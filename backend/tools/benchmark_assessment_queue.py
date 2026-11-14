"""Run a 100-resume local assessment benchmark with a mocked HTTP transport.

The production provider, shared limiter, SQLite queue, assessment writer and
progress recorder all execute. No request leaves the machine.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ["TTC_SKIP_DOTENV"] = "1"
os.environ["AI_MAX_CONCURRENCY"] = "3"
os.environ["SEARCH_MAX_CONCURRENCY"] = "3"

from candidate import recruitment_architect_store as architect
from candidate import recruitment_assessment as assessment
from candidate import recruitment_batches as batches
from candidate import recruitment_progress as progress
from candidate import recruitment_providers as providers
from candidate import recruitment_store as repo

COUNT = 100
EXTRA_CALLS = 8
REPORT = BACKEND / "tools" / "benchmark_100_resume_queue_report.md"


def seed() -> tuple[dict, dict, dict[str, str]]:
    repo.init_db()
    architect.init_db()
    assessment.init_db()
    batches.init_db()
    progress.init_db()
    hr = repo.create_user("基准 HR", "benchmark-hr@example.test",
                          "benchmark-password-123", "hr", "基准企业")
    job = repo.create_job(hr["companyId"], "软件工程师", "交付可靠 Python 项目。")
    session = architect.create_session(hr["companyId"], hr["id"], job["id"])
    architect.confirm_session(session["id"], hr["companyId"], hr["id"],
        {"jobName": "软件工程师", "summary": "分析实际 Python 项目贡献与交付质量。",
         "capabilityWeights": {"岗位能力": 60, "项目实践": 40}})
    ids: dict[str, str] = {}
    stamp = time.time()
    with repo.db() as db:
        for index in range(COUNT):
            candidate_id, application_id = uuid.uuid4().hex, uuid.uuid4().hex
            marker = f"PROJECT-{index:03d}"
            raw = f"张三\n项目编号 {marker}；本人负责 Python 项目交付。"
            db.execute("""INSERT INTO users
              (id,name,email,password_salt,password_hash,role,company_id,created_at)
              VALUES(?,?,?,?,?,'candidate',NULL,?)""",
              (candidate_id, "张三", f"benchmark-{index}@example.test", "00" * 16,
               "benchmark-only", stamp + index / 1000))
            db.execute("""INSERT INTO applications
              (id,candidate_id,job_id,status,resume_status,screening_status,verify_links,
               created_at,updated_at,source)
              VALUES(?,?,?,'hr_review','parsed','completed',0,?,?,'hr_import')""",
              (application_id, candidate_id, job["id"], stamp + index / 1000, stamp))
            db.execute("""INSERT INTO resumes
              (application_id,original_name,content_type,file_path,sha256,raw_text,parsed_json)
              VALUES(?,'synthetic.pdf','application/pdf','synthetic.pdf',?,?,?)""",
              (application_id, marker, raw, json.dumps({"name": "张三", "rawText": raw},
                                                    ensure_ascii=False)))
            db.execute("INSERT INTO screenings(application_id,report_json) VALUES(?,'{}')",
                       (application_id,))
            ids[application_id] = marker
    return hr, job, ids


async def benchmark(hr: dict, job: dict) -> tuple[float, list[dict], dict, int, int]:
    lock = threading.Lock()
    active = peak = calls = 0

    def fake_http(url: str, *, body: dict | None = None, **kwargs):
        nonlocal active, peak, calls
        assert url.endswith("/chat/completions") and body is not None
        payload = json.loads(body["messages"][1]["content"])
        marker = re.search(r"(?:PROJECT|EXTRA)-\d{3}", payload["resume"]).group(0)
        with lock:
            active += 1
            calls += 1
            peak = max(peak, active)
        try:
            time.sleep(0.035)
            result = {"summary": f"已分析 {marker}", "matchScore": 76,
                "scoreBasis": "Python 项目经历与岗位相关。",
                "capabilityProfile": [{"sourceText": marker, "normalized": "项目交付",
                                       "confidence": 0.8, "evidenceIds": []}],
                "dimensionScores": [
                    {"name": "岗位能力", "score": 80, "criteria": "Python 实践",
                     "sourceText": marker, "reason": "原文有项目编号。"},
                    {"name": "项目实践", "score": 70, "criteria": "项目交付",
                     "sourceText": marker, "reason": "原文有交付描述。"}] }
            return {"model": body["model"],
                    "choices": [{"message": {"content": json.dumps(result, ensure_ascii=False)}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50,
                              "total_tokens": 150}}, {"elapsedMs": 35, "traceId": "mock"}
        finally:
            with lock:
                active -= 1

    with patch.object(providers, "_http_json", side_effect=fake_http):
        queued = batches.enqueue_assessments(job["id"], hr["companyId"])
        assert queued["queued"] == COUNT, queued
        start = time.perf_counter()
        snapshots: list[dict] = []
        with ThreadPoolExecutor(max_workers=EXTRA_CALLS) as executor:
            await batches.start_worker()
            loop = asyncio.get_running_loop()
            direct = [loop.run_in_executor(executor, providers.SiliconFlowProvider(
                        api_key="local-mock-only").chat_json, "synthetic direct request",
                        {"resume": f"EXTRA-{index:03d}"})
                      for index in range(EXTRA_CALLS)]
            try:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    state = batches.assessment_queue(job["id"], hr["companyId"])
                    if not snapshots or state["completed"] != snapshots[-1]["completed"]:
                        snapshots.append({"elapsedSeconds": round(time.perf_counter() - start, 3),
                                          **state})
                    if state["completed"] == COUNT or state["failed"]:
                        break
                    await asyncio.sleep(0.05)
                await asyncio.gather(*direct)
            finally:
                await batches.stop_worker()
        elapsed = time.perf_counter() - start
    assert state["completed"] == COUNT and state["failed"] == 0, state
    assert calls == COUNT + EXTRA_CALLS, calls
    assert 2 <= peak <= 3, peak
    assert any(0 < item["completed"] < COUNT for item in snapshots), snapshots
    return elapsed, snapshots, state, peak, calls


def main() -> None:
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
        "RECRUITMENT_DATA_DIR": directory, "SILICONFLOW_API_KEY": "local-mock-only",
        "UAPI_API_KEY": ""}):
        hr, job, ids = seed()
        elapsed, snapshots, state, peak, calls = asyncio.run(benchmark(hr, job))
        with repo.db() as db:
            rows = db.execute("""SELECT ca.application_id,ca.report_json FROM candidate_assessments ca
              WHERE ca.job_id=? AND ca.status='completed'""", (job["id"],)).fetchall()
            stage_count = db.execute("""SELECT COUNT(*) FROM analysis_stages
              WHERE stage='assessment' AND status='completed'""").fetchone()[0]
            event_count = db.execute("""SELECT COUNT(*) FROM analysis_events
              WHERE stage='assessment' AND status='completed'""").fetchone()[0]
            usage_count = db.execute("""SELECT COUNT(*) FROM recruitment_ai_usage
              WHERE stage='capability_match'""").fetchone()[0]
        assert len(rows) == stage_count == event_count == usage_count == COUNT
        for row in rows:
            report = json.loads(row["report_json"])
            assert report["weightedScore"] == 76
            assert report["dimensionScores"][0]["sourceText"] == ids[row["application_id"]]
        assert len({row["application_id"] for row in rows}) == COUNT
        throughput = COUNT / elapsed
        report = f"""# 100 份简历补评队列本地基准

