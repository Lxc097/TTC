"""Deterministic integration checks; external evidence remains explicitly fixture data."""
from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
import app
from candidate import recruitment_architect_store as architect
from candidate import recruitment_assessment as assessment
from candidate import recruitment_providers as providers
from candidate import recruitment_store as repo
from candidate import recruitment_verification as verification


TEXT = "张三\n2024年参加全国大学生创新竞赛并获得一等奖。\n项目经历：负责设计数据分析模块，团队完成上线。\n技能：Python、SQL。"
QUOTE = "2024年参加全国大学生创新竞赛并获得一等奖。"


class FakeAI:
    def chat_json(self, system_prompt, payload, **kwargs):
        if verification.EXTRACT_PROMPT in system_prompt:
            return {"claims": [{"claim": "2024年获得全国大学生创新竞赛一等奖",
                "sourceText": QUOTE, "category": "award", "verificationTarget": "获奖名单及个人姓名",
                "publiclyVerifiable": True, "queries": [{"query": "全国大学生创新竞赛 2024 一等奖 公示",
                                                "site": None, "filetype": "pdf"}]}]}, {"model": "fixture"}
        if verification.EVALUATE_PROMPT in system_prompt:
            item = payload["items"][0]
            return {"results": [{"claimId": item["claimId"], "status": "PARTIALLY_VERIFIED",
                    "explanation": "官方公告证实竞赛存在，但没有证据将获奖归属于该候选人。",
                    "evidenceIds": [item["evidence"][0]["id"]],
                    "supportingQuote": "2024年竞赛获奖公示", "followUpQuestion": "请提供获奖证书。"}]}, {"model": "fixture"}
        if assessment.MATCH_PROMPT in system_prompt:
            return {"summary": "具备相关项目经历，个人贡献仍需面试确认。", "matchScore": 72,
                    "scoreBasis": "岗位要求 Python 与数据分析，简历有相关描述但缺独立交付佐证。",
                    "matchedRequirements": ["Python"], "gaps": ["个人贡献证据"],
                    "capabilityProfile": [{"sourceText": "负责设计数据分析模块", "originalClaim": "负责设计数据分析模块",
                        "normalized": "简历声称负责模块设计，个人成果待验证", "evidenceIds": [],
                        "confidence": 0.4, "interviewQuestion": "请展示个人设计方案。"}],
                    "recommendation": "review", "interviewQuestions": ["你负责了哪些具体代码？"],
                    "limitations": ["公开证据未证明个人贡献"]}, {"model": "fixture"}
        raise AssertionError("unexpected prompt")


class FakeSearch:
    def search(self, query, **kwargs):
        return {"query": query, "results": [{"url": "https://example.edu.cn/notice/2024",
            "title": "竞赛公示", "source": "院校公示", "snippet": "2024年竞赛获奖公示",
            "publishedAt": "2024-08-01", "fullContent": "该竞赛于2024年举办。"}]}

    def fetch_markdown(self, url):
        return {"url": url, "markdown": "2024年竞赛公示。"}


class IntelligenceFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": self.temp.name,
                                          "VERIFICATION_ENABLED": "1"})
        self.env.start()
        repo.init_db()
        architect.init_db()
        verification.init_db()
        assessment.init_db()
        self.hr = repo.create_user("HR", "hr-intelligence@example.test", "correct horse battery", "hr", "测试企业")
        self.job = repo.create_job(self.hr["companyId"], "数据分析师", "负责 Python 数据分析、业务指标设计与项目交付。需要解释具体个人贡献。")
        session = architect.create_session(self.hr["companyId"], self.hr["id"], self.job["id"])
        architect.confirm_session(session["id"], self.hr["companyId"], self.hr["id"],
            {"jobName": "数据分析师", "summary": "使用 Python 分析业务数据并交付可靠的指标与分析结论。",
             "requiredCapabilities": ["Python", "数据分析"]})
        path = Path(self.temp.name) / "resume.txt"
        path.write_text(TEXT, encoding="utf-8")
        self.app_id = repo.create_hr_import(self.hr["companyId"], self.hr["id"], self.job["id"],
                                           "张三", "resume.pdf", "application/pdf", str(path), "fixture")
        repo.save_parsed_resume(self.app_id, TEXT, {"rawText": TEXT, "name": "张三"})
        repo.save_screening(self.app_id, {"candidateSummary": "数据分析候选人", "resumeClaims": []},
                            "fixture", "fixture", 1, 10, 10)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_claim_search_evidence_capability_and_talent_rematch(self):
        with patch.object(providers, "SiliconFlowProvider", FakeAI), \
             patch.object(providers, "UAPISearchProvider", FakeSearch):
            self.assertTrue(verification.enqueue(self.app_id))
            self.assertEqual(verification.claim_next(), self.app_id)
            self.assertTrue(verification.enqueue(self.app_id, force=True))
            self.assertIsNone(verification.claim_next())
            verification.process_one(self.app_id)
            result = verification.detail(self.app_id)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["claims"][0]["status"], "PARTIALLY_VERIFIED")
            self.assertEqual(len(result["claims"][0]["evidence"]), 1)
            self.assertEqual(result["assessment"]["matchScore"], 72)
            self.assertEqual(result["assessment"]["profileVersion"], 1)
            with repo.db() as db:
                stages = [row[0] for row in db.execute(
                    "SELECT stage FROM recruitment_ai_usage WHERE application_id=? ORDER BY created_at",
                    (self.app_id,)).fetchall()]
            self.assertEqual(stages, ["claim_extraction", "evidence_evaluation", "capability_match"])
            usage = verification.usage_summary(user=self.hr)
            self.assertEqual(usage["publicSearch"]["requestsRecorded"], 1)
            self.assertTrue(all(any(item["stage"] == stage and item["requestsRecorded"] == 1
                                    for item in usage["aiStages"]) for stage in stages))
            assessment.archive_candidate(self.app_id, self.hr["companyId"])
            self.assertEqual(len(assessment.list_talent(user=self.hr)["items"]), 1)
            second = repo.create_job(self.hr["companyId"], "运营分析师", "负责业务分析、报表和运营建议。")
            session = architect.create_session(self.hr["companyId"], self.hr["id"], second["id"])
            architect.confirm_session(session["id"], self.hr["companyId"], self.hr["id"],
                {"jobName": "运营分析师", "summary": "负责运营数据分析与业务指标体系。"})
            result = assessment.rematch(assessment.list_talent(user=self.hr)["items"][0]["id"],
                                        assessment.RematchBody(jobId=second["id"]), self.hr)
            self.assertEqual(result["assessment"]["jobId"], second["id"])

    def test_no_public_hit_never_becomes_fraud(self):
        class EmptySearch(FakeSearch):
            def search(self, query, **kwargs):
                return {"query": query, "results": []}
        with patch.object(providers, "SiliconFlowProvider", FakeAI), \
             patch.object(providers, "UAPISearchProvider", EmptySearch):
            verification.enqueue(self.app_id)
            verification.process_one(self.app_id)
        self.assertEqual(verification.detail(self.app_id)["claims"][0]["status"], "UNVERIFIED")

    def test_three_claims_search_and_model_run_concurrently_and_reuse_results(self):
        lines = [f"2024年获得独立奖项{i}。" for i in range(1, 4)]
        with repo.db() as db:
            db.execute("UPDATE resumes SET raw_text=? WHERE application_id=?",
                       ("张三\n" + "\n".join(lines), self.app_id))
        lock = threading.Lock()
        active = {"search": 0, "ai": 0}
        peak = {"search": 0, "ai": 0}
        calls = {"search": 0, "ai": 0}

        def overlap(kind):
            with lock:
                active[kind] += 1
                calls[kind] += 1
                peak[kind] = max(peak[kind], active[kind])
            time.sleep(0.08)
            with lock:
                active[kind] -= 1

        class ThreeClaimAI:
            def chat_json(self, prompt, payload, **kwargs):
                if verification.EXTRACT_PROMPT in prompt:
                    return {"claims": [{"claim": f"张三于2024年获得独立奖项{i}",
                        "sourceText": lines[i - 1], "category": "award",
                        "verificationTarget": f"奖项{i}名单与个人归属", "publiclyVerifiable": True,
                        "queries": [{"query": f"2024 独立奖项{i} 官方公示"}]}
                        for i in range(1, 4)]}, {"model": "fixture"}
                item = payload["items"][0]
                overlap("ai")
                return {"results": [{"claimId": item["claimId"], "status": "PARTIALLY_VERIFIED",
                    "explanation": "公示仅证明奖项存在，个人归属需要补充原始证书。",
                    "evidenceIds": [item["evidence"][0]["id"]],
                    "supportingQuote": "奖项公示", "followUpQuestion": "请提供证书。"}]}, {"model": "fixture"}

        class ThreeClaimSearch:
            def search(self, query, **kwargs):
                overlap("search")
                return {"results": [{"url": "https://example.edu.cn/" + query.split("奖项")[1][0],
                    "title": query, "snippet": "奖项公示", "fullContent": "奖项公示，待核对获奖者身份。"}]}

        with patch.object(providers, "SiliconFlowProvider", ThreeClaimAI), \
             patch.object(providers, "UAPISearchProvider", ThreeClaimSearch), \
             patch.object(verification, "_assess_if_profile"):
            with patch.dict(os.environ, {"AI_MAX_CONCURRENCY": "1", "SEARCH_MAX_CONCURRENCY": "1"}):
                verification.enqueue(self.app_id)
                verification.process_one(self.app_id)
            self.assertEqual(peak, {"search": 1, "ai": 1})
            with repo.db() as db:
                db.execute("UPDATE verification_jobs SET resume_sha256=NULL WHERE application_id=?", (self.app_id,))
            for kind in peak:
                peak[kind] = calls[kind] = 0
            with patch.dict(os.environ, {"AI_MAX_CONCURRENCY": "3", "SEARCH_MAX_CONCURRENCY": "3"}):
                verification.enqueue(self.app_id, force=True)
                verification.process_one(self.app_id)
            result = verification.detail(self.app_id)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(len(result["claims"]), 3)
            self.assertEqual(calls, {"search": 3, "ai": 3})
            self.assertEqual(peak["search"], 3)
            self.assertGreaterEqual(peak["ai"], 2)
            self.assertTrue(all(len(item["evidence"]) == 1 and item["analysisStatus"] == "completed"
                                for item in result["claims"]))
            # Overlapping outbound calls prove concurrency; SQLite timing varies by host.
            verification.enqueue(self.app_id, force=True)
            verification.process_one(self.app_id)
            self.assertEqual(calls, {"search": 3, "ai": 3})

    def test_unexpected_single_claim_failure_preserves_sibling_results(self):
        class TwoClaimAI(FakeAI):
            fail_once = True

            def chat_json(self, prompt, payload, **kwargs):
                if verification.EXTRACT_PROMPT in prompt:
                    return {"claims": [{"claim": "张三于2024年获得竞赛一等奖",
                        "sourceText": QUOTE, "category": "award", "publiclyVerifiable": True,
                        "queries": [{"query": "竞赛 一等奖 2024 官方"}]},
                        {"claim": "张三于2024年参加竞赛并设计分析模块",
                        "sourceText": QUOTE, "category": "project", "publiclyVerifiable": True,
                        "queries": [{"query": "竞赛 分析模块 2024 官方"}]}]}, {"model": "fixture"}
                if "设计分析模块" in payload["items"][0]["claim"] and self.fail_once:
                    self.fail_once = False
                    raise RuntimeError("fixture interruption")
                return super().chat_json(prompt, payload, **kwargs)

        ai = TwoClaimAI()
        with patch.object(providers, "SiliconFlowProvider", return_value=ai), \
             patch.object(providers, "UAPISearchProvider", FakeSearch), \
             patch.object(verification, "_assess_if_profile"):
            verification.enqueue(self.app_id)
            verification.process_one(self.app_id)
            first = verification.detail(self.app_id)
            self.assertEqual(first["status"], "partial")
            self.assertEqual(sorted(c["analysisStatus"] for c in first["claims"]), ["completed", "failed"])
            completed_id = next(c["id"] for c in first["claims"] if c["analysisStatus"] == "completed")
            verification.enqueue(self.app_id, force=True)
            verification.process_one(self.app_id)
            second = verification.detail(self.app_id)
        self.assertEqual(second["status"], "completed")
        self.assertTrue(all(c["analysisStatus"] == "completed" for c in second["claims"]))
        self.assertEqual(next(c["retryCount"] for c in second["claims"] if c["id"] == completed_id), 0)
        self.assertEqual(next(c["retryCount"] for c in second["claims"] if c["id"] != completed_id), 1)
        self.assertEqual(sum(len(c["searches"]) for c in second["claims"]), 2)

    def test_one_completed_claim_can_reuse_or_refresh_evidence_on_request(self):
        headers = {"Authorization": "Bearer " + repo.issue_token(self.hr["id"])}
        client = TestClient(app.app)
        with patch.object(providers, "SiliconFlowProvider", FakeAI), \
             patch.object(providers, "UAPISearchProvider", FakeSearch), \
             patch.object(verification, "_assess_if_profile"):
            verification.enqueue(self.app_id)
            verification.process_one(self.app_id)
            initial = verification.detail(self.app_id)["claims"][0]
            endpoint = f"/api/hr/applications/{self.app_id}/verification/claims/{initial['id']}/retry"
            self.assertEqual(client.post(endpoint, headers=headers,
                                         json={"refreshSearch": False}).status_code, 202)
            verification.process_one(self.app_id)
            reused = verification.detail(self.app_id)["claims"][0]
            self.assertEqual((len(reused["searches"]), reused["retryCount"]), (1, 1))
            self.assertEqual(client.post(endpoint, headers=headers,
                                         json={"refreshSearch": True}).status_code, 202)
            verification.process_one(self.app_id)
            refreshed = verification.detail(self.app_id)["claims"][0]
            self.assertEqual((len(refreshed["searches"]), refreshed["retryCount"]), (2, 2))
            self.assertEqual(refreshed["analysisStatus"], "completed")

    def test_new_routes_enforce_tenant_scope_and_talent_status(self):
        other = repo.create_user("HR2", "hr2-intelligence@example.test", "correct horse battery",
                                 "hr", "另一测试企业")
        mine = {"Authorization": "Bearer " + repo.issue_token(self.hr["id"])}
        theirs = {"Authorization": "Bearer " + repo.issue_token(other["id"])}
        client = TestClient(app.app)
        path = f"/api/hr/applications/{self.app_id}/verification"
        self.assertEqual(client.get(path, headers=theirs).status_code, 404)
        self.assertEqual(client.get(path, headers=mine).status_code, 200)
        self.assertEqual(client.post(path + "/retry", headers=theirs).status_code, 404)
        self.assertEqual(client.post(f"/api/hr/applications/{self.app_id}/assessment/retry",
                                     headers=theirs).status_code, 404)
        assessment.archive_candidate(self.app_id, self.hr["companyId"])
        candidate_id = assessment.list_talent(user=self.hr)["items"][0]["id"]
        talent_path = f"/api/hr/talent/{candidate_id}"
        self.assertEqual(client.patch(talent_path, headers=theirs,
                                      json={"status": "archived"}).status_code, 404)
        archived = client.patch(talent_path, headers=mine, json={"status": "archived"})
        self.assertEqual(archived.status_code, 200)
        self.assertEqual(archived.json()["status"], "archived")
        self.assertEqual(client.get("/api/hr/talent", headers=mine).json()["items"], [])
        self.assertEqual(len(client.get("/api/hr/talent?status=archived", headers=mine).json()["items"]), 1)
        self.assertEqual(client.delete(talent_path, headers=theirs).status_code, 404)


if __name__ == "__main__":
    unittest.main()
