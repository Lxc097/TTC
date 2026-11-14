"""测试口令门禁：签名、过期、跳转白名单，以及 HTTP / WebSocket 两条链路。"""
from __future__ import annotations

import time
import unittest

from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocket

import access_gate
from access_gate import AccessGate, make_token, token_ok

CODE = "team-only-2026"


# ---------------------------------------------------------------- 签名层
class TestToken(unittest.TestCase):
    def test_roundtrip(self):
        self.assertTrue(token_ok(make_token(CODE), CODE))

    def test_wrong_code_rejected(self):
        self.assertFalse(token_ok(make_token(CODE), "another-code"))

    def test_tampered_signature_rejected(self):
        version, issued, sig = make_token(CODE).split(".")
        forged = f"{version}.{issued}.{'0' * len(sig)}"
        self.assertFalse(token_ok(forged, CODE))

    def test_garbage_rejected(self):
        for junk in ("", "garbage", "v1", "v1.notanint.deadbeef", "v2.1.deadbeef"):
            with self.subTest(junk=junk):
                self.assertFalse(token_ok(junk, CODE))

    def test_expiry(self):
        stale = make_token(CODE, issued=int(time.time()) - 40 * 86400)
        self.assertFalse(token_ok(stale, CODE, days=14), "超过有效期的 cookie 必须失效")
        self.assertTrue(token_ok(stale, CODE, days=0), "days=0 表示只看签名，不看时间")

    def test_fresh_token_survives_short_window(self):
        self.assertTrue(token_ok(make_token(CODE), CODE, days=14))

    def test_empty_code_never_validates(self):
        self.assertFalse(token_ok(make_token(CODE), ""))


