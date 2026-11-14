"""LLM 分析层（OpenAI 兼容接口）。

分工：
    FacePhys  → 只负责"测量"：心率、sqi、活体。（本地零推理）
    本模块     → 负责"分析"：读 transcript 判断有没有绕开关键信息、写追问、写总结。

三条设计约束，任何一条破了这个模块就不该上线：

1. **结构化输出**：LLM 必须回 JSON，只给两个东西——一个 0~1 的语义分、一句追问。
   自由文本没法进闸门，也没法测。
2. **LLM 不拍板**。它给的分数进入数值闸门，出不出提示仍由规则决定；
   生理确认（FacePhys）依然是必要条件。这样 LLM 挂了系统最多变哑，不会乱说话。
3. **失败必须静默降级**。超时/解析失败一律返回 None，由模板兜底，
   绝不阻塞面试流程。

合规红线写在 prompt 里：只判断"表达是否清晰具体"，不评价人格/能力/诚信，
不推测动机。返回里也没有任何这类字段。
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Optional

from shared import config

# 只描述表达，不描述人。这两条同时出现在 prompt 和代码注释里，
# 是为了让改代码的人一眼看到边界在哪。
SYSTEM_PROMPT = """你是面试辅助系统的语义分析模块。你只有一件事要做：
判断候选人的这段回答里，**有没有把关键信息绕过去**。

只看表达，不看人。判断依据：
- 用"我们/团队/公司"代替"我"，但说不清自己具体做了什么
- 用"战略调整/没上线/记不太清/后来就不了了之"这类模糊或被动表述带过原因
- 只有结论没有数字，没有具体动作
- 只讲结果不讲过程

铁律（违反即视为输出无效）：
- 不评价候选人的人格、能力、诚信
- 不使用"撒谎/隐瞒/欺骗/不诚实"等判断词
- 不推测动机，只描述表达是否清晰具体

只输出 JSON，不要 markdown 代码块，不要任何解释文字：
{"semantic": 0.0, "probe": "", "why": ""}

字段说明：
- semantic: 0~1 的浮点数。0 = 直接回答了问题，1 = 明显在绕开关键信息。
- probe: 一句不超过 10 个汉字的追问，能直接照着问。
         semantic < 0.4 时必须为空字符串。
- why: 不超过 30 个汉字，说明你依据的是哪句话或哪种表述。
"""


def _extract_json(text: str) -> Optional[dict]:
    """从模型输出里抠出 JSON。容忍 ```json 围栏和前后废话。"""
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1] if s.count("```") >= 2 else s.lstrip("`")
        s = s.replace("json", "", 1) if s.lstrip().startswith("json") else s
        s = s.strip()
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        obj = json.loads(s[i:j + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _clamp01(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


MAX_PROBE_CHARS = 12          # UI 上是 ≤10 字，留 2 字容错
MIN_PROBE_CHARS = 3


class LLMClient:
    def __init__(self, api_key: str = "", base_url: str = "",
                 model: str = "", timeout: Optional[float] = None) -> None:
        self.api_key = api_key or os.getenv("LLM_API_KEY", "")
        self.base = (base_url or os.getenv("LLM_BASE_URL",
                                           "https://api.deepseek.com")).rstrip("/")
        self.model = model or os.getenv("LLM_MODEL", "deepseek-chat")
        self.timeout = timeout or float(os.getenv("LLM_TIMEOUT", "8"))
        if not self.api_key:
            raise RuntimeError("缺少 LLM_API_KEY")
        self.last_latency = 0.0
        self.last_raw = ""
        self.calls = 0
        self.failures = 0

    # ---------------------------------------------------------- 传输
    def _chat(self, messages: list[dict], max_tokens: int = 200,
              temperature: float = 0.2, json_mode: bool = True) -> Optional[str]:
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        # 只有要求结构化输出的调用才加 response_format。
        # 写自然语言摘要时加了它，接口会直接 400 —— 这个坑踩过一次。
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{self.base}/chat/completions", data=body,
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            method="POST")
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read().decode("utf-8", "replace")
        except Exception:
            self.failures += 1
            return None
        finally:
            self.last_latency = time.monotonic() - t0
        self.calls += 1
        try:
            data = json.loads(raw)
            return data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            self.failures += 1
            return None

    # ---------------------------------------------------------- 语义分析
    def analyze_turn(self, question: str, answer: str,
                     beh_summary: str = "") -> Optional[dict]:
        """一轮回答结束时的语义分析。

        返回 {"semantic": float, "probe": str, "why": str} 或 None。
        None 表示"这次没分析出来"，调用方必须保持原有行为，不能当 0 处理。
        """
        if not answer or len(answer) < 8:
            # 太短的文本没有分析价值，也避免浪费一次调用
            return None

        user = (f"面试问题：{question or '（未提供）'}\n"
                f"候选人回答：{answer}\n"
                f"行为特征：{beh_summary or '（无）'}\n\n"
                f"请按约定输出 JSON。")

        content = self._chat([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ], max_tokens=180, temperature=0.1)
        if content is None:
            return None
        self.last_raw = content

        obj = _extract_json(content)
        if obj is None:
            self.failures += 1
            return None

        semantic = _clamp01(obj.get("semantic"))
        probe = str(obj.get("probe") or "").strip()
        why = str(obj.get("why") or "").strip()

        # 长度约束在代码里兜底，不指望模型一定听话
        if len(probe) > MAX_PROBE_CHARS:
            probe = probe[:MAX_PROBE_CHARS]
        if len(probe) < MIN_PROBE_CHARS:
            probe = ""
        if len(why) > 40:
            why = why[:40]
        # 语义分不够就不允许带追问，避免"低分却给了追问"的自相矛盾
        if semantic < 0.4:
            probe = ""

        return {"semantic": semantic, "probe": probe, "why": why}

    # ---------------------------------------------------------- 报告摘要
    def summarize(self, points: list[dict], meta: dict) -> Optional[str]:
        """把追问要点写成一段自然语言。失败返回 None，由模板兜底。"""
        if not points:
            return None
        brief = "\n".join(
            f"- {p.get('clock', '')} {p.get('label', '')}：{p.get('text', '')}"
            f"（{p.get('why', '')}）" for p in points)
        content = self._chat([
            {"role": "system", "content":
             "你是面试复盘助手。用 60 字以内、中文、平实客观地总结这场面试的追问点。"
             "不要评价候选人，不要给分数，不要用'优秀/较差'这类词。"},
            {"role": "user", "content":
             f"职位：{meta.get('job_title', '')}\n轮次：{meta.get('turns', 0)}\n"
             f"追问点：\n{brief}"},
        ], max_tokens=160, temperature=0.3, json_mode=False)
        text = (content or "").strip().strip('"')
        return text[:120] if text else None


_LLM: Optional[LLMClient] = None
_INITED = False


def get_llm() -> Optional[LLMClient]:
    """全局单例。没配 key 或 LLM_ENABLED=0 时返回 None，上层据此走模板。"""
    global _LLM, _INITED
    if _INITED:
        return _LLM
    _INITED = True
    if not config.LLM_ENABLED or not os.getenv("LLM_API_KEY"):
        _LLM = None
    else:
        _LLM = LLMClient()
    return _LLM


def reset() -> None:
    """测试用：清掉单例。"""
    global _LLM, _INITED
    _LLM, _INITED = None, False
