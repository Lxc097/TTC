"""HTTP authorization and lifecycle tests for the formal AI interview bridge."""
from __future__ import annotations

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
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")

from fastapi.testclient import TestClient  # noqa: E402
import formal_interview_api as formal  # noqa: E402
import main  # noqa: E402
import recruitment_store as repo  # noqa: E402

QUESTIONS = [
    {"id": "q1", "prompt": "Explain your React cache invalidation design."},
    {"id": "q2", "prompt": "How did you measure the project result?"},
]


class FormalInterviewHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory.name})
        env.start()
        self.addCleanup(env.stop)
        repo.init_db()
        self.candidate = repo.create_user("Candidate", "candidate@example.test",
                                          "password-123", "candidate")
        self.other = repo.create_user("Other", "other@example.test",
                                      "password-456", "candidate")
        self.hr = repo.create_user("HR", "hr@example.test", "password-789",
                                   "hr", "Company One")
        self.other_hr = repo.create_user("Other HR", "other-hr@example.test",
                                         "password-abc", "hr", "Company Two")
        job = repo.create_job(self.hr["companyId"], "Frontend Engineer",
                              "Build React interfaces and measure product performance improvements.")
        self.app_id = repo.create_application(self.candidate["id"], job["id"], "resume.pdf",
            "application/pdf", str(Path(directory.name) / "resume.pdf"), "hash", False)
        with repo.db() as connection:
            connection.execute("UPDATE resumes SET raw_text=? WHERE application_id=?",
                               ("Frontend resume: React cache invalidation.", self.app_id))
            connection.execute("UPDATE screenings SET report_json=? WHERE application_id=?",
                (json.dumps({"jobMatch": {"score": 99},
                             "screeningRecommendation": "manual_review",
                             "interviewQuestions": [q["prompt"] for q in QUESTIONS],
                             "private": "PRIVATE_SCREENING"}), self.app_id))
            connection.execute("UPDATE applications SET status='hr_review', resume_status='parsed',"
                               " screening_status='completed' WHERE id=?", (self.app_id,))
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    @staticmethod
    def auth(user: dict) -> dict:
        return {"Authorization": "Bearer " + repo.issue_token(user["id"])}

    def invite(self) -> None:
        response = self.client.post(f"/api/hr/applications/{self.app_id}/review",
            headers=self.auth(self.hr), json={"decision": "invite", "notes": "Review the project"})
        self.assertEqual(response.status_code, 200, response.text)

    def prepare(self) -> dict:
        response = self.client.post(f"/api/applications/{self.app_id}/ai-interview/start",
                                    headers=self.auth(self.candidate))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_owner_and_invitation_gate_formal_context(self) -> None:
        url = f"/api/applications/{self.app_id}/ai-interview/start"
        self.assertEqual(self.client.post(url).status_code, 401)
        self.assertEqual(self.client.post(url, headers=self.auth(self.other)).status_code, 404)
        self.assertEqual(self.client.post(url, headers=self.auth(self.hr)).status_code, 403)
        self.assertEqual(self.client.post(url, headers=self.auth(self.candidate)).status_code, 409)
        self.invite()
        invitation = self.client.get(f"/api/applications/{self.app_id}",
                                     headers=self.auth(self.candidate)).json()["invitation"]
        self.assertEqual(invitation["interviewPath"],
                         f"/ai-interview/?application={self.app_id}")
        prepared = self.prepare()
        self.assertEqual(self.prepare()["attemptId"], prepared["attemptId"])
        self.assertNotIn("PRIVATE_SCREENING", json.dumps(prepared))
        self.assertNotIn("jobMatch", json.dumps(prepared))
        blocked = self.client.post("/api/interview/sessions", headers=self.auth(self.other),
            json={"applicationId": self.app_id, "attemptId": prepared["attemptId"]})
        self.assertEqual(blocked.status_code, 404)

    def test_built_interview_spa_refresh_works_without_masking_missing_assets(self) -> None:
        if not (main.AI_WEB / "index.html").is_file():
            self.skipTest("optional gerenduan dist has not been built")
        document = self.client.get("/ai-interview/device-check")
        self.assertEqual(document.status_code, 200)
        self.assertIn("text/html", document.headers["content-type"])
        self.assertEqual(self.client.get("/ai-interview/assets/not-a-real-file.js").status_code, 404)

    def test_local_fallback_is_refused_and_repeated_start_resumes_session(self) -> None:
        self.invite()
        attempt = self.prepare()["attemptId"]
        body = {"applicationId": self.app_id, "attemptId": attempt}
        with patch.object(formal, "_sidecar", return_value={
            "id": "local-id", "mode": "local", "questions": QUESTIONS,
        }) as sidecar:
            refused = self.client.post("/api/interview/sessions",
                headers=self.auth(self.candidate), json=body)
        self.assertEqual(refused.status_code, 503)
        sidecar.assert_called_once()

        calls = []
        def fixture_sidecar(method: str, path: str, payload: dict | None = None) -> dict:
            calls.append((method, path, payload))
            return {"id": "formal-session-1", "mode": "siliconflow", "questions": QUESTIONS}

        with patch.object(formal, "_sidecar", side_effect=fixture_sidecar):
            first = self.client.post("/api/interview/sessions",
                headers=self.auth(self.candidate), json=body)
            second = self.client.post("/api/interview/sessions",
                headers=self.auth(self.candidate), json=body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual([call[0] for call in calls], ["POST", "GET"])
        self.assertIn("React", calls[0][2]["config"]["resumeText"])
        self.assertNotIn("PRIVATE_SCREENING", json.dumps(calls[0][2]))
        self.assertNotIn("PRIVATE_SCREENING", first.text)

    def test_saved_question_plan_gates_answers_summaries_and_completion(self) -> None:
        self.invite()
        attempt = self.prepare()["attemptId"]
        with patch.object(formal, "_sidecar", return_value={
            "id": "formal-session-2", "mode": "siliconflow", "questions": QUESTIONS,
        }):
            session = self.client.post("/api/interview/sessions",
                headers=self.auth(self.candidate),
                json={"applicationId": self.app_id, "attemptId": attempt})
        self.assertEqual(session.status_code, 200, session.text)
        sid = session.json()["id"]
        answer_url = f"/api/applications/{self.app_id}/ai-interview/answers"
        first = {"attemptId": attempt, "questionId": "q1", "prompt": QUESTIONS[0]["prompt"],
                 "answer": "I defined cache keys by product ID."}
        self.assertEqual(self.client.post(answer_url, headers=self.auth(self.other),
                                          json=first).status_code, 404)
        for altered in ({**first, "questionId": "invented"},
                        {**first, "prompt": "Fabricated different prompt"},
                        {**first, "answer": "a"}):
            self.assertEqual(self.client.post(answer_url, headers=self.auth(self.candidate),
                                              json=altered).status_code, 422)
        follow = {"applicationId": self.app_id, "attemptId": attempt, "sessionId": sid,
                  "questionId": "invented", "answer": first["answer"], "followUpCount": 0}
        self.assertEqual(self.client.post("/api/interview/follow-ups",
            headers=self.auth(self.candidate), json=follow).status_code, 422)
        summary = {"applicationId": self.app_id, "attemptId": attempt,
                   "sessionId": sid, "questionId": "invented", "answer": first["answer"]}
        self.assertEqual(self.client.post("/api/interview/answer-summary",
            headers=self.auth(self.candidate), json=summary).status_code, 422)
        self.assertEqual(self.client.post("/api/interview/answer-summary",
            headers=self.auth(self.other), json={**summary, "questionId": "q1"}).status_code, 404)
        with patch.object(formal, "_sidecar", return_value={"summary": "Answer names a cache key."}) as sidecar:
            valid = self.client.post("/api/interview/answer-summary",
                headers=self.auth(self.candidate), json={**summary, "questionId": "q1"})
        self.assertEqual(valid.status_code, 200, valid.text)
        self.assertEqual(sidecar.call_args.args[2]["questionId"], "q1")
        self.assertNotIn("PRIVATE_SCREENING", valid.text)

        finish_url = f"/api/applications/{self.app_id}/ai-interview/complete"
        finish = {"attemptId": attempt}
        self.assertEqual(self.client.post(finish_url, headers=self.auth(self.candidate),
                                          json=finish).status_code, 409)
        self.assertEqual(self.client.post(answer_url, headers=self.auth(self.candidate),
                                          json=first).status_code, 200)
        self.assertEqual(self.client.post(finish_url, headers=self.auth(self.candidate),
                                          json=finish).status_code, 409)
        second = {"attemptId": attempt, "questionId": "q2", "prompt": QUESTIONS[1]["prompt"],
                  "answer": "We measured request count and latency."}
        self.assertEqual(self.client.post(answer_url, headers=self.auth(self.candidate),
                                          json=second).status_code, 200)
        for _ in range(2):
            done = self.client.post(finish_url, headers=self.auth(self.candidate), json=finish)
            self.assertEqual(done.status_code, 200, done.text)
            self.assertEqual(done.json()["status"], "completed")
        self.assertEqual(self.client.post(f"/api/applications/{self.app_id}/ai-interview/start",
                                          headers=self.auth(self.candidate)).status_code, 409)
        self.assertEqual(self.client.post(answer_url, headers=self.auth(self.candidate),
                                          json=first).status_code, 409)
        own = self.client.get(f"/api/applications/{self.app_id}",
                              headers=self.auth(self.candidate)).json()
        self.assertEqual(own["status"], "ai_interview_completed")
        self.assertNotIn("screening", own)
        self.assertNotIn("formalInterview", own)
        hr_detail = self.client.get(f"/api/hr/applications/{self.app_id}",
                                    headers=self.auth(self.hr))
        self.assertEqual(hr_detail.status_code, 200, hr_detail.text)
        record = hr_detail.json()["formalInterview"]
        self.assertEqual(record["status"], "completed")
        self.assertEqual(len(record["answers"]), 2)
        self.assertEqual({item["questionId"] for item in record["answers"]}, {"q1", "q2"})
        self.assertIn("cache keys", json.dumps(record))
        self.assertEqual(self.client.get(f"/api/hr/applications/{self.app_id}",
                         headers=self.auth(self.other_hr)).status_code, 404)


if __name__ == "__main__":
    unittest.main()
