"""Versioned hiring requirements in the existing SQLite store."""
from __future__ import annotations

import json
import time
import uuid

from . import recruitment_store as repo


def init_db() -> None:
    """Additive tables; call after the existing recruitment migration."""
    with repo.db() as connection:
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS requirement_sessions (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
          created_by TEXT NOT NULL REFERENCES users(id),
          job_id TEXT REFERENCES jobs(id), stage TEXT NOT NULL DEFAULT 'clarifying',
          draft_json TEXT, confirmed_version_id TEXT,
          created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requirement_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES requirement_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL, created_at REAL NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'completed', error TEXT,
          status_updated_at REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS requirement_messages_session_idx
          ON requirement_messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS requirement_sessions_company_idx
          ON requirement_sessions(company_id, updated_at);
        CREATE TABLE IF NOT EXISTS hiring_profile_versions (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          version INTEGER NOT NULL, profile_json TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id), confirmed_at REAL NOT NULL,
          UNIQUE(job_id, version)
        );
        CREATE INDEX IF NOT EXISTS hiring_profile_versions_job_idx
          ON hiring_profile_versions(job_id, version DESC);
        CREATE TABLE IF NOT EXISTS architect_ai_usage (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES requirement_sessions(id) ON DELETE CASCADE,
          model TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
          elapsed_ms INTEGER, trace_id TEXT, created_at REAL NOT NULL
        );
        """)
        columns = {item[1] for item in connection.execute("PRAGMA table_info(requirement_messages)")}
        if "delivery_status" not in columns:
            connection.execute("ALTER TABLE requirement_messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'completed'")
        if "error" not in columns:
            connection.execute("ALTER TABLE requirement_messages ADD COLUMN error TEXT")
        if "status_updated_at" not in columns:
            connection.execute("ALTER TABLE requirement_messages ADD COLUMN status_updated_at REAL NOT NULL DEFAULT 0")
        connection.execute("UPDATE requirement_messages SET status_updated_at=created_at WHERE status_updated_at=0")
        connection.execute("""UPDATE requirement_messages
          SET delivery_status='failed',error='上次请求中断，请重试。',status_updated_at=?
          WHERE delivery_status='processing' AND status_updated_at<?""",
          (time.time(), time.time() - 120))


def _session_dto(connection, row) -> dict:
    messages = connection.execute("""SELECT id,role,content,created_at,delivery_status,error FROM requirement_messages
      WHERE session_id=? ORDER BY created_at,id""", (row["id"],)).fetchall()
    confirmed = None
    version = None
    if row["confirmed_version_id"]:
        saved = connection.execute("""SELECT version,profile_json FROM hiring_profile_versions
          WHERE id=?""", (row["confirmed_version_id"],)).fetchone()
        if saved:
            version = saved["version"]
            confirmed = json.loads(saved["profile_json"])
    job = connection.execute("SELECT title FROM jobs WHERE id=?", (row["job_id"],)).fetchone() if row["job_id"] else None
    return {"id": row["id"], "jobId": row["job_id"], "jobTitle": job["title"] if job else None,
            "stage": row["stage"],
            "messages": [{"id": item["id"], "role": item["role"], "content": item["content"],
                          "deliveryStatus": item["delivery_status"], "error": item["error"],
                          "createdAt": item["created_at"]} for item in messages],
            "draftProfile": json.loads(row["draft_json"]) if row["draft_json"] else None,
            "confirmedProfile": confirmed, "version": version,
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def list_sessions(company_id: str, *, job_id: str | None = None,
                  limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
    """Return compact server-backed history for the consultant sidebar."""
    limit = max(1, min(100, int(limit)))
    offset = max(0, int(offset))
    with repo.db() as connection:
        where = "s.company_id=?"
        args: list[object] = [company_id]
        if job_id:
            where += " AND s.job_id=?"
            args.append(job_id)
        total = connection.execute(f"SELECT COUNT(*) FROM requirement_sessions s WHERE {where}", args).fetchone()[0]
        rows = connection.execute(f"""SELECT s.*,j.title AS job_title,
          (SELECT COUNT(*) FROM requirement_messages m WHERE m.session_id=s.id) AS message_count,
          (SELECT content FROM requirement_messages m WHERE m.session_id=s.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS preview,
          (SELECT version FROM hiring_profile_versions p WHERE p.id=s.confirmed_version_id) AS profile_version
          FROM requirement_sessions s LEFT JOIN jobs j ON j.id=s.job_id
          WHERE {where} ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?""",
          [*args, limit, offset]).fetchall()
    return ([{"id": row["id"], "jobId": row["job_id"], "jobTitle": row["job_title"],
              "stage": row["stage"], "version": row["profile_version"],
              "messageCount": row["message_count"], "preview": row["preview"] or "",
              "createdAt": row["created_at"], "updatedAt": row["updated_at"]} for row in rows], total)


def begin_exchange(session_id: str, company_id: str, expected_messages: int,
                   user_message: str, retry_message_id: str | None = None) -> dict | None:
    """Persist the HR message before calling the model, so failed calls are retryable."""
    now = time.time()
    with repo.db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=? AND company_id=?",
                                 (session_id, company_id)).fetchone()
        if not row:
            return None
        messages = connection.execute("SELECT id,role,content,delivery_status,status_updated_at FROM requirement_messages WHERE session_id=? ORDER BY created_at,id",
                                      (session_id,)).fetchall()
        if retry_message_id:
            if (messages and messages[-1]["delivery_status"] == "processing"
                    and messages[-1]["status_updated_at"] < now - 120):
                connection.execute("UPDATE requirement_messages SET delivery_status='failed',error='上次请求中断，请重试。' WHERE id=?",
                                   (messages[-1]["id"],))
                messages = connection.execute("SELECT id,role,content,delivery_status,status_updated_at FROM requirement_messages WHERE session_id=? ORDER BY created_at,id",
                                              (session_id,)).fetchall()
            if (not messages or messages[-1]["id"] != retry_message_id
                    or messages[-1]["role"] != "user"
                    or messages[-1]["content"] != user_message
                    or messages[-1]["delivery_status"] != "failed"):
                raise ValueError("待重试消息已变化，请刷新对话。")
            connection.execute("UPDATE requirement_messages SET delivery_status='processing',error=NULL,status_updated_at=? WHERE id=?",
                               (now, retry_message_id))
            return {"messageId": retry_message_id, "session": _session_dto(connection, row), "reused": True}
        if len(messages) != expected_messages:
            raise ValueError("对话已由另一请求更新，请刷新后重试。")
        if messages and messages[-1]["role"] == "user":
            raise ValueError("上一条消息尚未完成，请等待或重试。")
        message_id = uuid.uuid4().hex
        connection.execute("""INSERT INTO requirement_messages
          (id,session_id,role,content,created_at,delivery_status,status_updated_at)
          VALUES(?,?,?,?,?,'processing',?)""",
                           (message_id, session_id, "user", user_message, now, now))
        connection.execute("UPDATE requirement_sessions SET updated_at=? WHERE id=?", (now, session_id))
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=?", (session_id,)).fetchone()
        return {"messageId": message_id, "session": _session_dto(connection, row), "reused": False}


def complete_exchange(session_id: str, company_id: str, message_id: str,
                      assistant_message: str, draft_profile: dict | None,
                      stage: str, usage: dict | None = None) -> dict | None:
    now = time.time()
    with repo.db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=? AND company_id=?",
                                  (session_id, company_id)).fetchone()
        user_row = connection.execute("SELECT * FROM requirement_messages WHERE id=? AND session_id=? AND role='user'",
                                      (message_id, session_id)).fetchone()
        if not row or not user_row:
            return None
        existing = connection.execute("SELECT id FROM requirement_messages WHERE session_id=? AND role='assistant' AND created_at>? LIMIT 1",
                                      (session_id, user_row["created_at"])).fetchone()
        if not existing:
            connection.execute("INSERT INTO requirement_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
                               (uuid.uuid4().hex, session_id, "assistant", assistant_message, now + 0.000001))
        connection.execute("UPDATE requirement_messages SET delivery_status='completed',error=NULL,status_updated_at=? WHERE id=?",
                           (now, message_id))
        draft_json = (json.dumps(draft_profile, ensure_ascii=False) if draft_profile else
                      (None if row["stage"] == "confirmed" else row["draft_json"]))
        connection.execute("UPDATE requirement_sessions SET stage=?,draft_json=?,updated_at=? WHERE id=?",
                           (stage, draft_json, now, session_id))
        if usage:
            connection.execute("""INSERT INTO architect_ai_usage
              (id,session_id,model,prompt_tokens,completion_tokens,elapsed_ms,trace_id,created_at)
              VALUES (?,?,?,?,?,?,?,?)""",
              (uuid.uuid4().hex, session_id, str(usage.get("model") or "unknown")[:120],
               usage.get("promptTokens"), usage.get("completionTokens"), usage.get("elapsedMs"),
               str(usage.get("traceId") or "")[:160], now))
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=?", (session_id,)).fetchone()
        return _session_dto(connection, row)


def fail_exchange(session_id: str, company_id: str, message_id: str, error: str) -> None:
    with repo.db() as connection:
        connection.execute("""UPDATE requirement_messages SET delivery_status='failed',error=?,status_updated_at=?
          WHERE id=? AND role='user' AND session_id IN
          (SELECT id FROM requirement_sessions WHERE id=? AND company_id=?)""",
          (error[:180], time.time(), message_id, session_id, company_id))


def create_session(company_id: str, user_id: str, job_id: str | None = None) -> dict | None:
    now = time.time()
    with repo.db() as connection:
        if job_id and not connection.execute(
                "SELECT 1 FROM jobs WHERE id=? AND company_id=?", (job_id, company_id)).fetchone():
            return None
        session_id = uuid.uuid4().hex
        connection.execute("""INSERT INTO requirement_sessions
          (id,company_id,created_by,job_id,stage,created_at,updated_at)
          VALUES (?,?,?,?,'clarifying',?,?)""",
          (session_id, company_id, user_id, job_id, now, now))
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=?", (session_id,)).fetchone()
        return _session_dto(connection, row)


def get_session(session_id: str, company_id: str) -> dict | None:
    with repo.db() as connection:
        connection.execute("""UPDATE requirement_messages SET delivery_status='failed',
          error='上次请求中断，请重试。',status_updated_at=?
          WHERE session_id=? AND delivery_status='processing' AND status_updated_at<?""",
          (time.time(), session_id, time.time() - 120))
        row = connection.execute("""SELECT * FROM requirement_sessions
          WHERE id=? AND company_id=?""", (session_id, company_id)).fetchone()
        return _session_dto(connection, row) if row else None


def add_exchange(session_id: str, company_id: str, expected_messages: int,
                 user_message: str, assistant_message: str, draft_profile: dict | None,
                 stage: str, usage: dict | None = None) -> dict | None:
    now = time.time()
    with repo.db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT * FROM requirement_sessions
          WHERE id=? AND company_id=?""", (session_id, company_id)).fetchone()
        if not row:
            return None
        count = connection.execute("SELECT COUNT(*) FROM requirement_messages WHERE session_id=?",
                                   (session_id,)).fetchone()[0]
        if count != expected_messages:
            raise ValueError("对话已由另一请求更新，请刷新后重试。")
        latest = connection.execute("""SELECT role FROM requirement_messages
          WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1""", (session_id,)).fetchone()
        if latest and latest["role"] == "user":
            raise ValueError("上一条消息尚未完成，请使用流式接口重试。")
        for index, (role, content) in enumerate((("user", user_message),
                                                 ("assistant", assistant_message))):
            connection.execute("""INSERT INTO requirement_messages
              (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)""",
              (uuid.uuid4().hex, session_id, role, content, now + index * 0.000001))
        draft_json = (json.dumps(draft_profile, ensure_ascii=False) if draft_profile else
                      (None if row["stage"] == "confirmed" else row["draft_json"]))
        connection.execute("""UPDATE requirement_sessions SET stage=?,draft_json=?,updated_at=?
          WHERE id=?""", (stage, draft_json, now, session_id))
        if usage:
            connection.execute("""INSERT INTO architect_ai_usage
              (id,session_id,model,prompt_tokens,completion_tokens,elapsed_ms,trace_id,created_at)
              VALUES (?,?,?,?,?,?,?,?)""",
              (uuid.uuid4().hex, session_id, str(usage.get("model") or "unknown")[:120],
               usage.get("promptTokens"), usage.get("completionTokens"),
               usage.get("elapsedMs"), str(usage.get("traceId") or "")[:160], now))
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=?", (session_id,)).fetchone()
        return _session_dto(connection, row)


