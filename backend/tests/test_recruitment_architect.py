"""Hiring consultant contract, tenant boundaries and version snapshots."""
from __future__ import annotations

import os
import json
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
import app  # noqa: E402
from candidate import recruitment_architect  # noqa: E402
from candidate import recruitment_architect_store as architect_store  # noqa: E402
from candidate import recruitment_store as repo  # noqa: E402
from candidate.recruitment_providers import ProviderError  # noqa: E402
from candidate.recruitment_skill_registry import (get_runtime_skill, list_runtime_skills,
                                        runtime_prompt)  # noqa: E402

PROFILE = {
    "jobName": "市场活动负责人", "recruitmentType": "mixed",
    "summary": "负责企业市场活动的策划、执行与复盘，能展示个人负责范围及结果口径，并与销售团队协作。",
    "businessContext": "新业务获客", "responsibilities": ["策划并执行活动"],
    "expectedOutcomes": ["完成活动复盘"], "requiredCapabilities": ["活动执行"],
    "capabilityWeights": {"活动执行": 100}, "resumeEvidence": ["活动方案和复盘"],
}


class ArchitectApiTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory.name,
                                   "HR_REGISTRATION_CODE": "test-secret"})
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(app.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.hr = self._register("First Company", "first@example.test")
        self.other = self._register("Second Company", "second@example.test")

    def _register(self, company, email):
        response = self.client.post("/api/auth/register", json={
            "name": "HR", "email": email, "password": "long-test-password",
            "role": "hr", "companyName": company, "hrRegistrationCode": "test-secret"})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def _headers(self, account):
        return {"Authorization": "Bearer " + account["token"]}

    def test_runtime_skill_registry_has_eight_callable_stages(self):
        self.assertGreaterEqual(len(list_runtime_skills()), 8)
        self.assertEqual(get_runtime_skill("Evidence Evaluator").id, "evidence-evaluator")
        self.assertIn("CONTRADICTED", runtime_prompt("evidence-evaluator"))
        self.assertIn("已确认", runtime_prompt("Requirement Architect", context="市场活动"))

    def test_clarify_confirm_and_version_snapshot(self):
        headers = self._headers(self.hr)
        created = self.client.post("/api/hr/architect/sessions", json={}, headers=headers)
        self.assertEqual(created.status_code, 201, created.text)
        session_id = created.json()["id"]
        self.assertIsNone(created.json()["jobId"])
        self.assertEqual(self.client.get(f"/api/hr/architect/sessions/{session_id}",
                                         headers=self._headers(self.other)).status_code, 404)
        responses = iter([
            ({"reply": "这项工作最重要的交付成果是什么？", "stage": "clarifying",
              "profile": None}, {"model": "fixture", "promptTokens": 10}),
            ({"reply": "已整理标准，请确认。", "stage": "draft", "profile": PROFILE},
             {"model": "fixture", "promptTokens": 20}),
        ])
        with patch.object(recruitment_architect.SiliconFlowProvider, "chat_json",
                          side_effect=lambda *args, **kwargs: next(responses)):
            first = self.client.post(f"/api/hr/architect/sessions/{session_id}/messages",
                                     json={"message": "我想招市场活动负责人"}, headers=headers)
            second = self.client.post(f"/api/hr/architect/sessions/{session_id}/messages",
                                      json={"message": "交付成果是完成活动复盘"}, headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["stage"], "clarifying")
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["stage"], "draft")
        self.assertEqual(len(second.json()["messages"]), 4)
        confirmed = self.client.post(f"/api/hr/architect/sessions/{session_id}/confirm",
                                     json={}, headers=headers)
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        job_id = confirmed.json()["jobId"]
        self.assertEqual(confirmed.json()["version"], 1)
        self.assertEqual(self.client.post(f"/api/hr/architect/sessions/{session_id}/confirm",
                                          json={}, headers=headers).json()["version"], 1)
        profile = self.client.get(f"/api/hr/jobs/{job_id}/profile", headers=headers)
        self.assertEqual(profile.json()["profile"]["jobName"], PROFILE["jobName"])
        self.assertEqual(self.client.get(f"/api/hr/jobs/{job_id}/profile",
                                         headers=self._headers(self.other)).status_code, 404)
        candidate = repo.create_user("Person", "person@example.test", "password-123", "candidate")
        app_id = repo.create_application(candidate["id"], job_id, "resume.pdf",
                                         "application/pdf", "test.pdf", "abc", False)
        with repo.db() as connection:
            version_id = connection.execute("SELECT profile_version_id FROM screenings WHERE application_id=?",
                                            (app_id,)).fetchone()[0]
        self.assertEqual(version_id, architect_store.latest_profile(job_id)["id"])
        self.assertEqual(architect_store.profile_for_application(app_id)["version"], 1)
        with repo.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM architect_ai_usage").fetchone()[0], 2)

        revised = {**PROFILE, "summary": PROFILE["summary"] + "进一步重视具体项目成果。"}
        with patch.object(recruitment_architect.SiliconFlowProvider, "chat_json",
                          return_value=({"reply": "新标准已更新，请确认。", "stage": "draft",
                                         "profile": revised}, {"model": "fixture"})):
            self.assertEqual(self.client.post(
                f"/api/hr/architect/sessions/{session_id}/messages",
                json={"message": "更强调实际项目"}, headers=headers).status_code, 200)
        second_version = self.client.post(f"/api/hr/architect/sessions/{session_id}/confirm",
                                          json={}, headers=headers)
        self.assertEqual(second_version.json()["version"], 2)
        self.assertEqual(architect_store.profile_for_application(app_id)["version"], 1)
        versions = self.client.get(f"/api/hr/jobs/{job_id}/profiles", headers=headers).json()["items"]
        self.assertEqual([item["version"] for item in versions], [2, 1])
        original = self.client.get(f"/api/hr/jobs/{job_id}/profiles/1", headers=headers)
        updated = self.client.get(f"/api/hr/jobs/{job_id}/profiles/2", headers=headers)
        self.assertEqual(original.status_code, 200, original.text)
        self.assertEqual(original.json()["profile"]["summary"], PROFILE["summary"])
        self.assertEqual(updated.json()["profile"]["summary"], revised["summary"])
        self.assertEqual(self.client.get(f"/api/hr/jobs/{job_id}/profiles/1",
                                         headers=self._headers(self.other)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/hr/jobs/{job_id}/profiles/3",
                                         headers=headers).status_code, 404)

    def test_provider_failure_does_not_store_fake_answer(self):
        headers = self._headers(self.hr)
        session_id = self.client.post("/api/hr/architect/sessions", json={}, headers=headers).json()["id"]
        with patch.dict(os.environ, {"SILICONFLOW_API_KEY": ""}):
            response = self.client.post(f"/api/hr/architect/sessions/{session_id}/messages",
                                        json={"message": "需要招聘工程师"}, headers=headers)
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(self.client.get(f"/api/hr/architect/sessions/{session_id}",
                                         headers=headers).json()["messages"], [])

    def test_history_lists_only_company_sessions_and_version(self):
        own = self._headers(self.hr)
        other = self._headers(self.other)
        first = self.client.post("/api/hr/architect/sessions", json={}, headers=own).json()
        self.client.post("/api/hr/architect/sessions", json={}, headers=other)
        self.client.post("/api/hr/architect/sessions", json={}, headers=own)
        result = self.client.get("/api/hr/architect/sessions?limit=1&offset=0", headers=own)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["total"], 2)
        self.assertEqual(len(result.json()["items"]), 1)
        self.assertEqual(self.client.get("/api/hr/architect/sessions", headers=other).json()["total"], 1)
        self.assertEqual(self.client.get("/api/hr/architect/sessions?jobId=no-such-job",
                                         headers=own).json()["total"], 0)
        self.assertIsNotNone(self.client.get(f"/api/hr/architect/sessions/{first['id']}",
                                             headers=own).json()["createdAt"])

    def test_stream_persists_user_first_and_supports_failed_retry(self):
        headers = self._headers(self.hr)
        session_id = self.client.post("/api/hr/architect/sessions", json={}, headers=headers).json()["id"]
        path = f"/api/hr/architect/sessions/{session_id}/messages/stream"
        with patch.object(recruitment_architect, "_model_stream", side_effect=ProviderError("upstream busy")):
            failed = self.client.post(path, json={"message": "需要招聘工程师"}, headers=headers)
        self.assertEqual(failed.status_code, 200, failed.text)
        self.assertIn("event: started", failed.text)
        self.assertIn("event: error", failed.text)
        saved = self.client.get(f"/api/hr/architect/sessions/{session_id}", headers=headers).json()
        self.assertEqual(len(saved["messages"]), 1)
        self.assertEqual(saved["messages"][0]["content"], "需要招聘工程师")
        self.assertEqual(saved["messages"][0]["deliveryStatus"], "failed")
        message_id = saved["messages"][0]["id"]

        answer = {"reply": "请说明岗位最重要的交付成果。", "stage": "clarifying", "profile": None}
        raw = json.dumps(answer, ensure_ascii=False)
        midpoint = raw.index("交付")
        stream = iter([{"content": raw[:midpoint]}, {"content": raw},
                       {"raw": answer, "usage": {"model": "fixture", "elapsedMs": 12}}])
        with patch.object(recruitment_architect, "_model_stream", return_value=stream):
            ok = self.client.post(path, json={"message": "需要招聘工程师", "retryMessageId": message_id},
                                  headers=headers)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertIn("event: delta", ok.text)
        self.assertIn("event: completed", ok.text)
        saved = self.client.get(f"/api/hr/architect/sessions/{session_id}", headers=headers).json()
        self.assertEqual(len(saved["messages"]), 2)
        self.assertEqual(saved["messages"][0]["deliveryStatus"], "completed")
        self.assertEqual(saved["messages"][1]["content"], answer["reply"])
        self.assertEqual(self.client.get("/api/hr/architect/sessions", headers=headers).json()["items"][0]["messageCount"], 2)


if __name__ == "__main__":
    unittest.main()
