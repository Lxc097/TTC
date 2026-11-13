"""候选人报告只引用本人的实际发言，不继承面试官的隐藏提示。"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ["TTC_SKIP_DOTENV"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import PhysioSample  # noqa: E402
from report import build_candidate_report  # noqa: E402
from store import Session  # noqa: E402


def session_with_transcript() -> Session:
    session = Session(id="case-1", room_code="ABC123",
                      job_title="后端工程师", started_at=100, ended_at=220,
                      consent=True)
    session.transcript = [
        {"role": "interviewer", "text": "请介绍你的项目。", "t": 3},
        {"role": "candidate", "text": "我们做了订单系统，", "t": 10},
        {"role": "candidate", "text": "团队一起完成了上线。", "t": 14},
        {"role": "interviewer", "text": "你具体负责什么？", "t": 30},
        {"role": "candidate", "text": "我负责接口设计，", "t": 35},
        {"role": "candidate", "text": "最后用压测验证了结果。", "t": 40},
    ]
    return session


class CandidateReportTests(unittest.TestCase):
    def test_uses_real_answers_and_pairs_interviewer_questions(self):
        report = build_candidate_report(session_with_transcript())
        self.assertEqual(report["role"], "candidate")
        self.assertEqual(report["answer_segments"], 2)
        self.assertEqual(report["duration"], 120)
        self.assertEqual(report["observations"][0]["question"], "请介绍你的项目。")
        self.assertEqual(report["observations"][0]["quote"],
                         "我们做了订单系统， 团队一起完成了上线。")
        self.assertEqual(report["observations"][1]["question"], "你具体负责什么？")
        self.assertIn("我负责接口设计", report["observations"][1]["quote"])
        self.assertEqual(report["observations"][0]["clock"], "00:10")

    def test_no_transcript_does_not_invent_insights(self):
        session = Session(id="empty", room_code="ABC123",
                          job_title="后端工程师", started_at=100)
        report = build_candidate_report(session)
        self.assertEqual(report["observations"], [])
        self.assertEqual(report["answer_segments"], 0)
        self.assertIn("没有可供回看", report["summary"])
        self.assertEqual(report["duration"], 0)

    def test_never_inherits_interviewer_metrics_or_raw_signals(self):
        session = session_with_transcript()
        session.samples.append(PhysioSample(t=12, hr=98, quality=0.8))
        session.report = {"role": "interviewer", "points": [{"why": "秘密提示"}]}
        base = {"summary": "内部判断", "points": [{"why": "秘密提示"}],
                "hint_stats": {"adopt_rate": 1}, "verification": {"confirmed": 1},
                "score": 99}
        report = build_candidate_report(session, base)
        for key in ("points", "hint_stats", "verification", "score", "samples"):
            self.assertNotIn(key, report)
        self.assertNotIn("秘密提示", str(report))
        self.assertNotIn("98", str(report))
        self.assertEqual(session.report["role"], "interviewer")


if __name__ == "__main__":
    unittest.main()
