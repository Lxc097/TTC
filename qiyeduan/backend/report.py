"""报告生成。

原则：报告标题是「面试质量报告」，不是「候选人评估报告」。
它评价的是这场面试挖得深不深，不是这个人行不行 —— 这一条同时决定了
合规安全和产品价值（面试官真的会用它复盘自己）。
"""
from __future__ import annotations

import os
from typing import Optional

import config
from store import Session


def _fmt_ts(sec: float) -> str:
    sec = max(0, int(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


KIND_LABEL = {
    "probe": "有东西没说透",
    "upgrade": "题可能太浅",
    "wrap": "该收了",
}


def build_points(session: Session) -> list[dict]:
    """从提示里挑出最强的 3 个点作为报告主体。

    只取 probe / upgrade 两类，wrap 是给面试官节奏提示、不进报告主体。
    """
    clues = [h for h in session.hints if h.kind in ("probe", "upgrade")]

    def strength(h) -> float:
        # 面试官采纳过的排前面，其次按时间
        return (1.0 if h.action == "used" else 0.0, -h.t)

    clues.sort(key=strength)

    points = []
    for h in clues[: config.REPORT_MAX_POINTS]:
        points.append({
            "t": round(h.t, 1),
            "clock": _fmt_ts(h.t),
            "label": KIND_LABEL.get(h.kind, h.kind),
            "text": h.text,
            "why": h.why,
            "adopted": h.action == "used",
            "hint_id": h.id,
        })
    return points


def build_summary(points: list[dict], session: Session) -> str:
    if not points:
        return "本场未发现明显需要追问的点，信号平稳。"
    n = len(points)
    if session.adopt_rate >= 0.66:
        return f"本场有 {n} 个点值得追问，其中大部分已被采用。"
    return f"本场有 {n} 个点值得二面追问。"


def build_report(session: Session) -> dict:
    points = build_points(session)
    summary = build_summary(points, session)

    if config.LLM_ENABLED:
        summary = _llm_summary(points) or summary

    report = {
        "session_id": session.id,
        "role": "interviewer",
        "title": "面试质量报告",
        "summary": summary,
        "duration": round((session.ended_at or 0) - session.started_at, 1),
        "turns": len(session.turns),
        "points": points,
        # 取证诚实度：申请了几次、坐实了几次。把"没坐实"写进报告，
        # 比只报成功更能说明这套信号是可验证的，而不是玄学。
        "verification": {
            "requested": session.confirms_requested,
            "confirmed": session.confirms_confirmed,
            "unconfirmed": max(0, session.confirms_requested
                               - session.confirms_confirmed),
        },
        "hint_stats": {
            "total": len(session.hints),
            "used": sum(1 for h in session.hints if h.action == "used"),
            "ignored": sum(1 for h in session.hints if h.action == "ignored"),
            "adopt_rate": round(session.adopt_rate, 3),
        },
        "disclaimer": "本报告不包含对候选人的任何评分或排序。",
        "deleted_media": True,   # 视频帧从不落盘，天然为真
    }
    session.report = report
    return report


def build_candidate_report(session: Session, base: dict | None = None) -> dict:
    """候选人版：同一个组件，换语气。不出现任何分数。

    传 base 可避免重复计算（ws.on_end 已经构建过面试官版）。
    """
    report = dict(base) if base else build_report(session)
    report.update({
        "role": "candidate",
        "title": "这次练习的 3 个收获",
        "disclaimer": "这份报告只属于你，可以导出，也可以删除。",
    })
    return report


def _llm_summary(points: list[dict]) -> Optional[str]:
    """可选：接 TTC 的语音/LLM 接口把要点写成一段自然语言。

    失败一律返回 None，由上面的模板兜底 —— 报告页永远不能白屏。
    """
    if not points:
        return None
    try:  # pragma: no cover - 需真实网络
        import json
        import urllib.request

        url = os.getenv("LLM_SUMMARY_URL", "")
        if not url:
            return None
        body = json.dumps({"points": points}, ensure_ascii=False).encode()
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode()).get("summary")
    except Exception:
        return None
