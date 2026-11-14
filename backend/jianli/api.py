"""HR-only batch resume import, proof access, and failed-resume retry."""
from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from candidate import recruitment_store as repo
from candidate.recruitment_api import _hr_dto, hr
from candidate.recruitment_resume import MAX_FILE_BYTES, ResumeError, validate_file
from jianli.archive import MAX_ARCHIVE_BYTES, unpack_candidate_archive

router = APIRouter()
MAX_BATCH_FILES = 30
MAX_BATCH_BYTES = 96 * 1024 * 1024
MAX_STORED_BYTES = 128 * 1024 * 1024


def _store_hr_resume(user: dict, job_id: str, name: str, data: bytes,
                     proofs: list[dict]) -> dict:
    _, content_type = validate_file(name, data)
    target_dir = repo.data_dir() / "resumes"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / (uuid.uuid4().hex + ".pdf")
    with target.open("xb") as stream:
        stream.write(data)
    try:
        app_id = repo.create_hr_import(
            user["companyId"], user["id"], job_id,
            Path(name).stem[:100] or "待识别候选人", name, content_type,
            str(target), hashlib.sha256(data).hexdigest(), proofs,
        )
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return _hr_dto(repo.hr_application(app_id, user["companyId"]))


@router.post("/api/hr/resumes/batch", status_code=202)
async def import_hr_batch(files: list[UploadFile] = File(...), jobId: str = Form(...),
                          permissionConfirmed: bool = Form(...),
                          user: dict = Depends(hr)) -> dict:
    if not permissionConfirmed:
        raise HTTPException(422, "请确认已获得处理这些简历用于当前岗位评估的授权。")
    job = repo.get_job(jobId)
    if not job or job["company_id"] != user["companyId"]:
        raise HTTPException(404, "岗位不存在或不属于当前企业。")
    if not files or len(files) > MAX_BATCH_FILES:
        raise HTTPException(422, "一次最多导入 30 个 PDF 或 ZIP 文件。")
    imported, errors = [], []
    total_bytes = stored_bytes = 0
    for uploaded in files:
        source_name = (uploaded.filename or "").replace("\\", "/").split("/")[-1][:180]
        suffix = Path(source_name).suffix.lower()
        if suffix not in (".pdf", ".zip"):
            errors.append({"file": source_name, "message": "只支持 PDF 或 ZIP。"})
            continue
        limit = MAX_ARCHIVE_BYTES if suffix == ".zip" else MAX_FILE_BYTES
        payload = await uploaded.read(limit + 1)
        total_bytes += len(payload)
        if total_bytes > MAX_BATCH_BYTES:
            errors.append({"file": source_name, "message": "本批次超过 96 MB，本文件及后续文件未处理。"})
            break
        try:
            if suffix == ".zip":
                resume_name, resume_data, proofs = await asyncio.to_thread(
                    unpack_candidate_archive, payload)
            else:
                resume_name, resume_data, proofs = source_name, payload, []
            validate_file(resume_name, resume_data)
            next_bytes = stored_bytes + len(resume_data) + sum(len(item["data"]) for item in proofs)
            if next_bytes > MAX_STORED_BYTES:
                raise ResumeError("本批次解压后总量不能超过 128 MB。")
            record = await asyncio.to_thread(_store_hr_resume, user, jobId,
                                             resume_name, resume_data, proofs)
            imported.append({"file": source_name, "application": record})
            stored_bytes = next_bytes
        except (ResumeError, ValueError) as exc:
            errors.append({"file": source_name, "message": str(exc)[:180]})
        except (sqlite3.Error, OSError):
            errors.append({"file": source_name, "message": "写入失败，请稍后重试。"})
    return {"items": imported, "errors": errors,
            "counts": repo.resume_source_counts(user["companyId"])}


@router.get("/api/hr/applications/{app_id}/attachments/{attachment_id}")
def view_attachment(app_id: str, attachment_id: str,
                    user: dict = Depends(hr)) -> Response:
    if not repo.hr_application(app_id, user["companyId"]):
        raise HTTPException(404, "佐证材料不存在。")
    attachment = repo.get_attachment(app_id, attachment_id)
    if not attachment:
        raise HTTPException(404, "佐证材料不存在。")
    return Response(attachment["content"], media_type=attachment["content_type"],
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/api/hr/applications/{app_id}/resume/retry", status_code=202)
def retry_resume(app_id: str, user: dict = Depends(hr)) -> dict:
    if not repo.hr_application(app_id, user["companyId"]):
        raise HTTPException(404, "申请不存在。")
    if not repo.requeue_resume(app_id):
        raise HTTPException(409, "当前简历识别状态不需要重试。")
    return {"resumeStatus": "queued", "screeningStatus": "queued"}
