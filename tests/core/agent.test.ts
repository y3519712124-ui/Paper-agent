// ============================================================
// Agent 系统测试
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "../../src/core/agent/registry.js";
import type { AgentDef } from "../../src/core/agent/types.js";

// 模拟 Agent 定义
const MOCK_AGENTS: AgentDef[] = [
  {
    name: "writer",
    role: "writer",
    label: "写作专员",
    language: "typescript",
    model: "deepseek-v4-flash",
    temperature: 0.7,
    systemPrompt: "你是一个写作专家。",
    tools: [],
    input: [{ key: "topic", label: "选题", type: "string" }],
    output: [{ key: "draft", label: "草稿", type: "string" }],
  },
  {
    name: "reviewer",
    role: "reviewer",
    label: "评审专家",
    language: "python",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    systemPrompt: "你是一个评审专家。",
    tools: ["evaluate"],
    input: [{ key: "draft", label: "草稿", type: "string" }],
    output: [
      { key: "score", label: "评分", type: "object" },
      { key: "comments", label: "评语", type: "string" },
    ],
  },
];

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry("nonexistent-dir");
  });

  it("创建时不应抛出异常", () => {
    expect(registry).toBeInstanceOf(AgentRegistry);
  });

  it("没有内置 Agent 时列表应返回空数组", () => {
    const agents = registry.listBuiltin();
    expect(agents).toEqual([]);
  });

  it("获取不存在的 Agent 应返回 null", () => {
    const def = registry.getDef("nonexistent");
    expect(def).toBeNull();
  });

  it("获取不存在的实例应返回 null", () => {
    const instance = registry.getOrCreateInstance("nonexistent");
    expect(instance).toBeNull();
  });

  it("更新不存在实例的状态不应抛出异常", () => {
    expect(() => registry.updateStatus("nonexistent", "running")).not.toThrow();
  });
});

// ── AgentDef 类型验证 ──
describe("AgentDef", () => {
  it("writer Agent 应正确定义", () => {
    const writer = MOCK_AGENTS[0]!;
    expect(writer.name).toBe("writer");
    expect(writer.language).toBe("typescript");
    expect(writer.input).toHaveLength(1);
    expect(writer.output).toHaveLength(1);
  });

  it("reviewer Agent 应有 evaluate 工具", () => {
    const reviewer = MOCK_AGENTS[1]!;
    expect(reviewer.tools).toContain("evaluate");
    expect(reviewer.language).toBe("python");
  });

  it("所有 Agent 必须有 systemPrompt", () => {
    for (const agent of MOCK_AGENTS) {
      expect(agent.systemPrompt).toBeTruthy();
    }
  });
});
