"""素材体检：用一条真实视频跑一次 FacePhys，并给出"这段素材能不能用于 demo"的结论。

一次调用约 17 万 token，别反复跑。

    python tools/check_video.py --video D:\\xxx.mp4

输出三层：
  1. 接口事实：hr / sqi / 呼吸率 / 活体 / 延迟 / 扣费
  2. 引擎视角：这段数据会不会进基线、能不能算出负荷
  3. 拍摄建议：按实测 sqi 给具体改进项
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from shared import config  # noqa: E402
from shared.engine import Baseline, PhysioSample  # noqa: E402
from shared.vision_facephys import FacePhysProvider  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    args = ap.parse_args()

    path = Path(args.video)
    if not path.exists():
        print(f"文件不存在：{path}")
        return 2

    size_mb = path.stat().st_size / 1048576
    print(f"素材：{path.name}  {size_mb:.2f} MB")
    print(f"配置：MIN_QUALITY={config.MIN_QUALITY} "
          f"SQI_STRONG={config.SQI_STRONG}\n")

    provider = FacePhysProvider()
    print("[调用 FacePhys …]")
    sample = provider.sample_video(path.read_bytes(), t=30.0)

    print("\n=== 1. 接口事实 ===")
    print(f"  心率 hr      = {sample.hr}")
    print(f"  呼吸率 rr    = {sample.rr}  "
          f"{'（' + provider.last_rr_reason + '）' if provider.last_rr_reason else ''}")
    print(f"  信号质量 sqi = {sample.quality:.3f}")
    print(f"  人脸数       = {sample.face_count}")
    print(f"  延迟         = {provider.last_latency:.1f}s")
    lv = provider.last_liveness or {}
    if lv:
        print(f"  活体         = is_live={lv.get('is_live')} "
              f"score={lv.get('score')} status={lv.get('status')}")
    print(f"  Token 扣费   = {provider.last_deducted}   剩余 = {provider.tokens_left}")

    print("\n=== 2. 引擎视角 ===")
    print(f"  能进基线吗：{'能' if sample.usable else '不能'} "
          f"（阈值 sqi >= {config.MIN_QUALITY}）")
    level = ("好" if sample.quality >= config.SQI_STRONG
             else "勉强（标 signal_weak）" if sample.usable else "不可用")
    print(f"  信号质量评级：{level}")

    # 同一条视频重复调用结果一致，基线方差会是 0，
    # 这会让 robust_z 恒为 0 —— 也就是永远不出提示。
    b = Baseline()
    for i in range(3):
        b.add(PhysioSample(t=i * 20.0, hr=sample.hr, rr=sample.rr,
                           quality=sample.quality, face_count=1))
    b.freeze()
    print(f"  重复采样建基线：ready={b.ready} mad={b.hr_mad:.3f}")
    if b.hr_mad < 1e-6:
        print("  ⚠ mad=0 → load_z 恒为 0 → 永远不出提示。")
        print("    这不是 bug：同一条视频每次结果一样，基线没有方差。")
        print("    真实面试中候选人的心率会自然波动，基线才有 mad。")

    print("\n=== 3. 拍摄建议 ===")
    tips: list[str] = []
    if not sample.usable:
        tips.append("sqi 低于 0.15：数据不可用，必须重拍")
    elif sample.quality < config.SQI_STRONG:
        tips.append(f"sqi={sample.quality:.2f} 偏低（官方 ≥0.30 才算好）："
                    "注意光线均匀、别逆光、脸占画面 20% 以上、坐稳少动")
    if sample.rr is None:
        tips.append("呼吸率没出来：通常是逐拍序列算不出来，"
                    "视频再长一点（30 秒以上）、保持静止")
    if lv and lv.get("is_live") is False:
        tips.append(f"活体判定未通过（{lv.get('reason')}）："
                    "确保画面里有且只有一张清晰正脸")
    if sample.hr is not None and sample.hr > 100:
        tips.append(f"hr={sample.hr:.0f} 偏高：如果这不是「紧张」本身，"
                    "拍之前静息 2 分钟，避免刚运动完就录")
    if not tips:
        tips.append("素材合格，可以直接用于 demo")
    for t in tips:
        print(f"  · {t}")

    print("\n=== 原始返回（截断）===")
    raw = provider.last_raw or {}
    data = raw.get("data", {})
    print(json.dumps({
        "cardiac": data.get("cardiac"),
        "liveness": {k: v for k, v in (data.get("liveness") or {}).items()
                     if k != "signals"},
        "tokens_deducted": data.get("tokens_deducted"),
    }, ensure_ascii=False, indent=2)[:900])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
