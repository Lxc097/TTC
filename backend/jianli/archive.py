"""Bounded in-memory import of one person's resume and supporting files."""
from __future__ import annotations

import hashlib
import io
import re
import zipfile
from pathlib import Path

from candidate.recruitment_resume import MAX_FILE_BYTES, ResumeError, parse_resume_with_timeout, validate_file

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 40
MAX_ARCHIVE_UNPACKED = 64 * 1024 * 1024
MAX_PROOFS = 24
_RESUME_NAME = re.compile(r"简历|履历|resume|curriculum|(?:^|[^a-z])cv(?:[^a-z]|$)", re.I)
_PROOF_NAME = re.compile(r"证明|证书|成绩|学位|奖状|附件|certificate|transcript|diploma|proof|portfolio", re.I)
_TYPES = {".pdf": "application/pdf", ".png": "image/png",
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    if info.file_size > MAX_FILE_BYTES or (info.compress_size and info.file_size > info.compress_size * 250):
        raise ResumeError("ZIP 中单个文件超过 8 MB，或压缩比异常。")
    with archive.open(info) as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ResumeError("ZIP 中单个文件不能超过 8 MB。")
    return data


def _resume_score(item: dict) -> int:
    name = item["name"]
    score = (10 if _RESUME_NAME.search(name) else 0) - (9 if _PROOF_NAME.search(name) else 0)
    try:
        parsed = parse_resume_with_timeout("pdf", item["data"], timeout=6)
    except (ResumeError, OSError, ValueError):
        return score - 20
    raw = parsed.get("rawText") or ""
    score += 2 if parsed.get("name") else 0
    score += 2 if parsed.get("contact", {}).get("email") else 0
    score += 1 if parsed.get("contact", {}).get("phone") else 0
    score += 2 * sum(bool(parsed.get(section)) for section in ("education", "workExperience", "projects"))
    score += 2 if re.search(r"教育经历|工作经历|项目经历|工作经验|education|experience|projects", raw, re.I) else 0
    return score


def unpack_candidate_archive(payload: bytes) -> tuple[str, bytes, list[dict]]:
    """Return one PDF resume and its proof files; never extract archive paths to disk."""
    if not payload or len(payload) > MAX_ARCHIVE_BYTES:
        raise ResumeError("ZIP 文件不能为空且不能超过 32 MB。")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()
                     and not info.filename.replace("\\", "/").startswith("__MACOSX/")
                     and Path(info.filename).name not in (".DS_Store", "Thumbs.db")]
            if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
                raise ResumeError("ZIP 须包含文件，且最多 40 个文件。")
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_UNPACKED:
                raise ResumeError("ZIP 解压后总量不能超过 64 MB。")
            files = []
            for info in infos:
                path = info.filename.replace("\\", "/")
                parts = path.split("/")
                if (path.startswith("/") or ":" in parts[0] or
                        any(part in ("", ".", "..") for part in parts) or
                        (info.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ResumeError("ZIP 包含不安全的文件路径。")
                if info.flag_bits & 1:
                    raise ResumeError("不支持加密 ZIP。")
                name = parts[-1][:180]
                suffix = Path(name).suffix.lower()
                if suffix not in _TYPES:
                    raise ResumeError("ZIP 只支持 PDF、PNG、JPG 形式的简历和佐证材料。")
                data = _read_member(archive, info)
                if suffix == ".pdf":
                    validate_file(name, data)
                elif suffix == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ResumeError("ZIP 中的 PNG 文件内容无效。")
                elif suffix in (".jpg", ".jpeg") and not data.startswith(b"\xff\xd8\xff"):
                    raise ResumeError("ZIP 中的 JPG 文件内容无效。")
                files.append({"name": name, "data": data, "content_type": _TYPES[suffix],
                              "sha256": hashlib.sha256(data).hexdigest()})
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError) as exc:
        raise ResumeError("ZIP 文件损坏或包含不支持的压缩格式。") from exc
    pdfs = [item for item in files if item["content_type"] == "application/pdf"]
    if not pdfs:
        raise ResumeError("ZIP 中没有 PDF 简历。")
    named = [item for item in pdfs if _RESUME_NAME.search(item["name"])
             and not _PROOF_NAME.search(item["name"])]
    if len(named) == 1:
        resume = named[0]
    elif len(pdfs) == 1:
        resume = pdfs[0]
    else:
        if len(pdfs) > 6:
            raise ResumeError("ZIP 中 PDF 较多，请将主文件命名为“简历.pdf”。")
        ranked = sorted(((_resume_score(item), item) for item in pdfs),
                        key=lambda pair: pair[0], reverse=True)
        if ranked[0][0] < 4 or ranked[0][0] - ranked[1][0] < 2:
            raise ResumeError("无法确定唯一简历，请将主 PDF 命名为“简历.pdf”后重试。")
        resume = ranked[0][1]
    proofs = [item for item in files if item is not resume]
    if len(proofs) > MAX_PROOFS:
        raise ResumeError("每个 ZIP 最多包含 24 份佐证材料。")
    for index, item in enumerate(proofs, 1):
        item["name"] = f"{index:02d}-{item['name']}"
    return resume["name"], resume["data"], proofs
