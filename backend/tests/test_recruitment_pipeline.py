"""招聘阶段管道：阶段映射、初筛标准、真人面试、邀请记录与结果可见性。

这个文件盯住三条产品约束：

1. 候选人只看到「当前阶段 + 下一步」，看不到内部报告、评分与面试官备注。
2. 阶段只能由企业端动作推进（邀请 → 真人面试 → 结论），并且不可回退。
3. 邀请过期在读取时计算，重发不产生第二条记录。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")

from fastapi.testclient import TestClient  # noqa: E402
import app as main  # noqa: E402
from candidate import pipeline, recruitment_api  # noqa: E402
from candidate import recruitment_store as repo  # noqa: E402

PDF = (Path(__file__).resolve().parent / "fixtures" / "candidate.pdf").read_bytes()
REPORT = {
    "candidateSummary": "简历提到前端缓存优化，具体贡献待面试核实。",
    "jobMatch": {"score": 68, "scoreBasis": "React 项目经历与岗位要求相关。",
                 "matchedRequirements": ["React"], "missingRequirements": ["可访问性"],
                 "evidence": [{"requirement": "React", "sourceText": "React",
                               "support": "简历原文提及 React。"}]},
    "resumeClaims": [],
    "strengths": ["有前端项目经验"],
    "areasToVerify": ["缓存优化的个人贡献"],
    "interviewQuestions": ["请解释你如何设计 React 缓存失效策略。"],
    "screeningRecommendation": "manual_review",
    "recommendationReasons": ["经历相关。"],
    "limitations": ["未进行外部核验。"],
}
META = {"model": "fixture/deepseek", "promptVersion": "test-fixture",
        "attempts": 1, "promptTokens": 12, "completionTokens": 34}


class PipelineRulesTests(unittest.TestCase):
    def test_status_maps_to_exactly_one_stage(self) -> None:
        cases = {
            "submitted": pipeline.APPLIED, "parsing": pipeline.APPLIED,
            "screening": pipeline.APPLIED, "hr_review": pipeline.APPLIED,
            "failed": pipeline.APPLIED,
            "ai_interview_invited": pipeline.AI_INTERVIEW,
            "ai_interview_in_progress": pipeline.AI_INTERVIEW,
            "ai_interview_completed": pipeline.AI_INTERVIEW,
            "hr_interview_invited": pipeline.HUMAN_INTERVIEW,
            "closed": pipeline.ENDED,
            "something_new": pipeline.APPLIED,
        }
        for status, expected in cases.items():
            with self.subTest(status=status):
                self.assertEqual(pipeline.stage_of(status), expected)
                self.assertTrue(pipeline.stage_label(pipeline.stage_of(status)))

    def test_invitation_state_is_computed_not_stored(self) -> None:
        now = time.time()
        self.assertEqual(pipeline.invitation_state("invited", now + 60, None, now),
                         pipeline.PENDING)
        self.assertEqual(pipeline.invitation_state("invited", now - 60, None, now),
                         pipeline.EXPIRED)
        self.assertEqual(pipeline.invitation_state("in_progress", now + 60, None, now),
                         pipeline.ACCEPTED)
        self.assertEqual(pipeline.invitation_state("invited", now + 60, now - 5, now),
                         pipeline.ACCEPTED)
        self.assertEqual(pipeline.invitation_state("completed", now - 60, now - 99, now),
                         pipeline.COMPLETED)

    def test_human_interview_state_and_result_copy(self) -> None:
        now = time.time()
        self.assertEqual(pipeline.human_state("invited", None, now + 60, None, now),
                         pipeline.PENDING)
        self.assertEqual(pipeline.human_state("invited", None, now - 60, None, now),
                         pipeline.EXPIRED)
        self.assertEqual(pipeline.human_state("invited", None, now + 60, now - 5, now),
                         pipeline.ACCEPTED)
        self.assertEqual(pipeline.human_state("completed", "pass", None, None, now),
                         pipeline.COMPLETED)
        for result in ("pass", "hold", "reject"):
            message = pipeline.result_message(result)
            self.assertTrue(message)
            # 候选人可见文案里不允许出现内部评估口径。
            for forbidden in ("分数", "排名", "备注", "评价"):
                self.assertNotIn(forbidden, message)


class RecruitmentPipelineApiTests(unittest.TestCase):
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
        patcher = patch.object(recruitment_api, "screen_resume",
                               return_value=(REPORT, META))
        self.screen_mock = patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    # ---------- helpers ----------
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

    def create_job(self, hr: dict, title: str = "前端工程师") -> dict:
        response = self.client.post("/api/hr/jobs", headers=self.auth(hr), json={
            "title": title,
            "description": "负责 React 与 TypeScript 产品开发、页面性能、可访问性和团队协作，能解释方案权衡并展示实际项目证据。",
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def submit_and_wait(self, candidate: dict, hr: dict, job_id: str) -> str:
        submission = self.client.post("/api/applications", headers=self.auth(candidate),
            data={"jobId": job_id, "consent": "true"},
            files={"resume": ("candidate.pdf", PDF, "application/pdf")})
        self.assertEqual(submission.status_code, 202, submission.text)
        app_id = submission.json()["application"]["id"]
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            detail = self.client.get(f"/api/hr/applications/{app_id}",
                                     headers=self.auth(hr)).json()
            if detail["screeningStatus"] in ("completed", "failed", "skipped"):
                return app_id
            time.sleep(0.1)
        self.fail("screening never settled")

    def invite(self, hr: dict, app_id: str) -> dict:
        response = self.client.post(f"/api/hr/applications/{app_id}/review",
            headers=self.auth(hr), json={"decision": "invite", "notes": "请核实项目贡献。"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def candidate_view(self, candidate: dict, app_id: str) -> dict:
        response = self.client.get(f"/api/applications/{app_id}", headers=self.auth(candidate))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def schedule_human(self, hr: dict, app_id: str, **overrides) -> dict:
        payload = {"scheduledAt": time.time() + 3 * 86400, "durationMinutes": 45,
                   "interviewerName": "张老师", "mode": "video"}
        payload.update(overrides)
        return self.client.post(f"/api/hr/applications/{app_id}/human-interview",
                                headers=self.auth(hr), json=payload)

    # ---------- 初筛标准 ----------
    def test_criteria_are_saved_used_and_never_exposed_publicly(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other_hr = self.register("Other HR", "other-hr@example.test", "hr", "Company Two")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        criteria = "必须能用中文清晰表达技术权衡"

        saved = self.client.put(f"/api/hr/jobs/{job['id']}/criteria",
                                headers=self.auth(hr), json={"criteria": criteria})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["screeningCriteria"], criteria)

        jobs = self.client.get("/api/hr/jobs", headers=self.auth(hr)).json()["items"]
        self.assertEqual(jobs[0]["screeningCriteria"], criteria)
        public = self.client.get("/api/jobs").json()["items"]
        self.assertNotIn("screeningCriteria", public[0])

        self.assertEqual(self.client.put(f"/api/hr/jobs/{job['id']}/criteria",
                         headers=self.auth(other_hr),
                         json={"criteria": "偷看别人的岗位"}).status_code, 404)
        self.assertEqual(self.client.put(f"/api/hr/jobs/{job['id']}/criteria",
                         headers=self.auth(hr),
                         json={"criteria": "x" * 4001}).status_code, 422)

        app_id = self.submit_and_wait(candidate, hr, job["id"])
        self.assertTrue(app_id)
        passed_criteria = self.screen_mock.call_args.kwargs.get("criteria")
        self.assertEqual(passed_criteria, criteria)

    # ---------- 阶段推进 ----------
    def test_stage_advances_only_through_enterprise_actions(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])

        self.assertEqual(self.candidate_view(candidate, app_id)["stage"], pipeline.APPLIED)
        self.invite(hr, app_id)
        invited = self.candidate_view(candidate, app_id)
        self.assertEqual(invited["stage"], pipeline.AI_INTERVIEW)
        self.assertEqual(invited["invitation"]["state"], pipeline.PENDING)
        self.assertGreater(invited["invitation"]["expiresAt"], time.time())

        scheduled = self.schedule_human(hr, app_id)
        self.assertEqual(scheduled.status_code, 201, scheduled.text)
        detail = scheduled.json()
        self.assertEqual(detail["stage"], pipeline.HUMAN_INTERVIEW)
        self.assertEqual(detail["humanInterview"]["state"], pipeline.PENDING)
        self.assertRegex(detail["humanInterview"]["roomCode"], r"^[A-Z0-9]{6}$")
        self.assertIn("ticket=", detail["invitation"]["interviewPath"])

        view = self.candidate_view(candidate, app_id)
        self.assertEqual(view["stage"], pipeline.HUMAN_INTERVIEW)
        self.assertEqual(view["humanInterview"]["interviewerName"], "张老师")
        self.assertNotIn("notes", view["humanInterview"])
        self.assertIsNone(view["result"])

        # 迟到的初筛失败不能把已推进的阶段打回去。
        repo.save_screening_failure(app_id, "上游超时", "fixture", "test", 1)
        self.assertEqual(repo.get_application_by_id(app_id)["status"], "hr_interview_invited")
        self.assertEqual(self.candidate_view(candidate, app_id)["stage"],
                         pipeline.HUMAN_INTERVIEW)

        # 面试间结束（AI 房间收口）也不能回退真人面试阶段。
        repo.mark_interview_completed(app_id)
        self.assertEqual(repo.get_application_by_id(app_id)["status"], "hr_interview_invited")

    # ---------- 真人面试 ----------
    def test_human_interview_enter_and_result_visibility(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other_hr = self.register("Other HR", "other-hr@example.test", "hr", "Company Two")
        candidate = self.register("Candidate", "candidate@example.test")
        other_candidate = self.register("Other", "other@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])

        self.assertEqual(self.schedule_human(other_hr, app_id).status_code, 404)
        scheduled = self.schedule_human(hr, app_id)
        self.assertEqual(scheduled.status_code, 201, scheduled.text)
        self.assertEqual(self.client.post(f"/api/applications/{app_id}/human-interview/enter",
                         headers=self.auth(other_candidate)).status_code, 404)

        entered = self.client.post(f"/api/applications/{app_id}/human-interview/enter",
                                   headers=self.auth(candidate))
        self.assertEqual(entered.status_code, 200, entered.text)
        self.assertTrue(entered.json()["ticket"])
        self.assertIn("ticket=", entered.json()["interviewPath"])
        self.assertEqual(self.candidate_view(candidate, app_id)["humanInterview"]["state"],
                         pipeline.ACCEPTED)

        # 内部备注只留在企业端；结论未发送前候选人看不到。
        result = self.client.patch(f"/api/hr/applications/{app_id}/human-interview",
            headers=self.auth(hr), json={"result": "pass",
                                         "notes": "内部备注：沟通清晰，建议二面。",
                                         "resultSent": False})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["status"], "closed")
        self.assertEqual(result.json()["humanInterview"]["notes"], "内部备注：沟通清晰，建议二面。")
        self.assertIsNone(self.candidate_view(candidate, app_id)["result"])

        sent = self.client.patch(f"/api/hr/applications/{app_id}/human-interview",
            headers=self.auth(hr), json={"resultSent": True})
        self.assertEqual(sent.status_code, 200, sent.text)
        view = self.candidate_view(candidate, app_id)
        self.assertEqual(view["stage"], pipeline.ENDED)
        self.assertEqual(view["result"]["conclusion"], "通过")
        self.assertNotIn("内部备注", json.dumps(view, ensure_ascii=False))
        self.assertNotIn("notes", json.dumps(view["humanInterview"], ensure_ascii=False))

        # 结束之后不能改审核决定，也不能重复安排。
        self.assertEqual(self.client.post(f"/api/hr/applications/{app_id}/review",
                         headers=self.auth(hr),
                         json={"decision": "hold", "notes": ""}).status_code, 409)
        self.assertEqual(self.schedule_human(hr, app_id).status_code, 409)

    def test_onsite_interview_returns_location_instead_of_room(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])
        self.assertEqual(self.schedule_human(hr, app_id, mode="onsite").status_code, 422)
        scheduled = self.schedule_human(hr, app_id, mode="onsite", location="上海张江 3 号楼")
        self.assertEqual(scheduled.status_code, 201, scheduled.text)
        self.assertIsNone(scheduled.json()["humanInterview"]["roomCode"])
        entered = self.client.post(f"/api/applications/{app_id}/human-interview/enter",
                                   headers=self.auth(candidate)).json()
        self.assertEqual(entered["mode"], "onsite")
        self.assertEqual(entered["location"], "上海张江 3 号楼")
        self.assertIsNone(entered["roomCode"])
        self.assertIsNone(entered["interviewPath"])

    # ---------- 邀请记录 ----------
    def test_invitation_expiry_resend_and_records(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])
        self.invite(hr, app_id)

        records = self.client.get("/api/hr/invitations", headers=self.auth(hr)).json()
        self.assertEqual(records["counts"]["total"], 1)
        first = records["items"][0]
        self.assertEqual(first["kind"], "ai")
        self.assertEqual(first["state"], pipeline.PENDING)
        self.assertTrue(first["resendable"])

        resent = self.client.post(f"/api/hr/applications/{app_id}/invitation/resend",
                                  headers=self.auth(hr), json={"days": 2})
        self.assertEqual(resent.status_code, 200, resent.text)
        self.assertEqual(resent.json()["invitation"]["sendCount"], 2)
        self.assertGreater(resent.json()["invitation"]["expiresAt"], first["expiresAt"])

        # 手动把邀请改成已过期：读取时就应该显示已过期，并且可以重发。
        with repo.db() as connection:
            connection.execute("UPDATE invitations SET expires_at=? WHERE application_id=?",
                               (time.time() - 60, app_id))
        expired = self.client.get("/api/hr/invitations", headers=self.auth(hr)).json()["items"][0]
        self.assertEqual(expired["state"], pipeline.EXPIRED)
        self.assertEqual(self.candidate_view(candidate, app_id)["invitation"]["state"],
                         pipeline.EXPIRED)
        again = self.client.post(f"/api/hr/applications/{app_id}/invitation/resend",
                                 headers=self.auth(hr))
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["invitation"]["state"], pipeline.PENDING)

        # 候选人已进入面试后不能重发；AI 初面完成后同样不能重发。
        repo.mark_interview_in_progress(app_id)
        self.assertEqual(self.client.post(f"/api/hr/applications/{app_id}/invitation/resend",
                         headers=self.auth(hr)).status_code, 409)
        repo.mark_interview_completed(app_id)
        self.assertEqual(self.client.post(f"/api/hr/applications/{app_id}/invitation/resend",
                         headers=self.auth(hr)).status_code, 409)
        completed = self.client.get("/api/hr/invitations", headers=self.auth(hr)).json()["items"][0]
        self.assertEqual(completed["state"], pipeline.COMPLETED)
        self.assertFalse(completed["resendable"])
        self.assertEqual(self.client.get("/api/hr/invitations", headers=self.auth(hr),
                                         params={"kind": "human"}).json()["items"], [])

    # ---------- AI 结果与面试间归档 ----------
    def test_ai_result_toggle_requires_completed_interview(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])
        path = f"/api/hr/applications/{app_id}/ai-result/send"
        self.assertEqual(self.client.post(path, headers=self.auth(hr),
                         json={"visible": True}).status_code, 409)
        self.invite(hr, app_id)
        self.assertEqual(self.client.post(path, headers=self.auth(hr),
                         json={"visible": True}).status_code, 409)
        repo.mark_interview_in_progress(app_id)
        repo.mark_interview_completed(app_id)

        sent = self.client.post(path, headers=self.auth(hr), json={"visible": True})
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertTrue(sent.json()["aiResultSent"])
        view = self.candidate_view(candidate, app_id)
        self.assertTrue(view["aiResult"]["visible"])
        self.assertTrue(view["aiResult"]["message"])
        self.assertNotIn("analysis", json.dumps(view, ensure_ascii=False))

        revoked = self.client.post(path, headers=self.auth(hr), json={"visible": False})
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertFalse(self.candidate_view(candidate, app_id)["aiResult"]["visible"])

    def test_interview_room_report_is_archived_for_hr_only(self) -> None:
        hr = self.register("HR", "hr@example.test", "hr", "Company One")
        other_hr = self.register("Other HR", "other-hr@example.test", "hr", "Company Two")
        candidate = self.register("Candidate", "candidate@example.test")
        job = self.create_job(hr)
        app_id = self.submit_and_wait(candidate, hr, job["id"])
        path = f"/api/hr/applications/{app_id}/interview-room"
        self.assertEqual(self.client.get(path, headers=self.auth(hr)).status_code, 404)

        report = {"title": "面试质量报告",
                  "verification": {"requested": 3, "confirmed": 2, "unconfirmed": 1},
                  "points": [{"text": "追问缓存失效的验证方式", "why": "生理 ∧ 行为双确认"}]}
        repo.archive_interview_report(app_id, "session-1", report)
        archived = self.client.get(path, headers=self.auth(hr))
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertEqual(archived.json()["sessionId"], "session-1")
        self.assertEqual(archived.json()["report"]["verification"]["confirmed"], 2)
        self.assertEqual(self.client.get(path, headers=self.auth(other_hr)).status_code, 404)
        detail = self.client.get(f"/api/hr/applications/{app_id}", headers=self.auth(hr)).json()
        self.assertEqual(detail["interviewRoomReport"]["report"]["verification"]["requested"], 3)


if __name__ == "__main__":
    unittest.main()
