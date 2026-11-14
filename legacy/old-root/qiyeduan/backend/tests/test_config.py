"""配置与 .env 解析的测试。

重点盯两件事：
1. 带引号的值必须保留引号内的尾部空格（VISION_AUTH_PREFIX="Bearer "）
   —— 空格被吃掉的话鉴权头会变成 "Bearerxxx"，报错信息还很难看懂。
2. 真实环境变量必须优先于 .env（demo 现场靠 set 临时切换数据源）。

全部用纯函数验证，不写任何文件（沙箱下也不该有副作用）。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import config   # noqa: E402


class TestParseDotenv(unittest.TestCase):
    def test_basic_keys(self):
        d = config._parse_dotenv("A=1\nB=hello\n")
        self.assertEqual(d, {"A": "1", "B": "hello"})

    def test_quoted_value_keeps_trailing_space(self):
        d = config._parse_dotenv('PREFIX="Bearer "\n')
        self.assertEqual(d["PREFIX"], "Bearer ",
                         "引号内的尾随空格被吃掉了，鉴权头会拼成 Bearerxxx")

    def test_single_quotes(self):
        self.assertEqual(config._parse_dotenv("K='x y'\n")["K"], "x y")

    def test_space_around_equals(self):
        self.assertEqual(config._parse_dotenv("K = value \n")["K"], "value")

    def test_empty_value_allowed(self):
        # VISION_AUTH_PREFIX= 表示不要前缀，必须能表达"空字符串"
        self.assertEqual(config._parse_dotenv("K=\n")["K"], "")

    def test_comments_and_blank_lines_ignored(self):
        d = config._parse_dotenv("# 注释\n\nK=1\n   # 缩进注释\n")
        self.assertEqual(d, {"K": "1"})

    def test_line_without_equals_ignored(self):
        self.assertEqual(config._parse_dotenv("garbage line\nK=1\n"), {"K": "1"})

    def test_value_containing_equals(self):
        self.assertEqual(config._parse_dotenv("K=a=b\n")["K"], "a=b")

    def test_empty_key_ignored(self):
        self.assertEqual(config._parse_dotenv("=v\nK=1\n"), {"K": "1"})

    def test_crlf_input(self):
        self.assertEqual(config._parse_dotenv("A=1\r\nB=2\r\n"),
                         {"A": "1", "B": "2"})


class TestLoadDotenv(unittest.TestCase):
    def test_missing_file_is_noop(self):
        config._load_dotenv(Path(__file__).with_name("__no_such__.env"))

    def test_real_env_wins(self):
        """shell 里 set 过的变量不能被 .env 覆盖，否则现场无法临时切换数据源。

        用纯函数验证，不落任何文件 —— 只读环境（如沙箱/CI）里也能跑。
        """
        key = "TTC_TEST_ENV_PRIORITY"
        old = os.environ.get(key)
        os.environ[key] = "from_shell"
        try:
            config._apply_dotenv(f"{key}=from_file\n")
            self.assertEqual(os.environ[key], "from_shell")
        finally:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

    def test_apply_sets_missing_keys(self):
        key = "TTC_TEST_APPLY"
        old = os.environ.pop(key, None)
        try:
            config._apply_dotenv(f"{key}=hello\nOTHER=1\n")
            self.assertEqual(os.environ[key], "hello")
            os.environ.pop("OTHER", None)
        finally:
            if old is not None:
                os.environ[key] = old


class TestDefaults(unittest.TestCase):
    def test_provider_is_known(self):
        self.assertIn(config.VISION_PROVIDER, ("mock", "real", "facephys"))

    def test_thresholds_sane(self):
        self.assertGreater(config.BASELINE_SECONDS, 0)
        self.assertLess(config.BASELINE_MIN_SAMPLES, 100)
        self.assertLess(config.PROBE_THRESHOLD, 5)
        self.assertGreater(config.HINT_COOLDOWN, 0)

    def test_mock_windows_parseable(self):
        from vision import MockProvider
        p = MockProvider("10-20,30-40")
        self.assertTrue(p._in_stress(15))
        self.assertFalse(p._in_stress(25))


if __name__ == "__main__":
    unittest.main(verbosity=2)
