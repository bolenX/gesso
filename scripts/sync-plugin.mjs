// Keeps the plugin and the marketplace files in step with the npm package: copies skills/ into
// plugins/gesso/skills (the directories don't allow symlinks or paths outside the plugin), and the
// package version into every manifest. Run it after changing a skill or bumping the version.
// With --check it changes nothing, lists what's out of step and fails; the tests run it that way.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const plugin = join(root, "plugins/gesso");
/** Skills that exist only in the plugin, not in the engine's skills/. */
const PLUGIN_ONLY = new Set(["get-started"]);
const version = JSON.parse(readFileSync(join(root, "packages/gesso-mcp/package.json"), "utf8")).version;

/** Every JSON field that carries the release version, by file. */
const VERSIONS = {
  "plugins/gesso/plugin.json": [["version"]],
  "plugins/gesso/.claude-plugin/plugin.json": [["version"]],
  "plugins/gesso/.cursor-plugin/plugin.json": [["version"]],
  "gemini-extension.json": [["version"]],
  "server.json": [["version"], ["packages", 0, "version"]],
};
/** Files copied into the plugin as they are. */
const COPIES = { LICENSE: "plugins/gesso/LICENSE", "packages/mcp-server/assets/icon.svg": "plugins/gesso/assets/icon.svg" };

const stale = [];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

for (const [file, paths] of Object.entries(VERSIONS)) {
  const text = readFileSync(join(root, file), "utf8");
  const json = JSON.parse(text);
  for (const path of paths) {
    const parent = path.slice(0, -1).reduce((o, k) => o[k], json);
    parent[path.at(-1)] = version;
  }
  const next = JSON.stringify(json, null, 2) + "\n";
  if (next !== text) {
    stale.push(`${file}: version`);
    if (!check) writeFileSync(join(root, file), next);
  }
}

for (const [from, to] of Object.entries(COPIES)) {
  if (existsSync(join(root, to)) && readFileSync(join(root, from)).equals(readFileSync(join(root, to)))) continue;
  stale.push(to);
  if (!check) cpSync(join(root, from), join(root, to));
}

// The plugin's skills are the engine's, file for file, plus the plugin-only ones.
const source = join(root, "skills");
const target = join(plugin, "skills");
const want = new Set();
for (const skill of readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const file of files(join(source, skill.name))) {
    const rel = join(skill.name, file);
    want.add(rel);
    const [a, b] = [join(source, rel), join(target, rel)];
    if (existsSync(b) && readFileSync(a).equals(readFileSync(b))) continue;
    stale.push(`plugins/gesso/skills/${rel}`);
    if (!check) {
      mkdirSync(dirname(b), { recursive: true });
      cpSync(a, b);
    }
  }
}
for (const rel of existsSync(target) ? files(target) : []) {
  if (want.has(rel) || PLUGIN_ONLY.has(rel.split(/[\\/]/)[0])) continue;
  stale.push(`plugins/gesso/skills/${rel} (not in skills/)`);
  if (!check) rmSync(join(target, rel));
}

if (check && stale.length) {
  const listed = stale.slice(0, 20).map((s) => `  ${s}`);
  if (stale.length > 20) listed.push(`  and ${stale.length - 20} more`);
  process.stderr.write(`The plugin is out of step with the package. Run node scripts/sync-plugin.mjs to update:\n${listed.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(check ? `plugin in step with gesso-mcp ${version}\n` : `synced the plugin to gesso-mcp ${version} (${stale.length} change${stale.length === 1 ? "" : "s"})\n`);
