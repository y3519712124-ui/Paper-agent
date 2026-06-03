// ============================================================
// paper agent — Agent 管理
// ============================================================

import { AGENTS_DIR } from "../../config/defaults.js";
import { AgentRegistry } from "../../core/agent/registry.js";
import { scanAgents, loadAgent } from "../../core/agent/loader.js";

interface AgentOptions {
  role?: string;
  language?: string;
}

export async function manageAgent(
  action: string,
  name: string | undefined,
  _options: AgentOptions,
): Promise<void> {
  const registry = new AgentRegistry(AGENTS_DIR);

  switch (action) {
    case "list": {
      const agents = registry.listAll();
      if (agents.length === 0) {
        console.log("没有可用的智能体");
        return;
      }

      console.log(`\n📋 可用智能体 (${agents.length} 个)\n`);
      console.log(`  ${"名称".padEnd(18)} ${"角色".padEnd(18)} ${"语言".padEnd(10)} ${"来源"}`);
      console.log(`  ${"─".repeat(18)} ${"─".repeat(18)} ${"─".repeat(10)} ${"─".repeat(6)}`);

      for (const a of agents) {
        const lang = a.language === "python" ? "🐍 Python" : "🔵 TS";
        const source = a.isBuiltin ? "内置" : "自定义";
        console.log(`  ${a.name.padEnd(18)} ${a.label.padEnd(18)} ${lang.padEnd(10)} ${source}`);
      }
      break;
    }

    case "create": {
      if (!name) {
        console.error("❌ 请指定智能体名称: paper agent create <name>");
        process.exit(1);
      }
      console.log(`📝 创建智能体 "${name}" 功能即将上线`);
      console.log(`   你可以手动创建 YAML 文件: ${AGENTS_DIR}/${name}.yaml`);
      break;
    }

    case "edit": {
      if (!name) {
        console.error("❌ 请指定智能体名称: paper agent edit <name>");
        process.exit(1);
      }
      const def = registry.getDef(name);
      if (!def) {
        console.error(`❌ 智能体 "${name}" 未找到`);
        process.exit(1);
      }
      console.log(`📝 编辑 "${def.label}":`);
      console.log(`   语言: ${def.language}`);
      console.log(`   模型: ${def.model}`);
      console.log(`   Prompt: ${def.systemPrompt.slice(0, 80)}...`);
      console.log(`   编辑功能即将上线，当前可手动修改 YAML 文件`);
      break;
    }

    default:
      console.error(`未知操作: ${action}（可用: list / create / edit）`);
  }
}
