// ============================================================
// TS ↔ Python 子进程桥
// 管理 Python 子进程生命周期 + JSON-RPC 通信
// ============================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BridgeMessage,
  BridgeMethodCall,
  BridgeStatus,
  BridgeStats,
  PythonBridgeConfig,
} from "./types.js";

const DEFAULT_CONFIG: PythonBridgeConfig = {
  pythonPath: "python",
  modulePath: "",
  startupTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  maxRestarts: 3,
};

export class PythonBridge {
  private config: PythonBridgeConfig;
  private process: ChildProcess | null = null;
  private status: BridgeStatus = "disconnected";
  private pendingRequests: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private nextMessageId = 1;
  private restartCount = 0;
  private totalCalls = 0;
  private failedCalls = 0;
  private totalLatency = 0;

  constructor(config?: Partial<PythonBridgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动 Python 子进程
   */
  async start(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;

    this.status = "connecting";

    // 构建 Python 模块路径
    const modulePath =
      this.config.modulePath ||
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "python");

    const pythonProcess = spawn(this.config.pythonPath, ["-m", "paper_agent"], {
      cwd: modulePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    this.process = pythonProcess;

    // ── 处理 stdout（接收响应） ──
    const rl = createInterface({ input: pythonProcess.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as BridgeMessage;
        this.handleMessage(msg);
      } catch {
        // 非 JSON 行（print 日志），忽略
      }
    });

    // ── 处理 stderr ──
    pythonProcess.stderr?.on("data", (data: Buffer) => {
      // Python 日志
    });

    // ── 等待就绪信号 ──
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Python 子进程启动超时"));
      }, this.config.startupTimeoutMs);

      pythonProcess.stdout?.once("data", () => {
        clearTimeout(timer);
        this.status = "connected";
        resolve();
      });

      pythonProcess.on("error", (err) => {
        clearTimeout(timer);
        this.status = "error";
        reject(err);
      });

      pythonProcess.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) {
          this.status = "error";
          reject(new Error(`Python 进程异常退出，code=${code}`));
        }
      });
    });
  }

  /**
   * 调用 Python Agent 方法
   */
  async call(call: BridgeMethodCall): Promise<unknown> {
    if (this.status !== "connected") {
      await this.start();
    }

    const messageId = `msg-${this.nextMessageId++}`;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        this.failedCalls++;
        reject(new Error(`请求超时: ${call.agent}.${call.method}`));
      }, call.timeoutMs ?? this.config.requestTimeoutMs);

      this.pendingRequests.set(messageId, { resolve, reject, timer });

      const message: BridgeMessage = {
        type: "call",
        messageId,
        agent: call.agent,
        method: call.method,
        params: call.params,
        timestamp: new Date().toISOString(),
      };

      this.totalCalls++;
      this.send(message);

      const latency = Date.now() - startTime;
      this.totalLatency += latency;
    });
  }

  /**
   * 发送 ping
   */
  async ping(): Promise<boolean> {
    try {
      await this.call({
        agent: "system",
        method: "ping",
        params: {},
        timeoutMs: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取桥状态统计
   */
  getStats(): BridgeStats {
    return {
      status: this.status,
      callsTotal: this.totalCalls,
      callsFailed: this.failedCalls,
      averageLatencyMs:
        this.totalCalls > 0
          ? Math.round(this.totalLatency / this.totalCalls)
          : 0,
      uptimeMs: 0,
      pythonVersion: "",
    };
  }

  /**
   * 优雅关闭
   */
  async shutdown(): Promise<void> {
    if (!this.process || this.status === "disconnected") return;

    try {
      await this.call({
        agent: "system",
        method: "shutdown",
        params: {},
        timeoutMs: 2000,
      });
    } catch {
      // 忽略关闭时的错误
    }

    this.process.kill("SIGTERM");
    setTimeout(() => this.process?.kill("SIGKILL"), 2000);
    this.status = "shutdown";
  }

  // ── 内部 ──

  private send(message: BridgeMessage): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(message) + "\n");
    }
  }

  private handleMessage(msg: BridgeMessage): void {
    if (msg.type === "response" || msg.type === "error") {
      const pending = this.pendingRequests.get(msg.messageId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.messageId);

        if (msg.type === "error") {
          this.failedCalls++;
          pending.reject(new Error(msg.error ?? "未知错误"));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }
}
