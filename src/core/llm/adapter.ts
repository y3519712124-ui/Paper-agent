// ============================================================
// LLM 适配器（服务层）
// 统一管理所有 LLM 后端的调用
// ============================================================

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  LLMUsageRecord,
} from "./types.js";

/**
 * LLM 服务
 * 管理多个 provider 的适配器，提供统一的 chat/chatStream 接口
 */
export class LLMService {
  private configs: Map<LLMProvider, LLMConfig> = new Map();
  private usageRecords: LLMUsageRecord[] = [];
  private defaultProvider: LLMProvider = "deepseek";

  constructor(initialConfigs?: LLMConfig[]) {
    if (initialConfigs) {
      for (const cfg of initialConfigs) {
        this.configs.set(cfg.provider, cfg);
      }
    }
  }

  /**
   * 注册/更新一个 LLM 供应商配置
   */
  setConfig(config: LLMConfig): void {
    this.configs.set(config.provider, config);
  }

  /**
   * 获取当前配置
   */
  getConfig(provider: LLMProvider): LLMConfig | undefined {
    return this.configs.get(provider);
  }

  /**
   * 设置默认供应商
   */
  setDefaultProvider(provider: LLMProvider): void {
    this.defaultProvider = provider;
  }

  /**
   * 调用 LLM（对话模式）
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    const config = this.configs.get(request.provider);

    if (!config) {
      // 没有配置时返回模拟响应（开发/演示用）
      return this.mockChat(request);
    }

    // 实际 API 调用（留接口，具体实现依赖 API Key）
    const response = await this.callAPI(request, config);
    const duration = Date.now() - startTime;

    if (response.tokensUsed) {
      this.usageRecords.push({
        timestamp: new Date(),
        provider: request.provider,
        model: response.model,
        inputTokens: response.tokensUsed.input,
        outputTokens: response.tokensUsed.output,
        totalTokens: response.tokensUsed.total,
        durationMs: duration,
      });
    }

    return response;
  }

  /**
   * 流式调用
   */
  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const config = this.configs.get(request.provider);
    if (!config) {
      yield { content: "（模拟响应：未配置 LLM API）", done: true };
      return;
    }
    yield* this.callAPIStream(request, config);
  }

  /**
   * 获取用量统计
   */
  getUsage(provider?: LLMProvider): LLMUsageRecord[] {
    if (provider) {
      return this.usageRecords.filter((r) => r.provider === provider);
    }
    return [...this.usageRecords];
  }

  /**
   * 获取总 Token 消耗
   */
  getTotalTokens(): number {
    return this.usageRecords.reduce((sum, r) => sum + r.totalTokens, 0);
  }

  // ── 模拟调用（开发阶段使用） ──
  private async mockChat(request: LLMRequest): Promise<LLMResponse> {
    // 模拟延迟
    await new Promise((r) => setTimeout(r, 500));

    const lastMsg = request.messages[request.messages.length - 1];
    return {
      content: `（模拟响应）\n\n收到您的输入：\n"${lastMsg?.content?.slice(0, 100) ?? ""}..."\n\n请配置 LLM API Key 以获取真实响应。\n\n配置方式：\n\`paper config set --provider deepseek --api-key sk-xxx\``,
      tokensUsed: { input: 100, output: 50, total: 150 },
      model: request.model,
      finishReason: "stop",
    };
  }

    // ── 真实 API 调用（DeepSeek / OpenAI 兼容接口） ──
  private async callAPI(
    request: LLMRequest,
    config: LLMConfig,
  ): Promise<LLMResponse> {
    const baseUrl = config.baseUrl ?? "https://api.deepseek.com/v1";
    const url = `${baseUrl}/chat/completions`;

    const body = {
      model: request.model || config.defaultModel || "deepseek-chat",
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: request.temperature ?? config.defaultTemperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API 错误 (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0]?.message.content ?? "",
      tokensUsed: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
      model: data.model,
      finishReason: (data.choices[0]?.finish_reason as "stop" | "length" | "error") ?? "stop",
    };
  }

  // ── 流式 API 调用 ──
  private async *callAPIStream(
    request: LLMRequest,
    config: LLMConfig,
  ): AsyncIterable<LLMStreamChunk> {
    const baseUrl = config.baseUrl ?? "https://api.deepseek.com/v1";
    const url = `${baseUrl}/chat/completions`;

    const body = {
      model: request.model || config.defaultModel || "deepseek-chat",
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: request.temperature ?? config.defaultTemperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API 流式错误 (${response.status}): ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("响应体不可读");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") {
          yield { content: "", done: true };
          return;
        }
        try {
          const chunk = JSON.parse(jsonStr) as {
            choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
          };
          const content = chunk.choices[0]?.delta?.content ?? "";
          yield { content, done: false };
        } catch {
          // 跳过解析失败的行
        }
      }
    }

    yield { content: "", done: true };
  }
}
