"""语音转文字（ASR）适配层。

为什么不用浏览器自带的识别：Chrome 的 `webkitSpeechRecognition` 直连 Google，
国内基本不通，实测报 `network`。所以把 ASR 放到服务端，换成阿里云百炼。

当前实现对：**阿里云百炼 DashScope · qwen3-asr-flash**
（实测：TTS 生成"我做过三年后端，主要负责订单系统。"，ASR 转回来一字不差。）

可插拔：上层只认 `transcribe(bytes) -> str | None`，换供应商只改这个文件。
失败一律返回 None，由调用方静默降级 —— 转写挂了不能拖垮面试流程。
"""
from __future__ import annotations

import time
from typing import Optional

import config


MIME_BY_FMT = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "ogg": "audio/ogg",
    "opus": "audio/opus",
    "webm": "audio/webm",
}


class DashScopeASR:
    """百炼 qwen3-asr-flash。

    实测两种传法：
    - `file://路径`：SDK 会先把文件传上去，多一次往返，且音频要落盘。
    - **data URI 内联 base64**：一次请求搞定，不写磁盘。现在用这个。
    """

    def __init__(self, api_key: str = "", model: str = "",
                 tmp_dir: str = "") -> None:
        self.api_key = api_key or config.STT_API_KEY
        self.model = model or config.STT_MODEL
        # 保留 tmp_dir 只为兼容旧配置；内联模式不再落盘。
        self.tmp_dir = tmp_dir or config.STT_TMP_DIR
        if not self.api_key:
            raise RuntimeError("缺少 STT_API_KEY（百炼的 key）")
        self.calls = 0
        self.failures = 0
        self.last_latency = 0.0
        self.last_error = ""

    @staticmethod
    def _data_uri(audio: bytes, fmt: str) -> str:
        import base64
        mime = MIME_BY_FMT.get((fmt or "webm").lower(), "audio/webm")
        return f"data:{mime};base64," + base64.b64encode(audio).decode()

    def _call(self, audio: bytes, fmt: str) -> Optional[str]:
        import dashscope
        from dashscope import MultiModalConversation

        dashscope.api_key = self.api_key
        resp = MultiModalConversation.call(
            model=self.model,
            messages=[{"role": "user", "content": [
                {"audio": self._data_uri(audio, fmt)}]}],
            result_format="message",
        )
        if getattr(resp, "status_code", 0) != 200:
            self.last_error = f"{getattr(resp, 'code', '')}:" \
                              f"{str(getattr(resp, 'message', ''))[:120]}"
            return None
        try:
            for item in resp.output["choices"][0]["message"]["content"]:
                txt = (item or {}).get("text")
                if txt:
                    return str(txt).strip()
            return None
        except (KeyError, IndexError, TypeError):
            self.last_error = f"返回结构异常: {str(resp.output)[:120]}"
            return None

    def transcribe(self, audio: bytes,
                   fmt: str = "webm") -> Optional[str]:
        """音频字节 → 文本。失败返回 None，调用方静默降级。"""
        if not audio or len(audio) < 1200:
            # 太短的一段基本是静音/气口，不值得花一次调用
            return None
        t0 = time.monotonic()
        self.calls += 1
        try:
            return self._call(audio, fmt)
        except Exception as exc:                     # noqa: BLE001
            self.failures += 1
            self.last_error = f"{type(exc).__name__}: {str(exc)[:140]}"
            return None
        finally:
            self.last_latency = time.monotonic() - t0


_STT = None
_INITED = False


def get_stt() -> Optional[DashScopeASR]:
    """全局单例。没开或没 key 时返回 None，上层自动退回手打输入。"""
    global _STT, _INITED
    if _INITED:
        return _STT
    _INITED = True
    if not config.STT_ENABLED or not config.STT_API_KEY:
        _STT = None
    else:
        try:
            _STT = DashScopeASR()
        except Exception:                            # noqa: BLE001
            _STT = None
    return _STT


def reset() -> None:
    """测试用。"""
    global _STT, _INITED
    _STT, _INITED = None, False
