import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Skills ship as MCP prompts: the agent (or the user, as a slash command) loads the
// recipe when the task calls for it. They live in the repo's skills/ folder, and the
// npm package carries a copy in assets/skills.

export type Skill = { name: string; description: string; body: string };

const ROOTS = ["../assets/skills", "../../../skills"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

export function loadSkills(): Skill[] {
  const root = ROOTS.find((r) => existsSync(r));
  if (!root) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const field = (key: string) => front?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    if (field("status") === "placeholder") continue;
    skills.push({ name: field("name") ?? entry.name, description: field("description") ?? "", body: front ? text.slice(front[0].length).trim() : text });
  }
  return skills;
}
