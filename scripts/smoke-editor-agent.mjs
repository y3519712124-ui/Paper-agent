const BASE_URL = process.env.PAPER_AGENT_URL || "http://localhost:3456";
const ID = "__smoke_editor_agent__";
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = typeof data === "object" && data?.error ? data.error : text;
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }
  return data;
}

function encodeId(id) {
  return encodeURIComponent(id);
}

async function cleanup() {
  await request(`/api/workflows/${encodeId(ID)}`, { method: "DELETE" }).catch(() => {});
}

function fail(message, data) {
  console.error(message);
  if (data) console.error(JSON.stringify(data, null, 2).slice(0, 2000));
  throw new Error(message);
}

async function run() {
  await request("/api/health");
  await cleanup();
  await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: ID,
      template: "dachuang",
      competition: "dachuang",
      track: "测试赛道",
      brief: "编辑器智能体行为测试",
      product: "测试系统",
      market: "测试用户",
      evidence: "测试材料",
      autoAdvance: false,
      humanCheckpoint: false,
      revisionLoop: false,
    }),
  });

  const content = [
    "# 测试项目计划书",
    "",
    "## 执行摘要",
    "本项目用于测试编辑器智能体。建议采用测试方案，后续完善项目书正文。",
    "",
    "## 一、项目概述",
    "测试系统面向测试用户，当前正文需要进一步形成项目背景、产品服务、市场分析和证明材料闭环。",
    "",
    "## 二、市场分析",
    "目标用户为测试用户，市场与财务论证仍较薄弱。",
  ].join("\n");

  await request(`/api/workflows/${encodeId(ID)}/file`, {
    method: "PUT",
    body: JSON.stringify({
      path: ".paper/drafts/project-book-final.md",
      content,
    }),
  });

  const result = await request(`/api/workflows/${encodeId(ID)}/editor/assist`, {
    method: "POST",
    body: JSON.stringify({
      instruction: "请像 Codex 一样自检当前项目书，自己判断哪里还没有完善，然后直接修改中间编辑器。",
      mode: "agent/latex",
      path: ".paper/drafts/project-book-final.md",
      content,
    }),
  });

  if (result.action !== "replace_current_file" || !result.canApply) {
    fail("Editor agent smoke failed: self-check instruction must produce an applicable editor patch.", result);
  }
  if (!result.patch || result.patch.length <= content.length || !result.patch.includes("项目")) {
    fail("Editor agent smoke failed: patch must contain the improved manuscript, not an empty/no-op response.", result);
  }
  if (!result.backup?.backupDir || !existsSync(result.backup.backupDir)) {
    fail("Editor agent smoke failed: applicable editor edits must create a pre-edit backup.", result);
  }
  const backupFile = join(result.backup.backupDir, "drafts", "project-book-final.md");
  if (!existsSync(backupFile) || readFileSync(backupFile, "utf-8") !== content) {
    fail("Editor agent smoke failed: backup must contain the exact pre-edit manuscript.", result);
  }
  if (String(result.answer || "").length > 1200 || result.answer.includes(result.patch.slice(0, 160))) {
    fail("Editor agent smoke failed: chat answer is too long or appears to include manuscript content.", result);
  }
  const traceLabels = (result.agentTrace || []).map((item) => item.label).join(",");
  for (const label of ["诊断", "计划", "执行", "复核"]) {
    if (!traceLabels.includes(label)) {
      fail(`Editor agent smoke failed: missing trace label ${label}.`, result);
    }
  }
  const traceText = JSON.stringify(result.agentTrace || []);
  if (!traceText.includes("体检") || !traceText.includes("未通过")) {
    fail("Editor agent smoke failed: self-check repair must include quality scan context in the agent trace.", result);
  }
  if (/待补充|后续完善|建议采用/.test(result.patch)) {
    fail("Editor agent smoke failed: patch still contains obvious non-final manuscript wording.", result);
  }
  if (/质量体检|质量报告|系统说明|来源映射|Paper-agent 负责/.test(result.patch)) {
    fail("Editor agent smoke failed: manuscript patch must not contain internal quality/system notes.", result);
  }

  await cleanup();
  console.log("Editor agent smoke passed.");
}

run().catch(async (error) => {
  await cleanup();
  console.error(error);
  process.exit(1);
});
