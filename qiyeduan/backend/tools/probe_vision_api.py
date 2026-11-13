"""真实视觉 API 接入探针。

用途：在你写任何业务代码之前，先花 3 分钟搞清楚这个 API 到底长什么样。

    # 1) 先自检适配层是否正常（不需要网络、不需要真实 API）
    python tools/probe_vision_api.py --self-test

    # 2) 再打真实 API，看返回结构、延迟、以及能不能被正确解析
    set VISION_API_URL=https://vendor.example.com/v1/physio
    set VISION_API_KEY=sk-xxxx
    python tools/probe_vision_api.py --image samples/face.jpg --times 5

输出会把四件事一次说清：原始响应长什么样、被映射成了什么、延迟多少、
以及「延迟是否满足轮次级提示（<3s）」这个决定性的结论。
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("VISION_API_URL", "http://127.0.0.1:0/unset")

from vision_http import HttpVisionProvider   # noqa: E402


def start_mock_server() -> tuple[HTTPServer, str]:
    """起一个本地假服务，返回 (server, url)。用来自检适配层。"""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            time.sleep(0.05)                     # 模拟网络往返
            payload = {
                "code": 0,
                "data": {
                    "heart_rate": 78.2,
                    "breath_rate": 16.1,
                    "quality": 0.91,
                    "face_count": 1,
                    "emotion": "neutral",        # 厂商给的情绪标签，我们不接也不传
                    "_received_bytes": len(body),
                },
            }
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args) -> None:    # 静音
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/vision"
    return server, url


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true",
                    help="起本地假服务自检适配层，不访问外网")
    ap.add_argument("--url", default=os.getenv("VISION_API_URL", ""))
    ap.add_argument("--key", default=os.getenv("VISION_API_KEY", ""))
    ap.add_argument("--image", default="", help="一张含人脸的 jpg/png")
    ap.add_argument("--times", type=int, default=3)
    ap.add_argument("--mode", default=os.getenv("VISION_API_MODE", "frame"))
    args = ap.parse_args()

    server = None
    url = args.url
    if args.self_test:
        server, url = start_mock_server()
        print(f"[自检] 本地假服务已启动 {url}")

    if not url:
        print("缺少 --url 或 VISION_API_URL")
        return 2

    frame = b""
    if args.image:
        p = Path(args.image)
        if not p.exists():
            print(f"图片不存在：{p}")
            return 2
        frame = p.read_bytes()
        print(f"[输入] {p.name}  {len(frame)} bytes")
    else:
        frame = b"\xff\xd8\xff\xe0" + b"0" * 2000    # 占位字节
        print("[输入] 未指定 --image，使用占位字节（真实 API 会返回无脸，属正常）")

    os.environ["VISION_API_MODE"] = args.mode
    provider = HttpVisionProvider(url=url, key=args.key)
    print(f"[配置] mode={provider.mode} payload={provider.payload_kind} "
          f"timeout={provider.timeout}s")

    latencies: list[float] = []
    print(f"\n[请求] 连打 {args.times} 次 …")
    for i in range(args.times):
        try:
            if provider.wants_segment:
                s = provider.sample_segment([frame] * 3, float(i))
            else:
                s = provider.sample(frame, float(i))
        except Exception as exc:
            print(f"  第 {i + 1} 次失败：{type(exc).__name__}: {exc}")
            continue
        latencies.append(provider.last_latency)
        print(f"  第 {i + 1} 次  {provider.last_latency * 1000:.0f}ms  →  "
              f"hr={s.hr} rr={s.rr} quality={s.quality} "
              f"faces={s.face_count} usable={s.usable}")

    if provider.last_raw is not None:
        print("\n[原始响应]")
        print(json.dumps(provider.last_raw, ensure_ascii=False, indent=2)[:1200])

    if not latencies:
        print("\n❌ 全部失败，先检查 URL / Key / 请求体格式")
        if server:
            server.shutdown()
        return 1

    lat = sorted(latencies)
    avg = statistics.mean(lat)
    print("\n[延迟] "
          f"min={lat[0] * 1000:.0f}ms  avg={avg * 1000:.0f}ms  "
          f"max={lat[-1] * 1000:.0f}ms")

    print("\n[结论]")
    if avg < 3.0:
        print("  ✅ 延迟满足「轮次级提示」：回答结束后 3 秒内能给出建议。")
    else:
        print("  ⚠️ 延迟超 3 秒，逐轮提示会卡。降级方案：")
        print("     - 只做整场结束后的报告（叙事不变，只是没了实时感）")
        print("     - 或者把 BASELINE 拉长、SAMPLE_MIN_INTERVAL 调大，减少调用")

    if provider.last_raw and "data" in provider.last_raw and \
            "heart_rate" in provider.last_raw.get("data", {}):
        print("  ✅ 响应结构已被默认字段映射识别，不需要改代码。")
    else:
        print("  ⚠️ 默认字段名没命中，用 VISION_FIELD_HR 等环境变量指定路径，")
        print("     例如 set VISION_FIELD_HR=result.physio.bpm")

    if provider.last_raw and "emotion" in json.dumps(provider.last_raw):
        print("  ℹ️ 响应里有情绪标签 —— 我们的 PhysioSample 不接这个字段，")
        print("     别顺手传下去，那是合规红线。")

    if server:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
