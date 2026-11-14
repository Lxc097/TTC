"""Recruitment rooms remain isolated from the legacy public demo endpoints."""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")
os.environ.setdefault("VISION_PROVIDER", "mock")
os.environ.setdefault("LLM_ENABLED", "0")

from interviewer import api  # noqa: E402
from candidate import recruitment_api  # noqa: E402
from candidate import recruitment_store as recruitment_repo  # noqa: E402
from interviewer import ws as ws_mod  # noqa: E402
from fastapi import HTTPException, WebSocketDisconnect  # noqa: E402
from shared.store import Store  # noqa: E402


class RecruitmentRoomAccessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Store()
        self.patcher = patch.object(api, "STORE", self.store)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.room = self.store.create_linked_room("后端工程师", ["请介绍项目"], "application-1")

    def assert_forbidden(self, call) -> None:
        with self.assertRaises(HTTPException) as result:
            call()
        self.assertEqual(result.exception.status_code, 403)

    def test_linked_room_and_tickets_are_idempotent_and_role_bound(self) -> None:
        repeated = self.store.create_linked_room("新标题", [], "application-1")
        self.assertIs(repeated, self.room)
        self.assertNotEqual(self.room.candidate_ticket, self.room.interviewer_ticket)
        self.assertEqual(self.store.ticket_role(self.room, self.room.candidate_ticket), "candidate")
        self.assertEqual(self.store.ticket_role(self.room, self.room.interviewer_ticket), "interviewer")
        self.assertIsNone(self.store.ticket_role(self.room, "wrong"))

    def test_room_metadata_requires_ticket_and_candidate_gets_safe_fields(self) -> None:
        self.assert_forbidden(lambda: api.get_room(self.room.code))
        result = api.get_room(self.room.code, ticket=self.room.candidate_ticket)
        self.assertEqual(set(result), {"code", "job_title", "status", "session_id"})

    def test_reports_and_session_routes_require_correct_ticket(self) -> None:
        session = self.store.start_session(self.room, consent=False, live=True)
        session.ended_at = time.time()
        self.room.status = "ended"
        session.report = {"role": "interviewer", "points": [{"text": "private"}]}
        self.assert_forbidden(lambda: api.get_candidate_report(self.room.code))
        self.assert_forbidden(lambda: api.get_report(session.id, role="interviewer",
                                                     ticket=self.room.candidate_ticket))
        self.assert_forbidden(lambda: api.get_report(session.id, role="candidate",
                                                     ticket=self.room.interviewer_ticket))
        self.assert_forbidden(lambda: api.get_transcript(session.id, limit=200))
        self.assertEqual(api.get_report(session.id, role="interviewer",
                                        ticket=self.room.interviewer_ticket), session.report)
        candidate = api.get_candidate_report(self.room.code, ticket=self.room.candidate_ticket)
        self.assertEqual(candidate["role"], "candidate")
        self.assertNotIn("private", str(candidate))

    def test_public_interview_list_excludes_linked_sessions(self) -> None:
        self.store.start_session(self.room, live=True)
        demo = self.store.create_room("演示岗位", ["介绍自己"])
        self.store.start_session(demo, live=True)
        rows = api.list_interviews()["items"]
        self.assertEqual([row["job_title"] for row in rows], ["演示岗位"])
        self.assertEqual(len(api.list_interviews(ticket=self.room.interviewer_ticket)["items"]), 2)


