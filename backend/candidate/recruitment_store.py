"""Persistent recruitment data, separate from the legacy in-memory interview demo.

Every query that returns an application is scoped to a candidate or company. A
candidate-facing serializer lives in recruitment_api and never selects reports.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def data_dir() -> Path:
    path = Path(os.getenv("RECRUITMENT_DATA_DIR", "").strip()
                or str(Path(__file__).with_name(".local-data")))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _days_env(name: str, default: int) -> int:
    """邀请有效期（天）。和 RECRUITMENT_RETENTION_DAYS 一样在读取时解析。"""
    try:
        return max(1, min(365, int(os.getenv(name, str(default)))))
    except ValueError:
        return default


def _invite_seconds(name: str, default: int) -> float:
    return _days_env(name, default) * 86400.0


def _ensure_columns(connection: sqlite3.Connection, table: str,
                    definitions: tuple[tuple[str, str], ...]) -> None:
    """Additive migration: only ever add missing columns, never rebuild a table."""
    columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    for name, definition in definitions:
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(data_dir() / "recruitment.sqlite3", timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    with db() as connection:
        connection.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS companies (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
          password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('candidate','hr')),
          company_id TEXT REFERENCES companies(id), created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_tokens (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
          title TEXT NOT NULL, description TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS applications (
          id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES users(id),
          job_id TEXT NOT NULL REFERENCES jobs(id), status TEXT NOT NULL,
          resume_status TEXT NOT NULL, screening_status TEXT NOT NULL,
          verify_links INTEGER NOT NULL DEFAULT 0,
          created_at REAL NOT NULL, updated_at REAL NOT NULL,
          source TEXT NOT NULL DEFAULT 'candidate_portal',
          uploaded_by TEXT REFERENCES users(id),
          UNIQUE(candidate_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS resumes (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL, content_type TEXT NOT NULL, file_path TEXT NOT NULL,
          sha256 TEXT NOT NULL, raw_text TEXT, parsed_json TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS application_attachments (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL, content_type TEXT NOT NULL,
          sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          content BLOB NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS screenings (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          report_json TEXT, model TEXT, prompt_version TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER, completion_tokens INTEGER, error TEXT, completed_at REAL
        );
        CREATE TABLE IF NOT EXISTS external_evidence (
          id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          source TEXT NOT NULL, url TEXT NOT NULL, checked_at REAL NOT NULL,
          related_claim TEXT, verification_status TEXT NOT NULL, details TEXT
        );
        CREATE TABLE IF NOT EXISTS reviews (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          reviewer_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL,
          notes TEXT NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY, application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
          room_code TEXT, status TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS correction_requests (
          id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          message TEXT NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS formal_interviews (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
          config_json TEXT NOT NULL, session_id TEXT,
          questions_json TEXT NOT NULL DEFAULT '[]', started_at REAL NOT NULL,
          completed_at REAL
        );
        CREATE TABLE IF NOT EXISTS formal_answers (
          attempt_id TEXT NOT NULL REFERENCES formal_interviews(attempt_id) ON DELETE CASCADE,
          question_id TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL,
          created_at REAL NOT NULL, PRIMARY KEY(attempt_id, question_id)
        );
        -- 真人面试：企业端安排、候选人接受、面试官出结论。一申请一条记录。
        CREATE TABLE IF NOT EXISTS human_interviews (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          id TEXT NOT NULL, status TEXT NOT NULL,
          scheduled_at REAL, duration_minutes INTEGER NOT NULL DEFAULT 45,
          interviewer_name TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'video',
          location TEXT, room_code TEXT, result TEXT, notes TEXT NOT NULL DEFAULT '',
          result_sent INTEGER NOT NULL DEFAULT 0, sent_at REAL, expires_at REAL,
          accepted_at REAL, send_count INTEGER NOT NULL DEFAULT 1, last_sent_at REAL,
          created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        -- 双人面试间的报告只活在内存里，重启即失。会话结束时归档一份，
        -- 企业端「真人面试结果」才有可回看的佐证（双确认、追问点）。
        CREATE TABLE IF NOT EXISTS interview_reports (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL, report_json TEXT NOT NULL, archived_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id, created_at);
        CREATE INDEX IF NOT EXISTS human_interviews_schedule_idx ON human_interviews(status, scheduled_at);
        CREATE INDEX IF NOT EXISTS applications_queue_idx ON applications(screening_status, created_at);
        CREATE INDEX IF NOT EXISTS attachments_application_idx ON application_attachments(application_id);
        """)
        application_columns = {row[1] for row in connection.execute("PRAGMA table_info(applications)")}
        if "source" not in application_columns:
            connection.execute("ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT 'candidate_portal'")
        if "uploaded_by" not in application_columns:
            connection.execute("ALTER TABLE applications ADD COLUMN uploaded_by TEXT REFERENCES users(id)")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(formal_interviews)")}
        if "questions_json" not in columns:
            connection.execute("ALTER TABLE formal_interviews ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]'")
        for name, definition in (
            ("analysis_status", "TEXT NOT NULL DEFAULT 'pending'"),
            ("analysis_json", "TEXT"),
            ("analysis_error", "TEXT"),
            ("analysis_model", "TEXT"),
        ):
            if name not in columns:
                connection.execute(f"ALTER TABLE formal_interviews ADD COLUMN {name} {definition}")
        connection.execute("""UPDATE formal_interviews SET analysis_status='queued'
          WHERE status='completed' AND analysis_json IS NULL
          AND analysis_status IN ('pending','processing')""")
        _ensure_columns(connection, "jobs", (
            ("screening_criteria", "TEXT NOT NULL DEFAULT ''"),
            ("criteria_updated_at", "REAL"),
        ))
        _ensure_columns(connection, "invitations", (
            ("sent_at", "REAL"),
            ("expires_at", "REAL"),
            ("accepted_at", "REAL"),
            ("send_count", "INTEGER NOT NULL DEFAULT 1"),
            ("last_sent_at", "REAL"),
            ("result_sent", "INTEGER NOT NULL DEFAULT 0"),
        ))
        # 历史邀请没有有效期：按 created_at 补一份，列表才能直接显示「已过期」。
        connection.execute("""UPDATE invitations SET
          sent_at=COALESCE(sent_at, created_at),
          last_sent_at=COALESCE(last_sent_at, sent_at, created_at),
          expires_at=COALESCE(expires_at, created_at + ?)""",
          (_invite_seconds("AI_INVITE_DAYS", 7),))
        # A worker interrupted by restart can safely retry; reports are upserted.
        connection.execute("""UPDATE applications SET screening_status='queued',
          resume_status=CASE WHEN resume_status='parsing' THEN 'queued' ELSE resume_status END,
          status='submitted' WHERE screening_status IN ('parsing','screening')""")


