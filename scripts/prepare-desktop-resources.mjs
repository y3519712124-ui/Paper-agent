import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const latexSource =
  process.env.PAPER_CODEX_LATEX_PLUGIN_ROOT ||
  join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "latex", "0.2.2");
const latexTarget = join(root, "desktop", "resources", "codex-latex");
const pythonSource =
  process.env.PAPER_DESKTOP_PYTHON_ROOT ||
  process.env.PAPER_PYTHON_ROOT ||
  join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python");
const pythonTarget = join(root, "desktop", "resources", "runtime", "python");

rmSync(latexTarget, { recursive: true, force: true });
mkdirSync(latexTarget, { recursive: true });

if (existsSync(latexSource)) {
  cpSync(latexSource, latexTarget, { recursive: true });
  console.log(`Prepared Codex LaTeX plugin from ${latexSource}`);
} else {
  const scriptsDir = join(latexTarget, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(latexTarget, "README.md"),
    [
      "# Codex LaTeX Runtime Placeholder",
      "",
      "The full Codex LaTeX plugin was not present while this desktop package was built.",
      "LaTeX source export still works, but direct PDF compilation requires a system TeX compiler or the full plugin bundle.",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(scriptsDir, "compile_latex.py"),
    [
      "import json",
      "import sys",
      "",
      "print(json.dumps({",
      "    'ok': False,",
      "    'error': 'Codex LaTeX plugin runtime was not bundled in this build.'",
      "}, ensure_ascii=False))",
      "sys.exit(1)",
      "",
    ].join("\n"),
    "utf-8",
  );
  console.warn(`Codex LaTeX plugin not found at ${latexSource}; wrote placeholder runtime.`);
}

rmSync(pythonTarget, { recursive: true, force: true });

if (process.platform === "win32" && existsSync(pythonSource)) {
  mkdirSync(pythonTarget, { recursive: true });
  cpSync(pythonSource, pythonTarget, { recursive: true });
  console.log(`Prepared Windows Python runtime from ${pythonSource}`);
} else {
  mkdirSync(pythonTarget, { recursive: true });
  writeFileSync(
    join(pythonTarget, "README.md"),
    [
      "# Python Runtime Placeholder",
      "",
      "A bundled Python runtime was not available while preparing desktop resources.",
      "The desktop app will fall back to system `python` or `python3` when no bundled runtime exists.",
      "For a self-contained Windows installer, set `PAPER_DESKTOP_PYTHON_ROOT` to a Python runtime directory before packaging.",
      "",
    ].join("\n"),
    "utf-8",
  );
  console.warn(`Python runtime not found at ${pythonSource}; wrote placeholder runtime.`);
}
