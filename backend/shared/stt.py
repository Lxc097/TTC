"""SiliconFlow speech-to-text adapter for the classic interview room."""
from __future__ import annotations

import time
from typing import Optional

import requests

from shared import config


MIME_BY_FMT = {
    "wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4",
    "mp4": "audio/mp4", "ogg": "audio/ogg", "opus": "audio/opus",
    "webm": "audio/webm",
}


class SiliconFlowASR:
    """Send audio chunks to POST /v1/audio/transcriptions."""

    def __init__(self, api_key: str = "", model: str = "",
                 base_url: str = "") -> None:
        self.api_key = api_key or config.SILICONFLOW_API_KEY
        self.model = model or config.STT_MODEL
        self.base_url = (base_url or config.SILICONFLOW_BASE_URL).rstrip("/")
        if not self.api_key:
            raise RuntimeError("缺少 SILICONFLOW_API_KEY")
        self.calls = 0
        self.failures = 0
        self.last_latency = 0.0
        self.last_error = ""

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
            self.last_error = (f"HTTP {response.status_code}: " + detail.replace(
                self.api_key, "[redacted]")).replace(chr(10), " ")[:140]
            return None
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            self.last_error = "ASR 返回缺少 text 字段"
            return None
        return text.strip() or None

    def transcribe(self, audio: bytes, fmt: str = "webm") -> Optional[str]:
        """Return text or None; do not interrupt an interview on ASR failure."""
        self.last_error = ""
        if not audio or len(audio) < 1200:
            return None
        if len(audio) > 50 * 1024 * 1024:
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


_STT: Optional[SiliconFlowASR] = None
_INITED = False


def get_stt() -> Optional[SiliconFlowASR]:
    """Return the singleton only when STT is enabled and keyed."""
    global _STT, _INITED
    if _INITED:
        return _STT
    _INITED = True
    if config.STT_ENABLED and config.SILICONFLOW_API_KEY:
        try:
            _STT = SiliconFlowASR()
        except Exception:  # noqa: BLE001
            _STT = None
    return _STT


def reset() -> None:
    """Reset the singleton in tests."""
    global _STT, _INITED
    _STT, _INITED = None, False
