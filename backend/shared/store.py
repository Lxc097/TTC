"""内存状态仓库。

黑客松不需要数据库：一个 dict + 一把锁就够。
重启即清空 —— 这正好也是"面试结束即删除"的合规叙事。
"""
from __future__ import annotations

import random
import secrets
import string
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from shared import config
from shared.engine import Baseline, HintDraft, PhysioSample, Turn


def _room_code() -> str:
    # 去掉容易看错的 0/O/1/I
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(6))


@dataclass
class Hint:
    id: str
    turn_id: int
    kind: str
    text: str
    why: str
    t: float
    action: Optional[str] = None   # used | ignored | None


@dataclass
class Session:
    id: str
    room_code: str
    job_title: str
    started_at: float
    ended_at: Optional[float] = None
    consent: bool = False
    turns: list[Turn] = field(default_factory=list)
    hints: list[Hint] = field(default_factory=list)
    samples: list[PhysioSample] = field(default_factory=list)
    report: Optional[dict] = None
    # 取证诚实度：申请了几次、坐实了几次。报告里要如实写出来，
    # "4 次取证里有 2 次没坐实"比只报成功更有说服力。
    confirms_requested: int = 0
    confirms_confirmed: int = 0
    # 会议纪要时间线：{id, role, text, final, t}
    # role 是 interviewer / candidate，服务端按连接角色判定，不信客户端自报。
    transcript: list[dict] = field(default_factory=list)

    @property
    def adopt_rate(self) -> float:
        acted = [h for h in self.hints if h.action]
        if not acted:
            return 0.0
        return sum(1 for h in self.hints if h.action == "used") / len(acted)


@dataclass
class Room:
    code: str
    job_title: str
    questions: list[str]
    created_at: float
    status: str = "waiting"          # waiting | live | ended
    session_id: Optional[str] = None
    baseline: Baseline = field(default_factory=Baseline)
    last_hint_t: float = -1e9
    current_turn: Optional[Turn] = None
    # 招聘投递创建的房间需要角色专属凭证；普通演示房间仍沿用原协议。
    application_id: Optional[str] = None
    candidate_ticket: Optional[str] = None
    interviewer_ticket: Optional[str] = None


