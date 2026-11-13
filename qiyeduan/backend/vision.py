"""视觉/生理数据来源。

上层只认 VisionProvider 这一个协议，所以：
- 前端没接好时用 MockProvider，立刻能联调
- demo 现场 API 挂了，VISION_PROVIDER=mock 一键切换，不丢人
- 真实 API 只需要实现 sample() 一个方法
"""
from __future__ import annotations

import math
import os
from typing import Optional, Protocol

import config
from engine import PhysioSample


class VisionProvider(Protocol):
    def sample(self, frame: Optional[bytes], t: float) -> PhysioSample:
        """给一帧（可为 None），返回这一时刻的生理采样。t = 相对面试开始秒数。"""
        ...


class MockProvider:
    """可排练的假数据。

    默认在 MOCK_STRESS_WINDOWS 指定的时间段抬高心率，
    让 demo 的"负荷突升"能稳定复现——**排练过的 demo 才是可信的 demo**。
    """

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

    def sample(self, frame: Optional[bytes], t: float) -> PhysioSample:
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


class RealProvider:
    """对接团队现有的云端人脸/生理 API。

    TODO 上线前必须填这里。注意三件事：
    1. 这是同步 HTTP 调用，必须放在 asyncio.to_thread 里跑（见 ws.py），
       否则会卡死整个事件循环，提示延迟直接爆掉。
    2. 只取需要的字段，别把原始响应透传给前端（合规 + 体积）。
    3. 拿不到 quality 时一律当作 0，宁可静默不可误报。
    """

    def __init__(self, endpoint: str = "", api_key: str = "") -> None:
        self.endpoint = endpoint or os.getenv("VISION_API_URL", "")
        self.api_key = api_key or os.getenv("VISION_API_KEY", "")
        if not self.endpoint:
            raise RuntimeError("VISION_API_URL 未配置，或改用 VISION_PROVIDER=mock")

    def _post(self, frame: bytes) -> dict:  # pragma: no cover - 需真实网络
        import urllib.request
        import json

        req = urllib.request.Request(
            self.endpoint,
            data=frame,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/octet-stream",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def sample(self, frame: Optional[bytes], t: float) -> PhysioSample:
        if not frame:
            return PhysioSample(t=t, quality=0.0, face_count=0)
        try:
            data = self._post(frame)
        except Exception:
            # 超时/报错一律降级为"本点无数据"，绝不抛给上层
            return PhysioSample(t=t, quality=0.0, face_count=0)

        n_faces = int(data.get("face_count", 0) or 0)
        return PhysioSample(
            t=t,
            hr=data.get("heart_rate"),
            rr=data.get("breath_rate"),
            quality=float(data.get("quality", 0.0) or 0.0),
            face_count=n_faces,
        )


def get_provider() -> VisionProvider:
    """按环境变量选择实现。整个后端只在这里 new 一次。"""
    if config.VISION_PROVIDER == "real":
        return RealProvider()
    return MockProvider()
