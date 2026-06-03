// ============================================================
// paper team — 团队预设管理
// ============================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TEAMS_DIR } from "../../config/defaults.js";
import { parse as parseYaml } from "yaml";

export async function manageTeam(
  action: string,
  name: string | undefined,
): Promise<void> {
  switch (action) {
    case "list": {
      if (!existsSync(TEAMS_DIR)) {
        console.log("没有可用的团队预设");
        return;
      }

      const files = readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".yaml"));
      if (files.length === 0) {
        console.log("没有可用的团队预设");
        return;
      }

      console.log(`\n👥 可用团队预设\n`);
      for (const file of files) {
        const raw = readFileSync(join(TEAMS_DIR, file), "utf-8");
        const team = parseYaml(raw) as Record<string, unknown>;
        const agentList = (team.agents as string[]) ?? [];
        console.log(`  ${file.replace(".yaml", "")}`);
        console.log(`    描述: ${(team.description as string) ?? "-"}`);
        console.log(`    智能体: ${agentList.join(", ")}`);
        console.log(``);
      }
      break;
    }

    case "use": {
      if (!name) {
        console.error("❌ 请指定团队名称: paper team use <name>");
        process.exit(1);
      }

      const teamFile = join(TEAMS_DIR, `${name}.yaml`);
      if (!existsSync(teamFile)) {
        console.error(`❌ 团队 "${name}" 未找到`);
        process.exit(1);
      }

      console.log(`✅ 已切换到团队 "${name}"`);
      console.log(`   下次 paper generate 将使用该团队配置`);
      break;
    }

    default:
      console.error(`未知操作: ${action}（可用: list / use）`);
  }
}
