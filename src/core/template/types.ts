// ============================================================
// 模板系统核心类型
// Paper-agent 模板类型定义
// ============================================================

/** 模板缩放单位 */
export type LengthUnit = "px" | "pt" | "cm" | "mm" | "in";

/** 模板约束 */
export interface TemplateConstraints {
  maxPages: number;
  maxChars?: number;
  font: string;
  headingFont: string;
  bodySize: string;
  headingSize: string;
  lineSpacing: number;
  margins: [number, number, number, number]; // 上 右 下 左
}

/** 字段类型 */
export type FieldType =
  | "string"
  | "number"
  | "select"
  | "date"
  | "textarea"
  | "tag_list"
  | "signature"
  | "seal";

/** 字段定义 */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
}

/** 表格定义 */
export interface TableDef {
  name?: string;
  maxRows?: number;
  fields: FieldDef[];
}

/** 章节类型 */
export type SectionType =
  | "single_line"
  | "textarea"
  | "select"
  | "bullet_list"
  | "table"
  | "table_group"
  | "group"
  | "checklist"
  | "reference_list"
  | "attachment_list"
  | "duration"
  | "signature_block"
  | "image"           // 图片占位
  | "image_group";    // 多图组合

/** 图片定义 */
export interface ImageDef {
  id: string;
  label: string;
  description?: string;
  maxWidth?: string;     // e.g. "14cm"
  maxHeight?: string;
  position?: "center" | "left" | "right";
  caption?: boolean;     // 是否生成图注
  optional?: boolean;    // 可选图片
}

/** 表格列定义 */
export interface TableColumn {
  key: string;
  label: string;
  width: string;
  type?: "string" | "number" | "sum";
}

/** 检查项 */
export interface ChecklistOption {
  id: string;
  label: string;
  countLabel?: string;
  freeText?: boolean;
}

/** 章节定义 */
export interface SectionDef {
  id: string;
  title: string;
  type: SectionType;
  required?: boolean;
  maxLength?: number;
  maxChars?: number;
  maxCharsPerItem?: number;
  minItems?: number;
  maxItems?: number;
  minRows?: number;
  maxRows?: number;
  description?: string;
  aiPrompt?: string;
  options?: string[];
  default?: string;
  defaultMonths?: number;
  fields?: FieldDef[];
  tables?: TableDef[];
  columns?: TableColumn[];
  footer?: TableColumn[];
  defaultRows?: Record<string, string>[];
  options_list?: ChecklistOption[];
  types?: string[];
  condition?: {
    if: string;
    equals?: string;
    in?: string[];
  };
  format?: string;
  // 图片相关
  images?: ImageDef[];          // 图片占位列表（用于 image/image_group 类型）
  imagePlaceholder?: string;    // AI 生成图片描述的提示词
  imageCaptionTemplate?: string; // 图注模板
}

/** 变量定义 */
export interface TemplateVariable {
  name: string;
  label: string;
  type: string;
  maxLength?: number;
  maxItems?: number;
  required?: boolean;
  options?: string[];
  unit?: string;
  default?: string | number;
}

/** 完整模板定义 */
export interface TemplateDef {
  name: string;
  id: string;
  competition: string;
  track: string;
  description: string;
  version: string;
  constraints: TemplateConstraints;
  sections: SectionDef[];
  variables: TemplateVariable[];
}

/** 渲染后的章节内容 */
export interface SectionContent {
  sectionId: string;
  title: string;
  content: string | Record<string, unknown> | Record<string, unknown>[];
  wordCount: number;
  valid: boolean;
  errors?: string[];
}

/** 渲染后的完整文档 */
export interface RenderedDoc {
  templateId: string;
  templateName: string;
  sections: SectionContent[];
  variables: Record<string, unknown>;
  constraints: TemplateConstraints;
  totalWords: number;
  isValid: boolean;
  errors: string[];
}

/** 模板商店中的模板条目 */
export interface TemplateMeta {
  id: string;
  name: string;
  competition: string;
  track: string;
  description: string;
  version: string;
  isBuiltin: boolean;
  filePath?: string;
}
