"""Deterministic V2 screening, scoring and reversible review tests."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
from candidate import recruitment_store as repo
from candidate import recruitment_architect_store as architect
from candidate import recruitment_assessment as assessment
from candidate import recruitment_batches as batches
from candidate import recruitment_api as api


class ScreeningBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": self.tmp.name})
        self.environment.start()
        repo.init_db()
        architect.init_db()
        assessment.init_db()
        batches.init_db()
        self.hr = repo.create_user("HR", "batch-hr@example.test", "correct horse battery",
                                   "hr", "批次测试企业")

    def tearDown(self):
        self.environment.stop()
        self.tmp.cleanup()

    def job(self):
        job = repo.create_job(self.hr["companyId"], "工程师", "负责软件项目设计、交付和质量。")
        session = architect.create_session(self.hr["companyId"], self.hr["id"], job["id"])
        architect.confirm_session(session["id"], self.hr["companyId"], self.hr["id"],
            {"jobName": "工程师", "summary": "负责独立交付软件项目并维护交付质量。",
             "capabilityWeights": {"岗位能力": 60, "项目实践": 40}})
        return job, architect.latest_profile(job["id"], self.hr["companyId"])

    def seed(self, job: dict, profile: dict, scores: list[float | None]) -> list[str]:
        ids = []
        with repo.db() as db:
            for index, score in enumerate(scores):
                uid, aid, sid = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
                stamp = 1000.0 + index
                db.execute("""INSERT INTO users
                  (id,name,email,password_salt,password_hash,role,company_id,created_at)
                  VALUES(?,?,?,?,?,'candidate',NULL,?)""",
                  (uid, f"候选人 {index}", f"batch-{aid}@example.test", "00" * 16, "x", stamp))
                db.execute("""INSERT INTO applications
                  (id,candidate_id,job_id,status,resume_status,screening_status,
                   verify_links,created_at,updated_at,source)
                  VALUES(?,?,?,'hr_review','parsed','completed',0,?,?,'hr_import')""",
                  (aid, uid, job["id"], stamp, stamp))
                db.execute("""INSERT INTO resumes
                  (application_id,original_name,content_type,file_path,sha256,raw_text,parsed_json)
                  VALUES(?,'fixture.pdf','application/pdf','fixture.pdf','fixture','resume','{}')""", (aid,))
                db.execute("""INSERT INTO screenings
                  (application_id,report_json,model,prompt_version,profile_version_id)
                  VALUES(?,'{}','fixture','fixture',?)""", (aid, profile["id"]))
                if score is not None:
                    report = {"weightedScore": score, "matchScore": score,
                              "scoringStatus": "complete", "scoreBasis": "岗位维度评分",
                              "dimensionScores": [{"name": "岗位能力", "weight": 60, "score": score},
                                                  {"name": "项目实践", "weight": 40, "score": score}]}
                    db.execute("""INSERT INTO candidate_assessments
                      (id,application_id,job_id,profile_version_id,profile_version,status,
                       report_json,created_at,updated_at)
                      VALUES(?,?,?,?,?,'completed',?,?,?)""",
                      (sid, aid, job["id"], profile["id"], profile["version"],
                       json.dumps(report, ensure_ascii=False), stamp, stamp))
                ids.append(aid)
        return ids

    def test_percentage_examples_and_immutable_snapshot(self):
        for count, percent, expected in ((7, 30, 3), (100, 30, 30), (20, 50, 10)):
            job, profile = self.job()
            self.seed(job, profile, [float(100 - index) for index in range(count)])
            pre = batches.preview(job["id"], percent, self.hr["companyId"])
            self.assertEqual(pre["selectedCount"], expected)
            result = batches.create_batch(job["id"], percent, self.hr["companyId"], self.hr["id"])
            self.assertEqual(result["selectedCount"], expected)
            self.assertEqual(len([item for item in result["items"] if item["selected"]]), expected)
            before = [item["applicationId"] for item in result["items"]]
            self.seed(job, profile, [12.0])
            after = batches.get_batch(result["id"], self.hr["companyId"])
            self.assertEqual([item["applicationId"] for item in after["items"]], before)
            self.assertEqual(after["totalCount"], count)

    def test_tie_missing_score_and_new_ratio(self):
        job, profile = self.job()
        self.seed(job, profile, [90, 80, 80, 70, None])
        pre = batches.preview(job["id"], 50, self.hr["companyId"])
        self.assertEqual((pre["eligibleCount"], pre["pendingCount"], pre["selectedCount"]),
                         (4, 1, 2))
        self.assertTrue(pre["boundaryTie"])
        first = batches.create_batch(job["id"], 50, self.hr["companyId"], self.hr["id"])
        second = batches.create_batch(job["id"], 75, self.hr["companyId"], self.hr["id"])
        self.assertEqual(first["selectedCount"], 2)
        self.assertEqual(second["selectedCount"], 3)
        self.assertEqual(first["items"][-1]["selectionStatus"], "pending_assessment")
        self.assertIsNone(first["items"][-1]["score"])

    def test_unparsed_resume_is_pending_but_not_available_for_rescoring(self):
        job, profile = self.job()
        first, second = self.seed(job, profile, [None, None])
        with repo.db() as db:
            db.execute("UPDATE resumes SET raw_text=NULL WHERE application_id=?", (second,))
        preview = batches.preview(job["id"], 30, self.hr["companyId"])
        self.assertEqual((preview["pendingCount"], preview["assessablePendingCount"],
                          preview["unavailableCount"]), (2, 1, 1))
        queued = batches.enqueue_assessments(job["id"], self.hr["companyId"])
        self.assertEqual(queued["queued"], 1)
        self.assertEqual(queued["assessablePendingCount"], 1)
        self.assertEqual(batches.assessment_queue(job["id"], self.hr["companyId"])["unavailableCount"], 1)
        self.assertEqual(batches._claim_assessment()["application_id"], first)

    def test_hr_card_score_tracks_current_confirmed_profile(self):
        job, profile = self.job()
        app_id = self.seed(job, profile, [88])[0]
        current = api._hr_dto(repo.hr_application(app_id, self.hr["companyId"]))
        self.assertEqual((current["weightedScore"], current["scoringStatus"],
                          current["profileVersion"]), (88, "complete", 1))
        session = architect.create_session(self.hr["companyId"], self.hr["id"], job["id"])
        architect.confirm_session(session["id"], self.hr["companyId"], self.hr["id"],
            {"jobName": "工程师", "summary": "新的招聘标准版本，用于重新评分。",
             "capabilityWeights": {"岗位能力": 50, "项目实践": 50}})
        updated = api._hr_dto(repo.hr_application(app_id, self.hr["companyId"]))
        self.assertIsNone(updated["weightedScore"])
        self.assertEqual((updated["scoringStatus"], updated["profileVersion"]),
                         ("pending", 2))

    def test_keep_talent_defer_and_undo_restore(self):
        job, profile = self.job()
        self.seed(job, profile, [90, 80, 70])
        batch = batches.create_batch(job["id"], 100, self.hr["companyId"], self.hr["id"])
        first, second, third = [item["applicationId"] for item in batch["items"]]
        batch = batches.decide(batch["id"], first, "keep", self.hr["companyId"], self.hr["id"])
        self.assertEqual(batch["reviewedCount"], 1)
        batch = batches.decide(batch["id"], second, "talent", self.hr["companyId"], self.hr["id"])
        with repo.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM talent_records WHERE source_application_id=?",
                                        (second,)).fetchone()[0], 1)
        batch = batches.undo(batch["id"], self.hr["companyId"])
        self.assertIsNone(batch["items"][1]["reviewDecision"])
        with repo.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM talent_records WHERE source_application_id=?",
                                        (second,)).fetchone()[0], 0)
        batch = batches.decide(batch["id"], second, "defer", self.hr["companyId"], self.hr["id"])
        self.assertEqual(batch["deferredCount"], 1)
        batch = batches.decide(batch["id"], third, "keep", self.hr["companyId"], self.hr["id"])
        self.assertEqual(batch["currentIndex"], 1)
        self.assertEqual(batch["status"], "active")

    def test_dimension_total_uses_confirmed_weights_and_rejects_bad_quote(self):
        raw = {"matchScore": 99, "scoreBasis": "岗位能力与项目经验",
               "capabilityProfile": [{"sourceText": "Python 项目", "normalized": "项目交付"}],
               "dimensionScores": [
                   {"name": "岗位能力", "score": 80, "criteria": "Python 实践", "sourceText": "Python 项目",
                    "evidenceIds": [], "reason": "有实际项目", "needsVerification": False},
                   {"name": "项目实践", "score": 70, "criteria": "交付成果", "sourceText": "项目交付",
                    "evidenceIds": [], "reason": "有交付记录", "needsVerification": True}]}
        result = assessment._report(raw, "Python 项目；项目交付", set(),
                                    {"岗位能力": 60, "项目实践": 40})
        self.assertEqual(result["weightedScore"], 76)
        self.assertEqual(result["matchScore"], 76)
        raw["dimensionScores"][1]["sourceText"] = "不存在的履历"
        result = assessment._report(raw, "Python 项目；项目交付", set(),
                                    {"岗位能力": 60, "项目实践": 40})
        self.assertIsNone(result["weightedScore"])
        self.assertEqual(result["scoringStatus"], "incomplete")

    def test_existing_resume_can_enter_persistent_rescoring_queue(self):
        job, profile = self.job()
        app_id = self.seed(job, profile, [None])[0]
        queued = batches.enqueue_assessments(job["id"], self.hr["companyId"])
        self.assertEqual(queued["queued"], 1)
        self.assertEqual(batches.enqueue_assessments(job["id"], self.hr["companyId"])["queued"], 0)
        claimed = batches._claim_assessment()
        self.assertEqual(claimed["application_id"], app_id)
        with patch.object(assessment, "assess_application", return_value={"weightedScore": 75}) as run:
            batches._process_assessment(claimed)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(batches.assessment_queue(job["id"], self.hr["companyId"])["completed"], 1)
        with repo.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM resumes WHERE application_id=?",
                                        (app_id,)).fetchone()[0], 1)

    def test_rescoring_worker_processes_three_resumes_concurrently(self):
        job, profile = self.job()
        self.seed(job, profile, [None, None, None])
        self.assertEqual(batches.enqueue_assessments(job["id"], self.hr["companyId"])["queued"], 3)
        barrier = threading.Barrier(3)
        lock = threading.Lock()
        peak = 0
        active = 0

        def process(item):
            nonlocal peak, active
            with lock:
                active += 1
                peak = max(peak, active)
            try:
                barrier.wait(timeout=3)
            finally:
                with repo.db() as db:
                    db.execute("UPDATE assessment_jobs SET status='completed' WHERE application_id=?",
                               (item["application_id"],))
                with lock:
                    active -= 1

        async def run():
            with (patch.object(batches.recruitment_config, "AI_MAX_CONCURRENCY", 3),
                  patch.object(batches, "_process_assessment", side_effect=process)):
                await batches.start_worker()
                try:
                    for _ in range(100):
                        if batches.assessment_queue(job["id"], self.hr["companyId"])["completed"] == 3:
                            break
                        await asyncio.sleep(0.05)
                finally:
                    await batches.stop_worker()

        asyncio.run(run())
        self.assertEqual(peak, 3)
        self.assertEqual(batches.assessment_queue(job["id"], self.hr["companyId"])["completed"], 3)


if __name__ == "__main__":
    unittest.main()
