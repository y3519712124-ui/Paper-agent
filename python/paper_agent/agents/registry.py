# ============================================================
# Agent 注册表（Python 侧）
# ============================================================

from typing import Dict, Optional, Any


class BaseAgent:
    """Python Agent 基类"""

    name: str = "base"
    description: str = ""

    def run(self, **params) -> dict:
        """执行 Agent 主逻辑"""
        raise NotImplementedError

    def ping(self) -> dict:
        return {"pong": True}


class AgentRegistry:
    """Python Agent 注册表"""

    def __init__(self):
        self._agents: Dict[str, BaseAgent] = {}

    def register(self, name: str, agent: BaseAgent):
        self._agents[name] = agent

    def get(self, name: str) -> Optional[BaseAgent]:
        return self._agents.get(name)

    def list_agents(self) -> list:
        return [{"name": name, "description": agent.description}
                for name, agent in self._agents.items()]
