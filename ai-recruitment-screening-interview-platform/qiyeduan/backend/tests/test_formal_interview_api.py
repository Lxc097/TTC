"""Formal interview uses only server-owned context and a real sidecar plan."""
from __future__ import annotations

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

import formal_interview_api as formal  # noqa: E402
import recruitment_store as repo  # noqa: E402
from fastapi import HTTPException  # noqa: E402


QUESTIONS = [
    {"id": "ai-1", "prompt": "请讲述你设计一个可靠 API 的具体经历。", "keywords": ["API", "可靠性"]},
    {"id": "ai-2", "prompt": "请解释你如何验证系统在高流量下的表现。", "keywords": ["测试", "性能"]},
]


class FormalInterviewTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory.name})
        env.start()
        self.addCleanup(env.stop)
        repo.init_db()
        self.candidate = repo.create_user("Applicant", "a@example.test", "password-123", "candidate")
        self.other = repo.create_user("Other", "b@example.test", "password-456", "candidate")
        hr = repo.create_user("HR", "hr@example.test", "password-789", "hr", "Company")
        job = repo.create_job(hr["companyId"], "后端工程师", "负责 API 设计、Python 服务和可靠性测试。")
        self.app_id = repo.create_application(self.candidate["id"], job["id"], "resume.pdf",
                                              "application/pdf", str(Path(directory.name) / "resume.pdf"),
                                              "hash", False)
        with repo.db() as connection:
            connection.execute("UPDATE resumes SET raw_text=? WHERE application_id=?",
                               ("我负责 Python 服务和高流量 API。", self.app_id))
            connection.execute("UPDATE screenings SET report_json=? WHERE application_id=?",
                               ('{"jobMatch":{"score":99},"private":"PRIVATE_EVALUATION"}', self.app_id))
        repo.ensure_invitation(self.app_id)
        repo.upsert_review(self.app_id, hr["id"], "invite", "", "ai_interview_invited")

    def start(self) -> tuple[str, dict]:
        prepared = formal.prepare_formal_interview(self.app_id, user=self.candidate)
        upstream = {"id": "node-session", "mode": "siliconflow", "questions": QUESTIONS}
        with patch.object(formal, "_sidecar", return_value=upstream) as sidecar:
            session = formal.start_formal_session(formal.SessionStart(
                applicationId=self.app_id, attemptId=prepared["attemptId"]), user=self.candidate)
        sidecar.assert_called_once()
        return prepared["attemptId"], session

    def test_context_is_candidate_owned_and_excludes_private_screening(self) -> None:
        with self.assertRaises(HTTPException) as denied:
            formal.prepare_formal_interview(self.app_id, user=self.other)
        self.assertEqual(denied.exception.status_code, 404)
        prepared = formal.prepare_formal_interview(self.app_id, user=self.candidate)
        self.assertEqual(prepared["config"]["role"], "backend")
        self.assertIn("Python", prepared["config"]["resumeText"])
        self.assertNotIn("PRIVATE_EVALUATION", str(prepared))
        self.assertNotIn("jobMatch", str(prepared))

    def test_local_sidecar_never_starts_formal_attempt(self) -> None:
        prepared = formal.prepare_formal_interview(self.app_id, user=self.candidate)
        with patch.object(formal, "_sidecar", return_value={"id": "local-id", "mode": "local", "questions": QUESTIONS}):
            with self.assertRaises(HTTPException) as refused:
                formal.start_formal_session(formal.SessionStart(
                    applicationId=self.app_id, attemptId=prepared["attemptId"]), user=self.candidate)
        self.assertEqual(refused.exception.status_code, 503)
        with repo.db() as connection:
            state = connection.execute("SELECT status,session_id FROM formal_interviews WHERE application_id=?",
                                       (self.app_id,)).fetchone()
        self.assertEqual(state["status"], "prepared")
        self.assertIsNone(state["session_id"])

    def test_answers_match_plan_and_completion_is_once_only(self) -> None:
        attempt_id, session = self.start()
        self.assertEqual(session["mode"], "siliconflow")
        with self.assertRaises(HTTPException) as early:
            formal.complete_formal_interview(self.app_id, formal.FinishEvent(attemptId=attempt_id),
                                             user=self.candidate)
        self.assertEqual(early.exception.status_code, 409)
        with self.assertRaises(HTTPException) as forged:
            formal.save_formal_answer(self.app_id, formal.AnswerEvent(
                attemptId=attempt_id, questionId="ai-1", prompt="伪造题目", answer="一个完整回答"),
                user=self.candidate)
        self.assertEqual(forged.exception.status_code, 422)
        for item in QUESTIONS:
            formal.save_formal_answer(self.app_id, formal.AnswerEvent(
                attemptId=attempt_id, questionId=item["id"], prompt=item["prompt"],
                answer="我负责设计并验证了这项功能。"), user=self.candidate)
        done = formal.complete_formal_interview(self.app_id, formal.FinishEvent(attemptId=attempt_id),
                                                user=self.candidate)
        self.assertEqual(done["status"], "completed")
        self.assertEqual(formal.complete_formal_interview(
            self.app_id, formal.FinishEvent(attemptId=attempt_id), user=self.candidate), done)
        self.assertEqual(repo.get_application_by_id(self.app_id)["status"], "ai_interview_completed")
        with self.assertRaises(HTTPException) as repeated:
            formal.prepare_formal_interview(self.app_id, user=self.candidate)
        self.assertEqual(repeated.exception.status_code, 409)

    def test_follow_up_requires_bound_attempt_and_session(self) -> None:
        attempt_id, _ = self.start()
        body = formal.FollowUpEvent(applicationId=self.app_id, attemptId=attempt_id,
                                    sessionId="wrong-session", questionId="ai-1",
                                    answer="我负责服务开发", followUpCount=0)
        with self.assertRaises(HTTPException) as denied:
            formal.formal_follow_up(body, user=self.candidate)
        self.assertEqual(denied.exception.status_code, 409)
        body.sessionId = "node-session"
        with patch.object(formal, "_sidecar", return_value={"mode": "siliconflow", "prompt": "具体怎么验证？"}) as sidecar:
            result = formal.formal_follow_up(body, user=self.candidate)
        self.assertEqual(result["prompt"], "具体怎么验证？")
        sidecar.assert_called_once()


if __name__ == "__main__":
    unittest.main()