def _id() -> str:
    return uuid.uuid4().hex


def _user(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "email": row["email"],
            "role": row["role"], "companyId": row["company_id"]}


def _password_hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 310_000).hex()


def create_user(name: str, email: str, password: str, role: str,
                company_name: str | None = None) -> dict:
    now = time.time()
    salt = secrets.token_hex(16)
    with db() as connection:
        company_id = None
        if role == "hr":
            assert company_name
            found = connection.execute("SELECT id FROM companies WHERE name=?", (company_name,)).fetchone()
            # A global bootstrap code may create a company, never join an existing
            # tenant. Additional HR accounts need a company-specific invite flow.
            if found:
                raise ValueError("企业已存在，不能使用初始开通码加入。")
            company_id = _id()
            connection.execute("INSERT INTO companies VALUES (?,?,?)", (company_id, company_name, now))
        user_id = _id()
        connection.execute("""INSERT INTO users
          (id,name,email,password_salt,password_hash,role,company_id,created_at)
          VALUES (?,?,?,?,?,?,?,?)""",
          (user_id, name, email, salt, _password_hash(password, salt), role, company_id, now))
        return {"id": user_id, "name": name, "email": email, "role": role,
                "companyId": company_id}


def authenticate(email: str, password: str) -> dict | None:
    with db() as connection:
        row = connection.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row:
        # Keep timing closer to a valid login attempt.
        _password_hash(password, "00" * 16)
        return None
    if not hmac.compare_digest(_password_hash(password, row["password_salt"]), row["password_hash"]):
        return None
    return _user(row)


def demo_hr() -> dict:
    """Use the first local HR workspace for the explicitly enabled demo mode."""
    with db() as connection:
        row = connection.execute("SELECT * FROM users WHERE role='hr' ORDER BY created_at LIMIT 1").fetchone()
    if row:
        return _user(row)
    return create_user("演示 HR", "demo-hr@example.invalid", secrets.token_urlsafe(24),
                       "hr", "演示企业")


def demo_candidate(identifier: str) -> dict:
    """Stable candidate identity by typed name/email; passwords are ignored in demo."""
    identifier = identifier.strip()[:120]
    if not identifier:
        raise ValueError("请输入测试账号。")
    email = identifier.lower()
    with db() as connection:
        row = connection.execute("SELECT * FROM users WHERE email=? AND role='candidate'",
                                 (email,)).fetchone()
    if row:
        return _user(row)
    synthetic = "demo-" + hashlib.sha256(email.encode()).hexdigest()[:32] + "@example.invalid"
    with db() as connection:
        row = connection.execute("SELECT * FROM users WHERE email=? AND role='candidate'",
                                 (synthetic,)).fetchone()
    if row:
        return _user(row)
    try:
        return create_user(identifier.split("@", 1)[0][:100], synthetic,
                           secrets.token_urlsafe(24), "candidate")
    except sqlite3.IntegrityError:
        with db() as connection:
            row = connection.execute("SELECT * FROM users WHERE email=? AND role='candidate'",
                                     (synthetic,)).fetchone()
        if row:
            return _user(row)
        raise


