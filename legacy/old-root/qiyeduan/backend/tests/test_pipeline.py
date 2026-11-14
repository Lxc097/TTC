"""管道级测试：把「跑起来没问题」和「跑对了」区分开。

覆盖三类容易被"测试全绿"掩盖的缺陷：
1. 背压实现把 sleep 期间到达的新帧覆盖成 None，产生空帧假样本（数据被污染）
2. 后台 worker 永不退出（长跑泄漏）
3. 候选人未授权时仍在产生生理分析（合规叙事是假的）
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import unittest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

import config          # noqa: E402
import ws as ws_mod    # noqa: E402
from engine import PhysioSample   # noqa: E402
from store import STORE, default_questions   # noqa: E402
from ws import get_hub   # noqa: E402


class FakeWS:
    def __init__(self) -> None:
        self.msgs: list[dict] = []

    async def send_text(self, s: str) -> None:
        self.msgs.append(json.loads(s))

    def types(self) -> list[str]:
        return [m["type"] for m in self.msgs]


class VideoProvider:
    """模拟视频形态的 provider（FacePhys 的替身）。"""

    wants_video = True
    wants_segment = False

    def __init__(self, hr: float = 80.0, quality: float = 0.5) -> None:
        self.calls: list[tuple] = []
        self.hr = hr
        self.quality = quality

    def sample_video(self, video, t, ct="video/mp4"):
        self.calls.append((len(video), t, ct))
        return PhysioSample(t=t, hr=self.hr, rr=15.0,
                            quality=self.quality, face_count=1)

    def sample(self, frame, t):
        return None

    def sample_segment(self, frames, t):
        return None


class CountingProvider:
    """记录被调用次数，用来验证「未授权时根本不该去调 API」。"""

    def __init__(self) -> None:
        self.calls = 0

    def sample(self, frame, t):
        self.calls += 1
        if frame is None:
            return PhysioSample(t=t, hr=None, rr=None, quality=0.0, face_count=0)
        return PhysioSample(t=t, hr=72.0, rr=15.0, quality=0.9, face_count=1)


class PipelineCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._orig = (config.BASELINE_SECONDS, config.BASELINE_MIN_SAMPLES,
                      config.SAMPLE_MIN_INTERVAL)
        config.BASELINE_SECONDS = 10.0
        config.BASELINE_MIN_SAMPLES = 3
        config.SAMPLE_MIN_INTERVAL = 0.3

        # 屏蔽真 LLM：本地 .env 里 LLM_ENABLED=1 时，on_turn_end 会真的发请求，
        # 单元测试既不该联网也不该花钱。需要测 LLM 的用例自己装假实现。
        self._orig_llm = ws_mod.LLM
        ws_mod.LLM = None
        # 同理屏蔽真 ASR：本地 .env 里 STT_ENABLED=1 时，发音频会真的调百炼接口
        self._orig_stt = ws_mod.STT
        ws_mod.STT = None

        # 这组测试验证的是**逐帧管道**，必须强制回到 frame 模式。
        # 否则本地 .env 一改成 facephys，VIDEO_MODE 就会把 push_frame 的事件
        # 关掉，所有用例一起挂——那不是代码坏了，是环境串了。
        self._orig_modes = (ws_mod.VIDEO_MODE, ws_mod.SEGMENT_MODE)
        ws_mod.VIDEO_MODE = False
        ws_mod.SEGMENT_MODE = False

        self.provider = CountingProvider()
        self._orig_provider = ws_mod.PROVIDER
        ws_mod.PROVIDER = self.provider

        self.room = STORE.create_room("管道测试", default_questions())
        self.hub = get_hub(self.room)
        self.iws, self.cws = FakeWS(), FakeWS()
        self.hub.add("interviewer", self.iws)
        self.hub.add("candidate", self.cws)
        await asyncio.sleep(0)      # 让 worker 任务真正起来

    async def asyncTearDown(self) -> None:
        self.hub.shutdown()
        await asyncio.sleep(0.05)
        config.BASELINE_SECONDS, config.BASELINE_MIN_SAMPLES, \
            config.SAMPLE_MIN_INTERVAL = self._orig
        ws_mod.VIDEO_MODE, ws_mod.SEGMENT_MODE = self._orig_modes
        ws_mod.PROVIDER = self._orig_provider
        ws_mod.LLM = self._orig_llm
        ws_mod.STT = self._orig_stt

    async def drain(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class TestBackpressure(PipelineCase):
    async def test_no_phantom_samples_from_empty_frame(self):
        """快速连推 6 帧后不得出现"空帧"样本。

        真实存在过的 bug：worker 处理完一帧后 sleep，醒来又把 latest_frame
        置为 None，于是 sleep 期间到达的新帧被丢弃；下一轮拿到 None，
        产出一条 quality=0 / face_count=0 的假样本污染基线。
        """
        STORE.start_session(self.room, consent=True)
        for i in range(6):
            self.hub.push_frame(b"x" * 2000, i * 0.05)
            await asyncio.sleep(0.05)
        await self.drain(1.2)

        samples = self.hub.session.samples
        self.assertTrue(samples, "应该至少处理过一帧")
        phantom = [s for s in samples if s.quality <= 0.0 or s.face_count == 0]
        self.assertEqual(phantom, [],
                         f"出现 {len(phantom)} 条空帧假样本，会污染基线与报告")

    async def test_frame_arriving_during_sleep_is_kept(self):
        """worker 睡眠期间到达的新帧必须被处理，且不是被替换成空帧。"""
        STORE.start_session(self.room, consent=True)
        self.hub.push_frame(b"a" * 2000, 0.0)
        await self.drain(0.1)          # worker 取走第一帧，进入 sleep
        self.hub.push_frame(b"b" * 2000, 0.5)   # 睡眠期间到达
        await self.drain(0.9)

        at_half = [s for s in self.hub.session.samples if round(s.t, 2) == 0.5]
        self.assertTrue(at_half, "睡眠期间到达的帧被整体丢弃了")
        self.assertGreater(at_half[0].quality, 0.5,
                           "该帧被替换成了空帧（latest_frame 被提前清空）")


class TestWorkerLifecycle(PipelineCase):
    async def test_worker_stops_after_end(self):
        STORE.start_session(self.room, consent=True)
        self.hub.push_frame(b"x" * 2000, 0.0)
        await self.drain(0.5)
        await self.hub.on_end()
        self.assertTrue(self.hub.worker.done(),
                        "面试结束后后台 worker 还在跑，长跑会泄漏")

    async def test_worker_stops_when_everyone_leaves(self):
        STORE.start_session(self.room, consent=True)
        self.hub.push_frame(b"x" * 2000, 0.0)
        await self.drain(0.5)
        self.hub.remove("interviewer", self.iws)
        self.hub.remove("candidate", self.cws)
        await self.drain(0.1)
        self.assertTrue(self.hub.worker.done(), "房间没人了 worker 还在跑")


class TestConsentGate(PipelineCase):
    async def test_no_analysis_without_consent(self):
        """未授权时：不调 API、不发 signal、只发一次状态说明。

        这是合规叙事的根基。候选人点了「只用语音」却仍被分析，
        整个项目的"尊重选择"就只是 PPT 上的一句话。
        """
        STORE.start_session(self.room, consent=False)
        for i in range(3):
            self.hub.push_frame(b"x" * 2000, i * 0.1)
            await asyncio.sleep(0.1)
        await self.drain(0.6)

        self.assertEqual(self.provider.calls, 0, "未授权却调用了视觉 API")
        self.assertNotIn("signal", self.iws.types(), "未授权却给面试官推了信号")
        self.assertIn("status", self.iws.types(), "应告知面试官本次无生理信号")
        self.assertEqual(self.hub.session.samples, [], "未授权却存了采样")

    async def test_signal_flows_with_consent(self):
        STORE.start_session(self.room, consent=True)
        for i in range(3):
            self.hub.push_frame(b"x" * 2000, i * 0.1)
            await asyncio.sleep(0.1)
        await self.drain(0.6)
        self.assertGreater(self.provider.calls, 0)
        self.assertIn("signal", self.iws.types())


class TestVideoChunk(PipelineCase):
    """视频形态（FacePhys）：一段视频换一个采样点，走 on_video_chunk。"""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.vp = VideoProvider()
        ws_mod.PROVIDER = self.vp

    async def test_chunk_emits_signal(self):
        STORE.start_session(self.room, consent=True)
        payload = base64.b64encode(b"fake-webm-bytes").decode()
        await self.hub.on_video_chunk(payload, 30.0, "video/webm")

        self.assertEqual(len(self.vp.calls), 1)
        self.assertEqual(self.vp.calls[0][2], "video/webm")
        self.assertIn("signal", self.iws.types())
        self.assertEqual(len(self.hub.session.samples), 1)

    async def test_chunk_dropped_when_busy(self):
        """上一段没回来时到达的新段必须直接丢，排队只会越拖越长。"""
        STORE.start_session(self.room, consent=True)
        self.hub.video_busy = True
        await self.hub.on_video_chunk(
            base64.b64encode(b"x").decode(), 30.0)
        self.assertEqual(self.vp.calls, [], "忙的时候不该发起新请求")
        self.assertIn("status", self.iws.types())
        self.assertNotIn("signal", self.iws.types())

    async def test_chunk_ignored_without_consent(self):
        STORE.start_session(self.room, consent=False)
        await self.hub.on_video_chunk(
            base64.b64encode(b"x").decode(), 30.0)
        self.assertEqual(self.vp.calls, [], "未授权不该调用任何视觉 API")
        self.assertEqual(self.hub.session.samples, [])

    async def test_empty_payload_is_noop(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.on_video_chunk("", 30.0)
        self.assertEqual(self.vp.calls, [])

    async def test_provider_error_degrades_not_crashes(self):
        STORE.start_session(self.room, consent=True)

        class Boom(VideoProvider):
            def sample_video(self, video, t, ct="video/mp4"):
                raise RuntimeError("oss upload failed")

        ws_mod.PROVIDER = Boom()
        await self.hub.on_video_chunk("eA==", 30.0)
        self.assertIn("status", self.iws.types())
        self.assertFalse(self.hub.video_busy, "出错后必须解开 busy 闸门")


class TestTriggerConfirm(PipelineCase):
    """行为触发 → 生理确认。免费信号决定何时花钱，花钱的结果才能出提示。"""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.vp = VideoProvider()
        ws_mod.PROVIDER = self.vp
        self._orig_confirm_max = config.CONFIRM_MAX

    async def asyncTearDown(self) -> None:
        config.CONFIRM_MAX = self._orig_confirm_max
        await super().asyncTearDown()

    async def _ready_baseline(self, hr: float = 80.0) -> None:
        # 三条样本：hr-1 / hr / hr+1 → median=hr, mad=1，正好够 MIN_SAMPLES=3
        for t, h in ((0.0, hr - 1), (5.0, hr), (9.0, hr + 1)):
            await self.hub._emit_sample(
                PhysioSample(t=t, hr=h, rr=16.0, quality=0.6, face_count=1), t)
        self.hub.room.baseline.freeze()
        self.assertTrue(self.hub.room.baseline.ready)

    async def test_high_pause_requests_clip(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(0.0)
        await self.hub.on_turn_end(20.0, "x" * 30, {"pause_ratio": 0.8})

        req = [m for m in self.cws.msgs if m["type"] == "record_request"]
        self.assertEqual(len(req), 1, "行为异常就应该请求一段确认视频")
        self.assertGreaterEqual(req[0]["seconds"], 15,
                                "低于 15 秒接口不认")
        self.assertIn("confirm_requested", self.iws.types(),
                      "面试官应知道正在取证")

    async def test_normal_turn_does_not_spend_money(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(0.0)
        await self.hub.on_turn_end(20.0, "x" * 30,
                                   {"pause_ratio": 0.05, "gaze_off": 0.0})
        self.assertEqual([m for m in self.cws.msgs
                          if m["type"] == "record_request"], [],
                         "正常轮次绝不能花钱采样")

    async def test_budget_cap(self):
        config.CONFIRM_MAX = 1
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(0.0)
        await self.hub.on_turn_end(20.0, "x" * 30, {"pause_ratio": 0.8})
        self.hub.pending = None          # 模拟这一段没回来
        await self.hub.on_turn_start(30.0)
        await self.hub.on_turn_end(60.0, "x" * 30, {"pause_ratio": 0.8})

        req = [m for m in self.cws.msgs if m["type"] == "record_request"]
        self.assertEqual(len(req), 1, f"本场额度 {config.CONFIRM_MAX}，不该发第二次")

    async def test_confirmation_emits_hint_when_phys_confirms(self):
        STORE.start_session(self.room, consent=True)
        await self._ready_baseline(hr=80.0)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "x" * 30, {"pause_ratio": 0.8})
        self.assertIsNotNone(self.hub.pending)

        # 证据回来：心率明显高于基线
        ws_mod.PROVIDER = VideoProvider(hr=96.0)
        await self.hub.on_video_chunk("eA==", 170.0)

        hints = [m for m in self.iws.msgs if m["type"] == "hint"]
        self.assertEqual(len(hints), 1, "行为 + 生理都异常，应该出提示")
        self.assertTrue(hints[0]["confirmed"])
        self.assertIn("σ", hints[0]["why"])
        self.assertIsNone(self.hub.pending, "确认完必须清掉 pending")

    async def test_confirmation_silent_when_phys_normal(self):
        STORE.start_session(self.room, consent=True)
        await self._ready_baseline(hr=80.0)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "x" * 30, {"pause_ratio": 0.8})

        # 证据回来：心率跟基线一样，生理侧没确认上
        ws_mod.PROVIDER = VideoProvider(hr=80.5)
        await self.hub.on_video_chunk("eA==", 170.0)

        self.assertEqual([m for m in self.iws.msgs if m["type"] == "hint"], [],
                         "生理没确认上就不许出提示（双确认不可破）")
        res = [m for m in self.iws.msgs if m["type"] == "confirm_result"]
        self.assertEqual(len(res), 1)
        self.assertFalse(res[0]["confirmed"])

    async def test_pending_timeout_does_not_block_forever(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(0.0)
        await self.hub.on_turn_end(20.0, "x" * 30, {"pause_ratio": 0.8})
        self.assertIsNotNone(self.hub.pending)

        # 很久之后又触发一次：旧 pending 应作废，允许重新请求
        config.CONFIRM_MAX = 5
        await self.hub.on_turn_start(300.0)
        await self.hub.on_turn_end(320.0, "x" * 30, {"pause_ratio": 0.8})
        req = [m for m in self.cws.msgs if m["type"] == "record_request"]
        self.assertEqual(len(req), 2, "超时的证据请求不该永久卡住下一次")


class TestAuditFixes(PipelineCase):
    """2025-xx 审计发现的 6 个问题的回归测试。"""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.vp = VideoProvider()
        ws_mod.PROVIDER = self.vp
        self._orig_floor = config.TOKEN_FLOOR

    async def asyncTearDown(self) -> None:
        config.TOKEN_FLOOR = self._orig_floor
        await super().asyncTearDown()

    async def _baseline(self, hr: float = 80.0) -> None:
        for t, h in ((0.0, hr - 1), (5.0, hr), (9.0, hr + 1)):
            await self.hub._emit_sample(
                PhysioSample(t=t, hr=h, rr=16.0, quality=0.6, face_count=1), t)
        self.hub.room.baseline.freeze()

    # ---- 1. 客户端时间必须被服务端时间覆盖 ----
    async def test_server_clock_overrides_client_t(self):
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "interviewer", {"type": "turn_start", "t": 9999})

        msgs = [m for m in self.iws.msgs if m["type"] == "turn_start"]
        self.assertEqual(len(msgs), 1)
        self.assertLess(msgs[0]["t"], 5,
                        "客户端传的 t=9999 必须被忽略，一律用服务端时间轴")

    # ---- 2. 证据晚到时，hint 必须挂在触发的那一轮 ----
    async def test_hint_attached_to_triggering_turn(self):
        STORE.start_session(self.room, consent=True)
        await self._baseline()
        # 第 1 轮正常
        await self.hub.on_turn_start(60.0)
        await self.hub.on_turn_end(90.0, "正常回答。", {"pause_ratio": 0.05})
        # 第 2 轮触发取证
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "绕圈。", {"pause_ratio": 0.8})
        self.assertEqual(self.hub.pending["turn_id"], 2)
        # 第 3 轮在证据回来之前就结束了（真实场景里必然发生）
        await self.hub.on_turn_start(160.0)
        await self.hub.on_turn_end(190.0, "下一题。", {"pause_ratio": 0.05})

        ws_mod.PROVIDER = VideoProvider(hr=96.0)
        await self.hub.on_video_chunk("eA==", 210.0)

        hints = [m for m in self.iws.msgs if m["type"] == "hint"]
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["turn_id"], 2,
                         "提示必须挂在第 2 轮，不能因为第 3 轮已结束就漂移")

    # ---- 3. 候选人不在线时不该浪费额度和 90 秒 pending ----
    async def test_no_request_when_candidate_offline(self):
        STORE.start_session(self.room, consent=True)
        self.hub.remove("candidate", self.cws)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "绕圈。", {"pause_ratio": 0.8})
        self.assertIsNone(self.hub.pending, "没人接请求，不该占着 pending")
        self.assertEqual(self.hub.session.confirms_requested, 0)

    # ---- 4. 余额见底要停手并告知 ----
    async def test_token_floor_blocks_request(self):
        config.TOKEN_FLOOR = 200_000
        self.vp.tokens_left = 50_000          # 连一次都不够
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "绕圈。", {"pause_ratio": 0.8})

        self.assertIsNone(self.hub.pending)
        self.assertNotIn("record_request",
                         [m["type"] for m in self.cws.msgs])
        self.assertIn("status", self.iws.types())
        self.assertIn("余额不足", self.iws.msgs[-1]["reason"])

    # ---- 5. 没有会话就点结束，要给明确回应而不是静默 ----
    async def test_end_without_session_notifies(self):
        await self.hub.on_end()               # 还没 start_session
        st = [m for m in self.iws.msgs if m["type"] == "status"]
        self.assertEqual(len(st), 1)
        self.assertEqual(st[0]["state"], "no_session")
        self.assertNotIn("report_ready", self.iws.types())

    # ---- 6. 重复点结束要幂等 ----
    async def test_end_is_idempotent(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.on_end()
        first = self.hub.session.report
        await self.hub.on_end()
        reports = [m for m in self.iws.msgs if m["type"] == "report_ready"]
        candidate_reports = [m for m in self.cws.msgs if m["type"] == "report_ready"]
        self.assertEqual(len(reports), 2)
        self.assertEqual(len(candidate_reports), 2)
        # 走了一次 JSON 序列化，比内容不比身份
        self.assertEqual(reports[0]["report"], first)
        self.assertEqual(reports[1]["report"], first,
                         "第二次必须是同一份，不重建")
        self.assertEqual(candidate_reports[0]["report"], candidate_reports[1]["report"])
        self.assertEqual(candidate_reports[1]["report"]["role"], "candidate")
        self.assertNotIn("hint_stats", candidate_reports[1]["report"])

    async def test_cached_report_still_ends_session(self):
        session = STORE.start_session(self.room, consent=True, live=True)
        session.report = {"role": "interviewer", "title": "已有报告"}
        await self.hub.on_end()
        self.assertIsNotNone(session.ended_at)
        self.assertEqual(self.room.status, "ended")
        ended_at = session.ended_at
        await self.hub.on_end()
        self.assertEqual(session.ended_at, ended_at, "重复结束不应重置结束时间")

    # ---- 7. 报告里要有取证诚实度 ----
    async def test_report_has_verification_stats(self):
        STORE.start_session(self.room, consent=True)
        await self._baseline()
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "绕圈。", {"pause_ratio": 0.8})
        self.vp.hr = 80.4                     # 生理没确认上
        await self.hub.on_video_chunk("eA==", 170.0)
        await self.hub.on_end()

        rep = [m for m in self.iws.msgs if m["type"] == "report_ready"][0]["report"]
        self.assertEqual(rep["verification"]["requested"], 1)
        self.assertEqual(rep["verification"]["confirmed"], 0)
        self.assertEqual(rep["verification"]["unconfirmed"], 1,
                         "没坐实的次数必须如实写进报告")


class FakeLLM:
    """假的语义分析器。返回固定的 semantic/probe，不发网络请求。"""

    def __init__(self, semantic: float = 0.9, probe: str = ""):
        self.semantic = semantic
        self.probe = probe
        self.calls = 0

    def analyze_turn(self, question, answer, beh_summary=""):
        self.calls += 1
        return {"semantic": self.semantic, "probe": self.probe,
                "why": "用了「战略调整」带过原因"}

    def summarize(self, points, meta):
        return None


class TestLlmSemanticChannel(PipelineCase):
    """语义通道：LLM 读 transcript 给分，参与触发，但不越过数值闸门。"""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.vp = VideoProvider(hr=96.0)
        ws_mod.PROVIDER = self.vp

    async def _baseline(self, hr: float = 80.0) -> None:
        for t, h in ((0.0, hr - 1), (5.0, hr), (9.0, hr + 1)):
            await self.hub._emit_sample(
                PhysioSample(t=t, hr=h, rr=16.0, quality=0.6, face_count=1), t)
        self.hub.room.baseline.freeze()

    async def test_semantic_alone_triggers_evidence(self):
        """行为特征全部正常，只有语义回避 —— 也应该触发取证。"""
        ws_mod.LLM = FakeLLM(semantic=0.9)
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(
            150.0, "后来因为公司战略调整就没上线，具体不太清楚。",
            {"pause_ratio": 0.05, "gaze_off": 0.0})

        req = [m for m in self.cws.msgs if m["type"] == "record_request"]
        self.assertEqual(len(req), 1, "语义回避 0.9 应该触发取证")
        self.assertAlmostEqual(self.hub.pending["beh"].semantic, 0.9)

    async def test_no_llm_behaves_exactly_as_before(self):
        ws_mod.LLM = None
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(
            150.0, "后来因为公司战略调整就没上线，具体不太清楚。",
            {"pause_ratio": 0.05, "gaze_off": 0.0})
        self.assertEqual(self.hub.pending, None, "没有 LLM 时退回原逻辑，不触发")

    async def test_llm_probe_becomes_hint_text(self):
        ws_mod.LLM = FakeLLM(semantic=0.9, probe="追问：为什么没上线")
        STORE.start_session(self.room, consent=True)
        await self._baseline()
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "后来因为战略调整就没上线。",
                                   {"pause_ratio": 0.05})
        await self.hub.on_video_chunk("eA==", 170.0)

        hints = [m for m in self.iws.msgs if m["type"] == "hint"]
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["text"], "追问：为什么没上线",
                         "probe 类提示要用 LLM 写的追问，而不是模板")

    async def test_llm_still_cannot_skip_physiological_gate(self):
        """语义再高，生理没确认上也不许出提示 —— LLM 不能越过双确认。"""
        ws_mod.LLM = FakeLLM(semantic=1.0, probe="追问：随便问点什么")
        self.vp.hr = 80.4          # 与基线持平
        STORE.start_session(self.room, consent=True)
        await self._baseline()
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "后来因为战略调整就没上线。",
                                   {"pause_ratio": 0.05})
        await self.hub.on_video_chunk("eA==", 170.0)

        self.assertEqual([m for m in self.iws.msgs if m["type"] == "hint"], [],
                         "LLM 语义满分也不能绕过生理确认")
        self.assertTrue([m for m in self.iws.msgs
                         if m["type"] == "confirm_result"
                         and m["confirmed"] is False])

    async def test_llm_failure_falls_back_silently(self):
        class Boom(FakeLLM):
            def analyze_turn(self, *a, **k):
                raise RuntimeError("timeout")

        ws_mod.LLM = Boom()
        STORE.start_session(self.room, consent=True)
        await self.hub.on_turn_start(120.0)
        await self.hub.on_turn_end(150.0, "后来因为战略调整就没上线。",
                                   {"pause_ratio": 0.8})
        # 语义挂了，但行为 0.8 仍然触发，说明降级不影响原有链路
        self.assertEqual(len([m for m in self.cws.msgs
                              if m["type"] == "record_request"]), 1)


class TestMockVideoPath(PipelineCase):
    """mock 模式下前端发 video_chunk 必须跑通。

    这条是为了防止 MockProvider.sample_video 再次被弄丢：
    丢了的话后端会抛 AttributeError → 面试官端直接降级黄条，演示当场废。
    """

    async def test_mock_provider_has_sample_video(self):
        import vision
        p = vision.MockProvider()
        self.assertTrue(hasattr(p, "sample_video"),
                        "MockProvider 缺 sample_video，mock 下 video_chunk 会炸")
        s = p.sample_video(b"x" * 5000, 30.0)
        self.assertIsNotNone(s)
        self.assertIsNotNone(s.hr)

    async def test_video_chunk_in_mock_mode_emits_signal(self):
        import vision
        ws_mod.PROVIDER = vision.MockProvider()
        STORE.start_session(self.room, consent=True)
        await self.hub.on_video_chunk(
            base64.b64encode(b"x" * 5000).decode(), 30.0)
        self.assertIn("signal", self.iws.types())
        self.assertEqual([m for m in self.iws.msgs if m["type"] == "status"],
                         [], "mock 模式下发 video_chunk 不该降级")


class TestStatusFields(PipelineCase):
    """前端提的两个字段缺口。"""

    async def test_snapshot_has_online_flags(self):
        STORE.start_session(self.room, consent=True)
        await self.hub.send_snapshot()
        snap = [m for m in self.iws.msgs if m["type"] == "snapshot"][-1]
        self.assertTrue(snap["candidate_online"])
        self.assertTrue(snap["interviewer_online"])

    async def test_interviews_has_is_live(self):
        STORE.start_session(self.room, consent=True)
        self.assertTrue(STORE.list_interviews()[0]["is_live"])
        await self.hub.on_end()
        self.assertFalse(STORE.list_interviews()[0]["is_live"])


class TestTranscript(PipelineCase):
    """会议纪要：语音转写的存储与广播。"""

    async def test_stt_broadcast_to_both_sides(self):
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "interviewer", {"type": "stt", "text": "请先做个自我介绍"})

        self.assertTrue([m for m in self.iws.msgs if m["type"] == "transcript"],
                        "面试官自己也要收到，纪要面板才完整")
        self.assertTrue([m for m in self.cws.msgs if m["type"] == "transcript"])
        self.assertEqual(len(self.hub.session.transcript), 1)
        self.assertEqual(self.hub.session.transcript[0]["role"], "interviewer")

    async def test_speaker_comes_from_role_not_client(self):
        """客户端自报 speaker 不可信 —— 否则候选人能把面试官的话标成自己说的。"""
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "candidate",
            {"type": "stt", "text": "我做过三年后端", "speaker": "interviewer"})
        self.assertEqual(self.hub.session.transcript[0]["role"], "candidate")

    async def test_interim_broadcast_but_not_stored(self):
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "candidate", {"type": "stt", "text": "我", "final": False})
        self.assertEqual(self.hub.session.transcript, [],
                         "边说边变的中间结果不该进纪要")
        self.assertTrue([m for m in self.iws.msgs if m["type"] == "transcript"],
                        "但要让对方实时看到")

    async def test_empty_text_ignored(self):
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "candidate", {"type": "stt", "text": "   "})
        self.assertEqual(self.hub.session.transcript, [])
        self.assertFalse([m for m in self.iws.msgs if m["type"] == "transcript"])

    async def test_snapshot_restores_transcript(self):
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "interviewer", {"type": "stt", "text": "第一句话"})
        await self.hub.send_snapshot()
        snap = [m for m in self.iws.msgs if m["type"] == "snapshot"][-1]
        self.assertEqual(len(snap["transcript"]), 1,
                         "刷新后纪要要能恢复")

    async def test_transcript_capped(self):
        session = STORE.start_session(self.room, consent=True)
        for i in range(520):
            STORE.add_transcript(session, "candidate", f"第{i}句", float(i))
        self.assertEqual(len(session.transcript), 500, "上限 500 条，防内存涨爆")


class FakeSTT:
    def __init__(self, text: str = "我做过三年后端，主要负责订单系统。") -> None:
        self.text = text
        self.calls: list[tuple] = []

    def transcribe(self, audio, fmt="webm"):
        self.calls.append((len(audio), fmt))
        return self.text


class TestAudioChunk(PipelineCase):
    """服务端 ASR：浏览器录音分片 → 转文字 → 走 transcript 通道。"""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self._orig_stt = ws_mod.STT

    async def asyncTearDown(self) -> None:
        ws_mod.STT = self._orig_stt
        await super().asyncTearDown()

    async def test_audio_becomes_transcript(self):
        fake = FakeSTT()
        ws_mod.STT = fake
        STORE.start_session(self.room, consent=True)

        await ws_mod.handle_message(
            self.hub, "candidate",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"x" * 5000).decode(),
             "ct": "audio/webm"})

        self.assertEqual(fake.calls, [(5000, "webm")])
        tr = self.hub.session.transcript
        self.assertEqual(len(tr), 1)
        self.assertEqual(tr[0]["role"], "candidate")
        self.assertIn("三年后端", tr[0]["text"])
        self.assertTrue([m for m in self.iws.msgs if m["type"] == "transcript"])

    async def test_wav_content_type_maps_to_fmt(self):
        fake = FakeSTT()
        ws_mod.STT = fake
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "interviewer",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"y" * 4000).decode(),
             "ct": "audio/wav"})
        self.assertEqual(fake.calls[0][1], "wav")

    async def test_stt_disabled_warns_once(self):
        ws_mod.STT = None
        STORE.start_session(self.room, consent=True)
        payload = {"type": "audio_chunk",
                   "data": base64.b64encode(b"z" * 5000).decode()}
        await ws_mod.handle_message(self.hub, "candidate", dict(payload))
        await ws_mod.handle_message(self.hub, "candidate", dict(payload))

        statuses = [m for m in self.iws.msgs if m["type"] == "status"]
        self.assertEqual(len(statuses), 1, "只提醒一次，别每段都喊")
        self.assertIn("STT_API_KEY", statuses[0]["reason"])
        self.assertEqual(self.hub.session.transcript, [])

    async def test_stt_exception_does_not_break(self):
        class Boom(FakeSTT):
            def transcribe(self, audio, fmt="webm"):
                raise RuntimeError("asr down")

        ws_mod.STT = Boom()
        STORE.start_session(self.room, consent=True)
        await ws_mod.handle_message(
            self.hub, "candidate",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"q" * 5000).decode()})
        self.assertEqual(self.hub.session.transcript, [],
                         "ASR 挂了就当没听见，不能崩")

    async def test_over_capacity_drops_new_chunk(self):
        fake = FakeSTT()
        ws_mod.STT = fake
        STORE.start_session(self.room, consent=True)
        self.hub.stt_inflight = 2      # 已有两段在转，超过并发上限
        await ws_mod.handle_message(
            self.hub, "candidate",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"w" * 5000).decode()})
        self.assertEqual(fake.calls, [], "超过并发上限才丢，1 段时不该丢")

    async def test_one_inflight_still_accepts(self):
        """1.6 秒分段下并发 2 是常态，不能像原来那样一段就把后面的全丢了。"""
        fake = FakeSTT()
        ws_mod.STT = fake
        STORE.start_session(self.room, consent=True)
        self.hub.stt_inflight = 1
        await ws_mod.handle_message(
            self.hub, "candidate",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"v" * 5000).decode()})
        self.assertEqual(len(fake.calls), 1)


class TestMinutesWithoutCandidate(PipelineCase):
    """只有面试官连上来（候选人还没进）也要能记录。

    真实踩过的坑：会话原本只在候选人进房时才创建，于是面试官一个人试麦克风时
    session 是 None，所有输入被静默丢弃 —— 表现就是"麦克风正常但一个字都不出"。
    """

    async def test_stt_creates_session_when_alone(self):
        self.assertIsNone(self.hub.session, "这个用例刻意不建会话")
        await ws_mod.handle_message(
            self.hub, "interviewer", {"type": "stt", "text": "喂，能听到吗"})
        self.assertIsNotNone(self.hub.session)
        self.assertEqual(len(self.hub.session.transcript), 1)
        self.assertEqual(self.hub.session.transcript[0]["role"], "interviewer")

    async def test_audio_chunk_creates_session_when_alone(self):
        ws_mod.STT = FakeSTT("喂，能听到吗")
        self.assertIsNone(self.hub.session)
        await ws_mod.handle_message(
            self.hub, "interviewer",
            {"type": "audio_chunk",
             "data": base64.b64encode(b"x" * 5000).decode()})
        self.assertIsNotNone(self.hub.session)
        self.assertEqual(len(self.hub.session.transcript), 1)


class TestSessionLifecycle(unittest.TestCase):
    """会话由先连上的一方创建，且候选人的授权必须能补上。"""

    def _room(self):
        return STORE.create_room("会话测试", default_questions())

    def test_interviewer_alone_creates_session(self):
        room = self._room()
        s = STORE.start_session(room, consent=False, live=False)
        self.assertIsNotNone(s)
        self.assertEqual(room.session_id, s.id)
        self.assertNotEqual(room.status, "live",
                            "面试官先到不该显示成面试进行中")

    def test_candidate_upgrades_consent_on_existing_session(self):
        room = self._room()
        s1 = STORE.start_session(room, consent=False, live=False)
        s2 = STORE.start_session(room, consent=True, live=True)
        self.assertIs(s2, s1, "同一条会话，不能重建")
        self.assertTrue(s2.consent,
                        "候选人带了授权进来，必须补上，否则视频分析被永久锁死")
        self.assertEqual(room.status, "live")

    def test_candidate_reconnect_can_revoke_consent(self):
        room = self._room()
        session = STORE.start_session(room, consent=True, live=True)
        again = STORE.start_session(room, consent=False, live=True)
        self.assertIs(again, session)
        self.assertFalse(session.consent)

    def test_interviewer_reconnect_preserves_candidate_consent(self):
        room = self._room()
        session = STORE.start_session(room, consent=True, live=True)
        STORE.start_session(room, consent=False, live=False)
        self.assertTrue(session.consent)

    def test_finished_session_cannot_be_reopened(self):
        room = self._room()
        session = STORE.start_session(room, consent=True, live=True)
        STORE.end_session(session)
        STORE.start_session(room, consent=False, live=True)
        self.assertEqual(room.status, "ended")
        self.assertTrue(session.consent)

    def test_idempotent(self):
        room = self._room()
        a = STORE.start_session(room, consent=True, live=True)
        b = STORE.start_session(room, consent=True, live=True)
        self.assertIs(a, b)


if __name__ == "__main__":
    unittest.main(verbosity=2)
