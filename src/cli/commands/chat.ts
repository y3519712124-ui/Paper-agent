// ============================================================
// paper chat — 与指定智能体实时对话
// ============================================================

import { createInterface } from "node:readline";
import { AGENTS_DIR } from "../../config/defaults.js";
import { AgentRegistry } from "../../core/agent/registry.js";
import { AgentRuntime } from "../../core/agent/runtime.js";
import { LLMService } from "../../core/llm/adapter.js";

interface ChatOptions {
  project?: string;
}

export async function chatWithAgent(
  agentName: string,
  _options: ChatOptions,
): Promise<void> {
  // ── 查找 Agent ──
  const llmService = new LLMService();
  const registry = new AgentRegistry(AGENTS_DIR);
  const runtime = new AgentRuntime({ llmService });

  const agentDef = registry.getDef(agentName);
  if (!agentDef) {
    console.error(`❌ 智能体 "${agentName}" 未找到`);
    console.error(`   可用: paper agent list`);
    process.exit(1);
  }

  // ── 启动对话 ──
  console.log(`\n💬 与 "${agentDef.label}" 对话模式`);
  console.log(`   角色: ${agentDef.role}`);
  console.log(`   输入 /exit 退出，/save 保存对话`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let sessionId = `${agentName}-${Date.now()}`;
  let isRunning = true;

  const ask = () => {
    if (!isRunning) return;
    rl.question(`你 > `, async (input) => {
      if (input.toLowerCase() === "/exit") {
        isRunning = false;
        rl.close();
        console.log(`\n👋 对话结束`);
        return;
      }

      if (input.toLowerCase() === "/save") {
        const session = runtime.getSession(sessionId);
        if (session) {
          console.log(`✅ 对话已保存 (${session.messages.length} 条消息)`);
        }
        ask();
        return;
      }

      try {
        console.log(`\n${agentDef.label} > `);
        const { reply } = await runtime.chat(agentDef, input, sessionId);
        console.log(reply);
        console.log(``);
      } catch (error) {
        console.error(`❌ 错误: ${error}`);
      }

      ask();
    });
  };

  // 打印初始问候
  console.log(`${agentDef.label} > 你好！我是${agentDef.label}，有什么可以帮你的？`);
  console.log(``);
  ask();

  // 等待关闭
  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
}