def issue_token(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with db() as connection:
        connection.execute("INSERT INTO auth_tokens VALUES (?,?,?)",
                           (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + 7 * 86400))
    return token


def get_user_for_token(token: str) -> dict | None:
    if not token or len(token) > 256:
        return None
    digest = hashlib.sha256(token.encode()).hexdigest()
    with db() as connection:
        row = connection.execute("""SELECT users.* FROM users JOIN auth_tokens
          ON users.id=auth_tokens.user_id WHERE auth_tokens.token_hash=?
          AND auth_tokens.expires_at>?""", (digest, time.time())).fetchone()
    return _user(row) if row else None


def create_job(company_id: str, title: str, description: str,
               criteria: str = "") -> dict:
    job = {"id": _id(), "companyId": company_id, "title": title,
           "description": description, "screeningCriteria": criteria,
           "createdAt": time.time()}
    with db() as connection:
        connection.execute("""INSERT INTO jobs
          (id,company_id,title,description,published,created_at,screening_criteria)
          VALUES (?,?,?,?,?,?,?)""",
          (job["id"], company_id, title, description, 1, job["createdAt"], criteria))
    return job


def list_jobs(company_id: str | None = None, include_criteria: bool = False) -> list[dict]:
    where = "AND jobs.company_id=?" if company_id else ""
    args = (company_id,) if company_id else ()
    with db() as connection:
        rows = connection.execute(f"""SELECT jobs.*, companies.name AS company_name
          FROM jobs JOIN companies ON companies.id=jobs.company_id
          WHERE jobs.published=1 {where} ORDER BY jobs.created_at DESC""", args).fetchall()
    result = [{"id": r["id"], "title": r["title"], "description": r["description"],
               "companyName": r["company_name"], "companyId": r["company_id"],
               "createdAt": r["created_at"]} for r in rows]
    if include_criteria:
        # 内部初筛标准只给企业端；公开的 /api/jobs 绝不能带出去。
        by_id = {r["id"]: r for r in rows}
        for item in result:
            row = by_id[item["id"]]
            item["screeningCriteria"] = row["screening_criteria"] or ""
            item["criteriaUpdatedAt"] = row["criteria_updated_at"]
    return result


def save_job_criteria(job_id: str, company_id: str, criteria: str) -> dict | None:
    now = time.time()
    with db() as connection:
        job = connection.execute("SELECT id FROM jobs WHERE id=? AND company_id=?",
                                 (job_id, company_id)).fetchone()
        if not job:
            return None
        connection.execute("""UPDATE jobs SET screening_criteria=?, criteria_updated_at=?
          WHERE id=?""", (criteria, now, job_id))
    return {"jobId": job_id, "screeningCriteria": criteria, "updatedAt": now}


def get_job(job_id: str) -> dict | None:
    with db() as connection:
        row = connection.execute("""SELECT jobs.*, companies.name AS company_name
          FROM jobs JOIN companies ON companies.id=jobs.company_id
          WHERE jobs.id=? AND jobs.published=1""", (job_id,)).fetchone()
    return dict(row) if row else None


def create_application(candidate_id: str, job_id: str, file_name: str,
                       content_type: str, file_path: str, sha256: str,
                       verify_links: bool) -> str:
    app_id, now = _id(), time.time()
    with db() as connection:
        connection.execute("""INSERT INTO applications
          (id,candidate_id,job_id,status,resume_status,screening_status,verify_links,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)""",
          (app_id, candidate_id, job_id, "submitted", "queued", "queued", int(verify_links), now, now))
        connection.execute("""INSERT INTO resumes
          (application_id,original_name,content_type,file_path,sha256)
          VALUES (?,?,?,?,?)""", (app_id, file_name, content_type, file_path, sha256))
        connection.execute("INSERT INTO screenings (application_id) VALUES (?)", (app_id,))
    return app_id


def create_hr_import(company_id: str, uploader_id: str, job_id: str,
                     candidate_name: str, file_name: str, content_type: str,
                     file_path: str, sha256: str,
                     attachments: list[dict] | None = None) -> str:
    """Keep imported resumes in the normal queue without granting a candidate account access."""
    app_id, user_id, now = _id(), _id(), time.time()
    salt = secrets.token_hex(16)
    with db() as connection:
        job = connection.execute("SELECT 1 FROM jobs WHERE id=? AND company_id=? AND published=1",
                                 (job_id, company_id)).fetchone()
        if not job:
            raise ValueError("岗位不存在或不属于当前企业。")
        connection.execute("""INSERT INTO users
          (id,name,email,password_salt,password_hash,role,company_id,created_at)
          VALUES (?,?,?,?,?,'candidate',NULL,?)""",
          (user_id, candidate_name, f"hr-import-{user_id}@example.invalid", salt,
           _password_hash(secrets.token_urlsafe(32), salt), now))
        connection.execute("""INSERT INTO applications
          (id,candidate_id,job_id,status,resume_status,screening_status,verify_links,
           created_at,updated_at,source,uploaded_by)
          VALUES (?,?,?,'submitted','queued','queued',0,?,?,'hr_import',?)""",
          (app_id, user_id, job_id, now, now, uploader_id))
        connection.execute("""INSERT INTO resumes
          (application_id,original_name,content_type,file_path,sha256)
          VALUES (?,?,?,?,?)""", (app_id, file_name, content_type, file_path, sha256))
        connection.execute("INSERT INTO screenings (application_id) VALUES (?)", (app_id,))
        for item in attachments or []:
            connection.execute("""INSERT INTO application_attachments
              (id,application_id,original_name,content_type,sha256,size_bytes,content,created_at)
              VALUES (?,?,?,?,?,?,?,?)""",
              (_id(), app_id, item["name"], item["content_type"], item["sha256"],
               len(item["data"]), item["data"], now))
    return app_id


def list_attachments(app_id: str) -> list[dict]:
    with db() as connection:
        rows = connection.execute("""SELECT id,original_name,content_type,size_bytes,created_at
          FROM application_attachments WHERE application_id=? ORDER BY created_at,id""",
          (app_id,)).fetchall()
    return [{"id": row["id"], "name": row["original_name"],
             "contentType": row["content_type"], "sizeBytes": row["size_bytes"],
             "createdAt": row["created_at"]} for row in rows]


def get_attachment(app_id: str, attachment_id: str) -> dict | None:
    with db() as connection:
        row = connection.execute("""SELECT original_name,content_type,content
          FROM application_attachments WHERE application_id=? AND id=?""",
          (app_id, attachment_id)).fetchone()
    return dict(row) if row else None


def resume_source_counts(company_id: str) -> dict:
    with db() as connection:
        rows = connection.execute("""SELECT a.source, COUNT(*) AS count FROM applications a
          JOIN jobs j ON j.id=a.job_id WHERE j.company_id=? GROUP BY a.source""",
          (company_id,)).fetchall()
    counts = {row["source"]: row["count"] for row in rows}
    return {"total": sum(counts.values()), "candidatePortal": counts.get("candidate_portal", 0),
            "hrImport": counts.get("hr_import", 0)}


def _application_query(where: str, args: tuple) -> list[dict]:
    with db() as connection:
        rows = connection.execute(f"""SELECT a.*, j.title AS job_title,
          j.description AS job_description, j.company_id,
          j.screening_criteria AS job_criteria, j.criteria_updated_at AS job_criteria_updated_at,
          c.name AS company_name,
          u.name AS candidate_name, u.email AS candidate_email,
          uploader.name AS uploaded_by_name,
          r.original_name, r.content_type, r.file_path, r.raw_text, r.parsed_json, r.error AS resume_error,
          s.report_json, s.model, s.prompt_version, s.attempts,
          s.prompt_tokens, s.completion_tokens, s.error AS screening_error,
          v.id AS invitation_id, v.room_code, v.status AS invitation_status,
          v.sent_at AS invitation_sent_at, v.expires_at AS invitation_expires_at,
          v.accepted_at AS invitation_accepted_at, v.send_count AS invitation_send_count,
          v.last_sent_at AS invitation_last_sent_at, v.result_sent AS invitation_result_sent,
          hi.id AS human_id, hi.status AS human_status, hi.scheduled_at AS human_scheduled_at,
          hi.duration_minutes AS human_duration_minutes,
          hi.interviewer_name AS human_interviewer_name, hi.mode AS human_mode,
          hi.location AS human_location, hi.room_code AS human_room_code,
          hi.result AS human_result, hi.notes AS human_notes,
          hi.result_sent AS human_result_sent, hi.sent_at AS human_sent_at,
          hi.expires_at AS human_expires_at, hi.accepted_at AS human_accepted_at,
          hi.send_count AS human_send_count, hi.last_sent_at AS human_last_sent_at,
          rev.decision AS review_decision, rev.notes AS review_notes, rev.updated_at AS reviewed_at,
          (SELECT COUNT(*) FROM application_attachments att WHERE att.application_id=a.id) AS attachment_count
          FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN companies c ON c.id=j.company_id JOIN users u ON u.id=a.candidate_id
          LEFT JOIN users uploader ON uploader.id=a.uploaded_by
          JOIN resumes r ON r.application_id=a.id
          JOIN screenings s ON s.application_id=a.id
          LEFT JOIN invitations v ON v.application_id=a.id
          LEFT JOIN human_interviews hi ON hi.application_id=a.id
          LEFT JOIN reviews rev ON rev.application_id=a.id
          WHERE {where} ORDER BY a.created_at DESC""", args).fetchall()
    return [dict(row) for row in rows]


def get_application_by_id(app_id: str) -> dict | None:
    rows = _application_query("a.id=?", (app_id,))
    return rows[0] if rows else None


def _candidate_query(where: str, args: tuple) -> list[dict]:
    """Only select public status fields, never the internal report/review/contact."""
    with db() as connection:
        rows = connection.execute(f"""SELECT a.id, a.job_id, a.candidate_id,
          a.status, a.resume_status, a.screening_status, a.created_at, a.updated_at,
          j.title AS job_title, c.name AS company_name, r.error AS resume_error,
          v.id AS invitation_id, v.status AS invitation_status,
          v.sent_at AS invitation_sent_at, v.expires_at AS invitation_expires_at,
          v.accepted_at AS invitation_accepted_at, v.result_sent AS invitation_result_sent,
          hi.status AS human_status, hi.scheduled_at AS human_scheduled_at,
          hi.duration_minutes AS human_duration_minutes,
          hi.interviewer_name AS human_interviewer_name, hi.mode AS human_mode,
          hi.location AS human_location, hi.room_code AS human_room_code,
          hi.result AS human_result, hi.result_sent AS human_result_sent,
          hi.expires_at AS human_expires_at, hi.accepted_at AS human_accepted_at
          FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN companies c ON c.id=j.company_id
          JOIN resumes r ON r.application_id=a.id
          LEFT JOIN invitations v ON v.application_id=a.id
          LEFT JOIN human_interviews hi ON hi.application_id=a.id
          WHERE a.source='candidate_portal' AND ({where}) ORDER BY a.created_at DESC""", args).fetchall()
    return [dict(row) for row in rows]


def candidate_application(app_id: str, candidate_id: str) -> dict | None:
    rows = _candidate_query("a.id=? AND a.candidate_id=?", (app_id, candidate_id))
    return rows[0] if rows else None


def candidate_applications(candidate_id: str) -> list[dict]:
    return _candidate_query("a.candidate_id=?", (candidate_id,))


def candidate_interview_context(app_id: str, candidate_id: str) -> dict | None:
    """Candidate-owned job/resume context; never query screening or HR review."""
    with db() as connection:
        row = connection.execute("""SELECT a.id, a.status, v.id AS invitation_id,
          j.title AS job_title, j.description AS job_description,
          r.raw_text FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN resumes r ON r.application_id=a.id
          LEFT JOIN invitations v ON v.application_id=a.id
          WHERE a.id=? AND a.candidate_id=? AND a.source='candidate_portal'""",
          (app_id, candidate_id)).fetchone()
    return dict(row) if row else None


def hr_application(app_id: str, company_id: str) -> dict | None:
    rows = _application_query("a.id=? AND j.company_id=?", (app_id, company_id))
    return rows[0] if rows else None


def hr_applications(company_id: str, *, job_id: str | None = None,
                    status: str | None = None, manual_review: bool = False,
                    since: float | None = None) -> list[dict]:
    clauses = ["j.company_id=?"]
    args: list = [company_id]
    if job_id:
        clauses.append("j.id=?"); args.append(job_id)
    if status:
        clauses.append("a.status=?"); args.append(status)
    if manual_review:
        clauses.append("(a.screening_status='failed' OR rev.decision='verify' OR s.report_json LIKE '%manual_review%')")
    if since is not None:
        clauses.append("a.created_at>=?"); args.append(since)
    return _application_query(" AND ".join(clauses), tuple(args))


def claim_next_application() -> str | None:
    with db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT id FROM applications WHERE screening_status='queued'
          ORDER BY created_at LIMIT 1""").fetchone()
        if not row:
            return None
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited','closed')
          THEN status ELSE 'parsing' END, resume_status='parsing',
          screening_status='parsing', updated_at=? WHERE id=?""", (time.time(), row["id"]))
        return row["id"]