class RecruitmentRoomRestartTests(unittest.TestCase):
    def test_hr_detail_rehydrates_invited_room_after_restart(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(os.environ, {"RECRUITMENT_DATA_DIR": directory.name})
        env.start()
        self.addCleanup(env.stop)
        recruitment_repo.init_db()
        candidate = recruitment_repo.create_user("Candidate", "c@example.test",
                                                 "password-123", "candidate")
        hr = recruitment_repo.create_user("HR", "hr@example.test",
                                          "password-123", "hr", "Company")
        job = recruitment_repo.create_job(hr["companyId"], "Engineer",
                                          "Build reliable APIs and test them")
        app_id = recruitment_repo.create_application(
            candidate["id"], job["id"], "resume.pdf", "application/pdf",
            str(Path(directory.name) / "resume.pdf"), "file-hash", False)
        recruitment_repo.ensure_invitation(app_id)
        recruitment_repo.upsert_review(app_id, hr["id"], "invite", "",
                                       "ai_interview_invited")
        old = Store().create_linked_room("Engineer", ["Intro"], app_id)
        recruitment_repo.set_invitation_room(app_id, old.code)
        row = recruitment_repo.hr_application(app_id, hr["companyId"])
        restarted_store = Store()
        with patch.object(recruitment_api, "STORE", restarted_store):
            dto = recruitment_api._hr_dto(row, detail=True)
        new_code = dto["invitation"]["roomCode"]
        self.assertIsNotNone(restarted_store.get_room(new_code))
        self.assertEqual(recruitment_repo.hr_application(app_id, hr["companyId"])["room_code"],
                         new_code)
        self.assertIn("ticket=", dto["invitation"]["interviewPath"])


class RecruitmentWebSocketAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_candidate_ticket_cannot_spoof_interviewer_role(self) -> None:
        store = Store()
        room = store.create_linked_room("后端工程师", ["请介绍项目"], "application-1")

        class Socket:
            accepted = False
            closed = None

            async def accept(self):
                self.accepted = True

            async def close(self, code):
                self.closed = code

        socket = Socket()
        with patch.object(api, "STORE", store):
            await api.room_ws(socket, room.code, role="interviewer", consent=0,
                              ticket=room.candidate_ticket)
            with self.assertRaises(HTTPException) as result:
                await api.end_room(room.code, ticket=room.candidate_ticket)
        self.assertFalse(socket.accepted)
        self.assertEqual(socket.closed, 4003)
        self.assertEqual(result.exception.status_code, 403)
        self.assertIsNone(room.session_id)

    async def test_candidate_join_updates_progress_without_leaking_question_plan(self) -> None:
        store = Store()
        room = store.create_linked_room("后端工程师", ["内部追问策略"], "application-1")

        class Socket:
            def __init__(self):
                self.messages = []

            async def accept(self):
                pass

            async def send_json(self, message):
                self.messages.append(message)

            async def receive_json(self):
                raise WebSocketDisconnect(code=1000)

        class Hub:
            def __init__(self):
                self.conns = {"candidate": set(), "interviewer": set()}

            def add(self, role, socket):
                self.conns[role].add(socket)

            def remove(self, role, socket):
                self.conns[role].discard(socket)

            async def send(self, role, message):
                pass

        socket = Socket()
        with patch.object(api, "STORE", store), \
             patch.object(api, "get_hub", return_value=Hub()), \
             patch("candidate.recruitment_store.mark_interview_in_progress") as progressing:
            await api.room_ws(socket, room.code, role="candidate", consent=0,
                              ticket=room.candidate_ticket)
        self.assertEqual(room.status, "live")
        progressing.assert_called_once_with("application-1")
        self.assertEqual(socket.messages[0]["room"]["questions"], [])
        self.assertNotIn("内部追问策略", str(socket.messages))

    async def test_completion_updates_linked_application_only_after_candidate_join(self) -> None:
        store = Store()
        room = store.create_linked_room("后端工程师", ["请介绍项目"], "application-1")
        with patch.object(ws_mod, "STORE", store), \
             patch("candidate.recruitment_store.mark_interview_completed") as completed:
            hub = ws_mod.RoomHub(room)
            store.start_session(room, live=False)
            await hub.on_end()
            self.assertEqual(room.status, "waiting")
            completed.assert_not_called()
            store.start_session(room, live=True)
            await hub.on_end()
            self.assertEqual(room.status, "ended")
            completed.assert_called_once_with("application-1")


if __name__ == "__main__":
    unittest.main()
