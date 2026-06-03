// ============================================================
// 工作流引擎测试
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { SharedContext } from "../../src/core/workflow/context.js";
import type { WorkflowNode, WorkflowDef } from "../../src/core/workflow/types.js";

// ── SharedContext ──
describe("SharedContext", () => {
  let ctx: SharedContext;

  beforeEach(() => {
    ctx = new SharedContext("test-project", "test-workflow");
  });

  it("初始状态应为空", () => {
    expect(ctx.get("anything")).toBeUndefined();
  });

  it("写入后应能读取", () => {
    ctx.set("name", "测试项目");
    expect(ctx.get("name")).toBe("测试项目");
  });

  it("批量写入应全部生效", () => {
    ctx.setBatch({ a: 1, b: 2, c: "three" });
    expect(ctx.get("a")).toBe(1);
    expect(ctx.get("b")).toBe(2);
    expect(ctx.get("c")).toBe("three");
  });

  it("版本号应递增", () => {
    ctx.set("key", "v1");
    const slot1 = ctx.getSlot("key");
    expect(slot1?.version).toBe(1);

    ctx.set("key", "v2");
    const slot2 = ctx.getSlot("key");
    expect(slot2?.version).toBe(2);
  });

  it("写锁应阻止其他写入", () => {
    ctx.set("locked", "original", "agent-a");
    ctx.lock("locked", "agent-a");

    // 其他 Agent 尝试写入应失败
    const result = ctx.set("locked", "hack", "agent-b");
    expect(result).toBe(false);
    expect(ctx.get("locked")).toBe("original");
  });

  it("解锁后应能写入", () => {
    ctx.set("locked", "original", "agent-a");
    ctx.lock("locked", "agent-a");
    ctx.unlock("locked", "agent-a");

    const result = ctx.set("locked", "updated", "agent-b");
    expect(result).toBe(true);
    expect(ctx.get("locked")).toBe("updated");
  });

  it("has 方法应正确判断", () => {
    expect(ctx.has("foo")).toBe(false);
    ctx.set("foo", "bar");
    expect(ctx.has("foo")).toBe(true);
  });

  it("snapshot 应返回所有数据", () => {
    ctx.setBatch({ x: 10, y: 20 });
    const snap = ctx.snapshot();
    expect(snap).toEqual({ x: 10, y: 20 });
  });

  it("JSON 序列化和恢复应保持数据", () => {
    ctx.setBatch({ a: 1, b: "hello" });
    const json = ctx.toJSON();
    const restored = SharedContext.fromJSON(json);
    expect(restored.get("a")).toBe(1);
    expect(restored.get("b")).toBe("hello");
  });

  it("变更订阅应触发回调", () => {
    let changedKey = "";
    let changedValue: unknown = null;
    const unsubscribe = ctx.onChange((key, value) => {
      changedKey = key;
      changedValue = value;
    });

    ctx.set("newKey", "newValue");
    expect(changedKey).toBe("newKey");
    expect(changedValue).toBe("newValue");

    unsubscribe();
    ctx.set("afterUnsub", "val");
    expect(changedKey).toBe("newKey"); // 不再更新
  });

  it("allSlots 应返回所有槽位信息", () => {
    ctx.setBatch({ x: 1, y: 2 });
    const slots = ctx.allSlots();
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.key).sort()).toEqual(["x", "y"]);
  });
});

// ── WorkflowDef 类型验证 ──
describe("WorkflowDef", () => {
  it("应能构建有效的工作流定义", () => {
    const workflow: WorkflowDef = {
      id: "test-workflow",
      name: "测试工作流",
      description: "用于测试",
      competition: "dachuang",
      agents: ["writer", "reviewer"],
      startNode: "step1",
      maxLoops: 3,
      nodes: [
        {
          id: "step1",
          type: "write_section",
          label: "写作",
          agentRef: "writer",
          inputs: ["topic"],
          outputs: ["draft"],
          next: ["step2"],
        },
        {
          id: "step2",
          type: "evaluate",
          label: "评审",
          agentRef: "reviewer",
          inputs: ["draft"],
          outputs: ["score"],
          next: [],
          condition: {
            source: "score",
            operator: "lt",
            value: 80,
            passTo: "step1",
            failTo: "",
          },
        },
      ],
    };

    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.agents).toContain("writer");
    expect(workflow.startNode).toBe("step1");
    expect(workflow.nodes[1]?.condition?.value).toBe(80);
  });

  it("条件分支的默认值应正确", () => {
    const node: WorkflowNode = {
      id: "evaluate",
      type: "evaluate",
      label: "评审",
      agentRef: "reviewer",
      inputs: ["draft"],
      outputs: ["score"],
      next: [],
      condition: {
        source: "score",
        operator: "gte",
        value: 60,
        passTo: "next_step",
        failTo: "retry",
      },
    };

    expect(node.condition.source).toBe("score");
    expect(node.condition.operator).toBe("gte");
    expect(node.condition.value).toBe(60);
  });
});
