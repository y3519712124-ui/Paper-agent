// ============================================================
// 工作流引擎
// 多智能体 DAG 执行器，编排协作流程
// ============================================================

import type {
  WorkflowDef,
  WorkflowNode,
  WorkflowExecution,
  WorkflowStatus,
  WorkflowProgress,
} from "./types.js";
import { SharedContext } from "./context.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { TemplateDef } from "../template/types.js";

/** 工作流引擎配置 */
export interface WorkflowEngineConfig {
  registry: AgentRegistry;
  runtime: AgentRuntime;
  template?: TemplateDef;
}

/** 进度回调 */
export type ProgressCallback = (progress: WorkflowProgress) => void;

/**
 * 工作流引擎
 * 按照 DAG 定义依次/并行执行各节点
 */
export class WorkflowEngine {
  private registry: AgentRegistry;
  private runtime: AgentRuntime;
  private template: TemplateDef | undefined;
  private executions: Map<string, WorkflowExecution> = new Map();
  private progressCallbacks: Set<ProgressCallback> = new Set();

  constructor(config: WorkflowEngineConfig) {
    this.registry = config.registry;
    this.runtime = config.runtime;
    this.template = config.template;
  }

  /**
   * 注册进度回调
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  /**
   * 执行工作流
   */
  async execute(
    workflow: WorkflowDef,
    projectId: string,
    initialContext?: Record<string, unknown>,
  ): Promise<WorkflowExecution> {
    const context = new SharedContext(projectId, workflow.id);

    // 注入初始上下文
    if (initialContext) {
      context.setBatch(initialContext, "system");
    }

    const execution: WorkflowExecution = {
      id: `exec-${Date.now()}`,
      workflowId: workflow.id,
      projectId,
      status: "running",
      currentNodeId: workflow.startNode,
      completedNodes: [],
      loopCount: 0,
      context,
      errors: [],
      startedAt: new Date(),
      completedAt: null,
    };

    this.executions.set(execution.id, execution);
    this.emitProgress(execution, "工作流开始执行");

    try {
      // ── DAG 执行 ──
      await this.executeNode(workflow, workflow.startNode, execution);
      execution.status = "completed";
      execution.completedAt = new Date();
      this.emitProgress(execution, "工作流执行完成");
    } catch (error) {
      execution.status = "error";
      execution.errors.push({
        nodeId: execution.currentNodeId ?? "unknown",
        code: "EXECUTION_ERROR",
        message: String(error),
        timestamp: new Date(),
        recoverable: false,
      });
      this.emitProgress(execution, `执行出错: ${error}`);
    }

    return execution;
  }

  /**
   * 获取执行记录
   */
  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * 列出所有执行记录
   */
  listExecutions(projectId?: string): WorkflowExecution[] {
    const all = Array.from(this.executions.values());
    if (projectId) {
      return all.filter((e) => e.projectId === projectId);
    }
    return all;
  }

  // ── 节点执行 ──

  private async executeNode(
    workflow: WorkflowDef,
    nodeId: string,
    execution: WorkflowExecution,
    visited = new Set<string>(),
  ): Promise<void> {
    // 空节点 ID = 工作流结束
    if (!nodeId) return;

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`工作流节点 ${nodeId} 不存在`);
    }

    // 循环检测
    if (visited.has(nodeId)) {
      execution.loopCount++;
      if (workflow.maxLoops && execution.loopCount > workflow.maxLoops) {
        this.emitProgress(execution, `达到最大循环次数 ${workflow.maxLoops}，停止`);
        return;
      }
    }
    visited.add(nodeId);

    execution.currentNodeId = nodeId;
    this.emitProgress(execution, `执行节点: ${node.label}`);

    // ── 收集输入 ──
    const inputs = this.collectInputs(node, execution.context);

    // ── 查找关联 Agent ──
    const agentDef = this.registry.getDef(node.agentRef);
    if (!agentDef) {
      throw new Error(`Agent ${node.agentRef} 未找到`);
    }

    // ── 执行 ──
    const { result } = await this.runtime.call(agentDef, inputs);

    // ── 写入输出到黑板 ──
    if (typeof result === "object" && result !== null) {
      const resultObj = result as Record<string, unknown>;
      for (const outputKey of node.outputs) {
        // 如果 result 里有对应的 key，取之；否则存整个 result
        const value = resultObj[outputKey] ?? result;
        execution.context.set(outputKey, value, agentDef.name);
      }
    } else {
      // 标量结果写入第一个 output
      if (node.outputs.length > 0) {
        execution.context.set(node.outputs[0], result, agentDef.name);
      }
    }

    execution.completedNodes.push(nodeId);
    this.emitProgress(execution, `节点完成: ${node.label}`);

    // ── 条件分支 ──
    let nextNodes = node.next;

    if (node.condition) {
      const conditionMet = this.evaluateCondition(node, execution.context);
      nextNodes = conditionMet ? [node.condition.passTo] : [node.condition.failTo];
    }

    // ── 执行后续节点 ──
    if (nextNodes.length === 0) return;

    if (node.parallel) {
      // 并行执行
      await Promise.all(
        nextNodes.map((nextId) =>
          this.executeNode(workflow, nextId, execution, new Set(visited)),
        ),
      );
    } else {
      // 串行执行
      for (const nextId of nextNodes) {
        await this.executeNode(workflow, nextId, execution, new Set(visited));
      }
    }
  }

  private collectInputs(
    node: WorkflowNode,
    context: SharedContext,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const key of node.inputs) {
      const value = context.get(key);
      if (value !== undefined) {
        inputs[key] = value;
      }
    }
    return inputs;
  }

  private evaluateCondition(
    node: WorkflowNode,
    context: SharedContext,
  ): boolean {
    if (!node.condition) return true;
    const value = context.get<number>(node.condition.source);
    if (value === undefined) return false;

    switch (node.condition.operator) {
      case "lt": return value < node.condition.value;
      case "gt": return value > node.condition.value;
      case "eq": return value === node.condition.value;
      case "gte": return value >= node.condition.value;
      case "lte": return value <= node.condition.value;
      default: return true;
    }
  }

  private emitProgress(execution: WorkflowExecution, message: string): void {
    const totalNodes = 0; // 可以从 workflow 计算
    const progress: WorkflowProgress = {
      executionId: execution.id,
      totalNodes,
      completedNodes: execution.completedNodes.length,
      currentNode: execution.currentNodeId,
      status: execution.status,
      loopIteration: execution.loopCount,
      message,
    };

    for (const cb of this.progressCallbacks) {
      cb(progress);
    }
  }
}
