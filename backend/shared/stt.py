"""Speech-to-text adapters for the classic interview room.

两套实现，二选一：

- ``DashScopeASR``：阿里云百炼 ``qwen3-asr-flash``，音频内联成 base64 data URI
  走多模态接口。
- ``SiliconFlowASR``：硅基流动 ``/audio/transcriptions``，multipart 上传音频。

选哪个由 ``shared.config`` 决定：配了 ``DASHSCOPE_API_KEY`` 就优先百炼，否则退回
SiliconFlow；两边都没配就等于"未启用"，房间自动只让候选人手打。转写失败一律返回
``None``，绝不打断面试。
"""
from __future__ import annotations

import base64
import time
from typing import Optional

import requests

from shared import config


MIME_BY_FMT = {
    "wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4",
    "mp4": "audio/mp4", "ogg": "audio/ogg", "opus": "audio/opus",
    "webm": "audio/webm",
}

MAX_AUDIO_BYTES = 50 * 1024 * 1024
MIN_AUDIO_BYTES = 1200


class _ASRBase:
    """共享的调用节奏：弱音频跳过、超长拒绝、失败只记录不抛出。"""

    provider = ""
    model = ""
    api_key = ""

    def __init__(self, api_key: str, model: str, missing_key: str) -> None:
        if not api_key:
            raise RuntimeError(missing_key)
        self.api_key = api_key
        self.model = model
        self.calls = 0
        self.failures = 0
        self.last_latency = 0.0
        self.last_error = ""

    # ---------------------------------------------------------------- 子类实现
    def _call(self, audio: bytes, fmt: str) -> Optional[str]:
        raise NotImplementedError

    # ---------------------------------------------------------------- 公共入口
    def transcribe(self, audio: bytes, fmt: str = "webm") -> Optional[str]:
        """Return text or None; do not interrupt an interview on ASR failure."""
        self.last_error = ""
        if not audio or len(audio) < MIN_AUDIO_BYTES:
            return None
        if len(audio) > MAX_AUDIO_BYTES:
            self.last_error = "音频超过 50MB 限制"
            return None
        start = time.monotonic()
        self.calls += 1
        try:
            return self._call(audio, fmt)
        except Exception as exc:  # noqa: BLE001
            self.failures += 1
            self.last_error = (f"{type(exc).__name__}: {exc}".replace(
                self.api_key, "[redacted]")).replace(chr(10), " ")[:140]
            return None
        finally:
            self.last_latency = time.monotonic() - start

    def _mime(self, fmt: str) -> str:
        return MIME_BY_FMT.get((fmt or "webm").lower(), MIME_BY_FMT["webm"])

    def _redacted(self, text: str) -> str:
        return text.replace(self.api_key, "[redacted]").replace(chr(10), " ")[:140]


def _qwen_text(output: object) -> Optional[str]:
    """从百炼多模态返回里取转写文本，兼容 dict 和 SDK 对象两种形态。"""
    if output is None:
        return None

    def field(obj: object, name: str) -> object:
        if isinstance(obj, dict):
            return obj.get(name)
        return getattr(obj, name, None)

    plain = field(output, "text")
    if isinstance(plain, str) and plain.strip():
        return plain
    choices = field(output, "choices")
    if not isinstance(choices, (list, tuple)):
        return None
    for choice in choices:
        content = field(field(choice, "message"), "content")
        if isinstance(content, str) and content.strip():
            return content
        if not isinstance(content, (list, tuple)):
            continue
        for part in content:
            value = field(part, "text")
            if isinstance(value, str) and value.strip():
                return value
    return None


class DashScopeASR(_ASRBase):
    """Send inline base64 audio to DashScope's multimodal ASR endpoint."""

    provider = "qwen"

    def __init__(self, api_key: str = "", model: str = "") -> None:
        super().__init__(api_key or config.DASHSCOPE_API_KEY,
                         model or config.QWEN_ASR_MODEL,
                         "缺少 DASHSCOPE_API_KEY")

    def _call(self, audio: bytes, fmt: str) -> Optional[str]:
        import dashscope
        from dashscope import MultiModalConversation

        dashscope.api_key = self.api_key
        payload = f"data:{self._mime(fmt)};base64," + base64.b64encode(
            audio).decode("ascii")
        response = MultiModalConversation.call(
            model=self.model,
            messages=[{"role": "user", "content": [{"audio": payload}]}],
        )
        status = getattr(response, "status_code", 200)
        if status != 200:
            code = str(getattr(response, "code", "") or "")
            message = str(getattr(response, "message", "") or "")
            detail = (code + " " + message).strip() or "transcription request failed"
            self.last_error = self._redacted(f"HTTP {status}: " + detail)
            return None
        text = _qwen_text(getattr(response, "output", None))
        if text is None:
            self.last_error = "ASR 返回缺少 text 字段"
            return None
        return text.strip() or None


class SiliconFlowASR(_ASRBase):
    """Send audio chunks to POST /v1/audio/transcriptions."""

    provider = "siliconflow"

    def __init__(self, api_key: str = "", model: str = "",
                 base_url: str = "") -> None:
        super().__init__(api_key or config.SILICONFLOW_API_KEY,
                         model or config.STT_MODEL,
                         "缺少 SILICONFLOW_API_KEY")
        self.base_url = (base_url or config.SILICONFLOW_BASE_URL).rstrip("/")

    def _call(self, audio: bytes, fmt: str) -> Optional[str]:
        fmt = (fmt or "webm").lower()
        if fmt not in MIME_BY_FMT:
            fmt = "webm"
        response = requests.post(
            f"{self.base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            data={"model": self.model},
            files={"file": (f"speech.{fmt}", audio, MIME_BY_FMT[fmt])},
            timeout=(5, 15),
        )
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if not response.ok:
            detail = payload.get("message") if isinstance(payload, dict) else None
            if not isinstance(detail, str):
                detail = "transcription request failed"
            self.last_error = self._redacted(
                f"HTTP {response.status_code}: " + detail)
            return None
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            self.last_error = "ASR 返回缺少 text 字段"
            return None
        return text.strip() or None


_STT: Optional[_ASRBase] = None
_INITED = False


def provider() -> str:
    """当前生效的转写供应商：qwen / siliconflow / 空字符串（未启用）。"""
    if not config.STT_ENABLED:
        return ""
    if config.DASHSCOPE_API_KEY:
        return "qwen"
    if config.SILICONFLOW_API_KEY:
        return "siliconflow"
    return ""


def active_model() -> str:
    """前端展示用的模型名，跟随实际生效的供应商。"""
    return config.QWEN_ASR_MODEL if provider() == "qwen" else config.STT_MODEL


def get_stt() -> Optional[_ASRBase]:
    """Return the singleton only when STT is enabled and keyed."""
    global _STT, _INITED
    if _INITED:
        return _STT
    _INITED = True
    kind = provider()
    try:
        if kind == "qwen":
            _STT = DashScopeASR()
        elif kind == "siliconflow":
            _STT = SiliconFlowASR()
    except Exception:  # noqa: BLE001
        _STT = None
    return _STT


def reset() -> None:
    """Reset the singleton in tests."""
    global _STT, _INITED
    _STT, _INITED = None, False
