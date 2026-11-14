"""真实视觉 API 适配层。

对接任何云端「人脸 → 心率/呼吸/信号质量」API 只需要改环境变量，不用改代码。

三种主流形态，适配方式完全不同，先确认你们是哪一种：

┌─────────────┬──────────────────────────┬────────────────────────────────┐
│ 形态         │ 特征                     │ 怎么接                          │
├─────────────┼──────────────────────────┼────────────────────────────────┤
│ A 帧级同步   │ POST 一张图 → 立刻返回    │ VISION_API_MODE=frame（默认）   │
│ B 片段异步   │ POST N 秒视频 → 拿任务号  │ VISION_API_MODE=segment         │
│ C 流式 WS    │ 长连接持续出数据          │ 本文件不适用，见文件末尾说明     │
└─────────────┴──────────────────────────┴────────────────────────────────┘

**B 形态有一个致命细节**：rPPG 需要连续视频帧。而我们的背压是「只保留最新一帧」，
如果照搬就会每 2 秒才喂一帧，视频断裂，心率算不出来。所以 segment 模式下
帧缓冲必须放在落帧那一侧（ws.py 的 seg_buffer），不能放在这里。

字段名不用改代码：用 VISION_FIELD_* 环境变量指定，支持「候选路径」用 | 分隔。
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.request
from collections import deque
from typing import Any, Optional

from engine import PhysioSample

# 常见字段名的候选路径，按顺序试。绝大多数厂商的返回都能命中其中一个。
DEFAULT_PATHS = {
    "hr": "data.heart_rate|data.hr|heart_rate|hr|result.heart_rate|"
          "data.physio.heart_rate|data.result.heart_rate",
    "rr": "data.breath_rate|data.respiration_rate|data.rr|breath_rate|"
          "resp_rate|rr|respiration_rate|respiratory_rate|"
          "data.physio.breath_rate|data.result.breath_rate",
    "quality": "data.quality|quality|data.signal_quality|signal_quality|"
               "data.score|confidence|data.confidence",
    "faces": "data.face_count|face_count|data.faces|faces|data.count|"
             "data.human_count",
}


def _dig(obj: Any, path: str) -> Any:
    """按 "a.b.0.c" 取值，取不到返回 None。

    支持数组：路径中间遇到 list 且当前段不是下标时，会逐元素尝试，
    返回**最后一个**命中值（rPPG 接口常返回逐帧数组，我们要最新的）。
    """
    parts = path.split(".")
    cur: Any = obj
    for i, part in enumerate(parts):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, (list, tuple)):
            try:
                idx = int(part)
            except ValueError:
                rest = ".".join(parts[i:])
                found = None
                for item in cur:
                    v = _dig(item, rest)
                    if v is not None:
                        found = v
                return found
            if idx >= len(cur) or idx < -len(cur):
                return None
            cur = cur[idx]
        else:
            return None
    return cur


def _first(obj: Any, candidates: str) -> Any:
    for p in candidates.split("|"):
        v = _dig(obj, p.strip())
        if v is not None:
            return v
    return None


def _num(v: Any) -> Optional[float]:
    """字符串 / 单元素列表 / 嵌套列表都转成 float，转不了返回 None。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (list, tuple)):
        for item in reversed(v):          # 数组取最后一个（最新的）
            r = _num(item)
            if r is not None:
                return r
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


