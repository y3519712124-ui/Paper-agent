import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const serverDir = join(rootDir, "server");
const smokeHomeDir = join(rootDir, ".tmp", "smoke-project-book-audit-home");
const ID = "__smoke_project_book_audit_blueprint__";

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
  fail("Audit blueprint smoke failed: test server did not become healthy.", {
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
        track: "测试赛道",
        team: "按任务推进",
        brief: "测试审计蓝图产物是否真正生成",
        product: "测试系统",
        market: "测试用户",
        evidence: "测试材料",
        pageLimit: "20",
        reviewMode: "strict",
        autoAdvance: true,
        humanCheckpoint: false,
        revisionLoop: true,
      }),
    });

    await request(baseUrl, `/api/workflows/${encodeId(ID)}/start`, {
      method: "POST",
      timeoutMs: 300_000,
    });

    const auditBlueprint = String((await readWorkflowFile(baseUrl, ID, ".paper/artifacts/00-project-book-audit-blueprint.md")).content || "");
    const finalBook = String((await readWorkflowFile(baseUrl, ID, ".paper/drafts/project-book-final.md")).content || "");

    if (!auditBlueprint.includes("project-book-audit-loop") && !auditBlueprint.includes("项目书审计蓝图")) {
      fail("Audit blueprint smoke failed: audit blueprint artifact was not generated correctly.");
    }
    if (!finalBook.length) {
      fail("Audit blueprint smoke failed: final manuscript was not generated.");
    }

    await cleanup(baseUrl, ID);
    console.log(`Audit blueprint smoke passed. auditChars=${auditBlueprint.length}, finalChars=${finalBook.length}`);
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
