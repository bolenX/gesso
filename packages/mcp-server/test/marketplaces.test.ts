import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { TOOL_HINTS } from "../src/brand.js";

// The plugin and the marketplace files are what each agent's directory reads. These checks hold them to the
// limits the directories publish, so a release can't break a listing. (They were also checked once against
// the official schemas and `claude plugin validate`.)
const root = fileURLToPath(new URL("../../..", import.meta.url));
const plugin = join(root, "plugins/gesso");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const pkg = json("packages/gesso-mcp/package.json");
const HOSTED = "https://mcp.gesso.run/mcp";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return lstatSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** WCAG contrast ratio between two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the plugin", () => {
  it("is in step with the package: skills and versions", () => {
    expect(() => execFileSync(process.execPath, [join(root, "scripts/sync-plugin.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("fits the plugin directories' limits", () => {
    const files = walk(plugin);
    expect(files.length).toBeLessThan(512);
    for (const file of files) {
      const rel = relative(plugin, file);
      expect(lstatSync(file).isSymbolicLink(), rel).toBe(false);
      expect(rel, "stray macOS file").not.toMatch(/\.DS_Store$/);
      if (!/\.(png|svg)$/.test(rel)) expect(statSync(file).size, rel).toBeLessThan(256 * 1024);
    }
    // claude.ai and Cowork refuse a plugin with a top-level bin/.
    expect(existsSync(join(plugin, "bin"))).toBe(false);
  });

  it("has skills every agent can load", () => {
    const skills = readdirSync(join(plugin, "skills"));
    expect(skills).toContain("get-started");
    for (const name of skills) {
      const text = readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      // Strict YAML, which most agents' loaders use: a plain value can't hold ": " or " #", or start with a
      // YAML indicator, so those are double-quoted (and JSON reads that quoting the same way).
      for (const line of front.split("\n")) {
        const value = /^[a-z-]+: (.*)$/.exec(line)?.[1] ?? "";
        if (value.startsWith('"')) expect(() => JSON.parse(value), `${name}: ${line}`).not.toThrow();
        else expect(/: | #|^[[\]{}>|*&!%@`'",?:-]/.test(value), `${name}: quote this value: ${line}`).toBe(false);
      }
      const field = (key: string) => {
        const value = new RegExp(`^${key}: (.*)$`, "m").exec(front)?.[1]?.trim();
        return value?.startsWith('"') ? (JSON.parse(value) as string) : value;
      };
      // The Agent Skills rules: the name is the folder's, in lowercase and hyphens, with a description up to 1,024 characters.
      expect(field("name"), name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(field("description")?.length, name).toBeGreaterThan(20);
      expect(field("description")!.length, name).toBeLessThanOrEqual(1024);
    }
  });

  it("has a square 512 px icon", async () => {
    const meta = await sharp(join(plugin, "assets/icon.png")).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([512, 512, "png"]);
  });

  it("connects every agent to the same hosted server", () => {
    expect(json("plugins/gesso/.mcp.json").mcpServers.gesso).toEqual({ type: "http", url: HOSTED });
    expect(json("plugins/gesso/mcp.json").mcpServers.gesso).toEqual({ type: "streamable-http", url: HOSTED });
    expect(json("plugins/gesso/.cursor-plugin/plugin.json").mcpServers.gesso).toEqual({ url: HOSTED });
    expect(json("server.json").remotes).toEqual([{ type: "streamable-http", url: HOSTED }]);
  });
});

describe("the Agent Plugins manifest (ChatGPT, Codex, Copilot, Cursor)", () => {
  const manifest = json("plugins/gesso/plugin.json");
  const openai = manifest.extensions["com.openai"];

  it("keeps to the standard's fields", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(Object.keys(manifest).every((k) => ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"].includes(k))).toBe(true);
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    const mcp = json("plugins/gesso/mcp.json");
    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  });

  it("has OpenAI's listing within its limits", () => {
    const ui = openai.interface;
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) expect(ui[key], key).toMatch(/^https:\/\//);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(new Set(ui.defaultPrompt).size).toBe(ui.defaultPrompt.length);
    for (const prompt of ui.defaultPrompt) expect(prompt.length, prompt).toBeLessThanOrEqual(128);
    expect(contrast(ui.brandColor, "#FFFFFF")).toBeGreaterThanOrEqual(2);
    expect(contrast(ui.brandColorDark, "#212121")).toBeGreaterThanOrEqual(2);
    for (const path of [ui.logo, ui.composerIcon, openai.onboardingSkill]) expect(existsSync(join(plugin, path)), path).toBe(true);
  });

  it("has the review's five positive and three negative test cases, naming real tools", () => {
    const { positive, negative } = openai.review.test_cases;
    expect(positive).toHaveLength(5);
    expect(negative).toHaveLength(3);
    for (const c of positive) {
      for (const key of ["description", "prompt", "tools_triggered", "expected_behavior"]) expect(c[key], key).toBeTruthy();
      for (const tool of c.tools_triggered.split(", ")) expect(Object.keys(TOOL_HINTS), tool).toContain(tool);
    }
    for (const c of negative) expect(Object.keys(c).sort()).toEqual(["description", "prompt"]);
  });
});

describe("the marketplaces and registries", () => {
  it("point at the plugin by its name", () => {
    expect(json(".claude-plugin/marketplace.json").plugins).toMatchObject([{ name: "gesso", source: "./plugins/gesso" }]);
    expect(json(".cursor-plugin/marketplace.json").plugins).toMatchObject([{ name: "gesso", source: "plugins/gesso" }]);
    expect(json(".agents/plugins/marketplace.json").plugins).toMatchObject([{ name: "gesso", source: { source: "local", path: "./plugins/gesso" } }]);
    for (const manifest of ["plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) expect(json(`plugins/gesso/${manifest}`).name).toBe("gesso");
  });

  it("list the npm package under its registry name", () => {
    const server = json("server.json");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toMatchObject([{ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } }]);
    expect(json("gemini-extension.json")).toMatchObject({ name: "gesso", version: pkg.version, mcpServers: { gesso: { command: "npx", args: ["-y", "gesso-mcp"] } } });
  });
});
