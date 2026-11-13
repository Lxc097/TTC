"""WebSocket 会话编排 —— 整个后端最关键的一个文件。

三条设计纪律：

1. **背压：只保留最新一帧。** 候选人 5fps 上报，云端 API 可能要 1-2s。
   如果排队，队列会无限增长，提示延迟从 2 秒变 20 秒，demo 当场死。
   所以用「覆盖写入 + Event」的写法，永远只处理最新帧，旧帧直接丢。
2. **视觉调用必须 to_thread。** 同步 HTTP 调用会卡死事件循环。
3. **所有推送都带 t。** 前端只按 t 对齐，不按本地时钟，省掉后期 80% 联调痛苦。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from collections import deque
from typing import Any

import config
import report as report_mod
from engine import Behavior, PhysioSample, Turn, judge_turn, summarize_turn
from store import STORE, Room, Session
from vision import get_provider

PROVIDER = get_provider()

# 视频形态（FacePhys）：一次要一段 ≥15 秒的视频，一个视频块换一个采样点。
# 这条路完全不经过逐帧背压，走 on_video_chunk。
VIDEO_MODE = bool(getattr(PROVIDER, "wants_video", False))
# 片段形态（VISION_API_MODE=segment）时，必须保留连续帧给 rPPG 用，
# 不能沿用「只保留最新一帧」的背压，否则视频被打散成每 2 秒一帧。
SEGMENT_MODE = bool(getattr(PROVIDER, "wants_segment", False))
SEGMENT_FRAMES = max(10, int(float(os.getenv("VISION_SEGMENT_SECONDS", "12"))
                            * config.FRAME_FPS))

# 每个房间一个 Hub（连接集合 + 单帧槽位 + 后台 worker）
HUBS: dict[str, "RoomHub"] = {}


class RoomHub:
    def __init__(self, room: Room) -> None:
        self.room = room
        self.conns: dict[str, set] = {"interviewer": set(), "candidate": set()}
        self.frame_ready = asyncio.Event()
        self.latest_frame: bytes | None = None
        self.latest_t: float = 0.0
        self.worker: asyncio.Task | None = None
        self.consent_warned = False
        self.seg_buffer: deque[bytes] = deque(maxlen=SEGMENT_FRAMES)
        self.video_busy = False      # 视频形态：同一时间只允许一段在分析

    # ---------------- 连接管理 ----------------
    def add(self, role: str, ws) -> None:
        self.conns.setdefault(role, set()).add(ws)
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._vision_worker())

    def remove(self, role: str, ws) -> None:
        self.conns.get(role, set()).discard(ws)
        if not any(self.conns.values()):
            self.shutdown()

    def shutdown(self) -> None:
        """请求停掉后台 worker。房间结束、双方都掉线时都要调，否则永不停机。"""
        if self.worker is not None and not self.worker.done():
            self.worker.cancel()

    async def stop(self) -> None:
        """取消并**等 worker 真正退出**。

        cancel() 只是投递一个取消信号，任务要等事件循环调度一次才会变成 done。
        结束面试时用这个，才能保证"报告发出去的时候分析已经彻底停了"。
        """
        self.shutdown()
        if self.worker is not None:
            await asyncio.gather(self.worker, return_exceptions=True)

    async def send(self, role: str, payload: dict) -> None:
        dead = []
        for ws in list(self.conns.get(role, set())):
            try:
                await ws.send_text(json.dumps(payload, ensure_ascii=False))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.remove(role, ws)

    async def broadcast(self, payload: dict) -> None:
        await self.send("interviewer", payload)
        await self.send("candidate", payload)

    @property
    def session(self) -> Session | None:
        return STORE.get_session(self.room.session_id) if self.room.session_id else None

    # ---------------- 帧入站（背压点） ----------------
    def push_frame(self, frame: bytes, t: float) -> None:
        self.latest_frame = frame      # 覆盖，不排队
        self.latest_t = t
        if SEGMENT_MODE:
            self.seg_buffer.append(frame)   # 片段形态必须保留连续帧
        if not VIDEO_MODE:
            self.frame_ready.set()     # 视频形态不走逐帧路径，别唤醒 worker

    # ---------------- 后台视觉 worker ----------------
    async def _vision_worker(self) -> None:
        while True:
            await self.frame_ready.wait()
            self.frame_ready.clear()

            # 取走即清空。**必须在这里清，不能放到 sleep 之后** ——
            # 放到 sleep 之后会把睡眠期间到达的新帧覆盖成 None，
            # 于是下一轮处理一个空帧，产出一条 quality=0 / face_count=0
            # 的假样本，把基线和报告一起污染。
            frame, t = self.latest_frame, self.latest_t
            self.latest_frame = None

            session = self.session
            if session is None:
                continue
            if not session.consent:
                # 未授权：一条生理数据都不许碰，连 API 都不能调。
                # 这是整个项目合规叙事的根基，不是可选项。
                if not self.consent_warned:
                    self.consent_warned = True
                    await self.send("interviewer", {
                        "type": "status",
                        "state": "no_consent",
                        "reason": "候选人未授权视频分析，本次仅语音",
                        "t": t,
                    })
                continue

            try:
                if SEGMENT_MODE:
                    # 片段形态：送连续帧，不能用只保留最新一帧的背压，
                    # 否则每 2 秒才喂一帧，视频断裂，rPPG 算不出心率。
                    sample = await asyncio.to_thread(
                        PROVIDER.sample_segment, list(self.seg_buffer), t)
                else:
                    sample = await asyncio.to_thread(PROVIDER.sample, frame, t)
            except Exception:
                # API 挂了：降级但不中断
                await self.send("interviewer",
                                {"type": "status", "state": "degraded",
                                 "reason": "vision_api_error", "t": t})
                await asyncio.sleep(config.SAMPLE_MIN_INTERVAL)
                continue

            if sample is None:
                # 这一次没什么可说的，忽略它 —— 绝不能当成"没人脸"采样
                await asyncio.sleep(config.SAMPLE_MIN_INTERVAL)
                continue

            await self._emit_sample(sample, t)

            # 限制云端 API 调用频率，省钱也省延迟
            await asyncio.sleep(config.SAMPLE_MIN_INTERVAL)

    async def _emit_sample(self, sample: PhysioSample, t: float) -> None:
        """采样落库 + 算负荷 + 推给面试官。逐帧路径和视频路径共用这一段。"""
        session = self.session
        if session is None:
            return
        self.room.baseline.add(sample)
        # 硬上限：窗口两倍时长后强制封板，避免一直「建立基线中」
        if t > config.BASELINE_SECONDS * 2 and not self.room.baseline.ready:
            self.room.baseline.freeze()

        session.samples.append(sample)
        z = self.room.baseline.load_z(sample)

        await self.send("interviewer", {
            "type": "signal",
            "t": round(t, 2),
            "load_z": round(z, 2),
            "hr": sample.hr,
            "quality": round(sample.quality, 2),
            "face_count": sample.face_count,
            "baseline_ready": self.room.baseline.ready,
            "baseline_remaining": round(self.room.baseline.remaining(t), 1),
        })

    # ---------------- 视频形态（FacePhys） ----------------
    async def on_video_chunk(self, data_b64: str, t: float,
                             content_type: str = "video/mp4") -> None:
        """一段视频换一个采样点。

        背压：同一时间只允许一段在分析。上一段没回来时到达的新段直接丢弃，
        因为视频接口本身要 5~30 秒，排队只会让延迟越来越长。
        """
        session = self.session
        if session is None or not session.consent:
            return
        if self.video_busy:
            await self.send("interviewer", {
                "type": "status", "state": "degraded",
                "reason": "上一段视频还在分析，本段已跳过", "t": t})
            return
        try:
            video = base64.b64decode(data_b64.split(",", 1)[-1])
        except Exception:
            return
        if not video:
            return

        self.video_busy = True
        try:
            sample = await asyncio.to_thread(
                PROVIDER.sample_video, video, t, content_type)
        except Exception as exc:
            await self.send("interviewer", {
                "type": "status", "state": "degraded",
                "reason": f"facephys_error: {exc}"[:200], "t": t})
            return
        finally:
            self.video_busy = False

        if sample is not None:
            await self._emit_sample(sample, t)

    # ---------------- 轮次处理 ----------------
    async def on_turn_start(self, t: float) -> None:
        session = self.session
        if session is None:
            return
        turn = Turn(turn_id=len(session.turns) + 1, start_t=t)
        self.room.current_turn = turn
        await self.send("interviewer", {"type": "turn_start", "t": t,
                                        "turn_id": turn.turn_id})

    async def on_turn_end(self, t: float, transcript: str,
                          beh_raw: dict[str, Any] | None) -> None:
        session = self.session
        if session is None:
            return
        turn = self.room.current_turn or Turn(turn_id=len(session.turns) + 1,
                                             start_t=max(0.0, t - 30))
        turn.end_t = t
        turn.transcript = transcript or ""
        b = beh_raw or {}
        turn.beh = Behavior(
            pause_ratio=float(b.get("pause_ratio", 0) or 0),
            filler_density=float(b.get("filler_density", 0) or 0),
            speech_rate_drop=float(b.get("speech_rate_drop", 0) or 0),
            gaze_off=float(b.get("gaze_off", 0) or 0),
        )
        summarize_turn(turn, session.samples, self.room.baseline)

        draft = judge_turn(turn, self.room.baseline,
                           self.room.last_hint_t, session.turns)
        session.turns.append(turn)
        self.room.current_turn = None

        await self.send("interviewer", {
            "type": "turn_summary",
            "turn_id": turn.turn_id,
            "duration": round(turn.duration, 1),
            "phys_peak": round(turn.phys_peak, 2),
            "phys_mean": round(turn.phys_mean, 2),
            "beh_anomaly": round(turn.beh.anomaly(), 2),
        })

        if draft is None:
            return   # 静默。这是常态，绝大多数轮次不应该有提示。

        hint = STORE.add_hint(session, draft, t)
        self.room.last_hint_t = t
        await self.send("interviewer", {
            "type": "hint",
            "id": hint.id,
            "turn_id": hint.turn_id,
            "kind": hint.kind,
            "text": hint.text,
            "why": hint.why,
            "t": round(hint.t, 2),
        })

    # ---------------- 结束 ----------------
    async def on_end(self) -> None:
        session = self.session
        if session is None:
            return
        STORE.end_session(session)
        await self.stop()        # 等 worker 真正退出，否则长跑泄漏

        base = report_mod.build_report(session)
        await self.send("interviewer", {
            "type": "report_ready",
            "session_id": session.id,
            "report": base,
        })
        # 两侧拿到的报告不一样：面试官得到「该往哪问」，候选人得到「该往哪改」
        await self.send("candidate", {
            "type": "report_ready",
            "session_id": session.id,
            "report": report_mod.build_candidate_report(session, base),
        })

    # ---------------- 重连补齐 ----------------
    async def send_snapshot(self) -> None:
        """面试官刷新页面/断线重连时补上已发生的状态，否则页面一片空白。"""
        session = self.session
        await self.send("interviewer", {
            "type": "snapshot",
            "session_id": self.room.session_id,
            "status": self.room.status,
            "baseline_ready": self.room.baseline.ready,
            "turns": len(session.turns) if session else 0,
            "hints": [
                {"id": h.id, "turn_id": h.turn_id, "kind": h.kind,
                 "text": h.text, "why": h.why, "t": round(h.t, 2),
                 "action": h.action}
                for h in (session.hints if session else [])
            ],
            "adopt_rate": round(session.adopt_rate, 3) if session else 0.0,
        })


def get_hub(room: Room) -> RoomHub:
    hub = HUBS.get(room.code)
    if hub is None:
        hub = RoomHub(room)
        HUBS[room.code] = hub
    return hub


def _decode_frame(data_url: str) -> bytes | None:
    """前端传 data:image/jpeg;base64,xxx。解码失败直接丢帧，不抛异常。"""
    try:
        if "," in data_url:
            data_url = data_url.split(",", 1)[1]
        return base64.b64decode(data_url, validate=False)
    except Exception:
        return None


async def handle_message(hub: RoomHub, role: str, msg: dict) -> None:
    t = float(msg.get("t", 0) or 0)
    mtype = msg.get("type")

    if mtype == "frame":
        if role != "candidate":
            return
        frame = _decode_frame(msg.get("img", ""))
        hub.push_frame(frame, t)

    elif mtype == "video_chunk":
        # 视频形态：候选人浏览器每 ~30 秒送一段 webm/mp4
        if role != "candidate":
            return
        await hub.on_video_chunk(msg.get("data", ""), t,
                                 msg.get("ct", "video/mp4"))

    elif mtype == "turn_start":
        await hub.on_turn_start(t)

    elif mtype == "turn_end":
        await hub.on_turn_end(t, msg.get("transcript", ""), msg.get("beh"))

    elif mtype == "hint_feedback":
        action = msg.get("action")
        if action in ("used", "ignored"):
            hint = STORE.set_feedback(msg.get("hint_id", ""), action)
            if hint:
                session = hub.session
                await hub.send("interviewer", {
                    "type": "hint_ack",
                    "id": hint.id,
                    "action": action,
                    "adopt_rate": round(session.adopt_rate, 3) if session else 0,
                })

    elif mtype == "end":
        # 只有面试官能结束整场，候选人最多退出连接
        if role == "interviewer":
            await hub.on_end()

    elif mtype == "ping":
        await hub.send(role, {"type": "pong", "t": t})
