// ============================================================
// 导出管线测试
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExportPipeline } from "../../src/core/export/pipeline.js";
import { prepareDocxJob } from "../../src/core/export/bridge.js";
import type { RenderedDoc } from "../../src/core/template/types.js";

const MOCK_DOC: RenderedDoc = {
  templateId: "test-template",
  templateName: "测试模板",
  sections: [
    {
      sectionId: "background",
      title: "项目背景",
      content: "本项目旨在解决...",
      wordCount: 8,
      valid: true,
    },
    {
      sectionId: "innovation",
      title: "创新点",
      content: "- 创新一\n- 创新二",
      wordCount: 8,
      valid: true,
    },
  ],
  variables: { "project.name": "测试项目" },
  constraints: {
    maxPages: 8,
    font: "宋体",
    headingFont: "黑体",
    bodySize: "12pt",
    headingSize: "14pt",
    lineSpacing: 1.5,
    margins: [2.5, 2.0, 2.5, 2.0],
  },
  totalWords: 16,
  isValid: true,
  errors: [],
};

describe("ExportPipeline", () => {
  let tmpDir: string;
  let pipeline: ExportPipeline;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `paper-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    pipeline = new ExportPipeline(tmpDir);
  });

  it("导出 Markdown 应成功", async () => {
    const result = await pipeline.export(MOCK_DOC, {
      format: "markdown",
      outputPath: join(tmpDir, "test.md"),
      templateId: "test",
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe("markdown");
    expect(existsSync(result.outputPath)).toBe(true);

    const content = readFileSync(result.outputPath, "utf-8");
    expect(content).toContain("测试项目");
    expect(content).toContain("项目背景");
  });

  it("导出文件大小应大于 0", async () => {
    const result = await pipeline.export(MOCK_DOC, {
      format: "markdown",
      outputPath: join(tmpDir, "size-test.md"),
      templateId: "test",
    });

    expect(result.fileSize).toBeGreaterThan(0);
  });

  it("PDF 导出当前应返回警告", async () => {
    const result = await pipeline.export(MOCK_DOC, {
      format: "pdf",
      outputPath: join(tmpDir, "test.pdf"),
      templateId: "test",
    });

    expect(result.success).toBe(false);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it("docx 导出当前应返回警告（未配置 Python）", async () => {
    const result = await pipeline.export(MOCK_DOC, {
      format: "docx",
      outputPath: join(tmpDir, "test.docx"),
      templateId: "test",
    });

    expect(result.success).toBe(false);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it("不支持的格式应返回错误", async () => {
    const result = await pipeline.export(MOCK_DOC, {
      // @ts-expect-error 测试无效格式
      format: "unknown",
      outputPath: join(tmpDir, "test.xyz"),
      templateId: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ── prepareDocxJob ──
describe("prepareDocxJob", () => {
  it("应生成有效的 DocxJobData", () => {
    const job = prepareDocxJob(MOCK_DOC);
    expect(job.type).toBe("export_docx");
    expect(job.templateName).toBe("测试模板");
    expect(job.sections).toHaveLength(2);
    expect(job.jobId).toBeTruthy();
  });

  it("模板约束应正确传递", () => {
    const job = prepareDocxJob(MOCK_DOC);
    expect(job.constraints.font).toBe("宋体");
    expect(job.constraints.bodySize).toBe("12pt");
    expect(job.constraints.margins).toEqual([2.5, 2.0, 2.5, 2.0]);
  });

  it("每个章节应有 id 和 title", () => {
    const job = prepareDocxJob(MOCK_DOC);
    for (const section of job.sections) {
      expect(section.id).toBeTruthy();
      expect(section.title).toBeTruthy();
    }
  });
});
