"""HR name repair preserves the original resume and application history."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")

from fastapi.testclient import TestClient
import app as main
from candidate import recruitment_architect_store as architect
from candidate import recruitment_store as repo
from candidate.recruitment_resume import valid_candidate_name


class CandidateNameCorrectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": self.temp.name})
        env.start()
        self.addCleanup(env.stop)
        repo.init_db()
        architect.init_db()
        self.hr = repo.create_user("HR", "name-hr@example.test", "safe password 123",
                                   "hr", "姓名修复企业")
        self.other = repo.create_user("Other", "name-other@example.test", "safe password 123",
                                      "hr", "其他企业")
        self.job = repo.create_job(self.hr["companyId"], "分析师", "负责分析项目与业务成果")
        self.client = TestClient(main.app)
        self.auth = {"Authorization": "Bearer " + repo.issue_token(self.hr["id"])}
        self.other_auth = {"Authorization": "Bearer " + repo.issue_token(self.other["id"])}

    def imported(self, initial_name: str) -> tuple[str, Path, bytes]:
        original = b"%PDF-1.4\noriginal resume bytes\n%%EOF"
        path = Path(self.temp.name) / (hashlib.sha256(initial_name.encode()).hexdigest() + ".pdf")
        path.write_bytes(original)
        app_id = repo.create_hr_import(self.hr["companyId"], self.hr["id"],
                                       self.job["id"], initial_name, "candidate.pdf",
                                       "application/pdf", str(path), hashlib.sha256(original).hexdigest())
        repo.save_parsed_resume(app_id, "原始简历文字 张三", {"name": initial_name, "rawText": "原始简历文字 张三"})
        with repo.db() as db:
            db.execute("UPDATE screenings SET report_json=? WHERE application_id=?",
                       (json.dumps({"candidateProfile": {"name": initial_name},
                                    "jobMatch": {"score": 0},
                                    "screeningRecommendation": "manual_review"}), app_id))
        return app_id, path, original

    def test_legacy_bad_names_display_pending_then_hr_correction_persists(self):
        for bad in ("3", "table[[221, 103, 847, 181]]", "www"):
            with self.subTest(bad=bad):
                self.assertIsNone(valid_candidate_name(bad))
                app_id, path, original = self.imported(bad)
                url = f"/api/hr/applications/{app_id}"
                before = self.client.get(url, headers=self.auth)
                self.assertEqual(before.status_code, 200, before.text)
                self.assertEqual(before.json()["candidateName"], "姓名待确认")
                forbidden = self.client.patch(url + "/candidate-name",
                                              headers=self.other_auth, json={"name": "李华"})
                self.assertEqual(forbidden.status_code, 404)
                invalid = self.client.patch(url + "/candidate-name",
                                            headers=self.auth, json={"name": bad})
                self.assertEqual(invalid.status_code, 422)
                fixed = self.client.patch(url + "/candidate-name",
                                          headers=self.auth, json={"name": "李华"})
                self.assertEqual(fixed.status_code, 200, fixed.text)
                self.assertEqual(fixed.json()["candidateName"], "李华")
                detail = self.client.get(url, headers=self.auth).json()
                self.assertEqual(detail["candidateName"], "李华")
                self.assertEqual(len(detail["nameCorrections"]), 1)
                self.assertEqual(detail["nameCorrections"][0]["previousName"], bad)
                self.assertEqual(detail["parsedResume"]["name"], bad)
                self.assertEqual(path.read_bytes(), original)
                with repo.db() as db:
                    saved = db.execute("SELECT sha256,raw_text FROM resumes WHERE application_id=?",
                                       (app_id,)).fetchone()
                self.assertEqual(saved["sha256"], hashlib.sha256(original).hexdigest())
                self.assertEqual(saved["raw_text"], "原始简历文字 张三")
                repo.save_parsed_resume(app_id, "原始简历文字 张三", {"name": "另一个人"})
                self.assertEqual(self.client.get(url, headers=self.auth).json()["candidateName"], "李华")
                duplicate = self.client.patch(url + "/candidate-name",
                                              headers=self.auth, json={"name": "李华"})
                self.assertTrue(duplicate.json()["unchanged"])
                self.assertEqual(len(repo.list_candidate_name_corrections(app_id)), 1)

    def test_candidate_portal_account_name_is_unchanged(self):
        candidate = repo.create_user("账户姓名", "name-candidate@example.test",
                                     "safe password 123", "candidate")
        path = Path(self.temp.name) / "portal.pdf"
        path.write_bytes(b"%PDF-1.4\nresume\n%%EOF")
        app_id = repo.create_application(candidate["id"], self.job["id"], "portal.pdf",
                                         "application/pdf", str(path), "fixture", False)
        response = self.client.patch(f"/api/hr/applications/{app_id}/candidate-name",
                                     headers=self.auth, json={"name": "王五"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(repo.get_user_for_token(repo.issue_token(candidate["id"]))["name"], "账户姓名")
        self.assertEqual(self.client.get(f"/api/hr/applications/{app_id}",
                                         headers=self.auth).json()["candidateName"], "王五")


if __name__ == "__main__":
    unittest.main()