class HttpVisionProvider:
    """A / B 两种形态都支持。C（流式）见文件末尾说明。"""

    wants_segment = False

    def __init__(self, url: str = "", key: str = "",
                 extra_headers: Optional[dict] = None,
                 body_template: str = "") -> None:
        self.url = url or _env("VISION_API_URL")
        self.key = key or _env("VISION_API_KEY")
        if not self.url:
            raise RuntimeError("VISION_API_URL 未配置（或改用 VISION_PROVIDER=mock）")

        # 用来对接任意厂商：额外的请求头 / 自定义请求体
        self.extra_headers = dict(extra_headers or {})
        self.body_template = body_template or ""
        if not self.body_template:
            self.body_template = _env("VISION_BODY_TEMPLATE")

        self.mode = _env("VISION_API_MODE", "frame").lower()
        self.wants_segment = self.mode == "segment"
        self.payload_kind = _env("VISION_PAYLOAD", "json_b64").lower()
        self.auth_header = _env("VISION_AUTH_HEADER", "Authorization")
        self.auth_prefix = _env("VISION_AUTH_PREFIX", "Bearer ")

        self.timeout = float(_env("VISION_TIMEOUT", "2.5"))
        self.segment_seconds = float(_env("VISION_SEGMENT_SECONDS", "12"))

        self.hr_range = self._parse_range(_env("VISION_HR_RANGE", "40-180"))
        self.rr_range = self._parse_range(_env("VISION_RR_RANGE", "4-60"))

        self.paths = {
            k: _env(f"VISION_FIELD_{k.upper()}", v)
            for k, v in DEFAULT_PATHS.items()
        }

        self.last_latency: float = 0.0
        self.last_raw: dict | None = None

    # ------------------------------------------------------------ 工具
    @staticmethod
    def _parse_range(spec: str) -> tuple[float, float]:
        try:
            a, b = spec.split("-")
            return float(a), float(b)
        except (ValueError, AttributeError):
            return (0.0, 9999.0)

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json" if self.payload_kind == "json_b64"
             else "application/octet-stream"}
        if self.key:
            h[self.auth_header] = f"{self.auth_prefix}{self.key}"
        h.update(self.extra_headers)      # 自定义头优先，便于对接任意厂商
        return h

    def _body(self, frames: list[bytes]) -> bytes:
        if self.body_template:
            # 自定义请求体：{b64} 会被替换成最后一帧的 base64
            b64 = base64.b64encode(frames[-1]).decode() if frames else ""
            return self.body_template.replace("{b64}", b64).encode()
        if self.payload_kind == "raw":
            # 部分厂商直接收二进制流（单帧）
            return frames[-1] if frames else b""
        if self.payload_kind == "json_b64_list":
            return json.dumps({
                "images": [base64.b64encode(f).decode() for f in frames],
                "fps": int(_env("FRAME_FPS", "5")),
            }).encode()
        # 默认：单帧 base64
        return json.dumps({
            "image": base64.b64encode(frames[-1]).decode() if frames else ""
        }).encode()

    def _post(self, frames: list[bytes]) -> dict:
        req = urllib.request.Request(
            self.url, data=self._body(frames),
            headers=self._headers(), method="POST")
        t_start = time.monotonic()
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        self.last_latency = time.monotonic() - t_start
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"返回不是 JSON: {raw[:200]}") from exc
        if not isinstance(data, dict):
            data = {"data": data}
        self.last_raw = data
        return data

    # ------------------------------------------------------------ 解析
    def parse(self, data: dict, t: float) -> PhysioSample:
        """把厂商返回映射成 PhysioSample。这一步是纯函数，可单测。"""
        hr = _num(_first(data, self.paths["hr"]))
        rr = _num(_first(data, self.paths["rr"]))
        quality = _num(_first(data, self.paths["quality"]))
        faces = _num(_first(data, self.paths["faces"]))

        faces_i = int(faces) if faces is not None else (1 if hr is not None else 0)

        # 生理合理性闸门：rPPG 抖动会吐出 250bpm 这种值，一律判为无效。
        # 宁可静默，不可误报 —— 这是全项目的信条。
        lo, hi = self.hr_range
        if hr is not None and not (lo <= hr <= hi):
            hr = None
            quality = 0.0
        lo, hi = self.rr_range
        if rr is not None and not (lo <= rr <= hi):
            rr = None

        if quality is None:
            # 厂商没给质量分：有人脸且有心率就当作可用，但不敢给高分
            quality = 0.8 if (faces_i == 1 and hr is not None) else 0.0
        quality = max(0.0, min(1.0, quality))

        if faces_i != 1:
            quality = 0.0

        return PhysioSample(t=t, hr=hr, rr=rr,
                            quality=quality, face_count=faces_i)

    # ------------------------------------------------------------ 对外接口
    def sample(self, frame: Optional[bytes], t: float) -> Optional[PhysioSample]:
        """A 形态：单帧同步。返回 None 表示"这次没什么可说的"（由上层忽略）。"""
        if not frame:
            return PhysioSample(t=t, quality=0.0, face_count=0)
        data = self._post([frame])      # 网络错误直接抛，让 ws 标 degraded
        return self.parse(data, t)

    def sample_segment(self, frames: list[bytes], t: float) -> Optional[PhysioSample]:
        """B 形态：送一段连续帧。frames 由 ws.py 的 seg_buffer 提供。"""
        if not frames:
            return PhysioSample(t=t, quality=0.0, face_count=0)
        data = self._post(list(frames))
        return self.parse(data, t)


# ============================================================ 关于 C 形态
# 如果厂商只给 WebSocket 流式接口（长连接持续吐 HR），不要硬塞进 sample()：
# 在 ws.py 的 RoomHub 里为每个房间开一条上游连接，收到数据后直接
# self.send("interviewer", {"type": "signal", ...})，把 provider 层绕过去。
# 这条路最快但改动最大，黑客松最后 6 小时不建议动。