def save_parsed_resume(app_id: str, raw_text: str, parsed: dict) -> None:
    with db() as connection:
        connection.execute("UPDATE resumes SET raw_text=?, parsed_json=?, error=NULL WHERE application_id=?",
                           (raw_text, json.dumps(parsed, ensure_ascii=False), app_id))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited','closed')
          THEN status ELSE 'screening' END, resume_status='parsed',
          screening_status='screening', updated_at=? WHERE id=?""", (time.time(), app_id))


def save_resume_failure(app_id: str, error: str) -> None:
    with db() as connection:
        connection.execute("UPDATE resumes SET error=? WHERE application_id=?", (error, app_id))
        connection.execute("UPDATE screenings SET error=? WHERE application_id=?", ("简历解析失败", app_id))
        connection.execute("""UPDATE applications SET status='hr_review', resume_status='failed',
          screening_status='skipped', updated_at=? WHERE id=?""", (time.time(), app_id))


def save_evidence(app_id: str, items: list[dict]) -> None:
    with db() as connection:
        connection.execute("DELETE FROM external_evidence WHERE application_id=?", (app_id,))
        for item in items:
            connection.execute("""INSERT INTO external_evidence VALUES (?,?,?,?,?,?,?)""",
              (_id(), app_id, item["source"], item["url"], item["checkedAt"],
               item.get("relatedClaim"), item["verificationStatus"], item.get("details")))


def list_evidence(app_id: str) -> list[dict]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM external_evidence WHERE application_id=?",
                                  (app_id,)).fetchall()
    return [{"id": r["id"], "source": r["source"], "url": r["url"],
             "checkedAt": r["checked_at"], "relatedClaim": r["related_claim"],
             "verificationStatus": r["verification_status"], "details": r["details"]} for r in rows]


def add_correction(app_id: str, message: str) -> dict:
    item = {"id": _id(), "message": message, "createdAt": time.time()}
    with db() as connection:
        count = connection.execute("SELECT COUNT(*) FROM correction_requests WHERE application_id=?",
                                   (app_id,)).fetchone()[0]
        if count >= 3:
            raise ValueError("每份申请最多提交三次更正说明。")
        connection.execute("INSERT INTO correction_requests VALUES (?,?,?,?)",
                           (item["id"], app_id, message, item["createdAt"]))
    return item


def list_corrections(app_id: str) -> list[dict]:
    with db() as connection:
        rows = connection.execute("""SELECT id,message,created_at FROM correction_requests
          WHERE application_id=? ORDER BY created_at""", (app_id,)).fetchall()
    return [{"id": row["id"], "message": row["message"],
             "createdAt": row["created_at"]} for row in rows]


def formal_interview_summary(app_id: str) -> dict | None:
    """HR-only record of the formal interview; caller must check company scope."""
    with db() as connection:
        attempt = connection.execute("""SELECT attempt_id,status,started_at,completed_at,
          analysis_status,analysis_json,analysis_error,analysis_model
          FROM formal_interviews WHERE application_id=?""", (app_id,)).fetchone()
        if not attempt:
            return None
        answers = connection.execute("""SELECT question_id,prompt,answer,created_at
          FROM formal_answers WHERE attempt_id=? ORDER BY created_at""",
          (attempt["attempt_id"],)).fetchall()
    return {"status": attempt["status"], "startedAt": attempt["started_at"],
            "completedAt": attempt["completed_at"],
            "analysisStatus": attempt["analysis_status"],
            "analysis": json.loads(attempt["analysis_json"]) if attempt["analysis_json"] else None,
            "analysisError": attempt["analysis_error"], "analysisModel": attempt["analysis_model"],
            "answers": [{"questionId": item["question_id"], "prompt": item["prompt"],
                         "answer": item["answer"], "createdAt": item["created_at"]}
                        for item in answers]}


def claim_next_interview_analysis() -> str | None:
    with db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT application_id FROM formal_interviews
          WHERE status='completed' AND analysis_status='queued'
          ORDER BY completed_at LIMIT 1""").fetchone()
        if not row:
            return None
        connection.execute("""UPDATE formal_interviews SET analysis_status='processing',
          analysis_error=NULL WHERE application_id=?""", (row["application_id"],))
        return row["application_id"]


