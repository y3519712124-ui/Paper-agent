// ============================================================
// API — 项目管理
// ============================================================

import { Router } from "express";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const projectsRouter = Router();

const PROJECTS_DIR = join(homedir(), ".paper", "projects");
const TEMPLATE_DIR = join(process.cwd(), "templates");

// ── 创建项目 ──
projectsRouter.post("/", (req, res) => {
  const { name, template, competition } = req.body;
  if (!name) return res.status(400).json({ error: "缺少项目名称" });

  const projectDir = join(PROJECTS_DIR, name);
  if (existsSync(projectDir)) return res.status(409).json({ error: "项目已存在" });

  const paperDir = join(projectDir, ".paper");
  mkdirSync(join(paperDir, "drafts"), { recursive: true });

  const config = {
    name,
    template: template || "dachuang-innovation-training",
    competition: competition || "dachuang",
    variables: {},
    team: [],
    advisor: {},
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  writeFileSync(join(paperDir, "project.yaml"), stringifyYaml(config), "utf-8");
  res.json({ success: true, id: name, ...config });
});

// ── 获取所有项目 ──
projectsRouter.get("/", (_req, res) => {
  if (!existsSync(PROJECTS_DIR)) return res.json([]);

  const projects = readdirSync(PROJECTS_DIR).map((name) => {
    const configPath = join(PROJECTS_DIR, name, ".paper", "project.yaml");
    let info: Record<string, unknown> = { name };
    if (existsSync(configPath)) {
      try {
        info = { ...info, ...(parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>) };
      } catch { /* */ }
    }
    // 查草稿
    const draftsDir = join(PROJECTS_DIR, name, ".paper", "drafts");
    const drafts = existsSync(draftsDir) ? readdirSync(draftsDir).filter((f) => f.endsWith(".md")) : [];
    return { id: name, ...info, draftCount: drafts.length };
  });

  res.json(projects);
});

// ── 获取单个项目 ──
projectsRouter.get("/:id", (req, res) => {
  const projectDir = join(PROJECTS_DIR, req.params.id);
  if (!existsSync(projectDir)) return res.status(404).json({ error: "项目不存在" });

  const configPath = join(projectDir, ".paper", "project.yaml");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }

  // 读取草稿
  const draftsDir = join(projectDir, ".paper", "drafts");
  let drafts: Array<{ name: string; content: string }> = [];
  if (existsSync(draftsDir)) {
    drafts = readdirSync(draftsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        content: readFileSync(join(draftsDir, f), "utf-8"),
      }));
  }

  // 读取模板
  let template: Record<string, unknown> | null = null;
  const templateId = (config.template as string) || "";
  const templatePath = join(TEMPLATE_DIR, templateId.split("-")[0] || "dachuang", `${templateId}.yaml`);
  if (existsSync(templatePath)) {
    template = parseYaml(readFileSync(templatePath, "utf-8")) as Record<string, unknown>;
  }

  res.json({ id: req.params.id, config, template, drafts });
});

// ── 更新项目变量 ──
projectsRouter.put("/:id", (req, res) => {
  const projectDir = join(PROJECTS_DIR, req.params.id);
  if (!existsSync(projectDir)) return res.status(404).json({ error: "项目不存在" });

  const configPath = join(projectDir, ".paper", "project.yaml");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }

  const { variables, team, advisor } = req.body;
  if (variables) config.variables = variables;
  if (team) config.team = team;
  if (advisor) config.advisor = advisor;

  config.updated = new Date().toISOString();
  writeFileSync(configPath, stringifyYaml(config), "utf-8");
  res.json({ success: true });
});

// ── 旧版三步生成入口已废弃 ──
projectsRouter.post("/:id/generate", (req, res) => {
  const projectDir = join(PROJECTS_DIR, req.params.id);
  if (!existsSync(projectDir)) return res.status(404).json({ error: "项目不存在" });

  res.status(410).json({
    success: false,
    error: "旧版三步项目书生成入口已停用。请使用完整工作流生成，避免产生空壳稿或跨项目套壳内容。",
    replacement: {
      start: `/api/workflows/${encodeURIComponent(req.params.id)}/start`,
      deliver: `/api/workflows/${encodeURIComponent(req.params.id)}/deliver`,
      export: `/api/workflows/${encodeURIComponent(req.params.id)}/export`,
    },
  });
});

// ── 删除项目 ──
projectsRouter.delete("/:id", (req, res) => {
  const projectDir = join(PROJECTS_DIR, req.params.id);
  if (!existsSync(projectDir)) return res.status(404).json({ error: "项目不存在" });
  rmSync(projectDir, { recursive: true, force: true });
  res.json({ success: true, message: `项目已删除: ${req.params.id}` });
});

// ── 保存草稿 ──
projectsRouter.post("/:id/draft", (req, res) => {
  const projectDir = join(PROJECTS_DIR, req.params.id);
  const draftsDir = join(projectDir, ".paper", "drafts");
  if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true });

  const { content, name } = req.body;
  const fileName = name || `draft-${Date.now()}.md`;
  writeFileSync(join(draftsDir, fileName), content, "utf-8");
  res.json({ success: true, file: fileName });
});
