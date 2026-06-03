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
    label: "大创 FreeFlow",
    minChars: 18_000,
    config: {
      name: "__smoke_final_guard_dachuang__FreeFlow多格式融合流式无限白板平台",
      template: "dachuang",
      competition: "dachuang",
      track: "创业训练项目",
      team: "团队按产品设计、多格式解析、画布引擎、前后端开发、用户调研、财务测算和路演展示分工推进",
      brief: "FreeFlow 是面向高校创新创业团队、产品经理、设计师和内容创作者的多格式融合流式无限白板平台，核心目标是把 PDF、Word、图片、网页链接和会议记录转化为可协作、可检索、可导出的画布内容。",
      product: "多格式导入解析、无限画布、结构化卡片、AI 并行工作区、流程图/表格生成、多人协作、版本管理、Word/PDF/PPT 多格式导出",
      market: "高校创新创业团队、课程项目组、产品原型团队、设计协作团队、知识管理工作室和内容创作团队",
      finance: "研发成本、云端解析成本、协作存储成本、校园推广成本、模板与导出服务收入、团队版订阅收入按项目估算口径测算",
      evidence: "原型截图、多格式导入样例、用户访谈纪要、竞品对比表、导出文件样例、协作演示视频和版本迭代记录",
      referenceNotes: "未上传真实写法参考时，大创项目书采用八章结构：项目方案概述、项目团队概述、产业背景与项目产品、市场调查与竞争分析、商业模式与发展战略、预期效益分析、总结与资金回报和证明材料。",
      contestFileNotes: "大创创业训练项目书，强调项目背景、产品服务、商业模式、市场验证、财务测算、团队基础和证明材料。",
      attachmentNotes: "以原型截图、多格式导入样例、用户访谈纪要、竞品对比表、导出文件样例和协作演示视频作为附件口径。",
    },
    projectSignals: ["FreeFlow", "白板", "多格式", "画布", "协作", "导出", "结构化", "PDF", "Word"],
    minProjectSignals: 6,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|YOLO|跌倒|防摔|护理|老人|夜班护理员|跨境电商|外贸|手势识别|非接触隔空|执行摘要|二、项目优势|六、市场运营|十、未来展望|组队招募|队友申请|学院竞赛群|校级赛事|陌生同学组队|校园竞赛协作/g,
  },
  {
    label: "挑战杯 勿触",
    minChars: 18_000,
    config: {
      name: "__smoke_final_guard_tiaozhanbei__勿触非接触隔空操作中间件",
      template: "tiaozhanbei",
      competition: "tiaozhanbei",
      track: "挑战杯创业计划竞赛项目",
      team: "团队按视觉算法、终端 SDK、产品交互、公共场景调研、商务渠道、财务测算和答辩展示分工推进",
      brief: "勿触面向公共屏幕、自助终端、展陈互动、会议演示和医疗实验室等不便直接触摸设备的场景，建设基于普通摄像头的非接触隔空操作中间件。",
      product: "普通摄像头接入、手部与人体关键点识别、手势指令映射、终端控制 SDK、灵敏度校准、误触过滤、场景配置后台和接入示例",
      market: "公共终端运营方、展馆与会议空间管理者、医疗或实验室场景用户、餐饮自助设备商、智能硬件集成商",
      finance: "SDK 授权、终端项目制集成、设备商合作分成、年度运维、行业场景定制和培训支持按项目估算口径测算",
      evidence: "手势演示视频、识别测试表、公共终端场景图、SDK接口说明、用户体验反馈、误触分析表和竞品对比表",
      referenceNotes: "挑战杯创业计划竞赛项目书强调社会问题、产品方案、创新内容、市场验证、营销销售、运营管理、团队组织、财务融资、风险对策和附件证明。",
      contestFileNotes: "本项目不使用大创创业训练模板，也不套用养老防摔、RAG养老智能体或互联网+通用商业计划书旧稿。",
      attachmentNotes: "附件以演示视频、SDK接口说明、识别测试表、误触分析表、用户反馈和公共终端应用图作为证明材料口径。",
    },
    projectSignals: ["勿触", "非接触", "隔空", "手势", "中间件", "SDK", "终端", "误触", "摄像头"],
    minProjectSignals: 6,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|老人|护理|YOLO|跌倒|防摔|FreeFlow|白板|跨境电商|外贸|商品页|执行摘要|五、营销策略及销售|十、发展战略与前景|十一、附件与证明材料|组队招募|队友申请|学院竞赛群|校级赛事|陌生同学组队|校园竞赛协作/g,
  },
  {
    label: "互联网+ 跨境电商",
    minChars: 18_000,
    config: {
      name: "__smoke_final_guard_internet_plus__数驭全球跨境电商大模型智慧服务平台",
      template: "internet-plus",
      competition: "internet-plus",
      track: "中国国际大学生创新大赛商业计划书",
      team: "团队按大模型应用、跨境运营、产品设计、市场调研、财务测算、企业访谈和路演视频分工推进",
      brief: "数驭全球面向县域中小企业、合作社和跨境运营团队，提供多语言商品内容、海外市场调研、店铺运营、智能客服和合规资料整理服务。",
      product: "多语言内容生成、选品与市场分析、跨境店铺运营助手、智能客服、合规资料库、数据看板、企业资料库和运营任务工作台",
      market: "县域中小企业、合作社农品品牌、跨境电商运营人员、外贸服务机构、海外采购商和地方产业带服务组织",
      finance: "SaaS订阅、代运营服务费、企业培训费、店铺搭建费、成交佣金和行业解决方案授权按项目估算口径测算",
      evidence: "企业访谈纪要、商品资料样例、多语言页面截图、竞品店铺分析、运营流程表、模拟询盘记录和财务测算表",
      referenceNotes: "互联网+商业计划书采用项目概要、行业痛点、解决方案、技术创新、市场验证、商业模式、运营推广、团队资源、财务融资和风险控制结构。",
      contestFileNotes: "本项目不沿用大创或挑战杯标题体系，也不复用养老防摔、非接触中间件或白板协作项目内容。",
      attachmentNotes: "附件以企业访谈、商品资料样例、多语言页面、店铺竞品分析、运营流程和模拟询盘记录作为证明材料口径。",
    },
    projectSignals: ["数驭全球", "跨境", "电商", "外贸", "多语言", "商品", "店铺", "客服", "询盘"],
    minProjectSignals: 6,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /养老|老人|护理|YOLO|跌倒|防摔|FreeFlow|白板|非接触|隔空|手势|中间件|执行摘要|项目概要|行业痛点与创业机会|运营推广与增长策略|路演呈现与附件材料|组队招募|队友申请|学院竞赛群|校级赛事|陌生同学组队|校园竞赛协作/g,
  },
  {
    label: "大创 养老防摔",
    minChars: 18_000,
    config: {
      name: "__smoke_final_guard_dachuang__基于yolo11n的老年人防摔系统",
      template: "dachuang",
      competition: "dachuang",
      track: "银发经济",
      team: "团队按视觉算法、养老场景调研、产品原型、隐私合规、财务测算和申报展示分工推进",
      brief: "面向养老院、社区日间照料中心和居家养老场景，建设基于 YOLO11 的无感式跌倒预警与事件留痕系统，帮助护理人员及时发现疑似跌倒并形成可追溯记录。",
      product: "视频接入、YOLO11人体检测、姿态与地面区域判断、连续帧静止确认、护理端分级告警、后台事件台账、误报漏报样本回流和隐私授权管理",
      market: "养老机构、社区养老服务中心、居家养老服务商、智慧养老平台集成商和老人家属",
      finance: "按点位部署费、年度运维费、社区/居家养老订阅、SDK/API算法授权和大型机构定制开发按团队估算口径测算",
      evidence: "跌倒检测演示视频、误报漏报分析表、护理人员访谈纪要、摄像头点位清单、后台事件台账截图和隐私授权说明",
      referenceNotes: "未上传真实写法参考时，大创项目书采用八章结构，不复用其他项目文章内容。",
      contestFileNotes: "本项目必须围绕养老防摔、视觉检测、护理告警和事件台账展开。",
      attachmentNotes: "附件以演示视频、误报漏报分析、护理访谈、点位清单、台账截图和隐私授权说明作为证明材料口径。",
    },
    projectSignals: ["YOLO11", "跌倒", "防摔", "护理", "养老", "告警", "事件台账", "误报", "摄像头"],
    minProjectSignals: 6,
    chapterSignals: DEFAULT_BOOK_CHAPTERS,
    minChapterSignals: 8,
    forbidden: /FreeFlow|白板|跨境电商|外贸|商品页|非接触|隔空|手势|中间件|执行摘要|组队招募|队友申请|学院竞赛群|创新创业社团|课程项目组|校级赛事|陌生同学组队|校园竞赛协作|优秀队伍|发布-匹配-沟通|匹配流程图|招募帖样例/g,
  },
  {
    label: "大创 YOLOv8版本保真",
    minChars: 18_000,
    config: {
      name: "__smoke_final_guard_dachuang__基于yolov8的老年人防摔报警器",
      template: "dachuang",
      competition: "dachuang",
      track: "银发经济",
      team: "团队按视觉算法、嵌入式报警、护理场景调研、产品原型、财务测算和申报展示分工推进",
      brief: "面向老年人居家和机构照护场景，建设基于 YOLOv8 的防摔报警器，重点完成跌倒识别、风险提醒、事件记录和护理通知。",
      product: "YOLOv8人体检测、姿态判断、跌倒报警、护理端通知、后台事件记录、误报样本复盘和隐私授权说明",
      market: "居家养老家庭、社区养老服务站、养老机构、智慧养老平台集成商和老人家属",
      finance: "设备试点、原型开发、年度运维、报警服务订阅和平台接口授权按团队估算口径测算",
      evidence: "报警器原型截图、YOLOv8测试记录、护理访谈纪要、误报分析表、事件记录截图和隐私授权说明",
    },
    projectSignals: ["YOLOv8", "防摔", "报警", "护理", "跌倒", "事件记录", "姿态", "人体检测"],
    minProjectSignals: 6,
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
  fail("Final manuscript guard smoke failed: test server did not become healthy.", {
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
    fail(`Final manuscript guard smoke failed (${testLabel}): ${label}.`, {
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
    fail(`Final manuscript guard smoke failed (${testLabel}): empty markdown headings leaked into final manuscript.`, {
      headings: empty.slice(0, 20),
    });
  }
}

function assertContainsSignals(text, signals, minimum, label, testLabel) {
  const hits = signals.filter((signal) => text.includes(signal));
  if (hits.length < minimum) {
    fail(`Final manuscript guard smoke failed (${testLabel}): missing ${label}.`, {
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
    ["数字化表达", metrics.numericSignals >= 18, metrics.numericSignals],
    ["证据材料表达", metrics.evidenceSignals >= 8, metrics.evidenceSignals],
    ["商业/财务表达", metrics.businessSignals >= 6, metrics.businessSignals],
    ["整段重复控制", metrics.duplicateParagraphs <= 1, metrics.duplicateParagraphs],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) {
    fail(`Final manuscript guard smoke failed (${testLabel}): manuscript does not look like a complete competition project book.`, {
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
      fail(`Final manuscript guard smoke failed (${testCase.label}): final manuscript is too short for a complete project book.`, {
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
      "complete competition chapter structure",
      testCase.label,
    );

    assertNoMatches(manuscript, testCase.forbidden, "cross-project contamination found in final manuscript", testCase.label);
    assertNoMatches(manuscript, LEGACY_COMPETITION_CHAPTERS, "legacy competition chapter structure leaked into no-reference manuscript", testCase.label);
    assertNoMatches(manuscript, INTERNAL_WORDING, "internal/advice wording leaked into final manuscript", testCase.label);
    assertNoMatches(manuscript, FORMAT_LEAKS, "title or cover format leakage found in final manuscript", testCase.label);
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
      console.error(`Keeping smoke workflow for inspection: ${workflowId}`);
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
        `Final manuscript guard smoke passed (${result.label}). chars=${result.chars}, projectSignals=${result.projectSignals.join("/")}, chapterSignals=${result.chapterSignals}, h2=${result.realism.h2}, h3=${result.realism.h3}, tables=${result.realism.tableLines}, figures=${result.realism.figureSignals}`,
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
