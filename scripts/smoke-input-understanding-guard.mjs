import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverDir = join(rootDir, "server");
const smokeHomeDir = join(rootDir, ".tmp", "smoke-input-understanding-home");
const ID = "__smoke_input_understanding_guard__";
const SENTINEL = "__RAW_PARAMETER_SENTENCE_SHOULD_NOT_APPEAR_IN_FINAL_BOOK__";

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
  fail("Input understanding smoke failed: test server did not become healthy.", {
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

async function readWorkflowFile(baseUrl, id, path) {
  return request(
    baseUrl,
    `/api/workflows/${encodeId(id)}/file?path=${encodeURIComponent(path)}`,
    { timeoutMs: 15_000 },
  );
}

function longRawParagraph(label) {
  return [
    `${label} ${SENTINEL}`,
    "这是一段故意很长的参数框原文，用来模拟用户把半成品文章直接粘贴进新建页。",
    "如果工作流没有理解层，最终项目书会原样复制这句话，从而暴露模板拼贴和人机化问题。",
    "这里还混入若干无意义短语：蓝色章鱼式增长、虚构银河客户、三十秒拿下全国市场。",
  ].join(" ");
}

async function run() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);

  try {
    await waitForHealth(baseUrl, server.logs);
    await cleanup(baseUrl, ID);
    await request(baseUrl, "/api/workflows", {
      method: "POST",
      timeoutMs: 15_000,
      body: JSON.stringify({
        name: ID,
        template: "dachuang",
        competition: "dachuang",
        track: "校园竞赛协作与学生项目服务",
        team: "产品、前端、后端、调研、财务、材料分工明确",
        brief: longRawParagraph("想法与场景素材"),
        product: longRawParagraph("技术与产品素材"),
        market: longRawParagraph("市场与商业素材"),
        finance: longRawParagraph("资金与财务素材"),
        evidence: longRawParagraph("证明材料素材"),
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
      }),
    });

    await request(baseUrl, `/api/workflows/${encodeId(ID)}/start`, {
      method: "POST",
      timeoutMs: 300_000,
    });

    const understanding = String((await readWorkflowFile(baseUrl, ID, ".paper/artifacts/00-input-understanding.md")).content || "");
    const skillBlueprint = String((await readWorkflowFile(baseUrl, ID, ".paper/artifacts/00-competition-skill-blueprint.md")).content || "");
    const finalBook = String((await readWorkflowFile(baseUrl, ID, ".paper/drafts/project-book-final.md")).content || "");

    if (!understanding.includes("项目素材理解摘要") || !understanding.includes("不得把新建页参数框中的长段原文直接复制到最终正文")) {
      fail("Input understanding smoke failed: understanding artifact is missing copy-prevention rules.");
    }
    if (!skillBlueprint.includes("竞赛技能蓝图") || !skillBlueprint.includes("生成前的竞赛专项约束层") || !skillBlueprint.includes("评分点覆盖矩阵")) {
      fail("Input understanding smoke failed: competition skill blueprint artifact is missing.");
    }
    if (finalBook.includes(SENTINEL)) {
      fail("Input understanding smoke failed: raw parameter sentinel leaked into final manuscript.");
    }
    for (const leak of ["项目素材理解摘要", "参数使用边界", "理解结果", "写作转化规则", "竞赛技能蓝图", "评分点覆盖矩阵", "章节自评", "遗漏点", "六层生成管线", "致命风险控制"]) {
      if (finalBook.includes(leak)) {
        fail("Input understanding smoke failed: internal understanding label leaked into final manuscript.", { leak });
      }
    }
    await cleanup(baseUrl, ID);
    console.log(`Input understanding smoke passed. finalChars=${finalBook.length}, understandingChars=${understanding.length}`);
  } catch (error) {
    console.error(server.logs.join("").slice(-3000));
    throw error;
  } finally {
    stopServer(server.child);
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
