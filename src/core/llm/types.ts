// ============================================================
// LLM 适配层类型
// ============================================================

/** 支持的 LLM 供应商 */
export type LLMProvider = "deepseek" | "openai" | "claude";

/** LLM 请求 */
export interface LLMRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/** LLM 消息 */
export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** LLM 响应（非流式） */
export interface LLMResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  model: string;
  finishReason: "stop" | "length" | "error";
}

/** LLM 流式响应块 */
export interface LLMStreamChunk {
  content: string;
  done: boolean;
  tokensUsed?: {
    input: number;
    output: number;
    total: number;
  };
}

/** LLM 统一适配器接口 */
export interface LLMAdapter {
  readonly provider: LLMProvider;
  chat(request: LLMRequest): Promise<LLMResponse>;
  chatStream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}

/** LLM 配置 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultTemperature?: number;
  maxRetries?: number;
}

/** LLM 调用统计 */
export interface LLMUsageRecord {
  timestamp: Date;
  provider: LLMProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}
