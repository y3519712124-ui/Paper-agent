import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const skillSource =
  process.env.PAPER_CHALLENGE_CUP_SKILL_ROOT ||
  join(root, ".codex", "skills", "challenge-cup-project-book");
const skillTarget = join(root, "desktop", "resources", "skills", "challenge-cup-project-book");
const auditSkillSource =
  process.env.PAPER_PROJECT_BOOK_AUDIT_SKILL_ROOT ||
  join(root, ".codex", "skills", "project-book-audit-loop");
const auditSkillTarget = join(root, "desktop", "resources", "skills", "project-book-audit-loop");

// ── site-packages allowlist ──────────────────────────────────────────────
// Only packages actually imported by python/paper_agent/export/* are kept.
// Everything else (pandas, numpy, artifact_tool_v2, pydantic, etc.) is removed
// to shrink the desktop installer from ~384 MB to ~70 MB.
//
// Allowlist rationale:
//   docx          – Word export (python-docx)
//   lxml          – python-docx hard dependency (XML parsing)
//   reportlab     – PDF export
//   PIL, pillow   – Image generation for PDF covers + reportlab dependency
//   charset_normalizer – reportlab dependency
//   typing_extensions  – python-docx dependency
//   packaging     – reportlab internal usage
const ALLOWED_SITE_PACKAGES = new Set([
  // Direct dependencies
  "docx",
  "lxml",
  "reportlab",
  "PIL",
  // Transitive dependencies
  "charset_normalizer",
  "typing_extensions",
  "packaging",
]);

/** Prefix match – matches `foo`, `foo-1.2.0.dist-info`, `foo.libs`, `foo.py` etc. */
function isAllowedSitePackage(name) {
  if (ALLOWED_SITE_PACKAGES.has(name)) return true;
  // Handle dist-info / libs / data / .py / .pth suffixes
  const cleanName = name
    .replace(/\.dist-info$/, "")
    .replace(/\.libs$/, "")
    .replace(/\.data$/, "")
    .replace(/\.py$/, "")
    .replace(/\.pth$/, "")
    .replace(/\.pyd$/, "")
    .replace(/[-_]\d.*$/, ""); // strip version suffix
  for (const allowed of ALLOWED_SITE_PACKAGES) {
    if (cleanName === allowed) return true;
    // python_docx → docx, python_dateutil → dateutil
    const normalized = cleanName.replace(/^python_/, "");
    if (normalized === allowed) return true;
  }
  return false;
}

// ── helpers ───────────────────────────────────────────────────────────────

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function assertNonEmptyDirectory(target, label) {
  if (!existsSync(target) || !statSync(target).isDirectory() || readdirSync(target).length === 0) {
    throw new Error(`${label} was prepared as an empty directory: ${target}`);
  }
}

/** Remove entries from site-packages that are not on the allowlist. */
function pruneSitePackages(sitePkgsDir) {
  const entries = readdirSync(sitePkgsDir, { withFileTypes: true });
  let removedBytes = 0;
  let removedCount = 0;
  for (const entry of entries) {
    if (!isAllowedSitePackage(entry.name)) {
      const full = join(sitePkgsDir, entry.name);
      if (entry.isDirectory()) {
        const size = dirSize(full);
        rmSync(full, { recursive: true, force: true });
        removedBytes += size;
      } else {
        removedBytes += statSync(full).size;
        rmSync(full);
      }
      removedCount++;
    }
  }
  return { removedCount, removedBytes };
}

function dirSize(dirPath) {
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── LaTeX plugin ──────────────────────────────────────────────────────────

rmSync(latexTarget, { recursive: true, force: true });
mkdirSync(latexTarget, { recursive: true });

if (existsSync(latexSource)) {
  copyDirectory(latexSource, latexTarget);
  assertNonEmptyDirectory(latexTarget, "Codex LaTeX plugin");
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
    join(latexTarget, "scripts", "compile_latex.py"),
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

// ── Python runtime ───────────────────────────────────────────────────────

rmSync(pythonTarget, { recursive: true, force: true });

if (process.platform === "win32" && existsSync(pythonSource)) {
  mkdirSync(pythonTarget, { recursive: true });
  copyDirectory(pythonSource, pythonTarget);
  assertNonEmptyDirectory(pythonTarget, "Windows Python runtime");

  // Prune unused site-packages to shrink the installer
  const sitePkgsDir = join(pythonTarget, "Lib", "site-packages");
  if (existsSync(sitePkgsDir)) {
    const { removedCount, removedBytes } = pruneSitePackages(sitePkgsDir);
    console.log(
      `[prune] Removed ${removedCount} unused packages (${formatBytes(removedBytes)}) from site-packages`,
    );
  } else {
    console.warn(`site-packages not found at ${sitePkgsDir}; skipping prune.`);
  }

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

// ── Competition project-book skill ───────────────────────────────────────

rmSync(skillTarget, { recursive: true, force: true });
mkdirSync(skillTarget, { recursive: true });

if (existsSync(skillSource)) {
  copyDirectory(skillSource, skillTarget);
  assertNonEmptyDirectory(skillTarget, "Challenge Cup project-book skill");
  console.log(`Prepared challenge-cup-project-book skill from ${skillSource}`);
} else {
  writeFileSync(
    join(skillTarget, "SKILL.md"),
    [
      "# challenge-cup-project-book",
      "",
      "Fallback skill placeholder. Build-time skill source was not found.",
      "The server will still use its compact built-in rules, but generated output may be weaker.",
      "",
    ].join("\n"),
    "utf-8",
  );
  console.warn(`challenge-cup-project-book skill not found at ${skillSource}; wrote placeholder skill.`);
}

// Project-book audit loop skill
rmSync(auditSkillTarget, { recursive: true, force: true });
mkdirSync(auditSkillTarget, { recursive: true });

if (existsSync(auditSkillSource)) {
  copyDirectory(auditSkillSource, auditSkillTarget);
  assertNonEmptyDirectory(auditSkillTarget, "Project book audit loop skill");
  console.log(`Prepared project-book-audit-loop skill from ${auditSkillSource}`);
} else {
  writeFileSync(
    join(auditSkillTarget, "SKILL.md"),
    [
      "# project-book-audit-loop",
      "",
      "Fallback audit skill placeholder. Build-time skill source was not found.",
      "The server will still use its built-in audit loop, but iteration quality may be weaker.",
      "",
    ].join("\n"),
    "utf-8",
  );
  console.warn(`project-book-audit-loop skill not found at ${auditSkillSource}; wrote placeholder skill.`);
}
