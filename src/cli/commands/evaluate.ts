// ============================================================
// paper evaluate — 模拟评审
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR, AGENTS_DIR } from "../../config/defaults.js";
import { AgentRegistry } from "../../core/agent/registry.js";
import { AgentRuntime } from "../../core/agent/runtime.js";
import { LLMService } from "../../core/llm/adapter.js";
import { findAgentByName } from "../../core/agent/loader.js";

interface EvaluateOptions {
  project?: string;
  draft?: string;
  standard?: string;
}

export async function evaluateDraft(options: EvaluateOptions): Promise<void> {
  const projectName = options.project ?? "my-project";
  const projectDir = join(PROJECTS_DIR, projectName);

  // ── 读取草稿 ──
  let draftContent: string;

  if (options.draft) {
    if (!existsSync(options.draft)) {
      console.error(`❌ 文件不存在: ${options.draft}`);
      process.exit(1);
    }
    draftContent = readFileSync(options.draft, "utf-8");
  } else {
    // 从项目目录找最新草稿
    const draftsDir = join(projectDir, ".paper", "drafts");
    if (!existsSync(draftsDir)) {
      console.error(`❌ 项目 "${projectName}" 没有草稿，请先运行 paper generate`);
      process.exit(1);
    }
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(draftsDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      console.error(`❌ 未找到草稿文件`);
      process.exit(1);
    }
    const latest = files.sort().reverse()[0];
    draftContent = readFileSync(join(draftsDir, latest!), "utf-8");
    console.log(`📄 使用草稿: ${latest}`);
  }

  // ── 初始化评审 Agent ──
  const llmService = new LLMService();
  const registry = new AgentRegistry(AGENTS_DIR);
  const runtime = new AgentRuntime({ llmService });

  const reviewer = registry.getDef("reviewer");
  if (!reviewer) {
    console.error(`❌ 评审专家智能体未找到`);
    process.exit(1);
  }

  console.log(`\n🔍 正在模拟评审...\n`);

  try {
    const { result } = await runtime.call(reviewer, {
      draft: draftContent,
      standard: options.standard ?? "通用竞赛评审标准",
    });

    const scoreResult = result as Record<string, unknown>;

    // ── 显示评分结果 ──
    console.log(`📊 评审结果`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━`);

    if (scoreResult.score && typeof scoreResult.score === "object") {
      const scores = scoreResult.score as Record<string, number>;
      let total = 0;
      let count = 0;
      for (const [dimension, score] of Object.entries(scores)) {
        console.log(`  ${dimension}: ${score}/100`);
        total += score;
        count++;
      }
      const avg = count > 0 ? Math.round(total / count) : 0;
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  总分: ${avg}/100`);
    }

    if (scoreResult.comments) {
      console.log(`\n💬 评语:`);
      console.log(`  ${scoreResult.comments as string}`);
    }

    if (scoreResult.suggestions) {
      console.log(`\n💡 改进建议:`);
      const suggestions = scoreResult.suggestions as string[];
      for (let i = 0; i < suggestions.length; i++) {
        console.log(`  ${i + 1}. ${suggestions[i]}`);
      }
    }

    console.log(`\n下一步: paper polish -p ${projectName}  # 根据建议优化`);
  } catch (error) {
    console.error(`❌ 评审失败: ${error}`);
  }
}
