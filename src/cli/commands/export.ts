// ============================================================
// paper export — 导出文档（支持 Python 桥接）
// ============================================================

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { PROJECTS_DIR } from "../../config/defaults.js";
import { ExportPipeline } from "../../core/export/pipeline.js";
import { prepareDocxJob } from "../../core/export/bridge.js";
import { PythonBridge } from "../../core/bridge/python-bridge.js";
import { findTemplateById, loadTemplate } from "../../core/template/parser.js";
import { renderToMarkdown } from "../../core/template/render.js";
import { TEMPLATE_DIR } from "../../config/defaults.js";
import type { ExportResult } from "../../core/export/types.js";
import type { RenderedDoc } from "../../core/template/types.js";

interface ExportOptions {
  project?: string;
  output?: string;
  python: boolean;
}

export async function exportDoc(
  format: string,
  options: ExportOptions,
): Promise<void> {
  const projectName = options.project ?? "my-project";
  const projectDir = join(PROJECTS_DIR, projectName);
  const outputDir = options.output ?? join(projectDir, ".paper", "drafts");

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const pipeline = new ExportPipeline(outputDir);

  const validFormats = ["md", "markdown", "pdf", "docx"];
  if (!validFormats.includes(format)) {
    console.error(`❌ 不支持的格式: ${format}（支持: md / pdf / docx）`);
    process.exit(1);
  }

  const fmt = format === "markdown" ? "markdown" :
              format === "md" ? "markdown" :
              format as "pdf" | "docx";

  // ── 从项目读取内容构建 RenderedDoc ──
  const doc = buildRenderedDoc(projectDir, projectName);

  console.log(`📤 正在导出 ${fmt.toUpperCase()}...`);

  let result: ExportResult;

  if (fmt === "docx" && options.python) {
    // ── Python 引擎 docx 导出 ──
    result = await exportDocxViaPython(doc, outputDir, projectName);
  } else if (fmt === "docx") {
    // ── 简单 docx 导出（提示安装 Python） ──
    result = await pipeline.export(doc, {
      format: "docx",
      outputPath: options.output ?? "",
      templateId: doc.templateId,
    });
  } else {
    result = await pipeline.export(doc, {
      format: fmt,
      outputPath: options.output ?? "",
      templateId: doc.templateId,
    });
  }

  // ── 输出结果 ──
  if (result.success) {
    const sizeKB = (result.fileSize / 1024).toFixed(1);
    console.log(`✅ 导出成功: ${result.outputPath} (${sizeKB} KB)`);
  } else {
    if (result.warnings) {
      for (const w of result.warnings) console.log(`   ⚠ ${w}`);
    }
    if (result.error) console.error(`   ❌ ${result.error}`);
  }
}

/**
 * 通过 Python 桥导出 docx
 */
async function exportDocxViaPython(
  doc: RenderedDoc,
  outputDir: string,
  projectName: string,
): Promise<ExportResult> {
  const outputPath = join(outputDir, `${projectName}.docx`);

  // 构建 Python 任务数据
  const jobData = prepareDocxJob(doc);

  // 启动 Python 桥
  const bridge = new PythonBridge({
    pythonPath: "python",
    startupTimeoutMs: 8000,
    requestTimeoutMs: 60000,
  });

  try {
    console.log(`   🐍 启动 Python 导出引擎...`);
    await bridge.start();
    console.log(`   ✅ Python 引擎就绪`);

    // 调用 Python docx 导出
    const result = await bridge.call({
      agent: "docx-exporter",
      method: "export",
      params: {
        data: jobData as unknown as Record<string, unknown>,
        output_path: outputPath,
      },
      timeoutMs: 60000,
    });

    return {
      format: "docx",
      outputPath,
      fileSize: existsSync(outputPath) ? statSync(outputPath).size : 0,
      success: true,
    };
  } catch (error) {
    return {
      format: "docx",
      outputPath,
      fileSize: 0,
      success: false,
      error: `Python docx 导出失败: ${error}`,
      warnings: [
        `确保已安装: pip install python-docx`,
        `临时 Markdown: ${outputPath.replace(/\.docx$/, ".md")}`,
      ],
    };
  } finally {
    await bridge.shutdown();
  }
}

/**
 * 从项目目录构建 RenderedDoc
 */
function buildRenderedDoc(projectDir: string, projectName: string): RenderedDoc {
  const configPath = join(projectDir, ".paper", "project.yaml");
  let variables: Record<string, unknown> = { "project.name": projectName };
  let templateId = "dachuang-innovation-training";

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = parseYaml(raw) as Record<string, unknown>;
      variables = { "project.name": projectName, ...(config.variables as Record<string, unknown> ?? {}) };
      templateId = (config.template as string) ?? templateId;
    } catch { /* fallback */ }
  }

  // 使用模板 ID 查找（支持 dachuang-innovation-training 格式）
  const template = findTemplateById(TEMPLATE_DIR, templateId) ?? loadTemplate(join(TEMPLATE_DIR, templateId.split("-")[0]!, `${templateId}.yaml`));

  // 尝试加载草稿
  const draftsDir = join(projectDir, ".paper", "drafts");
  let sections: Array<{ sectionId: string; title: string; content: string | Record<string, unknown> | Record<string, unknown>[]; wordCount: number; valid: boolean }> = [];

  if (existsSync(draftsDir)) {
    const files = readdirSync(draftsDir).filter((f: string) => f.endsWith(".md"));
    if (files.length > 0) {
      const latest = files.sort().reverse()[0];
      const draftContent = readFileSync(join(draftsDir, latest), "utf-8");
      sections = [{
        sectionId: "draft",
        title: "草稿",
        content: draftContent,
        wordCount: draftContent.length,
        valid: true,
      }];
    }
  }

  return {
    templateId,
    templateName: template?.name ?? "未知模板",
    sections,
    variables,
    constraints: template?.constraints ?? { maxPages: 8, font: "宋体", headingFont: "黑体", bodySize: "12pt", headingSize: "14pt", lineSpacing: 1.5, margins: [2.5, 2.0, 2.5, 2.0] },
    totalWords: sections.reduce((s, sec) => s + sec.wordCount, 0),
    isValid: true,
    errors: [],
  };
}
