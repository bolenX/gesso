import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WORDMARK_SVG } from "./brand.js";

/** App-only tool the card calls to fetch an exported file for download. */
export const FILE_TOOL = "gesso_file";

// The Gesso result card, an MCP App. Hosts that support MCP Apps (claude.ai,
// Claude Desktop) render it inline under Gesso tool calls; other hosts ignore
// it and show the text result. It reads the tool result's structuredContent.

export const WIDGET_URI = "ui://gesso/result.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** ext-apps ships a self-contained ESM bundle; expose its App class as a global for the inline script. */
function appBundle(): string {
  // The published gesso-mcp package vendors the bundle (ext-apps declares the v2 SDK and React as peers).
  const vendored = fileURLToPath(new URL("../vendor/ext-apps-app.js", import.meta.url));
  const source = existsSync(vendored)
    ? readFileSync(vendored, "utf8")
    : readFileSync(createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
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
.files { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.file { display:grid; grid-template-columns:minmax(0, 1fr); grid-template-rows:auto auto; border:1px solid var(--rule); border-radius:10px; overflow:hidden; min-width:0; }
.file .thumb { aspect-ratio:4/3; overflow:hidden; display:grid; place-items:center; padding:8px; border-bottom:1px solid var(--rule); background:conic-gradient(var(--check-b) 25%, var(--check-a) 0 50%, var(--check-b) 0 75%, var(--check-a) 0) 0 0/12px 12px; }
.file .thumb img { width:100%; height:100%; object-fit:contain; display:block; min-height:0; }
.file .thumb .badge { font:700 15px/1 ui-monospace, Menlo, monospace; letter-spacing:0.04em; padding:9px 11px; border-radius:6px; background:var(--bg); border:1.5px solid var(--fg); }
.file .meta { padding:8px 10px 10px; display:grid; gap:6px; min-width:0; }
.file .name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file .info { color:var(--muted); font:11px ui-monospace, Menlo, monospace; }
.file button { width:100%; font:600 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; padding:7px 10px; border-radius:6px; border:0; cursor:pointer; background:var(--orange); color:#111110; }
.file button.ghost { background:transparent; color:var(--fg); border:1px solid var(--rule); }
.file button:disabled { opacity:0.6; cursor:default; }
.file button:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
.ready { font-weight:600; }
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
function show(data, content = []) {
  // Preview images arrive as the result's image parts, in artboard order, not inside the card data.
  const images = content.filter((c) => c.type === "image");
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
    data.previews.forEach((p, i) => {
      const image = images[i];
      if (!image) return;
      const b = el("div", "board"), frame = el("div", "img"), img = el("img");
      img.src = "data:" + (image.mimeType ?? "image/png") + ";base64," + image.data; img.alt = "Preview of " + p.artboard;
      frame.append(img); b.append(frame, el("span", "cap", p.artboard + " · " + p.width + "×" + p.height));
      boards.append(b);
    });
    body.append(boards);
  }
  if (data.files?.length) {
    body.append(el("div", "ready", data.files.length + (data.files.length === 1 ? " file ready" : " files ready")));
    const files = el("div", "files");
    for (const f of data.files) files.append(fileCard(f, data.files));
    body.append(files);
  }
  if (data.outline) body.append(el("pre", null, data.outline));
  for (const w of data.warnings ?? []) body.append(el("div", "warn", "Warning: " + w));
}
globalThis.gessoShow = show; // lets a test page render the card without a host
const size = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB";
// Thumbnails are fetched on demand through the card-only tool, so they never enter the agent's context.
const IMAGE_KINDS = new Set(["PNG", "JPEG", "WEBP"]);
async function loadThumb(path, into) {
  if (!(app.getHostCapabilities?.() ?? {}).serverTools) return;
  try {
    const res = await app.callServerTool({ name: "${FILE_TOOL}", arguments: { path, maxSize: 320 } });
    const file = res.structuredContent;
    if (res.isError || !file) return;
    const img = el("img"); img.src = "data:" + file.mimeType + ";base64," + file.blob; img.alt = "";
    into.replaceChildren(img);
  } catch (err) { console.error(err); }
}
function fileCard(f, all) {
  const card = el("div", "file"), thumb = el("div", "thumb"), meta = el("div", "meta");
  thumb.append(el("span", "badge", f.kind));
  // A PSD shows the flat PNG exported next to it, when there is one.
  const preview = IMAGE_KINDS.has(f.kind) ? f.path : f.kind === "PSD" ? all.find((o) => o.kind === "PNG")?.path : undefined;
  if (preview) loadThumb(preview, thumb);
  const name = el("div", "name", f.name); name.title = f.path;
  meta.append(name, el("div", "info", f.kind + " · " + size(f.bytes)));
  const caps = app.getHostCapabilities?.() ?? {};
  const button = el("button");
  if (caps.downloadFile && caps.serverTools) {
    button.textContent = "Download";
    button.onclick = async () => {
      button.disabled = true; button.textContent = "Preparing…";
      try {
        const res = await app.callServerTool({ name: "${FILE_TOOL}", arguments: { path: f.path } });
        const file = res.structuredContent;
        if (res.isError || !file) throw new Error(res.content?.[0]?.text ?? "Download failed");
        const out = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: "file:///" + encodeURIComponent(f.name), mimeType: file.mimeType, blob: file.blob } }] });
        button.textContent = out?.isError ? "Download" : "Downloaded";
      } catch (err) {
        button.textContent = "Try again";
        console.error(err);
      } finally { button.disabled = false; }
    };
  } else {
    // Hosts without downloads: a hosted server's link, or the path of the file already on disk.
    const where = f.url ?? f.path;
    button.className = "ghost"; button.textContent = f.url ? "Copy link" : "Copy path";
    button.onclick = async () => {
      try { await navigator.clipboard.writeText(where); button.textContent = "Copied"; }
      catch { name.textContent = where; name.style.whiteSpace = "normal"; button.textContent = f.url ? "Link shown" : "Path shown"; }
    };
  }
  meta.append(button);
  card.append(thumb, meta);
  return card;
}
const app = new globalThis.GessoApp({ name: "Gesso", version: "0.13.0" });
app.ontoolresult = (result) => { if (result?.structuredContent?.gesso) show(result.structuredContent.gesso, result.content ?? []); };
await app.connect();
</script></body></html>`;
  return cached;
}
