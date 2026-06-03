import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverDir = join(rootDir, "server");
const keepSmokeProject = /^(1|true|yes|on)$/i.test(String(process.env.PAPER_AGENT_KEEP_SMOKE_PROJECT || "").trim());

const INTERNAL_WORDING = /建议|待补充|后续完善|以实际提交附件为准|质量报告|系统说明|来源映射|Paper-agent 负责|当前章节|写作建议|质量体检|评审返修报告|自动修稿|本章需要|章节需要|正文完善|本章节中的论证必须回到|项目画像约束包|当前主题事实边界|当前部分事实边界|计划书正文/g;
const FORMAT_LEAKS = /项目项目计划书|项目计划书项目计划书|项目计划书计划书|计划书正文项目计划书/g;
const TEMPLATE_TONE_LEAKS = /章节之间保持清晰衔接|论证边界与支撑口径|背景论证把|产品论证把|市场论证区分|商业论证把|团队论证把|附件论证说明|正文围绕项目事实|摘要需要形成完整判断|文本要让评审|该写法|产品论证|商业和运营论证|运营计划服务于|市场验证材料围绕|财务测算把|能力说明落到|附件和发展规划/g;
const DEFAULT_BOOK_CHAPTERS = ["一、项目方案概述", "二、项目团队概述", "三、产业背景与项目产品", "四、市场调查与竞争分析", "五、商业模式与发展战略", "六、预期效益分析", "七、总结与资金回报", "八、证明材料"];
const LEGACY_COMPETITION_CHAPTERS = /执行摘要|一、项目背景与社会价值|二、公司\/项目概况与产品服务|三、创新内容与竞争优势|五、营销策略及销售|六、运营管理与实施计划|七、团队介绍与组织能力|八、财务分析与融资计划|九、风险分析与对策|十、发展战略与前景|十一、附件与证明材料|一、项目概要|二、行业痛点与创业机会|三、解决方案与产品服务|四、技术创新与核心壁垒|五、市场分析与用户验证|六、商业模式与业务闭环|七、运营推广与增长策略|八、团队基础与资源支撑|九、财务预测与融资回报|十、风险控制与合规|十一、路演呈现与附件材料/g;
const CAMPUS_TEAMING_CONTAMINATION = /组队招募|队友申请|学院竞赛群|创新创业社团|课程项目组|校级赛事|陌生同学组队|校园竞赛协作|优秀队伍|发布-匹配-沟通|匹配流程图|招募帖样例/g;

