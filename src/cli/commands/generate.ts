// ============================================================
// paper generate — 启动多智能体协作生成
// ============================================================

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { PROJECTS_DIR, TEMPLATE_DIR, AGENTS_DIR } from "../../config/defaults.js";
import { findTemplateById } from "../../core/template/parser.js";
import { AgentRegistry } from "../../core/agent/registry.js";
import { AgentRuntime } from "../../core/agent/runtime.js";
import { LLMService } from "../../core/llm/adapter.js";
import { WorkflowEngine } from "../../core/workflow/engine.js";
import type { LLMConfig, LLMProvider } from "../../core/llm/types.js";

interface GenerateOptions {
  project?: string;
  workflow?: string;
  chat: boolean;
}

export async function generateContent(options: GenerateOptions): Promise<void> {
  const projectName = options.project ?? "my-project";
  const projectDir = join(PROJECTS_DIR, projectName);

  if (!existsSync(projectDir)) {
    console.error(`❌ 项目 "${projectName}" 不存在，请先运行 paper init`);
    process.exit(1);
  }

  // ── 加载项目配置 ──
  const projectConfigPath = join(projectDir, ".paper", "project.yaml");
  if (!existsSync(projectConfigPath)) {
    console.error(`❌ 项目配置文件缺失: ${projectConfigPath}`);
    process.exit(1);
  }

  const raw = readFileSync(projectConfigPath, "utf-8");
  const projectConfig = parseYaml(raw) as Record<string, unknown>;

  // ── 加载全局 LLM 配置 ──
  const llmConfig = loadLLMConfig();
  const llmService = new LLMService(llmConfig ? [llmConfig] : []);
  const registry = new AgentRegistry(AGENTS_DIR);
  const runtime = new AgentRuntime({ llmService });
  const template = findTemplateById(TEMPLATE_DIR, projectConfig.template as string);

  if (!template) {
    console.error(`❌ 模板 "${projectConfig.template}" 未找到`);
    process.exit(1);
  }

  const engine = new WorkflowEngine({
    registry,
    runtime,
    template,
  });

  // ── 注册进度回调 ──
  engine.onProgress((progress) => {
    const statusIcon =
      progress.status === "running" ? "▶" :
      progress.status === "completed" ? "✅" :
      progress.status === "error" ? "❌" : "⏸";
    console.log(`  ${statusIcon} [${progress.completedNodes}/${progress.totalNodes}] ${progress.message}`);
  });

  // ── 加载工作流（自定义优先） ──
  let workflow: ReturnType<typeof createDefaultWorkflow>;
  if (options.workflow) {
    const custom = loadWorkflowFromFile(options.workflow);
    if (!custom) {
      console.error(`❌ 工作流文件未找到: ${options.workflow}`);
      process.exit(1);
    }
    workflow = {
      id: `custom-${template.id}`,
      name: "自定义工作流",
      description: "通过 worklow 编辑器编排",
      competition: template.competition,
      agents: [...new Set(custom.map((n) => n.agentRef))],
      maxLoops: 3,
      targetScore: 80,
      startNode: custom[0]?.id ?? "",
      nodes: custom,
    };
    console.log(`📋 使用自定义工作流 (${custom.length} 个节点)`);
  } else {
    workflow = createDefaultWorkflow(template.id);
  }

  // ── 准备上下文 ──
  const context: Record<string, unknown> = {
    project_name: projectConfig.name,
    template_id: template.id,
    competition: template.competition,
    variables: projectConfig.variables ?? {},
    team: projectConfig.team ?? [],
  };

  // ── 交互式确认 ──
  if (options.chat) {
    console.log(`\n📋 项目: ${projectConfig.name}`);
    console.log(`📄 模板: ${template.name}`);
    console.log(`🤖 智能体: ${workflow.agents.join(", ")}`);
    console.log(`🔄 步骤数: ${workflow.nodes.length}`);
    console.log(``);

    // 这里可以用 Ink 交互，简化版本用确认
    console.log(`按 Enter 开始生成，Ctrl+C 取消...`);
    await waitForEnter();
  }

  // ── 执行工作流 ──
  console.log(`\n🚀 开始生成 "${projectConfig.name}"...\n`);

  try {
    const execution = await engine.execute(workflow, projectName, context);

    if (execution.status === "completed") {
      console.log(`\n✅ 生成完成！`);
      console.log(`   执行 ID: ${execution.id}`);
      console.log(`   用时: ${Math.round((Date.now() - execution.startedAt.getTime()) / 1000)}秒`);
      console.log(``);
      console.log(`下一步: paper evaluate -p ${projectName}  # 模拟评审`);
      console.log(`       paper export md -p ${projectName}      # 导出`);

      // 保存草稿
      saveDraft(projectName, execution);
    } else {
      console.error(`\n❌ 生成失败: ${execution.errors.map(e => e.message).join("; ")}`);
    }
  } catch (error) {
    console.error(`\n❌ 执行错误: ${error}`);
  }
}

