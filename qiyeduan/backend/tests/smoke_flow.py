"""端到端流程冒烟测试：不需要 fastapi、不需要浏览器。

用一个假的 WebSocket 走完：建房间 → 收帧 → 建基线 → 应激 → 双确认 → 出提示 → 报告。

跑法：
    python tests/smoke_flow.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

# 短时间参数，几秒钟就跑完
os.environ.update({
    "BASELINE_SECONDS": "20",
    "BASELINE_MIN_SAMPLES": "5",
    "SAMPLE_MIN_INTERVAL": "0.05",
    "MOCK_STRESS_WINDOWS": "21-40",
    "HINT_COOLDOWN": "10",
})

import config          # noqa: E402
import report as report_mod   # noqa: E402
from store import STORE, default_questions   # noqa: E402
from ws import get_hub   # noqa: E402
import ws as ws_mod      # noqa: E402

# 冒烟测试不该联网、不该花钱：屏蔽真 LLM
ws_mod.LLM = None


class FakeWS:
    def __init__(self, name: str) -> None:
        self.name = name
        self.msgs: list[dict] = []

    async def send_text(self, s: str) -> None:
        self.msgs.append(json.loads(s))

    def types(self) -> list[str]:
        return [m["type"] for m in self.msgs]

    def first(self, t: str) -> dict | None:
        return next((m for m in self.msgs if m["type"] == t), None)


async def main() -> int:
    room = STORE.create_room("后端联调", default_questions())
    hub = get_hub(room)
    iws, cws = FakeWS("interviewer"), FakeWS("candidate")
    hub.add("interviewer", iws)
    hub.add("candidate", cws)

    session = STORE.start_session(room, consent=True)
    print(f"[1] 房间 {room.code} / 会话 {session.id} 已建立")

    # ---- 阶段一：基线（无应激窗口）----
    for t in range(0, 21, 2):
        hub.push_frame(b"x" * 2000, float(t))
        await asyncio.sleep(0.08)
    print(f"[2] 基线采样 {len(hub.room.baseline.hr)} 点，等待封板")

    # ---- 阶段二：一轮问答，正好落在应激窗口 ----
    await hub.on_turn_start(21.0)
    for t in (22, 24, 26, 28):
        hub.push_frame(b"x" * 2000, float(t))
        await asyncio.sleep(0.08)
    b = hub.room.baseline
    print(f"[2b] 基线封板 ready={b.ready} "
          f"hr_med={b.hr_med:.1f} mad={b.hr_mad:.2f}")

    beh = {"pause_ratio": 0.8, "gaze_off": 0.3,
           "filler_density": 0.4, "speech_rate_drop": 0.2}
    await hub.on_turn_end(29.0, "这个项目后来因为公司战略调整就没上线。", beh)

    turn = session.turns[-1]
    print(f"[3] 轮次 {turn.turn_id} peak={turn.phys_peak:.2f}σ "
          f"mean={turn.phys_mean:.2f}σ beh={turn.beh.anomaly():.2f}")

    hint_msg = iws.first("hint")
    if hint_msg is None:
        print("[!] 没有产生提示 —— 双确认或阈值哪一步没通")
        return 1
    print(f"[4] 提示 [{hint_msg['kind']}] 「{hint_msg['text']}」 ← {hint_msg['why']}")

    # ---- 阶段三：面试官反馈 + 结束 ----
    STORE.set_feedback(hint_msg["id"], "used")
    await hub.on_end()

    rep_msg = iws.first("report_ready")
    if rep_msg is None:
        print("[!] 报告未生成")
        return 1
    rep = rep_msg["report"]
    print(f"[5] 报告：「{rep['summary']}」")
    for p in rep["points"]:
        print(f"      {p['clock']}  {p['label']} · {p['text']}  (采纳={p['adopted']})")
    print(f"[6] 采纳率={rep['hint_stats']['adopt_rate']} "
          f"轮次={rep['turns']} 免责={rep['disclaimer']}")

    # ---- 阶段四：场次列表 ----
    rows = STORE.list_interviews()
    print(f"[7] 场次列表 {len(rows)} 条：{rows[0]['job_title']} "
          f"points={rows[0]['points']} adopt={rows[0]['adopt_rate']}")

    # ---- 断言 ----
    assert rep["points"], "报告必须有追问点"
    assert "评分" in rep["disclaimer"] and "不包含" in rep["disclaimer"]
    assert not any("score" in r for r in rows), "场次列表不许出现 score 字段"
    print("\n✅ 全链路通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
