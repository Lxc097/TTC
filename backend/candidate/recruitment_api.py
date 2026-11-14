"""Authenticated, tenant-scoped resume applications and asynchronous screening."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import access_gate
from candidate import pipeline
from candidate import recruitment_store as repo
from candidate.recruitment_evidence import verify_supplied_links
from candidate.interview_analysis_service import analyze_interview
from candidate.recruitment_resume import MAX_FILE_BYTES, ResumeError, parse_resume_with_timeout, validate_file
from jianli.ocr import recognize_scanned_pdf
from candidate.resume_screening_prompt import PROMPT_VERSION
from candidate.resume_screening_service import ScreeningError, config as screening_config, screen_resume
from shared import config
from shared.store import STORE, default_questions

router = APIRouter()
_worker: asyncio.Task | None = None
_room_guard = threading.Lock()


class RegisterBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=200)
    role: str = "candidate"
    companyName: str | None = Field(default=None, max_length=120)
    hrRegistrationCode: str | None = None


class LoginBody(BaseModel):
    email: str
    password: str


def demo_enabled(request: Request) -> bool:
    """本机演示模式是否生效。

    两个判据，满足其一即可：

    1. 客户端是 loopback —— 原判据，只在"同一台机器上直接开浏览器"时成立。
    2. 测试口令已验证 —— 一旦套上 nginx / cloudflared / frp 之类的反向代理，
       第 1 条就**永远成立**（代理都是从 127.0.0.1 连过来的），它就不再是安全
       边界了。所以真正诚实的判据是"这个人是我们放进来的人"，也就是口令。

    换句话说：这道检查拦不住"经过代理的陌生人"，能拦住他们的是 ``AccessGate``。
    """
    if os.getenv("RECRUITMENT_DEMO_MODE") != "1" or not request.client:
        return False
    if access_gate.verified_request(request, config.ACCESS_CODE, config.ACCESS_CODE_DAYS):
        return True
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        return False


class JobBody(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    description: str = Field(min_length=30, max_length=12_000)


class ReviewBody(BaseModel):
    decision: str
    notes: str = Field(default="", max_length=2000)


class CorrectionBody(BaseModel):
    message: str = Field(min_length=10, max_length=1000)


class CriteriaBody(BaseModel):
    criteria: str = Field(default="", max_length=4000)


class HumanInterviewBody(BaseModel):
    scheduledAt: float = Field(gt=0)
    durationMinutes: int = Field(default=45, ge=15, le=240)
    interviewerName: str = Field(min_length=2, max_length=60)
    mode: str = Field(default="video", pattern="^(video|onsite|phone)$")
    location: str | None = Field(default=None, max_length=120)


class HumanInterviewUpdateBody(BaseModel):
    scheduledAt: float | None = Field(default=None, gt=0)
    durationMinutes: int | None = Field(default=None, ge=15, le=240)
    interviewerName: str | None = Field(default=None, min_length=2, max_length=60)
    mode: str | None = Field(default=None, pattern="^(video|onsite|phone)$")
    location: str | None = Field(default=None, max_length=120)
    result: str | None = Field(default=None, pattern="^(pass|hold|reject)$")
    notes: str | None = Field(default=None, max_length=2000)
    resultSent: bool | None = None


class ResendBody(BaseModel):
    days: int | None = Field(default=None, ge=1, le=60)


class ResultSendBody(BaseModel):
    visible: bool


def actor(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "请先登录。")
    user = repo.get_user_for_token(authorization[7:])
    if not user:
        raise HTTPException(401, "登录已失效，请重新登录。")
    return user


def candidate(user: dict = Depends(actor)) -> dict:
    if user["role"] != "candidate":
        raise HTTPException(403, "仅候选人可执行此操作。")
    return user


def hr(user: dict = Depends(actor)) -> dict:
    if user["role"] != "hr" or not user.get("companyId"):
        raise HTTPException(403, "仅企业 HR 可执行此操作。")
    return user


def _candidate_dto(row: dict) -> dict:
    """候选人可见的状态：阶段、邀请时间、真人面试安排与（已发送的）结论。

    这里刻意不出现报告、评分、审核意见、面试官备注：个人端只回答
    「我在哪一步、下一步做什么」，企业内部判断留在企业端。
    """
    stage = pipeline.stage_of(row["status"])
    invitation = None
    if row["invitation_id"]:
        state = pipeline.invitation_state(row["invitation_status"],
                                          row["invitation_expires_at"],
                                          row["invitation_accepted_at"])
        invitation = {"id": row["invitation_id"], "status": row["invitation_status"],
                      "state": state, "stateLabel": pipeline.state_label(state),
                      "sentAt": row["invitation_sent_at"],
                      "expiresAt": row["invitation_expires_at"],
                      "acceptedAt": row["invitation_accepted_at"],
                      "interviewPath": "/ai-interview/?application=" + row["id"]}
    human_interview = None
    if row.get("human_status"):
        state = pipeline.human_state(row["human_status"], row["human_result"],
                                     row["human_expires_at"], row["human_accepted_at"])
        human_interview = {
            "state": state, "stateLabel": pipeline.state_label(state),
            "scheduledAt": row["human_scheduled_at"],
            "durationMinutes": row["human_duration_minutes"],
            "interviewerName": row["human_interviewer_name"], "mode": row["human_mode"],
            "location": row["human_location"], "roomCode": row["human_room_code"],
            "enterable": bool(row["human_mode"] == "video"
                              and state in (pipeline.PENDING, pipeline.ACCEPTED)),
        }
    result = None
    if row.get("human_result") and row.get("human_result_sent"):
        result = {"visible": True, "conclusion": pipeline.result_label(row["human_result"]),
                  "message": pipeline.result_message(row["human_result"])}
    ai_result = None
    if row["invitation_id"]:
        ai_result = {"visible": bool(row["invitation_result_sent"]),
                     "message": pipeline.AI_RESULT_MESSAGE if row["invitation_result_sent"] else ""}
    # The query itself excludes reports and review data.
    return {"id": row["id"], "jobId": row["job_id"], "jobTitle": row["job_title"],
            "companyName": row["company_name"], "status": row["status"],
            "stage": stage, "stageLabel": pipeline.stage_label(stage),
            "resumeStatus": row["resume_status"], "screeningStatus": row["screening_status"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "resumeError": row["resume_error"] if row["resume_status"] == "failed" else None,
            "invitation": invitation, "humanInterview": human_interview,
            "result": result, "aiResult": ai_result}


def _human_interview_dto(row: dict) -> dict | None:
    """企业端视角的真人面试记录（含内部备注与结论）。"""
    if not row.get("human_id"):
        return None
    state = pipeline.human_state(row["human_status"], row["human_result"],
                                 row["human_expires_at"], row["human_accepted_at"])
    return {"id": row["human_id"], "status": row["human_status"], "state": state,
            "stateLabel": pipeline.state_label(state),
            "scheduledAt": row["human_scheduled_at"],
            "durationMinutes": row["human_duration_minutes"],
            "interviewerName": row["human_interviewer_name"], "mode": row["human_mode"],
            "location": row["human_location"], "roomCode": row["human_room_code"],
            "sentAt": row["human_sent_at"], "expiresAt": row["human_expires_at"],
            "acceptedAt": row["human_accepted_at"], "sendCount": row["human_send_count"],
            "lastSentAt": row["human_last_sent_at"], "result": row["human_result"],
            "resultLabel": pipeline.result_label(row["human_result"]) if row["human_result"] else None,
            "resultSent": bool(row["human_result_sent"]), "notes": row["human_notes"]}


def _hr_dto(row: dict, detail: bool = False) -> dict:
    screening = json.loads(row["report_json"]) if row["report_json"] else None
    profile = screening.get("candidateProfile") if screening else None
    profile = profile if isinstance(profile, dict) else {}
    parsed_resume = json.loads(row["parsed_json"]) if detail and row["parsed_json"] else None
    imported = row["source"] == "hr_import"
    room = STORE.get_room(row["room_code"]) if row["room_code"] else None
    if (detail and row["invitation_id"]
            and row["invitation_status"] != "completed"
            and (room is None or room.application_id != row["id"])):
        # SQLite keeps the invitation after a restart, while the live room
        # registry is in memory. Rebuild only when HR opens its detail page.
        room = _ensure_room(row)
        row = {**row, "room_code": room.code}
    invitation = None
    if row["invitation_id"]:
        state = pipeline.invitation_state(row["invitation_status"],
                                          row["invitation_expires_at"],
                                          row["invitation_accepted_at"])
        invitation = {"id": row["invitation_id"], "status": row["invitation_status"],
                      "state": state, "stateLabel": pipeline.state_label(state),
                      "roomCode": row["room_code"],
                      "sentAt": row["invitation_sent_at"],
                      "expiresAt": row["invitation_expires_at"],
                      "acceptedAt": row["invitation_accepted_at"],
                      "sendCount": row["invitation_send_count"],
                      "lastSentAt": row["invitation_last_sent_at"],
                      "resultSent": bool(row["invitation_result_sent"]),
                      "interviewPath": ("/classic/?room=" + room.code + "&ticket=" + room.interviewer_ticket)
                      if room and room.interviewer_ticket else None}
    result = {"id": row["id"], "jobId": row["job_id"], "jobTitle": row["job_title"],
              "companyName": row["company_name"],
              "candidateName": profile.get("name") or (parsed_resume or {}).get("name") or row["candidate_name"],
              "candidateEmail": (profile.get("email") or ((parsed_resume or {}).get("contact") or {}).get("email")) if imported
              else row["candidate_email"], "createdAt": row["created_at"],
              "source": row["source"],
              "attachmentCount": row["attachment_count"],
              "candidateProfile": profile or None,
              "status": row["status"],
              "stage": pipeline.stage_of(row["status"]),
              "stageLabel": pipeline.stage_label(pipeline.stage_of(row["status"])),
              "resumeStatus": row["resume_status"],
              "screeningStatus": row["screening_status"],
              "matchScore": screening["jobMatch"]["score"] if screening else None,
              "recommendation": screening["screeningRecommendation"] if screening else None,
              "reviewStatus": row["review_decision"],
              "aiResultSent": bool(row["invitation_result_sent"]) if row["invitation_id"] else False,
              "invitation": invitation, "humanInterview": _human_interview_dto(row)}
    if detail:
        result.update({"fileName": row["original_name"],
                       "uploadedBy": row["uploaded_by_name"] if imported else None,
                       "resumeDownloadPath": "/api/hr/applications/" + row["id"] + "/resume",
                       "parsedResume": parsed_resume,
                       "resumeError": row["resume_error"], "screening": screening,
                       "screeningError": row["screening_error"],
                       "screeningMeta": {"model": row["model"], "promptVersion": row["prompt_version"],
                                         "attempts": row["attempts"], "promptTokens": row["prompt_tokens"],
                                         "completionTokens": row["completion_tokens"]},
                       "evidence": repo.list_evidence(row["id"]),
                       "attachments": repo.list_attachments(row["id"]),
                       "corrections": repo.list_corrections(row["id"]),
                       "formalInterview": repo.formal_interview_summary(row["id"]),
                       "interviewRoomReport": repo.interview_report(row["id"]),
                       "review": {"decision": row["review_decision"], "notes": row["review_notes"],
                                  "updatedAt": row["reviewed_at"]} if row["review_decision"] else None})
    return result


def _process_one(app_id: str) -> None:
    row = repo.get_application_by_id(app_id)
    if not row:
        return
    try:
        if row["parsed_json"]:
            parsed = json.loads(row["parsed_json"])
            repo.save_parsed_resume(app_id, row["raw_text"], parsed)
        else:
            data = Path(row["file_path"]).read_bytes()
            kind = "pdf" if row["original_name"].lower().endswith(".pdf") else "docx"
            try:
                parsed = parse_resume_with_timeout(kind, data)
            except ResumeError as exc:
                if kind != "pdf" or "没有提取到足够的可读文字" not in str(exc):
                    raise
                parsed = recognize_scanned_pdf(data)
            repo.save_parsed_resume(app_id, parsed["rawText"], parsed)
    except (ResumeError, OSError, ValueError) as exc:
        repo.save_resume_failure(app_id, str(exc)[:180])
        return
    evidence = verify_supplied_links(parsed.get("portfolioLinks", []), bool(row["verify_links"]))
    repo.save_evidence(app_id, evidence)
    try:
        report, meta = screen_resume(parsed, {"description": row["job_description"],
                                       "title": row["job_title"]}, evidence,
                                     criteria=row["job_criteria"] or "")
        repo.save_screening(app_id, report, meta["model"], meta["promptVersion"],
                            meta["attempts"], meta.get("promptTokens"), meta.get("completionTokens"))
    except ScreeningError as exc:
        settings = screening_config()
        repo.save_screening_failure(app_id, str(exc)[:180], settings["model"], PROMPT_VERSION,
                                    exc.attempts or 1)


def _process_interview_analysis(app_id: str) -> None:
    context = repo.interview_analysis_context(app_id)
    if not context:
        repo.save_interview_analysis_failure(app_id, "面试记录不完整。", screening_config()["model"])
        return
    try:
        report, model = analyze_interview(context)
        repo.save_interview_analysis(app_id, report, model)
    except ScreeningError as exc:
        repo.save_interview_analysis_failure(app_id, str(exc), screening_config()["model"])


async def _screening_worker() -> None:
    last_cleanup = 0.0
    while True:
        if time.time() - last_cleanup > 3600:
            await asyncio.to_thread(repo.cleanup_expired)
            last_cleanup = time.time()
        app_id = await asyncio.to_thread(repo.claim_next_application)
        if app_id:
            try:
                await asyncio.to_thread(_process_one, app_id)
            except Exception:
                # No resume text or upstream response is logged. The HR can review a failed task.
                settings = screening_config()
                await asyncio.to_thread(repo.save_screening_failure, app_id,
                    "初筛任务内部错误。", settings["model"], PROMPT_VERSION, 1)
        else:
            interview_id = await asyncio.to_thread(repo.claim_next_interview_analysis)
            if interview_id:
                await asyncio.to_thread(_process_interview_analysis, interview_id)
            else:
                await asyncio.sleep(0.5)


async def start_worker() -> None:
    global _worker
    repo.init_db()
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_screening_worker())


async def stop_worker() -> None:
    global _worker
    if _worker:
        _worker.cancel()
        try:
            await _worker
        except asyncio.CancelledError:
            pass
        _worker = None


@router.post("/api/auth/register", status_code=201)
def register(body: RegisterBody) -> dict:
    name, email = body.name.strip(), body.email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(422, "邮箱格式无效。")
    if body.role not in ("candidate", "hr"):
        raise HTTPException(422, "账号角色无效。")
    if body.role == "hr":
        code = os.getenv("HR_REGISTRATION_CODE", "")
        if not code or not hmac.compare_digest(body.hrRegistrationCode or "", code) or not (body.companyName or "").strip():
            raise HTTPException(403, "企业账号开通码或企业名称无效。")
    try:
        user = repo.create_user(name, email, body.password, body.role,
                                body.companyName.strip() if body.companyName else None)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "该邮箱已注册。") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"token": repo.issue_token(user["id"]), "user": user}


@router.get("/api/auth/demo-mode")
def get_demo_mode(request: Request) -> dict:
    return {"enabled": demo_enabled(request)}


@router.post("/api/auth/demo/hr")
def enter_demo_hr(request: Request) -> dict:
    if not demo_enabled(request):
        raise HTTPException(404, "本机演示模式未启用。")
    user = repo.demo_hr()
    return {"token": repo.issue_token(user["id"]), "user": user}


@router.post("/api/auth/login")
def login(body: LoginBody, request: Request) -> dict:
    if demo_enabled(request):
        try:
            user = repo.demo_candidate(body.email)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"token": repo.issue_token(user["id"]), "user": user}
    user = repo.authenticate(body.email.strip().lower(), body.password)
    if not user:
        raise HTTPException(401, "邮箱或密码错误。")
    return {"token": repo.issue_token(user["id"]), "user": user}


@router.get("/api/auth/me")
def me(user: dict = Depends(actor)) -> dict:
    return {"user": user}


@router.get("/api/jobs")
def jobs() -> dict:
    return {"items": repo.list_jobs()}


@router.get("/api/hr/jobs")
def hr_jobs(user: dict = Depends(hr)) -> dict:
    return {"items": repo.list_jobs(user["companyId"], include_criteria=True)}


@router.post("/api/hr/jobs", status_code=201)
def create_job(body: JobBody, user: dict = Depends(hr)) -> dict:
    return repo.create_job(user["companyId"], body.title.strip(), body.description.strip())


@router.post("/api/applications", status_code=202)
async def submit_application(resume: UploadFile = File(...), jobId: str = Form(...),
                             consent: bool = Form(...), verifyLinks: bool = Form(False),
                             user: dict = Depends(candidate)) -> dict:
    if not consent:
        raise HTTPException(422, "请确认简历将用于该岗位的招聘评估。")
    job = repo.get_job(jobId)
    if not job:
        raise HTTPException(404, "岗位不存在或未发布。")
    name = (resume.filename or "").replace("\\", "/").split("/")[-1][:180]
    if not name:
        raise HTTPException(422, "请选择简历文件。")
    data = await resume.read(MAX_FILE_BYTES + 1)
    try:
        _, content_type = validate_file(name, data)
    except ResumeError as exc:
        raise HTTPException(422, str(exc)) from exc
    target_dir = repo.data_dir() / "resumes"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / (uuid.uuid4().hex + Path(name).suffix.lower())
    with target.open("xb") as out:
        out.write(data)
    try:
        app_id = repo.create_application(user["id"], jobId, name, content_type,
                                         str(target), hashlib.sha256(data).hexdigest(), verifyLinks)
    except sqlite3.IntegrityError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(409, "你已经投递过这个岗位。") from exc
    row = repo.candidate_application(app_id, user["id"])
    return {"application": _candidate_dto(row)}


@router.post("/api/hr/resumes/import", status_code=202)
async def import_hr_resume(resume: UploadFile = File(...), jobId: str = Form(...),
                           candidateName: str = Form(""), permissionConfirmed: bool = Form(...),
                           user: dict = Depends(hr)) -> dict:
    if not permissionConfirmed:
        raise HTTPException(422, "请确认已获得处理该简历用于当前岗位评估的授权。")
    job = repo.get_job(jobId)
    if not job or job["company_id"] != user["companyId"]:
        raise HTTPException(404, "岗位不存在或不属于当前企业。")
    name = (resume.filename or "").replace("\\", "/").split("/")[-1][:180]
    if not name.lower().endswith(".pdf"):
        raise HTTPException(422, "企业导入仅支持 PDF 简历。")
    data = await resume.read(MAX_FILE_BYTES + 1)
    try:
        _, content_type = validate_file(name, data)
    except ResumeError as exc:
        raise HTTPException(422, str(exc)) from exc
    target_dir = repo.data_dir() / "resumes"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / (uuid.uuid4().hex + ".pdf")
    with target.open("xb") as out:
        out.write(data)
    display_name = candidateName.strip()[:100] or Path(name).stem[:100] or "待识别候选人"
    try:
        app_id = repo.create_hr_import(user["companyId"], user["id"], jobId,
                                       display_name, name, content_type, str(target),
                                       hashlib.sha256(data).hexdigest())
    except ValueError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(404, str(exc)) from exc
    except Exception:
        target.unlink(missing_ok=True)
        raise
    row = repo.hr_application(app_id, user["companyId"])
    return {"application": _hr_dto(row)}


@router.get("/api/applications/my")
def my_applications(user: dict = Depends(candidate)) -> dict:
    return {"items": [_candidate_dto(row) for row in repo.candidate_applications(user["id"])]}


@router.get("/api/applications/{app_id}")
def my_application(app_id: str, user: dict = Depends(candidate)) -> dict:
    row = repo.candidate_application(app_id, user["id"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    return _candidate_dto(row)


@router.delete("/api/applications/{app_id}")
def delete_my_application(app_id: str, user: dict = Depends(candidate)) -> dict:
    row = repo.candidate_application(app_id, user["id"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    repo.delete_application(app_id)
    return {"deleted": True}


@router.post("/api/applications/{app_id}/corrections", status_code=201)
def submit_correction(app_id: str, body: CorrectionBody,
                      user: dict = Depends(candidate)) -> dict:
    if not repo.candidate_application(app_id, user["id"]):
        raise HTTPException(404, "申请不存在。")
    if len(body.message.strip()) < 10:
        raise HTTPException(422, "更正说明至少需要 10 个有效字符。")
    try:
        item = repo.add_correction(app_id, body.message.strip())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"id": item["id"], "createdAt": item["createdAt"]}


@router.get("/api/hr/applications")
def list_hr_applications(jobId: str | None = None, status: str | None = None,
                         stage: str | None = Query(None, pattern="^(applied|ai_interview|human_interview|ended)$"),
                         manualReview: bool = False, since: float | None = Query(None, ge=0),
                         user: dict = Depends(hr)) -> dict:
    items = [_hr_dto(row) for row in repo.hr_applications(
        user["companyId"], job_id=jobId, status=status,
        manual_review=manualReview, since=since)]
    if stage:
        items = [item for item in items if item["stage"] == stage]
    return {"counts": repo.resume_source_counts(user["companyId"]), "items": items}


@router.get("/api/hr/applications/{app_id}")
def get_hr_application(app_id: str, user: dict = Depends(hr)) -> dict:
    row = repo.hr_application(app_id, user["companyId"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    return _hr_dto(row, detail=True)


@router.get("/api/hr/applications/{app_id}/resume")
def download_resume(app_id: str, user: dict = Depends(hr)) -> FileResponse:
    row = repo.hr_application(app_id, user["companyId"])
    if not row or not Path(row["file_path"]).is_file():
        raise HTTPException(404, "简历不存在。")
    return FileResponse(row["file_path"], media_type=row["content_type"] if "content_type" in row else "application/octet-stream",
                        filename=row["original_name"], headers={"Cache-Control": "no-store"})


@router.post("/api/hr/applications/{app_id}/screening/retry", status_code=202)
def retry_screening(app_id: str, user: dict = Depends(hr)) -> dict:
    row = repo.hr_application(app_id, user["companyId"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    if not repo.requeue_screening(app_id):
        raise HTTPException(409, "当前初筛状态不需要重试。")
    return {"screeningStatus": "queued"}


@router.post("/api/hr/applications/{app_id}/interview-analysis/retry", status_code=202)
def retry_interview_analysis(app_id: str, user: dict = Depends(hr)) -> dict:
    row = repo.hr_application(app_id, user["companyId"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    if not repo.requeue_interview_analysis(app_id):
        raise HTTPException(409, "当前面试分析状态不需要重试。")
    return {"analysisStatus": "queued"}


def _hr_row(app_id: str, user: dict) -> dict:
    row = repo.hr_application(app_id, user["companyId"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    return row


@router.put("/api/hr/jobs/{job_id}/criteria")
def save_job_criteria(job_id: str, body: CriteriaBody, user: dict = Depends(hr)) -> dict:
    saved = repo.save_job_criteria(job_id, user["companyId"], body.criteria.strip())
    if not saved:
        raise HTTPException(404, "岗位不存在。")
    return saved


@router.get("/api/hr/invitations")
def list_invitations(kind: str | None = Query(None, pattern="^(ai|human)$"),
                     state: str | None = Query(None, pattern="^(pending|accepted|expired|completed|cancelled)$"),
                     user: dict = Depends(hr)) -> dict:
    """邀请记录：AI 初面 + 真人面试，状态读取时计算（过期不依赖定时任务）。"""
    items = repo.list_invitations(user["companyId"])
    for item in items:
        item["state"] = (pipeline.invitation_state(item["status"], item["expiresAt"],
                                                   item["acceptedAt"])
                         if item["kind"] == "ai" else
                         pipeline.human_state(item["status"], item["result"],
                                              item["expiresAt"], item["acceptedAt"]))
        item["stateLabel"] = pipeline.state_label(item["state"])
        item["resendable"] = item["state"] in (pipeline.PENDING, pipeline.EXPIRED)
    counts = {"total": len(items)}
    for key in ("pending", "accepted", "expired", "completed", "cancelled"):
        counts[key] = sum(1 for item in items if item["state"] == key)
    if kind:
        items = [item for item in items if item["kind"] == kind]
    if state:
        items = [item for item in items if item["state"] == state]
    return {"items": items, "counts": counts}


@router.post("/api/hr/applications/{app_id}/human-interview", status_code=201)
def schedule_human_interview(app_id: str, body: HumanInterviewBody,
                             user: dict = Depends(hr)) -> dict:
    row = _hr_row(app_id, user)
    if row["status"] == "closed":
        raise HTTPException(409, "申请已结束，不能再安排真人面试。")
    if row["source"] == "hr_import":
        raise HTTPException(409, "企业导入简历尚未关联候选人账号，不能安排真人面试。")
    if row["status"] == "ai_interview_in_progress":
        raise HTTPException(409, "AI 初面进行中，请完成后再安排真人面试。")
    now = time.time()
    if body.scheduledAt < now - 3600:
        raise HTTPException(422, "面试时间不能早于当前时间。")
    if body.scheduledAt > now + 365 * 86400:
        raise HTTPException(422, "面试时间超出可安排范围。")
    location = (body.location or "").strip() or None
    if body.mode != "video" and not location:
        raise HTTPException(422, "线下或电话面试请填写地点或联系方式。")
    room_code = _ensure_room(row).code if body.mode == "video" else None
    repo.upsert_human_interview(app_id, scheduled_at=body.scheduledAt,
                                duration_minutes=body.durationMinutes,
                                interviewer_name=body.interviewerName.strip(),
                                mode=body.mode, location=location, room_code=room_code)
    repo.set_application_status(app_id, "hr_interview_invited")
    return get_hr_application(app_id, user)


@router.patch("/api/hr/applications/{app_id}/human-interview")
def update_human_interview(app_id: str, body: HumanInterviewUpdateBody,
                           user: dict = Depends(hr)) -> dict:
    row = _hr_row(app_id, user)
    if not row["human_id"]:
        raise HTTPException(404, "尚未安排真人面试。")
    if row["human_status"] == "completed":
        if body.result is None and body.resultSent is None:
            raise HTTPException(409, "本次真人面试已出结论。")
        if body.result is None:
            if not repo.set_human_result_sent(app_id, bool(body.resultSent)):
                raise HTTPException(409, "本次真人面试还没有结论。")
            return get_hr_application(app_id, user)
    if body.result is not None:
        notes = body.notes if body.notes is not None else (row["human_notes"] or "")
        repo.set_human_interview_result(app_id, body.result, notes.strip(),
                                        bool(body.resultSent))
        repo.set_application_status(app_id, "closed")
        return get_hr_application(app_id, user)
    if body.resultSent is not None:
        raise HTTPException(409, "请先提交面试结论，再设置是否发送给候选人。")
    if body.scheduledAt is not None and body.scheduledAt < time.time() - 3600:
        raise HTTPException(422, "面试时间不能早于当前时间。")
    mode = body.mode or row["human_mode"]
    location = (body.location.strip() if body.location else None) or row["human_location"]
    if mode != "video" and not location:
        raise HTTPException(422, "线下或电话面试请填写地点或联系方式。")
    fields = {"scheduled_at": body.scheduledAt,
              "duration_minutes": body.durationMinutes,
              "interviewer_name": body.interviewerName.strip() if body.interviewerName else None,
              "mode": body.mode, "location": location}
    if body.scheduledAt is not None:
        fields["expires_at"] = repo.human_expiry(body.scheduledAt)
    repo.update_human_interview(app_id, **fields)
    if row["status"] != "closed":
        repo.set_application_status(app_id, "hr_interview_invited")
    return get_hr_application(app_id, user)


@router.post("/api/hr/applications/{app_id}/human-interview/resend")
def resend_human_interview(app_id: str, body: ResendBody | None = None,
                           user: dict = Depends(hr)) -> dict:
    _hr_row(app_id, user)
    if not repo.resend_human_interview(app_id, body.days if body else None):
        raise HTTPException(409, "没有可重发的真人面试邀请。")
    return get_hr_application(app_id, user)


@router.post("/api/hr/applications/{app_id}/invitation/resend")
def resend_ai_invitation(app_id: str, body: ResendBody | None = None,
                         user: dict = Depends(hr)) -> dict:
    row = _hr_row(app_id, user)
    if not row["invitation_id"]:
        raise HTTPException(409, "尚未发送 AI 初面邀请。")
    state = pipeline.invitation_state(row["invitation_status"], row["invitation_expires_at"],
                                      row["invitation_accepted_at"])
    if state == pipeline.ACCEPTED:
        raise HTTPException(409, "候选人已进入 AI 初面，不能重发邀请。")
    if not repo.resend_invitation(app_id, body.days if body else None):
        raise HTTPException(409, "本次 AI 初面已完成，不能重发邀请。")
    return get_hr_application(app_id, user)


@router.post("/api/hr/applications/{app_id}/ai-result/send")
def send_ai_result(app_id: str, body: ResultSendBody, user: dict = Depends(hr)) -> dict:
    row = _hr_row(app_id, user)
    if not row["invitation_id"]:
        raise HTTPException(409, "尚未发送 AI 初面邀请。")
    if body.visible and row["status"] != "ai_interview_completed":
        raise HTTPException(409, "AI 初面尚未完成，不能发送结果。")
    if not repo.set_ai_result_sent(app_id, body.visible):
        raise HTTPException(404, "邀请记录不存在。")
    return get_hr_application(app_id, user)


@router.get("/api/hr/applications/{app_id}/interview-room")
def get_interview_room(app_id: str, user: dict = Depends(hr)) -> dict:
    """真人面试间的归档摘要（双确认、追问点）。面试间数据只在内存，这里读归档。"""
    _hr_row(app_id, user)
    archived = repo.interview_report(app_id)
    if not archived:
        raise HTTPException(404, "还没有可回看的面试间记录。")
    return archived


def _ensure_room(row: dict):
    with _room_guard:
        room = STORE.create_linked_room(row["job_title"],
            (json.loads(row["report_json"]).get("interviewQuestions") or default_questions())
            if row["report_json"] else default_questions(), row["id"])
        repo.set_invitation_room(row["id"], room.code)
    return room


@router.post("/api/hr/applications/{app_id}/review")
def review_application(app_id: str, body: ReviewBody, user: dict = Depends(hr)) -> dict:
    row = repo.hr_application(app_id, user["companyId"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    if body.decision not in ("invite", "verify", "hold"):
        raise HTTPException(422, "审核决定无效。")
    if row["status"] == "closed":
        raise HTTPException(409, "申请已结束，不能再修改审核决定。")
    if row["status"] in ("ai_interview_in_progress", "ai_interview_completed",
                         "hr_interview_invited") and body.decision != "invite":
        raise HTTPException(409, "面试已开始或已安排，不能改为暂缓。")
    if body.decision == "invite":
        if row["source"] == "hr_import":
            raise HTTPException(409, "企业导入简历尚未关联候选人账号，不能发送线上初面邀请。")
        repo.ensure_invitation(app_id)
        _ensure_room(row)
        status = (row["status"] if row["status"] in (
            "ai_interview_in_progress", "ai_interview_completed", "hr_interview_invited")
            else "ai_interview_invited")
    else:
        if row["invitation_id"]:
            raise HTTPException(409, "邀请已发出，不能撤销为暂缓。")
        status = "hr_review"
    repo.upsert_review(app_id, user["id"], body.decision, body.notes.strip(), status)
    return get_hr_application(app_id, user)


@router.post("/api/applications/{app_id}/interview/start")
def start_invited_interview(app_id: str, user: dict = Depends(candidate)) -> dict:
    row = repo.candidate_application(app_id, user["id"])
    if not row or not row["invitation_id"]:
        raise HTTPException(404, "面试邀请不存在。")
    if row["invitation_status"] == "completed" or row["status"] == "ai_interview_completed":
        raise HTTPException(409, "这次 AI 初面已经完成。")
    # Load internal question context only after the candidate ownership check.
    internal_row = repo.get_application_by_id(app_id)
    room = _ensure_room(internal_row)
    return {"code": room.code, "ticket": room.candidate_ticket,
            "status": row["invitation_status"],
            "interviewPath": "/personal/?room=" + room.code + "&ticket=" + room.candidate_ticket}


@router.post("/api/applications/{app_id}/human-interview/enter")
def enter_human_interview(app_id: str, user: dict = Depends(candidate)) -> dict:
    """候选人进入真人面试房间。房间与 AI 初面邀请共用同一间（按申请幂等）。"""
    row = repo.candidate_application(app_id, user["id"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    if not row.get("human_status"):
        raise HTTPException(409, "企业还没有安排真人面试。")
    state = pipeline.human_state(row["human_status"], row["human_result"],
                                 row["human_expires_at"], row["human_accepted_at"])
    if state not in (pipeline.PENDING, pipeline.ACCEPTED):
        raise HTTPException(409, "本次真人面试已结束或已过期。")
    if row["human_mode"] != "video":
        return {"mode": row["human_mode"], "location": row["human_location"],
                "roomCode": None, "interviewPath": None}
    internal_row = repo.get_application_by_id(app_id)
    room = _ensure_room(internal_row)
    repo.mark_human_interview_accepted(app_id)
    return {"mode": "video", "code": room.code, "ticket": room.candidate_ticket,
            "roomCode": room.code, "location": row["human_location"],
            "interviewPath": "/personal/?room=" + room.code + "&ticket=" + room.candidate_ticket}
