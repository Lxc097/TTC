"""视觉/生理数据来源的选择器。

上层只认 VisionProvider 这一个协议，所以：
- 前端没接好时用 MockProvider，立刻能联调
- demo 现场 API 挂了，VISION_PROVIDER=mock 一键切换，不丢人
- 真实 API 的适配全部在 vision_http.py，这里只负责挑实现

接口约定（很重要，别改）：
    返回 PhysioSample  → 「我说了，这是数据」（quality=0 表示画面里没人/信号差）
    返回 None          → 「我这次没什么可说的」，上层必须忽略，不要当成采样
这个区分是为了防止「没数据」被误当成「没心跳」而污染基线。
"""
from __future__ import annotations

import math
import os
from typing import Optional, Protocol

import config
from engine import PhysioSample


class VisionProvider(Protocol):
    wants_segment: bool

    def sample(self, frame: Optional[bytes], t: float) -> Optional[PhysioSample]:
        """给一帧（可为 None），返回这一时刻的生理采样。t = 相对面试开始秒数。"""
        ...

    def sample_segment(self, frames: list[bytes],
                       t: float) -> Optional[PhysioSample]:
        """片段形态用：给一段连续帧。默认退化为取最后一帧。"""
        ...


class MockProvider:
    """可排练的假数据。

    默认在 MOCK_STRESS_WINDOWS 指定的时间段抬高心率，
    让 demo 的"负荷突升"能稳定复现——**排练过的 demo 才是可信的 demo**。
    """

    wants_segment = False

    BASE_HR = 72.0
    BASE_RR = 15.0
    STRESS_HR = 14.0     # 应激时心率抬升幅度

    def __init__(self, windows: str = config.MOCK_STRESS_WINDOWS) -> None:
        self.windows = self._parse(windows)

    @staticmethod
    def _parse(spec: str) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for part in spec.split(","):
            part = part.strip()
            if not part or "-" not in part:
                continue
            a, b = part.split("-", 1)
            try:
                out.append((float(a), float(b)))
            except ValueError:
                continue
        return out

    def _in_stress(self, t: float) -> bool:
        return any(a <= t <= b for a, b in self.windows)

    def sample(self, frame: Optional[bytes], t: float) -> Optional[PhysioSample]:
        if frame is None:
            # 没有画面 = 没有人脸，数据不可用
            return PhysioSample(t=t, hr=None, rr=None, quality=0.0, face_count=0)

        stress = self._in_stress(t)
        hr = self.BASE_HR + (self.STRESS_HR if stress else 0.0)
        # 缓慢漂移 + 一点噪声，让曲线看起来像真的（但可复现）
        hr += 1.9 * math.sin(t / 7.0) + 1.1 * math.sin(t / 1.7)
        rr = self.BASE_RR + (2.5 if stress else 0.0) + 0.3 * math.sin(t / 5.0)
        # 帧数据越小（越糊）质量越差，模拟真实光照影响
        quality = 0.9 - min(0.4, len(frame) / 400_000)
        return PhysioSample(t=t, hr=round(hr, 1), rr=round(rr, 1),
                            quality=max(0.1, quality), face_count=1)

    def sample_segment(self, frames: list[bytes],
                       t: float) -> Optional[PhysioSample]:
        return self.sample(frames[-1] if frames else None, t)

    def sample_video(self, video: bytes, t: float,
                     content_type: str = "video/webm") -> Optional[PhysioSample]:
        """mock 的视频形态：把整段视频当成一帧处理，走同一个可排练的心率模型。

        没有这个方法的话，mock 模式下前端发 video_chunk 会 AttributeError，
        面试官端直接降级成黄条 —— 演示当场就废。之前它被一次整目录覆盖弄丢过，
        现在由 tests/test_pipeline.py 的 mock 视频用例钉住。
        """
        return self.sample(video or b"mock-video", t)


def get_provider() -> VisionProvider:
    """按环境变量选择实现。整个后端只在这里 new 一次。

    - mock      : 假数据（默认，前端联调 / demo 兜底）
    - facephys  : FacePhys 视频接口（视频形态，30 秒一个采样点）
    - real      : 通用 HTTP 适配（单帧 / 片段）
    """
    kind = config.VISION_PROVIDER
    if kind == "facephys":
        from vision_facephys import FacePhysProvider
        return FacePhysProvider()
    if kind == "real":
        from vision_http import HttpVisionProvider   # 延迟导入，mock 模式不需要
        return HttpVisionProvider()
    return MockProvider()


# 兼容旧引用
def _alias() -> None:  # pragma: no cover
    from vision_http import HttpVisionProvider as RealProvider  # noqa: F401
