"""Local, isolated live-provider benchmark for three independent award claims.

Runs the same synthetic resume sequentially and with three claim workers.
No production application or database is touched; output contains no API keys.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared import config  # noqa: E402  -- loads backend/.env when present
from candidate import recruitment_providers as providers  # noqa: E402
from candidate import recruitment_store as repo  # noqa: E402
from candidate import recruitment_verification as verification  # noqa: E402


AWARDS = (
    ("全国大学生数学建模竞赛", "2024 全国大学生数学建模竞赛 获奖名单 官方"),
    ("中国国际大学生创新大赛", "2024 中国国际大学生创新大赛 获奖名单 公示"),
    ("蓝桥杯大赛", "2024 蓝桥杯 大赛 获奖名单 官方"),
)


class Tracker:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = {"search": 0, "ai": 0}
        self.peak = {"search": 0, "ai": 0}
        self.calls = {"search": 0, "ai": 0}

    def enter(self, kind):
        with self.lock:
            self.calls[kind] += 1
            self.active[kind] += 1
            self.peak[kind] = max(self.peak[kind], self.active[kind])

    def leave(self, kind):
        with self.lock:
            self.active[kind] -= 1


def run_case(company, job, label, concurrency):
    tracker = Tracker()
    raw_text = "测试候选人（虚构，用于并发测试）\n" + "\n".join(
        f"简历声明：2024年获得{title}奖项，个人获奖归属待核查。" for title, _ in AWARDS)
    path = repo.data_dir() / f"benchmark-{label}.txt"
    path.write_text(raw_text, encoding="utf-8")
    app_id = repo.create_hr_import(company["companyId"], company["id"], job["id"],
                                   f"测试候选人-{label}", path.name, "text/plain",
                                   str(path), f"benchmark-{label}")
    repo.save_parsed_resume(app_id, raw_text, {"rawText": raw_text, "name": "测试候选人"})
    repo.save_screening(app_id, {"candidateSummary": "仅用于并发测试"}, "fixture", "fixture", 1, 0, 0)
    verification.enqueue(app_id)
    claims = [{"id": __import__("uuid").uuid4().hex, "category": "award",
               "claim": f"测试候选人声称获得{title}奖项",
               "sourceText": f"简历声明：2024年获得{title}奖项，个人获奖归属待核查。",
               "verificationTarget": f"{title}及个人获奖归属",
               "publiclyVerifiable": True,
               "queries": [{"query": query, "site": None, "filetype": None}],
               "pageNumber": None} for title, query in AWARDS]
    verification._save_claims(app_id, claims)
    with repo.db() as db:
        db.execute("UPDATE verification_jobs SET resume_sha256=? WHERE application_id=?",
                   (f"benchmark-{label}", app_id))
    assert verification.claim_next() == app_id
    # Each mode must actually call UAPI, rather than inherit in-process cache.
    with providers._search_lock:
        providers._search_cache.clear()
        providers._markdown_cache.clear()

    real_http = providers._http_json

    def tracked_http(url, **kwargs):
        # This runs inside the provider limiter, immediately around the real
        # outbound HTTP call. Adapter entry would overstate actual concurrency
        # when a request is queued for a global slot.
        kind = ("ai" if url.endswith("/chat/completions") else
                "search" if url.endswith("/api/v1/search/aggregate") else None)
        if kind:
            tracker.enter(kind)
        try:
            return real_http(url, **kwargs)
        finally:
            if kind:
                tracker.leave(kind)

    with patch.object(providers, "_http_json", tracked_http), \
         patch.dict(os.environ, {"AI_MAX_CONCURRENCY": str(concurrency),
                                  "SEARCH_MAX_CONCURRENCY": str(concurrency)}):
        started = time.perf_counter()
        verification.process_one(app_id)
        wall_ms = round((time.perf_counter() - started) * 1000)

    result = verification.detail(app_id)
    with repo.db() as db:
        ai_rows = db.execute("SELECT elapsed_ms FROM recruitment_ai_usage WHERE application_id=? AND stage='evidence_evaluation'", (app_id,)).fetchall()
        search_rows = db.execute("SELECT elapsed_ms,error FROM search_executions WHERE claim_id IN (SELECT id FROM resume_claims WHERE application_id=?)", (app_id,)).fetchall()
    return {"mode": label, "claimWorkers": concurrency, "wallMs": wall_ms,
            "jobElapsedMs": result["elapsedMs"], "status": result["status"],
            "claims": len(result["claims"]), "searchRequests": len(search_rows),
            "modelRequests": len(ai_rows), "searchErrors": sum(bool(r["error"]) for r in search_rows),
            "failedClaims": sum(c["analysisStatus"] == "failed" for c in result["claims"]),
            "searchElapsedMsSum": sum(r["elapsed_ms"] or 0 for r in search_rows),
            "modelElapsedMsSum": sum(r["elapsed_ms"] or 0 for r in ai_rows),
            "maxConcurrent": tracker.peak, "requestCounts": tracker.calls,
            "claimStates": [{"category": c["category"], "searchStatus": c["searchStatus"],
                             "analysisStatus": c["analysisStatus"], "retryCount": c["retryCount"],
                             "error": c["conclusion"][:160] if c["analysisStatus"] == "failed" else None}
                            for c in result["claims"]],
            "attributionValid": all(c["searches"] and c["evidence"] and
                                    c["analysisStatus"] == "completed" and
                                    "".join(c["claim"].split("获得")[-1].split("奖项")[0].split())
                                    in "".join(c["searches"][0]["query"].split())
                                    for c in result["claims"])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mode", choices=("both", "sequential", "parallel"), default="both")
    args = parser.parse_args()
    if not os.getenv("SILICONFLOW_API_KEY") or not os.getenv("UAPI_API_KEY"):
        raise SystemExit("Existing local SiliconFlow and UAPI keys are required.")
    with tempfile.TemporaryDirectory(prefix="ttc-v2-benchmark-") as directory:
        with patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory,
                                    "VERIFICATION_ENABLED": "1"}):
            repo.init_db()
            verification.init_db()
            company = repo.create_user("HR", "benchmark@example.test", "correct horse battery",
                                       "hr", "本地测试企业")
            job = repo.create_job(company["companyId"], "奖项核查测试", "仅用于本地性能测试")
            sequential = run_case(company, job, "sequential", 1) if args.mode != "parallel" else None
            parallel = run_case(company, job, "parallel", 3) if args.mode != "sequential" else None
    report = {"fixture": "synthetic resume with three independent award claims",
              "providerModel": config.RECRUITMENT_AI_MODEL,
              "baseline": sequential, "optimized": parallel,
              "speedup": round(sequential["wallMs"] / parallel["wallMs"], 2)
                         if sequential and parallel and parallel["wallMs"] else None,
              "note": "Same workflow with claim concurrency 1 vs 3; live SiliconFlow and UAPI. Concurrency is measured around outbound HTTP inside the global limiter. Isolated temporary SQLite database; external latency can vary."}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
