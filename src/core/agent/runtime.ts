// ============================================================
// Agent 运行时
// 执行 Agent 调用（TS 直接调用 / Python 桥接）
// ============================================================

import type { AgentDef, AgentCallRecord, AgentSession, AgentMessage } from "./types.js";
import type { PythonBridge } from "../bridge/python-bridge.js";
import { LLMService } from "../llm/adapter.js";

export interface AgentRuntimeConfig {
  llmService: LLMService;
  pythonBridge?: PythonBridge;
  defaultModel?: string;
}

export class AgentRuntime {
  private llm: LLMService;
  private bridge: PythonBridge | undefined;
  private sessions: Map<string, AgentSession> = new Map();
  private callHistory: AgentCallRecord[] = [];

  constructor(config: AgentRuntimeConfig) {
    this.llm = config.llmService;
    this.bridge = config.pythonBridge;
  }

  /**
   * 调用 Agent（核心方法）
   */
  async call(
    agent: AgentDef,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ result: unknown; session: AgentSession }> {
    // ── 获取或创建会话 ──
    const session = this.getOrCreateSession(agent, sessionId);
    const startTime = new Date();

    try {
      let result: unknown;

      if (agent.language === "python" && this.bridge) {
        // ── Python Agent：通过桥调用 ──
        result = await this.bridge.call({
          agent: agent.name,
          method: "run",
          params: {
            systemPrompt: agent.systemPrompt,
            input: params,
            temperature: agent.temperature,
          },
        });
      } else {
        // ── TS Agent：直接调用 LLM ──
        result = await this.callTSAgent(agent, params, session);
      }

      const endTime = new Date();
      const record: AgentCallRecord = {
        agentId: agent.name,
        method: "run",
        params,
        result,
        startTime,
        endTime,
      };
      this.callHistory.push(record);

      // 记录到 session
      session.messages.push({
        role: "assistant",
        content: typeof result === "string" ? result : JSON.stringify(result),
        timestamp: endTime,
      });

      return { result, session };
    } catch (error) {
      const endTime = new Date();
      const record: AgentCallRecord = {
        agentId: agent.name,
        method: "run",
        params,
        result: null,
        startTime,
        endTime,
        error: String(error),
      };
      this.callHistory.push(record);
      throw error;
    }
  }

  /**
   * 对话模式（多轮交互）
   */
  async chat(
    agent: AgentDef,
    message: string,
    sessionId?: string,
  ): Promise<{ reply: string; session: AgentSession }> {
    const session = this.getOrCreateSession(agent, sessionId);

    session.messages.push({
      role: "user",
      content: message,
      timestamp: new Date(),
    });

    const response = await this.llm.chat({
      provider: "deepseek",
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      messages: session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: agent.temperature,
    });

    session.messages.push({
      role: "assistant",
      content: response.content,
      timestamp: new Date(),
    });

    return { reply: response.content, session };
  }

  /**
   * 获取会话记录
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取某 Agent 的历史调用记录
   */
  getCallHistory(agentName?: string): AgentCallRecord[] {
    if (agentName) {
      return this.callHistory.filter((r) => r.agentId === agentName);
    }
    return [...this.callHistory];
  }

  // ── 内部 ──

  private getOrCreateSession(agent: AgentDef, sessionId?: string): AgentSession {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing;
    }

    const session: AgentSession = {
      id: sessionId ?? `${agent.name}-${Date.now()}`,
      agentId: agent.name,
      projectId: "",
      messages: [
        {
          role: "system",
          content: agent.systemPrompt,
          timestamp: new Date(),
        },
      ],
      tokensUsed: 0,
      duration: 0,
      created: new Date(),
      updated: new Date(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  private async callTSAgent(
    agent: AgentDef,
    params: Record<string, unknown>,
    session: AgentSession,
  ): Promise<string> {
    const userMessage = buildUserMessage(agent, params);

    const response = await this.llm.chat({
      provider: "deepseek",
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      messages: [
        ...session.messages.slice(1).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: userMessage },
      ],
      temperature: agent.temperature,
    });

    return response.content;
  }
}

function buildUserMessage(agent: AgentDef, params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const input of agent.input) {
    const value = params[input.key];
    if (value !== undefined) {
      parts.push(`## ${input.label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
    }
  }
  return parts.join("\n\n");
}
