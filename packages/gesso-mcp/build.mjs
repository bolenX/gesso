// Bundles Gesso's own packages into one file; third-party libraries stay as
// npm dependencies (sharp is native, canvaskit ships a .wasm file).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const mcp = join(here, "../mcp-server");

await build({
  entryPoints: [join(mcp, "src/bin.ts")],
  outfile: join(here, "dist/bin.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]),
  // Workspace packages resolve to their sources, so the bundle never needs a prior tsc build.
  alias: {
    "@gesso/core": join(here, "../core/src/index.ts"),
    "@gesso/render": join(here, "../render/src/index.ts"),
    "@gesso/psd": join(here, "../psd/src/index.ts"),
  },
  logLevel: "warning",
});

cpSync(join(mcp, "assets"), join(here, "assets"), { recursive: true });
cpSync(join(here, "../../skills"), join(here, "assets/skills"), { recursive: true, filter: (src) => !src.endsWith("README.md") });
const require = createRequire(join(mcp, "package.json"));
const appBundle = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
mkdirSync(join(here, "vendor"), { recursive: true });
cpSync(appBundle, join(here, "vendor/ext-apps-app.js"));
cpSync(join(dirname(appBundle), "../../LICENSE"), join(here, "vendor/ext-apps-LICENSE"));
cpSync(join(here, "../../LICENSE"), join(here, "LICENSE"));
writeFileSync(join(here, "vendor/README.md"), "ext-apps-app.js is the browser bundle from @modelcontextprotocol/ext-apps 2.0.3 (MIT, see ext-apps-LICENSE). Gesso's result card inlines it.\n");
process.stdout.write(`built gesso-mcp ${pkg.version}\n`);
