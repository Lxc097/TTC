"""引擎单测（只用标准库，不需要装 fastapi）。

跑法：
    cd backend
    python -m unittest discover -s tests -v

这些测试覆盖的是全项目唯一有算法含量的部分：
基线 / 稳健 z / 双确认 / 提示确定性 / 冷却。
"""
from __future__ import annotations

import os
import sys
import unittest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

# 测试用短基线，别等 60 秒
os.environ["BASELINE_SECONDS"] = "20"
os.environ["BASELINE_MIN_SAMPLES"] = "5"

import config          # noqa: E402
import engine          # noqa: E402
from engine import (   # noqa: E402
    Baseline, Behavior, PhysioSample, Turn, judge_turn, robust_z, summarize_turn,
)


def samples(n: int = 10, hr: float = 72.0, t0: float = 0.0, dt: float = 2.0):
    """构造带抖动的心率样本：71,72,73 循环 → med=72, mad=1。"""
    out = []
    for i in range(n):
        out.append(PhysioSample(
            t=t0 + i * dt,
            hr=hr + ((i % 3) - 1),
            rr=15.0 + ((i % 3) - 1) * 0.3,
            quality=0.9,
            face_count=1,
        ))
    return out


def ready_baseline() -> Baseline:
    b = Baseline()
    for s in samples(n=10):
        b.add(s)
    b.freeze()
    return b


class TestRobustZ(unittest.TestCase):
    def test_sharp_deviation(self):
        # hr 从 72 突然跳到 88，mad=1
        self.assertAlmostEqual(robust_z(88, 72, 1), 10.792, places=3)

    def test_zero_mad_is_silent(self):
        # 基线完全无波动时无信息量，必须静默而不是爆炸
        self.assertEqual(robust_z(120, 72, 0.0), 0.0)
        self.assertEqual(robust_z(120, 72, 1e-9), 0.0)


class TestBaseline(unittest.TestCase):
    def test_not_ready_initially(self):
        self.assertFalse(Baseline().ready)

    def test_becomes_ready(self):
        b = ready_baseline()
        self.assertTrue(b.ready)
        self.assertAlmostEqual(b.hr_med, 72.0, places=3)
        self.assertAlmostEqual(b.hr_mad, 1.0, places=3)

    def test_rejects_low_quality(self):
        b = Baseline()
        b.add(PhysioSample(t=0, hr=72, rr=15, quality=0.1, face_count=1))
        self.assertEqual(len(b.hr), 0, "低质量数据必须被丢弃")

    def test_rejects_multi_face(self):
        b = Baseline()
        b.add(PhysioSample(t=0, hr=72, rr=15, quality=0.9, face_count=2))
        self.assertEqual(len(b.hr), 0, "画面里不止一张脸时基线不可用")

    def test_load_z_zero_before_ready(self):
        b = Baseline()
        b.add(PhysioSample(t=0, hr=120, rr=30, quality=0.9, face_count=1))
        self.assertEqual(b.load_z(PhysioSample(t=1, hr=120)), 0.0)

    def test_load_z_positive_under_stress(self):
        b = ready_baseline()
        z = b.load_z(PhysioSample(t=25, hr=88, rr=17, quality=0.9))
        self.assertGreater(z, 1.5)


class TestDoubleConfirmation(unittest.TestCase):
    """双确认：生理 ∧ 行为。任何单独信号都不许出提示。"""

    def test_high_phys_but_no_behavior_is_silent(self):
        turn = Turn(turn_id=1, start_t=0, end_t=30, phys_peak=3.0,
                    transcript="x" * 40)
        # 行为侧全 0 → 不许出提示
        self.assertIsNone(judge_turn(turn, ready_baseline()))

    def test_high_behavior_but_normal_phys_is_silent(self):
        turn = Turn(turn_id=1, start_t=0, end_t=30, phys_peak=0.2,
                    beh=Behavior(pause_ratio=0.9), transcript="x" * 40)
        self.assertIsNone(judge_turn(turn, ready_baseline()))

    def test_both_abnormal_gives_probe(self):
        turn = Turn(turn_id=1, start_t=0, end_t=30, phys_peak=2.2,
                    beh=Behavior(pause_ratio=0.8), transcript="x" * 40)
        hint = judge_turn(turn, ready_baseline())
        self.assertIsNotNone(hint)
        self.assertEqual(hint.kind, "probe")
        self.assertLessEqual(len(hint.text), 12, "提示文案必须短到能一眼看完")
        self.assertIn("2.2", hint.why)

    def test_not_ready_baseline_blocks_everything(self):
        turn = Turn(turn_id=1, start_t=0, end_t=30, phys_peak=9.9,
                    beh=Behavior(pause_ratio=0.9), transcript="x" * 40)
        self.assertIsNone(judge_turn(turn, Baseline()))


class TestHintPolicy(unittest.TestCase):
    def test_deterministic_across_calls(self):
        """同一个 turn_id 必须永远出同一条 —— 否则 demo 没法排练。"""
        turn = Turn(turn_id=7, start_t=0, end_t=30, phys_peak=2.5,
                    beh=Behavior(pause_ratio=0.8), transcript="x" * 40)
        a = judge_turn(turn, ready_baseline())
        b = judge_turn(turn, ready_baseline())
        self.assertEqual(a.text, b.text)

    def test_cooldown_suppresses(self):
        turn = Turn(turn_id=2, start_t=0, end_t=30, phys_peak=2.5,
                    beh=Behavior(pause_ratio=0.8), transcript="x" * 40)
        hint = judge_turn(turn, ready_baseline(), last_hint_t=25.0)
        self.assertIsNone(hint, f"{config.HINT_COOLDOWN}s 冷却期内必须静默")

    def test_cooldown_expires(self):
        turn = Turn(turn_id=2, start_t=0, end_t=200, phys_peak=2.5,
                    beh=Behavior(pause_ratio=0.8), transcript="x" * 40)
        self.assertIsNotNone(judge_turn(turn, ready_baseline(), last_hint_t=0.0))

    def test_upgrade_when_too_easy(self):
        turn = Turn(turn_id=3, start_t=0, end_t=30, phys_peak=0.0,
                    phys_mean=-1.0, transcript="x" * 40)
        hint = judge_turn(turn, ready_baseline())
        self.assertIsNotNone(hint)
        self.assertEqual(hint.kind, "upgrade")

    def test_wrap_beats_probe_on_second_hot_turn(self):
        prev = Turn(turn_id=1, start_t=0, end_t=30, phys_peak=2.0)
        turn = Turn(turn_id=2, start_t=40, end_t=70, phys_peak=2.0,
                    beh=Behavior(speech_rate_drop=0.6), transcript="x" * 40)
        hint = judge_turn(turn, ready_baseline(), prev_turns=[prev])
        self.assertIsNotNone(hint)
        self.assertEqual(hint.kind, "wrap", "连续高负荷时应该叫停而不是继续追")


class TestSummarize(unittest.TestCase):
    def test_window_picks_peak(self):
        b = ready_baseline()
        turn = Turn(turn_id=1, start_t=10, end_t=20)
        samples_in_window = [
            PhysioSample(t=5, hr=72, rr=15, quality=0.9),   # 窗外，忽略
            PhysioSample(t=12, hr=74, rr=15, quality=0.9),
            PhysioSample(t=18, hr=88, rr=17, quality=0.9),  # 窗外应力峰值
        ]
        summarize_turn(turn, samples_in_window, b)
        self.assertGreater(turn.phys_peak, 3.0)
        self.assertLess(turn.phys_mean, turn.phys_peak)


if __name__ == "__main__":
    unittest.main(verbosity=2)
