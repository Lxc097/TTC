"""Persisted, tenant-scoped analysis stages and replayable progress events."""
from __future__ import annotations

import asyncio
import json
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import recruitment_store as repo
from .recruitment_api import hr

router = APIRouter()
_schema_lock = threading.Lock()
_schema_path: str | None = None


def init_db() -> None:
    global _schema_path
    path = str(repo.data_dir() / "recruitment.sqlite3")
    if path == _schema_path:
        return
    with _schema_lock:
        if path == _schema_path:
            return
        with repo.db() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS analysis_stages (
              application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
              stage TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL,
              PRIMARY KEY(application_id,stage));
            CREATE TABLE IF NOT EXISTS analysis_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
              stage TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
              created_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS analysis_events_app_idx
              ON analysis_events(application_id,id);
            """)
        _schema_path = path


def record(application_id: str, stage: str, status: str, message: str) -> None:
    """Store only operational facts; never log resume text or provider responses."""
    init_db()
    now = time.time()
    with repo.db() as db:
        old = db.execute("SELECT status,message,attempts FROM analysis_stages WHERE application_id=? AND stage=?",
                         (application_id, stage)).fetchone()
        if old and old["status"] == status and old["message"] == message:
            return
        attempts = (old["attempts"] if old else 0) + (status == "processing")
        db.execute("""INSERT INTO analysis_stages(application_id,stage,status,message,attempts,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(application_id,stage) DO UPDATE SET
          status=excluded.status,message=excluded.message,attempts=excluded.attempts,
          updated_at=excluded.updated_at""",
          (application_id, stage, status, message[:240], attempts, now))
        db.execute("INSERT INTO analysis_events(application_id,stage,status,message,created_at) VALUES(?,?,?,?,?)",
                   (application_id, stage, status, message[:240], now))


def detail(application_id: str, after_id: int = 0) -> dict:
    init_db()
    with repo.db() as db:
        stages = db.execute("""SELECT stage,status,message,attempts,updated_at FROM analysis_stages
          WHERE application_id=? ORDER BY updated_at,stage""", (application_id,)).fetchall()
        events = db.execute("""SELECT id,stage,status,message,created_at FROM analysis_events
          WHERE application_id=? AND id>? ORDER BY id LIMIT 200""", (application_id, after_id)).fetchall()
    return {"taskId": application_id,
            "stages": [{"stage": row["stage"], "status": row["status"],
                        "message": row["message"], "attempts": row["attempts"],
                        "updatedAt": row["updated_at"]} for row in stages],
            "events": [{"id": row["id"], "stage": row["stage"], "status": row["status"],
                        "message": row["message"], "createdAt": row["created_at"]} for row in events]}


@router.get("/api/hr/applications/{app_id}/progress")
def get_progress(app_id: str, after: int = 0, user: dict = Depends(hr)) -> dict:
    if not repo.hr_application(app_id, user["companyId"]):
        raise HTTPException(404, "申请不存在。")
    return detail(app_id, max(0, after))


@router.get("/api/hr/applications/{app_id}/progress/events")
async def stream_progress(app_id: str, request: Request, after: int = 0,
                          user: dict = Depends(hr)) -> StreamingResponse:
    if not repo.hr_application(app_id, user["companyId"]):
        raise HTTPException(404, "申请不存在。")

    async def stream():
        cursor = max(0, after)
        while not await request.is_disconnected():
            batch = await asyncio.to_thread(detail, app_id, cursor)
            for event in batch["events"]:
                cursor = event["id"]
                yield f"id: {cursor}\nevent: progress\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