def interview_analysis_context(app_id: str) -> dict | None:
    with db() as connection:
        attempt = connection.execute("""SELECT f.attempt_id,j.title,j.description,r.raw_text
          FROM formal_interviews f JOIN applications a ON a.id=f.application_id
          JOIN jobs j ON j.id=a.job_id JOIN resumes r ON r.application_id=a.id
          WHERE f.application_id=? AND f.status='completed'""", (app_id,)).fetchone()
        if not attempt:
            return None
        answers = connection.execute("""SELECT question_id,prompt,answer FROM formal_answers
          WHERE attempt_id=? ORDER BY created_at""", (attempt["attempt_id"],)).fetchall()
    return {"jobTitle": attempt["title"], "jobDescription": attempt["description"],
            "resumeText": attempt["raw_text"] or "", "answers": [dict(item) for item in answers]}


def save_interview_analysis(app_id: str, report: dict, model: str) -> None:
    with db() as connection:
        connection.execute("""UPDATE formal_interviews SET analysis_status='completed',
          analysis_json=?,analysis_error=NULL,analysis_model=? WHERE application_id=?""",
          (json.dumps(report, ensure_ascii=False), model, app_id))


def save_interview_analysis_failure(app_id: str, error: str, model: str) -> None:
    with db() as connection:
        connection.execute("""UPDATE formal_interviews SET analysis_status='failed',
          analysis_error=?,analysis_model=? WHERE application_id=?""", (error[:180], model, app_id))


