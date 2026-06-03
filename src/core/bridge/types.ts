// ============================================================
// TS ↔ Python 通信协议类型
// ============================================================

/** 网桥消息类型 */
export type BridgeMessageType =
  | "call"           // TS → Python: 调用 Agent 方法
  | "response"       // Python → TS: 返回结果
  | "error"          // Python → TS: 错误
  | "ping"
  | "pong"
  | "progress"       // Python → TS: 执行进度
  | "log"            // Python → TS: 日志
  | "shutdown";      // TS → Python: 关闭

/** 网桥消息 */
export interface BridgeMessage {
  type: BridgeMessageType;
  messageId: string;
  agent?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  code?: number;
  progress?: {
    percent: number;
    message: string;
  };
  streamDone?: boolean;
  timestamp: string;
}

/** Python 子进程配置 */
export interface PythonBridgeConfig {
  pythonPath: string;           // python 可执行路径
  modulePath: string;           // Python 模块路径
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  maxRestarts: number;
}

/** 通过网桥调用的方法签名 */
export interface BridgeMethodCall {
  agent: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

/** 网桥状态 */
export type BridgeStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "shutdown";

/** 网桥统计 */
export interface BridgeStats {
  status: BridgeStatus;
  callsTotal: number;
  callsFailed: number;
  averageLatencyMs: number;
  uptimeMs: number;
  pythonVersion: string;
}
