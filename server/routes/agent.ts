// ============================================================
// API — 智能体对话
// ============================================================

import { Router } from "express";
import { AGENTS_DIR } from "../../src/config/defaults.js";
import { AgentRegistry } from "../../src/core/agent/registry.js";
import { AgentRuntime } from "../../src/core/agent/runtime.js";
import { LLMService } from "../../src/core/llm/adapter.js";
import { loadAgent } from "../../src/core/agent/loader.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const agentRouter = Router();

// ── 读取 LLM 配置 ──
function loadLLMConfig() {
  const configPath = join(homedir(), ".paper", "config.yaml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;
    const llm = config.llm as Record<string, unknown> | undefined;
    if (!llm?.apiKey) return null;
    const envKey = `PAPER_${(llm.provider as string)?.toUpperCase() ?? "DEEPSEEK"}_API_KEY`;
    return {
      provider: (llm.provider as string) || "deepseek",
      apiKey: process.env[envKey] || (llm.apiKey as string),
      defaultModel: (llm.model as string) || "deepseek-v4-flash",
    };
  } catch { return null; }
}

// ── 获取可用智能体列表 ──
agentRouter.get("/", (_req, res) => {
  const registry = new AgentRegistry(AGENTS_DIR);
  res.json(registry.listAll());
});

// ── 与智能体对话（带项目书上下文） ──
agentRouter.post("/chat", async (req, res) => {
  const { agentName, message, history, context } = req.body;
  if (!agentName || !message) return res.status(400).json({ error: "缺少参数" });

  // 注入项目上下文
  let contextualMessage = message;
  if (context?.draft) {
    const draftPreview = (context.draft as string).slice(0, 2000);
    const projectName = (context.projectName as string) || "";
    contextualMessage = `[项目: ${projectName}]\n当前申报书内容:\n${draftPreview}\n\n---\n用户指令: ${message}`;
  }
  if (context?.projectName && !context?.draft) {
    contextualMessage = `[项目: ${context.projectName as string}]\n用户指令: ${message}`;
  }

  const llmConfig = loadLLMConfig();
  const llmService = new LLMService(llmConfig ? [llmConfig] : []);
  const registry = new AgentRegistry(AGENTS_DIR);
  const runtime = new AgentRuntime({ llmService });

  const agent = registry.getDef(agentName);
  if (!agent) return res.status(404).json({ error: `智能体 ${agentName} 未找到` });

  try {
    const result = await runtime.chat(agent, message);
    res.json({ reply: result.reply, sessionId: result.session.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── 直接 LLM 调用（SEARCH/REPLACE 编辑模式） ──
agentRouter.post("/edit", async (req, res) => {
  const { message, content: docContent } = req.body;
  if (!message) return res.status(400).json({ error: "缺少参数" });

  const llmConfig = loadLLMConfig();
  if (!llmConfig?.apiKey) return res.status(400).json({ error: "未配置 API Key" });

  const prompt = `${message}\n\n当前文档内容：\n${(docContent || "").slice(0, 5000)}\n\n请你分析我的需求，用 SEARCH/REPLACE 格式输出对文档的修改。\n格式要求：\n<<<<<<< SEARCH\n（这里放文档中要被替换的原文，必须和文档内容完全一致）\n=======\n（这里放替换后的新内容）\n>>>>>>> REPLACE\n\n可以输出多个 SEARCH/REPLACE 块。如果不需要修改，请直接说明。`;

  try {
    const r = await fetch(`${(llmConfig as any).baseUrl || "https://api.deepseek.com"}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmConfig.apiKey}` },
      body: JSON.stringify({ model: llmConfig.defaultModel || "deepseek-v4-flash", messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: 0.3 }),
    });
    const data = await r.json() as any;
    const reply = data.choices?.[0]?.message?.content || "";
    res.json({ reply });
  } catch (e: any) {
    res.status(500).json({ error: `LLM 调用失败: ${e.message}` });
  }
});

// ── 获取单个智能体详情 ──
agentRouter.get("/:name", (req, res) => {
  const agentDef = loadAgent(join(AGENTS_DIR, `${req.params.name}.yaml`));
  if (!agentDef) return res.status(404).json({ error: "智能体未找到" });
  res.json(agentDef);
});
