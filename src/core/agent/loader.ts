// ============================================================
// Agent 加载器
// 从 YAML 文件加载 Agent 定义
// ============================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDef, AgentMeta, AgentRole, AgentLanguage, AgentTool, AgentIOField } from "./types.js";

/**
 * 从 YAML 文件加载 Agent 定义
 */
export function loadAgent(filePath: string): AgentDef {
  if (!existsSync(filePath)) {
    throw new Error(`Agent 文件不存在: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as Partial<AgentDef>;

  const required: (keyof AgentDef)[] = ["name", "systemPrompt"];
  for (const field of required) {
    if (!parsed[field]) {
      throw new Error(`Agent ${filePath} 缺少必填字段: ${field}`);
    }
  }

  const agent: AgentDef = {
    name: parsed.name!,
    role: (parsed.role ?? "custom") as AgentRole,
    label: parsed.label ?? parsed.name!,
    language: (parsed.language ?? "typescript") as AgentLanguage,
    model: parsed.model ?? "deepseek-chat",
    temperature: parsed.temperature ?? 0.7,
    systemPrompt: parsed.systemPrompt!,
    tools: (parsed.tools ?? []) as AgentTool[],
    input: (parsed.input ?? []) as AgentIOField[],
    output: (parsed.output ?? []) as AgentIOField[],
    memory: parsed.memory ?? [],
    allowedContextKeys: parsed.allowedContextKeys ?? [],
  };

  return agent;
}

/**
 * 扫描目录下所有 Agent 定义
 */
export function scanAgents(agentDir: string): AgentMeta[] {
  if (!existsSync(agentDir)) return [];

  const entries = readdirSync(agentDir);
  return entries
    .filter((e) => e.endsWith(".yaml"))
    .map((file) => {
      const fullPath = join(agentDir, file);
      try {
        const agent = loadAgent(fullPath);
        return {
          name: agent.name,
          label: agent.label,
          role: agent.role,
          language: agent.language,
          description: agent.systemPrompt.slice(0, 120),
          isBuiltin: true,
          filePath: fullPath,
        };
      } catch {
        return null;
      }
    })
    .filter((m): m is AgentMeta => m !== null);
}

/**
 * 通过名称查找 Agent
 */
export function findAgentByName(agentDir: string, name: string): AgentDef | null {
  const all = scanAgents(agentDir);
  const meta = all.find(
    (m) => m.name === name || basename(m.filePath ?? "", extname(m.filePath ?? "")) === name,
  );
  if (!meta?.filePath) return null;
  return loadAgent(meta.filePath);
}
