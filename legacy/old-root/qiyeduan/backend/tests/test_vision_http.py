"""真实 API 适配层的解析单测 —— 不需要网络。

用各种"厂商可能返回的样子"喂 parse()，保证映射和合理性闸门是对的。
"""
from __future__ import annotations

import os
import sys
import unittest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

os.environ.setdefault("VISION_API_URL", "http://localhost:0/fake")

from vision_http import HttpVisionProvider   # noqa: E402


class TestParse(unittest.TestCase):
    def setUp(self) -> None:
        self.p = HttpVisionProvider(url="http://localhost:0/fake")

    def test_nested_data_object(self):
        s = self.p.parse({"data": {"heart_rate": 78.2, "breath_rate": 16.1,
                                   "quality": 0.91, "face_count": 1}}, 10.0)
        self.assertAlmostEqual(s.hr, 78.2)
        self.assertAlmostEqual(s.rr, 16.1)
        self.assertAlmostEqual(s.quality, 0.91)
        self.assertEqual(s.face_count, 1)
        self.assertTrue(s.usable)

    def test_flat_string_values(self):
        s = self.p.parse({"hr": "75", "rr": "15"}, 1.0)
        self.assertAlmostEqual(s.hr, 75.0)
        self.assertAlmostEqual(s.rr, 15.0)
        # 没给 quality，有人脸+有心率 → 派生 0.8
        self.assertAlmostEqual(s.quality, 0.8)

    def test_array_takes_latest(self):
        s = self.p.parse({"data": [{"heart_rate": 70}, {"heart_rate": 84}]}, 2.0)
        self.assertAlmostEqual(s.hr, 84.0, msg="数组应取最后一帧")

    def test_alias_signal_quality(self):
        s = self.p.parse({"data": {"heart_rate": 72, "signal_quality": 0.66}}, 3.0)
        self.assertAlmostEqual(s.quality, 0.66)

    def test_out_of_range_hr_is_rejected(self):
        """rPPG 抖动吐 250bpm 时，必须判无效而不是当真。"""
        s = self.p.parse({"data": {"heart_rate": 250, "quality": 0.9}}, 4.0)
        self.assertIsNone(s.hr)
        self.assertEqual(s.quality, 0.0)
        self.assertFalse(s.usable)

    def test_no_face(self):
        s = self.p.parse({"data": {"face_count": 0, "quality": 0.9}}, 5.0)
        self.assertEqual(s.face_count, 0)
        self.assertEqual(s.quality, 0.0)
        self.assertFalse(s.usable)

    def test_multi_face_rejected(self):
        s = self.p.parse({"data": {"face_count": 2, "heart_rate": 80,
                                   "quality": 0.95}}, 6.0)
        self.assertEqual(s.face_count, 2)
        self.assertEqual(s.quality, 0.0, "多人脸时基线不可用")

    def test_empty_payload(self):
        s = self.p.parse({}, 7.0)
        self.assertIsNone(s.hr)
        self.assertEqual(s.quality, 0.0)

    def test_custom_field_mapping(self):
        p = HttpVisionProvider(url="http://localhost:0/fake")
        p.paths["hr"] = "result.physio.bpm"
        s = p.parse({"result": {"physio": {"bpm": 81}}}, 8.0)
        self.assertAlmostEqual(s.hr, 81.0)

    def test_quality_clamped(self):
        s = self.p.parse({"data": {"heart_rate": 70, "quality": 1.7}}, 9.0)
        self.assertEqual(s.quality, 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
