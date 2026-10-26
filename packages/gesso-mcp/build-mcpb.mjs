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

// The extension's icon: the G on a full square (hosts round it themselves), as a 512 px PNG.
await sharp(join(here, "assets/icon.svg"), { density: 1200 }).resize(512, 512).png().toFile(join(stage, "icon.png"));

const tools = [
  ["canvas_list", "List saved documents"],
  ["canvas_create", "Create a layered document from a full spec"],
  ["psd_import", "Open a Photoshop file as an editable document"],
  ["canvas_outline", "Read the compact tree of artboards and layers"],
  ["canvas_get", "Read full JSON for layers matching selectors"],
  ["canvas_selection", "Read or set the shared selection"],
  ["canvas_patch", "Edit layers with atomic, ID-addressed operations"],
  ["canvas_history", "List revisions or revert to one"],
  ["canvas_render", "Render previews, zoom into regions, and compare with earlier revisions"],
  ["canvas_inspect", "Measure tones, clipping, colour, sharpness and noise, and sample colours"],
  ["canvas_export", "Export PNG, JPEG, WebP, TIFF (RGB or CMYK with ICC profiles), a layered PSD, SVG, print-ready PDF, or slices named like files"],
  ["canvas_stamp", "Merge layers into one pixel layer: stamp visible, copy merged, merge, rasterize"],
  ["canvas_batch", "Run a document as a template over a folder of images or rows of data"],
  ["canvas_align", "Auto-Align Layers: line up exposures of the same scene"],
  ["canvas_stack", "Auto-Blend Layers: merge a focus stack or an exposure bracket"],
  ["artboard_create", "Add a size, or adapt an artboard to one"],
  ["font_list", "Find installed fonts"],
  ["skill_read", "Read a skill: the workflow, its recipes and its checks"],
  ["skill_apply", "Apply a skill's recipe as one revision: a proven layer setup filled in with your parameters"],
  ["asset_import", "Add an image, font or .cube LUT from a path, URL or data"],
  ["gen_prepare", "Prepare an expand (one plate for all sizes), generate, fill, segment (subject, sky, skin, eyes…), cut-out or upscale job for a connected image tool"],
].map(([name, description]) => ({ name, description }));

const manifest = {
  manifest_version: "0.3",
  name: "gesso",
  display_name: "Gesso",
  version: pkg.version,
  description: "Layered images as data. Agents build designs and export PSDs that stay editable in Photoshop.",
  long_description:
    "Gesso is an open-source, agent-first image engine. Claude builds layered compositions through small patches to named layers, renders previews to check its work, and exports PNG, JPEG, WebP, TIFF, SVG, print PDF or PSD files, in RGB or CMYK. It includes Photoshop's Filter menu as smart filters, every adjustment layer, all blend modes and layer styles, masks and retouching. PSDs keep live text, shape and adjustment layers, layer styles, artboards and smart objects.",
  author: { name: "Gesso", url: pkg.homepage },
  homepage: pkg.homepage,
  repository: { type: "git", url: "https://github.com/bolenX/gesso" },
  support: pkg.bugs.url,
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
