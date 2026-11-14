"""Versioned percentage-screening snapshots and reversible HR card decisions.

All decisions are scoped to the owning company and committed in one SQLite
transaction. Existing application, resume, screening and assessment rows are
never deleted or rewritten by a screening batch.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import threading
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import recruitment_store as repo
from . import recruitment_architect_store as architect
from . import recruitment_assessment as assessment
from shared import config as recruitment_config
from .recruitment_resume import valid_candidate_name
from .recruitment_api import hr

router = APIRouter()
_schema_lock = threading.Lock()
_schema_path: str | None = None
_workers: list[asyncio.Task] = []


class BatchCreate(BaseModel):
    jobId: str = Field(min_length=1, max_length=80)
    retentionPercent: float = Field(gt=0, le=100, allow_inf_nan=False)


class CardDecision(BaseModel):
    applicationId: str = Field(min_length=1, max_length=80)
    decision: Literal["keep", "talent", "defer"]


def init_db() -> None:
    """Add only new tables to the existing recruitment SQLite database."""
    global _schema_path
    path = str(repo.data_dir() / "recruitment.sqlite3")
    if path == _schema_path:
        return
    with _schema_lock:
        if path == _schema_path:
            return
        architect.init_db()
        assessment.init_db()
        with repo.db() as db:
            db.executescript("""
        CREATE TABLE IF NOT EXISTS screening_batches (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
          job_id TEXT NOT NULL REFERENCES jobs(id),
          profile_version_id TEXT NOT NULL REFERENCES hiring_profile_versions(id),
          profile_version INTEGER NOT NULL, retention_percent REAL NOT NULL,
          total_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL,
          selected_count INTEGER NOT NULL, pending_count INTEGER NOT NULL,
          boundary_tie INTEGER NOT NULL DEFAULT 0, boundary_score REAL,
          status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL REFERENCES users(id),
          created_at REAL NOT NULL, updated_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS screening_batches_job_idx
          ON screening_batches(company_id,job_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS screening_batch_candidates (
          batch_id TEXT NOT NULL REFERENCES screening_batches(id) ON DELETE CASCADE,
          application_id TEXT NOT NULL REFERENCES applications(id),
          candidate_id TEXT NOT NULL REFERENCES users(id),
          candidate_name TEXT NOT NULL, assessment_id TEXT,
          score REAL, rank INTEGER, selected INTEGER NOT NULL,
          selection_status TEXT NOT NULL, score_details_json TEXT,
          review_decision TEXT, reviewed_at REAL,
          PRIMARY KEY(batch_id,application_id));
        CREATE INDEX IF NOT EXISTS screening_batch_selected_idx
          ON screening_batch_candidates(batch_id,selected,rank);
        CREATE TABLE IF NOT EXISTS screening_batch_actions (
          id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES screening_batches(id) ON DELETE CASCADE,
          application_id TEXT NOT NULL REFERENCES applications(id),
          actor_id TEXT NOT NULL REFERENCES users(id),
          decision TEXT NOT NULL, previous_decision TEXT,
          previous_talent_json TEXT, created_at REAL NOT NULL, undone_at REAL);
        CREATE INDEX IF NOT EXISTS screening_batch_actions_idx
          ON screening_batch_actions(batch_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS assessment_jobs (
          application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          profile_version_id TEXT NOT NULL REFERENCES hiring_profile_versions(id),
          company_id TEXT NOT NULL REFERENCES companies(id),
          status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT, updated_at REAL NOT NULL,
          PRIMARY KEY(application_id,job_id,profile_version_id));
        CREATE INDEX IF NOT EXISTS assessment_jobs_queue_idx
          ON assessment_jobs(status,updated_at);
            """)
        _schema_path = path


def _profile(job_id: str, company_id: str) -> dict:
    profile = architect.latest_profile(job_id, company_id)
    if not profile:
        raise HTTPException(409, "该岗位尚无 HR 确认的招聘标准。")
    weights = profile["profile"].get("capabilityWeights") or {}
    if not isinstance(weights, dict) or not weights or sum(weights.values()) != 100:
        raise HTTPException(409, "请先在招聘需求顾问中确认合计 100% 的评分维度权重。")
    return profile


def _pool(job_id: str, company_id: str, profile_version_id: str) -> tuple[list[dict], list[dict]]:
    """Return stable ranked and pending groups without assigning fake low scores."""
    with repo.db() as db:
        rows = db.execute("""SELECT a.id AS application_id,a.candidate_id,a.created_at,
            COALESCE((SELECT corrected_name FROM candidate_name_corrections nc
              WHERE nc.application_id=a.id ORDER BY nc.created_at DESC,nc.id DESC LIMIT 1),
              u.name) AS candidate_name,ca.id AS assessment_id,ca.status AS assessment_status,
            ca.report_json AS assessment_report,
            CASE WHEN r.raw_text IS NOT NULL AND length(trim(r.raw_text))>0 THEN 1 ELSE 0 END AS assessable
          FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN users u ON u.id=a.candidate_id
          LEFT JOIN resumes r ON r.application_id=a.id
          LEFT JOIN candidate_assessments ca ON ca.application_id=a.id
            AND ca.job_id=a.job_id AND ca.profile_version_id=?
          WHERE a.job_id=? AND j.company_id=? ORDER BY a.created_at,a.id""",
                          (profile_version_id, job_id, company_id)).fetchall()
    ranked, pending = [], []
    for row in rows:
        report = json.loads(row["assessment_report"]) if row["assessment_report"] else {}
        score = report.get("weightedScore")
        item = {"applicationId": row["application_id"], "candidateId": row["candidate_id"],
                "candidateName": valid_candidate_name(row["candidate_name"]) or "姓名待确认",
                "createdAt": row["created_at"],
                "assessable": bool(row["assessable"]),
                "assessmentId": row["assessment_id"],
                "score": score if isinstance(score, (int, float)) and not isinstance(score, bool)
                         and 0 <= score <= 100 and row["assessment_status"] == "completed"
                         and report.get("scoringStatus") == "complete" else None,
                "scoreDetails": {"dimensionScores": report.get("dimensionScores") or [],
                                 "scoreBasis": report.get("scoreBasis") or "",
                                 "limitations": report.get("limitations") or []}}
        (ranked if item["score"] is not None else pending).append(item)
    ranked.sort(key=lambda item: (-item["score"], item["createdAt"], item["applicationId"]))
    for index, item in enumerate(ranked, 1):
        item["rank"] = index
    return ranked, pending


def enqueue_assessments(job_id: str, company_id: str) -> dict:
    """Schedule only missing/incomplete scores for the current confirmed version."""
    init_db()
    job = repo.get_job(job_id)
    if not job or job["company_id"] != company_id:
        raise HTTPException(404, "岗位不存在。")
    profile = _profile(job_id, company_id)
    _, pending = _pool(job_id, company_id, profile["id"])
    now, queued = time.time(), 0
    with repo.db() as db:
        db.execute("BEGIN IMMEDIATE")
        for item in pending:
            if not item["assessable"]:
                continue
            old = db.execute("""SELECT status FROM assessment_jobs
              WHERE application_id=? AND job_id=? AND profile_version_id=?""",
              (item["applicationId"], job_id, profile["id"])).fetchone()
            if old and old["status"] in ("queued", "processing"):
                continue
            db.execute("""INSERT INTO assessment_jobs
              (application_id,job_id,profile_version_id,company_id,status,updated_at)
              VALUES(?,?,?,?,'queued',?) ON CONFLICT(application_id,job_id,profile_version_id)
              DO UPDATE SET status='queued',error=NULL,updated_at=excluded.updated_at""",
              (item["applicationId"], job_id, profile["id"], company_id, now))
            queued += 1
    return {"jobId": job_id, "profileVersionId": profile["id"],
            "queued": queued, "pendingCount": len(pending),
            "assessablePendingCount": sum(item["assessable"] for item in pending),
            "unavailableCount": sum(not item["assessable"] for item in pending)}


def assessment_queue(job_id: str, company_id: str) -> dict:
    init_db()
    job = repo.get_job(job_id)
    if not job or job["company_id"] != company_id:
        raise HTTPException(404, "岗位不存在。")
    profile = _profile(job_id, company_id)
    _, pending = _pool(job_id, company_id, profile["id"])
    with repo.db() as db:
        rows = db.execute("""SELECT status,COUNT(*) AS count FROM assessment_jobs
          WHERE job_id=? AND company_id=? AND profile_version_id=? GROUP BY status""",
          (job_id, company_id, profile["id"])).fetchall()
    counts = {row["status"]: row["count"] for row in rows}
    return {"jobId": job_id, "profileVersionId": profile["id"],
            "pendingCount": len(pending),
            "assessablePendingCount": sum(item["assessable"] for item in pending),
            "unavailableCount": sum(not item["assessable"] for item in pending),
            "queued": counts.get("queued", 0),
            "processing": counts.get("processing", 0),
            "completed": counts.get("completed", 0), "failed": counts.get("failed", 0)}


def _claim_assessment() -> dict | None:
    init_db()
    with repo.db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("""SELECT * FROM assessment_jobs WHERE status='queued'
          AND updated_at<=? ORDER BY updated_at,application_id LIMIT 1""",
          (time.time(),)).fetchone()
        if not row:
            return None
        db.execute("""UPDATE assessment_jobs SET status='processing',attempts=attempts+1,
          updated_at=? WHERE application_id=? AND job_id=? AND profile_version_id=?""",
          (time.time(), row["application_id"], row["job_id"], row["profile_version_id"]))
        return dict(row)


def _process_assessment(item: dict) -> None:
    with repo.db() as db:
        version = db.execute("""SELECT * FROM hiring_profile_versions
          WHERE id=? AND job_id=?""", (item["profile_version_id"], item["job_id"])).fetchone()
    if not version:
        return
    snapshot = {"id": version["id"], "jobId": version["job_id"],
                "version": version["version"], "profile": json.loads(version["profile_json"])}
    try:
        assessment.assess_application(item["application_id"], item["job_id"],
                                      item["company_id"], profile_snapshot=snapshot)
        status, error, delay = "completed", None, 0
    except Exception as exc:
        from .recruitment_providers import ProviderError
        retry = isinstance(exc, ProviderError) and exc.retryable and item["attempts"] < 1
        status, error, delay = ("queued" if retry else "failed"), str(exc)[:180], (2 if retry else 0)
    with repo.db() as db:
        db.execute("""UPDATE assessment_jobs SET status=?,error=?,updated_at=?
          WHERE application_id=? AND job_id=? AND profile_version_id=?""",
          (status, error, time.time() + delay, item["application_id"], item["job_id"],
           item["profile_version_id"]))


async def _assessment_worker() -> None:
    while True:
        item = await asyncio.to_thread(_claim_assessment)
        if item:
            running = asyncio.create_task(asyncio.to_thread(_process_assessment, item))
            try:
                await asyncio.shield(running)
            except asyncio.CancelledError:
                await asyncio.gather(running, return_exceptions=True)
                raise
        else:
            await asyncio.sleep(0.7)


async def start_worker() -> None:
    init_db()
    _workers[:] = [worker for worker in _workers if not worker.done()]
    if not _workers:
        with repo.db() as db:
            db.execute("UPDATE assessment_jobs SET status='queued',updated_at=? WHERE status='processing'",
                       (time.time(),))
    for _ in range(recruitment_config.AI_MAX_CONCURRENCY - len(_workers)):
        _workers.append(asyncio.create_task(_assessment_worker()))


async def stop_worker() -> None:
    for worker in _workers:
        worker.cancel()
    if _workers:
        await asyncio.gather(*_workers, return_exceptions=True)
    _workers.clear()


def preview(job_id: str, retention_percent: float, company_id: str) -> dict:
    if not math.isfinite(retention_percent) or not 0 < retention_percent <= 100:
        raise HTTPException(422, "保留比例必须大于 0 且不超过 100%。")
    profile = _profile(job_id, company_id)
    ranked, pending = _pool(job_id, company_id, profile["id"])
    selected = math.ceil(len(ranked) * retention_percent / 100)
    boundary_tie = (0 < selected < len(ranked)
                    and ranked[selected - 1]["score"] == ranked[selected]["score"])
    return {"jobId": job_id, "profileVersion": profile["version"],
            "profileVersionId": profile["id"], "retentionPercent": retention_percent,
            "totalCount": len(ranked) + len(pending), "eligibleCount": len(ranked),
            "selectedCount": selected, "notSelectedCount": len(ranked) - selected,
            "pendingCount": len(pending),
            "assessablePendingCount": sum(item["assessable"] for item in pending),
            "unavailableCount": sum(not item["assessable"] for item in pending),
            "boundaryTie": boundary_tie,
            "boundaryScore": ranked[selected - 1]["score"] if boundary_tie else None,
            "scoringWeights": profile["profile"].get("capabilityWeights") or {},
            "note": "比例仅作用于已有同版本完整多维评分的候选人；缺分者待补充评估，不视为低分。"}


def _batch(db, batch_id: str, company_id: str):
    return db.execute("""SELECT b.*,j.title AS job_title FROM screening_batches b
      JOIN jobs j ON j.id=b.job_id WHERE b.id=? AND b.company_id=?""",
                      (batch_id, company_id)).fetchone()


def _serialize(db, batch) -> dict:
    rows = db.execute("""SELECT * FROM screening_batch_candidates WHERE batch_id=?
      ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank, application_id""",
                      (batch["id"],)).fetchall()
    items = [{"applicationId": row["application_id"], "candidateId": row["candidate_id"],
              "candidateName": row["candidate_name"], "assessmentId": row["assessment_id"],
              "rank": row["rank"], "score": row["score"], "selected": bool(row["selected"]),
              "selectionStatus": row["selection_status"],
              "scoreDetails": json.loads(row["score_details_json"]) if row["score_details_json"] else None,
              "reviewDecision": row["review_decision"], "reviewedAt": row["reviewed_at"]}
             for row in rows]
    selected = [item for item in items if item["selected"]]
    current_index = next((index for index, item in enumerate(selected)
                          if item["reviewDecision"] is None), None)
    if current_index is None:
        current_index = next((index for index, item in enumerate(selected)
                              if item["reviewDecision"] == "defer"), None)
    return {"id": batch["id"], "jobId": batch["job_id"], "jobTitle": batch["job_title"],
            "profileVersionId": batch["profile_version_id"],
            "profileVersion": batch["profile_version"],
            "retentionPercent": batch["retention_percent"],
            "totalCount": batch["total_count"], "eligibleCount": batch["eligible_count"],
            "selectedCount": batch["selected_count"],
            "notSelectedCount": batch["eligible_count"] - batch["selected_count"],
            "pendingCount": batch["pending_count"],
            "boundaryTie": bool(batch["boundary_tie"]), "boundaryScore": batch["boundary_score"],
            "reviewedCount": sum(item["reviewDecision"] in ("keep", "talent") for item in selected),
            "deferredCount": sum(item["reviewDecision"] == "defer" for item in selected),
            "currentIndex": current_index, "status": batch["status"],
            "createdAt": batch["created_at"], "updatedAt": batch["updated_at"],
            "items": items}


def get_batch(batch_id: str, company_id: str) -> dict | None:
    init_db()
    with repo.db() as db:
        batch = _batch(db, batch_id, company_id)
        return _serialize(db, batch) if batch else None


def create_batch(job_id: str, retention_percent: float, company_id: str,
                 actor_id: str) -> dict:
    init_db()
    job = repo.get_job(job_id)
    if not job or job["company_id"] != company_id:
        raise HTTPException(404, "岗位不存在。")
    if not math.isfinite(retention_percent) or not 0 < retention_percent <= 100:
        raise HTTPException(422, "保留比例必须大于 0 且不超过 100%。")
    profile = _profile(job_id, company_id)
    ranked, pending = _pool(job_id, company_id, profile["id"])
    if not ranked:
        raise HTTPException(409, "该岗位尚无同一招聘标准版本下可解释的多维评分，请先完成评估。")
    selected_count = math.ceil(len(ranked) * retention_percent / 100)
    boundary_tie = (0 < selected_count < len(ranked)
                    and ranked[selected_count - 1]["score"] == ranked[selected_count]["score"])
    batch_id, now = uuid.uuid4().hex, time.time()
    with repo.db() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""INSERT INTO screening_batches
          (id,company_id,job_id,profile_version_id,profile_version,retention_percent,
           total_count,eligible_count,selected_count,pending_count,boundary_tie,boundary_score,
           status,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (batch_id, company_id, job_id, profile["id"],
           profile["version"], retention_percent, len(ranked) + len(pending),
           len(ranked), selected_count, len(pending),
           int(boundary_tie), ranked[selected_count - 1]["score"] if boundary_tie else None,
           "active", actor_id, now, now))
        for item in [*ranked, *pending]:
            chosen = item["rank"] <= selected_count if item.get("rank") else False
            selection = "selected" if chosen else "not_selected" if item.get("rank") else "pending_assessment"
            db.execute("""INSERT INTO screening_batch_candidates
              (batch_id,application_id,candidate_id,candidate_name,assessment_id,score,rank,
               selected,selection_status,score_details_json)
              VALUES(?,?,?,?,?,?,?,?,?,?)""",
              (batch_id, item["applicationId"], item["candidateId"], item["candidateName"],
               item["assessmentId"], item["score"], item.get("rank"), int(chosen), selection,
               json.dumps(item["scoreDetails"], ensure_ascii=False)))
        return _serialize(db, _batch(db, batch_id, company_id))


def _refresh_status(db, batch_id: str) -> None:
    row = db.execute("""SELECT COUNT(*) AS unresolved,
      SUM(CASE WHEN review_decision='defer' THEN 1 ELSE 0 END) AS deferred
      FROM screening_batch_candidates WHERE batch_id=? AND selected=1
      AND (review_decision IS NULL OR review_decision='defer')""", (batch_id,)).fetchone()
    status = "active" if row["unresolved"] and row["unresolved"] > 0 else "completed"
    db.execute("UPDATE screening_batches SET status=?,updated_at=? WHERE id=?",
               (status, time.time(), batch_id))


def decide(batch_id: str, application_id: str, decision: str,
           company_id: str, actor_id: str) -> dict:
    init_db()
    with repo.db() as db:
        db.execute("BEGIN IMMEDIATE")
        batch = _batch(db, batch_id, company_id)
        if not batch:
            raise HTTPException(404, "筛选批次不存在。")
        item = db.execute("""SELECT * FROM screening_batch_candidates
          WHERE batch_id=? AND application_id=? AND selected=1""",
                          (batch_id, application_id)).fetchone()
        if not item:
            raise HTTPException(404, "候选人不在本轮入围名单。")
        prior = item["review_decision"]
        if prior == decision:
            return _serialize(db, batch)
        if prior in ("keep", "talent"):
            raise HTTPException(409, "该候选人已处理；请先撤销上一步，再重新审核。")
        talent = db.execute("""SELECT * FROM talent_records
          WHERE candidate_id=? AND company_id=?""",
                            (item["candidate_id"], company_id)).fetchone()
        talent_snapshot = json.dumps(dict(talent), ensure_ascii=False) if talent else None
        now = time.time()
        if decision == "talent":
            db.execute("""INSERT INTO talent_records
              (id,candidate_id,company_id,source_application_id,status,notes,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(candidate_id,company_id) DO UPDATE SET
              source_application_id=excluded.source_application_id,status='active',
              updated_at=excluded.updated_at""",
              (uuid.uuid4().hex, item["candidate_id"], company_id, application_id,
               "active", "本轮岗位暂不保留；人才库可重新匹配。", now, now))
        db.execute("""UPDATE screening_batch_candidates SET review_decision=?,reviewed_at=?
          WHERE batch_id=? AND application_id=?""",
          (decision, now, batch_id, application_id))
        db.execute("""INSERT INTO screening_batch_actions
          (id,batch_id,application_id,actor_id,decision,previous_decision,
           previous_talent_json,created_at) VALUES(?,?,?,?,?,?,?,?)""",
          (uuid.uuid4().hex, batch_id, application_id, actor_id, decision, prior,
           talent_snapshot, now))
        _refresh_status(db, batch_id)
        return _serialize(db, _batch(db, batch_id, company_id))


def undo(batch_id: str, company_id: str) -> dict:
    init_db()
    with repo.db() as db:
        db.execute("BEGIN IMMEDIATE")
        batch = _batch(db, batch_id, company_id)
        if not batch:
            raise HTTPException(404, "筛选批次不存在。")
        action = db.execute("""SELECT * FROM screening_batch_actions
          WHERE batch_id=? AND undone_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1""",
                            (batch_id,)).fetchone()
        if not action:
            raise HTTPException(409, "没有可撤销的审核操作。")
        item = db.execute("""SELECT * FROM screening_batch_candidates
          WHERE batch_id=? AND application_id=?""",
                          (batch_id, action["application_id"])).fetchone()
        if not item or item["review_decision"] != action["decision"]:
            raise HTTPException(409, "审核状态已变化，不能撤销。")
        if action["decision"] == "talent":
            previous = json.loads(action["previous_talent_json"]) if action["previous_talent_json"] else None
            if previous:
                db.execute("""UPDATE talent_records SET source_application_id=?,status=?,
                  notes=?,updated_at=? WHERE candidate_id=? AND company_id=?""",
                  (previous["source_application_id"], previous["status"], previous["notes"],
                   previous["updated_at"], item["candidate_id"], company_id))
            else:
                db.execute("DELETE FROM talent_records WHERE candidate_id=? AND company_id=?",
                           (item["candidate_id"], company_id))
        now = time.time()
        db.execute("""UPDATE screening_batch_candidates SET review_decision=?,reviewed_at=NULL
          WHERE batch_id=? AND application_id=?""",
          (action["previous_decision"], batch_id, action["application_id"]))
        db.execute("UPDATE screening_batch_actions SET undone_at=? WHERE id=?", (now, action["id"]))
        _refresh_status(db, batch_id)
        return _serialize(db, _batch(db, batch_id, company_id))


@router.get("/api/hr/screening-batches/preview")
def preview_route(jobId: str, retentionPercent: float = Query(gt=0, le=100),
                  user: dict = Depends(hr)) -> dict:
    init_db()
    job = repo.get_job(jobId)
    if not job or job["company_id"] != user["companyId"]:
        raise HTTPException(404, "岗位不存在。")
    return preview(jobId, retentionPercent, user["companyId"])


@router.post("/api/hr/jobs/{job_id}/assessments/queue", status_code=202)
def queue_assessments_route(job_id: str, user: dict = Depends(hr)) -> dict:
    return enqueue_assessments(job_id, user["companyId"])


@router.get("/api/hr/jobs/{job_id}/assessments/queue")
def assessment_queue_route(job_id: str, user: dict = Depends(hr)) -> dict:
    return assessment_queue(job_id, user["companyId"])


@router.post("/api/hr/screening-batches", status_code=201)
def create_route(body: BatchCreate, user: dict = Depends(hr)) -> dict:
    return create_batch(body.jobId, body.retentionPercent, user["companyId"], user["id"])


@router.get("/api/hr/screening-batches")
def list_route(jobId: str | None = None, user: dict = Depends(hr)) -> dict:
    init_db()
    with repo.db() as db:
        clause = "AND b.job_id=?" if jobId else ""
        args = (user["companyId"], jobId) if jobId else (user["companyId"],)
        rows = db.execute(f"""SELECT b.*,j.title AS job_title FROM screening_batches b
          JOIN jobs j ON j.id=b.job_id WHERE b.company_id=? {clause}
          ORDER BY b.created_at DESC LIMIT 100""", args).fetchall()
        return {"items": [{key: value for key, value in _serialize(db, row).items() if key != "items"}
                          for row in rows]}


@router.get("/api/hr/screening-batches/{batch_id}")
def get_route(batch_id: str, user: dict = Depends(hr)) -> dict:
    result = get_batch(batch_id, user["companyId"])
    if not result:
        raise HTTPException(404, "筛选批次不存在。")
    return result


@router.post("/api/hr/screening-batches/{batch_id}/decisions")
def decide_route(batch_id: str, body: CardDecision, user: dict = Depends(hr)) -> dict:
    return decide(batch_id, body.applicationId, body.decision, user["companyId"], user["id"])


@router.post("/api/hr/screening-batches/{batch_id}/undo")
def undo_route(batch_id: str, user: dict = Depends(hr)) -> dict:
    return undo(batch_id, user["companyId"])
