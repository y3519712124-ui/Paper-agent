# Paper-agent Product Requirements

Paper-agent is a competition project-book production system for 大创、挑战杯、中国国际大学生创新大赛/互联网+ and adjacent university competitions. It is not a generic writing chatbot. The product goal is to convert the current project topic, current form fields, current uploads, and optional reference documents into a complete project book with controlled structure, natural writing, evidence boundaries, quality review, and DOCX/PDF export.

## 1. Product Positioning

Paper-agent should solve four practical problems:

- Students know the project idea but cannot write it in the style expected by competition reviewers.
- Generated text often looks like a generic AI template, especially when every paragraph starts with “项目、市场、资金、价值、策略”.
- Workflows can accidentally inherit old drafts, other project topics, unrelated folders, or historical samples.
- DOCX/PDF output must preserve title hierarchy, paragraph rhythm, table wrapping, and reference-style formatting.

The system must therefore prioritize current-topic isolation, reference-style learning, fact boundaries, de-templated writing, and honest quality reporting.

## 2. Non-Negotiable Rules

1. No reference document uploaded: generate only from the current project form, current uploads, public/current research artifacts, and built-in competition requirements.
2. Reference document uploaded: learn only its directory order, title hierarchy, paragraph layout, table style, and formal writing rhythm.
3. Never inherit the reference document's project facts, project name, technology route, market, team, finance numbers, experimental results, or attachment facts.
4. Never use other local projects, other directories, old test workflows, historical examples, OpenClaw samples, or previous generated articles as hidden structure references.
5. Generated正文 must not contain system notes, quality reports, prompt instructions, “本节/本章节/写作要求/参考项目书” meta language, or quality-scanner explanations.
6. Quality scores are automatic prechecks, not truth claims. The system should not present itself as perfect; real data, attachments, school templates, and final formatting still require human verification.

## 3. Target Competition Matrix

| Priority | Competition | Document Type | Main Review Focus |
| --- | --- | --- | --- |
| P0 | 大创 | 创新训练、创业训练、创业实践项目书 | 训练属性、创新性、可行性、团队分工、经费对应成果 |
| P0 | 挑战杯 | 创业计划、社科调研、科技作品说明 | 社会问题、实践验证、学术/技术严谨性、应用价值 |
| P0 | 互联网+ / 中国国际大学生创新大赛 | 商业计划书 | 用户验证、商业闭环、增长路径、财务融资、路演表达 |
| P1 | 创青春等创业赛事 | 创业计划书 | 商业模式、市场进入、团队资源、落地执行 |
| P2 | 数学建模、电赛等 | 技术报告、竞赛报告 | 模型方法、实验过程、工程实现、结果复核 |

## 4. Input Model

### 4.1 Minimum Input

- Project name.
- Competition type.
- One-sentence project direction.
- Team or author information if available.

### 4.2 Standard Input

- Project name and 50-300 character summary.
- Competition type and group.
- Target users/customers.
- Product or technical solution.
- Team members, roles, advisor.
- Expected成果, budget, period, existing materials.

### 4.3 Advanced Input

- Uploaded reference project book for structure/style.
- Uploaded data, screenshots, charts, survey notes, test records.
- Desired innovation direction.
- Existing paper/patent/software copyright/prototype.
- Budget range, finance assumptions, market assumptions.

The input parser must summarize long pasted text before generation. It must not copy parameter-box prose directly into the final manuscript.

## 5. System Layers

### 5.1 Current Project Isolation Layer

Purpose: prevent cross-project contamination.

Requirements:

- Bind each run to one workflow ID, one config, one project directory, one upload set, one draft directory, and one export directory.
- Do not read unrelated projects or hidden historical examples as templates.
- Detect risky terms from other project profiles such as SAR, low-altitude drone, elder-care fall detection, cross-border e-commerce, unless they belong to the current project.
- Old drafts can be restored only through explicit rollback, not implicit generation memory.

Current artifact/code target:

- `.paper/projects/<workflow>/.paper/*`
- `safeId`, `projectDirFor`, `crossProjectContamination`

### 5.1.1 Planning / Execution / Audit Separation

Purpose: keep Claude planning, Codex execution, and Claude audit as three distinct contracts instead of one blended prompt chain.

Requirements:

