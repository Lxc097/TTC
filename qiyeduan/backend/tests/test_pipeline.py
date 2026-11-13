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

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def sample_video(self, video, t, ct="video/mp4"):
        self.calls.append((len(video), t, ct))
        return PhysioSample(t=t, hr=80.0, rr=15.0, quality=0.5, face_count=1)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