- 时间：{datetime.now(timezone.utc).isoformat(timespec='seconds')}
- 场景：100 份独立简历进入持久化补评队列，同时 8 个其他模块模拟模型请求。
- 模型：本地 mock HTTP 响应；真实 `SiliconFlowProvider.chat_json`、SQLite 全局限流器、队列和进度落库路径；**0 次外部付费调用，未上传云端**。
- 配置：`AI_MAX_CONCURRENCY=3`，模拟单次模型服务 35 ms。
- 队列完成：{state['completed']}/{COUNT}；失败：{state['failed']}；模拟模型请求：{calls}。
- 观测模型请求并发峰值：{peak}；上限：3。
- 队列总耗时（含并发的其他模块请求）：{elapsed:.3f} s；吞吐：{throughput:.2f} 份/s。
- 持久化：完整评估 {len(rows)}、完成阶段 {stage_count}、完成事件 {event_count}、模型用量记录 {usage_count}。
- 归属校验：100 个独立 application_id 与各自 `PROJECT-000` 至 `PROJECT-099` 原文证据一一对应；综合评分均为 76，未混淆。
- 阶段性进度：采集 {len(snapshots)} 次状态变化，包含未全部完成时的已完成结果。

本基准仅测补评阶段；不包含 PDF 解析、UAPI 搜索、真实模型网络延迟。
"""
        REPORT.write_text(report, encoding="utf-8")
        print(report)


if __name__ == "__main__":
    main()