def requeue_interview_analysis(app_id: str) -> bool:
    with db() as connection:
        row = connection.execute("""SELECT status,analysis_status FROM formal_interviews
          WHERE application_id=?""", (app_id,)).fetchone()
        if not row or row["status"] != "completed" or row["analysis_status"] != "failed":
            return False
        connection.execute("""UPDATE formal_interviews SET analysis_status='queued',
          analysis_error=NULL WHERE application_id=?""", (app_id,))
    return True


def save_screening(app_id: str, report: dict, model: str, version: str,
                   attempts: int, prompt_tokens: int | None,
                   completion_tokens: int | None) -> None:
    with db() as connection:
        connection.execute("""UPDATE screenings SET report_json=?, model=?, prompt_version=?,
          attempts=?, prompt_tokens=?, completion_tokens=?, error=NULL, completed_at=?
          WHERE application_id=?""", (json.dumps(report, ensure_ascii=False), model, version,
                                    attempts, prompt_tokens, completion_tokens, time.time(), app_id))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited','closed')
          THEN status ELSE 'hr_review' END, screening_status='completed',
          updated_at=? WHERE id=?""", (time.time(), app_id))


def save_screening_failure(app_id: str, error: str, model: str, version: str,
                           attempts: int) -> None:
    with db() as connection:
        connection.execute("""UPDATE screenings SET model=?, prompt_version=?, attempts=?, error=?
          WHERE application_id=?""", (model, version, attempts, error, app_id))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited','closed')
          THEN status ELSE 'hr_review' END, screening_status='failed',
          updated_at=? WHERE id=?""", (time.time(), app_id))


def requeue_screening(app_id: str) -> bool:
    with db() as connection:
        row = connection.execute("SELECT screening_status,resume_status FROM applications WHERE id=?",
                                 (app_id,)).fetchone()
        if not row or row["screening_status"] != "failed" or row["resume_status"] != "parsed":
            return False
        connection.execute("UPDATE screenings SET error=NULL WHERE application_id=?", (app_id,))
        connection.execute("UPDATE applications SET screening_status='queued',updated_at=? WHERE id=?",
                           (time.time(), app_id))
    return True


