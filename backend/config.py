"""全局配置。所有可调参数集中在这里，方便 demo 前 5 分钟改阈值。"""
from __future__ import annotations

import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# ---------- 环境 ----------
# mock: 假生理数据（前端可立刻联调 / demo 兜底）
# real: 对接云端人脸与生理 API（见 vision.py 的 TODO）
VISION_PROVIDER = os.getenv("VISION_PROVIDER", "mock")

# ---------- 采样 ----------
FRAME_FPS = _i("FRAME_FPS", 5)                 # 候选人上报帧率，仅用于校验
MIN_QUALITY = _f("MIN_QUALITY", 0.5)           # 低于此质量的数据直接丢弃
SAMPLE_MIN_INTERVAL = _f("SAMPLE_MIN_INTERVAL", 2.0)  # 两次调 API 的最小间隔（秒）

# ---------- 基线 ----------
BASELINE_SECONDS = _f("BASELINE_SECONDS", 60.0)  # 前 N 秒只采样、不出提示
BASELINE_MIN_SAMPLES = _i("BASELINE_MIN_SAMPLES", 8)

# ---------- 双确认阈值 ----------
PROBE_THRESHOLD = _f("PROBE_THRESHOLD", 1.5)     # 生理偏离（robust z）
BEHAVIOR_THRESHOLD = _f("BEHAVIOR_THRESHOLD", 0.5)  # 行为异常分 0..1
QUIET_THRESHOLD = _f("QUIET_THRESHOLD", -0.5)    # 负荷"过低"（题太浅）
HINT_COOLDOWN = _f("HINT_COOLDOWN", 30.0)        # 两条提示最小间隔（秒）

# ---------- 报告 ----------
REPORT_MAX_POINTS = _i("REPORT_MAX_POINTS", 3)
LLM_ENABLED = os.getenv("LLM_ENABLED", "0") == "1"

# ---------- Mock 专用 ----------
# 格式 "30-45,120-140"，表示这些时间段模拟负荷升高，方便排练 demo
MOCK_STRESS_WINDOWS = os.getenv("MOCK_STRESS_WINDOWS", "25-40,85-100")
