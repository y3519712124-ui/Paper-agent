// ============================================================
// Paper-agent CLI 入口
// Commander.js 命令行框架
// ============================================================

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  version: string;
  description: string;
};

const program = new Command();

program
  .name("paper")
  .description(pkg.description)
  .version(pkg.version)
  .helpOption("-h, --help", "查看帮助");

// ── 项目初始化 ──
program
  .command("init")
  .description("创建新项目")
  .argument("[name]", "项目名称")
  .option("-t, --template <id>", "使用的模板 ID", "dachuang-innovation-training")
  .option("-c, --competition <name>", "赛事类型 (dachuang/tiaozhanbei/internet-plus)")
  .action(async (name, options) => {
    const { initProject } = await import("./commands/init.js");
    await initProject(name ?? "my-project", options);
  });

// ── 生成内容 ──
program
  .command("generate")
  .description("启动多智能体协作生成申报书")
  .option("-p, --project <id>", "项目 ID")
  .option("-w, --workflow <id>", "工作流 ID")
  .option("--no-chat", "跳过交互确认，直接生成")
  .action(async (options) => {
    const { generateContent } = await import("./commands/generate.js");
    await generateContent(options);
  });

// ── 模拟评审 ──
program
  .command("evaluate")
  .description("模拟评审专家打分")
  .option("-p, --project <id>", "项目 ID")
  .option("-d, --draft <path>", "指定草稿文件路径")
  .option("-s, --standard <name>", "评分标准")
  .action(async (options) => {
    const { evaluateDraft } = await import("./commands/evaluate.js");
    await evaluateDraft(options);
  });

// ── 迭代优化 ──
program
  .command("polish")
  .description("根据评审结果迭代优化")
  .argument("[rounds]", "优化轮次", "1")
  .option("-p, --project <id>", "项目 ID")
  .action(async (rounds, options) => {
    const { polishDraft } = await import("./commands/polish.js");
    await polishDraft(parseInt(rounds), options);
  });

// ── 对话模式 ──
program
  .command("chat")
  .description("与指定智能体实时对话")
  .argument("<agent>", "智能体名称 (writer/reviewer/topic-advisor...)")
  .option("-p, --project <id>", "项目 ID")
  .action(async (agent, options) => {
    const { chatWithAgent } = await import("./commands/chat.js");
    await chatWithAgent(agent, options);
  });

// ── 导出 ──
program
  .command("export")
  .description("导出申报书")
  .argument("<format>", "导出格式 (md/pdf/docx)")
  .option("-p, --project <id>", "项目 ID")
  .option("-o, --output <path>", "输出路径")
  .option("--python", "使用 Python 引擎（推荐用于 docx）")
  .action(async (format, options) => {
    const { exportDoc } = await import("./commands/export.js");
    await exportDoc(format, options);
  });

// ── 工作流编辑器 ──
program
  .command("workflow")
  .description("可视化工作流编辑器")
  .option("-p, --project <id>", "项目 ID")
  .action(async (options) => {
    const { editWorkflow } = await import("./commands/workflow.js");
    await editWorkflow(options);
  });

// ── Agent 管理 ──
program
  .command("agent")
  .description("管理智能体")
  .argument("<action>", "操作 (list/create/edit)")
  .argument("[name]", "智能体名称")
  .option("-r, --role <role>", "智能体角色")
  .option("-l, --language <lang>", "语言 (typescript/python)")
  .action(async (action, name, options) => {
    const { manageAgent } = await import("./commands/agent.js");
    await manageAgent(action, name, options);
  });

// ── 团队预设 ──
program
  .command("team")
  .description("管理智能体团队")
  .argument("<action>", "操作 (use/list)")
  .argument("[name]", "团队名称")
  .action(async (action, name) => {
    const { manageTeam } = await import("./commands/team.js");
    await manageTeam(action, name);
  });

// ── 配置 ──
program
  .command("config")
  .description("查看/修改配置")
  .argument("[action]", "操作 (show/set)")
  .option("--provider <name>", "LLM 供应商 (deepseek/openai/claude)")
  .option("--api-key <key>", "API Key")
  .option("--model <name>", "默认模型")
  .action(async (action, options) => {
    const { manageConfig } = await import("./commands/config.js");
    await manageConfig(action ?? "show", options);
  });

// ── 解析运行 ──
program.parse(process.argv);

// 无参数时显示帮助
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
