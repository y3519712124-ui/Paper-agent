// ============================================================
// 约束检查器
// 校验渲染结果是否符合模板格式/字数/页数约束
// ============================================================

import type { RenderedDoc, TemplateConstraints, SectionContent } from "./types.js";

export interface ConstraintViolation {
  type: "page_limit" | "word_limit" | "section_word_limit" | "section_missing" | "min_items" | "max_items";
  sectionId?: string;
  sectionTitle?: string;
  message: string;
  actual: number;
  limit: number;
  severity: "error" | "warning";
}

/**
 * 检查文档是否满足模板约束
 */
export function checkConstraints(doc: RenderedDoc): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const c = doc.constraints;

  // ── 总字数检查 ──
  if (c.maxChars && doc.totalWords > c.maxChars) {
    violations.push({
      type: "word_limit",
      message: `总字数 ${doc.totalWords} 超出限制 ${c.maxChars}`,
      actual: doc.totalWords,
      limit: c.maxChars,
      severity: "error",
    });
  }

  // ── 页数估算检查 ──
  const estimatedPages = estimatePages(doc.totalWords, c);
  if (estimatedPages > c.maxPages) {
    violations.push({
      type: "page_limit",
      message: `预估页数 ${estimatedPages} 超出最大页数 ${c.maxPages}`,
      actual: estimatedPages,
      limit: c.maxPages,
      severity: "error",
    });
  }

  // ── 逐章节检查 ──
  for (const section of doc.sections) {
    checkSectionConstraints(section, violations);
  }

  return violations;
}

/**
 * 估算页数
 */
export function estimatePages(totalWords: number, constraints: TemplateConstraints): number {
  const marginWidth = constraints.margins[1] + constraints.margins[3]; // 左右
  const marginHeight = constraints.margins[0] + constraints.margins[2]; // 上下
  const pageWidthCm = 21.0 - marginWidth;  // A4 宽 21cm
  const pageHeightCm = 29.7 - marginHeight; // A4 高 29.7cm

  // 估算每页字数（取决于行距和字号）
  const bodySizePt = parseFloat(constraints.bodySize);
  const linesPerPage = Math.floor((pageHeightCm / 2.54) * 72 / (bodySizePt * constraints.lineSpacing));
  const charsPerLine = Math.floor((pageWidthCm / 2.54) * 72 / (bodySizePt * 0.6));
  const charsPerPage = linesPerPage * charsPerLine;

  return Math.ceil(totalWords / charsPerPage);
}

/**
 * 生成格式合规报告（用户可直接查看）
 */
export function formatReport(doc: RenderedDoc, violations: ConstraintViolation[]): string {
  const lines: string[] = [];
  lines.push(`# 格式合规检查报告`);
  lines.push(`模板: ${doc.templateName}`);
  lines.push(`总字数: ${doc.totalWords}`);
  lines.push(`预估页数: ${estimatePages(doc.totalWords, doc.constraints)}/${doc.constraints.maxPages}`);
  lines.push(`状态: ${violations.length === 0 ? "✅ 通过" : `❌ ${violations.length} 个问题`}`);
  lines.push("");

  if (violations.length > 0) {
    lines.push("## 发现的问题");
    for (const v of violations) {
      const icon = v.severity === "error" ? "❌" : "⚠️";
      lines.push(`${icon} [${v.sectionTitle ?? "全局"}] ${v.message}`);
    }
  }

  lines.push("");
  lines.push("## 章节详情");
  for (const s of doc.sections) {
    const status = s.valid ? "✅" : "❌";
    lines.push(`${status} ${s.title}: ${s.wordCount}字${s.errors?.length ? ` (${s.errors.join("; ")})` : ""}`);
  }

  return lines.join("\n");
}

// ── 内部 ──

function checkSectionConstraints(
  section: SectionContent,
  violations: ConstraintViolation[],
): void {
  // 字数上限
  // （运行时需要拿到最大字数，可通过外部传入）

  // 必填
  if (section.errors) {
    for (const err of section.errors) {
      violations.push({
        type: "section_missing",
        sectionId: section.sectionId,
        sectionTitle: section.title,
        message: err,
        actual: 0,
        limit: 0,
        severity: "error",
      });
    }
  }
}
