"""招聘阶段与状态机：企业端、候选人端与 DTO 的唯一判定来源。

`applications.status` 保持原有取值不变，这个模块只做三件事：

1. 把 `status` 映射成候选人可见的「阶段」（issue #5：只显示当前阶段）。
2. 计算 AI 初面邀请与真人面试邀请的展示状态（待响应 / 已接受 / 已过期 / 已完成）。
3. 收敛真人面试结论与「结果是否发送给候选人」的文案口径。

任何页面都不要自己再写一套 if/else：阶段映射一旦分叉，企业端推进了状态、
候选人端却还显示旧阶段，是这类双端产品最常见也最难查的 bug。
"""
from __future__ import annotations

import time

# ---------- 阶段 ----------
APPLIED = "applied"            # 阶段 1：投递与初筛
AI_INTERVIEW = "ai_interview"  # 阶段 2：AI 初面
HUMAN_INTERVIEW = "human_interview"  # 阶段 3：真人面试
ENDED = "ended"                # 流程结束

STAGE_LABELS = {
    APPLIED: "投递与初筛",
    AI_INTERVIEW: "AI 初面",
    HUMAN_INTERVIEW: "真人面试",
    ENDED: "流程结束",
}

_STATUS_TO_STAGE = {
    "submitted": APPLIED,
    "parsing": APPLIED,
    "screening": APPLIED,
    "hr_review": APPLIED,
    "failed": APPLIED,
    # 招聘流程里真正会写入的状态（hr_interview_invited / closed 由本模块的使用方写入）
    "ai_interview_invited": AI_INTERVIEW,
    "ai_interview_in_progress": AI_INTERVIEW,
    "ai_interview_completed": AI_INTERVIEW,
    "hr_interview_invited": HUMAN_INTERVIEW,
    "closed": ENDED,
}


def stage_of(status: str | None) -> str:
    """把 applications.status 映射成阶段；未知状态按「投递与初筛」处理。"""
    return _STATUS_TO_STAGE.get(status or "", APPLIED)


def stage_label(stage: str | None) -> str:
    return STAGE_LABELS.get(stage or "", STAGE_LABELS[APPLIED])


# ---------- 邀请状态 ----------
PENDING = "pending"
ACCEPTED = "accepted"
EXPIRED = "expired"
COMPLETED = "completed"
CANCELLED = "cancelled"

INVITATION_STATE_LABELS = {
    PENDING: "待响应",
    ACCEPTED: "已接受",
    EXPIRED: "已过期",
    COMPLETED: "已完成",
    CANCELLED: "已取消",
}


def invitation_state(status: str | None, expires_at: float | None = None,
                     accepted_at: float | None = None,
                     now: float | None = None) -> str:
    """AI 初面邀请的展示状态。

    过期是**读的时候算**的，不靠后台定时任务改库：时间一到，列表就该显示已过期，
    而不是等某个 worker 醒来。
    """
    if status == "completed":
        return COMPLETED
    if status == "cancelled":
        return CANCELLED
    if status == "in_progress" or accepted_at:
        return ACCEPTED
    if expires_at and (now if now is not None else time.time()) >= float(expires_at):
        return EXPIRED
    return PENDING


def human_state(status: str | None, result: str | None = None,
                expires_at: float | None = None,
                accepted_at: float | None = None,
                now: float | None = None) -> str:
    if status == "completed" or result:
        return COMPLETED
    if status == "cancelled":
        return CANCELLED
    if status == "accepted" or accepted_at:
        return ACCEPTED
    if expires_at and (now if now is not None else time.time()) >= float(expires_at):
        return EXPIRED
    return PENDING


def state_label(state: str | None) -> str:
    return INVITATION_STATE_LABELS.get(state or "", "待处理")


# ---------- 真人面试结论 ----------
RESULT_LABELS = {
    "pass": "通过",
    "hold": "待定",
    "reject": "未通过",
}

# 候选人可见的一句话结论。刻意不含任何内部评估、分数与备注：
# 个人端只回答「我现在在哪个阶段」，不展示企业内部判断。
_RESULT_MESSAGES = {
    "pass": "真人面试已完成，企业已反馈通过，请留意后续通知。",
    "hold": "真人面试已完成，企业仍在评估中。",
    "reject": "本次招聘流程已结束，感谢你的参与。",
}

AI_RESULT_MESSAGE = "AI 初面已完成，企业已收到结果，请留意后续通知。"


def result_label(result: str | None) -> str:
    return RESULT_LABELS.get(result or "", "待定")


def result_message(result: str | None) -> str:
    return _RESULT_MESSAGES.get(result or "", "")
