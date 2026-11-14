"""Strict screening output validation and bounded provider failure behavior."""
from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")

from candidate import resume_screening_service as service  # noqa: E402

RESUME = {"rawText": "Frontend resume: React cache invalidation."}
JOB = {"title": "Frontend Engineer", "description":
       "Build React and TypeScript interfaces, improve performance, explain trade-offs, and collaborate with designers and engineers."}


def valid_report() -> dict:
    return {
        "candidateSummary": "Resume claims a React performance project.",
        "jobMatch": {"score": 70, "scoreBasis": "The resume mentions React but has limited detail.",
                     "matchedRequirements": ["React"], "missingRequirements": ["Accessibility"],
                     "evidence": [{"requirement": "React", "sourceText": "React",
                                   "support": "This term occurs in the resume."}]},
        "resumeClaims": [{"claim": "Cache invalidation work",
                          "sourceText": "React cache invalidation",
                          "verificationStatus": "unverified", "confidence": None,
                          "supportingEvidence": [],
                          "followUpQuestion": "What cache invalidation strategy did you use?"}],
        "strengths": ["Related React work"],
        "areasToVerify": ["Individual contribution"],
        "interviewQuestions": ["Explain your cache invalidation strategy."],
        "screeningRecommendation": "manual_review",
        "recommendationReasons": ["Project details are incomplete."],
        "limitations": [],
    }


class ScreeningServiceTests(unittest.TestCase):
    def test_valid_report_keeps_provenance_and_marks_no_external_verification(self) -> None:
        result = service.validate_report(valid_report(), RESUME["rawText"], JOB["description"])
        self.assertEqual(result["jobMatch"]["score"], 70)
        self.assertIn("未进行外部核验。", result["limitations"])

    def test_drops_unmatched_quotes_and_withholds_unfounded_score(self) -> None:
        fabricated = valid_report()
        fabricated["resumeClaims"][0]["sourceText"] = "invented employer and degree"
        fabricated["jobMatch"]["evidence"][0]["sourceText"] = "invented React employer"
        result = service.validate_report(fabricated, RESUME["rawText"], JOB["description"])
        self.assertEqual(result["resumeClaims"], [])
        self.assertEqual(result["jobMatch"]["evidence"], [])
        self.assertIsNone(result["jobMatch"]["score"])
        self.assertTrue(any("引用" in item for item in result["limitations"]))
        thin = service.validate_report(valid_report(), RESUME["rawText"], "React developer")
        self.assertIsNone(thin["jobMatch"]["score"])

    def test_rejects_unsupported_external_support_extra_field_and_status(self) -> None:
        cases = []
        unsupported = valid_report()
        unsupported["resumeClaims"][0]["verificationStatus"] = "external_supported"
        cases.append((unsupported, JOB["description"]))
        extra = valid_report()
        extra["secretDecision"] = "reject"
        cases.append((extra, JOB["description"]))
        unsupported_status = valid_report()
        unsupported_status["screeningRecommendation"] = "auto_reject"
        cases.append((unsupported_status, JOB["description"]))
        for value, jd in cases:
            with self.subTest(case=value), self.assertRaises(service.ScreeningError):
                service.validate_report(value, RESUME["rawText"], jd)

    def test_retry_is_bounded_and_metadata_records_actual_attempt(self) -> None:
        invalid = copy.deepcopy(valid_report())
        invalid["screeningRecommendation"] = "auto_reject"
        with (
            patch.dict(os.environ, {"SILICONFLOW_API_KEY": "dummy-test-key"}),
            patch.object(service, "_request", side_effect=[
                (invalid, {}), (valid_report(), {"promptTokens": 10, "completionTokens": 20}),
            ]) as request,
            patch.object(service.time, "sleep"),
        ):
            result, meta = service.screen_resume(RESUME, JOB)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(meta["attempts"], 2)
        self.assertEqual(meta["promptTokens"], 10)
        self.assertEqual(result["screeningRecommendation"], "manual_review")

        with (
            patch.dict(os.environ, {"SILICONFLOW_API_KEY": "dummy-test-key"}),
            patch.object(service, "_request", return_value=(invalid, {})) as request,
            patch.object(service.time, "sleep"),
        ):
            with self.assertRaises(service.ScreeningError):
                service.screen_resume(RESUME, JOB)
        self.assertEqual(request.call_count, 3)

    def test_missing_key_never_calls_provider(self) -> None:
        with (
            patch.dict(os.environ, {"SILICONFLOW_API_KEY": ""}),
            patch.object(service, "_request") as request,
        ):
            with self.assertRaises(service.ScreeningError):
                service.screen_resume(RESUME, JOB)
        request.assert_not_called()

    def test_malformed_upstream_json_and_timeout_do_not_leak_input(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"choices": [{"message": {"content": "not-json"}}]}).encode()

        with (
            patch.dict(os.environ, {"SILICONFLOW_API_KEY": "dummy-test-key"}),
            patch.object(service.urllib.request, "urlopen", return_value=FakeResponse()) as call,
            patch.object(service.time, "sleep"),
        ):
            with self.assertRaisesRegex(service.ScreeningError, "JSON"):
                service.screen_resume(RESUME, JOB)
        self.assertEqual(call.call_count, 3)

        with (
            patch.dict(os.environ, {"SILICONFLOW_API_KEY": "dummy-test-key"}),
            patch.object(service.urllib.request, "urlopen",
                         side_effect=TimeoutError("private resume text and dummy-test-key")) as call,
            patch.object(service.time, "sleep"),
        ):
            with self.assertRaises(service.ScreeningError) as captured:
                service.screen_resume(RESUME, JOB)
        self.assertEqual(call.call_count, 3)
        self.assertNotIn("private resume text", str(captured.exception))
        self.assertNotIn("dummy-test-key", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
