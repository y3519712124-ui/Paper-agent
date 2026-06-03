// ============================================================
// 共享黑板（Shared Context）
// 工作流执行中多智能体间的数据交换中心
// ============================================================

import type { ContextSlot } from "./types.js";

export type ContextChangeListener = (key: string, value: unknown, updatedBy: string) => void;

/**
 * 共享黑板
 * 工作流中所有 Agent 通过它读写数据
 * 支持写锁、版本号、变更订阅
 */
export class SharedContext {
  private slots: Map<string, ContextSlot> = new Map();
  private listeners: Set<ContextChangeListener> = new Set();
  private projectId: string;
  public workflowId: string;
  public startedAt: Date;
  public updatedAt: Date;

  constructor(projectId: string, workflowId: string) {
    this.projectId = projectId;
    this.workflowId = workflowId;
    this.startedAt = new Date();
    this.updatedAt = new Date();
  }

  // ── 读写接口 ──

  /**
   * 读取槽位值
   */
  get<T = unknown>(key: string): T | undefined {
    const slot = this.slots.get(key);
    return slot?.value as T | undefined;
  }

  /**
   * 写入槽位值（带可选写锁）
   * @returns 写入是否成功（被锁定时返回 false）
   */
  set<T>(key: string, value: T, agentId?: string): boolean {
    const existing = this.slots.get(key);

    // 写锁检查
    if (existing?.lockedBy && existing.lockedBy !== agentId) {
      return false;
    }

    const slot: ContextSlot = {
      key,
      value,
      updatedBy: agentId ?? "system",
      updatedAt: new Date(),
      lockedBy: existing?.lockedBy,
      version: (existing?.version ?? 0) + 1,
    };

    this.slots.set(key, slot);
    this.updatedAt = new Date();

    // 通知监听器
    for (const listener of this.listeners) {
      listener(key, value, agentId ?? "system");
    }

    return true;
  }

  /**
   * 获取整个槽位元数据
   */
  getSlot(key: string): ContextSlot | undefined {
    return this.slots.get(key);
  }

  /**
   * 锁定槽位（防止并发写入）
   */
  lock(key: string, agentId: string): boolean {
    const slot = this.slots.get(key);
    if (slot?.lockedBy) return false; // 已被锁定

    const existing = slot ?? {
      key,
      value: undefined,
      updatedBy: agentId,
      updatedAt: new Date(),
      version: 0,
    };

    existing.lockedBy = agentId;
    this.slots.set(key, existing);
    return true;
  }

  /**
   * 解锁槽位
   */
  unlock(key: string, agentId: string): boolean {
    const slot = this.slots.get(key);
    if (slot?.lockedBy !== agentId) return false;
    slot.lockedBy = undefined;
    return true;
  }

  /**
   * 检查槽位是否存在
   */
  has(key: string): boolean {
    return this.slots.has(key);
  }

  /**
   * 批量写入
   */
  setBatch(values: Record<string, unknown>, agentId?: string): void {
    for (const [key, value] of Object.entries(values)) {
      this.set(key, value, agentId);
    }
  }

  /**
   * 获取快照（所有数据）
   */
  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, slot] of this.slots) {
      result[key] = slot.value;
    }
    return result;
  }

  /**
   * 获取所有槽位元数据
   */
  allSlots(): ContextSlot[] {
    return Array.from(this.slots.values());
  }

  // ── 订阅 ──

  /**
   * 订阅变更
   */
  onChange(listener: ContextChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── 序列化 ──

  /**
   * 导出为可序列化对象（用于存储/回放）
   */
  toJSON(): Record<string, unknown> {
    return {
      projectId: this.projectId,
      workflowId: this.workflowId,
      startedAt: this.startedAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      slots: Array.from(this.slots.entries()).map(([key, slot]) => ({
        key,
        value: slot.value,
        updatedBy: slot.updatedBy,
        updatedAt: slot.updatedAt.toISOString(),
        lockedBy: slot.lockedBy,
        version: slot.version,
      })),
    };
  }

  /**
   * 从 JSON 恢复
   */
  static fromJSON(data: Record<string, unknown>): SharedContext {
    const ctx = new SharedContext(
      data.projectId as string,
      data.workflowId as string,
    );
    ctx.startedAt = new Date(data.startedAt as string);
    ctx.updatedAt = new Date(data.updatedAt as string);

    const slots = data.slots as Array<{
      key: string;
      value: unknown;
      updatedBy: string;
      updatedAt: string;
      lockedBy?: string;
      version: number;
    }>;
    for (const s of slots) {
      ctx.slots.set(s.key, {
        key: s.key,
        value: s.value,
        updatedBy: s.updatedBy,
        updatedAt: new Date(s.updatedAt),
        lockedBy: s.lockedBy,
        version: s.version,
      });
    }
    return ctx;
  }
}
