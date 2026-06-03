import React, { useEffect, useMemo, useRef, useState } from "react";

const API = "/api";

function friendlyFetchError(error: unknown, fallback = "请求失败") {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/Failed to fetch|NetworkError|ERR_CONNECTION_RESET|ECONNRESET|fetch failed/i.test(message)) {
    return "连接后端时中断了。请确认 Paper-agent 服务仍在运行；如果刚上传了很多/很大的参考文件，请分批上传后重试。";
  }
  return message || fallback;
}

type Page = "workflows" | "new" | "detail" | "editor" | "settings";
type ThemeMode = "light" | "dark";

type StepDef = {
  id: string;
  name: string;
  agent: string;
  checkpointType: string;
  instruction: string;
};

type TemplateDef = {
  name: string;
  description: string;
  steps: StepDef[];
};

type Artifact = {
  name: string;
  path: string;
  content: string;
  updated: string;
  size: number;
};

type Checkpoint = {
  stepName: string;
  stepIndex: number;
  status: "running" | "completed" | "failed";
  completedAt?: string;
  error?: string;
};

type Workflow = {
  id: string;
  name: string;
  template: string;
  competition: string;
  track?: string;
  team?: string;
  brief?: string;
  status?: "draft" | "running" | "completed" | "failed";
  updated: string;
  draftCount: number;
  artifactCount: number;
  checkpointCount: number;
  steps: StepDef[];
  artifacts?: Artifact[];
  drafts?: Artifact[];
  checkpoints?: Checkpoint[];
  latestBackup?: { id: string; path: string } | null;
};

type EditorFile = {
  name: string;
  path: string;
  kind: string;
  extension: string;
  size: number;
  updated: string;
  content?: string;
};

type EditorFileGroup = {
  label: string;
  root: string;
  files: EditorFile[];
};

type AssistantMessage = {
  role: "assistant" | "user";
  text: string;
  patch?: string;
  preview?: string;
  undoContent?: string;
  backup?: { backupId: string; backupDir: string; files?: string[]; relativePath?: string } | null;
  trace?: AgentTraceItem[];
  status?: "working" | "done" | "error" | "info";
};

type AgentTraceItem = {
  step?: number;
  label: string;
  detail: string;
  status?: string;
};

type ModelOption = {
  id: string;
  ownedBy?: string;
  object?: string;
};

const ACTIVATION_CODE_HASH = "8a3f24f6";

function normalizeActivationCode(code: string) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function activationHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isValidActivationCode(code: string) {
  return activationHash(normalizeActivationCode(code)) === ACTIVATION_CODE_HASH;
}

function compactAssistantStatus(answer: string, action: string, patch: string, fileName?: string) {
  const text = String(answer || "")
    .replace(/外部模型暂未返回[^\n]*/g, "")
    .replace(/当前外部模型没有返回可用内容[^\n]*/g, "")
    .replace(/本地编辑器兜底[^\n]*/g, "")
    .replace(/兜底完成[^\n]*/g, "")
    .replace(/模型返回/g, "已收到")
    .replace(/模型没有返回/g, "未收到")
    .trim();
  const lineCount = text.split(/\r?\n/).filter(Boolean).length;
  const looksLikeManuscript = text.length > 900 || lineCount > 10 || /^#{1,3}\s/m.test(text) || /\|.+\|/.test(text);
  if (action === "replace_current_file" && patch) {
    const patchLines = patch.split(/\r?\n/).length;
    const patchChars = patch.length.toLocaleString();
    const summary = looksLikeManuscript
      ? "已收到较长改稿，右侧不展开全文，正文已写入中间编辑器。"
      : (text || "已按你的指令修改当前文件。");
    return [
      summary,
      `已应用到：${fileName || "当前文件"}`,
      `修改稿规模：约 ${patchChars} 字符 / ${patchLines} 行`,
      "请在中间编辑器检查；需要回退可点击撤销并保存。",
    ].join("\n");
  }
  if (looksLikeManuscript) {
    return [
      "已收到较长内容，右侧仅保留执行摘要。",
      "这次没有收到可安全应用的编辑补丁，因此中间编辑器未改动。",
      "请换成更明确的修改指令，例如“重写执行摘要并直接应用”。",
    ].join("\n");
  }
  return text || "已完成处理。";
}

function summarizeEdit(before: string, after: string) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const removed = Math.max(0, endBefore - start + 1);
  const added = Math.max(0, endAfter - start + 1);
  const changedFrom = beforeLines.slice(start, Math.min(endBefore + 1, start + 3));
  const changedTo = afterLines.slice(start, Math.min(endAfter + 1, start + 3));
  const trimLine = (line: string) => {
    const clean = line.trim();
    return clean.length > 86 ? `${clean.slice(0, 86)}...` : clean || "(空行)";
  };
  if (before === after) return { summary: "未检测到文本差异。", preview: "" };
  const summary = `变更范围：从第 ${start + 1} 行开始，移除 ${removed} 行，新增 ${added} 行。`;
  const preview = [
    "局部预览",
    ...changedFrom.map((line) => `- ${trimLine(line)}`),
    ...changedTo.map((line) => `+ ${trimLine(line)}`),
  ].join("\n");
  return { summary, preview };
}

function appendAssistantResult(messages: AssistantMessage[], doneMessage: AssistantMessage) {
  const next = [...messages];
  const lastWorking = next.findLastIndex((message) => message.role === "assistant" && message.status === "working");
  if (lastWorking >= 0) next[lastWorking] = doneMessage;
  else next.push(doneMessage);
  const compacted: AssistantMessage[] = [];
  for (const message of next) {
    const prev = compacted[compacted.length - 1];
    if (prev && prev.role === message.role && prev.status === message.status && prev.text === message.text) continue;
    compacted.push(message);
  }
  return compacted;
}

function normalizeAgentTrace(value: unknown): AgentTraceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any, index) => ({
      step: Number(item?.step || index + 1),
      label: String(item?.label || `步骤 ${index + 1}`),
      detail: String(item?.detail || ""),
      status: String(item?.status || "done"),
    }))
    .filter((item) => item.detail.trim());
}

type DeliveryFile = {
  label: string;
  path: string;
  exists: boolean;
  size: number;
  updated: string;
};

type DeliveryCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

type DeliveryResult = {
  success: boolean;
  generatedAt: string;
  exportDir: string;
  files: Record<string, DeliveryFile>;
  checks: DeliveryCheck[];
  backup?: { backupId: string; backupDir: string; files: string[] } | null;
  regeneration?: {
    beforeChars: number;
    afterChars: number;
    changedChars: number;
    beforeHeadings: number;
    afterHeadings: number;
    beforeTables: number;
    afterTables: number;
    summary: string;
  } | null;
  guidance?: {
    status: "ready" | "needs_attention" | string;
    failedCount: number;
    failedLabels: string[];
    shouldRegenerate: boolean;
    canAutoRepair: boolean;
    summary: string;
    nextActions: string[];
    finalChars: number;
  };
};

type QualityScanResult = {
  success: boolean;
  score: number;
  band: string;
  generatedAt: string;
  profile?: {
    id: string;
    title: string;
    domain: string;
  };
  metrics: {
    chars: number;
    chapterSignals: number;
    chapterTotal: number;
    tableRows: number;
    figureSignals: number;
    evidenceHits: number;
    adviceHits: number;
  };
  specificity: {
    score: number;
    hits: number;
    total: number;
    examples: string[];
    missing: string[];
  };
  contamination: Array<{ label: string; count: number; allowed: boolean; risky: boolean; examples: string[] }>;
  genericSamples: Array<{ count: number; text: string }>;
  duplicates: Array<{ count: number; text: string }>;
  repeatedPhrases: Array<{ count: number; text: string }>;
  risks: string[];
  actions: string[];
  checks: DeliveryCheck[];
};

type QualityRepairResult = {
  success: boolean;
  backupPath: string;
  finalPath: string;
  changedChars: number;
  removedParagraphs: number;
  removedSentences: number;
  removedContaminationLines: number;
  before: QualityScanResult;
  after: QualityScanResult;
};

const templateOrder = ["dachuang", "tiaozhanbei", "internet-plus"];

function statusLabel(status?: string) {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "草稿";
}

function statusClass(status?: string) {
  if (status === "running") return "status running";
  if (status === "completed") return "status done";
  if (status === "failed") return "status failed";
  return "status";
}

function useTemplates() {
  const [templates, setTemplates] = useState<Record<string, TemplateDef>>({});
  useEffect(() => {
    fetch(`${API}/templates`).then((r) => r.json()).then(setTemplates).catch(() => setTemplates({}));
  }, []);
  return templates;
}

export default function App() {
  const [accepted, setAccepted] = useState(() => localStorage.getItem("paper_disclaimer_accepted") === "true");
  const [activated, setActivated] = useState(() => localStorage.getItem("paper_activation_ok") === "true");
  const [page, setPage] = useState<Page>("workflows");
  const [selectedId, setSelectedId] = useState("");
  const [editorInstruction, setEditorInstruction] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => localStorage.getItem("paper_theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    localStorage.setItem("paper_theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!accepted) {
    return <Disclaimer onAccept={() => {
      localStorage.setItem("paper_disclaimer_accepted", "true");
      setAccepted(true);
    }} />;
  }

  if (!activated) {
    return <ActivationGate onActivated={() => {
      localStorage.setItem("paper_activation_ok", "true");
      setActivated(true);
    }} />;
  }

  return (
    <div className="app" data-theme={theme}>
      <Style />
      <header className="topbar">
        <button className="brand" onClick={() => setPage("workflows")} title="返回工作流">
          <img className="brand-logo" src="/brand/paper-agent-mark.png" alt="" />
          <span>Paper-agent</span>
        </button>
        <nav>
          <button className={page === "workflows" ? "nav active" : "nav"} onClick={() => setPage("workflows")}>工作流</button>
          <button className={page === "new" ? "nav active" : "nav"} onClick={() => setPage("new")}>新建</button>
          <button className={page === "settings" ? "nav active" : "nav"} onClick={() => setPage("settings")}>设置</button>
        </nav>
        <button
          className={theme === "dark" ? "theme-toggle is-dark" : "theme-toggle is-light"}
          onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "切换到亮色模式" : "切换到黑夜模式"}
          aria-label={theme === "dark" ? "切换到亮色模式" : "切换到黑夜模式"}
        >
          <span className="theme-icon" />
        </button>
      </header>
      <main className="shell">
        {page === "workflows" && <WorkflowList onNew={() => setPage("new")} onOpen={(id) => { setSelectedId(id); setPage("detail"); }} />}
        {page === "new" && <NewWorkflow onCancel={() => setPage("workflows")} onCreated={(id) => { setSelectedId(id); setPage("detail"); }} />}
        {page === "detail" && (
          <WorkflowDetail
            id={selectedId}
            onBack={() => setPage("workflows")}
            onOpenEditor={(instruction = "") => {
              setEditorInstruction(instruction);
              setPage("editor");
            }}
          />
        )}
        {page === "editor" && (
          <WorkflowEditor
            id={selectedId}
            initialInstruction={editorInstruction}
            onInitialInstructionConsumed={() => setEditorInstruction("")}
            onBack={() => setPage("detail")}
          />
        )}
        {page === "settings" && <Settings />}
      </main>
    </div>
  );
}

function Disclaimer({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="app">
      <Style />
      <main className="gate">
        <section className="gate-card">
          <div className="gate-head">
            <img className="brand-logo large" src="/brand/paper-agent-mark.png" alt="" />
            <div>
              <h1>Paper-agent</h1>
              <p>挑战杯 / 大创 / 互联网+ 项目书智能体工作台</p>
            </div>
          </div>
          <div className="notice">
            <h2>免责声明与版权声明</h2>
            <h3>版权声明</h3>
            <p>© 2026 芯词元科技保留所有权利。本软件（Paper-agent）及其所有组件、算法、模板、配方库均受中华人民共和国著作权法及国际版权公约保护。</p>
            <p>未经芯词元科技书面授权，任何个人或组织不得以任何形式复制、修改、反编译、反向工程、分发、转售、出租或以其他方式使用本软件的全部或部分内容。</p>
            <p>违反上述声明者，芯词元科技将依法追究其法律责任。</p>
            <h3>免责声明</h3>
            <p>1. 本工具为 AI 辅助科研与竞赛申报工具，生成的内容仅供参考和学习交流使用。用户应对最终提交的项目书内容负全部责任。</p>
            <p>2. AI 生成的内容可能存在错误、不准确或不完整之处，用户在使用前应仔细审核和修改。</p>
            <p>3. 用户应遵守所在学校和竞赛组委会的学术诚信规定，合理使用 AI 工具。本工具不鼓励任何形式的学术不端行为。</p>
            <p>4. 本工具不对因使用生成内容而产生的任何直接或间接损失承担责任。</p>
            <p>5. 使用本工具即表示您已阅读并同意以上条款。</p>
            <h3>API 服务</h3>
            <p>API 中转服务由 New API 提供：<a href="https://api.scxai.top/pricing" target="_blank" rel="noreferrer">https://api.scxai.top/pricing</a></p>
          </div>
          <button className="primary wide" onClick={onAccept}>我已阅读并同意</button>
        </section>
      </main>
    </div>
  );
}

function ActivationGate({ onActivated }: { onActivated: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isValidActivationCode(code)) {
      setError("");
      onActivated();
      return;
    }
    setError("激活码不正确，请核对后重新输入。");
  };

  return (
    <div className="app">
      <Style />
      <main className="activation-screen">
        <section className="activation-card">
          <div className="activation-brand">
            <img className="brand-logo large" src="/brand/paper-agent-mark.png" alt="" />
            <div>
              <p className="activation-kicker">Activation Required</p>
              <h1>激活 Paper-agent</h1>
              <p>完成授权校验后进入项目书工作台。</p>
            </div>
          </div>

          <form className="activation-form" onSubmit={submit}>
            <label htmlFor="activation-code">激活码</label>
            <div className="activation-input-row">
              <input
                id="activation-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (error) setError("");
                }}
                placeholder="请输入激活码"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="primary" type="submit">激活</button>
            </div>
            {error && <p className="activation-error">{error}</p>}
          </form>

          <div className="activation-notes">
            <span>本地授权</span>
            <span>仅当前设备保存激活状态</span>
            <span>激活后可继续创建工作流</span>
          </div>
        </section>
      </main>
    </div>
  );
}

