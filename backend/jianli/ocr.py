"""Server-side OCR fallback for image-only PDF resumes via SiliconFlow."""
from __future__ import annotations

import base64
import io
import json
import os
import re
import urllib.error
import urllib.request

from pypdf import PdfReader

from candidate.recruitment_resume import ResumeError, structure_resume

OCR_MAX_BYTES = 5 * 1024 * 1024
OCR_MAX_PAGES = 8
OCR_MODEL = "deepseek-ai/DeepSeek-OCR"


def recognize_scanned_pdf(data: bytes) -> dict:
    """Send a bounded scanned PDF to DeepSeek-OCR and parse its recognized text."""
    if len(data) > OCR_MAX_BYTES:
        raise ResumeError("扫描版 PDF 超过 OCR 的 5 MB 限制，请压缩后重试。")
    try:
        page_count = len(PdfReader(io.BytesIO(data), strict=False).pages)
    except Exception as exc:
        raise ResumeError("扫描版 PDF 无法读取页数。") from exc
    if not 1 <= page_count <= OCR_MAX_PAGES:
        raise ResumeError("扫描版 PDF 的 OCR 最多支持 8 页。")
    api_key = os.getenv("SILICONFLOW_API_KEY", "").strip()
    if not api_key:
        raise ResumeError("未配置硅基流动密钥，扫描版 PDF 无法进行 OCR。")
    base_url = os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
    body = json.dumps({
        "model": OCR_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {
                "url": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii")}},
            {"type": "text", "text": "<image>\n<|grounding|>Convert the document to markdown."},
        ]}],
        "max_tokens": 4096,
        "stream": False,
    }).encode("utf-8")
    request = urllib.request.Request(base_url + "/chat/completions", data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read(1_000_001).decode("utf-8", "replace"))
        content = payload["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as exc:
        raise ResumeError(f"扫描版 PDF OCR 请求失败（HTTP {exc.code}）。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ResumeError("扫描版 PDF OCR 连接失败或超时。") from None
    except (ValueError, KeyError, IndexError, TypeError):
        raise ResumeError("扫描版 PDF OCR 返回内容无效。") from None
    if not isinstance(content, str):
        raise ResumeError("扫描版 PDF OCR 未返回可读文字。")
    # DeepSeek-OCR may include layout/image markers; they are not resume text.
    content = re.sub(r"<\|[^|>]{1,80}\|>", "", content)
    content = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", content)
    return structure_resume(content)
