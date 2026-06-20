// ============================================================
// Generation guard smoke — END-TO-END (Phase 0.1 rewrite)
// ============================================================
// Why this file exists:
//   Previously this script only did `source.includes(...)` on the
//   source text of workflows.ts. That proves the developer wrote
//   certain strings into the code, NOT that the running program
//   actually satisfies the product acceptance criteria. It was a
//   self-deceiving test (see docs/upgrade-critique.md §维度3).
//
// What it does now:
//   1. Spins up the real workflow server (offline/local-only mode).
//   2. Creates a workflow and runs the FULL generation pipeline.
//   3. Reads the generated `project-book-final.md` artifact.
//   4. Asserts on the OUTPUT: length, project-specific signals,
//      cross-project contamination = 0, internal wording leakage
//      = 0, realistic manuscript structure.
//
//   Crucially, it includes a NOVEL-TOPIC case that does NOT match
//   any hardcoded profile in inferProjectProfile(). If the generic
//   fallback path regresses, this case fails — the old source-scan
//   test could never catch that.
//
// A tiny, explicitly-labeled source-invariant section is retained
// only for invariants that cannot be exercised at runtime (e.g.
// "the legacy generate endpoint is disabled"). Quality claims are
// validated by running generation, never by grepping source.
// ============================================================

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverDir = join(rootDir, "server");
const keepSmokeProject = /^(1|true|yes|on)$/i.test(String(process.env.PAPER_AGENT_KEEP_SMOKE_PROJECT || "").trim());

// ── Shared detection patterns ──
// Internal/advice/meta wording must never leak into a final manuscript.
const INTERNAL_WORDING = /建议|待补充|后续完善|以实际提交附件为准|质量报告|系统说明|来源映射|Paper-agent 负责|当前章节|写作建议|质量体检|评审返修报告|自动修稿|本章需要|章节需要|正文完善|本章节中的论证必须回到|项目画像约束包|当前主题事实边界|当前部分事实边界|计划书正文/g;
const FORMAT_LEAKS = /项目项目计划书|项目计划书项目计划书|项目计划书计划书|计划书正文项目计划书/g;
// Blueprint-layer labels that must stay internal (PRD §6.2).
const BLUEPRINT_LEAKS = /项目素材理解摘要|参数使用边界|参考样式蓝图|格式学习层|写作迁移规则|竞赛技能蓝图|评分点覆盖矩阵|六层生成管线|事实核查管线/g;

const DEFAULT_BOOK_CHAPTERS = [
  "一、项目方案概述",
  "二、项目团队概述",
  "三、研究目标与内容",
  "四、研究方法与技术路线",
  "五、创新点与项目特色",
  "六、应用场景与需求验证",
  "七、预期成果与实施计划",
  "八、风险控制与质量评价",
  "九、经费预算与用途",
  "十、证明材料与附件清单",
  "十一、后续验证安排",
];

