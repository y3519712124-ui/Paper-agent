const BASE_URL = process.env.PAPER_AGENT_URL || "http://localhost:3456";

const cases = [
  {
    name: "计小帅 AI辅导员分层嵌套智能体",
    template: "dachuang",
    expectedProfile: "ai-counselor-agent",
    forbiddenRiskLabels: ["养老/护理方向", "农业/种植方向", "低空/无人机方向"],
  },
  {
    name: "花境云伺 智能花卉监测与智慧养护解决方案",
    template: "dachuang",
    expectedProfile: "smart-flower-care",
    forbiddenRiskLabels: ["农业/种植方向", "养老/护理方向"],
  },
  {
    name: "湖湘非遗纹样数字化提取与轻量化素材库",
    template: "dachuang",
    expectedProfile: "intangible-pattern-library",
    forbiddenRiskLabels: ["农业/种植方向", "养老/护理方向"],
  },
  {
    name: "影巢 NAS 家庭个性化影音定制服务平台",
    template: "dachuang",
    expectedProfile: "home-nas-media",
    forbiddenRiskLabels: ["养老/护理方向", "农业/种植方向"],
  },
  {
    name: "勿触 非接触隔空操作中间件",
    template: "dachuang",
    expectedProfile: "touchless-interaction",
    forbiddenRiskLabels: ["养老/护理方向", "图书馆预约方向"],
  },
  {
    name: "智炼 智能哑铃姿态识别力量训练纠正系统",
    template: "dachuang",
    expectedProfile: "smart-fitness-coach",
    forbiddenRiskLabels: ["养老/护理方向", "农业/种植方向"],
  },
  {
    name: "基于无人地无人机协同的蜂群矩阵系统",
    template: "internet-plus",
    track: "低空经济",
    expectedProfile: "low-altitude-drone-swarm",
    forbiddenRiskLabels: ["养老/护理方向", "图书馆预约方向"],
  },
  {
    name: "基于SAR场景的超路由元适应检测网络",
    template: "dachuang",
    track: "低空经济",
    expectedProfile: "sar-hmad-detection",
    forbiddenRiskLabels: ["蜂群/低空平台串项", "养老/护理方向", "农业/种植方向"],
    extraBody:
      "本项目提出Hyper Route Meta-Adaptive Detection Network（HMAD-Ednet），面向无人机搜救场景中小目标人员检测困难、跨地域跨季节泛化不足等问题，构建多专家检测、场景路由与Reptile元学习优化的一体化检测网络。参考材料包含Phase A路由准确率、Phase B元适应得分、mAP、Precision、Recall、F1、路由收益验证和复杂植被航拍搜救样例。",
  },
  {
    name: "基于RAG检索的养老智能体",
    template: "tiaozhanbei",
    expectedProfile: "elder-care-rag-agent",
    forbiddenRiskLabels: ["低空/无人机方向", "农业/种植方向"],
  },
];

const SMOKE_PREFIX = "__smoke_profile_quality__ ";

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

async function ensureCaseProject(testCase) {
  const id = `${SMOKE_PREFIX}${testCase.name}`;
  try {
    await request(`/api/workflows/${encodeId(id)}`, { method: "DELETE" });
  } catch {
    // Project may not exist.
  }
  await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: id,
      template: testCase.template,
      competition: testCase.template,
      track: testCase.track || "",
      autoAdvance: false,
      humanCheckpoint: false,
      revisionLoop: false,
    }),
  });
  return id;
}

async function writeMinimalFinalBook(id, testCase) {
  const body = [
    `# ${testCase.name}项目书`,
    "",
    "## 执行摘要",
    `${testCase.name}围绕真实用户场景展开，本文用于画像与质量接口回归测试。`,
    "",
    "## 一、项目概述",
    `${testCase.name}需要形成项目定位、用户场景、产品模块、技术路线、商业模式和证明材料闭环。`,
    "",
    "## 二、产品与服务",
    "本节保留项目专属关键词，便于质量体检识别正确画像，不混入其他项目旧内容。",
    testCase.extraBody || "",
    "",
    "## 三、市场与运营",
    "正文采用公开资料口径、项目估算口径、原型测试口径和用户材料口径形成。",
    "",
    "## 四、风险与证明材料",
    "附件包括访谈记录、测试记录、原型截图、财务测算表和团队分工材料。",
  ].join("\n");
  await request(`/api/workflows/${encodeId(id)}/file`, {
    method: "PUT",
    body: JSON.stringify({
      path: ".paper/drafts/project-book-final.md",
      content: body,
    }),
  });
}

async function run() {
  await request("/api/health");
  const rows = [];
  const createdIds = [];
  for (const testCase of cases) {
    const id = await ensureCaseProject(testCase);
    createdIds.push(id);
    try {
      await writeMinimalFinalBook(id, testCase);
      const quality = await request(`/api/workflows/${encodeId(id)}/quality`);
      const profileId = quality.profile?.id || "";
      const risky = (quality.contamination || []).filter((item) => item.risky);
      const forbiddenRisk = risky.find((item) => testCase.forbiddenRiskLabels.includes(item.label));
      const ok = profileId === testCase.expectedProfile && !forbiddenRisk;
      rows.push({
        ok,
        name: testCase.name,
        expected: testCase.expectedProfile,
        actual: profileId,
        score: quality.score,
        risky: risky.map((item) => `${item.label}:${item.count}`).join("、") || "0",
      });
    } finally {
      await request(`/api/workflows/${encodeId(id)}`, { method: "DELETE" }).catch(() => {});
    }
  }

  console.table(rows);
  const failed = rows.filter((row) => !row.ok);
  if (failed.length) {
    await Promise.all(createdIds.map((id) => request(`/api/workflows/${encodeId(id)}`, { method: "DELETE" }).catch(() => {})));
    console.error(`Profile quality smoke failed: ${failed.length}/${rows.length}`);
    process.exit(1);
  }
  console.log(`Profile quality smoke passed: ${rows.length}/${rows.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