const CASES = [
  {
    label: "最小输入 大创 FreeFlow",
    config: {
      name: "__smoke_minimal_input__FreeFlow多格式融合流式无限白板平台",
      template: "dachuang",
      competition: "dachuang",
      track: "创业训练项目",
    },
    minChars: 18_000,
    projectSignals: ["FreeFlow", "白板", "多格式", "融合", "流式", "协作", "平台"],
    minProjectSignals: 4,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|YOLO|跌倒|防摔|护理|老人|夜班护理员|跨境电商|外贸|非接触|隔空|手势|执行摘要|二、项目优势|六、市场运营|十、未来展望/g,
  },
  {
    label: "最小输入 挑战杯 勿触",
    config: {
      name: "__smoke_minimal_input__勿触非接触隔空操作中间件",
      template: "tiaozhanbei",
      competition: "tiaozhanbei",
      track: "挑战杯创业计划竞赛项目",
    },
    minChars: 18_000,
    projectSignals: ["勿触", "非接触", "隔空", "操作", "中间件"],
    minProjectSignals: 4,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|老人|护理|YOLO|跌倒|防摔|FreeFlow|白板|跨境电商|外贸|商品页|执行摘要|五、营销策略及销售|十、发展战略与前景|十一、附件与证明材料|组队招募|队友申请|学院竞赛群|校级赛事|陌生同学组队|校园竞赛协作/g,
  },
  {
    label: "最小输入 互联网+ 跨境电商",
    config: {
      name: "__smoke_minimal_input__数驭全球跨境电商大模型智慧服务平台",
      template: "internet-plus",
      competition: "internet-plus",
      track: "中国国际大学生创新大赛商业计划书",
    },
    minChars: 18_000,
    projectSignals: ["数驭全球", "跨境", "电商", "大模型", "智慧服务", "平台"],
    minProjectSignals: 4,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|老人|护理|YOLO|跌倒|防摔|FreeFlow|白板|非接触|隔空|手势|中间件|执行摘要|项目概要|行业痛点与创业机会|运营推广与增长策略|路演呈现与附件材料|组队招募|队友申请|学院竞赛群|校级赛事|陌生同学组队|校园竞赛协作/g,
  },
  {
    label: "最小输入 养老防摔",
    config: {
      name: "__smoke_minimal_input__基于yolo11n的老年人防摔系统",
      template: "dachuang",
      competition: "dachuang",
      track: "银发经济",
    },
    minChars: 18_000,
    projectSignals: ["YOLOv11n", "老年", "防摔", "系统", "银发"],
    minProjectSignals: 4,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /FreeFlow|白板|跨境电商|外贸|商品页|非接触|隔空|手势|中间件|执行摘要|组队招募|队友申请|学院竞赛群|创新创业社团|课程项目组|校级赛事|陌生同学组队|校园竞赛协作|优秀队伍|发布-匹配-沟通|匹配流程图|招募帖样例/g,
  },
  {
    label: "最小输入 YOLOv8版本保真",
    config: {
      name: "__smoke_minimal_input__基于yolov8的老年人防摔报警器",
      template: "dachuang",
      competition: "dachuang",
      track: "银发经济",
      product: "YOLOv8人体检测、姿态判断、跌倒报警、护理端通知、后台事件记录",
    },
    minChars: 18_000,
    projectSignals: ["YOLOv8", "防摔", "报警", "护理", "跌倒", "事件记录", "姿态", "人体检测"],
    minProjectSignals: 5,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /YOLO11|FreeFlow|白板|跨境电商|外贸|商品页|非接触|隔空|手势|中间件|执行摘要|组队招募|队友申请|学院竞赛群|校园竞赛协作/g,
  },
];

function fail(message, data) {
  console.error(message);
  if (data) console.error(JSON.stringify(data, null, 2).slice(0, 4000));
  throw new Error(message);
}