// ── Test cases ──
// Case 1 is a NOVEL topic: "智慧停车" matches NO hardcoded profile,
// so it exercises the generic/current-topic fallback path. This is
// the path most likely to break for real users, and the old test
// suite never covered it.
const CASES = [
  {
    label: "陌生题目·智慧停车（验证 generic 路径）",
    novel: true,
    minChars: 12_000,
    config: {
      name: "__smoke_gen_guard_novel__校园智慧停车位预约与引导小程序",
      template: "dachuang",
      competition: "dachuang",
      track: "校园出行服务",
      team: "团队按小程序开发、地磁传感器、校园后勤对接、用户调研、财务测算和申报展示分工推进",
      brief: "面向高校师生和校园后勤，建设基于地磁传感与小程序的智慧停车位预约、实时空位引导、违章提醒和数据看板系统，解决校园停车难、绕圈找车位和秩序混乱问题。",
      product: "地磁车位检测、空位实时看板、车位预约、导航引导、违章提醒、后勤管理后台、停车数据报表",
      market: "高校师生车主、校园后勤管理处、访客车辆、校园物业管理方和高校信息化部门",
      finance: "地磁设备采购、小程序研发、后台运维、校园部署和年度服务费按项目估算口径测算",
      evidence: "校园车位调研记录、地磁传感器测试数据、小程序原型截图、后勤访谈纪要、空位看板演示和数据报表样例",
      referenceNotes: "未上传真实写法参考时，大创项目书采用 challenge-cup-project-book skill 的竞赛项目书结构。",
      contestFileNotes: "本项目围绕校园智慧停车展开，不复用其他项目内容。",
      attachmentNotes: "附件以调研记录、传感器测试、原型截图和后勤访谈作为证明材料口径。",
    },
    projectSignals: ["停车", "车位", "预约", "地磁", "空位", "引导", "校园", "后台"],
    minProjectSignals: 5,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 7,
    // A parking project must never inherit elder-care / drone / cross-border content.
    forbidden: /养老|老人|护理|YOLO|跌倒|防摔|无人机|低空|蜂群|跨境|外贸|亚马逊|FreeFlow|白板|组队招募|队友申请|校园竞赛协作|执行摘要/g,
  },
  {
    label: "已知题目·SAR检测（验证 profile 路径仍生效）",
    novel: false,
    minChars: 12_000,
    config: {
      name: "__smoke_gen_guard_profile__SAR场景超路由元适应小目标检测网络HMAD-Ednet",
      template: "dachuang",
      competition: "dachuang",
      track: "应急救援与小目标检测",
      team: "团队按检测算法、场景路由、元学习、实验验证、数据集和申报展示分工推进",
      brief: "面向无人机搜救场景的小目标人员检测，构建多专家检测、场景路由和元学习优化一体化的 Hyper Route Meta-Adaptive Detection Network。",
      product: "HMAD-Ednet、SPA-HyperNet、多专家检测器、场景路由模块、Reptile元学习训练器、HGF-C2f、IoU质量门控、Phase A/B验证流程",
      market: "应急管理部门、消防救援队伍、航空应急救援队伍、无人机运营商、指挥系统集成商",
      finance: "算法模块授权、应急搜救技术服务、指挥系统接口集成和场景化模型适配服务按项目估算口径测算",
      evidence: "系统架构图、Phase A/Phase B流程图、实验结果表、消融实验、路由命中率记录、数据集说明和场景样例图",
      referenceNotes: "未上传真实写法参考时，大创项目书采用 challenge-cup-project-book skill 的竞赛项目书结构。",
      contestFileNotes: "本项目必须围绕SAR小目标检测、场景路由和元学习展开。",
      attachmentNotes: "附件以架构图、实验表、消融实验和路由记录作为证明材料口径。",
    },
    projectSignals: ["SAR", "小目标", "检测", "场景路由", "元适应", "多专家", "mAP", "搜救", "HMAD"],
    minProjectSignals: 6,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 7,
    // SAR project must not inherit drone-swarm / elder-care / cross-border contamination.
    forbidden: /蜂群|无人地面站|空地协同|多机编队|园区巡检|农业植保|物流配送|低空运营平台|养老|老人|护理|跌倒|防摔|跨境|外贸|亚马逊|FreeFlow|白板|执行摘要/g,
  },
];

