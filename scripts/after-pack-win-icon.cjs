const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = join(context.appOutDir, "Paper-agent.exe");
  const iconPath = resolve(context.packager.projectDir, "build", "icon.ico");
  const rceditPath = join(
    process.env.LOCALAPPDATA || "",
    "electron-builder",
    "Cache",
    "winCodeSign",
    "winCodeSign-2.6.0",
    "rcedit-x64.exe",
  );

  if (!existsSync(exePath)) {
    throw new Error(`Paper-agent executable not found: ${exePath}`);
  }
  if (!existsSync(iconPath)) {
    throw new Error(`Windows icon not found: ${iconPath}`);
  }
  if (!existsSync(rceditPath)) {
    throw new Error(`rcedit not found: ${rceditPath}`);
  }

  const result = spawnSync(
    rceditPath,
    [
      exePath,
      "--set-version-string",
      "FileDescription",
      "AI-assisted project proposal writing and export workspace",
      "--set-version-string",
      "ProductName",
      "Paper-agent",
      "--set-version-string",
      "LegalCopyright",
      "Copyright 2026 Paper-agent contributors",
      "--set-file-version",
      "0.1.0",
      "--set-product-version",
      "0.1.0.0",
      "--set-version-string",
      "InternalName",
      "Paper-agent",
      "--set-version-string",
      "OriginalFilename",
      "Paper-agent.exe",
      "--set-version-string",
      "CompanyName",
      "Paper-agent contributors",
      "--set-icon",
      iconPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.warn([
      `afterPack rcedit failed: status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
};