function encodeId(id) {
  return encodeURIComponent(id);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
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
  fail("Minimal input smoke failed: test server did not become healthy.", {
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

function assertNoMatches(text, pattern, label, testLabel) {
  pattern.lastIndex = 0;
  const matches = text.match(pattern) || [];
  if (matches.length) {
    fail(`Minimal input smoke failed (${testLabel}): ${label}.`, {
      matches: [...new Set(matches)].slice(0, 20),
    });
  }
}

function assertNoEmptyHeadings(text, testLabel) {
  const lines = String(text || "").split(/\r?\n/);
  const empty = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^#{3,6}\s+(.+?)\s*$/);
    if (!match) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j >= lines.length || /^#{1,6}\s+/.test(lines[j])) empty.push(match[1]);
  }
  if (empty.length) {
    fail(`Minimal input smoke failed (${testLabel}): empty markdown headings leaked into final manuscript.`, {
      headings: empty.slice(0, 20),
    });
  }
}

function assertContainsSignals(text, signals, minimum, label, testLabel) {
  const hits = signals.filter((signal) => text.includes(signal));
  if (hits.length < minimum) {
    fail(`Minimal input smoke failed (${testLabel}): missing ${label}.`, {
      expectedAtLeast: minimum,
      hits,
      missing: signals.filter((signal) => !hits.includes(signal)),
    });
  }
  return hits;
}

function duplicateParagraphCount(text) {
  const seen = new Map();
  for (const line of String(text || "").split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed.length < 70 || trimmed.startsWith("|") || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const key = trimmed.replace(/[，。；：、,.!?！？\s]+/g, "").slice(0, 110);
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.values()].filter((count) => count > 1).length;
}

function countUniqueSignals(text, signals) {
  return signals.filter((signal) => text.includes(signal)).length;
}

function realismMetrics(text) {
  const source = String(text || "");
  return {
    h2: (source.match(/^##\s+/gm) || []).length,
    h3: (source.match(/^###\s+/gm) || []).length,
    tableLines: (source.match(/^\|.+\|$/gm) || []).length,
    figureSignals: (source.match(/!\[|paper:\/\/figure|图\s*\d|图[一二三四五六七八九十]/g) || []).length,
    numericSignals: (source.match(/\d+(?:\.\d+)?\s*(?:%|万元|元|人|个|项|份|家|次|月|年|周|页)|M[1-9]|第[一二三四五六七八九十]+阶段/g) || []).length,
    evidenceSignals: countUniqueSignals(source, ["访谈", "问卷", "原型", "截图", "演示", "测试", "指标", "竞品", "财务测算", "预算", "附件", "材料", "用户反馈", "版本", "日志"]),
    businessSignals: countUniqueSignals(source, ["收入", "成本", "客户", "推广", "营销", "渠道", "订阅", "授权", "运维", "资金", "融资", "预算", "商业模式"]),
    duplicateParagraphs: duplicateParagraphCount(source),
  };
}

function assertRealisticProjectBook(text, testLabel) {
  const metrics = realismMetrics(text);
  const checks = [
    ["二级标题密度", metrics.h2 >= 10, metrics.h2],
    ["三级标题密度", metrics.h3 >= 18, metrics.h3],
    ["表格密度", metrics.tableLines >= 50, metrics.tableLines],
    ["图示信号", metrics.figureSignals >= 2, metrics.figureSignals],
    ["数字化表达", metrics.numericSignals >= 16, metrics.numericSignals],
    ["证据材料表达", metrics.evidenceSignals >= 7, metrics.evidenceSignals],
    ["商业/财务表达", metrics.businessSignals >= 5, metrics.businessSignals],
    ["整段重复控制", metrics.duplicateParagraphs <= 1, metrics.duplicateParagraphs],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) {
    fail(`Minimal input smoke failed (${testLabel}): manuscript does not look like a complete competition project book.`, {
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
    if (manuscript.length < testCase.minChars) {
      fail(`Minimal input smoke failed (${testCase.label}): final manuscript is too short.`, {
        chars: manuscript.length,
        expectedAtLeast: testCase.minChars,
      });
    }

    const projectHits = assertContainsSignals(
      manuscript,
      testCase.projectSignals,
      testCase.minProjectSignals,
      "project-specific signals",
      testCase.label,
    );
    const chapterHits = assertContainsSignals(
      manuscript,
      testCase.chapterSignals,
      testCase.minChapterSignals,
      "competition chapter structure",
      testCase.label,
    );
    assertNoMatches(manuscript, testCase.forbidden, "cross-project contamination found", testCase.label);
    if (!/协创桥|竞赛组队|队友/.test(testCase.config.name)) {
      assertNoMatches(manuscript, CAMPUS_TEAMING_CONTAMINATION, "campus teaming content leaked into unrelated no-reference manuscript", testCase.label);
    }
    assertNoMatches(manuscript, LEGACY_COMPETITION_CHAPTERS, "legacy competition chapter structure leaked into no-reference manuscript", testCase.label);
    assertNoMatches(manuscript, INTERNAL_WORDING, "internal/advice wording leaked into final manuscript", testCase.label);
    assertNoMatches(manuscript, FORMAT_LEAKS, "title or cover format leakage found", testCase.label);
    assertNoMatches(manuscript, TEMPLATE_TONE_LEAKS, "template-like editorial wording leaked into final manuscript", testCase.label);
    assertNoEmptyHeadings(manuscript, testCase.label);
    const realism = assertRealisticProjectBook(manuscript, testCase.label);

    await cleanup(baseUrl, workflowId);
    return {
      label: testCase.label,
      chars: manuscript.length,
      projectSignals: projectHits,
      chapterSignals: chapterHits.length,
      realism,
    };
  } catch (error) {
    if (!keepSmokeProject) {
      await cleanup(baseUrl, workflowId);
    } else {
      console.error(`Keeping minimal-input smoke workflow for inspection: ${workflowId}`);
    }
    throw error;
  }
}

async function run() {
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
      console.log(
        `Minimal input smoke passed (${result.label}). chars=${result.chars}, projectSignals=${result.projectSignals.join("/")}, chapterSignals=${result.chapterSignals}, h2=${result.realism.h2}, h3=${result.realism.h3}, tables=${result.realism.tableLines}, figures=${result.realism.figureSignals}`,
      );
    }
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
