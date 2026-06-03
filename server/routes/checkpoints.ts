// ============================================================
// API — Checkpoint 断点续跑
// ============================================================

import { Router } from "express";
import { checkpointStore } from "../checkpoint-store.js";

export const checkpointsRouter = Router();

// ── 获取某个工作流的所有 checkpoint ──
checkpointsRouter.get("/:workflowId", (req, res) => {
  const checkpoints = checkpointStore.getWorkflowCheckpoints(req.params.workflowId);
  res.json(checkpoints);
});

// ── 获取最后完成的 checkpoint（用于恢复） ──
checkpointsRouter.get("/:workflowId/last", (req, res) => {
  const last = checkpointStore.getLastCompleted(req.params.workflowId);
  if (!last) return res.json(null);
  res.json(last);
});

// ── 清除 checkpoint ──
checkpointsRouter.delete("/:workflowId", (req, res) => {
  checkpointStore.clear(req.params.workflowId);
  res.json({ success: true });
});

// ── 列出所有有 checkpoint 的工作流 ──
checkpointsRouter.get("/", (_req, res) => {
  res.json(checkpointStore.listWorkflows());
});

// ── 恢复工作流 ──
checkpointsRouter.post("/:workflowId/resume", async (req, res) => {
  const last = checkpointStore.getLastCompleted(req.params.workflowId);
  if (!last) return res.status(404).json({ error: "无可恢复的 checkpoint" });
  res.json({
    success: true,
    resumeFrom: last.stepName,
    stepIndex: last.stepIndex,
    canResume: true,
  });
});
