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
from typing import Any

import config
import report as report_mod
from engine import Behavior, Turn, judge_turn, summarize_turn
from store import STORE, Room, Session
from vision import get_provider

PROVIDER = get_provider()

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

    # ---------------- 连接管理 ----------------
    def add(self, role: str, ws) -> None:
        self.conns.setdefault(role, set()).add(ws)
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._vision_worker())

    def remove(self, role: str, ws) -> None:
        self.conns.get(role, set()).discard(ws)

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
        self.frame_ready.set()         # 通知 worker 有新帧

    # ---------------- 后台视觉 worker ----------------
    async def _vision_worker(self) -> None:
        while True:
            await self.frame_ready.wait()
            self.frame_ready.clear()

            frame, t = self.latest_frame, self.latest_t
            session = self.session
            if session is None:
                continue

            try:
                sample = await asyncio.to_thread(PROVIDER.sample, frame, t)
            except Exception:
                # API 挂了：降级但不中断
                await self.send("interviewer",
                                {"type": "status", "state": "degraded",
                                 "reason": "vision_api_error", "t": t})
                await asyncio.sleep(config.SAMPLE_MIN_INTERVAL)
                continue

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

            # 限制云端 API 调用频率，省钱也省延迟
            await asyncio.sleep(config.SAMPLE_MIN_INTERVAL)
            self.latest_frame = None

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
        rep = report_mod.build_report(session)
        await self.broadcast({
            "type": "report_ready",
            "session_id": session.id,
            "report": rep,
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
        await hub.on_end()

    elif mtype == "ping":
        await hub.send(role, {"type": "pong", "t": t})
