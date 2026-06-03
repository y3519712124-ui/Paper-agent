// ============================================================
// 模板解析器
// 从 YAML 文件加载并校验模板定义
// ============================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  TemplateDef,
  TemplateMeta,
  SectionDef,
  TemplateConstraints,
  TemplateVariable,
} from "./types.js";

/**
 * 从 YAML 文件加载模板
 */
export function loadTemplate(filePath: string): TemplateDef {
  if (!existsSync(filePath)) {
    throw new Error(`模板文件不存在: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as Partial<TemplateDef>;

  // ── 校验必填字段 ──
  const required: (keyof TemplateDef)[] = [
    "name", "id", "competition", "constraints", "sections",
  ];
  for (const field of required) {
    if (!parsed[field]) {
      throw new Error(`模板 ${filePath} 缺少必填字段: ${field}`);
    }
  }

  // ── 注入默认值 ──
  const template: TemplateDef = {
    name: parsed.name!,
    id: parsed.id!,
    competition: parsed.competition!,
    track: parsed.track ?? "",
    description: parsed.description ?? "",
    version: parsed.version ?? "1.0",
    constraints: normalizeConstraints(parsed.constraints!),
    sections: parsed.sections!.map(normalizeSection),
    variables: (parsed.variables ?? []).map(normalizeVariable),
  };

  // ── 校验章节 ID 唯一性 ──
  const ids = template.sections.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(`模板 ${filePath} 存在重复的章节 ID: ${dupes.join(", ")}`);
  }

  return template;
}

/**
 * 扫描目录下所有模板
 */
export function scanTemplates(templateDir: string): TemplateMeta[] {
  if (!existsSync(templateDir)) return [];

  const entries = readdirSync(templateDir, { recursive: true });

  return entries
    .filter((e) => typeof e === "string" && e.endsWith(".yaml"))
    .map((file) => {
      const fullPath = join(templateDir, file);
      try {
        const tpl = loadTemplate(fullPath);
        return {
          id: tpl.id,
          name: tpl.name,
          competition: tpl.competition,
          track: tpl.track,
          description: tpl.description,
          version: tpl.version,
          isBuiltin: true,
          filePath: fullPath,
        };
      } catch {
        return null;
      }
    })
    .filter((m): m is TemplateMeta => m !== null);
}

/**
 * 通过 ID 查找模板
 */
export function findTemplateById(
  templateDir: string,
  templateId: string,
): TemplateDef | null {
  const all = scanTemplates(templateDir);
  const meta = all.find((m) => m.id === templateId || basename(m.filePath ?? "", extname(m.filePath ?? "")) === templateId);
  if (!meta?.filePath) return null;
  return loadTemplate(meta.filePath);
}

/**
 * 获取模板的纯文本描述（用于 LLM 上下文）
 */
export function templateToDescription(template: TemplateDef): string {
  const sections = template.sections
    .map((s) => {
      let desc = `- ${s.title} (${s.type})`;
      if (s.maxChars) desc += ` 上限${s.maxChars}字`;
      if (s.required) desc += " [必填]";
      if (s.type === "image" && s.images) {
        desc += ` [图片: ${s.images.map((i) => i.label).join(", ")}]`;
      }
      return desc;
    })
    .join("\n");

  return `## 模板: ${template.name}\n${template.description}\n\n### 章节结构\n${sections}\n\n### 约束\n- 最大页数: ${template.constraints.maxPages}\n- 正文字体: ${template.constraints.font} ${template.constraints.bodySize}\n- 行距: ${template.constraints.lineSpacing}`;
}

// ── 内部辅助 ──

function normalizeConstraints(raw: Partial<TemplateConstraints>): TemplateConstraints {
  return {
    maxPages: raw.maxPages ?? 10,
    maxChars: raw.maxChars,
    font: raw.font ?? "宋体",
    headingFont: raw.headingFont ?? "黑体",
    bodySize: raw.bodySize ?? "12pt",
    headingSize: raw.headingSize ?? "14pt",
    lineSpacing: raw.lineSpacing ?? 1.5,
    margins: raw.margins ?? [2.5, 2.0, 2.5, 2.0],
  };
}

function normalizeSection(raw: Partial<SectionDef> & { id: string; title: string; type: string }): SectionDef {
  return {
    ...raw,
    type: raw.type as SectionDef["type"],
    required: raw.required ?? false,
    maxLength: raw.maxLength,
    maxChars: raw.maxChars,
    maxCharsPerItem: raw.maxCharsPerItem,
    minItems: raw.minItems,
    maxItems: raw.maxItems,
    minRows: raw.minRows,
    maxRows: raw.maxRows,
    fields: raw.fields,
    tables: raw.tables,
    columns: raw.columns,
    footer: raw.footer,
    defaultRows: raw.defaultRows,
    defaultMonths: raw.defaultMonths,
    images: raw.images,
    imagePlaceholder: raw.imagePlaceholder,
    imageCaptionTemplate: raw.imageCaptionTemplate,
    aiPrompt: raw.aiPrompt,
    condition: raw.condition,
  };
}

function normalizeVariable(raw: Partial<TemplateVariable> & { name: string; label: string; type: string }): TemplateVariable {
  return {
    name: raw.name,
    label: raw.label,
    type: raw.type,
    maxLength: raw.maxLength,
    maxItems: raw.maxItems,
    required: raw.required ?? false,
    options: raw.options,
    unit: raw.unit,
    default: raw.default,
  };
}
