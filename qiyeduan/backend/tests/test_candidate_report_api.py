"""Candidate report access is tied to a finished room, not a raw session ID."""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")

import api  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from store import Store  # noqa: E402


class CandidateReportApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Store()
        self.patcher = patch.object(api, "STORE", self.store)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.room = self.store.create_room("产品经理", ["介绍一个项目"])

    def test_candidate_report_route_is_registered(self) -> None:
        paths = {route.path for route in api.router.routes}
        self.assertIn("/api/rooms/{code}/candidate-report", paths)

    def test_unknown_room_is_404(self) -> None:
        with self.assertRaises(HTTPException) as captured:
            api.get_candidate_report("ZZZZZZ")
        self.assertEqual(captured.exception.status_code, 404)

    def test_unfinished_room_is_409(self) -> None:
        self.store.start_session(self.room, consent=True, live=True)
        with self.assertRaises(HTTPException) as captured:
            api.get_candidate_report(self.room.code)
        self.assertEqual(captured.exception.status_code, 409)

    def test_ended_room_returns_candidate_report_only(self) -> None:
        session = self.store.start_session(self.room, consent=True, live=True)
        self.room.status = "ended"
        session.ended_at = time.time()
        candidate = {"role": "candidate", "title": "面试回顾"}
        with patch.object(api.report_mod, "build_candidate_report", return_value=candidate) as build_candidate, \
             patch.object(api.report_mod, "build_report", side_effect=AssertionError("interviewer report")):
            result = api.get_candidate_report(self.room.code.lower())
        self.assertEqual(result, candidate)
        build_candidate.assert_called_once_with(session)

    def test_legacy_report_rejects_live_session_without_caching(self) -> None:
        session = self.store.start_session(self.room, consent=True, live=True)
        for role in ("interviewer", "candidate"):
            with self.assertRaises(HTTPException) as captured:
                api.get_report(session.id, role=role)
            self.assertEqual(captured.exception.status_code, 409)
        self.assertIsNone(session.report)


class EndedCandidateWebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_receives_only_candidate_report_without_reopening(self) -> None:
        store = Store()
        room = store.create_room("产品经理", ["介绍一个项目"])
        session = store.start_session(room, consent=True, live=True)
        store.end_session(session)
        session.report = {"role": "interviewer", "points": [{"why": "内部提示"}]}

        class Socket:
            def __init__(self) -> None:
                self.accepted = False
                self.messages: list[dict] = []
                self.close_codes: list[int] = []

            async def accept(self) -> None:
                self.accepted = True

            async def send_json(self, message: dict) -> None:
                self.messages.append(message)

            async def close(self, code: int) -> None:
                self.close_codes.append(code)

        socket = Socket()
        with patch.object(api, "STORE", store), \
             patch.object(api, "get_hub", side_effect=AssertionError("ended room joined hub")):
            await api.room_ws(socket, room.code, role="candidate", consent=1)

        self.assertTrue(socket.accepted)
        self.assertEqual(socket.close_codes, [1000])
        self.assertEqual(room.status, "ended")
        self.assertEqual(len(socket.messages), 2)
        snapshot, message = socket.messages
        self.assertEqual(snapshot["type"], "candidate_snapshot")
        self.assertEqual(snapshot["transcript"], [])
        self.assertNotIn("hints", snapshot)
        self.assertEqual(message["type"], "report_ready")
        self.assertEqual(message["session_id"], session.id)
        self.assertEqual(message["report"]["role"], "candidate")
        self.assertNotIn("points", message["report"])
        self.assertNotIn("内部提示", str(message))

    async def test_live_reconnect_restores_only_minutes_and_revokes_consent(self) -> None:
        store = Store()
        room = store.create_room("产品经理", ["介绍一个项目"])
        session = store.start_session(room, consent=True, live=True)
        store.add_transcript(session, "candidate", "我负责用户调研。", 12)

        class Socket:
            def __init__(self) -> None:
                self.messages: list[dict] = []

            async def accept(self) -> None:
                pass

            async def send_json(self, message: dict) -> None:
                self.messages.append(message)

            async def receive_json(self) -> dict:
                from fastapi import WebSocketDisconnect
                raise WebSocketDisconnect(code=1000)

        class Hub:
            def __init__(self) -> None:
                self.conns = {"candidate": set(), "interviewer": set()}

            def add(self, role: str, socket: Socket) -> None:
                self.conns[role].add(socket)

            def remove(self, role: str, socket: Socket) -> None:
                self.conns[role].discard(socket)

            async def send(self, role: str, message: dict) -> None:
                pass

        socket = Socket()
        with patch.object(api, "STORE", store), patch.object(api, "get_hub", return_value=Hub()):
            await api.room_ws(socket, room.code, role="candidate", consent=0)
        self.assertFalse(session.consent)
        self.assertEqual([item["type"] for item in socket.messages],
                         ["hello_ack", "candidate_snapshot"])
        snapshot = socket.messages[1]
        self.assertEqual(snapshot["status"], "live")
        self.assertEqual(snapshot["transcript"][0]["text"], "我负责用户调研。")
        self.assertEqual(set(snapshot), {"type", "session_id", "status",
                                         "interviewer_online", "transcript"})


if __name__ == "__main__":
    unittest.main()