/**
 * 创建默认"评审优化循环"工作流
 */
function createDefaultWorkflow(templateId: string) {
  return {
    id: `default-${templateId}`,
    name: "标准评审优化流程",
    description: "选题→写作→评审→优化→完成",
    competition: templateId.split("-")[0] ?? "dachuang",
    agents: ["topic-advisor", "writer", "reviewer", "polisher"],
    maxLoops: 3,
    targetScore: 80,
    startNode: "topic",
    nodes: [
      {
        id: "topic",
        type: "topic_generation" as const,
        label: "选题论证",
        agentRef: "topic-advisor",
        promptTemplate: undefined,
        inputs: ["project_name", "variables"],
        outputs: ["topic_suggestion"],
        next: ["write"],
      },
      {
        id: "write",
        type: "write_section" as const,
        label: "申报书写作",
        agentRef: "writer",
        promptTemplate: undefined,
        inputs: ["topic_suggestion", "variables", "template_id"],
        outputs: ["full_draft"],
        next: ["evaluate"],
      },
      {
        id: "evaluate",
        type: "evaluate" as const,
        label: "模拟评审",
        agentRef: "reviewer",
        promptTemplate: undefined,
        inputs: ["full_draft"],
        outputs: ["score", "review_comments", "improvement_suggestions"],
        next: ["polish"],
        condition: {
          source: "score",
          operator: "lt" as const,
          value: 80,
          passTo: "polish",
          failTo: "", // 空 = 结束
        },
      },
      {
        id: "polish",
        type: "polish" as const,
        label: "定向优化",
        agentRef: "polisher",
        promptTemplate: undefined,
        inputs: ["full_draft", "review_comments", "improvement_suggestions"],
        outputs: ["full_draft"],
        next: ["evaluate"], // 循环回去
      },
    ],
  };
}

/**
 * 从文件加载自定义工作流
 */
function loadWorkflowFromFile(workflowArg: string): Array<{
  id: string; type: string; label: string; agentRef: string;
  inputs: string[]; outputs: string[]; next: string[];
  condition?: { source: string; operator: string; value: number; passTo: string; failTo: string };
}> | null {
  // 支持绝对路径和相对路径
  const candidates = [
    workflowArg,
    join(homedir(), ".paper", "workflows", workflowArg),
    join(homedir(), ".paper", "workflows", `${workflowArg}.yaml`),
    join(process.cwd(), workflowArg),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown>;
        const nodes = parsed.nodes as Array<Record<string, unknown>>;
        if (!nodes || !Array.isArray(nodes)) return null;
        return nodes.map((n) => ({
          id: n.id as string,
          type: n.type as string,
          label: n.label as string,
          agentRef: n.agentRef as string,
          inputs: (n.inputs as string[]) ?? [],
          outputs: (n.outputs as string[]) ?? [],
          next: (n.next as string[]) ?? [],
          condition: n.condition as (typeof nodes[0]["condition"]) ?? undefined,
        }));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 从用户主目录加载 LLM 配置
 */
function loadLLMConfig(): LLMConfig | null {
  const configPath = join(homedir(), ".paper", "config.yaml");
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;
    const llm = config.llm as Record<string, unknown> | undefined;

    if (!llm?.apiKey) return null;

    // 也检查环境变量（优先级更高）
    const envMap: Record<string, string> = {
      deepseek: "PAPER_DEEPSEEK_API_KEY",
      openai: "PAPER_OPENAI_API_KEY",
      claude: "PAPER_CLAUDE_API_KEY",
    };

    const provider = (llm.provider as string) || "deepseek";
    const envKey = envMap[provider];
    const apiKey = (envKey && process.env[envKey]) || (llm.apiKey as string);

    return {
      provider: provider as LLMProvider,
      apiKey,
      baseUrl: llm.baseUrl as string | undefined,
      defaultModel: (llm.model as string) || "deepseek-chat",
      defaultTemperature: 0.7,
    };
  } catch {
    return null;
  }
}

function saveDraft(projectName: string, execution: { context: { snapshot(): Record<string, unknown> } }): void {
  try {
    const draftsDir = join(PROJECTS_DIR, projectName, ".paper", "drafts");
    if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true });

    const snap = execution.context.snapshot();
    const draftContent = (snap.full_draft as string) || (snap.topic_suggestion as string) || JSON.stringify(snap, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const draftPath = join(draftsDir, `draft-${timestamp}.md`);
    writeFileSync(draftPath, draftContent, "utf-8");
    console.log(`   💾 草稿已保存: ${draftPath}`);
  } catch (e) {
    // 保存失败不影响主流程
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}
