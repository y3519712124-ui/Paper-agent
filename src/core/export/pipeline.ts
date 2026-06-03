// ============================================================
// 导出管线编排器
// Markdown / PDF / docx 统一导出入口
// ============================================================

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ExportConfig, ExportResult } from "./types.js";
import type { RenderedDoc } from "../template/types.js";
import { renderToMarkdown } from "../template/render.js";

export type { ExportConfig, ExportResult };

/**
 * 导出管线
 * 统一处理 Markdown / PDF / docx 导出
 */
export class ExportPipeline {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  /**
   * 导出文档
   */
  async export(doc: RenderedDoc, config: ExportConfig): Promise<ExportResult> {
    const outputPath = config.outputPath || this.resolveOutputPath(doc, config.format);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    switch (config.format) {
      case "markdown":
        return this.exportMarkdown(doc, outputPath);
      case "pdf":
        return this.exportPDF(doc, outputPath);
      case "docx":
        return this.exportDocx(doc, outputPath, config);
      default:
        return {
          format: config.format,
          outputPath,
          fileSize: 0,
          success: false,
          error: `不支持的导出格式: ${config.format}`,
        };
    }
  }

  /**
   * 导出为 Markdown
   */
  async exportMarkdown(
    doc: RenderedDoc,
    outputPath: string,
  ): Promise<ExportResult> {
    const md = renderToMarkdown(doc);
    writeFileSync(outputPath, md, "utf-8");
    const size = Buffer.byteLength(md, "utf-8");

    return {
      format: "markdown",
      outputPath,
      fileSize: size,
      success: true,
    };
  }

  /**
   * 导出为 PDF
   */
  async exportPDF(
    doc: RenderedDoc,
    outputPath: string,
  ): Promise<ExportResult> {
    // 先渲染 Markdown，然后通过 md-to-pdf 转换
    const md = renderToMarkdown(doc);
    const mdPath = outputPath.replace(/\.pdf$/i, ".md");
    writeFileSync(mdPath, md, "utf-8");

    try {
      // 尝试调用 md-to-pdf（需要在用户环境安装）
      // const { default: mdToPdf } = await import("md-to-pdf");
      // await mdToPdf({ path: mdPath }, { dest: outputPath });

      // 当前 fallback：返回 md 路径，提示需要转换
      return {
        format: "pdf",
        outputPath,
        fileSize: 0,
        success: false,
        warnings: [
          `PDF 导出需要安装 md-to-pdf: npm install -g md-to-pdf`,
          `临时文件: ${mdPath}`,
        ],
      };
    } catch (error) {
      return {
        format: "pdf",
        outputPath,
        fileSize: 0,
        success: false,
        error: `PDF 导出失败: ${error}`,
      };
    }
  }

  /**
   * 导出为 docx（通过 Python 桥）
   */
  async exportDocx(
    doc: RenderedDoc,
    outputPath: string,
    config: ExportConfig,
  ): Promise<ExportResult> {
    // 先生成 Markdown 作为中间格式
    const md = renderToMarkdown(doc);
    const mdPath = outputPath.replace(/\.docx$/i, ".md");
    writeFileSync(mdPath, md, "utf-8");

    // docx 导出依赖 Python python-docx
    // 此处返回提示，实际由 Python 模块处理
    return {
      format: "docx",
      outputPath,
      fileSize: 0,
      success: false,
      warnings: [
        `docx 导出需要通过 Python: paper export --python`,
        `临时 Markdown 文件: ${mdPath}`,
      ],
    };
  }

  /**
   * 解析默认输出路径
   */
  private resolveOutputPath(doc: RenderedDoc, format: string): string {
    const name = (doc.variables["project.name"] as string) || "output";
    const extMap: Record<string, string> = {
      markdown: ".md",
      pdf: ".pdf",
      docx: ".docx",
    };
    return join(this.outputDir, `${name}${extMap[format] ?? ".md"}`);
  }
}

/**
 * 快速导出辅助函数
 */
export async function quickExport(
  doc: RenderedDoc,
  format: "markdown" | "pdf" | "docx",
  outputDir: string = ".",
): Promise<ExportResult> {
  const pipeline = new ExportPipeline(outputDir);
  return pipeline.export(doc, {
    format,
    outputPath: "",
    templateId: doc.templateId,
  });
}
