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
import time
from collections import deque
from typing import Any

import config
import llm as llm_mod
import report as report_mod
import stt as stt_mod
from engine import (Behavior, PhysioSample, Turn, evaluate_trigger,
                    judge_turn, summarize_turn)
from store import STORE, Room, Session
from vision import get_provider

PROVIDER = get_provider()
# 分析交给 LLM，测量留给 FacePhys，语音转写交给百炼 ASR。
# 任何一个没配都在运行时降级，不影响主流程。
LLM = llm_mod.get_llm()
STT = stt_mod.get_stt()

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
        self.pending: dict | None = None   # 已请求、等待回来的证据
        self.confirm_used = 0              # 本场已经花掉几次确认额度
        self.token_warned = False          # 余额告警只发一次
        self.stt_busy = False
        self.stt_warned = False
        self.stt_fail = 0
        self.stt_inflight = 0

    def server_t(self) -> float:
        """服务端权威时间轴（相对会话开始的秒数）。

        **不要把客户端的 t 当真。** 面试官和候选人各自从"自己连上那一刻"
        开始计时，两条时间轴可能差几十秒。混用会让 turn_end 的时间戳和
        video_chunk 的采样时刻对不上，轮次窗口匹配、报告时钟全都会乱。
        """
        session = self.session
        if session is None:
            return 0.0
        return max(0.0, time.time() - session.started_at)

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

    def ensure_session(self) -> Session:
        """没有会话就地建一个。

        原来只有候选人进房才建会话，于是"面试官一个人连上来试麦克风"时
        session 是 None，所有输入（转写、轮次、音频）都被静默丢弃 ——
        表现就是"麦克风正常但一个字都不出"。
        """
        session = self.session
        if session is None:
            session = STORE.start_session(self.room, consent=False)
        return session

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

        payload = {
            "type": "signal",
            "t": round(t, 2),
            "load_z": round(z, 2),
            "hr": sample.hr,
            "rr": sample.rr,
            "quality": round(sample.quality, 2),
            "face_count": sample.face_count,
            "baseline_ready": self.room.baseline.ready,
            "baseline_remaining": round(self.room.baseline.remaining(t), 1),
            # sqi 在 0.15~0.30 之间：能用但只能参考，界面要如实标"信号偏弱"
            "signal_weak": bool(0 < sample.quality < config.SQI_STRONG),
        }
        # FacePhys 会白送活体检测，正好支撑「是不是本人」这条产品线。
        # 注意：这只是**提示**，永不参与任何自动决策。
        live = getattr(PROVIDER, "last_liveness", None)
        if live:
            payload["liveness"] = live
        # 指标为什么缺失也要如实告诉前端，别让界面显示 None
        rr_reason = getattr(PROVIDER, "last_rr_reason", "")
        if rr_reason:
            payload["rr_unavailable"] = rr_reason
        # 逐点序列的稳定性：伪跳变的数据会被判不可用，界面要说清楚原因
        hr_stats = getattr(PROVIDER, "last_hr_stats", None)
        if hr_stats:
            payload["hr_stats"] = hr_stats
            if getattr(PROVIDER, "last_hr_unstable", False):
                payload["hr_unstable"] = True

        await self.send("interviewer", payload)

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
            await self._apply_confirmation(sample, t)

    async def on_audio_chunk(self, role: str, data_b64: str, t: float,
                             content_type: str = "audio/webm") -> None:
        """一段录音 → 转文字 → 走和手工输入完全相同的 transcript 通道。

        背压：同一时间只转一段。ASR 要 1~3 秒，排队只会让延迟越拖越长。
        """
        session = self.ensure_session()
        if STT is None:
            if not self.stt_warned:
                self.stt_warned = True
                await self.send("interviewer", {
                    "type": "status", "state": "degraded",
                    "reason": "语音转写未启用（缺 STT_API_KEY），请用手打输入",
                    "t": t})
            return
        # 最多同时转 2 段：1.6 秒一段、单段约 0.85 秒，正常跟得上；
        # 给到 2 是为了网络抖动时不丢字（原来 busy 就整段丢弃，会漏话）。
        if self.stt_inflight >= 2:
            return
        try:
            audio = base64.b64decode(data_b64.split(",", 1)[-1])
        except Exception:
            return
        if not audio:
            return

        fmt = "webm"
        ct = (content_type or "").lower()
        if "wav" in ct:
            fmt = "wav"
        elif "mp4" in ct or "m4a" in ct or "aac" in ct:
            fmt = "m4a"
        elif "ogg" in ct:
            fmt = "ogg"

        self.stt_inflight += 1
        try:
            text = await asyncio.to_thread(STT.transcribe, audio, fmt)
        except Exception:                            # noqa: BLE001
            text = None
        finally:
            self.stt_inflight -= 1

        if text:
            print(f"[stt] role={role} bytes={len(audio)} fmt={fmt} "
                  f"-> {text[:40]!r}", flush=True)
            await self.on_stt(role, text, t, final=True)
        else:
            # 转写没出字：把真实原因回给发音频的那一端，否则前端只能干等
            self.stt_fail += 1
            reason = getattr(STT, "last_error", "") or "ASR 未返回文本"
            print(f"[stt] role={role} bytes={len(audio)} fmt={fmt} "
                  f"-> FAILED {reason[:100]}", flush=True)
            if self.stt_fail <= 3:
                await self.broadcast({"type": "status", "state": "stt_failed",
                                      "reason": str(reason)[:140], "t": t})

    # ---------------- 会议纪要（语音转写） ----------------
    async def on_stt(self, role: str, text: str, t: float,
                     final: bool = True) -> None:
        """收一条转写，存进时间线并广播给两端。

        发言人由**服务端按连接角色**判定，不信客户端自报的 speaker 字段 ——
        否则候选人可以把面试官的话标成自己说的。
        """
        session = self.ensure_session()
        item = STORE.add_transcript(session, role, text, t, final)
        if not item["text"]:
            return
        await self.broadcast({"type": "transcript", **item})

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

        # 语义分析交给 LLM：这是唯一会"读内容"的信号。
        # 失败一律静默，beh.semantic 保持 0，后面的判断完全退回原样。
        if LLM is not None and turn.transcript:
            try:
                res = await asyncio.to_thread(
                    LLM.analyze_turn, "",
                    turn.transcript,
                    f"停顿{turn.beh.pause_ratio:.2f} "
                    f"语速降{turn.beh.speech_rate_drop:.2f} "
                    f"视线离屏{turn.beh.gaze_off:.2f}")
            except Exception:
                res = None
            if res:
                turn.beh.semantic = res["semantic"]
                turn.llm = res

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

        if draft is not None:
            self._use_llm_text(draft, turn.llm)
            hint = STORE.add_hint(session, draft, t, turn_id=turn.turn_id)
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

        # 行为信号触发 → 花钱采一段视频去确认（而不是固定每 30 秒采）
        await self._maybe_request_confirm(turn, t)

    # ---------------- 触发 → 确认 ----------------
    @staticmethod
    def _use_llm_text(draft, llm_res) -> None:
        """probe 类提示优先用 LLM 写的追问。

        只换 probe：upgrade（题太浅）和 wrap（该收了）依赖节奏信息，
        语言模型看不见节奏，硬让它写反而更差。
        LLM 没结果时 draft 原样保留（模板兜底），绝不空手。
        """
        if draft is None or not llm_res:
            return
        if draft.kind == "probe" and llm_res.get("probe"):
            draft.text = llm_res["probe"]
            why = (llm_res.get("why") or "").strip()
            if why and why not in draft.why:
                draft.why = f"{draft.why}；{why}"[:60]

    async def _maybe_request_confirm(self, turn: Turn, t: float) -> None:
        """行为信号报警时，请求候选人录一段视频作为**证据**。

        为什么要有这道闸门：行为信号免费，生理片段一次 17 万 token。
        没有节制的采样在经济上不成立（一场面试 90 段 = 1575 万 token）。
        """
        session = self.session
        if session is None:
            return
        # 上一段证据迟迟没回来就作废，否则一次失败的请求会永久卡住后续触发
        if (self.pending is not None
                and t - self.pending["t"] > config.PENDING_TIMEOUT):
            self.pending = None
        if self.pending is not None:
            return
        if self.confirm_used >= config.CONFIRM_MAX:
            return

        trig = evaluate_trigger(turn.beh)
        if not trig.fired:
            return

        # 没有候选人在线就别浪费额度：请求发不出去，pending 会白占 90 秒
        if not self.conns.get("candidate"):
            return
        # 余额见底就停手 —— 现场跑到一半没额度比"少采一次"严重得多
        left = getattr(PROVIDER, "tokens_left", None)
        if left is not None and left < config.TOKEN_FLOOR:
            if not self.token_warned:
                self.token_warned = True
                await self.send("interviewer", {
                    "type": "status", "state": "degraded",
                    "reason": f"Token 余额不足（剩 {left}），已停止取证",
                    "t": t})
            return

        self.pending = {"turn_id": turn.turn_id, "t": t, "beh": turn.beh,
                        "reason": trig.reason, "score": trig.score,
                        "llm": turn.llm}
        self.confirm_used += 1
        session.confirms_requested += 1

        await self.send("candidate", {
            "type": "record_request",
            "t": t,
            "seconds": config.CONFIRM_CLIP_SECONDS,
            "turn_id": turn.turn_id,
            "reason": trig.reason,
        })
        await self.send("interviewer", {
            "type": "confirm_requested",
            "t": t,
            "turn_id": turn.turn_id,
            "reason": trig.reason,
            "used": self.confirm_used,
            "budget": config.CONFIRM_MAX,
        })

    async def _apply_confirmation(self, sample: PhysioSample, t: float) -> None:
        """证据回来了：过双确认。生理没确认上就明确告诉面试官"没证实"。"""
        session = self.session
        pending = self.pending
        if session is None or pending is None:
            return
        self.pending = None

        z = self.room.baseline.load_z(sample)
        turn = Turn(turn_id=pending["turn_id"], start_t=pending["t"],
                    end_t=pending["t"], phys_peak=z, phys_mean=z,
                    beh=pending["beh"])
        draft = judge_turn(turn, self.room.baseline, self.room.last_hint_t,
                           session.turns)

        if draft is None:
            await self.send("interviewer", {
                "type": "confirm_result",
                "t": round(pending["t"], 2),
                "turn_id": pending["turn_id"],
                "confirmed": False,
                "load_z": round(z, 2),
                "quality": round(sample.quality, 2),
            })
            return

        self._use_llm_text(draft, pending.get("llm"))
        hint = STORE.add_hint(session, draft, pending["t"],
                              turn_id=pending["turn_id"])
        session.confirms_confirmed += 1
        self.room.last_hint_t = pending["t"]
        await self.send("interviewer", {
            "type": "hint",
            "id": hint.id,
            "turn_id": hint.turn_id,
            "kind": hint.kind,
            "text": hint.text,
            "why": hint.why,
            "t": round(hint.t, 2),
            "confirmed": True,
        })

    # ---------------- 结束 ----------------
    async def on_end(self) -> None:
        session = self.session
        if session is None:
            # 候选人还没进来就点结束：明确回一句，别让前端一直等 report_ready
            await self.send("interviewer", {
                "type": "status", "state": "no_session",
                "reason": "还没有候选人进入，本场未开始",
                "t": self.server_t()})
            return
        if session.report is not None:
            # 幂等：重复点结束就把已有报告再发一遍，不重复生成
            await self.send("interviewer", {
                "type": "report_ready", "session_id": session.id,
                "report": session.report})
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
            # 重连时页面要知道对端还在不在，光有 status 不够
            "candidate_online": bool(self.conns.get("candidate")),
            "interviewer_online": bool(self.conns.get("interviewer")),
            "turns": len(session.turns) if session else 0,
            # 重连时把纪要也补回来，否则刷新一下前面的对话全没了
            "transcript": (session.transcript[-80:] if session else []),
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
    # 时间一律由服务端给：客户端 t 只在会话尚未建立时兜底
    t = hub.server_t() if hub.session is not None else float(msg.get("t", 0) or 0)
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

    elif mtype == "stt":
        await hub.on_stt(role, msg.get("text", ""), t,
                         bool(msg.get("final", True)))

    elif mtype == "audio_chunk":
        # 服务端 ASR：浏览器录音分片送上来，后端转文字后走同一条 transcript 通道
        await hub.on_audio_chunk(role, msg.get("data", ""), t,
                                 msg.get("ct", "audio/webm"))

    elif mtype == "end":
        # 只有面试官能结束整场，候选人最多退出连接
        if role == "interviewer":
            await hub.on_end()

    elif mtype == "ping":
        await hub.send(role, {"type": "pong", "t": t})
