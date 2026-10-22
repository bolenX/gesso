import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WORDMARK_SVG } from "./brand.js";

// The Gesso result card, an MCP App. Hosts that support MCP Apps (claude.ai,
// Claude Desktop) render it inline under Gesso tool calls; other hosts ignore
// it and show the text result. It reads the tool result's structuredContent.

export const WIDGET_URI = "ui://gesso/result.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** ext-apps ships a self-contained ESM bundle; expose its App class as a global for the inline script. */
function appBundle(): string {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const exportStatement = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(source);
  if (!exportStatement) throw new Error("Unexpected ext-apps bundle format");
  const local = exportStatement[1]!
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/))
    .find(([, name]) => name === "App")?.[0];
  if (!local) throw new Error("ext-apps bundle does not export App");
  return source.slice(0, exportStatement.index) + `\nglobalThis.GessoApp = ${local};\n`;
}

let cached: string | undefined;

export function widgetHtml(): string {
  cached ??= `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg:#ffffff; --fg:#12141a; --muted:#5b6070; --rule:#e2e5eb; --orange:#FF4F1A; --blue:#2440E6; --yellow:#FFC21A; --check-a:#ffffff; --check-b:#e4e7ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181e; --fg:#e9ebf1; --muted:#9aa0b2; --rule:#2a2e39; --orange:#FF6430; --blue:#6582FF; --yellow:#FFC21A; --check-a:#1b1e26; --check-b:#232731; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
.card { padding:14px 16px 12px; display:grid; grid-template-columns:minmax(0, 1fr); gap:12px; }
#body { display:grid; gap:10px; min-width:0; }
.head { display:flex; align-items:center; gap:10px; }
.head svg { height:15px; width:auto; flex:none; display:block; }
.what { color:var(--muted); }
.rev { margin-left:auto; font:12px ui-monospace, Menlo, monospace; color:var(--muted); }
.boards { display:flex; gap:10px; overflow-x:auto; padding-bottom:2px; }
.board { flex:none; display:grid; gap:6px; }
.board .img { border:1px solid var(--rule); border-radius:6px; overflow:hidden; background:conic-gradient(var(--check-b) 25%, var(--check-a) 0 50%, var(--check-b) 0 75%, var(--check-a) 0) 0 0/14px 14px; }
.board img { display:block; max-height:260px; width:auto; max-width:100%; }
.cap { font:12px ui-monospace, Menlo, monospace; color:var(--muted); }
.row { display:flex; gap:8px; flex-wrap:wrap; }
.chip { font:12px ui-monospace, Menlo, monospace; padding:3px 8px; border:1px solid var(--rule); border-radius:999px; }
.chip.on { border-color:var(--blue); color:var(--blue); }
pre { margin:0; padding:10px 12px; border:1px solid var(--rule); border-radius:6px; font:12px/1.5 ui-monospace, Menlo, monospace; overflow-x:auto; max-height:220px; }
.files { display:grid; gap:4px; font:12px ui-monospace, Menlo, monospace; }
.warn { font-size:12px; padding:4px 8px; border-left:3px solid var(--yellow); }
.what b { color:var(--orange); font-weight:600; }
.foot { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; border-top:1px solid var(--rule); padding-top:8px; }
.foot a { color:inherit; }
.empty { color:var(--muted); }
</style></head>
<body><div class="card" id="card"><div class="head">${WORDMARK_SVG.replace("<svg ", '<svg class="mark" ')}<span class="what" id="what">Working…</span><span class="rev" id="rev"></span></div><div id="body" class="empty">Waiting for the result.</div><div class="foot"><span>Layered images as data · editable PSDs</span><span id="gen"></span></div></div>
<script type="module">
${appBundle()}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const VERBS = { create: "Created", patch: "Edited", render: "Rendered", export: "Exported" };
function show(data) {
  const body = document.getElementById("body");
  body.className = ""; body.replaceChildren();
  const what = document.getElementById("what");
  what.replaceChildren(el("b", null, VERBS[data.kind] ?? "Done"), " " + data.doc);
  document.getElementById("rev").textContent = "rev " + data.revision;
  document.getElementById("gen").textContent = data.generator ?? "";
  if (data.changed?.length) {
    const row = el("div", "row");
    for (const id of data.changed) row.append(el("span", "chip on", "#" + id));
    body.append(row);
  }
  if (data.previews?.length) {
    const boards = el("div", "boards");
    for (const p of data.previews) {
      const b = el("div", "board"), frame = el("div", "img"), img = el("img");
      img.src = "data:image/png;base64," + p.png; img.alt = "Preview of " + p.artboard;
      frame.append(img); b.append(frame, el("span", "cap", p.artboard + " · " + p.width + "×" + p.height));
      boards.append(b);
    }
    body.append(boards);
  }
  if (data.files?.length) {
    const files = el("div", "files");
    for (const f of data.files) files.append(el("span", null, "↳ " + f));
    body.append(files);
  }
  if (data.outline) body.append(el("pre", null, data.outline));
  for (const w of data.warnings ?? []) body.append(el("div", "warn", "Warning: " + w));
}
globalThis.gessoShow = show; // lets a test page render the card without a host
const app = new globalThis.GessoApp({ name: "Gesso", version: "0.1.0" });
app.ontoolresult = (result) => { if (result?.structuredContent?.gesso) show(result.structuredContent.gesso); };
await app.connect();
</script></body></html>`;
  return cached;
}
