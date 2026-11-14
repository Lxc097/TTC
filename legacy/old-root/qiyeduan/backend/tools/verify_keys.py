"""验证三个外部 API 的 key 是否可用。

    python tools/verify_keys.py          # 只验证连通性和鉴权（免费）
    python tools/verify_keys.py --asr    # 额外跑一次真实转写（极少量费用）

设计原则：默认不花钱。FacePhys 只请求上传签名（不提交检测，不扣 token），
DeepSeek 和百炼只列模型。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import config  # noqa: E402  触发 .env 加载

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'✅' if ok else '❌'} {name}" + (f"  {detail}" if detail else ""))


def http(method: str, url: str, body: bytes | None = None,
         headers: dict | None = None, timeout: float = 20) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, headers=headers or {},
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as exc:                          # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------- FacePhys
def check_facephys() -> None:
    print("\n[1] FacePhys（心率/信号质量/活体）")
    base = config.__dict__.get("TTC_API_BASE") or "https://www.facephys.com"
    key_id = __import__("os").getenv("TTC_API_KEY_ID", "")
    secret = __import__("os").getenv("TTC_API_SECRET", "")
    if not key_id or not secret:
        record("凭据", False, "TTC_API_KEY_ID / TTC_API_SECRET 未配置")
        return
    record("凭据", True, f"key_id={key_id[:4]}***{key_id[-2:]}")

    code, text = http("GET", f"{base}/api/video/health",
                      headers={"User-Agent": "ttc-verify"})
    record("健康检查（免鉴权）", code == 200, f"HTTP {code}")

    ts = str(int(time.time()))
    sig = base64.b64encode(
        hmac.new(secret.encode(), ts.encode(), hashlib.sha256).digest()
    ).decode()
    code, text = http(
        "POST", f"{base}/api/v2/video/upload/presign", b"{}",
        headers={"x-key-id": key_id, "x-timestamp": ts, "x-signature": sig,
                 "Content-Type": "application/json",
                 "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/120.0.0.0 Safari/537.36"})
    if code == 200:
        try:
            ok = bool(json.loads(text).get("uploadUrl"))
        except json.JSONDecodeError:
            ok = False
        record("HMAC 签名（不扣 token）", ok, "拿到直传地址")
    else:
        hint = ""
        if code == 401:
            hint = "Key ID 抄错了？注意 0/O、l/I"
        elif code == 403:
            hint = "多半是 User-Agent 被拦"
        record("HMAC 签名", False, f"HTTP {code} {hint}")


# ---------------------------------------------------------------- DeepSeek
def check_llm() -> None:
    print("\n[2] DeepSeek（语义分析 / 写追问 / 报告摘要）")
    if not config.LLM_ENABLED:
        record("开关", False, "LLM_ENABLED=0，未启用")
        return
    key = __import__("os").getenv("LLM_API_KEY", "")
    if not key:
        record("凭据", False, "LLM_API_KEY 未配置")
        return
    record("凭据", True, f"{key[:5]}***{key[-4:]}  模型 {config.LLM_MODEL}")

    code, text = http("GET", f"{config.LLM_BASE_URL.rstrip('/')}/models",
                      headers={"Authorization": f"Bearer {key}",
                               "User-Agent": "ttc-verify"})
    record("模型列表", code == 200, f"HTTP {code}")


# ---------------------------------------------------------------- 百炼 ASR
def check_stt(do_asr: bool) -> None:
    print("\n[3] 百炼 ASR（语音转文字）")
    if not config.STT_ENABLED:
        record("开关", False, "STT_ENABLED=0，未启用（前端会退回手打）")
        return
    key = config.STT_API_KEY
    if not key:
        record("凭据", False, "STT_API_KEY 未配置")
        return
    record("凭据", True, f"{key[:8]}***  模型 {config.STT_MODEL}")

    code, text = http("GET", "https://dashscope.aliyuncs.com/api/v1/models"
                      "?page_no=1&page_size=1",
                      headers={"Authorization": f"Bearer {key}",
                               "User-Agent": "ttc-verify"})
    record("模型列表", code == 200, f"HTTP {code}")

    if not do_asr:
        print("     （没加 --asr，跳过真实转写）")
        return

    import stt as stt_mod
    client = stt_mod.get_stt()
    if client is None:
        record("真实转写", False, "客户端初始化失败")
        return
    sample = BACKEND / "tools" / "sample_speech.wav"
    if not sample.exists():
        record("真实转写", False, f"缺少示例音频 {sample.name}")
        return
    t0 = time.monotonic()
    text = client.transcribe(sample.read_bytes(), "wav")
    dt = time.monotonic() - t0
    record("真实转写", bool(text), f"{dt:.1f}s -> {text!r}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asr", action="store_true", help="额外跑一次真实转写")
    args = ap.parse_args()

    print("=" * 60)
    print("三个外部 API 接入验证")
    print(f"provider={config.VISION_PROVIDER}  llm={config.LLM_ENABLED}  "
          f"stt={config.STT_ENABLED}")
    print("=" * 60)

    check_facephys()
    check_llm()
    check_stt(args.asr)

    ok = sum(1 for _, o, _ in RESULTS if o)
    print("\n" + "=" * 60)
    print(f"通过 {ok}/{len(RESULTS)}")
    bad = [n for n, o, _ in RESULTS if not o]
    if bad:
        print("未通过：" + "、".join(bad))
        print("对照 qiyeduan/docs/接入测试指南.md 第 5 节的报错说明。")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
