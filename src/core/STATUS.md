# src/core — 状态说明

> 详见 `docs/architecture.md` §2/§3。

本目录是一套**独立的 agent / workflow / llm / template / export 模块**，被 `src/cli/**`（CLI 入口）import，并由 `tests/core/*.test.ts` 覆盖。

**重要**：本目录**当前不被服务端**（`server/routes/workflows.ts`，即桌面/Web 产品的实际生成路径）import。因此：

- 这里的 `WorkflowEngine`、`AgentRegistry`、`LLMService` 等在产品路径里**未生效**。
- `tests/core` 的绿色单测覆盖的是 CLI 路径，不是产品路径。

不要据此认为产品已经在用"多智能体引擎"。Phase 1 的目标是让服务端真正复用本目录，届时删除本说明。
