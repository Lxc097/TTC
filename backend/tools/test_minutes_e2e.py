"""端到端验证：真实 WebSocket 上跑一遍会议纪要。

不用 mock：起两个真 WS 连接（面试官 + 候选人），候选人发一句 stt，
看两端是否都收到 transcript，并检查 REST 历史接口。
"""
import asyncio
import json
import sys
import urllib.request

sys.path.insert(0, r"D:\Bohack\.pylibs")
import websockets  # noqa: E402

HTTP = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/ws/room/{}?role={}"


def api(path, data=None):
    req = urllib.request.Request(
        HTTP + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


async def grab(ws, want, timeout=5.0):
    """一直读，直到收到 want 类型的消息。"""
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") == want:
            return msg


async def main():
    room = api("/api/rooms", {"job_title": "纪要端到端测试"})
    code = room["code"]
    print(f"房间 {code}")

    async with websockets.connect(WS.format(code, "interviewer")) as iws, \
            websockets.connect(WS.format(code, "candidate") + "&consent=1") as cws:
        await grab(iws, "hello_ack")
        await grab(cws, "hello_ack")
        print("两端已连接")

        # ① 候选人说一句
        await cws.send(json.dumps({"type": "stt",
                                   "text": "我做过三年后端，主要负责订单系统。",
                                   "final": True}))
        mi, mc = await asyncio.gather(grab(iws, "transcript"),
                                      grab(cws, "transcript"))
        print(f"面试官收到: [{mi['role']}] {mi['text']!r}  t={mi['t']}")
        print(f"候选人收到: [{mc['role']}] {mc['text']!r}")
        assert mi["role"] == "candidate", "角色标注错了"
        assert mi["text"] == "我做过三年后端，主要负责订单系统。"

        # ② 面试官说一句（客户端故意伪造 speaker，服务端必须忽略）
        await iws.send(json.dumps({"type": "stt", "text": "具体负责哪部分？",
                                   "final": True, "speaker": "candidate"}))
        mi2, _ = await asyncio.gather(grab(iws, "transcript"),
                                      grab(cws, "transcript"))
        print(f"面试官再收到: [{mi2['role']}] {mi2['text']!r}")
        assert mi2["role"] == "interviewer", "服务端必须按角色判定，忽略客户端 speaker"

        # ③ 中间结果不落库
        await cws.send(json.dumps({"type": "stt", "text": "我", "final": False}))
        mid = await grab(iws, "transcript")
        assert mid["final"] is False

    # 通过 REST 验证落库
    sid = None
    # 客户端的 hello_ack 里有 session_id
    # 重新建连只为拿 session_id 太浪费，直接从房间状态取
    info = api(f"/api/rooms/{code}")
    sid = info["session_id"]
    print(f"session_id = {sid}")

    tr = api(f"/api/sessions/{sid}/transcript")
    print(f"落库条数 = {tr['total']}（应该是 2：中间结果不算）")
    for it in tr["items"]:
        print(f"   [{it['role']}] {it['text']!r}")
    assert tr["total"] == 2, f"预期 2 条 final，实际 {tr['total']}"

    rep = api(f"/api/sessions/{sid}/report")
    print(f"报告里纪要条数 = {len(rep.get('transcript') or [])}")

    print("\n✅ 会议纪要端到端通过")


if __name__ == "__main__":
    asyncio.run(main())
