"""LLM 分析层单测 —— 不联网，用假传输层。

重点盯三件会让产品翻车的事：
1. 模型回了带围栏 / 带废话的 JSON，能不能抠出来
2. 模型不听话（分数越界、追问太长、低分还给追问）时代码能不能兜住
3. 失败必须返回 None（而不是 0），否则"没分析出来"会被当成"没问题"
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("LLM_API_KEY", "test-key")

from shared import config  # noqa: E402
from shared import llm  # noqa: E402


def make(reply, calls: list | None = None) -> llm.LLMClient:
    c = llm.LLMClient(api_key="k", base_url="https://x",
                      model="m", timeout=1)
    def fake(messages, **kw):
        if calls is not None:
            calls.append({"messages": messages, "kw": kw})
        return reply
    c._chat = fake
    return c


class TestExtractJson(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(llm._extract_json('{"a":1}'), {"a": 1})

    def test_fenced(self):
        txt = '```json\n{"semantic":0.7,"probe":"追问","why":"x"}\n```'
        self.assertAlmostEqual(llm._extract_json(txt)["semantic"], 0.7)

    def test_with_surrounding_text(self):
        txt = '好的，分析如下：{"semantic":0.5} 以上。'
        self.assertAlmostEqual(llm._extract_json(txt)["semantic"], 0.5)

    def test_garbage(self):
        self.assertIsNone(llm._extract_json("我不想输出 JSON"))
        self.assertIsNone(llm._extract_json(""))
        self.assertIsNone(llm._extract_json("{不是合法json}"))

    def test_array_is_rejected(self):
        self.assertIsNone(llm._extract_json("[1,2,3]"))


class TestAnalyzeTurn(unittest.TestCase):
    def test_normal(self):
        c = make('{"semantic":0.82,"probe":"追问：为什么没上线","why":"用了战略调整带过"}')
        res = c.analyze_turn("讲一个失败的项目", "后来因为公司战略调整就没上线，具体不太清楚。")
        self.assertAlmostEqual(res["semantic"], 0.82)
        self.assertEqual(res["probe"], "追问：为什么没上线")
        self.assertIn("战略调整", res["why"])

    def test_semantic_clamped(self):
        c = make('{"semantic":2.5,"probe":"追问：什么情况","why":""}')
        self.assertEqual(c.analyze_turn("q", "很长的一段回答文本内容").get("semantic"), 1.0)
        c2 = make('{"semantic":-3,"probe":"x","why":""}')
        self.assertEqual(c2.analyze_turn("q", "很长的一段回答文本内容").get("semantic"), 0.0)

    def test_probe_truncated(self):
        c = make('{"semantic":0.9,"probe":"追问：你能具体说说当时到底是哪一个环节卡住了吗","why":""}')
        res = c.analyze_turn("q", "很长的一段回答文本内容")
        self.assertLessEqual(len(res["probe"]), llm.MAX_PROBE_CHARS)

    def test_low_semantic_clears_probe(self):
        """低分却给了追问，是自相矛盾 —— 代码里直接清掉，不信模型。"""
        c = make('{"semantic":0.1,"probe":"追问：为什么","why":""}')
        self.assertEqual(c.analyze_turn("q", "很长的一段回答文本内容")["probe"], "")

    def test_too_short_answer_skips_call(self):
        calls: list = []
        c = make('{"semantic":0.9}', calls)
        self.assertIsNone(c.analyze_turn("q", "嗯"))
        self.assertEqual(calls, [], "太短的文本不该浪费一次调用")

    def test_garbage_reply_returns_none(self):
        c = make("我觉得这个候选人不行")
        self.assertIsNone(c.analyze_turn("q", "很长的一段回答文本内容"))

    def test_none_reply_returns_none(self):
        c = make(None)
        self.assertIsNone(c.analyze_turn("q", "很长的一段回答文本内容"))

    def test_prompt_has_compliance_guard(self):
        """prompt 里必须写明不许评价人格 —— 这是合规红线，不能被后人改掉。"""
        self.assertIn("不评价候选人的人格", llm.SYSTEM_PROMPT)
        self.assertIn("不推测动机", llm.SYSTEM_PROMPT)


class TestSummarize(unittest.TestCase):
    def test_plain_text_used(self):
        c = make("本场有两个点值得二面追问，都集中在项目归属和上线原因上。")
        s = c.summarize([{"clock": "02:30", "label": "x", "text": "y", "why": "z"}],
                        {"job_title": "前端", "turns": 3})
        self.assertIn("二面追问", s)

    def test_uses_text_mode_not_json_mode(self):
        """摘要要求自然语言，绝不能带 response_format: json_object。"""
        calls: list = []
        c = make("好的总结", calls)
        c.summarize([{"clock": "00:01", "label": "a", "text": "b", "why": "c"}], {})
        self.assertFalse(calls[0]["kw"].get("json_mode", True),
                         "写自然语言摘要时 json_mode 必须为 False")

    def test_empty_points_returns_none(self):
        c = make("不该被调用")
        self.assertIsNone(c.summarize([], {}))

    def test_failure_returns_none(self):
        c = make(None)
        self.assertIsNone(c.summarize([{"clock": "00:01", "label": "a",
                                        "text": "b", "why": "c"}], {}))


class TestGetLlm(unittest.TestCase):
    def setUp(self):
        self._orig = config.LLM_ENABLED
        llm.reset()

    def tearDown(self):
        config.LLM_ENABLED = self._orig
        llm.reset()

    def test_disabled_returns_none(self):
        config.LLM_ENABLED = False
        self.assertIsNone(llm.get_llm())

    def test_missing_key_returns_none(self):
        config.LLM_ENABLED = True
        old = os.environ.pop("LLM_API_KEY", None)
        try:
            self.assertIsNone(llm.get_llm())
        finally:
            if old is not None:
                os.environ["LLM_API_KEY"] = old

    def test_enabled_with_key_returns_client(self):
        config.LLM_ENABLED = True
        os.environ.setdefault("LLM_API_KEY", "test-key")
        self.assertIsNotNone(llm.get_llm())


if __name__ == "__main__":
    unittest.main(verbosity=2)
