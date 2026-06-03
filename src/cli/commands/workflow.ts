// ============================================================
// paper workflow — TUI 工作流编辑器命令
// ============================================================

import { render } from "ink";
import React from "react";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkflowEditor } from "../ui/WorkflowEditor.js";
import { AGENTS_DIR, TEMPLATE_DIR, TEAMS_DIR } from "../../config/defaults.js";
import { scanAgents } from "../../core/agent/loader.js";
import { scanTemplates } from "../../core/template/parser.js";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { WorkflowNode } from "../../core/workflow/types.js";

interface WorkflowOptions {
  project?: string;
}

function getWorkflowPath(): string {
  const dir = join(homedir(), ".paper", "workflows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "custom-workflow.yaml");
}

function loadWorkflow(): WorkflowNode[] {
  const path = getWorkflowPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    return parseYaml(raw)?.nodes ?? [];
  } catch {
    return [];
  }
}

export async function editWorkflow(_options: WorkflowOptions): Promise<void> {
  const agents = scanAgents(AGENTS_DIR);
  const templates = scanTemplates(TEMPLATE_DIR);

  // 尝试加载已有工作流，没有则用默认
  const saved = loadWorkflow();
  const defaultNodes: WorkflowNode[] = saved.length > 0 ? saved : [
    {
      id: "topic",
      type: "topic_generation",
      label: "选题论证",
      agentRef: "topic-advisor",
      inputs: ["project_name", "variables"],
      outputs: ["topic_suggestion"],
      next: ["write"],
    },
    {
      id: "write",
      type: "write_section",
      label: "申报书写作",
      agentRef: "writer",
      inputs: ["topic_suggestion", "variables", "template_id"],
      outputs: ["full_draft"],
      next: ["evaluate"],
    },
    {
      id: "evaluate",
      type: "evaluate",
      label: "模拟评审",
      agentRef: "reviewer",
      inputs: ["full_draft"],
      outputs: ["score", "review_comments", "improvement_suggestions"],
      next: ["polish"],
      condition: {
        source: "score",
        operator: "lt",
        value: 80,
        passTo: "polish",
        failTo: "",
      },
    },
    {
      id: "polish",
      type: "polish",
      label: "定向优化",
      agentRef: "polisher",
      inputs: ["full_draft", "review_comments", "improvement_suggestions"],
      outputs: ["full_draft"],
      next: ["evaluate"],
    },
  ];

  const { waitUntilExit } = render(
    React.createElement(WorkflowEditor, {
      nodes: defaultNodes,
      agents: agents.map((a) => a.name),
      onSave: (nodes) => {
        const yaml = stringifyYaml({
          name: "自定义工作流",
          nodes,
          agents: [...new Set(nodes.map((n) => n.agentRef))],
        });
        const savePath = getWorkflowPath();
        writeFileSync(savePath, yaml, "utf-8");
        console.log(`✅ 工作流已保存: ${savePath}`);
      },
    }),
  );

  await waitUntilExit();
}
