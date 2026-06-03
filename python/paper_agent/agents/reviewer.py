# ============================================================
# 评审专家 Agent (Python)
# 模拟竞赛评委打分并给出修改建议
# ============================================================

"""
评审专家智能体。

根据竞赛评分标准对申报书进行评审，输出：
- score: 分项评分
- comments: 综合评语
- suggestions: 改进建议
"""

from typing import Optional
from paper_agent.agents.registry import BaseAgent


class ReviewerAgent(BaseAgent):
    """评审专家——模拟竞赛评委"""

    name = "reviewer"
    description = "模拟竞赛评委对申报书进行评审打分"

    def run(
        self,
        draft: str,
        standard: Optional[str] = None,
        competition: Optional[str] = None,
        systemPrompt: Optional[str] = None,
        input: Optional[dict] = None,
        **kwargs,
    ) -> dict:
        """
        评审申报书

        Args:
            draft: 申报书全文
            standard: 评分标准描述
            competition: 赛事类型
            systemPrompt: 系统提示词
            input: 替代 draft 的输入

        Returns:
            dict: { score: {...}, comments: str, suggestions: [...] }
        """
        # 如果通过 input 传入，取其 draft 字段
        if input and isinstance(input, dict):
            draft = input.get("draft", draft)
            standard = input.get("standard", standard)

        # 判断项目类型
        project_type = self._detect_type(draft)

        # 这里后续接入 LLM 调用
        # 当前返回基于项目类型的模拟评审结果

        if project_type == "entrepreneurship":
            return self._mock_review_entrepreneurship()
        else:
            return self._mock_review_innovation()

    def _detect_type(self, draft: str) -> str:
        """检测项目类型：创业训练 vs 创新训练"""
        biz_keywords = ["商业模式", "收入", "利润", "营销", "融资", "市场分析", "定价", "SWOT", "Freemium"]
        research_keywords = ["研究内容", "技术路线", "实验", "算法", "方法论", "文献综述"]

        biz_score = sum(1 for k in biz_keywords if k in draft)
        research_score = sum(1 for k in research_keywords if k in draft)

        return "entrepreneurship" if biz_score > research_score else "innovation"

    def _mock_review_innovation(self) -> dict:
        """创新训练模拟评审"""
        return {
            "score": {
                "创新性": 72,
                "可行性": 78,
                "团队能力": 75,
                "研究内容": 68,
                "预期成果": 70,
            },
            "total": 73,
            "type": "创新训练",
            "comments": "项目选题有较好的创新性，研究内容有一定深度。主要不足：创新点与现有方法的对比不够明确，技术路线的可操作性描述不足。",
            "suggestions": [
                "建议在第3节增加对比表格，列出本方案与现有方法的详细对比指标",
                "技术路线部分需要补充具体的模型选型、参数设置和评估指标",
                "预期成果需要量化，如'发表1篇核心期刊论文+申请1项发明专利'",
                "建议增加参考文献数量（目前偏少），并引用近3年的高水平论文",
            ],
        }

    def _mock_review_entrepreneurship(self) -> dict:
        """创业训练模拟评审"""
        return {
            "score": {
                "创新性": 75,
                "市场分析": 70,
                "商业模式": 68,
                "可行性": 78,
                "财务预测": 65,
            },
            "total": 71,
            "type": "创业训练",
            "comments": "项目产品定位清晰，市场切入点选择合理。主要短板：商业模式的盈利逻辑尚需完善，财务预测缺少客单价×用户量的分解论证。",
            "suggestions": [
                "商业模式部分需要补充单位经济模型（客单价、获客成本、用户生命周期价值）",
                "财务预测增加敏感性分析（乐观/中性/悲观三种情景）",
                "市场竞争分析建议使用波特五力模型或SWOT分析框架",
                "建议补充B端合作意向或种子用户数据来佐证市场需求真实性",
            ],
        }

    def evaluate(self, draft: str, standard: str = "通用竞赛标准") -> dict:
        """便捷方法：仅评分"""
        return self.run(draft=draft, standard=standard)
