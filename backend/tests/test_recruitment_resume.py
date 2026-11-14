"""PDF/DOCX parsing and bounded upload validation."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("TTC_SKIP_DOTENV", "1")

from candidate.recruitment_resume import (  # noqa: E402
    MAX_FILE_BYTES, ResumeError, parse_resume_bytes, structure_resume, validate_file,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class ResumeParsingTests(unittest.TestCase):
    def test_pdf_and_docx_fixtures_extract_real_text(self) -> None:
        for name, expected, kind in (
            ("candidate.pdf", "React cache invalidation", "pdf"),
            ("candidate.docx", "onboarding experiments", "docx"),
        ):
            with self.subTest(name=name):
                data = (FIXTURES / name).read_bytes()
                detected, mime = validate_file(name, data)
                self.assertEqual(detected, kind)
                self.assertTrue(mime)
                parsed = parse_resume_bytes(detected, data)
                self.assertIn(expected, parsed["rawText"])

    def test_chinese_and_english_fields_are_structured(self) -> None:
        parsed = structure_resume("""张三
zhangsan@example.com 13800138000
教育经历：北京某大学 计算机
工作经历：前端工程师，负责业务平台开发
项目经历：使用 React 和 TypeScript 改进性能
技能：React、TypeScript
作品：https://example.com/work
""")
        self.assertEqual(parsed["name"], "张三")
        self.assertEqual(parsed["contact"]["email"], "zhangsan@example.com")
        self.assertEqual(parsed["contact"]["phone"], "13800138000")
        self.assertTrue(parsed["education"])
        self.assertTrue(parsed["workExperience"])
        self.assertTrue(parsed["projects"])
        self.assertIn("React", parsed["skills"][0])
        self.assertEqual(parsed["portfolioLinks"], ["https://example.com/work"])

    def test_rejects_empty_oversize_masquerade_and_unsupported_files(self) -> None:
        invalid = (
            ("empty.pdf", b""),
            ("resume.pdf", b"MZ executable"),
            ("resume.docx", b"PK\x03\x04not a zip"),
            ("resume.exe", b"%PDF-1.4"),
            ("huge.pdf", b"%PDF-" + b"x" * MAX_FILE_BYTES),
        )
        for name, data in invalid:
            with self.subTest(name=name), self.assertRaises(ResumeError):
                validate_file(name, data)

    def test_competitions_are_structured_separately_from_awards(self) -> None:
        parsed = structure_resume("""张三
zhangsan@example.com
竞赛经历：ACM-ICPC 区域赛银奖
荣誉：校级优秀毕业生
项目经历：使用 React 和 TypeScript 改进性能
""")
        self.assertTrue(parsed["competitions"])
        self.assertIn("ACM", parsed["competitions"][0]["text"])
        self.assertTrue(parsed["achievements"])
        self.assertIn("优秀毕业生", parsed["achievements"][0])
        self.assertTrue(parsed["projects"])
    def test_scanned_or_nearly_empty_text_is_not_accepted(self) -> None:
        with self.assertRaises(ResumeError):
            structure_resume("a b c")


if __name__ == "__main__":
    unittest.main()
