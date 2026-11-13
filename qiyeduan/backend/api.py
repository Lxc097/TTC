"""REST + WebSocket 路由。面试官侧接口集中在 /api/rooms 和 /api/interviews。"""
from __future__ import annotations

import time

from fastapi import APIRouter, Body, HTTPException, Query, WebSocket, WebSocketDisconnect

import config
import report as report_mod
from store import STORE, default_questions
from ws import get_hub, handle_message

router = APIRouter()


def _candidate_snapshot(room, session, interviewer_online: bool = False) -> dict:
    """Reconnect state contains conversation minutes, never interviewer hints/signals."""
    return {
        "type": "candidate_snapshot",
        "session_id": session.id if session else None,
        "status": room.status,
        "interviewer_online": interviewer_online,
        "transcript": session.transcript[-80:] if session else [],
    }


# ------------------------------------------------------------ 健康检查
@router.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "vision_provider": config.VISION_PROVIDER,
            "llm_enabled": config.LLM_ENABLED, "ts": time.time()}


# ------------------------------------------------------------ 房间
@router.post("/api/rooms")
def create_room(payload: dict = Body(default={})) -> dict:
    """面试官创建房间 → 拿到 6 位房间号。"""
    room = STORE.create_room(
        job_title=payload.get("job_title") or "未命名职位",
        questions=payload.get("questions") or default_questions(),
    )
    return {
        "code": room.code,
        "job_title": room.job_title,
        "questions": room.questions,
        "status": room.status,
        "join_hint": f"让候选人输入房间号 {room.code}",
    }


@router.get("/api/rooms/{code}")
def get_room(code: str) -> dict:
    """面试官等待页轮询用。也支持 WS 推送 peer 事件，二者取一即可。"""
    room = STORE.get_room(code)
    if not room:
        raise HTTPException(404, "房间不存在")
    session = STORE.get_session(room.session_id) if room.session_id else None
    return {
        "code": room.code,
        "job_title": room.job_title,
        "status": room.status,
        "session_id": room.session_id,
        "turns": len(session.turns) if session else 0,
        "hints": len(session.hints) if session else 0,
        "baseline_ready": room.baseline.ready,
        "interviewer_online": len(get_hub(room).conns["interviewer"]) > 0,
        "candidate_online": len(get_hub(room).conns["candidate"]) > 0,
    }


@router.get("/api/rooms/{code}/candidate-report")
def get_candidate_report(code: str) -> dict:
    """Return the candidate-facing report only after this room has ended."""
    room = STORE.get_room(code)
    if not room:
        raise HTTPException(404, "房间不存在")
    session = STORE.get_session(room.session_id) if room.session_id else None
    if room.status != "ended" or not session or session.ended_at is None:
        raise HTTPException(409, "面试尚未结束")
    return report_mod.build_candidate_report(session)


@router.post("/api/rooms/{code}/end")
async def end_room(code: str) -> dict:
    room = STORE.get_room(code)
    if not room:
        raise HTTPException(404, "房间不存在")
    await get_hub(room).on_end()
    return {"ok": True, "session_id": room.session_id}


# ------------------------------------------------------------ 面试场次列表
@router.get("/api/interviews")
def list_interviews() -> dict:
    """面试官「查看面试者分析」用的列表。

    ⚠️ 这里是**场次记录**，不是候选人排名。不要加 score / rank 字段。
    """
    return {"items": STORE.list_interviews()}


# ------------------------------------------------------------ 报告
@router.get("/api/sessions/{sid}/report")
def get_report(sid: str, role: str = Query("interviewer")) -> dict:
    session = STORE.get_session(sid)
    if not session:
        raise HTTPException(404, "会话不存在")
    if session.ended_at is None:
        raise HTTPException(409, "面试尚未结束")
    if role == "candidate":
        return report_mod.build_candidate_report(session)
    return session.report or report_mod.build_report(session)


@router.get("/api/sessions/{sid}/transcript")
def get_transcript(sid: str, limit: int = Query(200, ge=1, le=500)) -> dict:
    """会议纪要（语音转写）。报告页和纪要面板都用它。"""
    session = STORE.get_session(sid)
    if not session:
        raise HTTPException(404, "会话不存在")
    return {"session_id": sid, "total": len(session.transcript),
            "items": session.transcript[-limit:]}


@router.post("/api/hints/{hint_id}/feedback")
def hint_feedback(hint_id: str, payload: dict = Body(default={})) -> dict:
    """REST 兜底：前端 WS 断了也能点「用掉 / 忽略」。"""
    action = payload.get("action")
    if action not in ("used", "ignored"):
        raise HTTPException(400, "action 必须是 used 或 ignored")
    hint = STORE.set_feedback(hint_id, action)
    if not hint:
        raise HTTPException(404, "提示不存在")
    return {"ok": True, "id": hint.id, "action": hint.action}


# ------------------------------------------------------------ WebSocket
@router.websocket("/ws/room/{code}")
async def room_ws(ws: WebSocket, code: str,
                  role: str = Query("interviewer"),
                  consent: int = Query(0)) -> None:
    """角色：interviewer | candidate。候选人在同一端点上报帧与轮次。"""
    room = STORE.get_room(code)
    if not room:
        await ws.close(code=4004)
        return
    if role not in ("interviewer", "candidate"):
        await ws.close(code=4000)
        return

    await ws.accept()
    if role == "candidate" and room.status == "ended":
        # 候选人刷新结束页时只补发自己的报告，不重新开启房间或接收媒体。
        session = STORE.get_session(room.session_id) if room.session_id else None
        if session and session.ended_at is not None:
            await ws.send_json(_candidate_snapshot(room, session))
            await ws.send_json({
                "type": "report_ready",
                "session_id": session.id,
                "report": report_mod.build_candidate_report(session),
            })
            await ws.close(code=1000)
        else:
            await ws.close(code=4004)
        return

    hub = get_hub(room)
    hub.add(role, ws)

    if role == "candidate":
        # 候选人进来才算真正开始，并且带上他的授权状态
        STORE.start_session(room, consent=bool(consent), live=True)
    else:
        # 面试官先连也建会话：只有他一个人时，麦克风转写/轮次也要有地方落库
        STORE.start_session(room, consent=False, live=False)

    await ws.send_json({
        "type": "hello_ack",
        "role": role,
        "room": {"code": room.code, "job_title": room.job_title,
                 "questions": room.questions, "status": room.status,
                 "candidate_online": bool(hub.conns.get("candidate")),
                 "interviewer_online": bool(hub.conns.get("interviewer"))},
        "session_id": room.session_id,
        "baseline_seconds": config.BASELINE_SECONDS,
        "server_t": round(time.time(), 3),
    })

    # 面试官刷新或重连时补齐已发生的状态
    if role == "interviewer":
        await hub.send_snapshot()
    else:
        session = STORE.get_session(room.session_id) if room.session_id else None
        await ws.send_json(_candidate_snapshot(
            room, session, bool(hub.conns.get("interviewer"))))

    # 通知对端有新人进来
    peer = "interviewer" if role == "candidate" else "candidate"
    await hub.send(peer, {"type": "peer", "role": role,
                          "state": "online", "t": 0})

    try:
        while True:
            msg = await ws.receive_json()
            await handle_message(hub, role, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.remove(role, ws)
        await hub.send(peer, {"type": "peer", "role": role,
                              "state": "offline", "t": 0})
