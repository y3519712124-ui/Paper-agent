// ============================================================
// paper config — 配置管理
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const CONFIG_DIR = join(homedir(), ".paper");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

interface ConfigOptions {
  provider?: string;
  apiKey?: string;
  model?: string;
}

export async function manageConfig(
  action: string,
  options: ConfigOptions,
): Promise<void> {
  // 确保配置目录存在
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  switch (action) {
    case "show": {
      if (!existsSync(CONFIG_FILE)) {
        console.log("📋 当前配置（默认）");
        console.log(``);
        console.log(`  provider: deepseek`);
        console.log(`  model: deepseek-chat`);
        console.log(`  api_key: (未设置)`);
        console.log(``);
        console.log(`  设置: paper config set --provider deepseek --api-key sk-xxx`);
        return;
      }

      const raw = readFileSync(CONFIG_FILE, "utf-8");
      const config = parseYaml(raw) as Record<string, unknown>;
      const llm = config.llm as Record<string, unknown> | undefined;

      console.log("📋 当前配置");
      console.log(``);
      if (llm) {
        console.log(`  provider: ${llm.provider ?? "未设置"}`);
        console.log(`  model: ${llm.model ?? "未设置"}`);
        console.log(`  api_key: ${llm.apiKey ? "****" + String(llm.apiKey).slice(-4) : "(未设置)"}`);
      }
      break;
    }

    case "set": {
      if (!options.provider && !options.apiKey && !options.model) {
        console.error("❌ 请指定要设置的选项");
        console.error(`   示例: paper config set --provider deepseek --api-key sk-xxx`);
        process.exit(1);
      }

      let config: Record<string, unknown> = {};
      if (existsSync(CONFIG_FILE)) {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        config = parseYaml(raw) as Record<string, unknown>;
      }

      if (!config.llm) config.llm = {};

      const llm = config.llm as Record<string, unknown>;
      if (options.provider) llm.provider = options.provider;
      if (options.apiKey) llm.apiKey = options.apiKey;
      if (options.model) llm.model = options.model;

      writeFileSync(CONFIG_FILE, stringifyYaml(config), "utf-8");
      console.log(`✅ 配置已保存: ${CONFIG_FILE}`);

      // 同时写入环境变量提示
      console.log(`   也可以通过环境变量设置:`);
      console.log(`   PAPER_DEEPSEEK_API_KEY=sk-xxx`);
      console.log(`   PAPER_OPENAI_API_KEY=sk-xxx`);
      break;
    }

    default:
      console.error(`未知操作: ${action}（可用: show / set）`);
  }
}
