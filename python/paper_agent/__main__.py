# ============================================================
# Paper-agent Python 入口
# 作为子进程被 TS 端调用，通过 stdin/stdout JSON 通信
# ============================================================

"""
Paper-agent Python 模块。

通过 stdin 接收 JSON-RPC 消息，处理后通过 stdout 返回结果。
启动方式: python -m paper_agent
"""

import sys
import json
import traceback
from paper_agent.bridge.server import start_server


def main():
    """入口：启动 JSON-RPC 服务器"""
    try:
        start_server()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        error_msg = {
            "type": "error",
            "messageId": "startup",
            "error": f"启动失败: {e}",
            "code": -1,
            "timestamp": __import__('datetime').datetime.now().isoformat(),
        }
        sys.stderr.write(json.dumps(error_msg, ensure_ascii=False) + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
