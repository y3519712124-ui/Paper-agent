// ============================================================
// paper init — 创建新项目
// ============================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTemplateById, loadTemplate } from "../../core/template/parser.js";
import { TEMPLATE_DIR, PROJECTS_DIR } from "../../config/defaults.js";

interface InitOptions {
  template: string;
  competition: string;
}

export async function initProject(
  name: string,
  options: InitOptions,
): Promise<void> {
  const projectDir = join(PROJECTS_DIR, name);
  const paperDir = join(projectDir, ".paper");

  if (existsSync(projectDir)) {
    console.error(`❌ 项目 "${name}" 已存在`);
    process.exit(1);
  }

  // ── 查找模板 ──
  const template = findTemplateById(TEMPLATE_DIR, options.template);
  if (!template) {
    console.error(`❌ 模板 "${options.template}" 未找到`);
    console.error(`   可用模板: paper template list`);
    process.exit(1);
  }

  // ── 创建目录 ──
  mkdirSync(paperDir, { recursive: true });
  mkdirSync(join(paperDir, "drafts"), { recursive: true });
  mkdirSync(join(paperDir, "sessions"), { recursive: true });

  // ── 写入项目配置 ──
  const projectConfig = {
    name,
    template: template.id,
    competition: template.competition,
    track: template.track,
    variables: {},
    team: [],
    advisor: {},
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  writeFileSync(
    join(paperDir, "project.yaml"),
    yamlStringify(projectConfig),
    "utf-8",
  );

  // ── 写入默认配置 ──
  const userConfig = {
    llm: {
      provider: "deepseek",
      model: "deepseek-chat",
    },
    templates: {
      default: options.template,
    },
  };

  writeFileSync(
    join(paperDir, "config.yaml"),
    yamlStringify(userConfig),
    "utf-8",
  );

  // ── 输出模板变量清单 ──
  const varList = template.variables
    .map((v) => `  ${v.name} (${v.label})${v.required ? " [必填]" : ""}`)
    .join("\n");

  console.log(`✅ 项目 "${name}" 创建成功`);
  console.log(`   目录: ${projectDir}`);
  console.log(`   模板: ${template.name}`);
  console.log(`   赛事: ${template.competition}`);
  console.log(``);
  console.log(`下一步:`);
  console.log(`  1. 填写项目信息: 编辑 .paper/project.yaml`);
  console.log(`  2. 查看变量: paper config show`);
  console.log(`  3. 生成申报书: paper generate`);
}

function yamlStringify(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      lines.push(yamlStringify(value as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      for (const item of value) {
        if (typeof item === "object") {
          lines.push(`${pad}-`);
          lines.push(yamlStringify(item as Record<string, unknown>, indent + 2));
        } else {
          lines.push(`${pad}- ${item}`);
        }
      }
    } else if (typeof value === "string") {
      lines.push(`${pad}${key}: "${value}"`);
    } else {
      lines.push(`${pad}${key}: ${value}`);
    }
  }
  return lines.join("\n");
}
