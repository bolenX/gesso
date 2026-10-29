import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecipes, type RecipeFile } from "./recipes.js";

// Skills ship as MCP prompts: the agent (or the user, as a slash command) loads the
// recipe when the task calls for it. They live in the repo's skills/ folder, and the
// npm package carries a copy in assets/skills. Each has a SKILL.md, and may have a
// recipe.json (patches skill_apply fills in) and a checks.md (what to verify before finishing).

export type Skill = { name: string; description: string; body: string; dir: string; recipes?: RecipeFile; checks?: string };

const ROOTS = ["../assets/skills", "../../../skills"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

export function skillsRoot(): string | undefined {
  return ROOTS.find((r) => existsSync(r));
}

export function loadSkills(root = skillsRoot()): Skill[] {
  if (!root) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    // A value with ": " in it is double-quoted, as YAML requires; JSON reads the same quoting.
    const field = (key: string) => {
      const value = front?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
      return value?.startsWith('"') ? (JSON.parse(value) as string) : value;
    };
    if (field("status") === "placeholder") continue;
    const name = field("name") ?? entry.name;
    const recipePath = join(dir, "recipe.json");
    const checksPath = join(dir, "checks.md");
    skills.push({
      name,
      description: field("description") ?? "",
      body: front ? text.slice(front[0].length).trim() : text,
      dir,
      ...(existsSync(recipePath) ? { recipes: parseRecipes(JSON.parse(readFileSync(recipePath, "utf8")), name) } : {}),
      ...(existsSync(checksPath) ? { checks: readFileSync(checksPath, "utf8").trim() } : {}),
    });
  }
  return skills;
}
