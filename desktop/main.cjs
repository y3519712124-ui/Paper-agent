const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PAPER_AGENT_PORT || 3456);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const isPackaged = app.isPackaged;
let serverProcess = null;
let mainWindow = null;

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
    ? resourcePath("server-dist", "index.js")
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

function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Keep waiting while the local server starts.
      }
      if (Date.now() > deadline) {
        reject(new Error("Paper-agent 后端启动超时"));
        return;
      }
      setTimeout(tick, 450);
    };
    tick();
  });
}

function startServer() {
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
    PYTHONPATH: pythonRootPath(),
  };

  const logDir = app.getPath("userData");
  const outLog = fs.openSync(path.join(logDir, "server.log"), "a");
  const errLog = fs.openSync(path.join(logDir, "server.err.log"), "a");

  serverProcess = spawn(process.execPath, args, {
    cwd: serverDir,
    env,
    windowsHide: true,
    stdio: ["ignore", outLog, errLog],
  });

  serverProcess.on("exit", () => {
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

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
