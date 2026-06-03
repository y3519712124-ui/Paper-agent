# ============================================================
# Python 侧 JSON-RPC 服务器
# 通过 stdin/stdout 与 TS 通信
# ============================================================

"""
JSON-RPC 服务器。

协议：
- 接收: stdin 每行一个 JSON 对象
- 发送: stdout 每行一个 JSON 对象
- 每条消息都有 messageId 用于匹配请求/响应

消息类型：
- call: TS → Python，调用指定 Agent 的方法
- response: Python → TS，返回结果
- error: Python → TS，返回错误
- ping/pong: 心跳
- shutdown: 优雅关闭
"""

import sys
import json
import threading
import traceback
from datetime import datetime
from typing import Any

from paper_agent.agents.registry import AgentRegistry
from paper_agent.agents.reviewer import ReviewerAgent
from paper_agent.agents.format_checker import FormatCheckerAgent
from paper_agent.export.docx import DocxExporterAgent


def start_server():
    """启动 JSON-RPC 服务器，从 stdin 读取指令"""

    registry = AgentRegistry()
    registry.register("reviewer", ReviewerAgent())
    registry.register("format-checker", FormatCheckerAgent())
    registry.register("docx-exporter", DocxExporterAgent())

    # 发送就绪信号
    ready_msg = {
        "type": "response",
        "messageId": "ready",
        "result": {"status": "ready", "agents": registry.list_agents()},
        "timestamp": datetime.now().isoformat(),
    }
    sys.stdout.write(json.dumps(ready_msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    running = True

    while running:
        try:
            line = sys.stdin.readline()
            if not line:
                break  # stdin 关闭

            line = line.strip()
            if not line:
                continue

            message = json.loads(line)

            if message["type"] == "call":
                threading.Thread(
                    target=handle_call,
                    args=(message, registry),
                    daemon=True,
                ).start()

            elif message["type"] == "ping":
                pong = {
                    "type": "response",
                    "messageId": message["messageId"],
                    "result": {"pong": True},
                    "timestamp": datetime.now().isoformat(),
                }
                sys.stdout.write(json.dumps(pong, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif message["type"] == "shutdown":
                running = False
                shutdown_msg = {
                    "type": "response",
                    "messageId": message["messageId"],
                    "result": {"shutdown": True},
                    "timestamp": datetime.now().isoformat(),
                }
                sys.stdout.write(json.dumps(shutdown_msg, ensure_ascii=False) + "\n")
                sys.stdout.flush()

        except json.JSONDecodeError as e:
            error_msg = {
                "type": "error",
                "messageId": "parse",
                "error": f"JSON 解析错误: {e}",
                "code": -32700,
                "timestamp": datetime.now().isoformat(),
            }
            sys.stdout.write(json.dumps(error_msg, ensure_ascii=False) + "\n")
            sys.stdout.flush()

        except Exception as e:
            error_msg = {
                "type": "error",
                "messageId": "server",
                "error": f"服务器错误: {e}",
                "code": -1,
                "timestamp": datetime.now().isoformat(),
            }
            sys.stdout.write(json.dumps(error_msg, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def handle_call(message: dict, registry: AgentRegistry):
    """处理调用请求（在独立线程中执行）"""
    message_id = message.get("messageId", "unknown")
    agent_name = message.get("agent", "")
    method = message.get("method", "")
    params = message.get("params", {})

    try:
        agent = registry.get(agent_name)
        if not agent:
            raise ValueError(f"Agent '{agent_name}' 未注册")

        method_fn = getattr(agent, method, None)
        if not method_fn:
            raise ValueError(f"Agent '{agent_name}' 没有方法 '{method}'")

        result = method_fn(**params)

        response = {
            "type": "response",
            "messageId": message_id,
            "result": result,
            "streamDone": True,
            "timestamp": datetime.now().isoformat(),
        }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    except Exception as e:
        error_response = {
            "type": "error",
            "messageId": message_id,
            "error": str(e),
            "code": getattr(e, "code", -1),
            "timestamp": datetime.now().isoformat(),
        }
        sys.stdout.write(json.dumps(error_response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
