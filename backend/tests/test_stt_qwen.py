"""Offline contract checks for the Qwen ASR adapter."""
import unittest
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from shared import config, stt


class QwenASRTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = stt.DashScopeASR(api_key="test-only-key", model="qwen3-asr-flash")

    @staticmethod
    def fake_sdk(response: Mock) -> ModuleType:
        sdk = ModuleType("dashscope")
        sdk.api_key = ""
        sdk.MultiModalConversation = SimpleNamespace(call=Mock(return_value=response))
        return sdk

    def test_inline_audio_and_text_response(self) -> None:
        response = Mock(status_code=200, output={"choices": [{"message": {
            "content": [{"text": "  我做过三年后端。  "}]}}]})
        sdk = self.fake_sdk(response)
        with patch.dict(sys.modules, {"dashscope": sdk}):
            self.assertEqual(self.client.transcribe(b"a" * 2000, "webm"), "我做过三年后端。")
        kwargs = sdk.MultiModalConversation.call.call_args.kwargs
        self.assertEqual(kwargs["model"], "qwen3-asr-flash")
        self.assertTrue(kwargs["messages"][0]["content"][0]["audio"].startswith(
            "data:audio/webm;base64,"))

    def test_failed_request_does_not_leak_key(self) -> None:
        sdk = self.fake_sdk(Mock(status_code=401, code="InvalidApiKey", message="invalid test-only-key"))
        with patch.dict(sys.modules, {"dashscope": sdk}):
            self.assertIsNone(self.client.transcribe(b"a" * 2000))
        self.assertNotIn("test-only-key", self.client.last_error)

    def test_short_audio_skips_api(self) -> None:
        self.assertIsNone(self.client.transcribe(b"a" * 100))

    def test_singleton_requires_enabled_shared_key(self) -> None:
        with patch.object(config, "STT_ENABLED", True), patch.object(
            config, "DASHSCOPE_API_KEY", "test-only-key"
        ):
            stt.reset()
            self.assertIsInstance(stt.get_stt(), stt.DashScopeASR)
        stt.reset()


if __name__ == "__main__":
    unittest.main()
