"""端到端验证：真实音频 → 后端起服务端 ASR → 转写结果回到两端。

前提：后端起着，并且 .env 里 STT_ENABLED=1、STT_API_KEY 有效、装了 dashscope。

    python tools/test_stt_e2e.py --audio path/to/speech.wav
"""
import argparse
import asyncio
import base64
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                    / "backend"))
HOME = Path.home()
sys.path.insert(0, str(Path(r"D:\Bohack\.pylibs")))
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


async def grab(ws, want, timeout=60.0):
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") == want:
            return msg


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--expect", default="")
    args = ap.parse_args()

    audio = Path(args.audio).read_bytes()
    suffix = Path(args.audio).suffix.lower()
    ct = "audio/wav" if suffix == ".wav" else "audio/webm"
    print(f"音频 {Path(args.audio).name}  {len(audio)} bytes  ct={ct}")

    cfg = api("/api/config")
    print(f"后端 provider={cfg.get('vision_provider')}")

    room = api("/api/rooms", {"job_title": "STT 端到端"})
    code = room["code"]
    print(f"房间 {code}")

    async with websockets.connect(WS.format(code, "interviewer")) as iws, \
            websockets.connect(WS.format(code, "candidate") + "&consent=1") as cws:
        await grab(iws, "hello_ack")
        await grab(cws, "hello_ack")

        payload = {"type": "audio_chunk",
                   "data": base64.b64encode(audio).decode(),
                   "ct": ct}
        print("发送 audio_chunk（服务端开始转写，可能 2~5 秒）…")
        await cws.send(json.dumps(payload))

        mi = await grab(iws, "transcript")
        mc = await grab(cws, "transcript")
        print(f"\n面试官收到: [{mi['role']}] {mi['text']!r}")
        print(f"候选人收到: [{mc['role']}] {mc['text']!r}")

        if mi["role"] != "candidate":
            print("❌ 角色标错了")
            return 1
        if args.expect and args.expect not in mi["text"]:
            print(f"❌ 转写里没找到预期内容 {args.expect!r}")
            return 1

    info = api(f"/api/rooms/{code}")
    tr = api(f"/api/sessions/{info['session_id']}/transcript")
    print(f"落库 {tr['total']} 条")
    print("\n✅ 服务端 ASR 端到端通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
