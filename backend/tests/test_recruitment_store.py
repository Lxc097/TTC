"""Persistence and tenant-boundary tests for recruitment records."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")

from candidate import recruitment_store as store  # noqa: E402


class RecruitmentStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory.name})
        env.start()
        self.addCleanup(env.stop)
        store.init_db()
        self.candidate = store.create_user("Candidate", "candidate@example.test",
                                           "password-123", "candidate")
        self.other_candidate = store.create_user("Other", "other@example.test",
                                                 "password-456", "candidate")
        self.hr = store.create_user("HR One", "hr-one@example.test",
                                    "password-789", "hr", "Company One")
        self.other_hr = store.create_user("HR Two", "hr-two@example.test",
                                          "password-abc", "hr", "Company Two")
        self.job = store.create_job(self.hr["companyId"], "Frontend Engineer",
                                    "Build React and TypeScript interfaces")
        self.application_id = store.create_application(
            self.candidate["id"], self.job["id"], "resume.pdf",
            "application/pdf", str(Path(directory.name) / "resume.pdf"), "abc123", False,
        )

    def test_tokens_and_passwords_are_not_stored_plaintext(self) -> None:
        token = store.issue_token(self.candidate["id"])
        self.assertEqual(store.get_user_for_token(token)["id"], self.candidate["id"])
        with store.db() as connection:
            user = connection.execute("SELECT password_hash FROM users WHERE id=?",
                                      (self.candidate["id"],)).fetchone()
            stored = connection.execute("SELECT token_hash FROM auth_tokens").fetchone()
        self.assertNotEqual(user["password_hash"], "password-123")
        self.assertNotEqual(stored["token_hash"], token)
        self.assertIsNone(store.get_user_for_token("invalid-token"))

    def test_queries_enforce_candidate_and_company_scope(self) -> None:
        self.assertIsNotNone(store.candidate_application(self.application_id, self.candidate["id"]))
        self.assertIsNone(store.candidate_application(self.application_id, self.other_candidate["id"]))
        self.assertEqual(len(store.candidate_applications(self.other_candidate["id"])), 0)
        self.assertIsNotNone(store.hr_application(self.application_id, self.hr["companyId"]))
        self.assertIsNone(store.hr_application(self.application_id, self.other_hr["companyId"]))
        self.assertEqual(len(store.hr_applications(self.other_hr["companyId"])), 0)

    def test_duplicate_application_and_invitation_are_bounded(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            store.create_application(self.candidate["id"], self.job["id"],
                                     "second.pdf", "application/pdf", "/tmp/second.pdf",
                                     "def456", False)
        first = store.ensure_invitation(self.application_id)
        second = store.ensure_invitation(self.application_id)
        self.assertEqual(first["id"], second["id"])
        with store.db() as connection:
            count = connection.execute("SELECT COUNT(*) FROM invitations").fetchone()[0]
        self.assertEqual(count, 1)

    def test_interrupted_screening_is_requeued_on_startup(self) -> None:
        self.assertEqual(store.claim_next_application(), self.application_id)
        store.save_parsed_resume(self.application_id, "React engineer",
                                 {"rawText": "React engineer"})
        self.assertEqual(store.get_application_by_id(self.application_id)["screening_status"],
                         "screening")
        store.init_db()
        row = store.get_application_by_id(self.application_id)
        self.assertEqual(row["screening_status"], "queued")
        self.assertEqual(row["status"], "submitted")

    def test_hr_import_counts_and_cleanup(self) -> None:
        path = store.data_dir() / "imported.pdf"
        path.write_bytes(b"%PDF-fixture")
        imported_id = store.create_hr_import(self.hr["companyId"], self.hr["id"],
            self.job["id"], "Imported Candidate", "imported.pdf", "application/pdf",
            str(path), "def456")
        with store.db() as connection:
            imported_user = connection.execute("SELECT candidate_id FROM applications WHERE id=?",
                                               (imported_id,)).fetchone()[0]
        self.assertIsNone(store.candidate_application(imported_id, imported_user))
        self.assertEqual(store.hr_application(imported_id, self.hr["companyId"])["source"], "hr_import")
        self.assertEqual(store.resume_source_counts(self.hr["companyId"]),
                         {"total": 2, "candidatePortal": 1, "hrImport": 1})
        self.assertEqual(store.resume_source_counts(self.other_hr["companyId"])["total"], 0)
        store.delete_application(imported_id)
        self.assertFalse(path.exists())
        with store.db() as connection:
            self.assertIsNone(connection.execute("SELECT id FROM users WHERE id=?",
                                                 (imported_user,)).fetchone())

    def test_existing_database_adds_resume_source_columns(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory}):
                connection = sqlite3.connect(Path(directory) / "recruitment.sqlite3")
                connection.execute("""CREATE TABLE applications (
                  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES users(id),
                  job_id TEXT NOT NULL REFERENCES jobs(id), status TEXT NOT NULL,
                  resume_status TEXT NOT NULL, screening_status TEXT NOT NULL,
                  verify_links INTEGER NOT NULL DEFAULT 0,
                  created_at REAL NOT NULL, updated_at REAL NOT NULL,
                  UNIQUE(candidate_id, job_id))""")
                connection.commit()
                connection.close()
                store.init_db()
                with store.db() as migrated:
                    columns = {row[1] for row in migrated.execute("PRAGMA table_info(applications)")}
                self.assertTrue({"source", "uploaded_by"}.issubset(columns))


if __name__ == "__main__":
    unittest.main()
