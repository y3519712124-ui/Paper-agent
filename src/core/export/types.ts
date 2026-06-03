// ============================================================
// 导出管线类型
// ============================================================

export type ExportFormat = "markdown" | "pdf" | "docx";

export interface ExportConfig {
  format: ExportFormat;
  outputPath: string;
  templateId?: string;
  styleTemplate?: string;     // 自定义样式模板路径
  pageSize?: "A4" | "letter";
  fontEmbedding?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  outputPath: string;
  fileSize: number;
  success: boolean;
  error?: string;
  warnings?: string[];
}

export interface StyleRule {
  element: string;            // h1, h2, h3, body, table, etc.
  font?: string;
  fontSize?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  alignment?: "left" | "center" | "right";
  spacing?: {
    before?: string;
    after?: string;
    line?: number;
  };
}

export interface StyleTemplate {
  name: string;
  rules: StyleRule[];
  pageSetup?: {
    size: "A4" | "letter";
    margins: [number, number, number, number];
  };
  defaultFont?: string;
  defaultSize?: string;
}

/** Markdown → Word 样式映射 */
export interface StyleMapping {
  markdownElement: string;     // # h1, ## h2, ### h3, p, table
  wordStyleName: string;       // Word 内建样式名
  formatting?: StyleRule;      // 额外格式覆盖
}

/** docx 模板引用 */
export interface DocxTemplateRef {
  referenceDocx?: string;      // Pandoc 参考模板路径
  styleMap?: StyleMapping[];
  imagePlaceholders?: Record<string, string>;
}