function WorkflowList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    fetch(`${API}/workflows`).then((r) => r.json()).then(setWorkflows).catch((err) => setError(err.message ?? String(err))).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const removeWorkflow = async (workflow: Workflow) => {
    const confirmed = window.confirm(`确定删除“${workflow.name}”吗？\n\n会删除该项目的本地草稿、产物和工作流记录。`);
    if (!confirmed) return;
    setDeletingId(workflow.id);
    setError("");
    try {
      const response = await fetch(`${API}/workflows/${encodeURIComponent(workflow.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "删除失败");
      setWorkflows((items) => items.filter((item) => item.id !== workflow.id));
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setDeletingId("");
    }
  };

  const openFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(id);
  };

  const filtered = workflows.filter((w) => `${w.name} ${w.competition} ${w.track ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const latestUpdated = workflows
    .map((w) => new Date(w.updated).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const stats = [
    { label: "工作流", value: workflows.length, detail: workflows.length ? "当前项目空间" : "干净工作区" },
    { label: "运行中", value: workflows.filter((w) => w.status === "running").length, detail: "实时任务" },
    { label: "产物", value: workflows.reduce((sum, w) => sum + (w.artifactCount || 0), 0), detail: "草稿 / 终稿 / 导出" },
    { label: "完成", value: workflows.filter((w) => w.status === "completed").length, detail: latestUpdated ? new Date(latestUpdated).toLocaleDateString() : "等待生成" },
  ];

  return (
    <section className="workflow-console">
      <div className="console-hero">
        <div className="console-title">
          <p className="console-kicker">Paper-agent Control Desk</p>
          <h1>项目书工作台</h1>
          <p>当前空间只保留新建工作流；参考文档、表单事实和导出产物会在同一处归档。</p>
        </div>
        <div className="console-actions">
          <button className="primary console-primary" onClick={onNew}><span className="button-icon">+</span>新建工作流</button>
        </div>
      </div>

      <div className="console-layout">
        <div className="console-main">
          <div className="stat-strip">
            {stats.map((item) => (
              <div className="stat-tile" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>

          <div className="workflow-toolbar">
            <label className="search-control">
              <span className="search-mark" aria-hidden="true" />
              <input className="console-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名称、赛道或方向" />
            </label>
            <button className="ghost refresh-button" onClick={load}><span className="button-icon">↻</span>刷新</button>
          </div>

          {error && <p className="error">{error}</p>}
          {loading && <p className="muted">加载中...</p>}
          {!loading && filtered.length === 0 && (
            <div className="workflow-empty">
              <div className="empty-visual" aria-hidden="true">
                <span className="empty-sheet sheet-one" />
                <span className="empty-sheet sheet-two" />
                <span className="empty-sheet sheet-three" />
                <span className="empty-rule" />
              </div>
              <div>
                <p className="eyebrow">Clean Workspace</p>
                <h2>工作区已清空</h2>
                <p>下一份项目书会从当前主题重新开始，不会读取刚才移走的旧草稿和旧配置。</p>
                <button className="primary" onClick={onNew}><span className="button-icon">+</span>创建第一个项目</button>
              </div>
            </div>
          )}

          <div className="workflow-grid">
            {filtered.map((w) => (
              <div
                className="workflow-card"
                key={w.id}
                onClick={() => onOpen(w.id)}
                onKeyDown={(event) => openFromKeyboard(event, w.id)}
                role="button"
                tabIndex={0}
              >
                <div className="card-row">
                  <span className={statusClass(w.status)}>{statusLabel(w.status)}</span>
                  <span className="card-actions">
                    <span className="muted small">{new Date(w.updated).toLocaleString()}</span>
                    <button
                      className="delete-workflow"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeWorkflow(w);
                      }}
                      disabled={deletingId === w.id}
                      title="删除项目"
                      aria-label={`删除 ${w.name}`}
                    >
                      {deletingId === w.id ? "删除中" : "删除"}
                    </button>
                  </span>
                </div>
                <h2>{w.name}</h2>
                <p>{w.competition}{w.track ? ` / ${w.track}` : ""}</p>
                <div className="meta-row">
                  <span>{w.steps?.length ?? 0} 步</span>
                  <span>{w.artifactCount ?? 0} 份产物</span>
                  <span>{w.draftCount ?? 0} 份草稿</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="console-aside">
          <div className="side-panel start-panel">
            <span className="side-number">01</span>
            <h2>开始新稿</h2>
            <p>先填项目名称、赛道、产品和参考文档；生成时只按当前材料走。</p>
            <button className="primary wide" onClick={onNew}>进入新建</button>
          </div>
          <div className="side-panel rule-panel">
            <h2>写法边界</h2>
            <div className="rule-list">
              <span>参考文档只学结构</span>
              <span>正文只用当前主题事实</span>
              <span>无参考时固定八章结构</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

const templateMeta: Record<string, { icon: string; badge: string; audience: string }> = {
  dachuang: { icon: "CN", badge: "项目训练", audience: "创新训练 / 创业训练 / 创业实践" },
  tiaozhanbei: { icon: "TB", badge: "竞赛申报", audience: "挑战杯创业计划 / 红旅 / 科技创新" },
  "internet-plus": { icon: "IP", badge: "商业路演", audience: "互联网+ / 商业计划书 / 路演文本" },
};

function NewWorkflow({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const templates = useTemplates();
  type UploadField = "referenceNotes" | "contestFileNotes" | "attachmentNotes";
  const [form, setForm] = useState({
    name: "",
    template: "dachuang",
    competition: "dachuang",
    track: "",
    team: "",
    brief: "",
    product: "",
    market: "",
    finance: "",
    evidence: "",
    pageLimit: "30",
    reviewMode: "strict",
    figureMode: false,
    figureCount: "2",
    tableMode: false,
    tableCount: "5",
    dataMode: false,
    dataCount: "3",
    modelMode: false,
    modelCount: "1",
    docStyle: "competition",
    referenceNotes: "",
    contestFileNotes: "",
    attachmentNotes: "",
    autoAdvance: true,
    humanCheckpoint: false,
    revisionLoop: true,
  });
  const [selectedFiles, setSelectedFiles] = useState<Record<UploadField, File[]>>({
    referenceNotes: [],
    contestFileNotes: [],
    attachmentNotes: [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    if (!form.name.trim()) {
      setError("请填写项目名称");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${API}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建失败");
      const files = Object.entries(selectedFiles).flatMap(([field, items]) =>
        items.map((file) => ({ field, file })),
      );
      if (files.length) {
        const uploadBody = new FormData();
        for (const item of files) uploadBody.append(item.field, item.file, item.file.name);
        const uploadResponse = await fetch(`${API}/workflows/${encodeURIComponent(data.id)}/uploads`, {
          method: "POST",
          body: uploadBody,
        });
        const uploadData = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok) throw new Error(uploadData.error || "文件上传失败");
      }
      onCreated(data.id);
    } catch (err: any) {
      setError(friendlyFetchError(err, "创建工作流失败"));
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof typeof form, value: string | boolean) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "template" ? { competition: value } : {}),
    }));
  };

  const rememberFiles = (key: UploadField, files: FileList | null) => {
    if (!files?.length) return;
    const items = Array.from(files);
    setSelectedFiles((prev) => ({ ...prev, [key]: items }));
    const names = items.map((file) => file.name).join("、");
    update(key, names);
  };

  const selectedTemplate = templates[form.template];
  const plannedArtifacts = [
    form.figureMode ? `${form.figureCount} 张图` : "AI 规划图示",
    form.tableMode ? `${form.tableCount} 张表` : "AI 规划表格",
    form.dataMode ? `${form.dataCount} 组数据` : "AI 规划数据口径",
    form.modelMode ? `${form.modelCount} 个模型/公式` : "按需生成模型说明",
  ];

  return (
    <section className="new-workflow-page">
      <div className="page-head workflow-hero">
        <div className="hero-copy">
          <p className="eyebrow">New Workflow</p>
          <h1>新建项目书生成任务</h1>
          <p className="muted">按 Modex 的流水线方式配置：先定赛项模板，再补充项目参数、图表要求和执行策略。</p>
        </div>
        <button className="ghost" onClick={onCancel}>返回</button>
      </div>

      <div className="workflow-builder">
        <section className="builder-main">
          <div className="builder-section">
            <div className="builder-section-head">
              <h2>流水线模板</h2>
              <span>{selectedTemplate?.steps.length ?? 9} 个阶段</span>
            </div>
            <div className="template-rail">
              {templateOrder.map((key) => {
                const template = templates[key];
                if (!template) return null;
                const active = form.template === key;
                const meta = templateMeta[key];
                return (
                  <button className={active ? "template-tile active" : "template-tile"} key={key} onClick={() => update("template", key)}>
                    <span className="tile-icon">{meta.icon}</span>
                    <strong>{template.name}</strong>
                    <small>{meta.badge}</small>
                    <p>{template.description}</p>
                    <em>{meta.audience}</em>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="builder-section">
            <div className="builder-section-head">
              <h2>项目参数</h2>
              <span>用于生成完整项目书</span>
            </div>
            <div className="form-grid">
              <div>
                <label>项目名称</label>
                <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="例如：基于SAR场景的超路由元适应检测网络" />
              </div>
              <div>
                <label>细分方向</label>
                <input value={form.track} onChange={(e) => update("track", e.target.value)} placeholder="例如：低空经济、智慧农业、公共安全、银发服务" />
              </div>
              <div className="wide-field">
                <label>团队基础</label>
                <input value={form.team} onChange={(e) => update("team", e.target.value)} placeholder="例如：已有原型、指导老师、试点单位、调研样本、竞赛经历" />
              </div>
              <div className="wide-field">
                <label>项目简介</label>
                <textarea value={form.brief} onChange={(e) => update("brief", e.target.value)} placeholder="写下已有想法、目标用户、核心功能、痛点和希望解决的问题。" rows={5} />
              </div>
              <div>
                <label>技术与产品基础</label>
                <textarea value={form.product} onChange={(e) => update("product", e.target.value)} placeholder="核心算法、系统架构、原型模块、实验指标、产品版本规划。" rows={5} />
              </div>
              <div>
                <label>市场与商业设想</label>
                <textarea value={form.market} onChange={(e) => update("market", e.target.value)} placeholder="目标客户、市场规模、竞品、收费方式、渠道和试点客户。" rows={5} />
              </div>
              <div>
                <label>资金与财务设想</label>
                <textarea value={form.finance} onChange={(e) => update("finance", e.target.value)} placeholder="经费用途、融资需求、收入预测、成本结构、交付周期。" rows={4} />
              </div>
              <div>
                <label>证明材料与数据来源</label>
                <textarea value={form.evidence} onChange={(e) => update("evidence", e.target.value)} placeholder="政策文件、行业报告、调研问卷、访谈记录、实验截图、软著/专利、合作证明。" rows={4} />
              </div>
            </div>
          </div>

          <div className="builder-section">
            <div className="builder-section-head">
              <h2>图表与版式要求</h2>
              <span>关闭开关 = AI 根据项目自动规划</span>
            </div>
            <div className="param-card">
              <div className="param-row">
                <div>
                  <strong>页数限制</strong>
                  <p>正文页数，不含附件和参考文献</p>
                </div>
                <label className="number-box">
                  <input value={form.pageLimit} onChange={(e) => update("pageLimit", e.target.value)} />
                  <span>页</span>
                </label>
              </div>
              <div className="param-row">
                <div>
                  <strong>审查模式</strong>
                  <p>严格模式会做完整性检查、事实风险提示和自修复</p>
                </div>
                <div className="segmented">
                  <button className={form.reviewMode === "strict" ? "active" : ""} onClick={() => update("reviewMode", "strict")}>严格</button>
                  <button className={form.reviewMode === "fast" ? "active" : ""} onClick={() => update("reviewMode", "fast")}>快速</button>
                </div>
              </div>
              <ToggleNumber label="图片数量" hint="架构图、流程图、路线图、商业闭环图" enabled={form.figureMode} count={form.figureCount} onToggle={(value) => update("figureMode", value)} onCount={(value) => update("figureCount", value)} />
              <ToggleNumber label="表格数量" hint="市场、竞品、财务、交付物、证明材料清单" enabled={form.tableMode} count={form.tableCount} onToggle={(value) => update("tableMode", value)} onCount={(value) => update("tableCount", value)} />
              <ToggleNumber label="数据数量" hint="调研样本、实验数据、市场数据、财务测算数据" enabled={form.dataMode} count={form.dataCount} onToggle={(value) => update("dataMode", value)} onCount={(value) => update("dataCount", value)} />
              <ToggleNumber label="模型数量" hint="技术模型、商业模型、财务模型或评价指标体系" enabled={form.modelMode} count={form.modelCount} onToggle={(value) => update("modelMode", value)} onCount={(value) => update("modelCount", value)} />
              <div className="param-row">
                <div>
                  <strong>文档模板</strong>
                  <p>自动按大创 / 挑战杯 / 互联网+ 套用 Word/PDF 版式；学术模式会压缩行距和表格。</p>
                </div>
                <div className="segmented">
                  <button className={form.docStyle === "competition" ? "active" : ""} onClick={() => update("docStyle", "competition")}>竞赛默认</button>
                  <button className={form.docStyle === "nature" ? "active" : ""} onClick={() => update("docStyle", "nature")}>Nature</button>
                </div>
              </div>
            </div>
          </div>

          <div className="builder-section">
            <div className="builder-section-head">
              <h2>参考资料与附件</h2>
              <span>仅使用当前项目上传文件，不读取其他项目或历史样例</span>
            </div>
            <div className="upload-grid">
              <label className="upload-box">
                <span>上传本项目参考文档</span>
                <small>{form.referenceNotes || "目录 / 写法 / 结构参考"}</small>
                <input type="file" multiple onChange={(e) => rememberFiles("referenceNotes", e.target.files)} />
              </label>
              <label className="upload-box">
                <span>上传相关文件</span>
                <small>{form.contestFileNotes || "PDF / Word / 图片 / 数据"}</small>
                <input type="file" multiple onChange={(e) => rememberFiles("contestFileNotes", e.target.files)} />
              </label>
              <label className="upload-box">
                <span>上传附件数据</span>
                <small>{form.attachmentNotes || "CSV / Excel / JSON / 图片"}</small>
                <input type="file" multiple onChange={(e) => rememberFiles("attachmentNotes", e.target.files)} />
              </label>
            </div>
          </div>

          <div className="builder-section">
            <div className="builder-section-head">
              <h2>参数设置</h2>
              <span>控制流水线执行方式</span>
            </div>
            <div className="param-card">
              <SwitchRow title="自动推进" hint="自动选择最佳想法并继续执行" checked={form.autoAdvance} onChange={(value) => update("autoAdvance", value)} />
              <SwitchRow title="人工检查点" hint="关键步骤完成后暂停，可预览产出并提交修改意见" checked={form.humanCheckpoint} onChange={(value) => update("humanCheckpoint", value)} />
              <SwitchRow title="项目书改进循环" hint="终稿后自动审稿、修改、重组（约 2 轮）" checked={form.revisionLoop} onChange={(value) => update("revisionLoop", value)} />
            </div>
          </div>

          {error && <p className="error">{error}</p>}
          <button className="launch-button" onClick={create} disabled={saving}>
            {saving ? "正在创建工作流..." : "创建并进入工作流"}
          </button>
        </section>

        <aside className="builder-summary">
          <div className="summary-card">
            <p className="eyebrow">Pipeline</p>
            <h2>{selectedTemplate?.name ?? "完整项目书工作流"}</h2>
            <p>{selectedTemplate?.description ?? "按完整项目书结构生成。"}</p>
            <div className="summary-list">
              {(selectedTemplate?.steps ?? []).slice(0, 9).map((step, index) => (
                <div key={step.id}>
                  <span>{index + 1}</span>
                  <strong>{step.name}</strong>
                </div>
              ))}
            </div>
          </div>
          <div className="summary-card">
            <p className="eyebrow">Output Plan</p>
            <h2>{form.pageLimit || "30"} 页内完整项目书</h2>
            <div className="chips">
              {plannedArtifacts.map((item) => <span key={item}>{item}</span>)}
              <span>{form.reviewMode === "strict" ? "严格审查" : "快速生成"}</span>
              <span>{form.revisionLoop ? "自动改进循环" : "单轮生成"}</span>
            </div>
            <button className="ghost wide" onClick={onCancel}>取消并返回</button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ToggleNumber({
  label,
  hint,
  enabled,
  count,
  onToggle,
  onCount,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  count: string;
  onToggle: (value: boolean) => void;
  onCount: (value: string) => void;
}) {
  return (
    <div className="param-row">
      <div>
        <strong>{label}</strong>
        <p>{hint}</p>
      </div>
      <div className="toggle-count">
        <button className={enabled ? "switch on" : "switch"} onClick={() => onToggle(!enabled)} aria-label={label} />
        <div className="count-stepper">
          <button
            type="button"
            onClick={() => {
              onToggle(true);
              onCount(String(Math.max(0, Number.parseInt(count || "0", 10) - 1)));
            }}
            aria-label={`${label}减少`}
          >
            -
          </button>
          <input
            value={count}
            onFocus={() => onToggle(true)}
            onChange={(e) => {
              onToggle(true);
              onCount(e.target.value.replace(/[^\d]/g, ""));
            }}
            inputMode="numeric"
          />
          <button
            type="button"
            onClick={() => {
              onToggle(true);
              onCount(String((Number.parseInt(count || "0", 10) || 0) + 1));
            }}
            aria-label={`${label}增加`}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function SwitchRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="param-row">
      <div>
        <strong>{title}</strong>
        <p>{hint}</p>
      </div>
      <button className={checked ? "switch on" : "switch"} onClick={() => onChange(!checked)} aria-label={title} />
    </div>
  );
}

function WorkflowDetail({
  id,
  onBack,
  onOpenEditor,
}: {
  id: string;
  onBack: () => void;
  onOpenEditor: (instruction?: string) => void;
}) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<"" | "docx" | "pdf" | "tex">("");
  const [exportResult, setExportResult] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [deliveryResult, setDeliveryResult] = useState<DeliveryResult | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityRepairing, setQualityRepairing] = useState(false);
  const [rollbacking, setRollbacking] = useState(false);
  const [qualityResult, setQualityResult] = useState<QualityScanResult | null>(null);
  const [qualityRepairResult, setQualityRepairResult] = useState<QualityRepairResult | null>(null);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!id) return;
    const response = await fetch(`${API}/workflows/${id}`);
    const data = await response.json();
    setWorkflow(data);
    const finalDraft = data.drafts?.find((d: Artifact) => d.name.includes("final"));
    setActiveArtifact(finalDraft || data.artifacts?.[data.artifacts.length - 1] || null);
    setRunning(data.status === "running");
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.data?.workflowId !== id) return;
        if (msg.event === "step" || msg.event === "done" || msg.event === "failed") {
          load();
          if (msg.event === "done" || msg.event === "failed") setRunning(false);
        }
      } catch {}
    };
    return () => ws.close();
  }, [id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [workflow?.checkpoints?.length]);

  const start = async () => {
    setRunning(true);
    setError("");
    setExportResult("");
    try {
      const response = await fetch(`${API}/workflows/${id}/start`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "生成失败");
      await load();
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRunning(false);
    }
  };

  const exportFile = async (format: "docx" | "pdf" | "tex") => {
    setExporting(format);
    setError("");
    setExportResult("");
    try {
      const response = await fetch(`${API}/workflows/${id}/export/${format}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "导出失败");
      setExportResult(`已导出：${data.outputPath}`);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setExporting("");
    }
  };

  const deliver = async (force = false) => {
    setDelivering(true);
    setRunning(true);
    setError("");
    setExportResult("");
    setDeliveryResult(null);
    try {
      const response = await fetch(`${API}/workflows/${id}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "生成交付包失败");
      setDeliveryResult(data);
      setExportResult(`交付包已生成：${data.exportDir}`);
      await load();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setDelivering(false);
      setRunning(false);
    }
  };

  const rollbackLatest = async () => {
    if (!workflow?.latestBackup || rollbacking) return;
    setRollbacking(true);
    setError("");
    setExportResult("");
    try {
      const response = await fetch(`${API}/workflows/${id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: workflow.latestBackup.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "回滚失败");
      setDeliveryResult(null);
      setQualityResult(null);
      setQualityRepairResult(null);
      setExportResult(`已回滚到备份：${data.backupDir}`);
      await load();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setRollbacking(false);
    }
  };

  const scanQuality = async () => {
    setQualityLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/workflows/${id}/quality`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "质量体检失败");
      setQualityResult(data);
      setQualityRepairResult(null);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setQualityLoading(false);
    }
  };

  const repairQuality = async () => {
    setQualityRepairing(true);
    setError("");
    try {
      const response = await fetch(`${API}/workflows/${id}/quality/repair`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "质量修复失败");
      setQualityRepairResult(data);
      setQualityResult(data.after);
      setExportResult(`质量修复完成：已备份到 ${data.backupPath}`);
      await load();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setQualityRepairing(false);
    }
  };

  const openEditorWithQualityInstruction = () => {
    if (!qualityResult) {
      onOpenEditor();
      return;
    }
    const failed = qualityResult.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.label}：${check.detail}`);
    const risky = qualityResult.contamination
      .filter((item) => item.risky)
      .map((item) => `${item.label}：${item.matches.join("、")}`)
      .slice(0, 4);
    const duplicates = qualityResult.duplicates
      .slice(0, 4)
      .map((item) => `${item.count} 次重复：${item.text.slice(0, 46)}`);
    const instruction = [
      "请像 Codex 一样根据质量体检结果继续修复当前项目书，直接修改中间编辑器并保存。",
      `体检分数：${qualityResult.score}（${qualityResult.band}）。`,
      failed.length ? `未通过检查：${failed.join("；")}` : "",
      qualityResult.risks.length ? `高风险：${qualityResult.risks.slice(0, 4).join("；")}` : "",
      qualityResult.specificity.missing.length ? `缺失专属信号：${qualityResult.specificity.missing.slice(0, 8).join("、")}` : "",
      risky.length ? `串项风险：${risky.join("；")}` : "",
      duplicates.length ? `重复内容：${duplicates.join("；")}` : "",
      qualityResult.actions.length ? `优先执行动作：${qualityResult.actions.slice(0, 4).join("；")}` : "",
      "要求：不要把修改后的全文输出在对话栏；右侧只汇报诊断、计划、执行、复核，正文直接写入编辑器。",
    ].filter(Boolean).join("\n");
    onOpenEditor(instruction);
  };

  const completionMap = useMemo(() => {
    const map = new Map<number, Checkpoint>();
    workflow?.checkpoints?.forEach((c) => map.set(c.stepIndex, c));
    return map;
  }, [workflow]);

  if (!workflow) return <p className="muted">加载中...</p>;

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">{workflow.competition}{workflow.track ? ` / ${workflow.track}` : ""}</p>
          <h1>{workflow.name}</h1>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onBack}>返回</button>
          <button className="ghost" onClick={() => onOpenEditor()}>编辑器</button>
          <button className="ghost" onClick={() => exportFile("docx")} disabled={running || exporting !== "" || workflow.status !== "completed"}>
            {exporting === "docx" ? "导出中..." : "导出 Word"}
          </button>
          <button className="ghost" onClick={() => exportFile("pdf")} disabled={running || exporting !== "" || workflow.status !== "completed"}>
            {exporting === "pdf" ? "导出中..." : "导出 PDF"}
          </button>
          <button className="ghost" onClick={() => exportFile("tex")} disabled={running || exporting !== "" || workflow.status !== "completed"}>
            {exporting === "tex" ? "导出中..." : "导出 LaTeX"}
          </button>
          <button className="ghost" onClick={scanQuality} disabled={running || qualityLoading || workflow.status !== "completed"}>
            {qualityLoading ? "体检中..." : "质量体检"}
          </button>
          <button className="primary" onClick={() => deliver(false)} disabled={running || delivering}>
            {delivering ? "交付包生成中..." : "一键生成交付包"}
          </button>
          <button className="primary" onClick={start} disabled={running}>{running ? "生成中..." : "启动生成"}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {exportResult && <p className="success">{exportResult}</p>}
      {qualityResult && (
        <QualityPanel
          result={qualityResult}
          repairResult={qualityRepairResult}
          onRepair={repairQuality}
          onAgentRepair={openEditorWithQualityInstruction}
          busy={qualityRepairing || running}
        />
      )}
      {deliveryResult && (
        <DeliveryPanel
          result={deliveryResult}
          latestBackup={workflow.latestBackup}
          onForce={() => deliver(true)}
          onRollback={rollbackLatest}
          busy={delivering || running}
          rollbacking={rollbacking}
        />
      )}
      <div className="detail-grid">
        <aside className="panel">
          <div className="section-title">
            <h2>执行阶段</h2>
            <span className={statusClass(workflow.status)}>{statusLabel(workflow.status)}</span>
          </div>
          <div className="steps">
            {[
              { id: "research-brief", name: "自动调研资料包", agent: "调研智能体", checkpointType: "research-brief", stepIndex: -2 },
              { id: "evidence-index", name: "证据库索引", agent: "证据库智能体", checkpointType: "evidence-index", stepIndex: -1 },
              ...workflow.steps.map((step, index) => ({ ...step, stepIndex: index + 1 })),
              { id: "final-review-loop", name: "终稿评审返修", agent: "评审返修智能体", checkpointType: "final-review", stepIndex: workflow.steps.length + 1 },
            ].map((step, index) => {
              const checkpoint = completionMap.get(step.stepIndex);
              const state = checkpoint?.status || "draft";
              return (
                <div className={`step ${state}`} key={step.id}>
                  <span className="step-index">{index + 1}</span>
                  <div>
                    <strong>{step.name}</strong>
                    <p>{step.agent} · {step.checkpointType}</p>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </aside>
        <section className="panel work-area">
          <div className="section-title">
            <h2>产物与定稿</h2>
            <button className="ghost compact" onClick={load}>刷新</button>
          </div>
          <div className="artifact-tabs">
            {[...(workflow.artifacts ?? []), ...(workflow.drafts ?? [])].map((artifact) => (
              <button
                className={activeArtifact?.name === artifact.name ? "artifact-tab active" : "artifact-tab"}
                key={`${artifact.path}-${artifact.name}`}
                onClick={() => setActiveArtifact(artifact)}
              >
                {artifact.name}
              </button>
            ))}
          </div>
          {activeArtifact ? <MarkdownPreview content={activeArtifact.content} /> : <p className="muted">启动生成后会在这里看到每个阶段的产物。</p>}
        </section>
      </div>
    </section>
  );
}

function DeliveryPanel({
  result,
  latestBackup,
  onForce,
  onRollback,
  busy,
  rollbacking,
}: {
  result: DeliveryResult;
  latestBackup?: { id: string; path: string } | null;
  onForce: () => void;
  onRollback: () => void;
  busy: boolean;
  rollbacking: boolean;
}) {
  const importantFiles = [
    result.files.finalMarkdown,
    result.files.qualityReport,
    result.files.reviewReport,
    result.files.docx,
    result.files.pdf,
  ].filter(Boolean);
  const passed = result.checks.filter((item) => item.ok).length;
  return (
    <section className="delivery-panel">
      <div className="section-title">
        <div>
          <h2>最终交付包</h2>
          <p className="muted small">已生成 Word/PDF，并完成终稿、质检、复审和格式交付检查。</p>
        </div>
        <div className="delivery-actions">
          {latestBackup && (
            <button className="ghost compact" onClick={onRollback} disabled={busy || rollbacking}>
              {rollbacking ? "回滚中..." : "回滚到上次重生成前"}
            </button>
          )}
          <button className="ghost compact" onClick={onForce} disabled={busy}>重新生成并覆盖</button>
        </div>
      </div>
      <div className="delivery-summary">
        <div>
          <span>通过检查</span>
          <strong>{passed}/{result.checks.length}</strong>
        </div>
        <div>
          <span>导出目录</span>
          <strong>{result.exportDir}</strong>
        </div>
        <div>
          <span>生成时间</span>
          <strong>{new Date(result.generatedAt).toLocaleString()}</strong>
        </div>
      </div>
      {result.guidance && (
        <div className={result.guidance.status === "ready" ? "delivery-guidance ready" : "delivery-guidance warn"}>
          <strong>{result.guidance.status === "ready" ? "交付状态" : "待处理项"}</strong>
          <span>{result.guidance.summary}</span>
          <small>{result.guidance.nextActions.join("；")}</small>
        </div>
      )}
      {(result.backup || result.regeneration || latestBackup) && (
        <div className="delivery-backup">
          {result.backup && (
            <>
              <strong>本次重生成前已备份</strong>
              <span>{result.backup.backupDir}</span>
              <small>备份文件 {result.backup.files.length} 个，可用回滚按钮恢复。</small>
            </>
          )}
          {!result.backup && latestBackup && (
            <>
              <strong>可回滚备份</strong>
              <span>{latestBackup.path}</span>
              <small>最近备份编号：{latestBackup.id}</small>
            </>
          )}
          {result.regeneration && (
            <>
              <strong>重生成变化</strong>
              <span>{result.regeneration.summary}</span>
              <small>
                正文 {result.regeneration.beforeChars.toLocaleString()}{" -> "}{result.regeneration.afterChars.toLocaleString()} 字符；
                标题 {result.regeneration.beforeHeadings}{" -> "}{result.regeneration.afterHeadings}；
                表格 {result.regeneration.beforeTables}{" -> "}{result.regeneration.afterTables}
              </small>
            </>
          )}
        </div>
      )}
      <div className="delivery-files">
        {importantFiles.map((file) => (
          <div className={file.exists ? "delivery-file ready" : "delivery-file missing"} key={file.path || file.label}>
            <strong>{file.label}</strong>
            <span>{file.exists ? file.path : "未生成"}</span>
            <small>{file.exists ? `${file.size.toLocaleString()} bytes` : "missing"}</small>
          </div>
        ))}
      </div>
      <div className="delivery-checks">
        {result.checks.map((check) => (
          <div className={check.ok ? "delivery-check ok" : "delivery-check warn"} key={check.label}>
            <span>{check.ok ? "✓" : "!"}</span>
            <strong>{check.label}</strong>
            <small>{check.detail}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function QualityPanel({
  result,
  repairResult,
  onRepair,
  onAgentRepair,
  busy,
}: {
  result: QualityScanResult;
  repairResult: QualityRepairResult | null;
  onRepair: () => void;
  onAgentRepair: () => void;
  busy: boolean;
}) {
  const risky = result.contamination.filter((item) => item.risky);
  const needsRepair = result.checks.some((check) => !check.ok) || risky.length > 0 || result.duplicates.length > 0 || result.genericSamples.length > 0 || result.metrics.adviceHits > 0;
  const metricItems = [
    ["正文", `${result.metrics.chars.toLocaleString()} 字符`],
    ["章节", `${result.metrics.chapterSignals}/${result.metrics.chapterTotal}`],
    ["表格", `${result.metrics.tableRows} 行`],
    ["图示", `${result.metrics.figureSignals} 个`],
    ["证据", `${result.metrics.evidenceHits} 次`],
    ["口吻", `${result.metrics.adviceHits} 风险`],
  ];
  return (
    <section className="quality-panel">
      <div className="section-title">
        <div>
          <h2>质量体检</h2>
          <p className="muted small">检查终稿的项目专属度、串项、重复、套话、章节和格式风险。</p>
        </div>
        <div className="quality-head-actions">
          <button className="ghost compact" onClick={onRepair} disabled={busy || !needsRepair}>
            {busy ? "修复中..." : needsRepair ? "按体检自动修复" : "无需修复"}
          </button>
          <button className="ghost compact" onClick={onAgentRepair} disabled={busy}>
            交给 Agent 继续修
          </button>
          <div className={`quality-score ${result.score >= 85 ? "good" : result.score >= 75 ? "mid" : "bad"}`}>
            <strong>{result.score}</strong>
            <span>{result.band}</span>
          </div>
        </div>
      </div>
      {repairResult && (
        <div className="quality-repair-note">
          <strong>已自动修复</strong>
          <span>
            分数 {repairResult.before.score} → {repairResult.after.score}；
            字符变化 {repairResult.changedChars >= 0 ? "+" : ""}{repairResult.changedChars.toLocaleString()}；
            删除重复段落 {repairResult.removedParagraphs}、重复句 {repairResult.removedSentences}、串项行 {repairResult.removedContaminationLines}。
          </span>
        </div>
      )}
      {result.profile && (
        <div className="quality-profile">
          <span>当前画像</span>
          <strong>{result.profile.title}</strong>
          <small>{result.profile.domain}</small>
        </div>
      )}
      <div className="quality-metrics">
        {metricItems.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
        <div>
          <span>项目专属度</span>
          <strong>{result.specificity.score}/100</strong>
        </div>
        <div>
          <span>串项风险</span>
          <strong>{risky.length ? `${risky.length} 类` : "0"}</strong>
        </div>
      </div>
      <div className="quality-checks">
        {result.checks.map((check) => (
          <div className={check.ok ? "quality-check ok" : "quality-check warn"} key={check.label}>
            <span>{check.ok ? "✓" : "!"}</span>
            <strong>{check.label}</strong>
            <small>{check.detail}</small>
          </div>
        ))}
      </div>
      <div className="quality-columns">
        <div>
          <h3>专属信号</h3>
          <p>{result.specificity.examples.length ? result.specificity.examples.join("、") : "暂无明显命中"}</p>
        </div>
        <div>
          <h3>需要补强</h3>
          <p>{result.specificity.missing.length ? result.specificity.missing.slice(0, 8).join("、") : "暂无明显缺口"}</p>
        </div>
        <div>
          <h3>风险</h3>
          <p>{result.risks.length ? result.risks.slice(0, 3).join("；") : "未发现高风险问题"}</p>
        </div>
        <div>
          <h3>下一步</h3>
          <p>{result.actions.length ? result.actions.slice(0, 3).join("；") : "保持当前终稿并核对真实附件"}</p>
        </div>
      </div>
    </section>
  );
}

function WorkflowEditor({
  id,
  initialInstruction,
  onInitialInstructionConsumed,
  onBack,
}: {
  id: string;
  initialInstruction?: string;
  onInitialInstructionConsumed?: () => void;
  onBack: () => void;
}) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [groups, setGroups] = useState<EditorFileGroup[]>([]);
  const [activeFile, setActiveFile] = useState<EditorFile | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [compiling, setCompiling] = useState<"" | "docx" | "pdf" | "tex">("");
  const [bottomTab, setBottomTab] = useState<"preview" | "log" | "output">("preview");
  const [compileLog, setCompileLog] = useState("等待编译。");
  const [compileResult, setCompileResult] = useState("");
  const [compilePreviewUrl, setCompilePreviewUrl] = useState("");
  const [assistantMode, setAssistantMode] = useState<"light" | "agent">("light");
  const [assistantScope, setAssistantScope] = useState<"latex" | "python">("latex");
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const consumedInitialInstructionRef = useRef("");
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { role: "assistant", status: "info", text: "我会按“诊断-计划-执行-复核”处理当前编辑器：右侧汇报判断依据和结果，正文修改直接写入中间编辑器。" },
  ]);
  const [error, setError] = useState("");

  const allFiles = useMemo(() => groups.flatMap((group) => group.files), [groups]);
  const dirty = activeFile ? content !== savedContent : false;

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const persistEditorContent = async (nextContent: string, file = activeFile) => {
    if (!file) throw new Error("当前没有可保存的文件");
    const response = await fetch(`${API}/workflows/${id}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file.path, content: nextContent }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    setSavedContent(nextContent);
    setActiveFile((prev) => prev ? { ...prev, ...data.file } : prev);
    setGroups((prev) => prev.map((group) => ({
      ...group,
      files: group.files.map((item) => item.path === file.path ? { ...item, ...data.file } : item),
    })));
    return data.file as EditorFile;
  };

  const loadFiles = async (keepPath?: string) => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/workflows/${id}/files`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "文件树加载失败");
      setWorkflow(data.workflow);
      setGroups(data.groups || []);
      const files: EditorFile[] = (data.groups || []).flatMap((group: EditorFileGroup) => group.files);
      const nextFile = files.find((file) => file.path === keepPath)
        || files.find((file) => file.name === "project-book-final.md")
        || files[0]
        || null;
      if (nextFile) await openFile(nextFile);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (file: EditorFile) => {
    setError("");
    const response = await fetch(`${API}/workflows/${id}/file?path=${encodeURIComponent(file.path)}`);
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "文件读取失败");
      return;
    }
    setActiveFile({ ...file, ...data });
    setContent(data.content || "");
    setSavedContent(data.content || "");
    setBottomTab(file.extension === "md" ? "preview" : "output");
  };

  const saveFile = async () => {
    if (!activeFile) return;
    setSaving(true);
    setError("");
    try {
      await persistEditorContent(content, activeFile);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  const compile = async (format: "docx" | "pdf" | "tex") => {
    if (!activeFile) return;
    setCompiling(format);
    setBottomTab("log");
    setCompileLog(activeFile.extension === "tex" && format === "pdf"
      ? "正在保存当前 .tex，并调用 Codex LaTeX 插件编译 PDF..."
      : "正在保存当前文件并调用项目书导出器...");
    setCompileResult("");
    setCompilePreviewUrl("");
    setError("");
    try {
      const response = await fetch(`${API}/workflows/${id}/editor/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeFile.path, content, format }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "编译失败");
      setSavedContent(content);
      setCompileLog(data.log || "编译完成。");
      setCompileResult(data.outputPath || "");
      setCompilePreviewUrl(data.previewUrl || "");
      if (data.previewUrl) setBottomTab("output");
    } catch (err: any) {
      setCompileLog(`编译失败：${err.message ?? String(err)}`);
      setCompilePreviewUrl("");
      setError(err.message ?? String(err));
    } finally {
      setCompiling("");
    }
  };

  const askAssistant = async () => {
    const instruction = assistantInput.trim();
    if (!instruction) return;
    await runAssistantInstruction(instruction);
  };

  const runAssistantInstruction = async (
    instruction: string,
    options?: { mode?: "light" | "agent"; scope?: "latex" | "python" },
  ) => {
    setAssistantInput("");
    setAssistantBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: instruction },
      { role: "assistant", status: "working", text: `收到：${instruction}\n正在处理：${activeFile?.name || "当前编辑器"}\n状态：分析指令并准备应用到中间编辑器。` },
    ]);
    try {
      const response = await fetch(`${API}/workflows/${id}/editor/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          mode: `${options?.mode ?? assistantMode}/${options?.scope ?? assistantScope}`,
          path: activeFile?.path,
          content,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI 助手调用失败");
      const patch = data.canApply ? String(data.patch || "") : "";
      const action = String(data.action || "suggest");
      const shouldApply = action === "replace_current_file" && patch;
      const beforeApply = content;
      let autoSaved = false;
      const editSummary = shouldApply ? summarizeEdit(beforeApply, patch) : null;
      if (shouldApply) {
        setContent(patch);
        setBottomTab("preview");
        if (data.autoApply !== false && activeFile) {
          await persistEditorContent(patch, activeFile);
          autoSaved = true;
        }
      }
      if (action === "compile_pdf") compile("pdf");
      if (action === "export_docx") compile("docx");
      if (action === "export_tex") compile("tex");
      const statusText = compactAssistantStatus(String(data.answer || ""), action, patch, activeFile?.name);
      const trace = normalizeAgentTrace(data.agentTrace);
      const backup = data.backup || null;
      setMessages((prev) => {
        const doneMessage: AssistantMessage = {
          role: "assistant",
          status: shouldApply ? "done" : "info",
          text: editSummary ? `${statusText}\n${editSummary.summary}${autoSaved ? "\n已保存：本次修改已写入项目文件。" : ""}${backup?.backupDir ? "\n已备份：改前版本已保存，可用于追溯或手动恢复。" : ""}` : statusText,
          patch: shouldApply ? "" : patch,
          preview: editSummary?.preview,
          undoContent: shouldApply ? beforeApply : undefined,
          backup,
          trace,
        };
        return appendAssistantResult(prev, doneMessage);
      });
    } catch (err: any) {
      setMessages((prev) => {
        const errorMessage: AssistantMessage = { role: "assistant", status: "error", text: `执行失败：${err.message ?? String(err)}` };
        return appendAssistantResult(prev, errorMessage);
      });
    } finally {
      setAssistantBusy(false);
    }
  };

  useEffect(() => {
    const instruction = initialInstruction?.trim();
    if (!instruction || assistantBusy || !activeFile || consumedInitialInstructionRef.current === instruction) return;
    consumedInitialInstructionRef.current = instruction;
    setAssistantMode("agent");
    setAssistantScope("latex");
    onInitialInstructionConsumed?.();
    runAssistantInstruction(instruction, { mode: "agent", scope: "latex" });
  }, [initialInstruction, activeFile?.path, assistantBusy]);

  useEffect(() => { loadFiles(); }, [id]);

  const currentStage = workflow?.steps?.find((step, index) => workflow.checkpoints?.some((checkpoint) => checkpoint.stepIndex === index + 1 && checkpoint.status === "running"));
  const assistantTitle = assistantMode === "agent" ? "Agent 模式" : `${assistantScope === "latex" ? "LaTeX" : "Python"} 编辑助手`;
  const assistantHint = assistantMode === "agent"
    ? "Agent 会先诊断全文缺口，再规划修改、执行补丁并复核结果。"
    : `输入修改指令，AI 自动处理当前 ${assistantScope === "latex" ? "LaTeX / Markdown" : "Python / 数据"} 文件；可以直接说“完善项目书”。`;
  const assistantWarning = assistantMode === "agent"
    ? "Agent 模式适合整篇完善、批量改写、编译排错；右侧展示诊断指标和执行结果，正文在中间编辑器应用。"
    : "轻量模式只处理当前打开文件，响应更快，但跨文件能力有限。";
  const assistantPlaceholder = assistantMode === "agent"
    ? "输入指令，例如：继续完善整篇项目书。Ctrl+Enter 发送"
    : "输入修改指令，例如：完善项目书。Ctrl+Enter 发送";
  const editorLines = Math.max(content.split("\n").length, 12);

  return (
    <section className="editor-page">
      <div className="editor-top">
        <div className="editor-title">
          <span className="editor-file-tab">{activeFile?.name || "project-book-final.md"}</span>
          <span className="editor-path">{activeFile?.path || workflow?.name || "Paper-agent Workbench"}</span>
        </div>
        <div className="editor-tools editor-top-tools">
          <button className="ghost compact" onClick={onBack}>返回</button>
          <button className="ghost compact" onClick={() => loadFiles(activeFile?.path)}>刷新</button>
          <button className="ghost compact" onClick={() => compile("docx")} disabled={!activeFile || compiling !== ""}>{compiling === "docx" ? "导出中" : "导出 Word"}</button>
          <button className="ghost compact" onClick={() => compile("pdf")} disabled={!activeFile || compiling !== ""}>{compiling === "pdf" ? "编译中" : "编译 PDF"}</button>
          <button className="primary compact" onClick={saveFile} disabled={!activeFile || !dirty || saving}>{saving ? "保存中..." : dirty ? "保存" : "已保存"}</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="editor-grid">
        <aside className="editor-sidebar">
          <div className="editor-panel-title">
            <strong>文件工作区</strong>
            <span>{allFiles.length} files</span>
          </div>
          {loading && <p className="muted small">正在加载文件...</p>}
          {!loading && groups.map((group) => (
            <div className="file-group" key={group.root}>
              <div className="file-group-title">{group.label}</div>
              {group.files.length === 0 && <p className="muted small">暂无文件</p>}
              {group.files.map((file) => (
                <button
                  className={activeFile?.path === file.path ? "file-item active" : "file-item"}
                  key={file.path}
                  onClick={() => openFile(file)}
                >
                  <span className={`file-dot ${file.kind}`} />
                  <span>{file.name}</span>
                  <small>{file.extension}</small>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="editor-main">
          <div className="editor-tabs">
            {activeFile ? (
              <button className="editor-tab active">{activeFile.name}{dirty ? " *" : ""}</button>
            ) : (
              <span className="muted">请选择一个文件</span>
            )}
            <div className="editor-tools">
              <button className="ghost compact" onClick={() => compile("tex")} disabled={!activeFile || compiling !== ""}>{compiling === "tex" ? "生成中" : "LaTeX"}</button>
            </div>
          </div>
          <div className="code-shell">
            <div className="line-rail" aria-hidden="true">
              {Array.from({ length: editorLines }, (_, index) => <span key={index}>{index + 1}</span>)}
            </div>
            <textarea
              className="code-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              placeholder="选择 project-book-final.md 或章节产物开始编辑"
            />
          </div>
          <div className="editor-bottom">
            <div className="bottom-tabs">
              <button className={bottomTab === "preview" ? "active" : ""} onClick={() => setBottomTab("preview")}>预览</button>
              <button className={bottomTab === "log" ? "active" : ""} onClick={() => setBottomTab("log")}>编译日志</button>
              <button className={bottomTab === "output" ? "active" : ""} onClick={() => setBottomTab("output")}>脚本输出</button>
            </div>
            <div className="bottom-content">
              {bottomTab === "preview" && (content ? <MarkdownPreview content={content} /> : <p className="muted">暂无可预览内容。</p>)}
              {bottomTab === "log" && <pre>{compileLog}</pre>}
              {bottomTab === "output" && (
                <div className="output-card">
                  <strong>{compileResult ? "最近输出文件" : "尚未生成输出"}</strong>
                  <p>{compileResult || "点击 Word / PDF / LaTeX 后，这里会显示本次编译或导出的结果路径。"}</p>
                  {compilePreviewUrl && (
                    <div className="output-actions">
                      <a className="primary compact output-link" href={compilePreviewUrl} target="_blank" rel="noreferrer">打开 PDF</a>
                      <span>当前 PDF 来自 Codex LaTeX 插件编译链路</span>
                    </div>
                  )}
                  {compilePreviewUrl && <iframe className="pdf-preview-frame" src={compilePreviewUrl} title="PDF 预览" />}
                </div>
              )}
            </div>
          </div>
        </main>

        <aside className="assistant-panel">
          <div className="assistant-head">
            <strong>{assistantTitle}</strong>
            <button onClick={() => setMessages([])}>清除</button>
          </div>
          <div className="assistant-mode-stack">
            <div className="mode-row">
              <button className={assistantMode === "light" ? "active" : ""} onClick={() => setAssistantMode("light")}>轻量</button>
              <button className={assistantMode === "agent" ? "active" : ""} onClick={() => setAssistantMode("agent")}>Agent</button>
            </div>
            {assistantMode === "light" && (
              <div className="mode-row scope-row">
                <button className={assistantScope === "latex" ? "active" : ""} onClick={() => setAssistantScope("latex")}>LaTeX</button>
                <button className={assistantScope === "python" ? "active" : ""} onClick={() => setAssistantScope("python")}>Python</button>
              </div>
            )}
          </div>
          <p className="assistant-hint">{assistantHint}</p>
          <p className={assistantMode === "agent" ? "assistant-warning agent" : "assistant-warning"}>{assistantWarning}</p>
          <div className="assistant-quick-row">
            <button
              className="ghost compact"
              onClick={() => runAssistantInstruction("请像 Codex 一样自检当前项目书，自己判断哪里还没有完善，然后直接修改中间编辑器。")}
              disabled={assistantBusy || !activeFile}
            >
              自检继续完善
            </button>
            <button
              className="ghost compact"
              onClick={() => runAssistantInstruction("检查当前正文是否还有建议式语言、系统说明、重复内容或跨项目串项，有就直接清理到中间编辑器。")}
              disabled={assistantBusy || !activeFile}
            >
              清理正文痕迹
            </button>
          </div>
          <div className="chat-log" ref={chatLogRef}>
            {messages.map((message, index) => (
              <div className={`chat-message ${message.role} ${message.status || ""}`} key={`${message.role}-${index}`}>
                <div>{message.text}</div>
                {message.trace && message.trace.length > 0 && (
                  <div className="agent-trace">
                    {message.trace.map((item) => (
                      <div className={`trace-step ${item.status || "done"}`} key={`${item.step}-${item.label}`}>
                        <span>{item.step}</span>
                        <div>
                          <strong>{item.label}</strong>
                          <small>{item.detail}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {message.preview && <pre className="patch-preview">{message.preview}</pre>}
                {message.backup?.backupDir && (
                  <div className="editor-backup-note">
                    <strong>改前备份</strong>
                    <span>{message.backup.backupDir}</span>
                    {message.backup.relativePath && <small>{message.backup.relativePath}</small>}
                  </div>
                )}
                {message.patch && (
                  <div className="message-actions">
                    <button
                      className="apply-patch-button"
                      onClick={async () => {
                        const nextPatch = message.patch || "";
                        setContent(nextPatch);
                        setBottomTab("preview");
                        try {
                          await persistEditorContent(nextPatch);
                          setMessages((prev) => prev.map((item, itemIndex) => itemIndex === index
                            ? { ...item, patch: undefined, text: `${item.text}\n已应用并保存：补丁已写入当前文件。` }
                            : item));
                        } catch (err: any) {
                          setError(err.message ?? String(err));
                        }
                      }}
                    >
                      应用并保存
                    </button>
                  </div>
                )}
                {message.undoContent !== undefined && (
                  <div className="message-actions">
                    <button
                      className="undo-patch-button"
                      onClick={async () => {
                        const restored = message.undoContent || "";
                        setContent(restored);
                        setBottomTab("preview");
                        try {
                          await persistEditorContent(restored);
                          setMessages((prev) => prev.map((item, itemIndex) => itemIndex === index
                            ? { ...item, undoContent: undefined, text: `${item.text}\n已撤销并保存：当前文件已恢复到本次应用前。` }
                            : item));
                        } catch (err: any) {
                          setError(err.message ?? String(err));
                        }
                      }}
                    >
                      撤销并保存
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="assistant-send-row">
            <textarea
              className="assistant-input"
              value={assistantInput}
              onChange={(event) => setAssistantInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  askAssistant();
                }
              }}
              placeholder={assistantPlaceholder}
            />
            <button className="primary" onClick={askAssistant} disabled={assistantBusy || !assistantInput.trim()}>
              {assistantBusy ? "分析中" : "发送"}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const html = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n")
    .map((line) => {
      if (/^#\s/.test(line)) return `<h1>${line.replace(/^#\s*/, "")}</h1>`;
      if (/^##\s/.test(line)) return `<h2>${line.replace(/^##\s*/, "")}</h2>`;
      if (/^###\s/.test(line)) return `<h3>${line.replace(/^###\s*/, "")}</h3>`;
      if (/^\|/.test(line)) return `<pre>${line}</pre>`;
      if (/^-\s/.test(line)) return `<p class="list">${line.replace(/^-\s*/, "• ")}</p>`;
      if (/^\d+\.\s/.test(line)) return `<p class="list">${line}</p>`;
      return line.trim() ? `<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>` : `<br/>`;
    })
    .join("");
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Settings() {
  const SCXAI_BASE_URL = "https://api.scxai.top";
  const API_KEY_URL = "https://api.scxai.top/";
  const [settings, setSettings] = useState({
    provider: "scxai",
    baseUrl: SCXAI_BASE_URL,
    model: "claude-opus-4-6",
    apiKey: "",
    imageProvider: "scxai",
    imageBaseUrl: SCXAI_BASE_URL,
    imageModel: "gpt-image-1",
    imageApiKey: "",
  });
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingAgent, setTestingAgent] = useState("");
  const [testResult, setTestResult] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelListResult, setModelListResult] = useState("");
  const [testingImage, setTestingImage] = useState(false);
  const [imageTestResult, setImageTestResult] = useState("");

  useEffect(() => {
    fetch(`${API}/settings`).then((r) => r.json()).then((data) => {
      if (data.settings) {
        setSettings((prev) => ({
          ...prev,
          ...data.settings,
          provider: "scxai",
          baseUrl: SCXAI_BASE_URL,
          model: data.settings.model || prev.model,
          apiKey: "",
          imageProvider: data.settings.imageProvider || prev.imageProvider,
          imageBaseUrl: data.settings.imageBaseUrl || prev.imageBaseUrl,
          imageModel: data.settings.imageModel || prev.imageModel,
          imageApiKey: "",
        }));
      }
    });
  }, []);

  const update = (key: keyof typeof settings, value: string) => setSettings((prev) => ({ ...prev, [key]: value }));
  const saveCurrentSettings = async () => {
    await fetch(`${API}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { ...settings, provider: "scxai", baseUrl: SCXAI_BASE_URL } }),
    });
  };
  const updateImageProvider = (provider: string) => {
    setSettings((prev) => ({
      ...prev,
      imageProvider: provider,
      imageBaseUrl: provider === "openai" ? "https://api.openai.com" : provider === "scxai" ? SCXAI_BASE_URL : prev.imageBaseUrl,
      imageModel: provider === "openai" ? "gpt-image-1" : prev.imageModel || "gpt-image-1",
    }));
  };

  const save = async () => {
    await saveCurrentSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const refreshModels = async (menuKey = "") => {
    setLoadingModels(true);
    setModelListResult("");
    await saveCurrentSettings();
    try {
      const response = await fetch(`${API}/settings/models`);
      const data = await response.json();
      setModelOptions(data.models || []);
      if ((data.models || []).length && menuKey) setModelMenuOpen(menuKey);
      setModelListResult(`${data.ok ? "模型列表已刷新" : "模型列表刷新失败"}：${data.message}`);
    } catch (error: any) {
      setModelListResult(`模型列表刷新失败：${error.message || String(error)}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const test = async (agentTitle: string) => {
    setTesting(true);
    setTestingAgent(agentTitle);
    setTestResult("");
    await saveCurrentSettings();
    const response = await fetch(`${API}/settings/test-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model }),
    });
    const data = await response.json();
    setTestResult(`${data.ok ? "连接成功" : "连接失败"}：${data.message}`);
    setTesting(false);
    setTestingAgent("");
  };

  const testImage = async () => {
    setTestingImage(true);
    setImageTestResult("");
    await saveCurrentSettings();
    const response = await fetch(`${API}/settings/test-image`, { method: "POST" });
    const data = await response.json();
    setImageTestResult(`${data.ok ? "连接成功" : "连接失败"}：${data.message}`);
    setTestingImage(false);
  };

  const openApiKeyPage = () => {
    window.open(API_KEY_URL, "_blank", "noopener,noreferrer");
  };

  const agents = [
    { title: "执行者 AGENT", desc: "负责项目书章节生成、资料整理、技术方案和商业计划撰写" },
    { title: "审稿者 AGENT", desc: "负责评审、打分、找弱点（跨模型协作）" },
    { title: "编辑器 AI 助手", desc: "LaTeX 编辑器中的 AI 对话修改功能" },
    { title: "LaTeX 编辑器", desc: "负责论文与项目书的 LaTeX 源码输出、结构整理和格式修复" },
    { title: "项目书 AGENT", desc: "负责生成、审稿、补全图表说明与导出前检查" },
  ];

  return (
    <section className="settings-page">
      <div className="settings-stack">
        {agents.map((agent) => (
          <section className="settings-card" key={agent.title}>
            {(() => {
              const modelMenuKey = agent.title;
              return (
                <>
            <div className="settings-card-head">
              <div>
                <h2>{agent.title}</h2>
                <p>{agent.desc}</p>
              </div>
              <button className="settings-test" onClick={() => test(agent.title)} disabled={testing}>{testing && testingAgent === agent.title ? "测试中..." : "测试连接"}</button>
            </div>
            <p className="settings-warning">△ 点击测试连接会先保存当前填写的 API Key 和 Model ID</p>
            <label>Base URL</label>
            <input className="settings-input" value={SCXAI_BASE_URL} readOnly />
            <p className="settings-note">
              为确保服务稳定性和数据安全，本系统统一使用 SCXAI API 中转服务。该服务已针对项目书/论文工作流场景优化，支持高并发长文本输出，保障工作流不中断。
              <button type="button" className="settings-link" onClick={openApiKeyPage}>前往获取 API Key →</button>
            </p>
            <label>API Key</label>
            <input className="settings-input" value={settings.apiKey} onChange={(e) => update("apiKey", e.target.value)} type="password" placeholder="请输入从 SCXAI 获取的 API Key；留空则保留旧配置" />
            <label>Model ID</label>
            <div className="model-picker">
              <div className="model-combo">
                <input
                  className="settings-input model-input"
                  value={settings.model}
                  onChange={(e) => {
                    update("model", e.target.value);
                    if (modelOptions.length) setModelMenuOpen(modelMenuKey);
                  }}
                  onFocus={() => {
                    if (modelOptions.length) setModelMenuOpen(modelMenuKey);
                  }}
                  placeholder="可直接输入任意模型 ID，例如 gpt-4o / gpt-4.1 / claude-opus-4-6"
                />
                <button
                  type="button"
                  className="model-menu-toggle"
                  onClick={() => setModelMenuOpen((open) => open === modelMenuKey ? "" : modelMenuKey)}
                  aria-label="展开模型候选"
                  title="展开模型候选"
                >
                  ▾
                </button>
                {modelMenuOpen === modelMenuKey && (
                  <div className="model-menu">
                    {modelOptions.length ? modelOptions.map((model) => (
                      <button
                        type="button"
                        className="model-menu-item"
                        key={model.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          update("model", model.id);
                          setModelMenuOpen("");
                        }}
                      >
                        <span>{model.id}</span>
                        {model.ownedBy && <small>{model.ownedBy}</small>}
                      </button>
                    )) : (
                      <div className="model-menu-empty">先点击刷新模型，或直接手动输入 Model ID</div>
                    )}
                  </div>
                )}
              </div>
              <button className="settings-test compact" onClick={() => refreshModels(modelMenuKey)} disabled={loadingModels}>{loadingModels ? "刷新中..." : "刷新模型"}</button>
            </div>
            <p className="settings-note model-note">Model ID 可手动输入；刷新模型会自动隐藏 gpt-image、embedding、audio 等非文本模型，只保留文本候选。保存后点击“测试连接”确认当前模型是否能用于 Paper-agent。</p>
            {modelListResult && <p className={modelListResult.startsWith("模型列表已刷新") ? "success" : "error"}>{modelListResult}</p>}
            {testResult && !testingAgent && <p className={testResult.startsWith("连接成功") ? "success" : "error"}>{testResult}</p>}
                </>
              );
            })()}
          </section>
        ))}

        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h2>其他配置</h2>
              <p>图表和项目书导出目前使用本地生成器，可按需扩展</p>
            </div>
            <button className="settings-test" onClick={testImage} disabled={testingImage}>{testingImage ? "测试中..." : "测试连接"}</button>
          </div>
          <p className="settings-warning">△ 点击测试连接会先保存当前填写的图像 API Key，并判断本地/外部模式</p>
          <label>Image Provider</label>
          <div className="segmented image-provider">
            <button className={settings.imageProvider === "scxai" ? "active" : ""} onClick={() => updateImageProvider("scxai")}>SCXAI</button>
            <button className={settings.imageProvider === "openai" ? "active" : ""} onClick={() => updateImageProvider("openai")}>OpenAI</button>
            <button className={settings.imageProvider === "custom" ? "active" : ""} onClick={() => updateImageProvider("custom")}>自定义</button>
          </div>
          <label>Image Base URL</label>
          <input className="settings-input" value={settings.imageBaseUrl} onChange={(e) => update("imageBaseUrl", e.target.value)} placeholder="https://api.scxai.top" />
          <label>Image Model ID</label>
          <input className="settings-input" value={settings.imageModel} onChange={(e) => update("imageModel", e.target.value)} placeholder="gpt-image-1 / dall-e-3 / flux..." />
          <label>GPT Image API Key</label>
          <input className="settings-input" value={settings.imageApiKey} onChange={(e) => update("imageApiKey", e.target.value)} type="password" placeholder="用于生成示意图/技术路线图/流程图（可选）；留空则保留旧配置" />
          <p className="settings-note">当前 Paper-agent 已内置本地图表生成器；填写图像服务配置后会尝试外部图像服务。SCXAI 默认使用 https://api.scxai.top，OpenAI 默认使用 https://api.openai.com。</p>
          {imageTestResult && <p className={imageTestResult.startsWith("连接成功") ? "success" : "error"}>{imageTestResult}</p>}
        </section>

        <button className="settings-save" onClick={save}>{saved ? "已保存配置" : "保存配置"}</button>
      </div>
    </section>
  );
}

function Style() {
  return (
    <style>{`
      :root {
        color-scheme: light;
        --bg: #f6f7f9;
        --panel: #ffffff;
        --panel-glass: rgba(255,255,255,.96);
        --surface: #ffffff;
        --surface-soft: #f8fafc;
        --surface-mute: #eef1f5;
        --text: #20242a;
        --muted: #687180;
        --faint: #97a1af;
        --line: #dfe4ea;
        --line-strong: #cfd6e4;
        --accent: #2563eb;
        --accent-soft: #eaf1ff;
        --accent-border: #93c5fd;
        --warm: #f59e0b;
        --warm-soft: #fff7e6;
        --mint: #0f9f8f;
        --ok: #15803d;
        --warn: #b45309;
        --bad: #b91c1c;
        --topbar: rgba(255,255,255,0.96);
        --nav: #4f5871;
        --nav-active: #2f3850;
        --page-grid-bg: #eef2f7;
        --page-grid-line: #dce3ed;
        --settings-grid-bg: #f4f6fb;
        --settings-grid-line: #e5e9f2;
        --danger-soft: #fff7f7;
        --danger-line: #fecaca;
        --success-soft: #ecfdf3;
        --success-line: #bbf7d0;
        --warning-soft: #fff7ed;
        --shadow: 0 12px 32px rgba(31, 41, 55, .05);
        font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      :root[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0e141d;
        --panel: #151d29;
        --panel-glass: rgba(21,29,41,.94);
        --surface: #111827;
        --surface-soft: #182232;
        --surface-mute: #202b3b;
        --text: #eef4ff;
        --muted: #a8b3c4;
        --faint: #778499;
        --line: #2b3748;
        --line-strong: #3a4658;
        --accent: #7aa7ff;
        --accent-soft: #172848;
        --accent-border: #456da7;
        --warm: #f6b84b;
        --warm-soft: #33260e;
        --mint: #2dd4bf;
        --ok: #6ee7a8;
        --warn: #fbbf64;
        --bad: #ff8a8a;
        --topbar: rgba(14,20,29,.96);
        --nav: #a8b3c4;
        --nav-active: #ffffff;
        --page-grid-bg: #0f1722;
        --page-grid-line: #1f2b3b;
        --settings-grid-bg: #0f1722;
        --settings-grid-line: #1f2b3b;
        --danger-soft: #351d22;
        --danger-line: #7f3340;
        --success-soft: #12291f;
        --success-line: #276447;
        --warning-soft: #322412;
        --shadow: 0 18px 44px rgba(0,0,0,.28);
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); }
      button, input, textarea, select { font: inherit; }
      .app { min-height: 100vh; }
      .topbar { height: 74px; display: flex; align-items: center; gap: 28px; padding: 0 22px; border-bottom: 1px solid var(--line); background: var(--topbar); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 10; }
      .brand { display: inline-flex; align-items: center; gap: 10px; border: 0; background: transparent; color: var(--text); font-weight: 700; cursor: pointer; padding: 0; }
      .brand-logo { width: 34px; height: 27px; object-fit: contain; display: block; }
      .brand-logo.large { width: 58px; height: 46px; }
      .brand-mark { width: 30px; height: 30px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: #fff; font-weight: 800; }
      .brand-mark.large { width: 44px; height: 44px; border-radius: 10px; font-size: 20px; }
      nav { display: flex; gap: 6px; }
      .nav { border: 0; background: transparent; color: var(--nav); padding: 0 20px; height: 74px; border-radius: 0; cursor: pointer; font-size: 18px; }
      .nav.active, .nav:hover { background: transparent; color: var(--nav-active); }
      .theme-toggle { margin-left: auto; width: 46px; height: 46px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 8px 22px rgba(15, 23, 42, .08); transition: background .18s, border-color .18s, transform .18s, box-shadow .18s; }
      .theme-toggle:hover { transform: translateY(-1px); border-color: var(--accent-border); box-shadow: 0 12px 28px rgba(15, 23, 42, .14); }
      .theme-icon { position: relative; width: 20px; height: 20px; border-radius: 999px; transition: background .18s, box-shadow .18s; }
      .theme-toggle.is-light .theme-icon { background: #f59e0b; box-shadow: 0 -8px 0 -6px #f59e0b, 0 8px 0 -6px #f59e0b, 8px 0 0 -6px #f59e0b, -8px 0 0 -6px #f59e0b, 6px 6px 0 -6px #f59e0b, -6px -6px 0 -6px #f59e0b, 6px -6px 0 -6px #f59e0b, -6px 6px 0 -6px #f59e0b; }
      .theme-toggle.is-dark .theme-icon { background: #dbeafe; box-shadow: inset -7px -4px 0 #111827; }
      .shell { max-width: 1360px; margin: 0 auto; padding: 30px 24px 56px; }
      .button-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-right: 7px; font-weight: 900; line-height: 1; }
      .workflow-console { min-width: 0; }
      .console-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 28px; align-items: end; margin: 4px 0 22px; padding: 0 0 22px; border-bottom: 1px solid var(--line); }
      .console-title { min-width: 0; }
      .console-kicker { margin: 0 0 8px; color: var(--warm); font-size: 12px; font-weight: 900; text-transform: uppercase; }
      .console-title h1 { margin: 0; font-size: 34px; line-height: 1.12; color: var(--text); }
      .console-title p { max-width: 720px; margin: 10px 0 0; color: var(--muted); line-height: 1.65; }
      .console-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
      .console-primary { height: 44px; padding: 0 18px; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; box-shadow: 0 12px 24px rgba(37, 99, 235, .16); }
      .console-layout { display: grid; grid-template-columns: minmax(0, 1fr) 318px; gap: 18px; align-items: start; }
      .console-main { min-width: 0; display: grid; gap: 16px; }
      .stat-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      .stat-tile { min-height: 96px; padding: 15px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); display: grid; align-content: space-between; box-shadow: var(--shadow); }
      .stat-tile span { color: var(--muted); font-size: 12px; font-weight: 800; }
      .stat-tile strong { color: var(--text); font-size: 28px; line-height: 1; }
      .stat-tile small { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .workflow-toolbar { min-height: 58px; display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: 10px; align-items: stretch; }
      .search-control { position: relative; display: block; margin: 0; }
      .search-mark { position: absolute; left: 15px; top: 50%; width: 14px; height: 14px; border: 2px solid var(--faint); border-radius: 999px; transform: translateY(-55%); pointer-events: none; }
      .search-mark::after { content: ""; position: absolute; width: 7px; height: 2px; right: -6px; bottom: -3px; border-radius: 999px; background: var(--faint); transform: rotate(45deg); transform-origin: center; }
      .console-search { height: 58px; padding-left: 42px; border-radius: 8px; background: var(--panel); box-shadow: var(--shadow); }
      .refresh-button { height: 58px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; }
      .workflow-empty { min-height: 260px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 28px; align-items: center; padding: 34px 40px; box-shadow: var(--shadow); overflow: hidden; }
      .workflow-empty h2 { margin: 6px 0 8px; color: var(--text); font-size: 24px; }
      .workflow-empty p { margin: 0 0 18px; color: var(--muted); line-height: 1.7; max-width: 620px; }
      .empty-visual { position: relative; height: 174px; border-radius: 8px; background: linear-gradient(135deg, var(--surface-soft), var(--surface)); border: 1px solid var(--line); overflow: hidden; }
      .empty-visual::before { content: ""; position: absolute; inset: 16px; border: 1px dashed var(--line-strong); border-radius: 8px; }
      .empty-sheet { position: absolute; width: 94px; height: 118px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--panel); box-shadow: 0 14px 28px rgba(31, 41, 55, .08); }
      .sheet-one { left: 34px; top: 32px; transform: rotate(-7deg); }
      .sheet-two { left: 84px; top: 24px; transform: rotate(3deg); }
      .sheet-three { left: 138px; top: 42px; transform: rotate(9deg); }
      .empty-rule { position: absolute; left: 54px; right: 54px; bottom: 34px; height: 7px; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--warm)); opacity: .72; }
      .console-aside { display: grid; gap: 14px; position: sticky; top: 92px; }
      .side-panel { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 18px; box-shadow: var(--shadow); }
      .start-panel { background: linear-gradient(180deg, var(--panel), var(--surface-soft)); }
      .side-number { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 28px; border-radius: 7px; background: var(--warm-soft); color: var(--warm); font-size: 12px; font-weight: 900; }
      .side-panel h2 { margin: 12px 0 8px; font-size: 18px; color: var(--text); }
      .side-panel p { margin: 0 0 16px; color: var(--muted); line-height: 1.65; font-size: 13px; }
      .rule-list { display: grid; gap: 9px; margin-top: 12px; }
      .rule-list span { min-height: 34px; display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 13px; line-height: 1.45; }
      .rule-list span::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--mint); box-shadow: 0 0 0 4px color-mix(in srgb, var(--mint) 16%, transparent); flex: 0 0 auto; }
      .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
      .page-head h1 { margin: 4px 0 0; font-size: 25px; letter-spacing: 0; }
      .eyebrow { margin: 0; color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .primary, .ghost { border-radius: 7px; border: 1px solid transparent; padding: 9px 15px; cursor: pointer; font-weight: 650; }
      .primary { background: var(--accent); color: #fff; }
      .primary:disabled, .ghost:disabled { opacity: .55; cursor: not-allowed; }
      .ghost { background: var(--surface); border-color: var(--line); color: var(--text); }
      .compact { padding: 5px 10px; font-size: 12px; }
      .wide { width: 100%; padding: 12px 16px; }
      .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
      .stat, .panel, .workflow-card, .empty, .gate-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
      .stat { padding: 16px; }
      .stat span { color: var(--muted); font-size: 12px; display: block; }
      .stat strong { display: block; margin-top: 8px; font-size: 24px; }
      .toolbar { display: flex; gap: 10px; margin: 18px 0; }
      input, textarea, select { width: 100%; border: 1px solid var(--line); background: var(--surface); border-radius: 7px; padding: 10px 12px; color: var(--text); outline: none; }
      textarea { resize: vertical; line-height: 1.6; }
      input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
      .workflow-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
      .workflow-card { text-align: left; padding: 18px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
      .workflow-card:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,.16); outline: none; }
      .workflow-card:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: 0 10px 24px rgba(20, 30, 50, .08); }
      .workflow-card h2 { margin: 14px 0 8px; font-size: 17px; }
      .workflow-card p { color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
      .card-row, .meta-row, .actions, .section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .card-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
      .delete-workflow { flex: 0 0 auto; height: 28px; border: 1px solid var(--danger-line); border-radius: 7px; background: var(--danger-soft); color: var(--bad); padding: 0 10px; cursor: pointer; font-size: 12px; font-weight: 800; }
      .delete-workflow:hover { background: var(--danger-soft); border-color: var(--bad); }
      .delete-workflow:disabled { opacity: .55; cursor: not-allowed; }
      .meta-row { justify-content: flex-start; color: var(--faint); font-size: 12px; }
      .status { display: inline-flex; align-items: center; height: 24px; border-radius: 999px; padding: 0 9px; font-size: 12px; color: var(--muted); background: var(--surface-mute); }
      .status.running { color: var(--warn); background: var(--warning-soft); }
      .status.done { color: var(--ok); background: var(--success-soft); }
      .status.failed { color: var(--bad); background: var(--danger-soft); }
      .muted { color: var(--muted); }
      .small { font-size: 12px; }
      .empty { padding: 46px; text-align: center; color: var(--muted); }
      .empty h2 { color: var(--text); margin-top: 0; }
      .split { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 18px; align-items: start; }
      .panel { padding: 20px; }
      .panel h2 { margin: 0 0 14px; font-size: 17px; }
      .new-workflow-page { max-width: 1180px; margin: 0 auto; }
      .workflow-hero { align-items: center; margin-bottom: 18px; }
      .hero-copy .muted { margin: 7px 0 0; }
      .workflow-builder { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 18px; align-items: start; }
      .builder-main { display: grid; gap: 16px; }
      .builder-section, .summary-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
      .builder-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .builder-section-head h2 { margin: 0; font-size: 16px; }
      .builder-section-head span { color: var(--faint); font-size: 12px; }
      .template-rail { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .template-tile { display: grid; grid-template-columns: 40px 1fr; column-gap: 12px; row-gap: 3px; min-height: 136px; border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 15px; text-align: left; cursor: pointer; transition: border-color .16s, background .16s, box-shadow .16s, transform .16s; }
      .template-tile:hover { border-color: var(--accent-border); transform: translateY(-1px); box-shadow: 0 10px 22px rgba(30, 41, 59, .07); }
      .template-tile.active { border-color: var(--accent); background: linear-gradient(180deg, var(--accent-soft), var(--surface)); box-shadow: 0 0 0 3px rgba(37,99,235,.08); }
      .tile-icon { grid-row: span 4; width: 40px; height: 40px; border-radius: 8px; background: var(--surface-soft); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; }
      .template-tile.active .tile-icon { background: var(--accent); color: #fff; }
      .template-tile strong { font-size: 14px; }
      .template-tile small { color: var(--warm); font-weight: 800; }
      .template-tile p { margin: 3px 0; color: var(--muted); line-height: 1.45; font-size: 12px; }
      .template-tile em { color: var(--faint); font-style: normal; font-size: 12px; }
      .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
      .wide-field { grid-column: 1 / -1; }
      .param-card { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
      .param-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
      .param-row:last-child { border-bottom: 0; }
      .param-row strong { display: block; font-size: 14px; }
      .param-row p { margin: 4px 0 0; color: var(--faint); font-size: 12px; line-height: 1.45; }
      .number-box { margin: 0; width: 132px; display: flex; align-items: center; gap: 8px; }
      .number-box input, .toggle-count input { text-align: center; padding: 8px 9px; }
      .number-box span { color: var(--muted); }
      .segmented { display: grid; grid-template-columns: 1fr 1fr; min-width: 260px; gap: 8px; }
      .segmented button { border: 0; border-radius: 7px; padding: 9px 12px; background: var(--surface-mute); color: var(--muted); cursor: pointer; font-weight: 700; }
      .segmented button.active { background: var(--warm); color: #fff; }
      .image-provider { grid-template-columns: repeat(3, 1fr); min-width: 0; margin: 0 0 22px; }
      .image-provider button { height: 44px; border-radius: 12px; }
      .toggle-count { display: grid; grid-template-columns: 52px 140px; gap: 10px; align-items: center; }
      .count-stepper { display: grid; grid-template-columns: 32px minmax(54px, 1fr) 32px; gap: 6px; align-items: center; }
      .count-stepper button { height: 34px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft); color: var(--text); cursor: pointer; font-weight: 800; }
      .count-stepper input { height: 34px; }
      .switch { width: 48px; height: 28px; border: 0; border-radius: 999px; background: var(--surface-mute); cursor: pointer; position: relative; }
      .switch::after { content: ""; position: absolute; top: 4px; left: 4px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(15, 23, 42, .18); transition: transform .16s; }
      .switch.on { background: #635bff; }
      .switch.on::after { transform: translateX(20px); }
      .upload-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .upload-box { min-height: 108px; margin: 0; border: 1px dashed var(--line-strong); border-radius: 8px; background: var(--surface-soft); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 7px; padding: 16px; text-align: center; cursor: pointer; }
      .upload-box:hover { border-color: var(--accent); background: var(--accent-soft); }
      .upload-box span { color: var(--text); font-weight: 700; }
      .upload-box small { color: var(--faint); line-height: 1.45; overflow-wrap: anywhere; }
      .upload-box input { display: none; }
      .launch-button { width: 100%; border: 0; border-radius: 8px; padding: 16px 18px; color: #fff; background: linear-gradient(90deg, #635bff, #4f46e5); font-size: 16px; font-weight: 800; cursor: pointer; box-shadow: 0 12px 28px rgba(79,70,229,.22); }
      .launch-button:disabled { opacity: .62; cursor: not-allowed; }
      .builder-summary { position: sticky; top: 76px; display: grid; gap: 14px; }
      .summary-card h2 { margin: 4px 0 8px; font-size: 18px; }
      .summary-card p { color: var(--muted); line-height: 1.5; margin: 0 0 14px; }
      .summary-list { display: grid; gap: 8px; }
      .summary-list div { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
      .summary-list span { width: 24px; height: 24px; border-radius: 7px; background: var(--accent-soft); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
      .summary-list strong { color: var(--text); font-weight: 700; }
      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 18px; }
      .chips span { border: 1px solid var(--accent-border); background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 6px 10px; font-size: 12px; }
      label { display: block; margin: 14px 0 7px; font-size: 12px; font-weight: 700; color: var(--muted); }
      .template-list { display: grid; gap: 10px; }
      .template { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 14px; text-align: left; cursor: pointer; }
      .template.active { border-color: var(--accent); background: var(--accent-soft); }
      .template strong, .template span, .template small { display: block; }
      .template span { color: var(--muted); line-height: 1.5; margin: 5px 0; }
      .template small { color: var(--faint); }
      .error { color: var(--bad); background: var(--danger-soft); border: 1px solid var(--danger-line); padding: 10px 12px; border-radius: 7px; }
      .success { color: var(--ok); background: var(--success-soft); border: 1px solid var(--success-line); padding: 10px 12px; border-radius: 7px; }
      .detail-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 16px; align-items: start; }
      .delivery-panel { margin: 0 0 16px; padding: 16px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-soft); box-shadow: var(--shadow); }
      .delivery-summary { display: grid; grid-template-columns: 150px minmax(0, 1fr) 220px; gap: 10px; margin: 14px 0; }
      .delivery-summary div { border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; background: var(--surface); min-width: 0; }
      .delivery-summary span { display: block; color: var(--faint); font-size: 11px; margin-bottom: 4px; }
      .delivery-summary strong { display: block; color: var(--text); font-size: 13px; overflow-wrap: anywhere; }
      .delivery-guidance { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 4px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); padding: 10px 12px; margin: 0 0 12px; }
      .delivery-guidance.ready { border-color: var(--success-line); background: var(--success-soft); }
      .delivery-guidance.warn { border-color: var(--danger-line); background: var(--danger-soft); }
      .delivery-guidance strong { color: var(--text); font-size: 12px; }
      .delivery-guidance span { color: var(--text); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
      .delivery-guidance small { grid-column: 2; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; }
      .delivery-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .delivery-backup { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 5px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); padding: 10px 12px; margin: 0 0 12px; }
      .delivery-backup strong { color: var(--text); font-size: 12px; }
      .delivery-backup span { color: var(--text); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
      .delivery-backup small { grid-column: 2; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; }
      .delivery-files { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
      .delivery-file { min-width: 0; border: 1px solid var(--line); border-radius: 7px; padding: 10px; background: var(--surface); }
      .delivery-file.ready { border-color: var(--success-line); }
      .delivery-file.missing { border-color: var(--danger-line); background: var(--danger-soft); }
      .delivery-file strong, .delivery-file span, .delivery-file small { display: block; min-width: 0; }
      .delivery-file strong { font-size: 12px; color: var(--text); margin-bottom: 5px; }
      .delivery-file span { color: var(--muted); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
      .delivery-file small { color: var(--faint); margin-top: 6px; }
      .delivery-checks { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .delivery-check { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 2px 8px; align-items: start; border: 1px solid var(--line); border-radius: 7px; padding: 9px 10px; background: var(--surface); }
      .delivery-check span { width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 900; }
      .delivery-check.ok span { background: #dcfce7; color: #15803d; }
      .delivery-check.warn span { background: #fee2e2; color: #b91c1c; }
      .delivery-check strong { color: var(--text); font-size: 12px; }
      .delivery-check small { grid-column: 2; color: var(--muted); line-height: 1.35; overflow-wrap: anywhere; }
      .quality-panel { margin: 0 0 16px; padding: 16px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-soft); box-shadow: var(--shadow); }
      .quality-head-actions { display: inline-flex; align-items: center; gap: 10px; }
      .quality-score { width: 74px; height: 58px; display: grid; place-items: center; gap: 0; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); }
      .quality-score strong { font-size: 24px; line-height: 1; }
      .quality-score span { color: var(--muted); font-size: 11px; font-weight: 800; }
      .quality-score.good { border-color: var(--success-line); background: var(--success-soft); color: var(--ok); }
      .quality-score.mid { border-color: #fed7aa; background: var(--warning-soft); color: #b45309; }
      .quality-score.bad { border-color: var(--danger-line); background: var(--danger-soft); color: var(--bad); }
      .quality-repair-note { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; align-items: center; border: 1px solid var(--success-line); border-radius: 7px; background: var(--success-soft); color: var(--ok); padding: 9px 10px; margin: 12px 0 0; }
      .quality-repair-note strong { font-size: 12px; }
      .quality-repair-note span { color: var(--text); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
      .quality-profile { display: grid; grid-template-columns: 72px minmax(0, 0.9fr) minmax(0, 1.5fr); gap: 8px; align-items: center; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); padding: 9px 10px; margin: 12px 0 0; }
      .quality-profile span { color: var(--faint); font-size: 11px; font-weight: 800; }
      .quality-profile strong { color: var(--text); font-size: 13px; overflow-wrap: anywhere; }
      .quality-profile small { color: var(--muted); line-height: 1.35; overflow-wrap: anywhere; }
      .quality-metrics { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
      .quality-metrics div { min-width: 0; border: 1px solid var(--line); border-radius: 7px; padding: 9px 10px; background: var(--surface); }
      .quality-metrics span { display: block; color: var(--faint); font-size: 11px; margin-bottom: 4px; }
      .quality-metrics strong { display: block; color: var(--text); font-size: 13px; overflow-wrap: anywhere; }
      .quality-checks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
      .quality-check { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 2px 8px; align-items: start; border: 1px solid var(--line); border-radius: 7px; padding: 9px 10px; background: var(--surface); }
      .quality-check span { width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 900; }
      .quality-check.ok span { background: #dcfce7; color: #15803d; }
      .quality-check.warn span { background: #fee2e2; color: #b91c1c; }
      .quality-check strong { color: var(--text); font-size: 12px; }
      .quality-check small { grid-column: 2; color: var(--muted); line-height: 1.35; overflow-wrap: anywhere; }
      .quality-columns { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .quality-columns div { min-width: 0; border: 1px solid var(--line); border-radius: 7px; padding: 10px; background: var(--surface); }
      .quality-columns h3 { margin: 0 0 6px; font-size: 12px; color: var(--text); }
      .quality-columns p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .steps { display: grid; gap: 10px; margin-top: 16px; }
      .step { display: flex; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
      .step.completed { border-color: var(--success-line); background: var(--success-soft); }
      .step.running { border-color: #fed7aa; background: var(--warning-soft); }
      .step strong { display: block; font-size: 13px; }
      .step p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
      .step-index { flex: 0 0 auto; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; background: var(--surface-mute); color: var(--muted); font-weight: 700; font-size: 12px; }
      .work-area { min-height: 650px; }
      .artifact-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
      .artifact-tab { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--muted); }
      .artifact-tab.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
      .markdown { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 24px; line-height: 1.8; max-height: 70vh; overflow: auto; }
      .markdown h1 { font-size: 22px; margin: 0 0 16px; }
      .markdown h2 { font-size: 18px; margin: 22px 0 8px; color: var(--accent); }
      .markdown h3 { font-size: 15px; margin: 18px 0 6px; }
      .markdown p { margin: 6px 0; }
      .markdown pre { margin: 3px 0; padding: 4px 8px; background: var(--surface-soft); border-radius: 4px; white-space: pre-wrap; font-family: Consolas, monospace; font-size: 12px; }
      .markdown .list { padding-left: 8px; }
      .editor-page { margin: -30px calc(50% - 50vw) -56px; min-height: calc(100vh - 74px); height: calc(100vh - 74px); padding: 46px clamp(24px, 3.2vw, 64px) 34px; overflow: hidden; background-color: var(--page-grid-bg); background-image: linear-gradient(var(--page-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--page-grid-line) 1px, transparent 1px); background-size: 48px 48px; }
      .editor-top { max-width: 1740px; margin: 0 auto 12px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
      .editor-title { display: flex; align-items: center; min-width: 0; gap: 0; }
      .editor-file-tab { min-width: 112px; height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 0 18px; border: 1px solid var(--line); border-bottom-color: var(--panel); border-radius: 10px 10px 0 0; background: var(--panel-glass); color: var(--text); font-weight: 800; font-size: 13px; box-shadow: 0 10px 22px rgba(20,30,50,.04); }
      .editor-path { min-width: 0; color: var(--faint); font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 16px; }
      .editor-top-tools { flex: 0 0 auto; }
      .editor-grid { max-width: 1740px; margin: 0 auto; display: grid; grid-template-columns: clamp(236px, 18vw, 316px) minmax(0, 1fr) clamp(300px, 24vw, 404px); gap: clamp(12px, 1vw, 18px); height: calc(100vh - 176px); min-height: 560px; }
      .editor-sidebar, .editor-main, .assistant-panel { border: 1px solid var(--line-strong); border-radius: 13px; background: var(--panel-glass); box-shadow: var(--shadow); min-height: 0; }
      .editor-sidebar { padding: 16px 16px 12px; overflow: auto; }
      .assistant-panel { padding: 18px; overflow: hidden; position: static; height: 100%; max-height: none; }
      .editor-panel-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; color: var(--text); }
      .editor-panel-title strong { font-size: 15px; }
      .editor-panel-title span { color: var(--faint); font-size: 12px; text-transform: none; }
      .file-group { border-top: 0; padding-top: 8px; margin-top: 8px; }
      .file-group-title { color: var(--faint); font-size: 12px; font-weight: 800; margin-bottom: 7px; }
      .file-item { width: 100%; min-height: 32px; display: grid; grid-template-columns: 12px minmax(0, 1fr) 32px; align-items: center; gap: 8px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); text-align: left; cursor: pointer; padding: 6px 8px; }
      .file-item:hover, .file-item.active { background: var(--accent-soft); color: var(--accent); }
      .file-item span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
      .file-item small { color: var(--faint); text-align: right; font-size: 10px; text-transform: uppercase; }
      .file-dot { width: 9px; height: 9px; border-radius: 3px; background: #94a3b8; }
      .file-dot.draft { background: var(--accent); }
      .file-dot.artifact { background: var(--warm); }
      .file-dot.export { background: var(--mint); }
      .file-dot.upload { background: #10b981; }
      .editor-main { display: grid; grid-template-rows: 52px minmax(260px, 1fr) minmax(180px, 38%); overflow: hidden; }
      .editor-tabs { height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 0 16px; background: var(--panel-glass); }
      .editor-tab { max-width: 56%; border: 0; border-radius: 0; background: transparent; color: var(--faint); padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 800; }
      .editor-tools { display: flex; align-items: center; gap: 7px; }
      .code-shell { min-height: 0; display: grid; grid-template-columns: 66px minmax(0, 1fr); background: var(--surface); overflow: hidden; }
      .line-rail { padding: 18px 14px 18px 0; border-right: 1px solid var(--line); background: var(--surface-soft); color: var(--faint); text-align: right; font: 13px/1.7 Consolas, "Cascadia Mono", monospace; overflow: hidden; user-select: none; }
      .line-rail span { display: block; height: 22.1px; }
      .code-editor { height: 100%; min-height: 0; border: 0; border-radius: 0; padding: 18px 22px; resize: none; font: 13px/1.7 Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace; color: var(--text); background: var(--surface); box-shadow: none; }
      .code-editor:focus { border: 0; box-shadow: inset 0 0 0 2px rgba(37,99,235,.15); }
      .editor-bottom { border-top: 1px solid var(--line); background: var(--surface); min-height: 0; display: grid; grid-template-rows: 42px minmax(0, 1fr); }
      .bottom-tabs { display: flex; gap: 18px; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--line); }
      .bottom-tabs button, .mode-row button { border: 0; border-radius: 7px; background: var(--surface-mute); color: var(--muted); padding: 7px 10px; cursor: pointer; font-weight: 800; font-size: 12px; }
      .bottom-tabs button { border-radius: 0; background: transparent; height: 42px; padding: 0 2px; }
      .bottom-tabs button.active { background: transparent; color: #635bff; box-shadow: inset 0 -2px 0 #635bff; }
      .mode-row button.active { background: #253044; color: #fff; }
      .bottom-content { overflow: auto; padding: 12px; }
      .bottom-content .markdown { max-height: none; padding: 16px; border-radius: 7px; }
      .bottom-content pre { margin: 0; min-height: 100%; white-space: pre-wrap; font: 12px/1.6 Consolas, monospace; color: var(--text); }
      .output-card { height: 100%; border: 1px dashed var(--line-strong); border-radius: 7px; background: var(--surface); padding: 16px; color: var(--muted); }
      .output-card strong { color: var(--text); }
      .output-card p { overflow-wrap: anywhere; line-height: 1.65; }
      .output-actions { display: flex; align-items: center; gap: 12px; margin: 12px 0; flex-wrap: wrap; }
      .output-actions span { color: var(--faint); font-size: 12px; font-weight: 700; }
      .output-link { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; min-height: 34px; }
      .pdf-preview-frame { width: 100%; height: min(420px, 46vh); border: 1px solid var(--line); border-radius: 7px; background: #fff; }
      .assistant-panel { display: grid; grid-template-rows: auto auto auto auto auto minmax(0, 1fr) auto; gap: 10px; }
      .assistant-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); }
      .assistant-head strong { font-size: 16px; color: var(--text); }
      .assistant-head button { border: 0; background: transparent; color: #a6adbc; cursor: pointer; font-weight: 800; padding: 4px 0; }
      .assistant-mode-stack { display: grid; gap: 8px; }
      .mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .assistant-panel .mode-row:first-of-type button.active:first-child { background: #e5e1ff; color: #5b4cf6; }
      .assistant-panel .mode-row:first-of-type button.active:last-child { background: #ffe5d4; color: #f97316; }
      .assistant-panel .scope-row button.active { background: #253044; color: #fff; }
      .assistant-hint { margin: 0; color: var(--faint); font-size: 12px; line-height: 1.5; font-weight: 700; }
      .assistant-warning { margin: -2px 0 2px; color: #ff6b6b; font-size: 12px; line-height: 1.55; }
      .assistant-warning.agent { color: #f97316; }
      .assistant-quick-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .assistant-quick-row button { min-width: 0; overflow-wrap: anywhere; white-space: normal; line-height: 1.25; }
      .chat-log { border: 1px solid var(--line); background: var(--surface); border-radius: 9px; padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; min-height: 0; overscroll-behavior: contain; }
      .chat-message { border-radius: 9px; padding: 10px 11px; font-size: 12px; line-height: 1.62; white-space: pre-wrap; }
      .chat-message.assistant { background: var(--surface); border: 1px solid var(--line); color: var(--text); }
      .chat-message.assistant.working { border-color: var(--accent-border); background: var(--accent-soft); color: var(--text); }
      .chat-message.assistant.done { border-color: var(--success-line); background: var(--success-soft); color: var(--text); }
      .chat-message.assistant.error { border-color: var(--danger-line); background: var(--danger-soft); color: var(--bad); }
      .chat-message.assistant.info { color: var(--muted); }
      .chat-message.user { background: var(--accent); color: #fff; align-self: flex-end; max-width: 92%; }
      .agent-trace { display: grid; gap: 8px; margin-top: 10px; }
      .trace-step { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 8px; align-items: start; border: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 84%, #5b7cfa 6%); border-radius: 9px; padding: 8px; }
      .trace-step > span { width: 22px; height: 22px; border-radius: 999px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 900; }
      .trace-step strong { display: block; color: var(--text); font-size: 12px; margin-bottom: 2px; }
      .trace-step small { display: block; color: var(--muted); line-height: 1.5; word-break: break-word; }
      .patch-preview { margin: 9px 0 0; padding: 9px 10px; border-radius: 8px; border: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 78%, #000 4%); color: var(--text); font-size: 11px; line-height: 1.55; white-space: pre-wrap; max-height: 150px; overflow: auto; }
      .editor-backup-note { margin-top: 9px; display: grid; gap: 3px; border: 1px solid var(--line); border-radius: 8px; background: color-mix(in srgb, var(--surface) 82%, #22c55e 7%); padding: 8px 10px; }
      .editor-backup-note strong { color: var(--text); font-size: 12px; }
      .editor-backup-note span, .editor-backup-note small { color: var(--muted); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
      .message-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .apply-patch-button { margin-top: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; padding: 8px 10px; cursor: pointer; font-weight: 800; font-size: 12px; }
      .message-actions .apply-patch-button { margin-top: 0; }
      .undo-patch-button { border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); padding: 8px 10px; cursor: pointer; font-weight: 800; font-size: 12px; }
      .assistant-send-row { display: grid; grid-template-columns: minmax(0, 1fr) 72px; gap: 10px; align-items: stretch; padding-top: 10px; border-top: 1px solid var(--line); background: var(--panel-glass); }
      .assistant-input { height: 76px; min-height: 76px; border-radius: 12px; resize: none; font-size: 12px; line-height: 1.45; padding: 10px 14px; }
      .assistant-send-row .primary { min-height: 76px; border-radius: 12px; padding: 0 14px; }
      .settings-page { margin: -30px calc(50% - 50vw) -56px; min-height: calc(100vh - 74px); padding: 38px 24px 72px; background-color: var(--settings-grid-bg); background-image: linear-gradient(var(--settings-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--settings-grid-line) 1px, transparent 1px); background-size: 60px 60px; }
      .settings-panel { max-width: 680px; }
      .settings-stack { max-width: 1008px; margin: 0 auto; display: grid; gap: 38px; }
      .settings-card { background: var(--panel-glass); border: 1px solid var(--line-strong); border-radius: 16px; padding: 30px; box-shadow: var(--shadow); }
      .settings-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 26px; }
      .settings-card-head h2 { margin: 0; font-size: 20px; letter-spacing: .04em; color: var(--text); }
      .settings-card-head p { margin: 8px 0 0; color: var(--faint); font-size: 16px; font-weight: 700; }
      .settings-test { border: 1px solid var(--line); background: var(--surface); color: var(--text); border-radius: 14px; min-width: 104px; height: 46px; padding: 0 20px; cursor: pointer; font-weight: 800; font-size: 15px; }
      .settings-test.compact { min-width: 112px; height: 62px; border-radius: 12px; margin-bottom: 22px; }
      .settings-test:disabled { opacity: .55; cursor: not-allowed; }
      .settings-warning { color: #ff6b6b; background: transparent; border: 0; border-radius: 0; padding: 0; font-size: 14px; margin: 0 0 26px; }
      .settings-card label { display: block; margin: 0 0 10px; font-size: 16px; font-weight: 500; color: var(--muted); }
      .settings-input { height: 62px; border-radius: 16px; padding: 0 24px; font-size: 20px; color: var(--text); border-color: var(--line); margin-bottom: 22px; }
      .model-picker { display: grid; grid-template-columns: minmax(0, 1fr) 124px; gap: 12px; align-items: start; }
      .model-combo { position: relative; min-width: 0; }
      .model-input { background: var(--surface); padding-right: 58px; margin-bottom: 0; }
      .model-menu-toggle { position: absolute; right: 10px; top: 9px; width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: var(--text); cursor: pointer; font-size: 18px; line-height: 1; }
      .model-menu-toggle:hover { background: var(--accent-soft); color: var(--accent); }
      .model-menu { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0; max-height: 260px; overflow: auto; padding: 6px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
      .model-menu-item { width: 100%; border: 0; border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; display: grid; gap: 3px; padding: 10px 12px; text-align: left; }
      .model-menu-item:hover { background: var(--accent-soft); }
      .model-menu-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 800; }
      .model-menu-item small { color: var(--muted); font-size: 12px; }
      .model-menu-empty { padding: 12px; color: var(--muted); font-size: 13px; line-height: 1.6; }
      .model-select { appearance: auto; background: var(--surface); overflow: hidden; text-overflow: ellipsis; }
      .compact-input { height: 48px; border-radius: 12px; font-size: 15px; margin-bottom: 12px; }
      .model-note { margin-top: 0; }
      .settings-note { color: var(--faint); font-size: 14px; font-weight: 700; line-height: 1.8; margin: -8px 0 26px; }
      .settings-link { border: 0; background: transparent; color: #667bff; text-decoration: none; font-weight: 800; margin-left: 12px; padding: 0; cursor: pointer; font-size: 14px; }
      .settings-link:hover { text-decoration: underline; }
      .link-button { border: 0; background: transparent; color: #667bff; font-weight: 800; cursor: pointer; padding: 0; }
      .settings-save { width: 100%; border: 0; border-radius: 14px; padding: 17px 18px; color: #fff; background: linear-gradient(90deg, #635bff, #4f46e5); font-size: 16px; font-weight: 800; cursor: pointer; box-shadow: 0 12px 28px rgba(79,70,229,.22); }
      .gate { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .gate-card { width: min(560px, 100%); padding: 34px; }
      .gate-head { display: flex; gap: 14px; align-items: center; margin-bottom: 24px; }
      .gate-head h1 { margin: 0; font-size: 24px; }
      .gate-head p { margin: 4px 0 0; color: var(--muted); }
      .notice { background: var(--surface-soft); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 20px; color: var(--muted); line-height: 1.7; max-height: 430px; overflow: auto; }
      .notice h2 { margin-top: 0; color: var(--text); font-size: 17px; }
      .notice h3 { margin: 18px 0 6px; color: var(--text); font-size: 14px; }
      .notice a { color: var(--accent); text-decoration: none; }
      .activation-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 34%, var(--surface-soft), var(--bg) 56%); }
      .activation-card { width: min(620px, 100%); border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 36px; box-shadow: 0 24px 60px rgba(31, 41, 55, .10); }
      .activation-brand { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
      .activation-kicker { margin: 0 0 6px; color: var(--warm); font-size: 12px; font-weight: 900; text-transform: uppercase; }
      .activation-brand h1 { margin: 0; font-size: 28px; color: var(--text); }
      .activation-brand p:last-child { margin: 7px 0 0; color: var(--muted); }
      .activation-form { border: 1px solid var(--line); border-radius: 8px; padding: 20px; background: var(--surface-soft); }
      .activation-form label { margin: 0 0 10px; color: var(--text); font-size: 14px; }
      .activation-input-row { display: grid; grid-template-columns: minmax(0, 1fr) 116px; gap: 10px; }
      .activation-input-row input { height: 48px; border-radius: 8px; letter-spacing: .08em; font-weight: 800; text-transform: uppercase; }
      .activation-input-row button { height: 48px; border-radius: 8px; }
      .activation-error { margin: 12px 0 0; color: var(--bad); font-size: 13px; font-weight: 700; }
      .activation-notes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
      .activation-notes span { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; text-align: center; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface); font-size: 12px; font-weight: 800; }
      @media (max-width: 1100px) {
        .console-layout { grid-template-columns: 1fr; }
        .console-aside { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .editor-page { padding: 34px 18px 24px; }
        .editor-grid { grid-template-columns: 210px minmax(0, 1fr) 270px; gap: 10px; height: calc(100vh - 152px); }
        .editor-sidebar { padding: 14px 12px; }
        .assistant-panel { padding: 14px; }
        .code-shell { grid-template-columns: 48px minmax(0, 1fr); }
        .line-rail { padding-right: 10px; }
        .editor-path { display: none; }
      }
      @media (max-width: 860px) {
        .stats, .split, .detail-grid, .workflow-builder, .template-rail, .form-grid, .upload-grid, .agent-card-grid, .editor-grid, .stat-strip, .workflow-toolbar, .workflow-empty, .console-aside { grid-template-columns: 1fr; }
        .delivery-summary, .delivery-files, .delivery-checks, .delivery-backup, .quality-metrics, .quality-checks, .quality-columns, .quality-profile { grid-template-columns: 1fr; }
        .delivery-backup small { grid-column: 1; }
        .builder-summary { position: static; }
        .console-hero { grid-template-columns: 1fr; align-items: start; }
        .console-actions { justify-content: flex-start; }
        .console-title h1 { font-size: 28px; }
        .workflow-empty { padding: 24px; }
        .empty-visual { height: 150px; }
        .activation-card { padding: 24px; }
        .activation-input-row, .activation-notes { grid-template-columns: 1fr; }
        .editor-page { height: auto; min-height: calc(100vh - 74px); overflow: visible; padding: 16px; }
        .editor-top { flex-direction: column; }
        .editor-main { grid-template-rows: auto minmax(260px, 48vh) minmax(320px, 1fr); }
        .assistant-panel { position: static; height: 680px; max-height: none; }
        .segmented { min-width: 0; width: 100%; }
        .param-row { align-items: flex-start; flex-direction: column; }
        .topbar { padding: 0 16px; }
        .shell { padding: 22px 16px 40px; }
        .page-head { flex-direction: column; }
      }
    `}</style>
  );
}
