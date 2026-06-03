// ============================================================
// Checkpoint 存储 — 断点续跑
// 每个工作流按 step 保存执行状态
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Checkpoint {
  id: string;            // checkpoint 唯一 ID
  workflowId: string;    // 所属工作流
  stepName: string;      // 当前完成的步骤名
  stepIndex: number;     // 步骤序号
  status: "running" | "completed" | "failed";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
  artifactPaths?: string[];  // 本步骤生成的文件
}

const CHECKPOINT_DIR = join(homedir(), ".paper", "checkpoints");

export class CheckpointStore {
  private ensureDir() {
    if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }

  private filePath(workflowId: string): string {
    return join(CHECKPOINT_DIR, `${workflowId}.json`);
  }

  /**
   * 保存一个 checkpoint
   */
  save(checkpoint: Checkpoint): void {
    this.ensureDir();
    const path = this.filePath(checkpoint.workflowId);
    let checkpoints: Checkpoint[] = [];
    if (existsSync(path)) {
      try {
        checkpoints = JSON.parse(readFileSync(path, "utf-8"));
      } catch { /* */ }
    }
    // 替换同步骤的旧 checkpoint
    const idx = checkpoints.findIndex(c => c.stepName === checkpoint.stepName);
    if (idx >= 0) {
      checkpoints[idx] = checkpoint;
    } else {
      checkpoints.push(checkpoint);
    }
    writeFileSync(path, JSON.stringify(checkpoints, null, 2), "utf-8");
  }

  /**
   * 获取某个工作流的所有 checkpoint
   */
  getWorkflowCheckpoints(workflowId: string): Checkpoint[] {
    const path = this.filePath(workflowId);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch { return []; }
  }

  /**
   * 获取最后完成的 checkpoint（用于恢复）
   */
  getLastCompleted(workflowId: string): Checkpoint | null {
    const all = this.getWorkflowCheckpoints(workflowId);
    const completed = all.filter(c => c.status === "completed").sort((a, b) => b.stepIndex - a.stepIndex);
    return completed[0] ?? null;
  }

  /**
   * 获取下一个要执行的步骤序号
   */
  getNextStepIndex(workflowId: string): number {
    const last = this.getLastCompleted(workflowId);
    return last ? last.stepIndex + 1 : 0;
  }

  /**
   * 列出所有有 checkpoint 的工作流
   */
  listWorkflows(): string[] {
    this.ensureDir();
    return readdirSync(CHECKPOINT_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  }

  /**
   * 清除某个工作流的所有 checkpoint
   */
  clear(workflowId: string): void {
    const path = this.filePath(workflowId);
    if (existsSync(path)) {
      writeFileSync(path, JSON.stringify([], null, 2), "utf-8");
    }
  }
}

export const checkpointStore = new CheckpointStore();
