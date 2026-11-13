"""FacePhys Provider 的单测 —— 不需要网络、不消耗 Token。

用假 transport 验证：签名算法、三步流程顺序、请求体字段、返回映射、闸门。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("TTC_API_KEY_ID", "dummy-key-id")
os.environ.setdefault("TTC_API_SECRET", "dummy-secret")

import config                                    # noqa: E402
from vision_facephys import FacePhysError, FacePhysProvider   # noqa: E402

KEY, SECRET = "test-key-id", "test-secret"


class FakeTransport:
    """记录每次调用，返回可编排的假响应。"""

    def __init__(self, presign_status=200, process_status=200,
                 upload_status=200, process_body=None):
        self.calls: list[tuple] = []
        self.presign_status = presign_status
        self.process_status = process_status
        self.upload_status = upload_status
        self.process_body = process_body or {
            "data": {
                "cardiac": {"hr": 78.2, "sqi": 0.62,
                            "hrv": {"sdnn": 45.1}},
                "breathing_rate": 16.0,
                "tokens_deducted": 120,
                "remaining_tokens": 999880,
            }
        }

    def __call__(self, method, url, body, headers, timeout):
        self.calls.append((method, url, body, headers))
        if url.endswith("/api/v2/video/upload/presign"):
            if self.presign_status != 200:
                return self.presign_status, b'{"error":"invalid API key"}'
            return 200, json.dumps({
                "uploadUrl": "https://oss.example.com/bucket/k1?sign=x",
                "objectKey": "uploads/k1.mp4",
            }).encode()
        if method == "PUT":
            return self.upload_status, b""
        if url.endswith("/api/v3/video/process"):
            if self.process_status != 200:
                return self.process_status, b'{"error":"bad video"}'
            return 200, json.dumps(self.process_body).encode()
        return 404, b""


def make(transport=None) -> FacePhysProvider:
    return FacePhysProvider(key_id=KEY, secret=SECRET,
                            base_url="https://www.facephys.com",
                            transport=transport or FakeTransport(),
                            timeout=5)


class TestSignature(unittest.TestCase):
    def test_matches_reference_hmac(self):
        p = make()
        h = p.auth_headers(ts=1700000000)
        expect = base64.b64encode(
            hmac.new(SECRET.encode(), b"1700000000",
                     hashlib.sha256).digest()).decode()
        self.assertEqual(h["x-signature"], expect)

    def test_header_names_and_types(self):
        h = make().auth_headers(ts=1700000000)
        self.assertEqual(set(h), {"x-key-id", "x-timestamp", "x-signature"})
        self.assertEqual(h["x-key-id"], KEY)
        self.assertEqual(h["x-timestamp"], "1700000000")   # 秒级字符串
        self.assertIsInstance(h["x-timestamp"], str)
        self.assertEqual(len(h["x-signature"]), 44, "SHA256 的 base64 是 44 字符")

    def test_default_timestamp_is_seconds(self):
        import time
        h = make().auth_headers()
        self.assertLess(abs(int(h["x-timestamp"]) - int(time.time())), 5)

    def test_signature_changes_with_timestamp(self):
        p = make()
        self.assertNotEqual(p.auth_headers(ts=1)["x-signature"],
                            p.auth_headers(ts=2)["x-signature"])

    def test_missing_credentials_raises(self):
        old_k = os.environ.pop("TTC_API_KEY_ID", None)
        old_s = os.environ.pop("TTC_API_SECRET", None)
        try:
            with self.assertRaises(RuntimeError):
                FacePhysProvider(key_id="", secret="", base_url="https://x",
                                 transport=FakeTransport())
        finally:
            if old_k is not None:
                os.environ["TTC_API_KEY_ID"] = old_k
            if old_s is not None:
                os.environ["TTC_API_SECRET"] = old_s


class TestProcessFlow(unittest.TestCase):
    def test_three_steps_in_order(self):
        t = FakeTransport()
        p = make(t)
        p.process_video(b"\x00" * 1000)

        methods = [(c[0], c[1]) for c in t.calls]
        self.assertEqual(len(methods), 3)

        # 1. presign，带签名头
        self.assertEqual(methods[0][0], "POST")
        self.assertTrue(methods[0][1].endswith("/api/v2/video/upload/presign"))
        self.assertIn("x-signature", t.calls[0][3])

        # 2. PUT 直传，不带签名（OSS 预签名 URL 自带授权）
        self.assertEqual(methods[1][0], "PUT")
        self.assertIn("oss.example.com", methods[1][1])
        self.assertNotIn("x-signature", t.calls[1][3])

        # 3. 提交检测
        self.assertEqual(methods[2][0], "POST")
        self.assertTrue(methods[2][1].endswith("/api/v3/video/process"))

    def test_process_payload_uses_object_key_and_rppg(self):
        t = FakeTransport()
        make(t).process_video(b"x")
        body = json.loads(t.calls[2][2].decode())
        self.assertEqual(body["objectKey"], "uploads/k1.mp4")
        self.assertEqual(body["capability"], "rppg",
                         "capability 只能是 rppg，full 是 fieldSet")

    def test_sends_browser_user_agent(self):
        """Cloudflare 会拦 Python-urllib 的默认 UA（403 / error code 1010）。

        这个坑看起来像"签名不对"，其实跟签名无关，必须钉住。
        """
        t = FakeTransport()
        make(t).process_video(b"x")
        self.assertEqual(len(t.calls), 3)
        for method, url, _body, headers in t.calls:
            self.assertIn("User-Agent", headers, f"{method} {url} 缺少 UA")
            self.assertIn("Mozilla", headers["User-Agent"])

    def test_upload_content_type_video(self):
        t = FakeTransport()
        make(t).process_video(b"x", "video/webm")
        self.assertEqual(t.calls[1][3]["Content-Type"], "video/webm")

    def test_presign_401_raises(self):
        t = FakeTransport(presign_status=401)
        with self.assertRaises(FacePhysError) as ctx:
            make(t).process_video(b"x")
        self.assertIn("401", str(ctx.exception))

    def test_upload_failure_raises(self):
        t = FakeTransport(upload_status=500)
        with self.assertRaises(FacePhysError):
            make(t).process_video(b"x")


class TestToSample(unittest.TestCase):
    def _data(self, **kw):
        return {"cardiac": {"hr": 78.2, "sqi": 0.62}, **kw}

    def test_nested_v3_structure(self):
        p = make()
        s = p.to_sample(self._data(breathing_rate=16.0), 30.0)
        self.assertAlmostEqual(s.hr, 78.2)
        self.assertAlmostEqual(s.rr, 16.0)
        self.assertAlmostEqual(s.quality, 0.62)
        self.assertEqual(s.face_count, 1)
        self.assertTrue(s.usable)

    def test_flat_v2_structure(self):
        p = make()
        s = p.to_sample({"hr": 70.0, "sqi": 0.5, "breathing_rate": 15.0}, 1.0)
        self.assertAlmostEqual(s.hr, 70.0)
        self.assertAlmostEqual(s.quality, 0.5)

    def test_confidence_fallback(self):
        p = make()
        s = p.to_sample({"hr": 70.0, "confidence": 0.8}, 1.0)
        self.assertAlmostEqual(s.quality, 0.8)

    def test_out_of_range_hr_rejected(self):
        p = make()
        s = p.to_sample({"cardiac": {"hr": 250, "sqi": 0.9}}, 1.0)
        self.assertIsNone(s.hr)
        self.assertEqual(s.quality, 0.0)
        self.assertFalse(s.usable)

    def test_low_sqi_marks_unusable(self):
        p = make()
        s = p.to_sample({"cardiac": {"hr": 72, "sqi": 0.1}}, 1.0)
        self.assertLess(s.quality, config.MIN_QUALITY)
        self.assertFalse(s.usable, "sqi 低于阈值的数据不能进基线")

    def test_remembers_remaining_tokens(self):
        p = make()
        p.to_sample({"cardiac": {"hr": 70, "sqi": 0.5},
                     "remaining_tokens": 999000}, 1.0)
        self.assertEqual(p.tokens_left, 999000)


class TestInterface(unittest.TestCase):
    def test_sample_returns_none_in_video_mode(self):
        """视频形态绝不能对单帧编造采样，否则会污染基线（老 bug 的同类）。"""
        self.assertIsNone(make().sample(b"frame", 1.0))
        self.assertIsNone(make().sample_segment([b"a", b"b"], 1.0))

    def test_flags(self):
        p = make()
        self.assertTrue(p.wants_video)
        self.assertFalse(p.wants_segment)

    def test_empty_video_short_circuits(self):
        t = FakeTransport()
        s = make(t).sample_video(b"", 1.0)
        self.assertEqual(s.quality, 0.0)
        self.assertEqual(t.calls, [], "空视频不该发起任何网络请求")


if __name__ == "__main__":
    unittest.main(verbosity=2)
