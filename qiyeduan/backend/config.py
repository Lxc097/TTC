"""全局配置。所有可调参数集中在这里，方便 demo 前 5 分钟改阈值。"""
from __future__ import annotations

import os
from pathlib import Path


def _parse_dotenv(text: str) -> dict[str, str]:
    """纯函数：.env 文本 → dict。不碰文件系统，方便单测。

    规则：
    - 忽略空行与 # 注释
    - KEY=VALUE，等号两边空格无所谓
    - 值被引号包裹时去掉引号，但**保留引号内的尾部空格**
      （VISION_AUTH_PREFIX="Bearer " 依赖这一点，否则鉴权头会拼成 Bearerxxx）
    """
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        key = k.strip()
        if not key:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[key] = v
    return out


def _load_dotenv(path: Path) -> None:
    """极简 .env 加载，不引入 python-dotenv 依赖。

    **真实环境变量优先**（set 过的不会被 .env 覆盖），
    这样 demo 现场用 set VISION_PROVIDER=mock 临时切换不会失效。

    密钥只放 .env，.env 已被 .gitignore 排除 —— 永远不要让密钥进仓库。
    """
    if not path.exists():
        return
    for k, v in _parse_dotenv(path.read_text(encoding="utf-8")).items():
        os.environ.setdefault(k, v)


# 测试/CI 里设 TTC_SKIP_DOTENV=1，避免开发者本地 .env 影响测试结果
# （本地 .env 里 VISION_PROVIDER=facephys 会让逐帧管道的测试全部失效）
if os.getenv("TTC_SKIP_DOTENV") != "1":
    _load_dotenv(Path(__file__).with_name(".env"))


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
