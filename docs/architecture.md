# Paper-agent 架构说明（实情版）

> 本文档由 Phase 0 升级（止血与去伪）补充，目的是如实记录"代码里写了什么"与"实际运行的是哪条路径"，避免后续维护者被表面的"多智能体架构"误导。批判与完整背景见 `docs/upgrade-critique.md`。

## 1. 两条并行的代码路径

Paper-agent 仓库里存在**两套互不相通的运行路径**，这是当前最大的架构混淆点：

| 路径 | 入口 | 是否打包进桌面/Web 产品 | 是否有单测 |
| --- | --- | --- | --- |
| **A. 服务端生成路径（实际产品）** | `server/index.ts` → `server/routes/workflows.ts` | 是（`desktop/main.cjs` 启动 `server-dist/index.cjs`） | 否（无单测，仅 smoke 端到端） |
| **B. CLI 路径（次要/历史）** | `src/cli/index.ts` → `dist/index.js` | 否（桌面端不启动 CLI） | 是（`tests/core/*`） |

**关键事实**：`desktop/main.cjs:28` 启动的是服务端 `server-dist/index.cjs`，而不是 CLI。`tests/core/*.test.ts`（如 `SharedContext` 读写锁测试）测的是路径 B 的 `src/core/**`，而路径 B 的代码**不被服务端导入**。

即：**绿色的单元测试覆盖的是产品不使用的那条路径**。这是"测试在自欺"问题的根源之一。

## 2. 路径 A（服务端）的真实组成

服务端生成全部集中在一个文件里：

- `server/routes/workflows.ts`（约 10000 行）—— 承担了 profile 推断、LLM 调用、联网检索、LaTeX 编译、质量评分、导出调度等几乎所有职责。
- `server/routes/*.ts` —— 其余路由（projects / settings / agent / export / checkpoints）。

服务端**不 import** `src/core/**`、`src/cli/**`、`agents/*.yaml`、`teams/*.yaml`。因此：

- `src/core/workflow/engine.ts`（WorkflowEngine）、`src/core/agent/registry.ts`、`src/core/llm/adapter.ts` 在产品路径里是**死代码**。
- `agents/*.yaml`、`teams/*.yaml` 被前端/CLI 引用展示，但服务端生成不加载它们。所谓"多智能体"在产品路径里并未真正调度。

## 3. 路径 B（CLI）的真实组成

- `src/cli/index.ts`（Commander）+ `src/cli/commands/*.ts` —— 真正 import `src/core/**`。
- `src/core/**` —— 一套独立的 agent registry / runtime / workflow engine / llm adapter / template / export。
- `tests/core/*.test.ts` —— 测的就是这套 core。

CLI 是一个合法的（但当前非主力、未随桌面包分发）入口。**不要删除 `src/core`**，否则会破坏 CLI 与其单测。

## 4. Phase 0.2 处理动作

本次（Phase 0.2）不删除任何代码，只做**如实标注与隔离**，防止误导：

1. **本文件**说明双路径，明确哪条是产品路径。
2. 在 `src/core/**` 与 `agents/`、`teams/` 顶部说明其当前未被服务端使用（见各目录说明）。
3. smoke 测试已改为端到端（跑路径 A 的真实生成），不再用源码字符串匹配来自证（见 `scripts/smoke-generation-guards.mjs` 顶部注释）。

## 5. 后续重构方向（Phase 1）

理想终态是：**让服务端路径 A 真正复用 `src/core` 的模块化能力**，从而消除双路径。即把 `workflows.ts` 的万行逻辑拆成 `prompt/`、`pipeline/`、`quality/` 等模块，并让 `src/core/agent/runtime` 真正驱动 writer→reviewer→polisher 循环。届时本文件的双路径说明可删除，单测也将测到产品路径。
