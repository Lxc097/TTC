"""Contract tests for the externally connected recruitment provider adapters."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
from shared import config as recruitment_config  # noqa: E402
from candidate.recruitment_provider_limiter import SharedProviderLimit  # noqa: E402
from candidate.recruitment_providers import (  # noqa: E402
    ProviderError, SiliconFlowProvider, UAPISearchProvider, _ai_limit, _search_limit,
)


class ProviderContractTests(unittest.TestCase):
    def test_chat_returns_parsed_json_and_usage(self) -> None:
        payload = {"choices": [{"message": {"content": '{"ok":true}'}}],
                   "model": "deepseek-ai/DeepSeek-V4-Flash",
                   "usage": {"total_tokens": 42}}
        with patch("candidate.recruitment_providers._http_json", return_value=(payload, {"traceId": "t1", "elapsedMs": 2})) as request:
            result, meta = SiliconFlowProvider(api_key="test", model="deepseek-ai/DeepSeek-V4-Flash").chat_json("system", "user")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(meta["totalTokens"], 42)
        self.assertEqual(request.call_args.args[0], "https://api.siliconflow.cn/v1/chat/completions")
        self.assertEqual(request.call_args.kwargs["body"]["reasoning_effort"], "high")

    def test_chat_rejects_non_object_and_does_not_send_unsupported_effort(self) -> None:
        with patch("candidate.recruitment_providers._http_json", return_value=({"choices": [{"message": {"content": "[]"}}]}, {"traceId": "t2"})) as request:
            with self.assertRaises(ProviderError):
                SiliconFlowProvider(api_key="test", model="other-model").chat_json("system", "user")
        self.assertNotIn("reasoning_effort", request.call_args.kwargs["body"])

    def test_search_normalizes_and_deduplicates(self) -> None:
        response = {"results": [{"url": "https://official.example/award", "title": "Award", "snippet": "名单", "publish_time": "2024-11-01"},
                                {"url": "https://official.example/award", "title": "Duplicate"}]}
        with patch("candidate.recruitment_providers._http_json", return_value=(response, {"traceId": "t3"})):
            result = UAPISearchProvider(api_key="test").search("2024 获奖名单", filetype="pdf")
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["results"][0]["publishedAt"], "2024-11-01")
        self.assertEqual(result["authMode"], "api_key")

    def test_identical_search_uses_cached_public_result(self) -> None:
        response = {"results": [{"url": "https://official.example/notice"}]}
        provider = UAPISearchProvider(api_key="test")
        with patch("candidate.recruitment_providers._http_json", return_value=(response, {"traceId": "t4"})) as request:
            first = provider.search("独立缓存测试赛事 2024")
            second = provider.search("独立缓存测试赛事 2024")
        self.assertEqual(request.call_count, 1)
        self.assertFalse(first["requestMeta"]["cacheHit"])
        self.assertTrue(second["requestMeta"]["cacheHit"])

    def test_simultaneous_identical_search_is_single_flight(self) -> None:
        response = {"results": [{"url": "https://official.example/single-flight"}]}
        barrier = threading.Barrier(4)
        request_count = 0
        count_lock = threading.Lock()

        def request(*args, **kwargs):
            nonlocal request_count
            with count_lock:
                request_count += 1
            time.sleep(0.15)
            return response, {"traceId": "single-flight"}

        provider = UAPISearchProvider(api_key="test")
        with patch("candidate.recruitment_providers._http_json", side_effect=request):
            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = [executor.submit(lambda: (barrier.wait(), provider.search("赛事 2026 single flight"))[1])
                           for _ in range(3)]
                barrier.wait()
                results = [future.result(timeout=5) for future in futures]
        self.assertEqual(request_count, 1)
        self.assertEqual(sum(result["requestMeta"]["cacheHit"] for result in results), 2)

    def test_global_limits_match_configuration(self) -> None:
        self.assertEqual(_ai_limit.limit, recruitment_config.AI_MAX_CONCURRENCY)
        self.assertEqual(_search_limit.limit, recruitment_config.SEARCH_MAX_CONCURRENCY)
        self.assertIsInstance(_ai_limit, SharedProviderLimit)
        self.assertIsInstance(_search_limit, SharedProviderLimit)

    def test_streaming_lease_releases_after_thread_hop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "provider_limits.sqlite3"
            limit = SharedProviderLimit("ai", 1, database_path=database)

            def chunks():
                with limit.lease():
                    yield "first"
                    yield "second"

            stream = chunks()
            for expected in ("first", "second"):
                with ThreadPoolExecutor(max_workers=1) as executor:
                    self.assertEqual(executor.submit(next, stream).result(timeout=3), expected)
            with ThreadPoolExecutor(max_workers=1) as executor:
                with self.assertRaises(StopIteration):
                    executor.submit(next, stream).result(timeout=3)
            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM provider_leases").fetchone()[0], 0)
            finally:
                connection.close()

    def test_sqlite_limit_blocks_another_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "provider_limits.sqlite3"
            script = """
import sys
from pathlib import Path
from candidate.recruitment_provider_limiter import SharedProviderLimit
kind = sys.argv[1]
db, ready, acquired = map(Path, sys.argv[2:])
ready.write_text('1')
with SharedProviderLimit(kind, 1, database_path=db, retry_seconds=.02):
    acquired.write_text('1')
"""
            for kind in ("ai", "search"):
                with self.subTest(kind=kind):
                    ready = Path(directory) / f"{kind}-ready"
                    acquired = Path(directory) / f"{kind}-acquired"
                    limit = SharedProviderLimit(kind, 1, database_path=database, retry_seconds=.02)
                    child = None
                    try:
                        with limit:
                            child = subprocess.Popen(
                                [sys.executable, "-c", script, kind, str(database),
                                 str(ready), str(acquired)],
                                cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                            deadline = time.monotonic() + 5
                            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                                time.sleep(.02)
                            self.assertTrue(ready.exists(), "child did not reach the limiter")
                            time.sleep(.2)
                            self.assertFalse(acquired.exists(), "child exceeded the global cap")
                        stdout, stderr = child.communicate(timeout=5)
                        self.assertEqual(child.returncode, 0, stderr or stdout)
                        self.assertTrue(acquired.exists())
                    finally:
                        if child is not None and child.poll() is None:
                            child.kill()
                            child.communicate()

    def test_markdown_waits_for_completed_task(self) -> None:
        responses = [({"task_id": "id-1", "status": "pending"}, {"traceId": "a"}),
                     ({"task_id": "id-1", "status": "processing"}, {"traceId": "b"}),
                     ({"task_id": "id-1", "status": "completed", "result": {"markdown": "# Evidence"}}, {"traceId": "c"})]
        with patch("candidate.recruitment_providers._http_json", side_effect=responses) as request, patch("candidate.recruitment_providers.time.sleep"):
            result = UAPISearchProvider(api_key="test").fetch_markdown("https://official.example/award")
        self.assertEqual(result["markdown"], "# Evidence")
        self.assertEqual(result["taskId"], "id-1")
        self.assertIn("?url=https%3A%2F%2Fofficial.example%2Faward", request.call_args_list[0].args[0])
        self.assertEqual(request.call_args_list[0].kwargs["body"], {})

    def test_missing_key_and_bad_urls_fail_explicitly(self) -> None:
        with self.assertRaises(ProviderError):
            SiliconFlowProvider(api_key="").chat_json("system", "user")
        with self.assertRaises(ValueError):
            UAPISearchProvider().fetch_markdown("http://127.0.0.1/admin")


if __name__ == "__main__":
    unittest.main()