- Planning layer: produce a workflow manifest, chapter plan, evidence plan, and reference-style constraints; do not write manuscript prose here.
- Execution layer: generate and revise chapters strictly from the manifest, current uploads, and current-topic evidence; do not invent plan logic inside the final draft.
- Audit layer: read only the generated manuscript and evidence artifacts, then return block/rewrite/pass with locations and fixes; do not silently patch the manuscript unless explicitly requested.
- The server may orchestrate these stages, but it must not blur their outputs or reuse audit text inside manuscript text.

Visible artifacts for this separation should include, when applicable:

- `00-workflow-manifest.md` or an equivalent planning artifact;
- `00-input-understanding.md`;
- `00-reference-style-blueprint.md`;
- `00-competition-skill-blueprint.md`;
- `98-quality-report.md`;
- `99-review-report.md` or an equivalent audit artifact.

### 5.2 Input Understanding Layer

Purpose: create a private “thinking layer” before writing.

Requirements:

- Extract topic, domain, users, scenes, pain points, modules, technology route, business models, metrics, finance assumptions, and proof materials.
- Convert raw form fields into compact writing facts.
- Mark unverifiable market, finance, technical, or achievement claims with口径.
- Generate an internal artifact named `00-input-understanding.md`.

This layer is internal. Its content must guide generation but must never appear in正文.

### 5.3 Reference Style Learning Layer

Purpose: make outputs structurally similar to the uploaded reference document.

Requirements:

- Extract一级标题、二级标题、三级标题、numbering style, paragraph density, table density, table headers, and document rhythm.
- Generate an internal artifact named `00-reference-style-blueprint.md`.
- When a reference blueprint exists, chapter order and title hierarchy should follow it before built-in competition skeletons.
- The style layer must include explicit “learn structure only, do not inherit facts” constraints.

### 5.4 Competition Skill Layer

Purpose: encode competition-specific scoring and writing logic.

Requirements:

- Generate `00-competition-skill-blueprint.md`.
- Maintain different rubrics for 大创、挑战杯、互联网+.
- Force coverage of scoring points such as innovation, practice validation, social value, business closure, team resources, finance, risks, and proof materials.
- Feed this blueprint into every chapter prompt and final review.

### 5.5 Evidence and Research Layer

Purpose: give the manuscript traceable factual boundaries.

Requirements:

- Build upload knowledge, research brief, and evidence index.
- Distinguish current uploads, public research, team estimates, prototype-test口径, and future plans.
- Do not write unverified contracts, customers, revenue, patents, software copyrights, or pilot results as completed facts.
- Every major market/finance/technical number must have a口径 or source category.

### 5.6 Chapter Generation Layer

Purpose: avoid quality collapse from one-shot long generation.

Requirements:

- Generate project book by chapter agents: overview, team, product/technology, market, business, benefits, finance, proof materials, final assembly.
- Each chapter should receive project profile, input understanding, competition skill blueprint, research/evidence context, and optional reference-style excerpt.
- Chapter output must be正文, not advice, outline, prompt explanation, or quality notes.
- Each chapter prompt should be fed from the planning manifest, not from unrelated hard-coded assumptions or old workflow memory.

### 5.7 Final Assembly Layer

Purpose: turn chapter artifacts into one manuscript.

Requirements:

- Normalize directory, heading order, title hierarchy, terminology, project name usage, figure/table numbering, and attachment references.
- Remove duplicated auto sections, fallback sections, quality notes, source maps, and system descriptions.
- Use the full project name early, then switch to natural context subjects such as 系统、团队、经费安排、服务路径、这一路径、产品模块.

### 5.8 De-Template and Human-Writing Layer

Purpose: reduce AI/template feel.

Requirements:

- Detect and rewrite title-noun-leading sentences: “项目、市场、资金、价值、策略、商业模式、营销策略、发展战略”.
- Reduce repeated “本项目、该平台、该系统、该方案” paragraph starts.
- Remove meta language: “本节、本章节、写作要求、参考项目书、质量报告、系统提示”.
- Rewrite awkward field concatenations such as “经费安排与经费投向……收入来源包括……对应到具体成果”.
- Replace “项目制交付” with more specific terms only when appropriate, such as “定制交付”.
- Table headers should stay short and readable. Long cell content should wrap naturally or use semicolon-separated clauses.

### 5.9 Quality Review Layer

