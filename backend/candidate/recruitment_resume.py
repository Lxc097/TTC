"""Bounded PDF/DOCX extraction. Documents are data, never instructions."""
from __future__ import annotations

import io
import multiprocessing as mp
import queue as queue_module
import re
import zipfile
from pathlib import Path

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 30_000
MAX_PAGES = 40


class ResumeError(ValueError):
    pass


def validate_file(name: str, data: bytes) -> tuple[str, str]:
    suffix = Path(name).suffix.lower()
    if not data:
        raise ResumeError("简历文件为空。")
    if len(data) > MAX_FILE_BYTES:
        raise ResumeError("简历文件不能超过 8 MB。")
    if suffix == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise ResumeError("文件内容不是有效的 PDF。")
        return "pdf", "application/pdf"
    if suffix == ".docx":
        if not data.startswith(b"PK\x03\x04"):
            raise ResumeError("文件内容不是有效的 DOCX。")
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = set(archive.namelist())
                if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                    raise ResumeError("DOCX 缺少必要的文档内容。")
                if any("vbaproject" in item.lower() or item.lower().endswith(".exe") for item in names):
                    raise ResumeError("包含宏或可执行内容的文档不受支持。")
                if len(names) > 1_000 or sum(info.file_size for info in archive.infolist()) > 25 * 1024 * 1024:
                    raise ResumeError("DOCX 解压后内容过大。")
        except (zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
            raise ResumeError("DOCX 文件损坏。") from exc
        return "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    raise ResumeError("仅支持 PDF 或 DOCX 简历。")


def _clean(text: str) -> str:
    return (text.replace("\x00", "").replace("\r", "\n")
            .replace("\u00a0", " ").replace("\u200b", "")
            .replace("\t", "  ").strip())


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise ResumeError("加密 PDF 无法解析，请上传可读取的文件。")
    if len(reader.pages) > MAX_PAGES:
        raise ResumeError("PDF 页数不能超过 40 页。")
    pieces: list[str] = []
    for page in reader.pages:
        # Layout mode usually preserves columns and line breaks better than plain mode.
        try:
            piece = page.extract_text(extraction_mode="layout") or ""
        except (TypeError, ValueError):
            piece = page.extract_text() or ""
        pieces.append(piece)
        if sum(map(len, pieces)) > MAX_TEXT_CHARS * 2:
            break
    return "\n".join(pieces)


def _extract_docx(data: bytes) -> str:
    from docx import Document

    document = Document(io.BytesIO(data))
    lines = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    for table in document.tables:
        for row in table.rows:
            lines.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(lines)


_SECTIONS = {
    "education": re.compile(r"^(教育(背景|经历)?|学历|education|academic background)\b", re.I),
    "workExperience": re.compile(r"^(工作(经历|经验)?|职业经历|实习经历|work experience|employment|professional experience)\b", re.I),
    "projects": re.compile(r"^(项目(经历|经验)?|项目实践|projects?|project experience)\b", re.I),
    "skills": re.compile(r"^(技能(清单|专长)?|专业技能|技术栈|skills?|technical skills|expertise)\b", re.I),
    "certifications": re.compile(r"^(证书|资格证|certifications?|licenses?)\b", re.I),
    "achievements": re.compile(r"^(获奖|荣誉|成就|achievements?|awards?)\b", re.I),
}


def structure_resume(text: str) -> dict:
    text = _clean(text)[:MAX_TEXT_CHARS]
    if len(re.sub(r"\s", "", text)) < 20:
        raise ResumeError("没有提取到足够的可读文字；扫描版 PDF 请先进行 OCR。")
    lines = [re.sub(r"[ \t]+", " ", line).strip(" -•·|\t")
             for line in text.splitlines()]
    lines = [line for line in lines if line]
    email = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)
    phone = re.search(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)\+?[1-9]\d[\d ()-]{7,16}\d", text)
    links = list(dict.fromkeys(re.findall(r"https?://[^\s<>\]\[\"']+", text, re.I)))[:20]
    result: dict = {
        "name": None,
        "contact": {"email": email.group(0) if email else None,
                    "phone": phone.group(0).strip() if phone else None},
        "education": [], "workExperience": [], "projects": [],
        "skills": [], "certifications": [], "achievements": [],
        "portfolioLinks": links, "rawText": text,
    }
    for line in lines[:8]:
        if len(line) <= 35 and not any(symbol in line for symbol in ("@", "http", ":", "：")) \
                and not any(pattern.match(line) for pattern in _SECTIONS.values()):
            result["name"] = line
            break
    current = None
    section_lines: dict[str, list[str]] = {key: [] for key in _SECTIONS}
    for line in lines:
        heading = next((key for key, pattern in _SECTIONS.items()
                        if pattern.match(line) and len(line) < 70), None)
        if heading:
            current = heading
            tail = re.sub(_SECTIONS[heading], "", line).lstrip("：: -")
            if tail:
                section_lines[heading].append(tail)
        elif current:
            section_lines[current].append(line)
    for key in ("education", "workExperience", "projects"):
        result[key] = [{"text": item[:1_000]} for item in section_lines[key][:25]]
    for key in ("skills", "certifications", "achievements"):
        result[key] = [item[:300] for item in section_lines[key][:40]]
    return result


def parse_resume_bytes(kind: str, data: bytes) -> dict:
    raw = _extract_pdf(data) if kind == "pdf" else _extract_docx(data)
    return structure_resume(raw)


def _parse_worker(kind: str, data: bytes, queue: mp.Queue) -> None:
    try:
        queue.put((True, parse_resume_bytes(kind, data)))
    except Exception as exc:
        queue.put((False, str(exc)[:180] if isinstance(exc, ResumeError) else "文件无法解析。"))


def parse_resume_with_timeout(kind: str, data: bytes, timeout: float = 20.0) -> dict:
    """Hard-kill a hung parser so malformed files cannot hold a worker forever."""
    context = mp.get_context("spawn")
    queue = context.Queue(maxsize=1)
    process = context.Process(target=_parse_worker, args=(kind, data, queue), daemon=True)
    process.start()
    process.join(timeout)
    if process.is_alive():
        process.terminate()
        process.join(2)
        raise ResumeError("简历解析超时。")
    if process.exitcode != 0:
        raise ResumeError("简历文件无法解析。")
    try:
        ok, result = queue.get(timeout=1)
    except queue_module.Empty as exc:
        raise ResumeError("简历文件无法解析。") from exc
    finally:
        queue.close()
    if not ok:
        raise ResumeError(result)
    return result
