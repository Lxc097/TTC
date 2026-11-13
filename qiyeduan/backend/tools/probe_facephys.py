"""FacePhys 接入探针。

按官方文档实现 HMAC-SHA256 签名，逐级验证：
  1. GET  /api/video/health              免认证，验证网络可达
  2. POST /api/v2/video/upload/presign   验证签名是否正确（200 = 签名对了）
  3. PUT  <uploadUrl>                    验证 OSS 直传
  4. POST /api/v3/video/process          验证提交检测与返回结构

用法：
    python tools/probe_facephys.py            # 只跑到第 2 步（安全，不消耗额度）
    python tools/probe_facephys.py --full     # 跑完四步（会消耗 Token）
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import config  # noqa: E402  触发 .env 加载

BASE = os.getenv("TTC_API_BASE", "https://www.facephys.com")
KEY_ID = os.getenv("TTC_API_KEY_ID", "")
SECRET = os.getenv("TTC_API_SECRET", "")
UA = "facephys-probe/1.0"


def mask(s: str) -> str:
    return s[:4] + "***" + s[-2:] if len(s) > 8 else "***"


def auth_headers() -> dict:
    ts = str(int(time.time()))
    sig = base64.b64encode(
        hmac.new(SECRET.encode("utf-8"), ts.encode("utf-8"),
                 hashlib.sha256).digest()
    ).decode()
    return {"x-key-id": KEY_ID, "x-timestamp": ts, "x-signature": sig}


def call(method: str, url: str, payload=None, content_type="application/json",
         signed=True, timeout=30):
    headers = {"User-Agent": UA}
    if signed:
        headers.update(auth_headers())
    body = None
    if payload is not None:
        headers["Content-Type"] = content_type
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code, text = r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        code, text = e.code, raw.decode("utf-8", "replace")
    except Exception as e:
        return None, f"{type(e).__name__}: {e}", time.monotonic() - t0
    return code, text, time.monotonic() - t0


def show(label: str, code, text: str, dt: float) -> None:
    body = text[:400].replace("\n", " ")
    print(f"  {label:34s} {code}  {dt * 1000:6.0f}ms  {body}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="跑完上传+检测（消耗 Token）")
    ap.add_argument("--video", default="", help="真实人脸视频路径（15s 以上）")
    args = ap.parse_args()

    if not KEY_ID or not SECRET:
        print("缺少 TTC_API_KEY_ID / TTC_API_SECRET（应写在 backend/.env）")
        return 2
    print(f"[配置] base={BASE} key_id={mask(KEY_ID)} secret={mask(SECRET)}\n")

    print("[1] 健康检查（免认证）")
    code, text, dt = call("GET", f"{BASE}/api/video/health", signed=False)
    show("GET /api/video/health", code, text, dt)
    if code != 200:
        print("  ⚠️ 连不上，后面的不用试了")
        return 1

    print("\n[2] 请求直传签名（这一步验证签名算法对不对）")
    code, text, dt = call("POST", f"{BASE}/api/v2/video/upload/presign", {})
    show("POST /api/v2/video/upload/presign", code, text, dt)
    if code != 200:
        print("\n  401/403 说明签名错了，检查：")
        print("   - x-key-id 填的是 Key ID，不是 secret")
        print("   - 签名原文是 timestamp 字符串，不是别的")
        print("   - 本机时间是否准确（±300 秒窗口）")
        return 1
    print("\n  ✅ 签名正确，鉴权通过")

    data = json.loads(text)
    upload_url = data.get("uploadUrl")
    object_key = data.get("objectKey")
    print(f"  objectKey = {object_key}")

    if not args.full:
        print("\n（未加 --full，到此为止。已确认：网络通、签名对、能拿到直传 URL。）")
        return 0

    print("\n[3] 上传视频")
    if args.video:
        video = Path(args.video).read_bytes()
        ctype = "video/mp4" if args.video.lower().endswith(".mp4") else "video/webm"
    else:
        # 服务端要求 ≥10240 字节，占位字节要给够，否则会卡在 VIDEO_UPLOAD_INCOMPLETE
        video = b"\x00" * 65536
        ctype = "video/mp4"
        print("  （无真实视频，用 64KB 占位字节：只能验证链路，不可能出心率）")
    code, text, dt = call("PUT", upload_url, video, content_type=ctype,
                          signed=False)
    show(f"PUT upload ({len(video)}B)", code, text, dt)
    if code is None or code >= 400:
        print("  上传失败")
        return 1

    print("\n[4] 提交检测")
    code, text, dt = call("POST", f"{BASE}/api/v3/video/process",
                          {"objectKey": object_key, "capability": "rppg"})
    show("POST /api/v3/video/process", code, text, dt)
    if code == 200:
        try:
            d = json.loads(text).get("data", {})
            cardiac = d.get("cardiac", d)
            print(f"\n  hr={cardiac.get('hr')} sqi={cardiac.get('sqi')} "
                  f"breathing={d.get('breathing_rate')}")
            print(f"  tokens_deducted={d.get('tokens_deducted')} "
                  f"remaining_tokens={d.get('remaining_tokens')}")
        except Exception as e:
            print(f"  解析失败：{e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
