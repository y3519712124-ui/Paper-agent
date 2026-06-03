// ============================================================
// TUI 可视化工作流编辑器 v2
// Ink + React — 完整节点编排体验
// ============================================================

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { WorkflowNode, WorkflowNodeType } from "../../core/workflow/types.js";

interface WorkflowEditorProps {
  nodes: WorkflowNode[];
  agents: string[];
  onSave: (nodes: WorkflowNode[]) => void;
}

// ── 节点类型颜色映射 ──
const TYPE_STYLE: Record<string, { color: string; icon: string }> = {
  topic_generation: { color: "magenta", icon: "💡" },
  research: { color: "blue", icon: "🔍" },
  innovation_extract: { color: "cyan", icon: "⚡" },
  outline: { color: "cyan", icon: "📋" },
  write_section: { color: "green", icon: "✍" },
  merge: { color: "yellow", icon: "🔗" },
  evaluate: { color: "red", icon: "⭐" },
  polish: { color: "yellow", icon: "✨" },
  format_check: { color: "blue", icon: "📐" },
  custom_agent_call: { color: "white", icon: "🤖" },
};

const NODE_TYPES: { value: WorkflowNodeType; label: string }[] = [
  { value: "topic_generation", label: "选题论证" },
  { value: "research", label: "调研" },
  { value: "innovation_extract", label: "创新提炼" },
  { value: "outline", label: "大纲生成" },
  { value: "write_section", label: "章节写作" },
  { value: "merge", label: "合并" },
  { value: "evaluate", label: "评审" },
  { value: "polish", label: "润色" },
  { value: "format_check", label: "格式检查" },
];

// ── 操作模式 ──
type Mode =
  | "view"
  | "select_type"
  | "select_agent"
  | "edit_connections"
  | "edit_inputs"
  | "edit_outputs"
  | "edit_condition"
  | "confirm_delete"
  | "saved"
  | "confirm_quit";