class Store:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.sessions: dict[str, Session] = {}

    # ---------- 房间 ----------
    def create_room(self, job_title: str, questions: list[str]) -> Room:
        code = _room_code()
        while code in self.rooms:
            code = _room_code()
        room = Room(code=code, job_title=job_title,
                    questions=questions, created_at=time.time())
        self.rooms[code] = room
        return room

    def get_room(self, code: str) -> Optional[Room]:
        return self.rooms.get(code.upper())

    def create_linked_room(self, job_title: str, questions: list[str],
                           application_id: str) -> Room:
        """Idempotently reserve one interview room for an application."""
        for room in self.rooms.values():
            if room.application_id == application_id:
                return room
        room = self.create_room(job_title, questions)
        room.application_id = application_id
        room.candidate_ticket = secrets.token_urlsafe(32)
        room.interviewer_ticket = secrets.token_urlsafe(32)
        return room

    @staticmethod
    def ticket_role(room: Room, ticket: Optional[str]) -> Optional[str]:
        """Unlinked demo rooms remain public; linked rooms require a role-bound ticket."""
        if room.application_id is None:
            return "legacy"
        if not ticket:
            return None
        if room.candidate_ticket and secrets.compare_digest(ticket, room.candidate_ticket):
            return "candidate"
        if room.interviewer_ticket and secrets.compare_digest(ticket, room.interviewer_ticket):
            return "interviewer"
        return None

    # ---------- 会话 ----------
    def start_session(self, room: Room, consent: bool = False,
                      live: bool = False) -> Session:
        """开一场会话。**谁先连上就建** —— 只有面试官也要能记事。

        两个关键细节：
        1. 已存在的会话会被复用；候选人重连时的 consent 以本次选择为准，
           可以授权也可以撤销。面试官重连不能更改候选人的选择。
        2. 只有候选人进房（live=True）才把房间标成 live，避免面试官一进来
           就显示"面试进行中"。
        """
        existing = (self.sessions.get(room.session_id)
                    if room.session_id else None)
        if existing is not None:
            if live and existing.ended_at is None:
                existing.consent = bool(consent)
                room.status = "live"
            return existing

        s = Session(
            id=uuid.uuid4().hex[:12],
            room_code=room.code,
            job_title=room.job_title,
            started_at=time.time(),
            consent=consent,
        )
        self.sessions[s.id] = s
        room.session_id = s.id
        if live:
            room.status = "live"
        return s

    def get_session(self, sid: str) -> Optional[Session]:
        return self.sessions.get(sid)

    def add_hint(self, session: Session, draft: HintDraft, t: float,
                 turn_id: int | None = None) -> Hint:
        """turn_id 必须显式传。

        以前用 len(session.turns) 推，在"证据晚 30 秒才回来"的场景里会算错：
        触发时是第 2 轮，等视频回来时第 3 轮已经结束，len 变成 3，
        提示就被挂到了不相干的第 3 轮上。
        """
        h = Hint(id=uuid.uuid4().hex[:8],
                 turn_id=turn_id if turn_id is not None else len(session.turns),
                 kind=draft.kind, text=draft.text, why=draft.why, t=t)
        session.hints.append(h)
        return h

    def add_transcript(self, session: Session, role: str, text: str,
                       t: float, final: bool = True) -> dict:
        """追加一条转写。只存 final，interim（边说边变的中间结果）只在内存里广播。

        上限 500 条：一场面试几百句足够，防止有人恶意刷导致内存涨爆。
        """
        item = {
            "id": uuid.uuid4().hex[:8],
            "role": role,
            "text": (text or "").strip()[:1000],
            "final": bool(final),
            "t": round(float(t), 1),
        }
        if final and item["text"]:
            session.transcript.append(item)
            if len(session.transcript) > 500:
                del session.transcript[:len(session.transcript) - 500]
        return item

    def set_feedback(self, hint_id: str, action: str) -> Optional[Hint]:
        for s in self.sessions.values():
            for h in s.hints:
                if h.id == hint_id:
                    h.action = action
                    return h
        return None

    def end_session(self, session: Session) -> None:
        if session.ended_at is None:
            session.ended_at = time.time()
        room = self.rooms.get(session.room_code)
        if room:
            room.status = "ended"

    # ---------- 面试官侧列表 ----------
    def list_interviews(self, ticket: Optional[str] = None) -> list[dict]:
        """注意：这里列的是**场次**，不是候选人排名。

        永远不要在这里加 score / rank / 排序权重 ——
        排名的下一步一定是自动淘汰，那会让整个项目的合规叙事崩掉。
        """
        rows = []
        for s in sorted(self.sessions.values(), key=lambda x: x.started_at,
                        reverse=True):
            room = self.get_room(s.room_code)
            if room and room.application_id is not None \
                    and self.ticket_role(room, ticket) != "interviewer":
                continue
            rows.append({
                "session_id": s.id,
                "job_title": s.job_title,
                "started_at": s.started_at,
                # 秒数（浮点）。没结束的场次按"到现在为止"算，所以带个 is_live
                # 让前端能区分"已结束的时长"和"还在进行中"。
                "duration": (s.ended_at or time.time()) - s.started_at,
                "is_live": s.ended_at is None,
                "turns": len(s.turns),
                "points": len(s.hints),
                "adopt_rate": round(s.adopt_rate, 3),
                "consent": s.consent,
            })
        return rows


STORE = Store()


def default_questions() -> list[str]:
    return [
        "请介绍一个你认为最有代表性的项目。",
        "这个项目里最难的技术问题是什么，你怎么解决的？",
        "讲一个你失败或遗憾的项目。",
    ]
