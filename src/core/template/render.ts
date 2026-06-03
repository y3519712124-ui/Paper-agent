// ============================================================
// 模板渲染器
// 将变量注入模板，生成各章节内容
// ============================================================

import type {
  TemplateDef,
  SectionContent,
  RenderedDoc,
  SectionDef,
} from "./types.js";

/** 渲染选项 */
export interface RenderOptions {
  preserveEmpty?: boolean;   // 保留空章节
  aiContent?: Record<string, string>; // AI 生成的内容（按 sectionId）
}

/**
 * 渲染完整文档
 */
export function renderTemplate(
  template: TemplateDef,
  variables: Record<string, unknown>,
  options: RenderOptions = {},
): RenderedDoc {
  const sections: SectionContent[] = [];
  const errors: string[] = [];

  for (const section of template.sections) {
    // ── 检查条件渲染 ──
    if (section.condition && !evaluateCondition(section.condition, variables)) {
      continue;
    }

    const aiContent = options.aiContent?.[section.id];

    // ── 判断内容来源优先级 ──
    // 1) AI 生成内容 2) 变量直接注入 3) 空
    let content: string | Record<string, unknown> | Record<string, unknown>[];

    if (aiContent) {
      content = aiContent;
    } else {
      content = resolveContent(section, variables);
    }

    const contentStr = typeof content === "string" ? content : JSON.stringify(content);
    const wordCount = countWords(contentStr);

    // ── 校验 ──
    const sectionErrors: string[] = [];
    if (section.required && !contentStr.trim()) {
      sectionErrors.push(`${section.title} 为必填章节`);
    }
    if (section.maxChars && wordCount > section.maxChars) {
      sectionErrors.push(`${section.title} 超出字数限制: ${wordCount}/${section.maxChars}`);
    }

    if (contentStr.trim() || options.preserveEmpty) {
      sections.push({
        sectionId: section.id,
        title: section.title,
        content,
        wordCount,
        valid: sectionErrors.length === 0,
        errors: sectionErrors.length > 0 ? sectionErrors : undefined,
      });
    }
  }

  const totalWords = sections.reduce((sum, s) => sum + s.wordCount, 0);

  return {
    templateId: template.id,
    templateName: template.name,
    sections,
    variables,
    constraints: template.constraints,
    totalWords,
    isValid: sections.every((s) => s.valid),
    errors,
  };
}

/**
 * 渲染为 Markdown 字符串
 */
export function renderToMarkdown(doc: RenderedDoc): string {
  const lines: string[] = [];

  lines.push(`# ${doc.variables["project.name"] ?? doc.templateName}`);
  lines.push("");
  lines.push(`> 生成于: ${new Date().toLocaleString("zh-CN")}`);
  lines.push(`> 模板: ${doc.templateName}`);
  lines.push("");

  for (const section of doc.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");

    const content = section.content;
    if (typeof content === "string") {
      lines.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "object" && item !== null) {
          lines.push(
            "| " +
              Object.values(item as Record<string, unknown>).join(" | ") +
              " |",
          );
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── 内部辅助 ──

function resolveContent(
  section: SectionDef,
  variables: Record<string, unknown>,
): string {
  // 查找变量路径：project.name → nested lookup
  const directKey = section.id.replace(/_/g, ".");
  const value = getNested(variables, directKey);

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join("\n");
  }
  return "";
}

function evaluateCondition(
  condition: { if: string; equals?: string; in?: string[] },
  variables: Record<string, unknown>,
): boolean {
  const actual = getNested(variables, condition.if);
  const actualStr = String(actual ?? "");

  if (condition.equals) return actualStr === condition.equals;
  if (condition.in) return condition.in.includes(actualStr);
  return true;
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function countWords(text: string): number {
  // 中文按字符数，英文按空格分词
  const clean = text.replace(/\s+/g, " ").trim();
  const chineseChars = (clean.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const englishWords = clean
    .replace(/[\u4e00-\u9fff]/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + englishWords;
}
