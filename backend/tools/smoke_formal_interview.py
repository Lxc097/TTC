"""Optional paid live smoke for the formal SiliconFlow interview bridge.

Start the loopback sidecar with npm run api:formal in TTC/ai-interview first.
This script creates an isolated temporary application and uses fixture answers;
it never prints or stores API credentials, resume text, questions, or reports.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")
os.environ.setdefault("INTERVIEW_SIDECAR_URL", "http://127.0.0.1:8788")

from candidate import formal_interview_api as formal  # noqa: E402
from candidate import recruitment_store as repo  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        os.environ["RECRUITMENT_DATA_DIR"] = directory
        repo.init_db()
        candidate = repo.create_user("Fixture Candidate", "candidate@example.test",
                                     "password-123", "candidate")
        hr = repo.create_user("Fixture HR", "hr@example.test", "password-456",
                              "hr", "Fixture Company")
        job = repo.create_job(hr["companyId"], "后端工程师",
                              "负责 Python API 设计、数据库可靠性和高并发服务测试。")
        app_id = repo.create_application(candidate["id"], job["id"], "fixture.pdf",
                                         "application/pdf", str(Path(directory) / "fixture.pdf"),
                                         "fixture-sha", False)
        with repo.db() as connection:
            connection.execute("UPDATE resumes SET raw_text=? WHERE application_id=?",
                               ("测试简历：负责 Python API 服务和数据库性能优化。", app_id))
            connection.execute("UPDATE screenings SET report_json=? WHERE application_id=?",
                               ('{"private":"DO_NOT_SEND_TO_INTERVIEW"}', app_id))
        repo.ensure_invitation(app_id)
        repo.upsert_review(app_id, hr["id"], "invite", "", "ai_interview_invited")
        prepared = formal.prepare_formal_interview(app_id, user=candidate)
        assert "DO_NOT_SEND_TO_INTERVIEW" not in str(prepared)
        attempt_id = prepared["attemptId"]
        session = formal.start_formal_session(formal.SessionStart(
            applicationId=app_id, attemptId=attempt_id), user=candidate)
        assert session["mode"] == "siliconflow"
        assert session["questions"]
        print("LIVE SILICONFLOW formal session:", len(session["questions"]), "questions")
        first = session["questions"][0]
        summary = formal.formal_answer_summary(formal.SummaryEvent(
            applicationId=app_id, attemptId=attempt_id, sessionId=session["id"],
            questionId=first["id"], answer="测试回答：我设计了带幂等控制的接口，并通过压测验证性能。"),
            user=candidate)
        assert summary.get("mode") == "siliconflow"
        print("LIVE SILICONFLOW answer summary: received")
        for item in session["questions"]:
            formal.save_formal_answer(app_id, formal.AnswerEvent(
                attemptId=attempt_id, questionId=item["id"], prompt=item["prompt"],
                answer="测试回答：我负责接口设计、故障排查和实际验证；这里仅为联调用例。"),
                user=candidate)
        finished = formal.complete_formal_interview(app_id,
            formal.FinishEvent(attemptId=attempt_id), user=candidate)
        assert finished["status"] == "completed"
        assert repo.candidate_application(app_id, candidate["id"])["status"] == "ai_interview_completed"
        print("FIXTURE answers persisted; formal application status: completed")


if __name__ == "__main__":
    main()
