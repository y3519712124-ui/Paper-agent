# Paper-agent

Paper-agent is a desktop and CLI tool for generating, reviewing, editing, and exporting Chinese university competition project books. It is designed for workflows such as 大创, 挑战杯, 互联网+ and similar proposal-writing scenarios where structure, evidence, writing style, and final document formatting all matter.

The project combines a React editor, an Express workflow backend, TypeScript CLI agents, and Python exporters for DOCX/PDF output. The goal is not to provide a single generic AI template, but to help teams turn project facts, uploaded references, review comments, and competition requirements into a complete project book with traceable workflow steps.

## Features

- Multi-step project-book workflow for project setup, drafting, review, polishing, export, and delivery checks.
- Reference-aware writing rules: uploaded reference documents drive structure and style; unrelated historical samples are not treated as templates.
- Local project workspace under `.paper`, with drafts, artifacts, checkpoints, backups, and exports.
- Built-in editor for Markdown and LaTeX-oriented editing, with DOCX/PDF/TeX export paths.
- Python-based document export helpers for Word and PDF formatting.
- Desktop packaging through Electron for Windows, Linux, and macOS.
- GitHub Actions workflow for building macOS `.dmg` and `.zip` artifacts on a macOS runner.

## Project Structure

```text
Paper-agent/
  frontend/        React web UI
  server/          Express API server and workflow routes
  src/             CLI, core agent runtime, templates, LLM bridge
  python/          Python bridge and DOCX/PDF export helpers
  agents/          Agent definitions
  teams/           Workflow/team presets
  templates/       Competition templates
  desktop/         Electron wrapper
  scripts/         Build and smoke-test scripts
  .github/         GitHub Actions workflows
```

## Requirements

- Node.js 22 or newer is recommended for desktop builds.
- Python 3.10 or newer is recommended for DOCX/PDF export.
- For desktop packaging, install dependencies in the root project, `frontend`, and `server`.

```bash
npm ci
cd frontend && npm ci
cd ../server && npm ci
cd ..
python -m pip install -r python/requirements.txt
```

## Development

Start the existing local web workflow with the server and frontend used by the project. The desktop wrapper opens the same local application at `http://127.0.0.1:3456/`.

```bash
npm run build:desktop
npm run test
```

The current repository also includes focused smoke tests:

```bash
npm run smoke:generation
npm run smoke:export-format
npm run smoke:final-guard
```

## Desktop Packaging

Windows:

```bash
npm run pack:win
```

Linux:

```bash
npm run pack:linux
```

macOS must be built on macOS:

```bash
npm run pack:mac
```

The repository includes `.github/workflows/build-macos.yml`. After pushing to GitHub, open the repository Actions page, choose `Build macOS Desktop`, and run the workflow manually. The workflow uploads a `paper-agent-macos` artifact containing the generated macOS package files.

## Optional Desktop Resources

`scripts/prepare-desktop-resources.mjs` prepares optional local runtime resources before desktop packaging:

- Codex LaTeX plugin runtime, if available.
- Windows Python runtime, if `PAPER_DESKTOP_PYTHON_ROOT` or `PAPER_PYTHON_ROOT` points to a Python runtime folder.

If these resources are not present, placeholder folders are generated and the app falls back to system Python where possible.

## Notes on Reference Documents

Paper-agent should only use user-uploaded reference documents as writing-structure references. Other projects, old local samples, unrelated directories, and historical test documents must not be used as implicit templates. This rule is important for avoiding topic contamination and template-like AI writing.

## Product Requirements

The project-book generation requirements are documented in [`docs/product-requirements.md`](docs/product-requirements.md). This document defines the current-topic isolation layer, input understanding layer, reference-style learning layer, competition skill layer, evidence layer, de-template cleanup, honest quality review, and export requirements that guide workflow development.

## Architecture (actual runtime paths)

[`docs/architecture.md`](docs/architecture.md) documents which code path the desktop/Web product actually runs (the Express server in `server/`) versus the separate CLI path (`src/core` + `src/cli`), and which modules are currently not wired into the production generation pipeline. Read it before assuming the "multi-agent engine" is active.

## License

MIT