export function WorkflowEditor({ nodes: initialNodes, agents, onSave }: WorkflowEditorProps) {
  const { exit } = useApp();
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("view");
  const [draftNode, setDraftNode] = useState<WorkflowNode | null>(null);
  const [modified, setModified] = useState(false);
  const [listScroll, setListScroll] = useState(0);

  const current = nodes[cursor];
  const VISIBLE_ROWS = 6;

  useInput(
    useCallback(
      (input, key) => {
        switch (mode) {
          // ═══════════════════ 浏览模式 ═══════════════════
          case "view": {
            if (key.upArrow) {
              setCursor((c) => {
                const next = Math.max(0, c - 1);
                if (next < listScroll) setListScroll(next);
                return next;
              });
            } else if (key.downArrow) {
              setCursor((c) => {
                const next = Math.min(nodes.length - 1, c + 1);
                if (next >= listScroll + VISIBLE_ROWS) setListScroll(next - VISIBLE_ROWS + 1);
                return next;
              });
            } else if (key.return && current) {
              setDraftNode({ ...current });
              setMode("select_type");
            } else if (input === "a") {
              const newNode: WorkflowNode = {
                id: `step-${Date.now()}`,
                type: "write_section",
                label: "新章节",
                agentRef: agents[0] ?? "writer",
                inputs: [],
                outputs: [],
                next: [],
              };
              setDraftNode(newNode);
              setMode("select_type");
            } else if (input === "d" && current) {
              setMode("confirm_delete");
            } else if (key.return && key.ctrl) {
              // Ctrl+Enter = 在当前位置下方插入
              const newNode: WorkflowNode = {
                id: `step-${Date.now()}`,
                type: "write_section",
                label: "新步骤",
                agentRef: agents[0] ?? "writer",
                inputs: [],
                outputs: ["output"],
                next: [],
              };
              const updated = [...nodes];
              updated.splice(cursor + 1, 0, newNode);
              setNodes(updated);
              setCursor(cursor + 1);
              setModified(true);
            } else if (key.upArrow && key.ctrl && cursor > 0) {
              // Ctrl+↑ 上移
              const updated = [...nodes];
              [updated[cursor - 1], updated[cursor]] = [updated[cursor], updated[cursor - 1]];
              setNodes(updated);
              setCursor(cursor - 1);
              setModified(true);
            } else if (key.downArrow && key.ctrl && cursor < nodes.length - 1) {
              // Ctrl+↓ 下移
              const updated = [...nodes];
              [updated[cursor], updated[cursor + 1]] = [updated[cursor + 1], updated[cursor]];
              setNodes(updated);
              setCursor(cursor + 1);
              setModified(true);
            } else if (input === "s") {
              onSave(nodes);
              setMode("saved");
            } else if (input === "q") {
              if (modified) {
                setMode("confirm_quit");
              } else {
                exit();
              }
            } else if (input === "c" && current) {
              // 编辑条件分支
              if (!current.condition) {
                const condNode = { ...current, condition: { source: "score", operator: "lt" as const, value: 80, passTo: "", failTo: "" } };
                setDraftNode(condNode);
              } else {
                setDraftNode({ ...current });
              }
              setMode("edit_condition");
            }
            break;
          }

          // ═══════════════════ 选择节点类型 ═══════════════════
          case "select_type": {
            const typeIdx = NODE_TYPES.findIndex((t) => t.value === draftNode?.type);
            if (key.upArrow) {
              const prev = (typeIdx - 1 + NODE_TYPES.length) % NODE_TYPES.length;
              setDraftNode((d) => d ? { ...d, type: NODE_TYPES[prev].value, label: NODE_TYPES[prev].label } : d);
            } else if (key.downArrow) {
              const next = (typeIdx + 1) % NODE_TYPES.length;
              setDraftNode((d) => d ? { ...d, type: NODE_TYPES[next].value, label: NODE_TYPES[next].label } : d);
            } else if (key.return) {
              setMode("select_agent");
            } else if (key.escape) {
              setDraftNode(null);
              setMode("view");
            }
            break;
          }

          // ═══════════════════ 选择 Agent ═══════════════════
          case "select_agent": {
            const agentIdx = agents.indexOf(draftNode?.agentRef ?? "");
            if (key.upArrow) {
              const prev = (agentIdx - 1 + agents.length) % agents.length;
              setDraftNode((d) => d ? { ...d, agentRef: agents[prev] } : d);
            } else if (key.downArrow) {
              const next = (agentIdx + 1) % agents.length;
              setDraftNode((d) => d ? { ...d, agentRef: agents[next] } : d);
            } else if (key.return) {
              setMode("edit_connections");
            } else if (key.escape) {
              setMode("select_type");
            }
            break;
          }

          // ═══════════════════ 编辑后续连接 ═══════════════════
          case "edit_connections": {
            if (input >= "0" && input <= "9") {
              const targetIdx = parseInt(input);
              if (targetIdx < nodes.length && nodes[targetIdx].id !== draftNode?.id) {
                setDraftNode((d) => {
                  if (!d) return d;
                  const next = d.next.includes(nodes[targetIdx].id)
                    ? d.next.filter((id) => id !== nodes[targetIdx].id)
                    : [...d.next, nodes[targetIdx].id];
                  return { ...d, next };
                });
              }
            } else if (key.return) {
              // 保存节点
              setNodes((prev) => {
                if (!draftNode) return prev;
                const exists = prev.findIndex((n) => n.id === draftNode.id);
                if (exists >= 0) {
                  const updated = [...prev];
                  updated[exists] = draftNode;
                  return updated;
                }
                return [...prev, draftNode];
              });
              setDraftNode(null);
              setModified(true);
              setMode("view");
            } else if (key.escape) {
              setMode("select_agent");
            }
            break;
          }

          // ═══════════════════ 编辑条件分支 ═══════════════════
          case "edit_condition": {
            if (!draftNode?.condition) break;
            if (input === "t") {
              // 切换 source
              const sources = ["score", "innovation", "feasibility", "total"];
              const idx = sources.indexOf(draftNode.condition.source);
              const next = sources[(idx + 1) % sources.length];
              setDraftNode((d) => d ? { ...d, condition: { ...d.condition!, source: next } } : d);
            } else if (input === "+" || input === "=") {
              const val = Math.min(100, (draftNode.condition.value ?? 0) + 5);
              setDraftNode((d) => d ? { ...d, condition: { ...d.condition!, value: val } } : d);
            } else if (input === "-") {
              const val = Math.max(0, (draftNode.condition.value ?? 0) - 5);
              setDraftNode((d) => d ? { ...d, condition: { ...d.condition!, value: val } } : d);
            } else if (input === "o") {
              const ops = ["lt", "gt", "eq", "gte", "lte"] as const;
              const idx = ops.indexOf(draftNode.condition.operator as typeof ops[number]);
              const next = ops[(idx + 1) % ops.length];
              setDraftNode((d) => d ? { ...d, condition: { ...d.condition!, operator: next } } : d);
            } else if (key.return) {
              // 保存条件分支
              setNodes((prev) => {
                if (!draftNode) return prev;
                return prev.map((n) => n.id === draftNode.id ? { ...n, condition: draftNode.condition } : n);
              });
              setDraftNode(null);
              setModified(true);
              setMode("view");
            } else if (key.escape) {
              setDraftNode(null);
              setMode("view");
            }
            break;
          }

          // ═══════════════════ 确认删除 ═══════════════════
          case "confirm_delete": {
            if (input === "y") {
              const updated = nodes.filter((_, i) => i !== cursor);
              setNodes(updated);
              setCursor(Math.min(cursor, updated.length - 1));
              setModified(true);
              setMode("view");
            } else if (input === "n" || key.escape) {
              setMode("view");
            }
            break;
          }

          case "saved": {
            if (key.return || key.escape || input === "q") exit();
            break;
          }

          case "confirm_quit": {
            if (input === "y") exit();
            if (input === "n" || key.escape) setMode("view");
            break;
          }
        }
      },
      [nodes, cursor, mode, draftNode, agents, onSave, exit, modified, listScroll],
    ),
  );

  const visibleNodes = nodes.slice(listScroll, listScroll + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" padding={1}>
      {/* ── 标题栏 ── */}
      <Box marginBottom={1}>
        <Text bold underline color="cyan">
          {" "}Paper-agent 工作流编辑器{" "}
        </Text>
        <Text dimColor>  (共 {nodes.length} 个节点)</Text>
        {modified && <Text color="yellow"> [未保存]</Text>}
      </Box>

      {/* ── 节点列表（可视化连线） ── */}
      <Box flexDirection="column" marginBottom={1}>
        {visibleNodes.map((node, vi) => {
          const realIdx = listScroll + vi;
          const isActive = realIdx === cursor && mode === "view";
          const isEditing = mode !== "view" && draftNode?.id === node.id;
          const style = TYPE_STYLE[node.type] ?? { color: "white", icon: "➤" };

          // 找后续节点在可见列表中的位置
          const nextLabels = node.next
            .map((nid) => {
              const n = nodes.find((x) => x.id === nid);
              return n?.label ?? nid;
            });

          return (
            <Box key={node.id} flexDirection="column">
              {/* 节点行 */}
              <Box>
                {/* 游标 */}
                <Text color="green" bold>
                  {isActive ? " ▸ " : "   "}
                </Text>

                {/* 节点序号 */}
                <Text dimColor>{(realIdx + 1).toString().padStart(2, "0")} </Text>

                {/* 类型图标 */}
                <Text color={style.color as "magenta" | "blue" | "cyan" | "green" | "yellow" | "red" | "white"}>
                  {style.icon}{" "}
                </Text>

                {/* 节点名称 */}
                <Text
                  bold={isActive}
                  inverse={isEditing}
                  color={isActive ? "green" : isEditing ? "cyan" : "white"}
                >
                  {node.label.padEnd(14)}
                </Text>

                {/* 类型标签 */}
                <Text color={style.color as "magenta" | "blue" | "cyan" | "green" | "yellow" | "red" | "white"}>
                  {node.type.replace("_", " ").padEnd(14)}
                </Text>

                {/* Agent */}
                <Text color="cyan">[{node.agentRef}]</Text>

                {/* 条件标记 */}
                {node.condition && <Text color="yellow"> ⚡</Text>}
              </Box>

              {/* 箭头连线 */}
              {nextLabels.length > 0 && (
                <Box paddingLeft={8}>
                  <Text dimColor>
                    {"↳ "}{nextLabels.join(", ")}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* 底部空行提示 */}
        {nodes.length === 0 && (
          <Box paddingLeft={4}>
            <Text dimColor>— 暂无节点，按 a 添加 —</Text>
          </Box>
        )}
      </Box>

      {/* ── 分隔线 ── */}
      <Text dimColor>{"─".repeat(64)}</Text>

      {/* ── 当前节点详情 ── */}
      {current && mode === "view" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{current.label}</Text>
          <Text dimColor>  ID: {current.id}</Text>
          <Text dimColor>  类型: {current.type} | Agent: {current.agentRef}</Text>
          <Text dimColor>  输入: {current.inputs.join(", ") || "(无)"}</Text>
          <Text dimColor>  输出: {current.outputs.join(", ") || "(无)"}</Text>
          <Text dimColor>  流向: {current.next.join(" → ") || "(终点)"}</Text>
          {current.condition && (
            <Text color="yellow">
              条件: 当 {current.condition.source} {current.condition.operator} {current.condition.value}
              {" → "}通过: {current.condition.passTo || "结束"} | 失败: {current.condition.failTo || "结束"}
            </Text>
          )}
        </Box>
      )}

      {/* ── 编辑面板 ── */}
      {mode === "select_type" && draftNode && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">▼ 选择节点类型 (↑↓切换 Enter确认)</Text>
          {NODE_TYPES.map((t) => {
            const selected = t.value === draftNode.type;
            const style = TYPE_STYLE[t.value] ?? { color: "white", icon: "➤" };
            return (
              <Text key={t.value} color={selected ? "green" : "dim"}>
                {selected ? " ▸ " : "   "}
                <Text color={style.color as "magenta" | "blue" | "cyan" | "green" | "yellow" | "red" | "white"}>
                  {style.icon}
                </Text>{" "}
                {t.label} <Text dimColor>({t.value})</Text>
              </Text>
            );
          })}
        </Box>
      )}

      {mode === "select_agent" && draftNode && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">▼ 选择 Agent (↑↓切换 Enter确认)</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {agents.map((a) => (
              <Text key={a} color={a === draftNode.agentRef ? "green" : "dim"} bold={a === draftNode.agentRef}>
                {a === draftNode.agentRef ? " ▸ " : "   "}{a}{"  "}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {mode === "edit_connections" && draftNode && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">▼ 连接后续节点 (按数字键0-9切换 Enter确认)</Text>
          <Text dimColor>  已选: {draftNode.next.join(", ") || "(无)"}</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {nodes.map((n, i) => {
              if (n.id === draftNode.id) return null;
              const connected = draftNode.next.includes(n.id);
              return (
                <Text key={n.id} color={connected ? "green" : "dim"}>
                  [{i}]{connected ? " ✓" : ""} {n.label}{"  "}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === "edit_condition" && draftNode?.condition && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">▼ 条件分支编辑</Text>
          <Text>
            条件: 当{" "}
            <Text bold color="cyan">{draftNode.condition.source}</Text>{" "}
            <Text bold color="green">{draftNode.condition.operator}</Text>{" "}
            <Text bold color="yellow">{draftNode.condition.value}</Text>
          </Text>
          <Text dimColor>  t=切换指标 | o=切换运算符 | +/- 调整阈值 | Enter保存</Text>
        </Box>
      )}

      {/* ── 操作提示 ── */}
      <Box marginTop={1}>
        {mode === "view" && (
          <Text dimColor wrap="truncate-end">
            ↑↓导航 Enter编辑 a添加 d删除 c条件 Ctrl+↑↓移动 s保存 q退出
          </Text>
        )}
        {mode === "confirm_delete" && (
          <Text color="red">
            确认删除 <Text bold>{current?.label}</Text>？ (y/n)
          </Text>
        )}
        {mode === "confirm_quit" && (
          <Text color="yellow">
            有未保存的修改，确认退出？ (y/n)
          </Text>
        )}
        {mode === "saved" && (
          <Text color="green">
            ✅ 已保存！按 Enter 或 q 退出
          </Text>
        )}
      </Box>
    </Box>
  );
}
