# agents/ — 状态说明

> 详见 `docs/architecture.md` §2。

本目录是 agent 定义（YAML），被前端 UI 和 `src/cli` 引用展示。

**重要**：服务端生成路径（`server/routes/workflows.ts`）**当前不加载这些 YAML**。所谓"多智能体"在产品路径里由 `workflows.ts` 内部的 `COMPLETE_PROJECT_BOOK_STEPS` 等硬编码步骤定义驱动，而非本目录。

这里保留的定义是 CLI / 展示用途，Phase 1 计划让服务端真正按这些定义调度 agent。
