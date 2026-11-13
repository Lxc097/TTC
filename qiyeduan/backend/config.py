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


def _apply_dotenv(text: str) -> None:
    """把 .env 文本写进环境变量。**真实环境变量优先**（setdefault）。

    拆成纯函数是为了可测：不用真的落一个文件，任何环境（包括只读沙箱）都能跑。
    """
    for k, v in _parse_dotenv(text).items():
        os.environ.setdefault(k, v)


def _load_dotenv(path: Path) -> None:
    """极简 .env 加载，不引入 python-dotenv 依赖。

    密钥只放 .env，.env 已被 .gitignore 排除 —— 永远不要让密钥进仓库。
    """
    if not path.exists():
        return
    _apply_dotenv(path.read_text(encoding="utf-8"))


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
# 低于此质量的数据直接丢弃。
# 官方对 rPPG 的 sqi 分档：>=0.30 可用，0.15~0.30 仅供参考，<0.15 不可用。
# 实测真实手机视频的 sqi 只有 0.20 上下，所以默认取 0.15 这一档下限；
# 0.15~0.30 之间样本仍进基线，但会带 signal_weak 标记，前端应显示"信号偏弱"。
MIN_QUALITY = _f("MIN_QUALITY", 0.15)
SQI_STRONG = _f("SQI_STRONG", 0.30)   # 超过它才算"信号好"
SAMPLE_MIN_INTERVAL = _f("SAMPLE_MIN_INTERVAL", 2.0)  # 两次调 API 的最小间隔（秒）

# ---------- 基线 ----------
BASELINE_SECONDS = _f("BASELINE_SECONDS", 60.0)  # 前 N 秒只采样、不出提示
BASELINE_MIN_SAMPLES = _i("BASELINE_MIN_SAMPLES", 8)

# ---------- 双确认阈值 ----------
PROBE_THRESHOLD = _f("PROBE_THRESHOLD", 1.5)     # 生理偏离（robust z）
BEHAVIOR_THRESHOLD = _f("BEHAVIOR_THRESHOLD", 0.5)  # 行为异常分 0..1
QUIET_THRESHOLD = _f("QUIET_THRESHOLD", -0.5)    # 负荷"过低"（题太浅）
HINT_COOLDOWN = _f("HINT_COOLDOWN", 30.0)        # 两条提示最小间隔（秒）

# ---------- 触发 / 确认（行为触发、生理确认）----------
# 行为信号免费（STT 就能拿到），生理信号一个片段 17 万 token。
# 所以不持续采样，只在行为信号报警时花一次钱去确认。
TRIGGER_THRESHOLD = _f("TRIGGER_THRESHOLD", 0.55)  # 行为异常分达到就请求确认
TRIGGER_STRONG = _f("TRIGGER_STRONG", 0.75)        # 单通道达到这个值直接硬触发
CONFIRM_MAX = _i("CONFIRM_MAX", 5)                 # 每场最多请求几段确认视频（省钱闸门）
CONFIRM_CLIP_SECONDS = _i("CONFIRM_CLIP_SECONDS", 20)  # 每次请求录多长（必须 >=15）
PENDING_TIMEOUT = _f("PENDING_TIMEOUT", 90.0)      # 请求后多久没回来就作废
# 余额低于这个值就不再请求取证：一次 20 秒视频约 17 万 token，
# 现场跑到一半没额度是比"少采一次"严重得多的事故。
TOKEN_FLOOR = _i("TOKEN_FLOOR", 200_000)
# 逐点心率序列里相邻两点的最大合理跳变（bpm）。
# 实测素材出现过 0.9 秒内 85→117.5 的跳变，生理上不可能，属算法换段伪影。
# 超过就判定本段信号不可靠，不进基线 —— 和"宁可静默不可误报"一致。
HR_MAX_JUMP = _f("HR_MAX_JUMP", 15.0)

# ---------- 报告 ----------
REPORT_MAX_POINTS = _i("REPORT_MAX_POINTS", 3)
# LLM 负责"分析"（语义判断 / 写追问 / 写总结），FacePhys 只负责"测量"。
# 没配 key 或关掉时，整条链自动退回模板，不会报错。
LLM_ENABLED = os.getenv("LLM_ENABLED", "0") == "1"
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
LLM_TIMEOUT = _f("LLM_TIMEOUT", 8.0)

# ---------- Mock 专用 ----------
# 格式 "30-45,120-140"，表示这些时间段模拟负荷升高，方便排练 demo
MOCK_STRESS_WINDOWS = os.getenv("MOCK_STRESS_WINDOWS", "25-40,85-100")
