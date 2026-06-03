// ============================================================
// Agent 系统核心类型
// ============================================================

/** Agent 运行语言 */
export type AgentLanguage = "typescript" | "python";

/** Agent 角色类型 */
export type AgentRole =
  | "topic_advisor"     // 选题顾问
  | "researcher"        // 调研员
  | "innovation_architect" // 创新架构师
  | "writer"            // 写作专员
  | "reviewer"          // 评审专家
  | "format_checker"    // 格式审查员
  | "polisher"          // 润色编辑
  | "custom";           // 自定义

/** Agent 可调用工具 */
export type AgentTool =
  | "web_search"
  | "read_file"
  | "write_file"
  | "read_draft"
  | "evaluate"
  | "render_template"
  | "export_markdown";

/** 输入输出字段定义 */
export interface AgentIOField {
  key: string;
  label: string;
  type: "string" | "number" | "object" | "array";
  description?: string;
  required?: boolean;
}

/** Agent 定义 */
export interface AgentDef {
  name: string;
  role: AgentRole;
  label: string;
  language: AgentLanguage;
  model: string;
  temperature: number;
  systemPrompt: string;
  tools: AgentTool[];
  input: AgentIOField[];
  output: AgentIOField[];
  memory?: string[];
  allowedContextKeys?: string[];
}

/** Agent 实例状态 */
export type AgentStatus = "idle" | "running" | "completed" | "error";

/** Agent 运行时实例 */
export interface AgentInstance {
  id: string;
  def: AgentDef;
  status: AgentStatus;
  sessionId: string | null;
  lastCalled: Date | null;
  error?: string;
}

/** Agent 调用记录 */
export interface AgentCallRecord {
  agentId: string;
  method: string;
  params: Record<string, unknown>;
  result: unknown;
  startTime: Date;
  endTime: Date;
  tokensUsed?: number;
  error?: string;
}

/** Agent 对话会话 */
export interface AgentSession {
  id: string;
  agentId: string;
  projectId: string;
  messages: AgentMessage[];
  tokensUsed: number;
  duration: number;
  created: Date;
  updated: Date;
}

/** Agent 消息 */
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/** Agent 元数据（用于列表/选择器） */
export interface AgentMeta {
  name: string;
  label: string;
  role: AgentRole;
  language: AgentLanguage;
  description: string;
  isBuiltin: boolean;
  filePath?: string;
}
