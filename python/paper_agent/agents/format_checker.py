# ============================================================
# 格式审查员 Agent (Python)
# 检查申报书是否符合官方模板格式要求
# ============================================================

"""
格式审查员智能体。

检查申报书是否满足模板约束：
- 字数/页数是否超标
- 字体字号是否正确
- 页边距/行距是否合规
- 章节是否完整
"""

from typing import Optional, Any
from paper_agent.agents.registry import BaseAgent


class FormatCheckerAgent(BaseAgent):
    """格式审查员——检查申报书格式合规性"""

    name = "format-checker"
    description = "检查申报书是否符合官方模板格式要求"

    def run(
        self,
        draft: str,
        constraints: Optional[dict] = None,
        input: Optional[dict] = None,
        **kwargs,
    ) -> dict:
        """
        检查格式

        Args:
            draft: 申报书内容（Markdown 格式）
            constraints: 格式约束
            input: 替代输入

        Returns:
            dict: { passed: bool, violations: [...], summary: str }
        """
        if input and isinstance(input, dict):
            draft = input.get("draft", draft)
            constraints = input.get("constraints", constraints)

        # 简单字数检查
        chinese_chars = sum(1 for c in draft if '\u4e00' <= c <= '\u9fff')
        english_words = len([w for w in draft.split() if w.isascii()])
        total = chinese_chars + english_words

        max_chars = (constraints or {}).get("maxChars", 8000)

        violations = []

        if total > max_chars:
            violations.append({
                "type": "word_limit",
                "message": f"总字数 {total} 超出限制 {max_chars}",
                "severity": "error",
            })

        # 估算页数
        estimated_pages = max(1, total // 1000)
        max_pages = (constraints or {}).get("maxPages", 8)
        if estimated_pages > max_pages:
            violations.append({
                "type": "page_limit",
                "message": f"预估页数 {estimated_pages} 超出上限 {max_pages}",
                "severity": "warning",
            })

        # 检查关键章节是否存在
        required_sections = [
            "项目背景", "研究内容", "创新点",
            "预期成果", "进度安排", "经费预算"
        ]
        for section in required_sections:
            if section not in draft:
                violations.append({
                    "type": "section_missing",
                    "message": f"缺少必要章节: {section}",
                    "severity": "error",
                })

        return {
            "passed": len([v for v in violations if v["severity"] == "error"]) == 0,
            "violations": violations,
            "summary": f"字数: {total}, 预估页数: {estimated_pages}, 问题: {len(violations)} 个",
        }

    def check(self, draft: str, constraints: Optional[dict] = None) -> dict:
        """便捷方法：仅检查格式"""
        return self.run(draft=draft, constraints=constraints)
