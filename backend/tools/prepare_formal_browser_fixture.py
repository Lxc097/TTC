"""Create an isolated invited candidate for local browser QA (no real applicant data)."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
directory = Path(tempfile.mkdtemp(prefix="ttc-formal-browser-"))
os.environ["RECRUITMENT_DATA_DIR"] = str(directory)
os.environ["TTC_SKIP_DOTENV"] = "1"

from candidate import recruitment_store as repo  # noqa: E402

repo.init_db()
candidate = repo.create_user("浏览器测试候选人", "browser-candidate@example.test",
                             "fixture-password-123", "candidate")
hr = repo.create_user("浏览器测试 HR", "browser-hr@example.test",
                      "fixture-password-456", "hr", "浏览器测试企业")
job = repo.create_job(hr["companyId"], "后端工程师",
                      "负责 Python API、数据库可靠性和服务性能测试，需解释真实项目贡献。")
app_id = repo.create_application(candidate["id"], job["id"], "fixture.pdf",
                                 "application/pdf", str(directory / "fixture.pdf"),
                                 "fixture-sha", False)
with repo.db() as connection:
    connection.execute("""UPDATE resumes SET raw_text=? WHERE application_id=?""",
                       ("测试简历：负责 Python API、SQL 性能优化和线上故障排查。", app_id))
    connection.execute("""UPDATE applications SET resume_status='parsed',
      screening_status='completed' WHERE id=?""", (app_id,))
repo.ensure_invitation(app_id)
repo.upsert_review(app_id, hr["id"], "invite", "", "ai_interview_invited")
print("DATA_DIR=" + str(directory))
print("APP_ID=" + app_id)
print("CANDIDATE_EMAIL=browser-candidate@example.test")
print("CANDIDATE_PASSWORD=fixture-password-123")
