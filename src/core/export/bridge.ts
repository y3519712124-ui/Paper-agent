// ============================================================
// 导出桥 → Python (docx 精确生成)
// TS 生成中间数据，Python 处理最终 docx
// ============================================================

import type { RenderedDoc } from "../template/types.js";
import type { StyleMapping, DocxTemplateRef } from "./types.js";

/**
 * 构建 docx 导出所需的中间数据
 * 这个结构会被序列化后传递给 Python 的 docx 生成器
 */
export interface DocxJobData {
  type: "export_docx";
  jobId: string;

  // 文档元数据
  templateName: string;
  competition: string;

  // 格式约束
  constraints: {
    font: string;
    headingFont: string;
    bodySize: string;
    headingSize: string;
    lineSpacing: number;
    margins: [number, number, number, number];
  };

  // 章节内容
  sections: Array<{
    id: string;
    title: string;
    type: string;
    content: string | Record<string, unknown> | Record<string, unknown>[];
  }>;

  // 图片数据
  images?: Array<{
    id: string;                // 图片标识
    sectionId: string;         // 所属章节
    label: string;             // 图注
    filePath: string;          // 图片文件路径
    imageData?: string;        // base64 编码（替代 filePath）
    maxWidth?: string;         // 最大宽度 e.g. "14cm"
    maxHeight?: string;
    position?: "center" | "left" | "right";
  }>;

  // 样式映射
  styleMap?: StyleMapping[];

  // 参考模板（Pandoc）
  referenceDocx?: string;
}

/**
 * 将 RenderedDoc 转换为 DocxJobData
 */
export function prepareDocxJob(
  doc: RenderedDoc,
  styleRef?: DocxTemplateRef,
): DocxJobData {
  return {
    type: "export_docx",
    jobId: `docx-${Date.now()}`,
    templateName: doc.templateName,
    competition: doc.templateId.split("-")[0] ?? "unknown",
    constraints: {
      font: doc.constraints.font,
      headingFont: doc.constraints.headingFont,
      bodySize: doc.constraints.bodySize,
      headingSize: doc.constraints.headingSize,
      lineSpacing: doc.constraints.lineSpacing,
      margins: doc.constraints.margins,
    },
    sections: doc.sections.map((s) => ({
      id: s.sectionId,
      title: s.title,
      type: inferSectionType(s.sectionId),
      content: s.content,
    })),
    styleMap: styleRef?.styleMap,
    referenceDocx: styleRef?.referenceDocx,
  };
}

/**
 * 从章节 ID 推断类型（用于 docx 格式决策）
 */
function inferSectionType(sectionId: string): string {
  if (sectionId.includes("img") || sectionId.includes("image") || sectionId.includes("figure")) {
    return "image";
  }
  if (sectionId.includes("table") || sectionId === "schedule" || sectionId === "budget" || sectionId === "team_info") {
    return "table";
  }
  if (sectionId === "project_name" || sectionId === "work_name") {
    return "title";
  }
  if (sectionId === "abstract" || sectionId === "executive_summary") {
    return "abstract";
  }
  if (sectionId.includes("signature") || sectionId.includes("opinion")) {
    return "signature";
  }
  return "text";
}
