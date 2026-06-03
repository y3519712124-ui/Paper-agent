// ============================================================
// API — 导出
// ============================================================

import { Router } from "express";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const exportRouter = Router();

// ── 导出 Markdown ──
exportRouter.post("/markdown", (req, res) => {
  const { content, projectName } = req.body;
  if (!content) return res.status(400).json({ error: "缺少内容" });

  const outDir = join(homedir(), ".paper", "exports");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const fileName = `${projectName || "export"}-${Date.now()}.md`;
  const filePath = join(outDir, fileName);
  writeFileSync(filePath, content, "utf-8");

  res.json({ success: true, filePath, fileName });
});

// ── 获取导出历史 ──
exportRouter.get("/history", (_req, res) => {
  const outDir = join(homedir(), ".paper", "exports");
  if (!existsSync(outDir)) return res.json([]);
  const fs = require("node:fs");
  const files = fs.readdirSync(outDir).map((f: string) => ({
    name: f,
    path: join(outDir, f),
    size: fs.statSync(join(outDir, f)).size,
    time: fs.statSync(join(outDir, f)).mtime,
  }));
  res.json(files);
});
