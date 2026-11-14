"""报告生成。

原则：报告标题是「面试质量报告」，不是「候选人评估报告」。
它评价的是这场面试挖得深不深，不是这个人行不行 —— 这一条同时决定了
合规安全和产品价值（面试官真的会用它复盘自己）。
"""
from __future__ import annotations

from shared import config
from shared import llm as llm_mod
from shared.store import Session


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
        # 摘要交给 LLM 写；它挂了/超时/没配 key 都退回上面的模板，
        # 报告页永远不能白屏。
        client = llm_mod.get_llm()
        if client is not None:
            try:
                summary = client.summarize(
                    points, {"job_title": session.job_title,
                             "turns": len(session.turns)}) or summary
            except Exception:
                pass

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
        # 会议纪要：只带角色/文本/时间，附件不带原始音频（本来也不存）
        "transcript": [
            {"role": it["role"], "text": it["text"], "t": it["t"]}
            for it in session.transcript[-120:]
        ],
    }
    session.report = report
    return report


def build_candidate_report(session: Session, base: dict | None = None) -> dict:
    """基于候选人自己的转写生成表达回看，不复用面试官的提示或判断。

    ``base`` 只为兼容现有 WS 调用保留；复制它会泄露面试官提示、
    取证与采纳数据。转写缺失时不推测回答内容。
    """
    del base
    transcript = [
        {"role": item["role"], "text": item["text"].strip(),
         "t": item.get("t", 0)}
        for item in session.transcript[-120:]
        if isinstance(item, dict)
        and item.get("role") in ("candidate", "interviewer")
        and isinstance(item.get("text"), str)
        and item["text"].strip()
    ]

    # STT 分片会把一句话拆成多条；只在发言人切换时形成一段。
    exchanges: list[dict] = []
    question_parts: list[str] = []
    answer_parts: list[str] = []
    current_question = ""
    answer_t = 0.0

    def finish_answer() -> None:
        if answer_parts:
            exchanges.append({"question": current_question,
                              "answer": " ".join(answer_parts), "t": answer_t})
            answer_parts.clear()

    for item in transcript:
        if item["role"] == "interviewer":
            finish_answer()
            question_parts.append(item["text"])
        else:
            if not answer_parts:
                current_question = " ".join(question_parts)
                question_parts.clear()
                try:
                    answer_t = max(0.0, float(item["t"]))
                except (TypeError, ValueError):
                    answer_t = 0.0
            answer_parts.append(item["text"])
    finish_answer()

    def excerpt(value: str, limit: int = 110) -> str:
        return value if len(value) <= limit else value[:limit].rstrip() + "…"

    def suggestion(answer: str) -> tuple[str, str]:
        compact = "".join(answer.split())
        if len(compact) < 30:
            return ("补足回答", "这段转写较短。下次可以补充背景、本人行动与结果；转写若不完整，请以实际发言为准。")
        if "我们" in answer and not any(
            phrase in answer for phrase in ("我负责", "我做", "我主导", "我参与", "我的任务")
        ):
            return ("说清个人贡献", "提到了团队经历。可以补充自己负责的具体动作，让贡献边界更清楚。")
        if not any(phrase in answer for phrase in ("结果", "最终", "后来", "提升", "降低", "完成", "上线", "验证", "%")):
            return ("补充结果依据", "可以再说明结果或验证方式；没有量化数字时，也可以描述如何确认进展。")
        return ("突出重点", "下次可以先用一句话点明结论，再用这段经历中的行动和结果支撑。")

    observations = []
    for exchange in exchanges[:3]:
        focus, tip = suggestion(exchange["answer"])
        observations.append({
            "t": round(exchange["t"], 1),
            "clock": _fmt_ts(exchange["t"]),
            "question": excerpt(exchange["question"], 140),
            "quote": excerpt(exchange["answer"]),
            "focus": focus,
            "suggestion": tip,
        })

    count = len(exchanges)
    summary = (f"本场记录了 {count} 段你的发言。以下建议只依据转写原话，供你回看表达方式。"
               if count else "本场没有可供回看的候选人转写，暂时无法分析回答内容。")
    return {
        "session_id": session.id,
        "role": "candidate",
        "title": "我的面试表达回看",
        "summary": summary,
        "duration": round(max(0.0, (session.ended_at or session.started_at) - session.started_at), 1),
        "turns": len(session.turns),
        "answer_segments": count,
        "observations": observations,
        "transcript": transcript,
        "disclaimer": "仅根据本场转写回看表达，不评价能力、人格或诚信，也不评分或排名。转写可能存在遗漏。",
        "deleted_media": True,
    }
