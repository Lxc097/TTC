"""Candidate-consented professional links remain bounded and provenance-labeled."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")

from candidate import recruitment_evidence as evidence  # noqa: E402


class EvidenceProviderTests(unittest.TestCase):
    def test_untrusted_hosts_and_redirect_shapes_are_not_requested(self) -> None:
        for url in (
            "http://github.com/example/repo", "https://localhost/admin",
            "https://127.0.0.1/private", "https://github.com.evil.test/repo",
            "https://user:pass@github.com/repo", "https://github.com:8443/repo",
        ):
            with self.subTest(url=url):
                self.assertIsNone(evidence._safe_url(url))

    def test_opt_out_does_not_make_network_request(self) -> None:
        with patch.object(evidence.urllib.request, "build_opener") as opener:
            items = evidence.verify_supplied_links(["https://github.com/example/repo"], False)
        self.assertEqual(items[0]["verificationStatus"], "not_checked")
        self.assertEqual(items[0]["source"], "candidate_provided")
        opener.return_value.open.assert_not_called()

    def test_github_repo_reachability_never_claims_authorship(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return b'{"full_name":"example/repo"}'

        with patch.object(evidence.urllib.request, "build_opener") as build:
            build.return_value.open.return_value = FakeResponse()
            items = evidence.verify_supplied_links(["https://github.com/example/repo"], True)
            request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/example/repo")
        self.assertEqual(items[0]["verificationStatus"], "public_project_found")
        self.assertIn("不代表候选人身份", items[0]["details"])
        self.assertIn("个人贡献待核实", items[0]["relatedClaim"])
        self.assertGreater(items[0]["checkedAt"], 0)

    def test_checks_at_most_five_unique_links(self) -> None:
        urls = ["https://invalid.example/" + str(i) for i in range(8)]
        with patch.object(evidence.urllib.request, "build_opener") as build:
            items = evidence.verify_supplied_links(urls + [urls[0]], True)
        self.assertEqual(len(items), 5)
        build.return_value.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
