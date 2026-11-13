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

import config

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
        self.last_deducted: Optional[int] = None
        self.last_rr_reason = ""
        self.last_rr_detail = ""
        self.last_liveness: dict = {}
        self.last_hr_stats: dict = {}
        self.last_hr_unstable = False
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

    # ---------------------------------------------------------- 逐点序列
    @staticmethod
    def _hr_series(cardiac: dict, data: dict) -> list[float]:
        """取 cardiac.hr_list（可能是 [{hr, ts}] 或纯数字数组）。"""
        raw = cardiac.get("hr_list") or data.get("hr_list") or []
        out: list[float] = []
        for item in raw:
            v = item.get("hr") if isinstance(item, dict) else item
            try:
                out.append(float(v))
            except (TypeError, ValueError):
                continue
        return out

    def _analyse_series(self, series: list[float]) -> dict:
        """分析逐点心率，判断这段数据是不是可信。

        为什么要看这个：aggregate 的 hr 会被中途的伪跳变带偏。
        实测一条素材里 0.9 秒内 hr 从 85 跳到 117.5，
        聚合值最后给了 117.9，而前 7 个点都在 85~92。
        生理上不可能 1 秒涨 32 bpm，那是算法换段产生的伪影。
        """
        if len(series) < 3:
            return {}
        jumps = [abs(b - a) for a, b in zip(series, series[1:])]
        stats = {
            "points": len(series),
            "min": round(min(series), 1),
            "max": round(max(series), 1),
            "range": round(max(series) - min(series), 1),
            "max_jump": round(max(jumps), 1) if jumps else 0.0,
        }
        stats["unstable"] = stats["max_jump"] > config.HR_MAX_JUMP
        return stats

    # ---------------------------------------------------------- 映射
    def to_sample(self, data: dict, t: float) -> PhysioSample:
        """把 FacePhys 的返回映射成我们自己的采样结构。

        兼容三种返回形态：
          - V3 分组：data.cardiac.{hr, sqi, hrv}
          - V2 扁平：data.{hr, confidence, hrv}
          - 各种字段集（basic 只有 hr+confidence；standard 才有 breathing_rate）

        呼吸率在不同返回里位置不一样，实测会在 data / cardiac / hrv 三个层级出现，
        所以三个都找一遍 —— 之前在顶层找不到就丢掉，是 bug。
        """
        cardiac = data.get("cardiac") or data
        hrv = cardiac.get("hrv") or data.get("hrv") or {}

        # 逐点序列分析：伪跳变的数据不能进基线，否则会污染后续所有判断
        series = self._hr_series(cardiac, data)
        stats = self._analyse_series(series)
        self.last_hr_stats = stats
        self.last_hr_unstable = bool(stats.get("unstable"))

        hr = cardiac.get("hr")
        if hr is None:
            hr = data.get("hr")

        quality = cardiac.get("sqi")
        if quality is None:
            quality = data.get("sqi", data.get("confidence"))

        rr = data.get("breathing_rate")
        if rr is None:
            rr = cardiac.get("breathing_rate")
        if rr is None:
            rr = cardiac.get("breathingrate")
        if rr is None:
            rr = hrv.get("breathing_rate")

        def _f(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        hr, rr, quality = _f(hr), _f(rr), _f(quality)

        # 换算出 Token 用量（points_* 是历史别名，单位也是 Token）
        left = data.get("remaining_tokens", data.get("remaining_points"))
        if left is not None:
            self.tokens_left = int(left)
        deducted = data.get("tokens_deducted", data.get("points_deducted"))
        if deducted is not None:
            self.last_deducted = int(deducted)

        # 指标为什么没出来：**不要猜字段集**，接口自己会说话。
        # 实测 rr 为空是因为 hr_list 为空 → 没有逐拍间期 → HRV 整条链全灭，
        # indicators_status 里 22 项全是 not_available。跟 fieldSet 没关系。
        status = data.get("indicators_status") or {}
        rr_status = status.get("rr") or {}
        if rr is None:
            self.last_rr_reason = rr_status.get("status") or "not_returned"
            self.last_rr_detail = rr_status.get("reason") or ""
        else:
            self.last_rr_reason = ""
            self.last_rr_detail = ""

        # 活体检测：接口白送的，正好支撑「防代面」叙事
        live = data.get("liveness") or {}
        if live:
            self.last_liveness = {
                "is_live": live.get("is_live"),
                "score": live.get("liveness_score"),
                "status": live.get("status"),
                "reason": live.get("rejected_reason") or "",
                "blink_rate": (live.get("signals") or {}).get("blink_rate"),
            }

        # 生理合理性闸门：rPPG 会吐离谱值；breathing_rate 在缺数据时返回 0，也要挡掉
        if hr is not None and not (40 <= hr <= 180):
            hr, quality = None, 0.0
        if rr is not None and not (4 <= rr <= 60):
            rr = None

        # 伪跳变：逐点序列里出现生理上不可能的跳变，整段判不可用。
        # 这条比阈值更硬：宁可这一段不出结果，也不能把伪影写进基线。
        if self.last_hr_unstable:
            quality = 0.0

        quality = max(0.0, min(1.0, quality or 0.0))
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
