// ============================================================
// 默认路径配置
// ============================================================

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

/** 模板目录 */
export const TEMPLATE_DIR = join(PROJECT_ROOT, "templates");

/** 内置 Agent 目录 */
export const AGENTS_DIR = join(PROJECT_ROOT, "agents");

/** 团队预设目录 */
export const TEAMS_DIR = join(PROJECT_ROOT, "teams");

/** 用户项目根目录 */
export const PROJECTS_DIR = join(homedir(), ".paper", "projects");

/** Python 模块目录 */
export const PYTHON_DIR = join(PROJECT_ROOT, "python");

/** 默认 LLM 配置 */
export const DEFAULT_LLM_CONFIG = {
  provider: "deepseek" as const,
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  temperature: 0.7,
};

/** 默认导出目录 */
export const DEFAULT_EXPORT_DIR = join(homedir(), ".paper", "exports");
