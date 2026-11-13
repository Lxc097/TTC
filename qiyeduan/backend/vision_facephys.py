"""FacePhys 真实 Provider。

和 vision_http.py 的「单帧 / 多帧」都不同，FacePhys 是**视频文件异步接口**：
一次调用要传一段 ≥15 秒（最好 30 秒）的视频，返回**一个**心率采样点。

三步流程（官方 v3）：
    1. POST /api/v2/video/upload/presign   → {uploadUrl, objectKey}
    2. PUT  {uploadUrl}    Content-Type: video/mp4
    3. POST /api/v3/video/process          {objectKey, capability:"rppg"}
       → data.cardiac.{hr, sqi, hrv...} / data.breathing_rate / tokens_deducted

鉴权（HMAC-SHA256，±300 秒窗口）：
    x-key-id    : Key ID
    x-timestamp : Unix 秒级字符串
    x-signature : Base64(HMAC-SHA256(secret_key, timestamp))

⚠️ 这对架构有硬约束：**采样下限就是 15~30 秒一个点**。
   原先设计的「每 2 秒一个采样、回答结束 3 秒内出提示」不成立。
   换取的做法：浏览器每 30 秒切一个视频块送上来，一个块换一个采样点。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from typing import Optional

from engine import PhysioSample

DEFAULT_BASE = "https://www.facephys.com"
# 官方文档：sqi >= 0.30 视为可用。我们的 MIN_QUALITY 默认 0.5 对 rPPG 太严。
SQI_USABLE = 0.30

# 必须伪装成浏览器 UA。FacePhys 挂在 Cloudflare 后面，默认的
# "Python-urllib/3.x" 会被 WAF 直接 403（body: "error code: 1010"），
# 看起来像"签名不对"，实际跟签名毫无关系 —— 这个坑很费时间。
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/120.0.0.0 Safari/537.36")


class FacePhysError(RuntimeError):
    pass


class FacePhysProvider:
    """wants_video=True 表示上层要喂视频片段，而不是单帧。"""

    wants_video = True
    wants_segment = False

    def __init__(self, key_id: str = "", secret: str = "",
                 base_url: str = "", transport=None,
                 timeout: float = 60.0) -> None:
        self.key_id = key_id or os.getenv("TTC_API_KEY_ID", "")
        self.secret = secret or os.getenv("TTC_API_SECRET", "")
        self.base = (base_url or os.getenv("TTC_API_BASE", DEFAULT_BASE)).rstrip("/")
        self.timeout = timeout or float(os.getenv("FACEPHYS_TIMEOUT", "60"))
        self._transport = transport or self._urllib_transport
        if not self.key_id or not self.secret:
            raise RuntimeError("缺少 TTC_API_KEY_ID / TTC_API_SECRET")
        self.last_raw: dict | None = None
        self.last_latency = 0.0
        self.tokens_left: Optional[int] = None

    # ---------------------------------------------------------- 签名
    def auth_headers(self, ts: Optional[int] = None) -> dict:
        ts = int(ts if ts is not None else time.time())
        msg = str(ts).encode("utf-8")
        sig = base64.b64encode(
            hmac.new(self.secret.encode("utf-8"), msg, hashlib.sha256).digest()
        ).decode()
        return {"x-key-id": self.key_id,
                "x-timestamp": str(ts),
                "x-signature": sig}

    # ---------------------------------------------------------- 传输
    def _urllib_transport(self, method: str, url: str, body: Optional[bytes],
                          headers: dict, timeout: float):
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def _json(self, method: str, path: str, payload: dict | None = None,
              signed: bool = True, with_type: str = "application/json"):
        headers = {"Content-Type": with_type, "User-Agent": BROWSER_UA}
        if signed:
            headers.update(self.auth_headers())
        body = json.dumps(payload).encode() if payload is not None else None
        code, raw = self._transport(method, self.base + path, body, headers,
                                    self.timeout)
        text = raw.decode("utf-8", "replace")
        if code is None or code >= 400:
            raise FacePhysError(f"{method} {path} -> {code}: {text[:300]}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise FacePhysError(f"{path} 返回不是 JSON: {text[:200]}") from exc

    # ---------------------------------------------------------- 主流程
    def process_video(self, video: bytes, content_type: str = "video/mp4") -> dict:
        """三步走完，返回 API 的原始 data。"""
        t0 = time.monotonic()

        pre = self._json("POST", "/api/v2/video/upload/presign", {})
        upload_url = pre.get("uploadUrl") or pre.get("upload_url")
        object_key = pre.get("objectKey") or pre.get("object_key")
        if not upload_url or not object_key:
            raise FacePhysError(f"presign 返回缺字段: {pre}")

        code, raw = self._transport(
            "PUT", upload_url, video,
            {"Content-Type": content_type, "User-Agent": BROWSER_UA},
            self.timeout)
        if code is None or code >= 400:
            raise FacePhysError(f"OSS 上传失败 {code}: {raw[:200]!r}")

        res = self._json("POST", "/api/v3/video/process",
                         {"objectKey": object_key, "capability": "rppg"})
        self.last_latency = time.monotonic() - t0
        self.last_raw = res
        return res.get("data", res)

    # ---------------------------------------------------------- 映射
    def to_sample(self, data: dict, t: float) -> PhysioSample:
        """把 FacePhys 的返回映射成我们自己的采样结构。

        V3 key 返回分组结构 data.cardiac；老 key 返回扁平 data，两种都兼容。
        """
        cardiac = data.get("cardiac") or data
        hr = cardiac.get("hr")
        if hr is None:
            hr = data.get("hr")
        sqi = cardiac.get("sqi")
        if sqi is None:
            sqi = data.get("sqi", data.get("confidence"))

        rr = data.get("breathing_rate")
        if rr is None:
            rr = cardiac.get("breathing_rate") or cardiac.get("breathingrate")

        def _f(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        hr, rr, sqi = _f(hr), _f(rr), _f(sqi)

        if self.tokens_left is None:
            self.tokens_left = data.get("remaining_tokens")

        # 生理合理性闸门：rPPG 会吐离谱值
        if hr is not None and not (40 <= hr <= 180):
            hr, sqi = None, 0.0
        if rr is not None and not (4 <= rr <= 60):
            rr = None

        quality = max(0.0, min(1.0, sqi or 0.0))
        faces = 1 if (hr is not None or quality > 0) else 0
        return PhysioSample(t=t, hr=hr, rr=rr, quality=quality, face_count=faces)

    # ---------------------------------------------------------- 对外接口
    def sample_video(self, video: bytes, t: float,
                     content_type: str = "video/mp4") -> Optional[PhysioSample]:
        if not video:
            return PhysioSample(t=t, quality=0.0, face_count=0)
        data = self.process_video(video, content_type)
        return self.to_sample(data, t)

    def sample(self, frame: Optional[bytes], t: float) -> Optional[PhysioSample]:
        # 单帧接口无法满足 ≥15 秒的要求，直接声明"无话可说"，
        # 上层会忽略。绝不能返回 quality=0 的假样本污染基线。
        return None

    def sample_segment(self, frames: list[bytes],
                       t: float) -> Optional[PhysioSample]:
        return None


def get_facephys_provider() -> FacePhysProvider:
    return FacePhysProvider()
