"""Focused OCR fallback checks without sending private PDFs to a provider."""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from jianli.ocr import recognize_scanned_pdf  # noqa: E402
from candidate.recruitment_resume import ResumeError  # noqa: E402


class OCRTests(unittest.TestCase):
    @staticmethod
    def pdf() -> bytes:
        stream = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.write(stream)
        return stream.getvalue()

    def test_sends_pdf_to_deepseek_ocr_and_structures_text(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                return json.dumps({"choices": [{"message": {
                    "content": "张三\n工作经历\n负责 React 产品开发与维护。\n技能\nReact、TypeScript"
                }}]}, ensure_ascii=False).encode()

        with (patch.dict(os.environ, {"SILICONFLOW_API_KEY": "test-only-key"}),
              patch("jianli.ocr.urllib.request.urlopen", return_value=Response()) as call):
            parsed = recognize_scanned_pdf(self.pdf())
        request = call.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(payload["model"], "deepseek-ai/DeepSeek-OCR")
        self.assertTrue(payload["messages"][0]["content"][0]["image_url"]["url"].startswith(
            "data:application/pdf;base64,"))
        self.assertEqual(parsed["name"], "张三")
        self.assertTrue(parsed["workExperience"])

    def test_http_error_is_safe_and_identifiable(self) -> None:
        error = urllib.error.HTTPError("https://example.test", 429, "private", None, None)
        with (patch.dict(os.environ, {"SILICONFLOW_API_KEY": "test-only-key"}),
              patch("jianli.ocr.urllib.request.urlopen", side_effect=error),
              self.assertRaisesRegex(ResumeError, "HTTP 429") as captured):
            recognize_scanned_pdf(self.pdf())
        self.assertNotIn("test-only-key", str(captured.exception))
        self.assertNotIn("private", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
