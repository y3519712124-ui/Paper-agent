// ============================================================
// 默认路径配置
// ============================================================

import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_ROOT = process.env.PAPER_PROJECT_ROOT || process.cwd();

/** 模板目录 */
export const TEMPLATE_DIR = process.env.PAPER_TEMPLATE_DIR || join(PROJECT_ROOT, "templates");

/** 内置 Agent 目录 */
export const AGENTS_DIR = join(PROJECT_ROOT, "agents");

/** 团队预设目录 */
export const TEAMS_DIR = join(PROJECT_ROOT, "teams");

/** 用户项目根目录 */
export const PROJECTS_DIR = join(homedir(), ".paper", "projects");

/** Python 模块目录 */
export const PYTHON_DIR = process.env.PYTHONPATH || join(PROJECT_ROOT, "python");

/** 默认 LLM 配置 */
export const DEFAULT_LLM_CONFIG = {
  provider: "deepseek" as const,
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  temperature: 0.7,
};

/** 默认导出目录 */
export const DEFAULT_EXPORT_DIR = join(homedir(), ".paper", "exports");
