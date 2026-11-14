"""``.env`` 到底从哪读。

这个文件只测一件事，但它是真出过事的：重构成 ``backend/shared/config.py`` 之后，
``Path(__file__).with_name(".env")`` 从 ``backend/.env`` 变成了
``backend/shared/.env``，于是写在 ``backend/.env`` 里的 key 被静默忽略，
表现是「明明填了 SILICONFLOW_API_KEY，初筛还是报未配置」。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from shared import config  # noqa: E402


class TestDotenvLocation(unittest.TestCase):
    def test_first_candidate_is_backend_env(self):
        first = config._DOTENV_CANDIDATES[0]
        self.assertEqual(first, BACKEND / ".env",
                         ".env 必须落在 backend/.env —— setup.sh、"
                         ".env.example、ai-interview 侧车都指向这里")

    def test_legacy_location_is_second(self):
        """旧位置保留为兜底，不能抢在 backend/.env 前面。"""
        self.assertEqual(config._DOTENV_CANDIDATES[1],
                         BACKEND / "shared" / ".env")

    def test_candidates_are_absolute(self):
        for path in config._DOTENV_CANDIDATES:
            self.assertTrue(path.is_absolute(), f"{path} 必须是绝对路径，"
                                                "否则换个 cwd 启动就读错文件")


if __name__ == "__main__":
    unittest.main()
