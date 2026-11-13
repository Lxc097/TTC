"""Candidate-only bridge to the existing autonomous DeepSeek voice interview.

The Node interview service is bound to loopback. Its question plan and follow-ups
are requested through these routes so a browser cannot supply a different job,
resume, application, or session for a formal attempt.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import recruitment_store as repo
from recruitment_api import candidate

router = APIRouter()
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class SessionStart(BaseModel):
    applicationId: str
    attemptId: str


class AnswerEvent(BaseModel):
    attemptId: str
    questionId: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=500)
    answer: str = Field(min_length=1, max_length=5000)


class FinishEvent(BaseModel):
    attemptId: str


class FollowUpEvent(BaseModel):
    applicationId: str
    attemptId: str
    sessionId: str
    questionId: str
    answer: str = Field(min_length=1, max_length=5000)
    followUpCount: int = Field(ge=0, le=5)
    previousPrompt: str | None = None


class SummaryEvent(BaseModel):
    applicationId: str
    attemptId: str
    sessionId: str
    questionId: str
    answer: str = Field(min_length=1, max_length=5000)


def _lock_for(app_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(app_id, threading.Lock())


def _owned_application(app_id: str, user: dict) -> dict:
    # This query never joins screenings, evidence, or HR review notes.
    row = repo.candidate_interview_context(app_id, user["id"])
    if not row:
        raise HTTPException(404, "申请不存在。")
    return row


def _attempt(app_id: str, attempt_id: str, user: dict) -> dict:
    _owned_application(app_id, user)
    with repo.db() as connection:
        row = connection.execute(
            "SELECT * FROM formal_interviews WHERE application_id=? AND attempt_id=?",
            (app_id, attempt_id)).fetchone()
    if not row:
        raise HTTPException(404, "初面记录不存在。")
    return dict(row)


def _config(row: dict) -> dict:
    title = row["job_title"].strip()[:120]
    jd = row["job_description"].strip()[:12_000]
    combined = (title + " " + jd[:1000]).lower()
    role = ("frontend" if any(word in combined for word in ("前端", "react", "vue", "frontend"))
            else "backend" if any(word in combined for word in ("后端", "java", "python", "backend", "api"))
            else "product" if any(word in combined for word in ("产品经理", "product manager"))
            else "marketing" if any(word in combined for word in ("运营", "市场", "marketing"))
            else "general")
    return {"role": role, "type": "technical" if role in ("frontend", "backend") else "general",
            "difficulty": "standard", "durationMinutes": 15,
            "targetRole": title,
            "targetRoleDescription": (title + "。岗位要求：" + jd)[:300],
            # Candidate owns this resume; the internal screening report is never loaded.
            "resumeText": (row["raw_text"] or "")[:8000]}


def _sidecar(method: str, path: str, payload: dict | None = None) -> dict:
    base = os.getenv("INTERVIEW_SIDECAR_URL", "http://127.0.0.1:8787").rstrip("/")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = Request(base + path, data=body, method=method,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=45) as response:
            raw = response.read(200_000)
    except HTTPError as exc:
        # The sidecar may include resume-derived text in error bodies. Never relay it.
        raise HTTPException(503 if exc.code >= 500 else 502, "AI 初面服务暂不可用。") from None
    except (URLError, TimeoutError, OSError):
        raise HTTPException(503, "AI 初面服务暂不可用。") from None
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(502, "AI 初面服务返回无效数据。") from None
    if not isinstance(value, dict):
        raise HTTPException(502, "AI 初面服务返回无效数据。")
    return value


def _valid_questions(value: object) -> list[dict]:
    if not isinstance(value, list) or not (1 <= len(value) <= 12):
        raise HTTPException(502, "AI 初面题目无效。")
    ids: set[str] = set()
    rows = []
    for item in value:
        if not isinstance(item, dict):
            raise HTTPException(502, "AI 初面题目无效。")
        qid, prompt = item.get("id"), item.get("prompt")
        if not isinstance(qid, str) or not isinstance(prompt, str) or not qid or qid in ids or not (8 <= len(prompt) <= 500):
            raise HTTPException(502, "AI 初面题目无效。")
        ids.add(qid)
        rows.append(item)
    return rows


@router.post("/api/applications/{app_id}/ai-interview/start")
def prepare_formal_interview(app_id: str, user: dict = Depends(candidate)) -> dict:
    row = _owned_application(app_id, user)
    if not row["invitation_id"] or row["status"] not in ("ai_interview_invited", "ai_interview_in_progress"):
        raise HTTPException(409, "尚未获得可用的 AI 初面邀请。")
    with _lock_for(app_id):
        with repo.db() as connection:
            existing = connection.execute("SELECT * FROM formal_interviews WHERE application_id=?",
                                          (app_id,)).fetchone()
            if existing and existing["status"] == "completed":
                raise HTTPException(409, "本次 AI 初面已经完成。")
            if not existing:
                attempt_id = uuid.uuid4().hex
                config = _config(row)
                connection.execute("""INSERT INTO formal_interviews
                  (application_id,attempt_id,status,config_json,questions_json,started_at)
                  VALUES (?,?,?,?,?,?)""", (app_id, attempt_id, "prepared",
                  json.dumps(config, ensure_ascii=False), "[]", time.time()))
            else:
                attempt_id = existing["attempt_id"]
                config = json.loads(existing["config_json"])
    return {"attemptId": attempt_id, "config": config,
            "status": "prepared" if not existing else existing["status"]}


@router.post("/api/interview/sessions")
def start_formal_session(body: SessionStart, user: dict = Depends(candidate)) -> dict:
    app_id = body.applicationId
    with _lock_for(app_id):
        attempt = _attempt(app_id, body.attemptId, user)
        if attempt["status"] == "completed":
            raise HTTPException(409, "本次 AI 初面已经完成。")
        if attempt["session_id"]:
            try:
                resumed = _sidecar("GET", "/api/interview/sessions/" + attempt["session_id"])
                questions = _valid_questions(resumed.get("questions"))
                if resumed.get("mode") == "siliconflow":
                    return {"id": attempt["session_id"], "mode": "siliconflow",
                            "questions": questions}
            except HTTPException:
                pass  # Sidecar restarted; create a fresh question plan for this incomplete attempt.
        config = json.loads(attempt["config_json"])
        upstream = _sidecar("POST", "/api/interview/sessions", {"config": config})
        if upstream.get("mode") != "siliconflow" or not isinstance(upstream.get("id"), str):
            raise HTTPException(503, "真实 AI 出题暂不可用，请稍后再进入初面。")
        questions = _valid_questions(upstream.get("questions"))
        with repo.db() as connection:
            connection.execute("DELETE FROM formal_answers WHERE attempt_id=?", (body.attemptId,))
            connection.execute("""UPDATE formal_interviews SET status='in_progress',
              session_id=?, questions_json=? WHERE application_id=? AND attempt_id=?""",
              (upstream["id"], json.dumps(questions, ensure_ascii=False), app_id, body.attemptId))
        repo.mark_interview_in_progress(app_id)
        return {"id": upstream["id"], "mode": "siliconflow", "questions": questions}


def _active_session(app_id: str, attempt_id: str, session_id: str, user: dict) -> dict:
    attempt = _attempt(app_id, attempt_id, user)
    if attempt["status"] != "in_progress" or attempt["session_id"] != session_id:
        raise HTTPException(409, "AI 初面会话已失效，请重新进入邀请。")
    return attempt


@router.post("/api/interview/follow-ups")
def formal_follow_up(body: FollowUpEvent, user: dict = Depends(candidate)) -> dict:
    attempt = _active_session(body.applicationId, body.attemptId, body.sessionId, user)
    questions = _valid_questions(json.loads(attempt["questions_json"]))
    if body.questionId not in {item["id"] for item in questions}:
        raise HTTPException(422, "题目不属于本次初面。")
    return _sidecar("POST", "/api/interview/follow-ups", {
        "sessionId": body.sessionId, "questionId": body.questionId,
        "answer": body.answer, "followUpCount": body.followUpCount,
        "previousPrompt": (body.previousPrompt or "")[:300]})


@router.post("/api/interview/answer-summary")
def formal_answer_summary(body: SummaryEvent, user: dict = Depends(candidate)) -> dict:
    attempt = _active_session(body.applicationId, body.attemptId, body.sessionId, user)
    questions = _valid_questions(json.loads(attempt["questions_json"]))
    if body.questionId not in {item["id"] for item in questions}:
        raise HTTPException(422, "题目不属于本次初面。")
    return _sidecar("POST", "/api/interview/answer-summary", {
        "sessionId": body.sessionId, "questionId": body.questionId, "answer": body.answer})


@router.post("/api/applications/{app_id}/ai-interview/answers")
def save_formal_answer(app_id: str, body: AnswerEvent,
                       user: dict = Depends(candidate)) -> dict:
    with _lock_for(app_id):
        attempt = _attempt(app_id, body.attemptId, user)
        if attempt["status"] != "in_progress":
            raise HTTPException(409, "AI 初面尚未开始或已完成。")
        questions = _valid_questions(json.loads(attempt["questions_json"]))
        expected = {item["id"]: item["prompt"] for item in questions}
        if body.questionId not in expected or body.prompt != expected[body.questionId]:
            raise HTTPException(422, "题目不属于本次初面。")
        answer = body.answer.strip()
        if len(answer) < 4:
            raise HTTPException(422, "请先提交有效回答。")
        with repo.db() as connection:
            connection.execute("""INSERT INTO formal_answers
              (attempt_id,question_id,prompt,answer,created_at) VALUES (?,?,?,?,?)
              ON CONFLICT(attempt_id,question_id) DO UPDATE SET
              answer=excluded.answer,created_at=excluded.created_at""",
              (body.attemptId, body.questionId, body.prompt, answer, time.time()))
    return {"saved": True}


@router.post("/api/applications/{app_id}/ai-interview/complete")
def complete_formal_interview(app_id: str, body: FinishEvent,
                              user: dict = Depends(candidate)) -> dict:
    with _lock_for(app_id):
        attempt = _attempt(app_id, body.attemptId, user)
        if attempt["status"] == "completed":
            repo.mark_interview_completed(app_id)
            return {"status": "completed", "attemptId": body.attemptId}
        if attempt["status"] != "in_progress" or not attempt["session_id"]:
            raise HTTPException(409, "AI 初面尚未开始。")
        questions = _valid_questions(json.loads(attempt["questions_json"]))
        with repo.db() as connection:
            answered = {row["question_id"] for row in connection.execute(
                "SELECT question_id FROM formal_answers WHERE attempt_id=? AND length(trim(answer))>=4",
                (body.attemptId,)).fetchall()}
            missing = [item["id"] for item in questions if item["id"] not in answered]
            if missing:
                raise HTTPException(409, "还有题目未完成，请完成全部题目后再提交。")
            connection.execute("""UPDATE formal_interviews SET status='completed',completed_at=?,
              analysis_status='queued',analysis_error=NULL
              WHERE application_id=? AND attempt_id=? AND status='in_progress'""",
              (time.time(), app_id, body.attemptId))
        repo.mark_interview_completed(app_id)
    return {"status": "completed", "attemptId": body.attemptId}
