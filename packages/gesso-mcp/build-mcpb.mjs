// Builds the Claude Desktop extension (gesso-<version>.mcpb): the bundled server,
// its npm dependencies, and Sharp's native binaries for macOS (Apple silicon and
// Intel), Windows and Linux, so one file installs anywhere.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const stage = join(here, "mcpb");
const run = (cmd, args, cwd = here) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

run("node", ["build.mjs"]);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const f of ["dist", "assets", "vendor", "LICENSE", "README.md"]) cpSync(join(here, f), join(stage, f), { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true, dependencies: pkg.dependencies }, null, 2),
);

// Runtime dependencies, then Sharp's binaries for every platform Claude Desktop runs on.
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], stage);
const sharpVersion = pkg.dependencies.sharp;
const libvips = JSON.parse(readFileSync(join(stage, "node_modules/sharp/package.json"), "utf8")).optionalDependencies[
  "@img/sharp-libvips-darwin-arm64"
];
const natives = ["darwin-arm64", "darwin-x64", "linux-x64"].flatMap((p) => [`@img/sharp-${p}@${sharpVersion}`, `@img/sharp-libvips-${p}@${libvips}`]);
natives.push(`@img/sharp-win32-x64@${sharpVersion}`);
run("npm", ["install", "--no-save", "--force", "--no-audit", "--no-fund", "--loglevel=error", ...natives], stage);

// The extension's icon: the G tile as a 512 px PNG.
await sharp(join(here, "assets/favicon.svg"), { density: 1200 }).resize(512, 512).png().toFile(join(stage, "icon.png"));

const tools = [
  ["canvas_list", "List saved documents"],
  ["canvas_create", "Create a layered document from a full spec"],
  ["canvas_outline", "Read the compact tree of artboards and layers"],
  ["canvas_get", "Read full JSON for layers matching selectors"],
  ["canvas_selection", "Read or set the shared selection"],
  ["canvas_patch", "Edit layers with atomic, ID-addressed operations"],
  ["canvas_history", "List revisions or revert to one"],
  ["canvas_render", "Render preview images"],
  ["canvas_export", "Export PNG, JPEG, WebP or a layered PSD"],
  ["artboard_create", "Add a size, or adapt an artboard to one"],
  ["font_list", "Find installed fonts"],
  ["skill_read", "Read a recipe, such as adapting a design to more sizes"],
  ["asset_import", "Add an image or font from a path, URL or data"],
  ["gen_prepare", "Prepare an expand, generate, cut-out or upscale job for a connected image tool"],
].map(([name, description]) => ({ name, description }));

const manifest = {
  manifest_version: "0.3",
  name: "gesso",
  display_name: "Gesso",
  version: pkg.version,
  description: "Layered images as data. Agents build designs and export PSDs that stay editable in Photoshop.",
  long_description:
    "Gesso is an open-source, agent-first image engine. Claude builds layered compositions through small patches to named layers, renders previews to check its work, and exports PNG, JPEG, WebP or PSD files with live text, shape and adjustment layers, artboards and smart objects.",
  author: { name: "Gesso", url: pkg.homepage },
  homepage: pkg.homepage,
  repository: { type: "git", url: "https://github.com/bolenX/gesso" },
  icon: "icon.png",
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    entry_point: "dist/bin.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/bin.mjs"],
      env: { GESSO_WORKDIR: "${user_config.workdir}" },
    },
  },
  tools,
  user_config: {
    workdir: {
      type: "directory",
      title: "Gesso folder",
      description: "Where Gesso reads images and fonts you give it, and writes the files it exports.",
      default: "${HOME}/Documents/Gesso",
      required: true,
    },
  },
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20.0.0" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

const out = join(here, `gesso-${pkg.version}.mcpb`);
rmSync(out, { force: true });
run("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", stage, out]);
process.stdout.write(`built ${out}\n`);
