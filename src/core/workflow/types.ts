// ============================================================
// 工作流引擎核心类型
// ============================================================

import type { AgentDef } from "../agent/types.js";

/** 工作流节点类型 */
export type WorkflowNodeType =
  | "topic_generation"    // 选题论证
  | "research"            // 调研
  | "innovation_extract"  // 创新提炼
  | "outline"             // 大纲生成
  | "write_section"       // 章节写作
  | "merge"               // 合并
  | "evaluate"            // 评审
  | "polish"              // 润色
  | "format_check"        // 格式检查
  | "custom_agent_call";  // 调用自定义 Agent

/** 工作流节点定义 */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  agentRef: string;           // 关联的 Agent 名称
  promptTemplate?: string;    // 节点级 Prompt 覆盖
  inputs: string[];           // 从黑板读取的 key 列表
  outputs: string[];          // 写入黑板的 key 列表
  next: string[];             // 后续节点列表
  condition?: {
    source: string;           // 检查哪个输出
    operator: "lt" | "gt" | "eq" | "gte" | "lte";
    value: number;
    passTo: string;           // 条件满足时走向
    failTo: string;           // 条件不满足时走向
  };
  parallel?: boolean;         // 是否并行执行
  retryCount?: number;
}

/** 工作流定义 */
export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  competition: string;
  agents: string[];           // 用到的 Agent 名称列表
  nodes: WorkflowNode[];
  startNode: string;          // 起始节点 ID
  maxLoops?: number;          // evaluate→polish 最大循环数
  targetScore?: number;       // 目标分数（达标自动停止）
}

/** 共享黑板中的槽位 */
export interface ContextSlot {
  key: string;
  value: unknown;
  updatedBy: string;          // 最后更新的 Agent ID
  updatedAt: Date;
  lockedBy?: string;          // 写锁
  version: number;
}

/** 共享黑板 */
export interface SharedContext {
  projectId: string;
  slots: Map<string, ContextSlot>;
  workflowId: string;
  startedAt: Date;
  updatedAt: Date;
}

/** 工作流执行状态 */
export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "error";

/** 工作流执行记录 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  projectId: string;
  status: WorkflowStatus;
  currentNodeId: string | null;
  completedNodes: string[];
  loopCount: number;
  context: SharedContext;
  errors: WorkflowError[];
  startedAt: Date;
  completedAt: Date | null;
}

/** 工作流执行错误 */
export interface WorkflowError {
  nodeId: string;
  code: string;
  message: string;
  timestamp: Date;
  recoverable: boolean;
}

/** 工作流执行进度 */
export interface WorkflowProgress {
  executionId: string;
  totalNodes: number;
  completedNodes: number;
  currentNode: string | null;
  status: WorkflowStatus;
  loopIteration: number;
  message: string;
  scores?: Record<string, number>;
}

/** 工作流元数据 */
export interface WorkflowMeta {
  id: string;
  name: string;
  description: string;
  competition: string;
  agentCount: number;
  nodeCount: number;
  isBuiltin: boolean;
  filePath?: string;
}
