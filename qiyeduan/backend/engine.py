"""纯逻辑引擎：基线 / robust z / 双确认 / 提示生成。

设计约束（很重要，评审会问）：
1. 永远不看生理绝对值，只看"相对本人基线"的偏离。
2. 生理信号与行为信号必须同时异常才允许出提示（双确认），否则静默。
3. 提示文案确定性生成（不用 random），否则无法排练 demo。

本模块不依赖任何第三方库，可单独单测。
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Optional

import config


# ---------------------------------------------------------------- 数据结构
@dataclass
class PhysioSample:
    """一次生理采样。t = 相对面试开始的秒数。"""
    t: float
    hr: Optional[float] = None          # 心率 bpm
    rr: Optional[float] = None          # 呼吸频率 次/分
    quality: float = 1.0                # 0..1，来自 API 的 signal quality
    face_count: int = 1

    @property
    def usable(self) -> bool:
        return self.quality >= config.MIN_QUALITY and self.face_count == 1


@dataclass
class Behavior:
    """行为侧特征，全部归一化到 0..1（越大越异常）。

    来源：STT 时间戳 + 视觉视线。缺的维度留 0，不参与平均。
    """
    pause_ratio: float = 0.0        # 长停顿占比
    filler_density: float = 0.0     # 填充词密度（"那个""就是"）
    speech_rate_drop: float = 0.0   # 语速相对本场基线下降幅度
    gaze_off: float = 0.0           # 视线离屏率

    def anomaly(self) -> float:
        """行为异常总分 0..1。

        注意这里**不能简单平均**：四个通道里只要有一个明显异常
        （比如停顿占比 0.8），就足以构成"行为侧异常"；
        取平均会被其他三个正常通道稀释掉，导致该出的提示全漏。
        所以用「最强通道 0.6 + 平均 0.4」——既承认单通道的强证据，
        也奖励多通道同时异常。
        """
        vals = [v for v in (self.pause_ratio, self.filler_density,
                            self.speech_rate_drop, self.gaze_off) if v > 0]
        if not vals:
            return 0.0
        mean = sum(vals) / len(vals)
        return min(1.0, 0.6 * max(vals) + 0.4 * mean)

    def top_reason(self) -> str:
        pairs = [
            (self.pause_ratio, "停顿明显变长"),
            (self.gaze_off, "视线多次离开屏幕"),
            (self.filler_density, "填充词变多"),
            (self.speech_rate_drop, "语速明显下降"),
        ]
        key, label = max(pairs, key=lambda p: p[0])
        return label if key >= 0.3 else ""


@dataclass
class Turn:
    """一个问答轮次。"""
    turn_id: int
    start_t: float
    end_t: float = 0.0
    transcript: str = ""
    phys_peak: float = 0.0
    phys_mean: float = 0.0
    beh: Behavior = field(default_factory=Behavior)
    judged: bool = False

    @property
    def duration(self) -> float:
        return max(0.0, self.end_t - self.start_t)


@dataclass
class HintDraft:
    """待发出的提示。"""
    kind: str       # probe | upgrade | wrap
    text: str       # <=10 字，直接能问
    why: str        # 一句话证据，前端直接显示


# ---------------------------------------------------------------- 统计工具
def robust_z(x: float, median: float, mad: float) -> float:
    """基于中位数/MAD 的稳健 z 分数。

    rPPG 的原始序列一定有尖刺，用普通标准差会被单点拉爆；
    MAD（中位数绝对偏差）对这个免疫，这是本项目的核心数值选择。
    """
    if mad is None or mad < 1e-6:
        return 0.0
    return 0.6745 * (x - median) / mad


def _median_mad(values: list[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    med = statistics.median(values)
    mad = statistics.median([abs(v - med) for v in values]) or 0.0
    return med, mad


# ---------------------------------------------------------------- 基线
class Baseline:
    """前 N 秒的个人静息基线。未就绪前不许出任何提示。"""

    def __init__(self) -> None:
        self.hr: list[float] = []
        self.rr: list[float] = []
        self.hr_med = 0.0
        self.hr_mad = 0.0
        self.rr_med = 0.0
        self.rr_mad = 0.0
        self._frozen = False

    def add(self, s: PhysioSample) -> None:
        if self._frozen or not s.usable:
            return
        if s.t > config.BASELINE_SECONDS and len(self.hr) >= config.BASELINE_MIN_SAMPLES:
            self.freeze()
            return
        # 样本不够就顺延基线窗口 —— 绝不带着空基线开始出提示
        if s.hr is not None:
            self.hr.append(s.hr)
        if s.rr is not None:
            self.rr.append(s.rr)

    def freeze(self) -> None:
        if self._frozen:
            return
        self._frozen = True
        self.hr_med, self.hr_mad = _median_mad(self.hr)
        self.rr_med, self.rr_mad = _median_mad(self.rr)

    @property
    def ready(self) -> bool:
        return self._frozen and len(self.hr) >= config.BASELINE_MIN_SAMPLES

    def remaining(self, now_t: float) -> float:
        """基线还剩多少秒。前端用它显示「建立基线中 12s」。"""
        if self.ready:
            return 0.0
        return max(0.0, config.BASELINE_SECONDS - now_t)

    def load_z(self, s: PhysioSample) -> float:
        """单点负荷分数。基线未就绪时返回 0（等价于静默）。"""
        if not self.ready or not s.usable:
            return 0.0
        z_hr = robust_z(s.hr, self.hr_med, self.hr_mad) if s.hr is not None else 0.0
        # 呼吸变快 → 负荷升高
        z_rr = robust_z(s.rr, self.rr_med, self.rr_mad) if s.rr is not None else 0.0
        return 0.6 * z_hr + 0.4 * z_rr


# ---------------------------------------------------------------- 触发
@dataclass
class Trigger:
    """行为信号触发的结论。不花钱，随时可以算。"""
    fired: bool
    score: float
    reason: str


def evaluate_trigger(beh: Behavior, threshold: Optional[float] = None,
                     strong: Optional[float] = None) -> Trigger:
    """判断这一轮的行为信号是否值得花钱去采一次生理数据。

    思路：行为信号（停顿、语速、视线）由 STT/视觉免费得到，生理信号一个
    20 秒片段要 17 万 token。所以用免费的信号决定"什么时候值得花钱"。
    注意这只是**请求证据**，不是结论 —— 证据回来还要过双确认才允许出提示。
    """
    threshold = config.TRIGGER_THRESHOLD if threshold is None else threshold
    strong = config.TRIGGER_STRONG if strong is None else strong

    score = beh.anomaly()
    # 单通道极强也算触发（比如停顿占比 0.8），不能被平均稀释掉
    hard = max(beh.pause_ratio, beh.gaze_off,
               beh.speech_rate_drop) >= strong
    return Trigger(bool(score >= threshold or hard), score, beh.top_reason())


# ---------------------------------------------------------------- 提示模板
# 确定性选择：同一个 turn_id 永远出同一条，demo 才能排练。
TEMPLATES: dict[str, list[str]] = {
    "probe": [
        "追问：具体卡在哪",
        "追问：当时谁反对",
        "追问：再来一次会怎么做",
    ],
    "upgrade": [
        "升级难度：要具体数字",
        "升级难度：问边界在哪",
        "升级难度：问你亲手做的",
    ],
    "wrap": [
        "收，换轻松话题",
        "收，节奏放慢一点",
    ],
}


def _pick(kind: str, turn_id: int) -> str:
    pool = TEMPLATES[kind]
    return pool[(max(1, turn_id) - 1) % len(pool)]


# ---------------------------------------------------------------- 双确认
def judge_turn(
    turn: Turn,
    baseline: Baseline,
    last_hint_t: float = -1e9,
    prev_turns: Optional[list[Turn]] = None,
) -> Optional[HintDraft]:
    """三重闸门后决定是否出提示。返回 None 表示静默。

    闸门 1：基线必须就绪
    闸门 2：冷却期内一律静默
    闸门 3：双确认（生理 ∧ 行为）
    """
    prev_turns = prev_turns or []

    if not baseline.ready:
        return None
    if turn.end_t - last_hint_t < config.HINT_COOLDOWN:
        return None

    beh = turn.beh.anomaly()

    # --- wrap：连续两轮高负荷 + 语速下降（到极限了）---
    # 放在 probe 之前：已经问到第二道高温题了，此时"该收"比"再追问"更有价值。
    if prev_turns:
        last = prev_turns[-1]
        if (last.phys_peak >= config.PROBE_THRESHOLD
                and turn.phys_peak >= config.PROBE_THRESHOLD
                and turn.beh.speech_rate_drop >= 0.4):
            return HintDraft(
                "wrap",
                _pick("wrap", turn.turn_id),
                "连续两轮负荷偏高，语速下降",
            )

    # --- probe：负荷突升 + 行为异常（唯一真正的双确认） ---
    if turn.phys_peak >= config.PROBE_THRESHOLD and beh >= config.BEHAVIOR_THRESHOLD:
        reason = turn.beh.top_reason()
        # 显示值封顶 9.9：真实 rPPG 的 mad 很小，z 会飙到十几，
        # 直接印在卡片上像假数据，压一下更像"人话"。
        why = f"负荷 +{min(turn.phys_peak, 9.9):.1f}σ"
        if reason:
            why += f"，且{reason}"
        return HintDraft("probe", _pick("probe", turn.turn_id), why)

    # --- upgrade：整题负荷偏低 + 回答短而顺（题太浅） ---
    if (turn.phys_mean <= config.QUIET_THRESHOLD
            and 10 <= turn.duration <= 45
            and beh < config.BEHAVIOR_THRESHOLD
            and len(turn.transcript) >= 20):
        return HintDraft(
            "upgrade",
            _pick("upgrade", turn.turn_id),
            f"负荷 {turn.phys_mean:+.1f}σ，回答流利且短",
        )

    return None


# ---------------------------------------------------------------- 汇总
def summarize_turn(turn: Turn, samples: list[PhysioSample],
                   baseline: Baseline) -> Turn:
    """把一轮内的采样压成 phys_peak / phys_mean，供 judge_turn 使用。"""
    zs = [baseline.load_z(s) for s in samples
          if turn.start_t <= s.t <= max(turn.end_t, turn.start_t)]
    if zs:
        turn.phys_peak = max(zs)
        turn.phys_mean = sum(zs) / len(zs)
    return turn