# ---------------------------------------------------------------- 中间件层
def _app(code: str = CODE, days: int = 14) -> Starlette:
    async def home(request):
        return PlainTextResponse("home")

    async def api(request):
        return JSONResponse({"ok": True})

    async def health(request):
        return JSONResponse({"ok": True})

    async def socket(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("connected")
        await websocket.close()

    app = Starlette(routes=[
        Route("/", home),
        Route("/api/x", api),
        Route("/healthz", health),
        Route("/__access", home, methods=["GET"]),
        WebSocketRoute("/ws/room/{code}", socket),
    ])
    if code:
        app.add_middleware(AccessGate, code=code, days=days)
    return app


class TestGateHttp(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(_app())

    def test_page_requires_code(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 401)
        self.assertIn("TTC 测试通道", response.text)

    def test_api_returns_json_401(self):
        response = self.client.get("/api/x")
        self.assertEqual(response.status_code, 401)
        self.assertIn("需要测试口令", response.json()["detail"])

    def test_healthz_is_open(self):
        self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_wrong_code_keeps_gate_shut(self):
        response = self.client.post("/__access", data={"code": "nope", "next": "/"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.get("/api/x").status_code, 401)

    def test_right_code_opens_the_gate(self):
        response = self.client.post("/__access", data={"code": CODE, "next": "/api/x"},
                                    follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/api/x")
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertEqual(self.client.get("/api/x").status_code, 200)

    def test_cookie_is_honoured_for_pages(self):
        self.client.post("/__access", data={"code": CODE, "next": "/"}, follow_redirects=False)
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_forged_cookie_rejected(self):
        self.client.cookies.set(access_gate.COOKIE_NAME, "v1.1.deadbeef")
        self.assertEqual(self.client.get("/api/x").status_code, 401)

    def test_open_redirect_blocked(self):
        response = self.client.post("/__access", data={"code": CODE, "next": "//evil.example.com"},
                                    follow_redirects=False)
        self.assertEqual(response.headers["location"], "/")

    def test_next_with_backslash_blocked(self):
        response = self.client.post("/__access", data={"code": CODE, "next": "/\\evil.example.com"},
                                    follow_redirects=False)
        self.assertEqual(response.headers["location"], "/")

    def test_authenticated_404_stays_404(self):
        """登录后不该把 404 也变成 401 —— 否则前端分不清"没权限"和"没这个接口"。"""
        self.client.post("/__access", data={"code": CODE}, follow_redirects=False)
        self.assertEqual(self.client.get("/api/missing").status_code, 404)


class TestGateWebSocket(unittest.TestCase):
    def test_socket_blocked_without_cookie(self):
        client = TestClient(_app())
        with self.assertRaises(Exception):
            with client.websocket_connect("/ws/room/ABC123"):
                pass

    def test_socket_open_after_login(self):
        client = TestClient(_app())
        client.post("/__access", data={"code": CODE}, follow_redirects=False)
        with client.websocket_connect("/ws/room/ABC123") as ws:
            self.assertEqual(ws.receive_text(), "connected")


class TestGateDisabled(unittest.TestCase):
    def test_empty_code_leaves_app_untouched(self):
        client = TestClient(_app(code=""))
        self.assertEqual(client.get("/").status_code, 200)
        self.assertEqual(client.get("/api/x").status_code, 200)
        with client.websocket_connect("/ws/room/ABC123") as ws:
            self.assertEqual(ws.receive_text(), "connected")


# ---------------------------------------------------------------- demo_enabled 的判据
class TestDemoEnabledCredential(unittest.TestCase):
    """``demo_enabled()`` 的第二个判据：口令已验证。

    这条是本次改动的重点 —— 原来的"客户端是 loopback"一旦套反代就永远为真，
    所以必须有一个不依赖客户端地址的判据。
    """

    def test_verified_request_matches_cookie(self):
        token = make_token(CODE)
        self.assertTrue(token_ok(token, CODE, 14))
        self.assertFalse(access_gate.token_ok("", CODE, 14))

    def test_verified_request_ignores_absent_code(self):
        self.assertFalse(access_gate.verified_request(_FakeRequest({}), "", 14))
        self.assertTrue(access_gate.verified_request(
            _FakeRequest({access_gate.COOKIE_NAME: make_token(CODE)}), CODE, 14))
        self.assertFalse(access_gate.verified_request(
            _FakeRequest({access_gate.COOKIE_NAME: make_token(CODE)}), "other", 14))


class _FakeRequest:
    """只需要 ``.cookies``，不必拖一整个 ASGI scope。"""

    def __init__(self, cookies: dict):
        self.cookies = cookies


class TestDemoEnabledIntegration(unittest.TestCase):
    """把 demo_enabled 真的跑一遍：没有口令时，远端请求依然被拒。"""

    def test_remote_request_needs_code(self):
        import os

        from candidate import recruitment_api
        from shared import config

        previous = os.environ.get("RECRUITMENT_DEMO_MODE")
        original = config.ACCESS_CODE
        os.environ["RECRUITMENT_DEMO_MODE"] = "1"
        config.ACCESS_CODE = CODE
        try:
            remote = _FakeClientRequest("203.0.113.9", {})
            self.assertFalse(recruitment_api.demo_enabled(remote),
                             "远端 + 没有口令 cookie，不能进演示模式")
            remote_ok = _FakeClientRequest(
                "203.0.113.9", {access_gate.COOKIE_NAME: make_token(CODE)})
            self.assertTrue(recruitment_api.demo_enabled(remote_ok),
                            "远端 + 口令已验证，应当允许演示模式")
            local = _FakeClientRequest("127.0.0.1", {})
            self.assertTrue(recruitment_api.demo_enabled(local),
                            "本机 loopback 的旧行为必须保留")
        finally:
            config.ACCESS_CODE = original
            if previous is None:
                os.environ.pop("RECRUITMENT_DEMO_MODE", None)
            else:
                os.environ["RECRUITMENT_DEMO_MODE"] = previous


class _Client:
    def __init__(self, host: str):
        self.host = host


class _FakeClientRequest:
    def __init__(self, host: str, cookies: dict):
        self.client = _Client(host)
        self.cookies = cookies


if __name__ == "__main__":
    unittest.main()
