import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appPath = path.join(root, "frontend", "src", "App.tsx");
const source = fs.readFileSync(appPath, "utf8");

const checks = [
  {
    label: "detail page accepts an optional editor instruction",
    test: () => source.includes("onOpenEditor: (instruction?: string) => void"),
  },
  {
    label: "quality scan result is converted into an agent instruction",
    test: () => [
      "openEditorWithQualityInstruction",
      "qualityResult.checks",
      "qualityResult.specificity.missing",
      "qualityResult.actions",
      "onOpenEditor(instruction)",
    ].every((token) => source.includes(token)),
  },
  {
    label: "quality panel exposes agent repair action",
    test: () => [
      "onAgentRepair",
      "交给 Agent 继续修",
      "onClick={onAgentRepair}",
    ].every((token) => source.includes(token)),
  },
  {
    label: "editor accepts and consumes initial agent instruction",
    test: () => [
      "initialInstruction?: string",
      "onInitialInstructionConsumed?: () => void",
      "consumedInitialInstructionRef",
      "onInitialInstructionConsumed?.()",
    ].every((token) => source.includes(token)),
  },
  {
    label: "initial quality instruction is executed in agent mode",
    test: () => [
      'runAssistantInstruction(instruction, { mode: "agent", scope: "latex" })',
      "mode: `${options?.mode ?? assistantMode}/${options?.scope ?? assistantScope}`",
    ].every((token) => source.includes(token)),
  },
];

const failed = checks.filter((check) => !check.test());
if (failed.length) {
  for (const check of failed) console.error(`Missing: ${check.label}`);
  process.exit(1);
}

console.log("Quality editor flow smoke passed.");
