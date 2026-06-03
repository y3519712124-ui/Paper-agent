// ============================================================
// Template 引擎测试
// ============================================================

import { describe, it, expect } from "vitest";
import { countWords, renderToMarkdown, renderTemplate } from "../../src/core/template/render.js";
import { checkConstraints, estimatePages, formatReport } from "../../src/core/template/constraints.js";
import type { RenderedDoc, TemplateDef } from "../../src/core/template/types.js";

// ── countWords ──
describe("countWords", () => {
  it("应该正确统计中文字数", () => {
    expect(countWords("这是一个测试")).toBe(6);
  });

  it("应该正确统计英文单词数", () => {
    expect(countWords("hello world test")).toBe(3);
  });

  it("应该正确处理中英文混合", () => {
    expect(countWords("你好 world 测试 hello")).toBe(6);
  });

  it("应该忽略空白字符", () => {
    expect(countWords("  你好  世界  ")).toBe(4);
  });

  it("空字符串返回 0", () => {
    expect(countWords("")).toBe(0);
  });
});

// ── renderToMarkdown ──
describe("renderToMarkdown", () => {
  const mockDoc: RenderedDoc = {
    templateId: "test-template",
    templateName: "测试模板",
    sections: [
      {
        sectionId: "background",
        title: "项目背景",
        content: "这是一个项目背景描述。",
        wordCount: 9,
        valid: true,
      },
      {
        sectionId: "innovation",
        title: "创新点",
        content: "- 创新点一\n- 创新点二",
        wordCount: 10,
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
    totalWords: 19,
    isValid: true,
    errors: [],
  };

  it("应该生成包含标题的 Markdown", () => {
    const md = renderToMarkdown(mockDoc);
    expect(md).toContain("# 测试项目");
    expect(md).toContain("## 项目背景");
    expect(md).toContain("## 创新点");
  });

  it("应该包含模板名称元数据", () => {
    const md = renderToMarkdown(mockDoc);
    expect(md).toContain("测试模板");
  });

  it("应该包含所有章节内容", () => {
    const md = renderToMarkdown(mockDoc);
    expect(md).toContain("这是一个项目背景描述。");
    expect(md).toContain("创新点一");
  });
});

// ── checkConstraints ──
describe("checkConstraints", () => {
  it("字数未超限时不应报错", () => {
    const doc: RenderedDoc = {
      templateId: "test",
      templateName: "测试",
      sections: [],
      variables: {},
      constraints: { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] },
      totalWords: 500,
      isValid: true,
      errors: [],
    };
    const violations = checkConstraints({ ...doc, constraints: { ...doc.constraints, maxChars: 8000 } });
    const wordViolations = violations.filter((v) => v.type === "word_limit");
    expect(wordViolations).toHaveLength(0);
  });

  it("字数超限时应报错", () => {
    const doc: RenderedDoc = {
      templateId: "test",
      templateName: "测试",
      sections: [],
      variables: {},
      constraints: { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] },
      totalWords: 10000,
      isValid: true,
      errors: [],
    };
    const violations = checkConstraints({ ...doc, constraints: { ...doc.constraints, maxChars: 5000 } });
    const wordViolations = violations.filter((v) => v.type === "word_limit");
    expect(wordViolations.length).toBeGreaterThan(0);
  });

  it("必填章节缺失时应标记", () => {
    const doc: RenderedDoc = {
      templateId: "test",
      templateName: "测试",
      sections: [
        {
          sectionId: "missing",
          title: "缺失章节",
          content: "",
          wordCount: 0,
          valid: false,
          errors: ["项目背景 为必填章节"],
        },
      ],
      variables: {},
      constraints: { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] },
      totalWords: 0,
      isValid: false,
      errors: [],
    };
    const violations = checkConstraints(doc);
    expect(violations.some((v) => v.type === "section_missing")).toBe(true);
  });
});

// ── estimatePages ──
describe("estimatePages", () => {
  it("500 字应估算为至少 1 页", () => {
    const pages = estimatePages(500, {
      maxPages: 8,
      font: "宋体",
      headingFont: "黑体",
      bodySize: "12pt",
      headingSize: "14pt",
      lineSpacing: 1.5,
      margins: [2.5, 2.0, 2.5, 2.0],
    });
    expect(pages).toBeGreaterThanOrEqual(1);
  });

  it("字数越多页数越多", () => {
    const c = { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] };
    const pages1 = estimatePages(1000, c);
    const pages2 = estimatePages(10000, c);
    expect(pages2).toBeGreaterThan(pages1);
  });
});

// ── formatReport ──
describe("formatReport", () => {
  it("应生成合规报告文本", () => {
    const doc: RenderedDoc = {
      templateId: "test",
      templateName: "测试模板",
      sections: [],
      variables: {},
      constraints: { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] },
      totalWords: 1000,
      isValid: true,
      errors: [],
    };
    const report = formatReport(doc, []);
    expect(report).toContain("测试模板");
    expect(report).toContain("通过");
  });
});