def latest_profile(job_id: str, company_id: str | None = None) -> dict | None:
    with repo.db() as connection:
        scope = "AND j.company_id=?" if company_id else ""
        args = (job_id, company_id) if company_id else (job_id,)
        row = connection.execute(f"""SELECT p.* FROM hiring_profile_versions p
          JOIN jobs j ON j.id=p.job_id WHERE p.job_id=? {scope}
          ORDER BY p.version DESC LIMIT 1""", args).fetchone()
    return ({"id": row["id"], "jobId": job_id, "version": row["version"],
             "profile": json.loads(row["profile_json"]),
             "confirmedAt": row["confirmed_at"]} if row else None)


def profile_for_application(application_id: str) -> dict | None:
    """Return the version pinned when the application was created."""
    with repo.db() as connection:
        row = connection.execute("""SELECT p.* FROM screenings s
          JOIN hiring_profile_versions p ON p.id=s.profile_version_id
          WHERE s.application_id=?""", (application_id,)).fetchone()
    return ({"id": row["id"], "jobId": row["job_id"], "version": row["version"],
             "profile": json.loads(row["profile_json"]),
             "confirmedAt": row["confirmed_at"]} if row else None)


def list_profiles(job_id: str, company_id: str) -> list[dict] | None:
    with repo.db() as connection:
        if not connection.execute("SELECT 1 FROM jobs WHERE id=? AND company_id=?",
                                  (job_id, company_id)).fetchone():
            return None
        rows = connection.execute("""SELECT * FROM hiring_profile_versions
          WHERE job_id=? ORDER BY version DESC""", (job_id,)).fetchall()
    return [{"id": row["id"], "jobId": job_id, "version": row["version"],
             "profile": json.loads(row["profile_json"]),
             "confirmedAt": row["confirmed_at"]} for row in rows]


