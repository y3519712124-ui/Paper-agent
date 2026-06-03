// ============================================================
// Agent 注册表
// 管理所有可用的 Agent 定义（内置 + 用户自定义）
// ============================================================

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, AgentMeta, AgentInstance, AgentStatus } from "./types.js";
import { loadAgent, scanAgents, findAgentByName } from "./loader.js";

export class AgentRegistry {
  private instances: Map<string, AgentInstance> = new Map();
  private builtinDir: string;
  private userDir: string;

  constructor(builtinDir: string, userDir?: string) {
    this.builtinDir = builtinDir;
    this.userDir = userDir ?? "";

    // 确保用户目录存在
    if (this.userDir && !existsSync(this.userDir)) {
      mkdirSync(this.userDir, { recursive: true });
    }
  }

  /**
   * 列出所有可用 Agent
   */
  listAll(): AgentMeta[] {
    const builtins = scanAgents(this.builtinDir);
    const userAgents = this.userDir ? scanAgents(this.userDir) : [];
    return [...builtins, ...userAgents];
  }

  /**
   * 列出内置 Agent
   */
  listBuiltin(): AgentMeta[] {
    return scanAgents(this.builtinDir);
  }

  /**
   * 列出用户自定义 Agent
   */
  listUser(): AgentMeta[] {
    if (!this.userDir) return [];
    return scanAgents(this.userDir);
  }

  /**
   * 获取 Agent 定义
   */
  getDef(name: string): AgentDef | null {
    // 先查用户目录，再查内置
    if (this.userDir) {
      const user = findAgentByName(this.userDir, name);
      if (user) return user;
    }
    return findAgentByName(this.builtinDir, name);
  }

  /**
   * 获取或创建 Agent 实例
   */
  getOrCreateInstance(name: string): AgentInstance | null {
    const existing = this.instances.get(name);
    if (existing) return existing;

    const def = this.getDef(name);
    if (!def) return null;

    const instance: AgentInstance = {
      id: `${name}-${Date.now()}`,
      def,
      status: "idle",
      sessionId: null,
      lastCalled: null,
    };

    this.instances.set(name, instance);
    return instance;
  }

  /**
   * 更新实例状态
   */
  updateStatus(name: string, status: AgentStatus): void {
    const instance = this.instances.get(name);
    if (instance) {
      instance.status = status;
      if (status === "running") {
        instance.lastCalled = new Date();
      }
    }
  }

  /**
   * 获取所有活跃实例
   */
  getActiveInstances(): AgentInstance[] {
    return Array.from(this.instances.values()).filter(
      (i) => i.status === "idle" || i.status === "running",
    );
  }

  /**
   * 创建自定义 Agent（写入用户目录）
   */
  createCustom(def: AgentDef): void {
    if (!this.userDir) {
      throw new Error("未设置用户 Agent 目录");
    }
    const filePath = join(this.userDir, `${def.name}.yaml`);
    // 通过 YAML 写入（用 JSON 序列化模拟，后续优化）
    const yaml = serializeAgentToYaml(def);
    import("node:fs").then((fs) => fs.writeFileSync(filePath, yaml, "utf-8"));
  }
}

/**
 * 将 AgentDef 序列化为 YAML
 */
function serializeAgentToYaml(def: AgentDef): string {
  const lines: string[] = [];
  lines.push(`name: ${def.name}`);
  lines.push(`role: ${def.role}`);
  lines.push(`label: "${def.label}"`);
  lines.push(`language: ${def.language}`);
  lines.push(`model: ${def.model}`);
  lines.push(`temperature: ${def.temperature}`);
  lines.push("");
  lines.push(`systemPrompt: |`);
  lines.push(`  ${def.systemPrompt.replace(/\n/g, "\n  ")}`);
  lines.push("");
  if (def.tools.length > 0) {
    lines.push(`tools:`);
    for (const t of def.tools) lines.push(`  - ${t}`);
    lines.push("");
  }
  if (def.input.length > 0) {
    lines.push(`input:`);
    for (const i of def.input) lines.push(`  - { key: ${i.key}, label: "${i.label}", type: ${i.type} }`);
    lines.push("");
  }
  if (def.output.length > 0) {
    lines.push(`output:`);
    for (const o of def.output) lines.push(`  - { key: ${o.key}, label: "${o.label}", type: ${o.type} }`);
  }
  return lines.join("\n");
}