// ── HTTP server lifecycle (mirrors smoke-final-manuscript-guard) ──
function encodeId(id) {
  return encodeURIComponent(id);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  const smokeHomeDir = join(rootDir, ".tmp", "smoke-generation-home");
  mkdirSync(smokeHomeDir, { recursive: true });
  const child = spawn(process.execPath, [tsxCli, "index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOME: smokeHomeDir,
      USERPROFILE: smokeHomeDir,
      PORT: String(port),
      PAPER_AGENT_LOCAL_ONLY: "1",
      PAPER_AGENT_SKIP_WEB_RESEARCH: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

function stopServer(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function request(baseUrl, path, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json", ...(fetchOptions.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
    ...fetchOptions,
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

async function waitForHealth(baseUrl, logs) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 45_000) {
    try {
      const health = await request(baseUrl, "/api/health", { timeoutMs: 2500 });
      if (health?.status === "ok") return;
    } catch (error) {
      lastError = error.message || String(error);
      await delay(500);
    }
  }
  fail("Generation guard smoke failed: test server did not become healthy.", {
    lastError,
    logs: logs.join("").slice(-3000),
  });
}

async function cleanup(baseUrl, id) {
  await request(baseUrl, `/api/workflows/${encodeId(id)}`, {
    method: "DELETE",
    timeoutMs: 10_000,
  }).catch(() => {});
}

// ── Output assertions ──
function fail(message, data) {
  console.error(message);
  if (data) console.error(JSON.stringify(data, null, 2).slice(0, 4000));
  throw new Error(message);
}

function assertNoMatches(text, pattern, label, testLabel) {
  pattern.lastIndex = 0;
  const matches = text.match(pattern) || [];
  if (matches.length) {
    fail(`Generation guard smoke failed (${testLabel}): ${label}.`, {
      matches: [...new Set(matches)].slice(0, 20),
    });
  }
}

function assertContainsSignals(text, signals, minimum, label, testLabel) {
  const hits = signals.filter((signal) => text.includes(signal));
  if (hits.length < minimum) {
    fail(`Generation guard smoke failed (${testLabel}): missing ${label}.`, {
      expectedAtLeast: minimum,
      hits,
      missing: signals.filter((signal) => !hits.includes(signal)),
    });
  }
  return hits;
}

function assertRealisticStructure(text, testLabel) {
  const source = String(text || "");
  const metrics = {
    h2: (source.match(/^##\s+/gm) || []).length,
    h3: (source.match(/^###\s+/gm) || []).length,
    tableLines: (source.match(/^\|.+\|$/gm) || []).length,
    numericSignals: (source.match(/\d+(?:\.\d+)?\s*(?:%|万元|元|人|个|项|份|家|次|月|年|周|页)|M[1-9]|第[一二三四五六七八九十]+阶段/g) || []).length,
  };
  const checks = [
    ["二级标题密度", metrics.h2 >= 8, metrics.h2],
    ["三级标题密度", metrics.h3 >= 12, metrics.h3],
    ["表格密度", metrics.tableLines >= 20, metrics.tableLines],
    ["数字化表达", metrics.numericSignals >= 10, metrics.numericSignals],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) {
    fail(`Generation guard smoke failed (${testLabel}): manuscript lacks realistic project-book structure.`, {
      failed: failed.map(([label, , actual]) => ({ label, actual })),
      metrics,
    });
  }
  return metrics;
}

function workflowPayload(config) {
  return {
    ...config,
    pageLimit: "30",
    reviewMode: "strict",
    figureMode: true,
    figureCount: "2",
    tableMode: true,
    tableCount: "8",
    dataMode: true,
    dataCount: "3",
    modelMode: true,
    modelCount: "1",
    docStyle: "competition",
    autoAdvance: true,
    humanCheckpoint: false,
    revisionLoop: true,
  };
}

async function runCase(baseUrl, testCase) {
  let workflowId = testCase.config.name;
  await cleanup(baseUrl, workflowId);

  try {
    const created = await request(baseUrl, "/api/workflows", {
      method: "POST",
      body: JSON.stringify(workflowPayload(testCase.config)),
      timeoutMs: 15_000,
    });
    workflowId = created.id || testCase.config.name;

    await request(baseUrl, `/api/workflows/${encodeId(workflowId)}/start`, {
      method: "POST",
      timeoutMs: 300_000,
    });

    const finalFile = await request(
      baseUrl,
      `/api/workflows/${encodeId(workflowId)}/file?path=${encodeURIComponent(".paper/drafts/project-book-final.md")}`,
      { timeoutMs: 15_000 },
    );
    const manuscript = String(finalFile.content || "");

    // 1. Length — a complete project book cannot be a stub.
    if (manuscript.length < testCase.minChars) {
      fail(`Generation guard smoke failed (${testCase.label}): final manuscript is too short.`, {
        chars: manuscript.length,
        expectedAtLeast: testCase.minChars,
      });
    }

    // 2. Project-specific signals appear in the OUTPUT (not the source).
    const projectHits = assertContainsSignals(
      manuscript,
      testCase.projectSignals,
      testCase.minProjectSignals,
      "project-specific signals",
      testCase.label,
    );

    // 3. Competition chapter structure is present.
    const chapterHits = assertContainsSignals(
      manuscript,
      testCase.chapterSignals,
      testCase.minChapterSignals,
      "competition chapter structure",
      testCase.label,
    );

    // 4. Cross-project contamination must be zero (PRD §8 acceptance).
    assertNoMatches(manuscript, testCase.forbidden, "cross-project contamination found in final manuscript", testCase.label);

    // 5. Internal/advice/meta wording must not leak (PRD §5.8, §6.2).
    assertNoMatches(manuscript, INTERNAL_WORDING, "internal/advice wording leaked into final manuscript", testCase.label);
    assertNoMatches(manuscript, BLUEPRINT_LEAKS, "blueprint-layer labels leaked into final manuscript", testCase.label);
    assertNoMatches(manuscript, FORMAT_LEAKS, "title/cover format leakage in final manuscript", testCase.label);

    // 6. Realistic structure.
    const realism = assertRealisticStructure(manuscript, testCase.label);

    await cleanup(baseUrl, workflowId);
    return {
      label: testCase.label,
      novel: testCase.novel,
      chars: manuscript.length,
      projectSignals: projectHits,
      chapterSignals: chapterHits.length,
      realism,
    };
  } catch (error) {
    if (!keepSmokeProject) {
      await cleanup(baseUrl, workflowId);
    } else {
      console.error(`Keeping smoke workflow for inspection: ${workflowId}`);
    }
    throw error;
  }
}

// ── Runtime-agnostic source invariants ──
// These are NOT quality claims. They check structural invariants that
// cannot be exercised by a happy-path generation run (e.g. that the
// legacy short-form generate endpoint is disabled, preventing
// regressions to the old 3-step path). All quality claims live above.
function assertSourceInvariants() {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const projectsSource = readFileSync(join(root, "server", "routes", "projects.ts"), "utf-8");
  const readmeSource = readFileSync(join(root, "README.md"), "utf-8");
  const requirementsSource = readFileSync(join(root, "docs", "product-requirements.md"), "utf-8");

  // Legacy short-form generation must stay disabled (regression guard).
  if (!projectsSource.includes("旧版三步项目书生成入口已停用") || !projectsSource.includes("res.status(410).json")) {
    fail("Source invariant failed: legacy /api/projects/:id/generate must return 410 and point to the full workflow pipeline.");
  }

  // README must link the product requirements.
  if (!readmeSource.includes("docs/product-requirements.md")) {
    fail("Source invariant failed: README must link to docs/product-requirements.md.");
  }

  // PRD must keep its core layer definitions (these define what we test).
  const requirementSnippets = [
    "Current Project Isolation Layer",
    "Input Understanding Layer",
    "Reference Style Learning Layer",
    "Competition Skill Layer",
    "De-Template and Human-Writing Layer",
    "Quality Review Layer",
    "Acceptance Criteria",
  ];
  const missingRequirements = requirementSnippets.filter((snippet) => !requirementsSource.includes(snippet));
  if (missingRequirements.length) {
    fail("Source invariant failed: product requirements document is missing core layer definitions.", { missing: missingRequirements });
  }
}

async function run() {
  // First, cheap source invariants that cannot be runtime-exercised.
  assertSourceInvariants();
  console.log("Source invariants passed (structural only; quality is verified by generation below).");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  const results = [];

  try {
    await waitForHealth(baseUrl, server.logs);
    for (const testCase of CASES) {
      results.push(await runCase(baseUrl, testCase));
    }
    for (const result of results) {
      const kind = result.novel ? "NOVEL" : "PROFILE";
      console.log(
        `Generation guard smoke passed [${kind}] (${result.label}). chars=${result.chars}, projectSignals=${result.projectSignals.join("/")}, chapterSignals=${result.chapterSignals}, h2=${result.realism.h2}, h3=${result.realism.h3}, tables=${result.realism.tableLines}`,
      );
    }
    console.log("\nGeneration guard smoke passed. All assertions were made on generated OUTPUT, not source text.");
  } catch (error) {
    console.error(server.logs.join("").slice(-3000));
    throw error;
  } finally {
    stopServer(server.child);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
