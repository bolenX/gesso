// Builds the ZIP to upload to OpenAI's plugin directory (ChatGPT and Codex) from plugins/gesso.
// OpenAI's extras go only into the ZIP: the sign-in method for the server (the Agent Plugins schema
// that Copilot and Cursor read has no field for it) and, with --demo <url>, the walkthrough video.
// The other agents' manifests are left out. Writes dist/gesso-openai-<version>.zip.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = process.argv.includes("--demo") ? process.argv[process.argv.indexOf("--demo") + 1] : undefined;
if (process.argv.includes("--demo") && !/^https:\/\//.test(demo ?? "")) {
  process.stderr.write("--demo needs the video's https:// address\n");
  process.exit(1);
}
/** Files in the plugin that only other agents read. */
const OTHERS = new Set([".claude-plugin", ".cursor-plugin", ".mcp.json"]);

const work = mkdtempSync(join(tmpdir(), "gesso-openai-"));
const out = join(work, "gesso");
cpSync(join(root, "plugins/gesso"), out, { recursive: true, filter: (src) => !OTHERS.has(basename(src)) });

const mcp = JSON.parse(readFileSync(join(out, "mcp.json"), "utf8"));
// Gesso registers clients itself (Dynamic Client Registration), so there's no client ID or secret to ship.
mcp.mcpServers.gesso.extensions = { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } } };
writeFileSync(join(out, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n");

const manifest = JSON.parse(readFileSync(join(out, "plugin.json"), "utf8"));
if (demo) manifest.extensions["com.openai"].review.demo_recording_url = demo;
writeFileSync(join(out, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

mkdirSync(join(root, "dist"), { recursive: true });
const zip = join(root, "dist", `gesso-openai-${manifest.version}.zip`);
rmSync(zip, { force: true });
// The manifest sits at the root of the ZIP, as the upload expects.
execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: out });
rmSync(work, { recursive: true, force: true });
process.stdout.write(`wrote ${zip}${demo ? "" : " (no demo video yet: add --demo <url> before submitting)"}\n`);