def requeue_resume(app_id: str) -> bool:
    """Retry a failed PDF/DOCX extraction and its downstream screening."""
    with db() as connection:
        row = connection.execute("SELECT resume_status,screening_status FROM applications WHERE id=?",
                                 (app_id,)).fetchone()
        if not row or row["resume_status"] != "failed" or row["screening_status"] != "skipped":
            return False
        connection.execute("UPDATE resumes SET error=NULL WHERE application_id=?", (app_id,))
        connection.execute("UPDATE screenings SET error=NULL WHERE application_id=?", (app_id,))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited','closed')
          THEN status ELSE 'parsing' END, resume_status='queued', screening_status='queued',
          updated_at=? WHERE id=?""", (time.time(), app_id))
    return True


def upsert_review(app_id: str, reviewer_id: str, decision: str, notes: str,
                  status: str) -> None:
    now = time.time()
    with db() as connection:
        connection.execute("""INSERT INTO reviews VALUES (?,?,?,?,?)
          ON CONFLICT(application_id) DO UPDATE SET reviewer_id=excluded.reviewer_id,
          decision=excluded.decision, notes=excluded.notes, updated_at=excluded.updated_at""",
          (app_id, reviewer_id, decision, notes, now))
        connection.execute("UPDATE applications SET status=?, updated_at=? WHERE id=?",
                           (status, now, app_id))


def ensure_invitation(app_id: str) -> dict:
    """一申请一条 AI 初面邀请；重复调用返回同一条（历史行为）。"""
    now = time.time()
    with db() as connection:
        connection.execute("""INSERT OR IGNORE INTO invitations
          (id,application_id,room_code,status,created_at,updated_at,
           sent_at,expires_at,send_count,last_sent_at,result_sent)
          VALUES (?,?,NULL,'invited',?,?,?,?,1,?,0)""",
          (_id(), app_id, now, now, now, now + _invite_seconds("AI_INVITE_DAYS", 7), now))
        row = connection.execute("SELECT * FROM invitations WHERE application_id=?", (app_id,)).fetchone()
    return dict(row)


def resend_invitation(app_id: str, days: int | None = None) -> dict | None:
    """重发 AI 初面邀请：顺延有效期并计数，不产生第二条记录。"""
    now = time.time()
    with db() as connection:
        row = connection.execute("SELECT * FROM invitations WHERE application_id=?",
                                 (app_id,)).fetchone()
        if not row or row["status"] == "completed":
            return None
        base = max(now, float(row["expires_at"] or now))
        connection.execute("""UPDATE invitations SET sent_at=?, last_sent_at=?,
          expires_at=?, send_count=COALESCE(send_count,1)+1, updated_at=?
          WHERE application_id=?""",
          (now, now, base + (days or _days_env("AI_INVITE_DAYS", 7)) * 86400.0, now, app_id))
        row = connection.execute("SELECT * FROM invitations WHERE application_id=?",
                                 (app_id,)).fetchone()
    return dict(row)


def set_ai_result_sent(app_id: str, visible: bool) -> bool:
    with db() as connection:
        cursor = connection.execute("""UPDATE invitations SET result_sent=?, updated_at=?
          WHERE application_id=?""", (1 if visible else 0, time.time(), app_id))
    return cursor.rowcount > 0


def set_application_status(app_id: str, status: str) -> None:
    with db() as connection:
        connection.execute("UPDATE applications SET status=?, updated_at=? WHERE id=?",
                           (status, time.time(), app_id))


def set_invitation_room(app_id: str, room_code: str) -> None:
    with db() as connection:
        connection.execute("UPDATE invitations SET room_code=?, updated_at=? WHERE application_id=?",
                           (room_code, time.time(), app_id))


def mark_interview_in_progress(app_id: str) -> None:
    now = time.time()
    with db() as connection:
        connection.execute("""UPDATE invitations SET status='in_progress',updated_at=?,
          accepted_at=COALESCE(accepted_at,?) WHERE application_id=? AND status!='completed'""",
          (now, now, app_id))
        connection.execute("""UPDATE applications SET status='ai_interview_in_progress',updated_at=?
          WHERE id=? AND status='ai_interview_invited'""", (now, app_id))


def mark_interview_completed(app_id: str) -> None:
    """AI 初面房间结束后收口。真人面试阶段与已结束的申请不回退。"""
    with db() as connection:
        row = connection.execute("SELECT status FROM applications WHERE id=?",
                                 (app_id,)).fetchone()
        if not row or row["status"] in ("hr_interview_invited", "closed"):
            return
        now = time.time()
        connection.execute("UPDATE invitations SET status='completed',updated_at=? WHERE application_id=?",
                           (now, app_id))
        connection.execute("UPDATE applications SET status='ai_interview_completed',updated_at=? WHERE id=?",
                           (now, app_id))


# ---------- 真人面试 ----------
def upsert_human_interview(app_id: str, *, scheduled_at: float,
                           duration_minutes: int, interviewer_name: str,
                           mode: str, location: str | None = None,
                           room_code: str | None = None, days: int | None = None) -> dict:
    """安排/改期真人面试。已有记录就地更新，不新建第二行。"""
    now = time.time()
    expires = max(now, scheduled_at) + (days or _days_env("HUMAN_INVITE_DAYS", 3)) * 86400.0
    with db() as connection:
        row = connection.execute("SELECT id FROM human_interviews WHERE application_id=?",
                                 (app_id,)).fetchone()
        if row:
            connection.execute("""UPDATE human_interviews SET status='invited',
              scheduled_at=?, duration_minutes=?, interviewer_name=?, mode=?, location=?,
              room_code=COALESCE(?,room_code), sent_at=?, last_sent_at=?, expires_at=?,
              accepted_at=NULL, send_count=COALESCE(send_count,1)+1, updated_at=?
              WHERE application_id=?""",
              (scheduled_at, duration_minutes, interviewer_name, mode, location,
               room_code, now, now, expires, now, app_id))
        else:
            connection.execute("""INSERT INTO human_interviews
              (application_id,id,status,scheduled_at,duration_minutes,interviewer_name,
               mode,location,room_code,sent_at,expires_at,send_count,last_sent_at,
               created_at,updated_at)
              VALUES (?,?,'invited',?,?,?,?,?,?,?,?,1,?,?,?)""",
              (app_id, _id(), scheduled_at, duration_minutes, interviewer_name,
               mode, location, room_code, now, expires, now, now, now))
        row = connection.execute("SELECT * FROM human_interviews WHERE application_id=?",
                                 (app_id,)).fetchone()
    return dict(row)


def human_expiry(scheduled_at: float, days: int | None = None) -> float:
    """真人面试邀请的失效时间：面试时间之后 N 天（默认 3）。"""
    return max(time.time(), float(scheduled_at or 0)) + \
        (days or _days_env("HUMAN_INVITE_DAYS", 3)) * 86400.0


def _human_row(app_id: str) -> dict | None:
    with db() as connection:
        row = connection.execute("SELECT * FROM human_interviews WHERE application_id=?",
                                 (app_id,)).fetchone()
    return dict(row) if row else None


def update_human_interview(app_id: str, **fields) -> dict | None:
    """只更新传入的字段；None 表示不改。"""
    allowed = ("scheduled_at", "duration_minutes", "interviewer_name", "mode",
               "location", "room_code", "expires_at")
    values = {key: value for key, value in fields.items() if key in allowed and value is not None}
    if not values:
        return _human_row(app_id)
    assignments = ", ".join(f"{key}=?" for key in values)
    with db() as connection:
        connection.execute(f"UPDATE human_interviews SET {assignments}, updated_at=? WHERE application_id=?",
                           (*values.values(), time.time(), app_id))
    return _human_row(app_id)


def mark_human_interview_accepted(app_id: str) -> None:
    now = time.time()
    with db() as connection:
        connection.execute("""UPDATE human_interviews SET status='accepted',
          accepted_at=COALESCE(accepted_at,?),updated_at=?
          WHERE application_id=? AND status IN ('invited','accepted')""",
          (now, now, app_id))


def set_human_interview_result(app_id: str, result: str, notes: str,
                               result_sent: bool) -> dict | None:
    now = time.time()
    with db() as connection:
        connection.execute("""UPDATE human_interviews SET status='completed',result=?,
          notes=?,result_sent=?,updated_at=? WHERE application_id=?""",
          (result, notes, 1 if result_sent else 0, now, app_id))
    return _human_row(app_id)


def set_human_result_sent(app_id: str, visible: bool) -> bool:
    with db() as connection:
        cursor = connection.execute("""UPDATE human_interviews SET result_sent=?,updated_at=?
          WHERE application_id=? AND result IS NOT NULL""",
          (1 if visible else 0, time.time(), app_id))
    return cursor.rowcount > 0


def resend_human_interview(app_id: str, days: int | None = None) -> dict | None:
    now = time.time()
    with db() as connection:
        row = connection.execute("SELECT * FROM human_interviews WHERE application_id=?",
                                 (app_id,)).fetchone()
        if not row or row["status"] == "completed":
            return None
        base = max(now, float(row["expires_at"] or now))
        connection.execute("""UPDATE human_interviews SET sent_at=?,last_sent_at=?,
          expires_at=?,send_count=COALESCE(send_count,1)+1,status='invited',
          accepted_at=NULL,updated_at=? WHERE application_id=?""",
          (now, now, base + (days or _days_env("HUMAN_INVITE_DAYS", 3)) * 86400.0, now, app_id))
        row = connection.execute("SELECT * FROM human_interviews WHERE application_id=?",
                                 (app_id,)).fetchone()
    return dict(row)


# ---------- 面试间报告归档 ----------
def archive_interview_report(app_id: str, session_id: str, report: dict) -> None:
    with db() as connection:
        connection.execute("""INSERT INTO interview_reports
          (application_id,session_id,report_json,archived_at) VALUES (?,?,?,?)
          ON CONFLICT(application_id) DO UPDATE SET session_id=excluded.session_id,
          report_json=excluded.report_json, archived_at=excluded.archived_at""",
          (app_id, session_id, json.dumps(report, ensure_ascii=False), time.time()))


def interview_report(app_id: str) -> dict | None:
    with db() as connection:
        row = connection.execute("SELECT * FROM interview_reports WHERE application_id=?",
                                 (app_id,)).fetchone()
    if not row:
        return None
    try:
        report = json.loads(row["report_json"])
    except ValueError:
        return None
    return {"sessionId": row["session_id"], "archivedAt": row["archived_at"], "report": report}


# ---------- 邀请记录 ----------
def list_invitations(company_id: str) -> list[dict]:
    """邀请记录：AI 初面与真人面试合并，状态在读取时计算（过期不靠定时任务）。"""
    with db() as connection:
        ai_rows = connection.execute("""SELECT v.id, v.application_id, v.status,
          v.created_at, v.sent_at, v.expires_at, v.accepted_at, v.send_count,
          v.last_sent_at, v.result_sent, j.title AS job_title, u.name AS candidate_name
          FROM invitations v JOIN applications a ON a.id=v.application_id
          JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.candidate_id
          WHERE j.company_id=? ORDER BY v.created_at DESC""", (company_id,)).fetchall()
        human_rows = connection.execute("""SELECT h.id, h.application_id, h.status,
          h.created_at, h.sent_at, h.expires_at, h.accepted_at, h.send_count,
          h.last_sent_at, h.result_sent, h.scheduled_at, h.interviewer_name, h.mode,
          h.result, j.title AS job_title, u.name AS candidate_name
          FROM human_interviews h JOIN applications a ON a.id=h.application_id
          JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.candidate_id
          WHERE j.company_id=? ORDER BY h.created_at DESC""", (company_id,)).fetchall()
    items = [{"id": row["id"], "applicationId": row["application_id"], "kind": "ai",
              "candidateName": row["candidate_name"], "jobTitle": row["job_title"],
              "status": row["status"], "sentAt": row["sent_at"],
              "expiresAt": row["expires_at"], "acceptedAt": row["accepted_at"],
              "lastSentAt": row["last_sent_at"], "sendCount": row["send_count"],
              "resultSent": bool(row["result_sent"]), "scheduledAt": None,
              "interviewerName": None, "mode": None, "result": None}
             for row in ai_rows]
    items += [{"id": row["id"], "applicationId": row["application_id"], "kind": "human",
               "candidateName": row["candidate_name"], "jobTitle": row["job_title"],
               "status": row["status"], "sentAt": row["sent_at"],
               "expiresAt": row["expires_at"], "acceptedAt": row["accepted_at"],
               "lastSentAt": row["last_sent_at"], "sendCount": row["send_count"],
               "resultSent": bool(row["result_sent"]), "scheduledAt": row["scheduled_at"],
               "interviewerName": row["interviewer_name"], "mode": row["mode"],
               "result": row["result"]}
              for row in human_rows]
    items.sort(key=lambda item: item["sentAt"] or 0, reverse=True)
    return items


def delete_application(app_id: str) -> None:
    with db() as connection:
        row = connection.execute("SELECT file_path FROM resumes WHERE application_id=?", (app_id,)).fetchone()
        application = connection.execute("SELECT candidate_id,source FROM applications WHERE id=?",
                                         (app_id,)).fetchone()
        connection.execute("DELETE FROM applications WHERE id=?", (app_id,))
        if application and application["source"] == "hr_import":
            connection.execute("""DELETE FROM users WHERE id=? AND NOT EXISTS
              (SELECT 1 FROM applications WHERE candidate_id=?)""",
              (application["candidate_id"], application["candidate_id"]))
    if row:
        Path(row["file_path"]).unlink(missing_ok=True)


def cleanup_expired() -> int:
    try:
        days = max(1, int(os.getenv("RECRUITMENT_RETENTION_DAYS", "365")))
    except ValueError:
        days = 365
    cutoff = time.time() - days * 86400
    with db() as connection:
        rows = connection.execute("SELECT id FROM applications WHERE created_at<?", (cutoff,)).fetchall()
        connection.execute("DELETE FROM auth_tokens WHERE expires_at<?", (time.time(),))
    for row in rows:
        delete_application(row["id"])
    return len(rows)
