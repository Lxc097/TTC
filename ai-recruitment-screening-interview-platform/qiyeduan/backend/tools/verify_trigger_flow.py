"""触发 → 确认 链路的端到端验证。

不访问网络、不消耗 token：用一个"剧本化"的假 provider 返回预设的心率，
把 **record_request → video_chunk → confirm → hint / confirm_result**
整条消息流跑一遍，并断言每一环的行为。

任何一次改动后都该重跑这个脚本：

    python tools/verify_trigger_flow.py

它会打印完整的消息轨迹，最后给出 PASS/FAIL。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# 强制走 mock，避免脚本误用真实 key 烧 token
os.environ["VISION_PROVIDER"] = "mock"

import config  # noqa: E402
import ws as ws_mod  # noqa: E402
from engine import PhysioSample  # noqa: E402
from store import STORE, default_questions  # noqa: E402
from ws import get_hub  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'✅' if ok else '❌'} {label}{('  ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(label)


class ScriptedProvider:
    """按队列返回预设心率，模拟 FacePhys。queue 里是 (hr, sqi)。"""

    wants_video = True
    wants_segment = False

    def __init__(self, queue: list[tuple[float, float]]) -> None:
        self.queue = list(queue)
        self.calls = 0

    def sample_video(self, video, t, ct="video/mp4"):
        self.calls += 1
        hr, q = self.queue.pop(0) if self.queue else (80.0, 0.5)
        print(f"      · [FacePhys 假] 收到 {len(video)}B 视频 → hr={hr} sqi={q}")
        return PhysioSample(t=t, hr=hr, rr=16.0, quality=q, face_count=1)

    def sample(self, frame, t):
        return None

    def sample_segment(self, frames, t):
        return None


class FakeWS:
    def __init__(self, name: str) -> None:
        self.name = name
        self.msgs: list[dict] = []

    async def send_text(self, s: str) -> None:
        m = json.loads(s)
        self.msgs.append(m)
        if m["type"] in ("signal",):
            return                      # signal 太密，单独统计
        brief = json.dumps(m, ensure_ascii=False)
        print(f"      [→{self.name}] {brief[:190]}")

    def of(self, t: str) -> list[dict]:
        return [m for m in self.msgs if m["type"] == t]

    def clear(self) -> None:
        self.msgs.clear()


async def main() -> int:
    ws_mod.LLM = None          # 验证脚本不联网、不烧 LLM 额度
    ws_mod.PROVIDER = ScriptedProvider([
        (96.0, 0.45),    # 第一次取证：明显高于基线 → 应确认成功
        (80.4, 0.50),    # 第二次取证：与基线持平 → 应确认失败
    ])
    ws_mod.VIDEO_MODE = True

    room = STORE.create_room("链路验证", default_questions())
    hub = get_hub(room)
    iws, cws = FakeWS("面试官"), FakeWS("候选人")
    hub.add("interviewer", iws)
    hub.add("candidate", cws)
    session = STORE.start_session(room, consent=True)

    print(f"房间 {room.code} / 会话 {session.id}")
    print(f"触发阈值={config.TRIGGER_THRESHOLD} 硬触发={config.TRIGGER_STRONG} "
          f"预算={config.CONFIRM_MAX} 取证时长={config.CONFIRM_CLIP_SECONDS}s\n")

    # ---------------- 阶段 1：建立基线 ----------------
    print("[1] 建立静息基线（3 个采样，围绕 80bpm）")
    for t, hr in ((0.0, 79.0), (5.0, 80.0), (9.0, 81.0)):
        await hub._emit_sample(
            PhysioSample(t=t, hr=hr, rr=16.0, quality=0.6, face_count=1), t)
    hub.room.baseline.freeze()
    check("基线就绪", hub.room.baseline.ready,
          f"hr_med={hub.room.baseline.hr_med:.1f} mad={hub.room.baseline.hr_mad:.2f}")

    # ---------------- 阶段 2：正常轮次，不该花钱 ----------------
    print("\n[2] 正常轮次（行为信号正常）——不应该请求取证")
    iws.clear(); cws.clear()
    await hub.on_turn_start(60.0)
    await hub.on_turn_end(90.0, "这是一段正常的回答，语速平稳。",
                          {"pause_ratio": 0.05, "gaze_off": 0.0})
    check("没有发出 record_request", not cws.of("record_request"))
    check("没有 confirm_requested", not iws.of("confirm_requested"))
    check("没有 hint", not iws.of("hint"))
    check("没有调用 FacePhys", ws_mod.PROVIDER.calls == 0)

    # ---------------- 阶段 3：行为异常 → 请求取证 ----------------
    print("\n[3] 行为异常轮次（停顿占比 0.8）——应该请求取证")
    iws.clear(); cws.clear()
    await hub.on_turn_start(120.0)
    await hub.on_turn_end(150.0, "后来因为公司战略调整就没上线。",
                          {"pause_ratio": 0.8, "gaze_off": 0.4})
    req = cws.of("record_request")
    check("候选人收到 record_request", len(req) == 1)
    if req:
        check("取证时长 >= 15 秒", req[0]["seconds"] >= 15,
              f"seconds={req[0]['seconds']}")
        check("带了触发原因", bool(req[0].get("reason")),
              f"reason={req[0].get('reason')!r}")
    cr = iws.of("confirm_requested")
    check("面试官看到「正在取证」", len(cr) == 1,
          f"used={cr[0]['used']}/{cr[0]['budget']}" if cr else "")
    check("pending 已记录", hub.pending is not None)

    # ---------------- 阶段 4：证据回来且生理确认 ----------------
    print("\n[4] 候选人回传视频（高心率）——双确认应成立")
    iws.clear()
    await hub.on_video_chunk(base64.b64encode(b"fake-video").decode(), 170.0)
    hints = iws.of("hint")
    check("产生了 hint", len(hints) == 1)
    if hints:
        check("标了 confirmed", hints[0].get("confirmed") is True)
        check("提示文案够短", len(hints[0]["text"]) <= 12,
              f"{hints[0]['text']!r}")
        check("why 同时含生理与行为证据",
              "σ" in hints[0]["why"], hints[0]["why"])
    check("pending 已清空", hub.pending is None)
    check("FacePhys 被调用 1 次", ws_mod.PROVIDER.calls == 1)

    # ---------------- 阶段 5：生理没确认上 ----------------
    print("\n[5] 再次行为异常，但心率与基线持平——应该明确回复「没证实」")
    iws.clear(); cws.clear()
    await hub.on_turn_start(200.0)
    await hub.on_turn_end(230.0, "又是一段绕圈的回答。", {"pause_ratio": 0.85})
    check("再次发出 record_request", len(cws.of("record_request")) == 1)
    await hub.on_video_chunk(base64.b64encode(b"fake-video-2").decode(), 250.0)
    check("没有产生 hint", not iws.of("hint"))
    res = iws.of("confirm_result")
    check("回传 confirm_result{confirmed:false}", len(res) == 1
          and res[0]["confirmed"] is False,
          f"load_z={res[0]['load_z']}" if res else "")

    # ---------------- 阶段 6：预算闸门 ----------------
    print("\n[6] 预算闸门：把预算压到 1，再触发不应该再花钱")
    config.CONFIRM_MAX = 1
    hub.confirm_used = 1
    iws.clear(); cws.clear()
    await hub.on_turn_start(300.0)
    await hub.on_turn_end(330.0, "又一段。", {"pause_ratio": 0.9})
    check("预算耗尽后不再请求", not cws.of("record_request"))

    hub.shutdown()
    await asyncio.sleep(0.05)

    print("\n" + "=" * 52)
    if FAILS:
        print(f"❌ FAIL —— {len(FAILS)} 项不通过：")
        for f in FAILS:
            print(f"   - {f}")
        return 1
    print("✅ PASS —— 触发/确认链路全部符合预期")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
