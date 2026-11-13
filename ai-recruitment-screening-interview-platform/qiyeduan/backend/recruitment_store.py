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
          UNIQUE(candidate_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS resumes (
          application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL, content_type TEXT NOT NULL, file_path TEXT NOT NULL,
          sha256 TEXT NOT NULL, raw_text TEXT, parsed_json TEXT, error TEXT
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
        CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id, created_at);
        CREATE INDEX IF NOT EXISTS applications_queue_idx ON applications(screening_status, created_at);
        """)
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


def create_job(company_id: str, title: str, description: str) -> dict:
    job = {"id": _id(), "companyId": company_id, "title": title,
           "description": description, "createdAt": time.time()}
    with db() as connection:
        connection.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?)",
                           (job["id"], company_id, title, description, 1, job["createdAt"]))
    return job


def list_jobs(company_id: str | None = None) -> list[dict]:
    where = "AND jobs.company_id=?" if company_id else ""
    args = (company_id,) if company_id else ()
    with db() as connection:
        rows = connection.execute(f"""SELECT jobs.*, companies.name AS company_name
          FROM jobs JOIN companies ON companies.id=jobs.company_id
          WHERE jobs.published=1 {where} ORDER BY jobs.created_at DESC""", args).fetchall()
    return [{"id": r["id"], "title": r["title"], "description": r["description"],
             "companyName": r["company_name"], "companyId": r["company_id"],
             "createdAt": r["created_at"]} for r in rows]


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
        connection.execute("""INSERT INTO applications VALUES (?,?,?,?,?,?,?,?,?)""",
          (app_id, candidate_id, job_id, "submitted", "queued", "queued", int(verify_links), now, now))
        connection.execute("""INSERT INTO resumes
          (application_id,original_name,content_type,file_path,sha256)
          VALUES (?,?,?,?,?)""", (app_id, file_name, content_type, file_path, sha256))
        connection.execute("INSERT INTO screenings (application_id) VALUES (?)", (app_id,))
    return app_id


def _application_query(where: str, args: tuple) -> list[dict]:
    with db() as connection:
        rows = connection.execute(f"""SELECT a.*, j.title AS job_title,
          j.description AS job_description, j.company_id, c.name AS company_name,
          u.name AS candidate_name, u.email AS candidate_email,
          r.original_name, r.content_type, r.file_path, r.raw_text, r.parsed_json, r.error AS resume_error,
          s.report_json, s.model, s.prompt_version, s.attempts,
          s.prompt_tokens, s.completion_tokens, s.error AS screening_error,
          v.id AS invitation_id, v.room_code, v.status AS invitation_status,
          rev.decision AS review_decision, rev.notes AS review_notes, rev.updated_at AS reviewed_at
          FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN companies c ON c.id=j.company_id JOIN users u ON u.id=a.candidate_id
          JOIN resumes r ON r.application_id=a.id
          JOIN screenings s ON s.application_id=a.id
          LEFT JOIN invitations v ON v.application_id=a.id
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
          v.id AS invitation_id, v.status AS invitation_status
          FROM applications a JOIN jobs j ON j.id=a.job_id
          JOIN companies c ON c.id=j.company_id
          JOIN resumes r ON r.application_id=a.id
          LEFT JOIN invitations v ON v.application_id=a.id
          WHERE {where} ORDER BY a.created_at DESC""", args).fetchall()
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
          WHERE a.id=? AND a.candidate_id=?""", (app_id, candidate_id)).fetchone()
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
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited')
          THEN status ELSE 'parsing' END, resume_status='parsing',
          screening_status='parsing', updated_at=? WHERE id=?""", (time.time(), row["id"]))
        return row["id"]


def save_parsed_resume(app_id: str, raw_text: str, parsed: dict) -> None:
    with db() as connection:
        connection.execute("UPDATE resumes SET raw_text=?, parsed_json=?, error=NULL WHERE application_id=?",
                           (raw_text, json.dumps(parsed, ensure_ascii=False), app_id))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited')
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
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited')
          THEN status ELSE 'hr_review' END, screening_status='completed',
          updated_at=? WHERE id=?""", (time.time(), app_id))


def save_screening_failure(app_id: str, error: str, model: str, version: str,
                           attempts: int) -> None:
    with db() as connection:
        connection.execute("""UPDATE screenings SET model=?, prompt_version=?, attempts=?, error=?
          WHERE application_id=?""", (model, version, attempts, error, app_id))
        connection.execute("""UPDATE applications SET status=CASE WHEN status IN
          ('ai_interview_invited','ai_interview_in_progress','ai_interview_completed','hr_interview_invited')
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
    now = time.time()
    with db() as connection:
        connection.execute("""INSERT OR IGNORE INTO invitations VALUES (?,?,?,?,?,?)""",
                           (_id(), app_id, None, "invited", now, now))
        row = connection.execute("SELECT * FROM invitations WHERE application_id=?", (app_id,)).fetchone()
    return dict(row)


def set_invitation_room(app_id: str, room_code: str) -> None:
    with db() as connection:
        connection.execute("UPDATE invitations SET room_code=?, updated_at=? WHERE application_id=?",
                           (room_code, time.time(), app_id))


def mark_interview_in_progress(app_id: str) -> None:
    with db() as connection:
        connection.execute("UPDATE invitations SET status='in_progress',updated_at=? WHERE application_id=? AND status!='completed'",
                           (time.time(), app_id))
        connection.execute("""UPDATE applications SET status='ai_interview_in_progress',updated_at=?
          WHERE id=? AND status='ai_interview_invited'""", (time.time(), app_id))


def mark_interview_completed(app_id: str) -> None:
    with db() as connection:
        connection.execute("UPDATE invitations SET status='completed',updated_at=? WHERE application_id=?",
                           (time.time(), app_id))
        connection.execute("UPDATE applications SET status='ai_interview_completed',updated_at=? WHERE id=?",
                           (time.time(), app_id))


def delete_application(app_id: str) -> None:
    with db() as connection:
        row = connection.execute("SELECT file_path FROM resumes WHERE application_id=?", (app_id,)).fetchone()
        connection.execute("DELETE FROM applications WHERE id=?", (app_id,))
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