Purpose: produce an honest machine precheck.

Requirements:

- Score structure coverage, chapter depth, current-topic specificity, cross-topic contamination, table density, figure signals, evidence口径, duplicate paragraphs, repeated phrase loops, AI-tone signals, malformed cleanup artifacts, and advice-style wording.
- Cap score when real risks exist.
- Never output a perfect-sounding claim. A clean scan should say automatic detection found no obvious hard issue, while reminding users to verify data, attachments, and school templates.
- Generate `98-quality-report.md`.
- If an audit loop exists, it should return a separate review report rather than mutating the manuscript body directly unless a repair action is explicitly invoked.

### 5.10 Export and Format Layer

Purpose: make the output usable beyond Markdown.

Requirements:

- Export Markdown, DOCX, and PDF.
- Preserve Chinese heading hierarchy, font sizes, paragraph spacing, table wrapping, figure captions, table titles, and page-level document shape.
- Reference-document formatting should influence DOCX/PDF where possible.
- Long tables must wrap cells instead of breaking layout.

## 6. Output Documents

### 6.1 Final Manuscript

The final project book should include competition-appropriate chapters such as:

- Cover / basic information.
- Directory.
- Executive summary or project overview.
- Project scheme / background / need.
- Team overview.
- Product, technology, or research plan.
- Market survey and competitive analysis.
- Business model and development strategy.
- Expected benefits.
- Finance, budget, and funding return.
- Risk control.
- Proof materials / appendix index.

Reference documents can override this chapter order when explicitly uploaded.

### 6.2 Internal Artifacts

| Artifact | Purpose | Visible in final正文 |
| --- | --- | --- |
| `00-input-understanding.md` | Topic understanding and fact boundaries | No |
| `00-reference-style-blueprint.md` | Structure/style learning from current reference | No |
| `00-competition-skill-blueprint.md` | Competition scoring and constraints | No |
| `00-upload-knowledge.md` | Uploaded material inventory | No |
| `00-research-brief.md` | Public research and background packet | No |
| `00-evidence-index.md` | Evidence-to-claim map | No |
| `98-quality-report.md` | Automatic quality precheck | No |

## 7. MVP Scope

P0 must ship:

- planning manifest generation for Claude-style planning;
- execution pipeline that consumes the manifest;
- audit pipeline that can return block/rewrite/pass decisions;
- 大创、挑战杯、互联网+ workflow templates.
- Current project isolation.
- Input understanding layer.
- Reference style learning layer.
- Competition skill blueprint.
- Upload/evidence/research artifacts.
- Multi-agent chapter generation.
- Final assembly and de-template cleanup.
- Quality scan and repair.
- Markdown, DOCX, PDF export.
- Smoke tests for cross-topic contamination, AI-tone residue, export format, final manuscript structure.

P1 should add:

- Stronger online policy/literature search.
- GB/T 7714 reference formatting.
- Better chart/image generation.
- Local chapter rewrite UI.
- Multi-version output: academic, business, practice, roadshow.

P2 can add:

- Managed优秀项目书 knowledge base with permission and anonymization.
- Similarity/checking preflight.
- Judge Q&A simulator.
- PPT and roadshow script generation.
- More structured finance model tables.

## 8. Acceptance Criteria

A generated project book is acceptable when:

- It uses only the current project and current uploads.
- With a reference document, it follows the reference structure and style without inheriting facts.
- Without a reference document, it follows the selected competition's built-in structure.
- The final manuscript has no system notes, prompt notes, quality report text, or hidden blueprint text.
- Cross-project risky terms count is zero unless relevant to the current topic.
- Meta-tone hits are zero.
- Malformed cleanup hits are zero.
- Narrative “项目” usage stays below the configured density limit.
- Tables remain readable in Markdown/DOCX/PDF.
- Quality report is honest and does not claim perfection.

## 9. Test Coverage

Required smoke tests:

- Generation guard: verifies required layers and forbids legacy hidden-template logic.
- Input understanding guard: verifies raw long inputs are summarized rather than copied.
- Profile quality guard: verifies topic classification and cross-topic risk.
- Final manuscript guard: verifies full manuscripts across several competition types.
- Export format guard: verifies table/heading/export formatting assumptions.

The smoke tests should be treated as product safety checks, not just code tests.
