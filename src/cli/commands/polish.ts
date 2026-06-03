// ============================================================
// paper polish — 迭代优化
// ============================================================

import { join } from "node:path";
import { PROJECTS_DIR, AGENTS_DIR } from "../../config/defaults.js";
import { AgentRegistry } from "../../core/agent/registry.js";
import { AgentRuntime } from "../../core/agent/runtime.js";
import { LLMService } from "../../core/llm/adapter.js";

interface PolishOptions {
  project?: string;
}

export async function polishDraft(
  rounds: number,
  options: PolishOptions,
): Promise<void> {
  const projectName = options.project ?? "my-project";

  const llmService = new LLMService();
  const registry = new AgentRegistry(AGENTS_DIR);
  const runtime = new AgentRuntime({ llmService });

  const polisher = registry.getDef("polisher");
  if (!polisher) {
    console.error(`❌ 润色智能体未找到`);
    process.exit(1);
  }

  console.log(`\n✨ 开始优化，共 ${rounds} 轮...\n`);

  for (let round = 1; round <= rounds; round++) {
    console.log(`[第 ${round}/${rounds} 轮]`);

    // 实际逻辑：读取当前草稿 → 调用润色 Agent → 保存
    // 这里简化为调用演示
    try {
      const { result } = await runtime.call(polisher, {
        draft: `（第 ${round} 轮优化目标）`,
        round,
      });
      console.log(`  ✅ 第 ${round} 轮完成`);
    } catch (error) {
      console.error(`  ❌ 第 ${round} 轮失败: ${error}`);
    }
  }

  console.log(`\n✅ 优化完成！`);
  console.log(`下一步: paper export docx -p ${projectName}`);
}
