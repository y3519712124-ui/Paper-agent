// ============================================================
// Paper-agent API Server
// Express.js — 提供 REST API 给前端
// ============================================================

import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer } from "ws";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { projectsRouter } from "./routes/projects.js";
import { agentRouter } from "./routes/agent.js";
import { exportRouter } from "./routes/export.js";
import { checkpointsRouter } from "./routes/checkpoints.js";
import { settingsRouter } from "./routes/settings.js";
import { workflowsRouter, WORKFLOW_TEMPLATES } from "./routes/workflows.js";

// ── WebSocket 广播 ──
export function broadcast(event: string, data: Record<string, unknown>) {
  const msg = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

const PORT = process.env.PORT || 3456;

function firstExistingPath(paths: string[]) {
  return paths.find((candidate) => existsSync(candidate));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── WebSocket 服务 ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ event: "connected", data: { message: "Paper-agent WebSocket 已连接" } }));
});

// ── API 路由 ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "Paper-agent", desktop: false });
});
app.get("/api/templates", (_req, res) => {
  res.json(WORKFLOW_TEMPLATES);
});
app.use("/api/settings", settingsRouter);
app.use("/api/workflows", workflowsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/agent", agentRouter);
app.use("/api/export", exportRouter);
app.use("/api/checkpoints", checkpointsRouter);

// ── API 404 错误处理 ──
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API 端点不存在" });
});

// ── 静态文件（前端构建产物） ──
const frontendDist = firstExistingPath([
  process.env.PAPER_FRONTEND_DIST || "",
  join(process.cwd(), "frontend", "dist"),
  join(process.cwd(), "..", "frontend", "dist"),
]);
if (frontendDist && existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback
  const indexPath = join(frontendDist, "index.html");
  if (existsSync(indexPath)) {
    app.use((_req, res) => {
      res.sendFile(indexPath);
    });
  }
}

// ── 启动 ──
server.listen(PORT, () => {
  console.log(`\n  🧠 Paper-agent Server`);
  console.log(`  ─────────────────────`);
  console.log(`  API:  http://localhost:${PORT}/api`);
  console.log(`  Web:  http://localhost:${PORT}`);
  console.log(`  ─────────────────────\n`);
});
