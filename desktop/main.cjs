const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PAPER_AGENT_PORT || 3456);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const isPackaged = app.isPackaged;
let serverProcess = null;
let serverExit = null;
let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function resourcePath(...segments) {
  return isPackaged
    ? path.join(process.resourcesPath, "app-resources", ...segments)
    : path.join(__dirname, "..", ...segments);
}

function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

function serverEntryPath() {
  return isPackaged
    ? resourcePath("server-dist", "index.cjs")
    : resourcePath("server", "index.ts");
}

function serverCwdPath() {
  return isPackaged ? resourcePath("server-dist") : resourcePath("server");
}

function frontendDistPath() {
  return resourcePath("frontend", "dist");
}

function pythonRootPath() {
  return resourcePath("python");
}

function pythonExePath() {
  const bundledCandidates = process.platform === "win32"
    ? [resourcePath("runtime", "python", "python.exe")]
    : [
        resourcePath("runtime", "python", "bin", "python3"),
        resourcePath("runtime", "python", "bin", "python"),
      ];
  return firstExistingPath(bundledCandidates) || (process.platform === "win32" ? "python" : "python3");
}

function codexLatexPluginPath() {
  return resourcePath("codex-latex");
}

function challengeCupSkillPath() {
  return resourcePath("skills", "challenge-cup-project-book");
}

function appIconPath() {
  return isPackaged
    ? path.join(process.resourcesPath, "app.asar", "build", "icon.ico")
    : path.join(__dirname, "..", "build", "icon.ico");
}

function serverLogPaths() {
  const logDir = app.getPath("userData");
  return {
    out: path.join(logDir, "server.log"),
    err: path.join(logDir, "server.err.log"),
  };
}

function readLogTail(filePath, maxChars = 6000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(-maxChars).trim();
  } catch {
    return "";
  }
}

function serverFailureMessage(reason) {
  const logs = serverLogPaths();
  const errTail = readLogTail(logs.err);
  const outTail = readLogTail(logs.out, 2000);
  const parts = [
    reason,
    "",
    `后端入口：${serverEntryPath()}`,
    `错误日志：${logs.err}`,
  ];
  if (errTail) parts.push("", "最近错误：", errTail);
  if (!errTail && outTail) parts.push("", "最近输出：", outTail);
  return parts.join("\n");
}

function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const onExit = ({ code, signal }) => {
      finish(
        reject,
        new Error(serverFailureMessage(`Paper-agent 后端已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`)),
      );
    };

    if (serverExit) {
      onExit(serverExit);
      return;
    }
    if (serverProcess) serverProcess.once("exit", onExit);

    const tick = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (response.ok) {
          if (serverProcess) serverProcess.off("exit", onExit);
          finish(resolve);
          return;
        }
      } catch {
        // Keep waiting while the local server starts.
      }
      if (Date.now() > deadline) {
        if (serverProcess) serverProcess.off("exit", onExit);
        finish(reject, new Error(serverFailureMessage("Paper-agent 后端启动超时")));
        return;
      }
      setTimeout(tick, 450);
    };
    tick();
  });
}

function startServer() {
  serverExit = null;
  const serverEntry = serverEntryPath();
  const serverDir = serverCwdPath();
  const args = isPackaged
    ? [serverEntry]
    : [path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs"), serverEntry];
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(PORT),
    PAPER_FRONTEND_DIST: frontendDistPath(),
    PAPER_PYTHON: pythonExePath(),
    PAPER_CODEX_LATEX_PLUGIN_ROOT: codexLatexPluginPath(),
    PAPER_CHALLENGE_CUP_SKILL_ROOT: challengeCupSkillPath(),
    PAPER_PROJECT_BOOK_AUDIT_SKILL_ROOT: resourcePath("skills", "project-book-audit-loop"),
    PYTHONPATH: pythonRootPath(),
  };

  const logs = serverLogPaths();
  fs.mkdirSync(path.dirname(logs.out), { recursive: true });
  fs.appendFileSync(logs.out, `\n\n[${new Date().toISOString()}] starting ${serverEntry}\n`);
  fs.appendFileSync(logs.err, `\n\n[${new Date().toISOString()}] starting ${serverEntry}\n`);
  const outLog = fs.openSync(logs.out, "a");
  const errLog = fs.openSync(logs.err, "a");

  serverProcess = spawn(process.execPath, args, {
    cwd: serverDir,
    env,
    windowsHide: true,
    stdio: ["ignore", outLog, errLog],
  });

  serverProcess.on("error", (error) => {
    serverExit = { code: null, signal: null };
    fs.appendFileSync(logs.err, `\n[${new Date().toISOString()}] spawn error: ${error.message}\n`);
  });

  serverProcess.on("exit", (code, signal) => {
    serverExit = { code, signal };
    serverProcess = null;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f6f4ef",
    title: "Paper-agent",
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL) || url.startsWith(`http://localhost:${PORT}/`)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(APP_URL);
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  try {
    startServer();
    await waitForServer();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("Paper-agent 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
