"""Authenticated submission -> screening -> HR review -> interview handoff."""
from __future__ import annotations

import os
import io
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")

from fastapi.testclient import TestClient  # noqa: E402
import app as main  # noqa: E402
from candidate import recruitment_api  # noqa: E402
from candidate.resume_screening_service import ScreeningError  # noqa: E402

PDF = (Path(__file__).resolve().parent / "fixtures" / "candidate.pdf").read_bytes()
REPORT = {
    "candidateSummary": "简历提到前端缓存优化，具体贡献待面试核实。",
    "jobMatch": {"score": 68, "scoreBasis": "React 项目经历与岗位要求相关；其他能力证据不足。",
                 "matchedRequirements": ["React"], "missingRequirements": ["可访问性"],
                 "evidence": [{"requirement": "React", "sourceText": "React",
                               "support": "简历原文提及 React。"}]},
    "resumeClaims": [{"claim": "优化缓存", "sourceText": "React cache invalidation",
                      "verificationStatus": "unverified", "confidence": None,
                      "supportingEvidence": [],
                      "followUpQuestion": "如何验证缓存失效策略的结果？"}],
    "strengths": ["有前端项目经验"], "areasToVerify": ["缓存优化的个人贡献"],
    "interviewQuestions": ["请解释你如何设计 React 缓存失效策略。"],
    "screeningRecommendation": "manual_review",
    "recommendationReasons": ["经历相关，但缺少独立验证材料。"],
    "limitations": ["未进行外部核验。"],
}
META = {"model": "fixture/deepseek", "promptVersion": "test-fixture",
        "attempts": 1, "promptTokens": 12, "completionTokens": 34}


class RecruitmentApiTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {
            "RECRUITMENT_DATA_DIR": directory.name,
            "HR_REGISTRATION_CODE": "local-test-only-code",
            "SILICONFLOW_API_KEY": "local-test-only-key",
        })
        env.start()
        self.addCleanup(env.stop)
        screening = patch.object(recruitment_api, "screen_resume", return_value=(REPORT, META))
        screening.start()
        self.addCleanup(screening.stop)
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def register(self, name: str, email: str, role: str = "candidate",
                 company: str | None = None) -> dict:
        payload = {"name": name, "email": email, "password": "safe-password-123",
                   "role": role}
        if role == "hr":
            payload.update({"companyName": company, "hrRegistrationCode": "local-test-only-code"})
        response = self.client.post("/api/auth/register", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    @staticmethod
    def auth(account: dict) -> dict:
        return {"Authorization": "Bearer " + account["token"]}

    def create_job(self, hr: dict) -> dict:
        response = self.client.post("/api/hr/jobs", headers=self.auth(hr), json={
            "title": "前端工程师",
            "description": "负责 React 与 TypeScript 产品开发、页面性能、可访问性和团队协作，能解释方案权衡并展示实际项目证据。",
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def submit(self, candidate: dict, job_id: str, data: bytes = PDF,
               filename: str = "candidate.pdf", consent: str = "true"):
        return self.client.post("/api/applications", headers=self.auth(candidate),
            data={"jobId": job_id, "consent": consent},
            files={"resume": (filename, data, "application/pdf")})

    def wait_for_screening(self, hr: dict, app_id: str, expected: str) -> dict:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            response = self.client.get(f"/api/hr/applications/{app_id}", headers=self.auth(hr))
            self.assertEqual(response.status_code, 200, response.text)
            detail = response.json()
            if detail["screeningStatus"] == expected:
                return detail
            time.sleep(0.1)
        self.fail(f"screening never reached {expected}; last detail: {detail}")

    def test_submission_screening_isolation_and_invite_are_end_to_end(self) -> None:
        candidate = self.register("Candidate", "candidate@example.test")
        other_candidate = self.register("Other", "other@example.test")
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other_hr = self.register("Other HR", "other-hr@example.test", "hr", "Company Two")
        duplicate_company = self.client.post("/api/auth/register", json={
            "name": "Imposter", "email": "imposter@example.test",
            "password": "safe-password-123", "role": "hr",
            "companyName": "Company One", "hrRegistrationCode": "local-test-only-code",
        })
        self.assertEqual(duplicate_company.status_code, 409)
        job = self.create_job(hr)
        self.assertEqual(len(self.client.get("/api/jobs").json()["items"]), 1)

        submission = self.submit(candidate, job["id"])
        self.assertEqual(submission.status_code, 202, submission.text)
        app_id = submission.json()["application"]["id"]
        self.assertNotIn("screening", submission.json()["application"])
        detail = self.wait_for_screening(hr, app_id, "completed")
        self.assertEqual(detail["status"], "hr_review")
        self.assertIn("React", detail["parsedResume"]["rawText"])
        self.assertEqual(detail["screening"]["jobMatch"]["score"], 68)
        self.assertEqual(detail["screeningMeta"]["model"], "fixture/deepseek")
        self.assertEqual(self.client.get(f"/api/hr/applications/{app_id}/resume",
                         headers=self.auth(hr)).content, PDF)

        safe = self.client.get(f"/api/applications/{app_id}", headers=self.auth(candidate))
        self.assertEqual(safe.status_code, 200, safe.text)
        self.assertEqual(safe.json()["status"], "hr_review")
        for private in ("screening", "screeningMeta", "matchScore", "recommendation",
                        "parsedResume", "review", "candidateEmail", "evidence"):
            self.assertNotIn(private, safe.json())
        own_items = self.client.get("/api/applications/my",
                                    headers=self.auth(candidate)).json()["items"]
        self.assertEqual(len(own_items), 1)
        self.assertNotIn("screening", own_items[0])
        self.assertNotIn("screeningMeta", own_items[0])
        self.assertEqual(self.client.get(f"/api/applications/{app_id}",
                         headers=self.auth(other_candidate)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/hr/applications/{app_id}",
                         headers=self.auth(other_hr)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/hr/applications/{app_id}/resume",
                         headers=self.auth(other_hr)).status_code, 404)
        self.assertEqual(self.client.get("/api/hr/applications",
                         headers=self.auth(candidate)).status_code, 403)

        correction_path = f"/api/applications/{app_id}/corrections"
        denied_correction = self.client.post(correction_path, headers=self.auth(other_candidate),
                                             json={"message": "我没有权利修改这份申请"})
        self.assertEqual(denied_correction.status_code, 404)
        correction = self.client.post(correction_path, headers=self.auth(candidate),
                                      json={"message": "我的缓存项目负责范围是前端状态同步。"})
        self.assertIn(correction.status_code, (200, 201), correction.text)
        hr_after_correction = self.client.get(f"/api/hr/applications/{app_id}",
                                              headers=self.auth(hr)).json()
        self.assertTrue(any("前端状态同步" in item["message"]
                            for item in hr_after_correction["corrections"]))
        self.assertEqual(self.client.get(f"/api/hr/applications/{app_id}",
                         headers=self.auth(other_hr)).status_code, 404)

        review = self.client.post(f"/api/hr/applications/{app_id}/review",
            headers=self.auth(hr), json={"decision": "invite", "notes": "请核实项目贡献。"})
        self.assertEqual(review.status_code, 200, review.text)
        first_invitation = review.json()["invitation"]["id"]
        repeated = self.client.post(f"/api/hr/applications/{app_id}/review",
            headers=self.auth(hr), json={"decision": "invite", "notes": "请核实项目贡献。"})
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["invitation"]["id"], first_invitation)
        invited = self.client.get(f"/api/applications/{app_id}", headers=self.auth(candidate))
        self.assertEqual(invited.json()["status"], "ai_interview_invited")
        self.assertIn("interviewPath", invited.json()["invitation"])
        start = self.client.post(f"/api/applications/{app_id}/interview/start",
                                 headers=self.auth(candidate))
        self.assertEqual(start.status_code, 200, start.text)
        self.assertTrue(start.json()["ticket"])
        second_start = self.client.post(f"/api/applications/{app_id}/interview/start",
                                        headers=self.auth(candidate))
        self.assertEqual(second_start.json()["code"], start.json()["code"])
        self.assertEqual(self.submit(candidate, job["id"]).status_code, 409)

    def test_registration_upload_and_screening_failures(self) -> None:
        denied = self.client.post("/api/auth/register", json={
            "name": "Unauthorized HR", "email": "no-hr@example.test",
            "password": "safe-password-123", "role": "hr",
            "companyName": "Company One", "hrRegistrationCode": "wrong",
        })
        self.assertEqual(denied.status_code, 403)
        candidate = self.register("Candidate", "candidate@example.test")
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        job = self.create_job(hr)
        self.assertEqual(self.submit(candidate, job["id"], consent="false").status_code, 422)
        self.assertEqual(self.submit(candidate, job["id"], b"").status_code, 422)
        self.assertEqual(self.submit(candidate, job["id"], b"MZ executable").status_code, 422)
        self.assertEqual(self.submit(candidate, job["id"], PDF, "candidate.exe").status_code, 422)
        with patch.object(recruitment_api, "screen_resume",
                          side_effect=ScreeningError("模型结果不符合初筛 Schema。")):
            submission = self.submit(candidate, job["id"])
            self.assertEqual(submission.status_code, 202, submission.text)
            app_id = submission.json()["application"]["id"]
            detail = self.wait_for_screening(hr, app_id, "failed")
        self.assertEqual(detail["status"], "hr_review")
        self.assertIn("Schema", detail["screeningError"])
        safe = self.client.get(f"/api/applications/{app_id}", headers=self.auth(candidate))
        self.assertEqual(safe.status_code, 200)
        self.assertNotIn("screeningError", safe.json())

    def test_hr_pdf_import_shares_screening_and_counts_without_candidate_access(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other_hr = self.register("Other HR", "other-hr@example.test", "hr", "Company Two")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        self.assertEqual(self.submit(candidate, job["id"]).status_code, 202)
        path = "/api/hr/resumes/import"
        fields = {"jobId": job["id"], "candidateName": "企业录入候选人",
                  "permissionConfirmed": "true"}
        imported = self.client.post(path, headers=self.auth(hr), data=fields,
            files={"resume": ("imported.pdf", PDF, "application/pdf")})
        self.assertEqual(imported.status_code, 202, imported.text)
        imported_id = imported.json()["application"]["id"]
        self.assertEqual(imported.json()["application"]["source"], "hr_import")
        detail = self.wait_for_screening(hr, imported_id, "completed")
        self.assertEqual(detail["uploadedBy"], "HR")
        self.assertNotIn("hr-import-", detail["candidateEmail"] or "")
        self.assertEqual(self.client.get(f"/api/hr/applications/{imported_id}/resume",
                         headers=self.auth(hr)).content, PDF)
        listing = self.client.get("/api/hr/applications", headers=self.auth(hr)).json()
        self.assertEqual(listing["counts"], {"total": 2, "candidatePortal": 1, "hrImport": 1})
        self.assertEqual({item["source"] for item in listing["items"]},
                         {"candidate_portal", "hr_import"})
        self.assertEqual(len(self.client.get("/api/applications/my",
                         headers=self.auth(candidate)).json()["items"]), 1)
        self.assertEqual(self.client.get(f"/api/applications/{imported_id}",
                         headers=self.auth(candidate)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/hr/applications/{imported_id}",
                         headers=self.auth(other_hr)).status_code, 404)
        self.assertEqual(self.client.get("/api/hr/applications",
                         headers=self.auth(other_hr)).json()["counts"]["total"], 0)
        self.assertEqual(self.client.post(f"/api/hr/applications/{imported_id}/review",
                         headers=self.auth(hr), json={"decision": "invite", "notes": ""}).status_code, 409)
        self.assertEqual(self.client.post(f"/api/hr/applications/{imported_id}/review",
                         headers=self.auth(hr), json={"decision": "verify", "notes": "核验工作经历"}).status_code, 200)
        self.assertEqual(self.client.post(path, headers=self.auth(hr),
                         data={**fields, "permissionConfirmed": "false"},
                         files={"resume": ("x.pdf", PDF, "application/pdf")}).status_code, 422)
        self.assertEqual(self.client.post(path, headers=self.auth(hr), data=fields,
                         files={"resume": ("x.pdf", b"not a PDF", "application/pdf")}).status_code, 422)
        self.assertEqual(self.client.post(path, headers=self.auth(other_hr), data=fields,
                         files={"resume": ("x.pdf", PDF, "application/pdf")}).status_code, 404)
        self.assertEqual(self.client.post(path, headers=self.auth(candidate), data=fields,
                         files={"resume": ("x.pdf", PDF, "application/pdf")}).status_code, 403)


    def test_batch_zip_binds_proofs_to_one_private_resume(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other = self.register("Other HR", "other@example.test", "hr", "Company Two")
        job = self.create_job(hr)
        proof = b"\x89PNG\r\n\x1a\n" + b"fixture-proof"
        package = io.BytesIO()
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("person/简历.pdf", PDF)
            archive.writestr("person/学历证明.png", proof)
            archive.writestr("person/项目证明.pdf", PDF)
        fields = {"jobId": job["id"], "permissionConfirmed": "true"}
        response = self.client.post("/api/hr/resumes/batch", headers=self.auth(hr),
            data=fields, files=[("files", ("one.pdf", PDF, "application/pdf")),
                                ("files", ("person.zip", package.getvalue(), "application/zip"))])
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(len(response.json()["items"]), 2)
        self.assertEqual(response.json()["errors"], [])
        self.assertEqual(response.json()["counts"]["hrImport"], 2)
        imported = response.json()["items"][1]["application"]
        self.assertEqual(imported["attachmentCount"], 2)
        detail = self.client.get(f"/api/hr/applications/{imported['id']}",
                                 headers=self.auth(hr)).json()
        self.assertEqual(len(detail["attachments"]), 2)
        proof_id = next(item["id"] for item in detail["attachments"]
                        if item["contentType"] == "image/png")
        proof_path = f"/api/hr/applications/{imported['id']}/attachments/{proof_id}"
        self.assertEqual(self.client.get(proof_path, headers=self.auth(hr)).content, proof)
        self.assertEqual(self.client.get(proof_path, headers=self.auth(other)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/hr/applications/{imported['id']}",
                         headers=self.auth(other)).status_code, 404)
        bad = io.BytesIO()
        with zipfile.ZipFile(bad, "w") as archive:
            archive.writestr("../resume.pdf", PDF)
        rejected = self.client.post("/api/hr/resumes/batch", headers=self.auth(hr),
            data=fields, files={"files": ("bad.zip", bad.getvalue(), "application/zip")})
        self.assertEqual(rejected.status_code, 202)
        self.assertEqual(rejected.json()["items"], [])
        self.assertEqual(len(rejected.json()["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