def get_profile_version(job_id: str, company_id: str, version: int) -> dict | None:
    """Read an immutable version without changing the job's current standard."""
    with repo.db() as connection:
        row = connection.execute("""SELECT p.* FROM hiring_profile_versions p
          JOIN jobs j ON j.id=p.job_id
          WHERE p.job_id=? AND j.company_id=? AND p.version=?""",
          (job_id, company_id, version)).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "jobId": job_id, "version": row["version"],
            "profile": json.loads(row["profile_json"]),
            "confirmedAt": row["confirmed_at"]}


def confirm_session(session_id: str, company_id: str, user_id: str, profile: dict) -> dict | None:
    """Commit an immutable version and create a job for a new session."""
    now = time.time()
    with repo.db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT * FROM requirement_sessions
          WHERE id=? AND company_id=?""", (session_id, company_id)).fetchone()
        if not row:
            return None
        if row["stage"] == "confirmed":
            return _session_dto(connection, row)
        job_id = row["job_id"]
        if not job_id:
            job_id = uuid.uuid4().hex
            connection.execute("""INSERT INTO jobs
              (id,company_id,title,description,published,created_at) VALUES (?,?,?,?,1,?)""",
              (job_id, company_id, profile["jobName"][:120], profile["summary"][:12000], now))
        latest = connection.execute("""SELECT COALESCE(MAX(version),0) FROM hiring_profile_versions
          WHERE job_id=?""", (job_id,)).fetchone()[0]
        version_id = uuid.uuid4().hex
        connection.execute("""INSERT INTO hiring_profile_versions
          (id,job_id,version,profile_json,created_by,confirmed_at) VALUES (?,?,?,?,?,?)""",
          (version_id, job_id, latest + 1, json.dumps(profile, ensure_ascii=False), user_id, now))
        connection.execute("""UPDATE requirement_sessions SET job_id=?,stage='confirmed',
          draft_json=?,confirmed_version_id=?,updated_at=? WHERE id=?""",
          (job_id, json.dumps(profile, ensure_ascii=False), version_id, now, session_id))
        row = connection.execute("SELECT * FROM requirement_sessions WHERE id=?", (session_id,)).fetchone()
        return _session_dto(connection, row)
