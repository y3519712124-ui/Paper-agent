import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workDir = join(tmpdir(), `paper-agent-export-format-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const docxOutputPath = join(workDir, "format-smoke.docx");
const pdfOutputPath = join(workDir, "format-smoke.pdf");
const latexOutputPath = join(workDir, "format-smoke.tex");
const scriptPath = join(repoRoot, "python", "paper_agent", "export", "project_book.py");
const bundledPython = join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
const python = process.env.PAPER_PYTHON || process.env.PAPER_AGENT_PYTHON || (existsSync(bundledPython) ? bundledPython : "python");

const basePayload = {
  markdown: [
    "# 基于测试项目的项目计划书",
    "",
    "## 封面信息",
    "| 项目字段 | 内容 |",
    "| --- | --- |",
    "| 项目名称 | 格式测试项目 |",
    "| 项目类别 | 大创项目 |",
    "",
    "## 一、项目概述",
    "本项目围绕真实竞赛项目书的版式要求进行导出测试，正文应为宋体、小四、首行缩进两个中文字符、接近一点五倍行距，并保持段落两端对齐。",
    "",
    "### 1.1 项目背景",
    "项目背景段落用于检查三级标题、普通正文、页眉页脚和页面边距是否同时生效。",
    "",
    "| 指标 | 目标 | 说明 |",
    "| --- | --- | --- |",
    "| 正文字号 | 小四 | 12pt |",
    "| 行间距 | 1.5倍 | 竞赛项目书常用格式 |",
    "",
    "待补充、后续完善、以实际提交附件为准、TODO、??? 这些待办式文字是烟测污染内容，导出时必须被清理。",
    "",
    "### 质量体检报告",
    "这段是烟测故意混入的质量体检报告，正式 Word/PDF/LaTeX 导出前必须被截断。",
    "",
    "## 项目书评审返修报告",
    "这段是烟测故意混入的评审返修报告，正式 Word/PDF 导出前必须被清理。",
    "",
    "## 终稿质量检测报告",
    "这段是烟测故意混入的质量报告，不能出现在正式项目书里。",
    "",
    "## 材料来源与正文对应表",
    "来源映射、系统说明、Paper-agent 负责、自动修稿、当前章节、写作建议都不应进入导出文件。",
  ].join("\n"),
  project: {
    name: "格式测试项目",
    template: "dachuang-innovation-training",
    competition: "dachuang",
    docStyle: "competition",
  },
};

function runExport(format, outputPath) {
  const result = spawnSync(python, [scriptPath], {
    input: JSON.stringify({ ...basePayload, format, output_path: outputPath }),
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
}

runExport("docx", docxOutputPath);

if (!existsSync(docxOutputPath) || statSync(docxOutputPath).size < 10_000) {
  console.error("DOCX export did not create a substantial Word file.");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const zipRead = spawnSync(python, ["-c", `
import json, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    data = {
        "document": z.read("word/document.xml").decode("utf-8"),
        "styles": z.read("word/styles.xml").decode("utf-8"),
        "footer": z.read("word/footer1.xml").decode("utf-8"),
    }
print(json.dumps(data, ensure_ascii=False))
`, docxOutputPath], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });

if (zipRead.status !== 0) {
  console.error(zipRead.stderr || zipRead.stdout);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const docxXml = JSON.parse(zipRead.stdout);
const documentXml = docxXml.document;
const stylesXml = docxXml.styles;
const footerXml = docxXml.footer;

const checks = [
  ["page margins", /w:pgMar[^>]+w:top="1440"[^>]+w:right="1417"[^>]+w:bottom="1440"[^>]+w:left="1701"/.test(documentXml)],
  ["body first-line indent", /w:firstLine="480"/.test(documentXml) || /w:firstLine="480"/.test(stylesXml)],
  ["body font size 12pt", /w:sz w:val="24"/.test(stylesXml)],
  ["CJK body font", /w:eastAsia="宋体"/.test(stylesXml)],
  ["CJK heading font", /w:eastAsia="黑体"/.test(stylesXml)],
  ["heading outline levels", /w:outlineLvl w:val="0"/.test(stylesXml) && /w:outlineLvl w:val="1"/.test(stylesXml)],
  ["table grid style", /w:tblStyle w:val="TableGrid"/.test(documentXml)],
  ["page number field", /w:instrText[^>]*>PAGE</.test(footerXml)],
  ["formal content retained", /格式测试项目/.test(documentXml) && /项目背景段落/.test(documentXml)],
  ["quality report stripped", !/项目书评审返修报告|终稿质量检测报告|质量体检报告|质量报告|系统说明|来源映射|Paper-agent|自动修稿|待补充|后续完善|以实际提交附件为准|TODO|\?\?\?|当前章节|写作建议/.test(documentXml)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("DOCX format smoke failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

runExport("pdf", pdfOutputPath);

if (!existsSync(pdfOutputPath) || statSync(pdfOutputPath).size < 6_000) {
  console.error("PDF export did not create a substantial PDF file.");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const pdfRead = spawnSync(python, ["-c", `
import json, sys
from pypdf import PdfReader
path = sys.argv[1]
reader = PdfReader(path)
text = "\\n".join(page.extract_text() or "" for page in reader.pages)
print(json.dumps({"page_count": len(reader.pages), "text": text}, ensure_ascii=False))
`, pdfOutputPath], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });

if (pdfRead.status !== 0) {
  console.error(pdfRead.stderr || pdfRead.stdout);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const pdfData = JSON.parse(pdfRead.stdout);
const pdfText = pdfData.text || "";
const pdfChecks = [
  ["PDF page count", pdfData.page_count >= 1],
  ["PDF formal content retained", /格式测试项目/.test(pdfText) && /项目背景段落/.test(pdfText)],
  ["PDF quality report stripped", !/项目书评审返修报告|终稿质量检测报告|质量体检报告|质量报告|系统说明|来源映射|Paper-agent|自动修稿|待补充|后续完善|以实际提交附件为准|TODO|\?\?\?|当前章节|写作建议/.test(pdfText)],
];

const pdfFailed = pdfChecks.filter(([, ok]) => !ok);
if (pdfFailed.length) {
  console.error("PDF format smoke failed:");
  for (const [name] of pdfFailed) console.error(`- ${name}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

runExport("tex", latexOutputPath);

if (!existsSync(latexOutputPath) || statSync(latexOutputPath).size < 1_000) {
  console.error("LaTeX export did not create a substantial TeX file.");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const latexText = readFileSync(latexOutputPath, "utf-8");
const latexChecks = [
  ["LaTeX formal content retained", /格式测试项目/.test(latexText) && /项目背景段落/.test(latexText)],
  ["LaTeX system wording stripped", !/项目书评审返修报告|终稿质量检测报告|质量体检报告|质量报告|系统说明|来源映射|Paper-agent|自动修稿|自动生成|自动嵌入|待补充|后续完善|以实际提交附件为准|TODO|\?\?\?|当前章节|写作建议/.test(latexText)],
];

const latexFailed = latexChecks.filter(([, ok]) => !ok);
if (latexFailed.length) {
  console.error("LaTeX format smoke failed:");
  for (const [name] of latexFailed) console.error(`- ${name}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(workDir, { recursive: true, force: true });
console.log("Export format smoke passed.");
