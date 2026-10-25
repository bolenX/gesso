import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join, relative, sep } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FAVICON_SVG } from "./brand.js";
import { createServer, DocStore, newServerState, type ServerState } from "./index.js";
import { inside, resolvePath } from "./paths.js";

// Gesso over Streamable HTTP, at /mcp.
//
// Local (`--http`): one Gesso folder, as over stdio, listening on 127.0.0.1 unless HOST says otherwise.
//
// Hosted (`--http --hosted`), for claude.ai and ChatGPT connectors: every visitor gets a private workspace
// from /new, with a secret key. The connector URL is /mcp/<key>; the workspace page /w/<key> uploads images
// and lists files; /files/<key>/... serves them, so exports come back as links. Tools can only read and
// write inside their own workspace and only download from public addresses. Idle workspaces are deleted.

export type HttpOptions = {
  port: number;
  host?: string;
  /** The Gesso folder (local), or the folder that holds every workspace (hosted). */
  baseDir: string;
  hosted?: boolean;
  /** The server's public origin, e.g. https://gesso.example.com; read from the request headers when unset. */
  publicUrl?: string;
  /** Hosted: delete workspaces nobody has used for this many days. */
  workspaceDays?: number;
  /** Hosted: most a workspace may hold, in MB. */
  workspaceMb?: number;
  /** Hosted: largest upload, in MB. */
  uploadMb?: number;
  /** Hosted: largest artboard render, in megapixels. */
  maxMegapixels?: number;
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".psd": "image/vnd.adobe.photoshop",
  ".json": "application/json",
  ".cube": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** Workspace keys: 24 URL-safe characters (144 random bits) from /new. */
const KEY = /^[A-Za-z0-9_-]{24,64}$/;

/** Kept out of file listings and downloads: the documents' history and the activity marker. */
const PRIVATE = new Set([".gesso", ".last"]);

type Workspace = { dir: string; store: DocStore; state: ServerState; seen: number; touched: number };

export async function startHttp(options: HttpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const { hosted = false } = options;
  const root = hosted ? join(options.baseDir, "workspaces") : options.baseDir;
  await mkdir(root, { recursive: true });
  const workspaces = new Map<string, Workspace>();
  const local = { store: new DocStore(options.baseDir), state: newServerState() };
  const maxPixels = hosted ? (options.maxMegapixels ?? 40) * 1e6 : undefined;
  const created = new Map<string, number[]>();

  const origin = (req: IncomingMessage) => {
    if (options.publicUrl) return options.publicUrl.replace(/\/$/, "");
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0]!.trim();
    return `${proto}://${host}`;
  };

  /** The workspace for a key, if it was made with /new and hasn't expired. */
  const open = async (key: string): Promise<Workspace | undefined> => {
    if (!KEY.test(key)) return undefined;
    const known = workspaces.get(key);
    if (known) {
      known.seen = Date.now();
      return known;
    }
    const dir = join(root, key);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) return undefined;
    const ws = { dir, store: new DocStore(dir), state: newServerState(), seen: Date.now(), touched: 0 };
    workspaces.set(key, ws);
    return ws;
  };

  /** Marks the workspace as used, at most once a minute, so cleanup knows what's idle. */
  const touch = async (ws: Workspace) => {
    if (Date.now() - ws.touched < 60_000) return;
    ws.touched = Date.now();
    const marker = join(ws.dir, ".last");
    const now = new Date();
    await utimes(marker, now, now).catch(() => writeFile(marker, ""));
  };

  const cleanup = async () => {
    for (const [key, ws] of workspaces) if (Date.now() - ws.seen > 30 * 60_000) workspaces.delete(key);
    const days = options.workspaceDays ?? 7;
    for (const key of await readdir(root).catch(() => [])) {
      if (!KEY.test(key) || workspaces.has(key)) continue;
      const dir = join(root, key);
      const last = (await stat(join(dir, ".last")).catch(() => stat(dir))).mtimeMs;
      if (Date.now() - last > days * 86_400_000) await rm(dir, { recursive: true, force: true });
    }
  };
  const sweeper = hosted ? setInterval(() => void cleanup(), 3_600_000).unref() : undefined;
  if (hosted) await cleanup();

  const mcp = async (req: IncomingMessage, res: ServerResponse, ws: { dir: string; store: DocStore; state: ServerState }, key?: string) => {
    const base = origin(req);
    const fileUrl = key
      ? (path: string) => (inside(ws.dir, path) ? `${base}/files/${key}/${relative(ws.dir, path).split(sep).map(encodeURIComponent).join("/")}` : undefined)
      : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    const server = createServer({ store: ws.store, state: ws.state, baseDir: ws.dir, confined: hosted, ...(fileUrl ? { fileUrl } : {}), ...(maxPixels ? { maxPixels } : {}) });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://gesso");
    const parts = url.pathname.split("/").filter(Boolean);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (url.pathname === "/favicon.svg") return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(FAVICON_SVG);

    if (!hosted) {
      if (url.pathname === "/mcp") return mcp(req, res, { dir: options.baseDir, ...local });
      return void res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "text/plain" }).end("Gesso MCP server. Connect to /mcp\n");
    }

    if (url.pathname === "/") return html(res, 200, home());
    if (url.pathname === "/new") {
      if (!allowCreate(created, String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim())) {
        return html(res, 429, page("Slow down", "<p>Too many workspaces from this address in the last hour. Try again later.</p>"));
      }
      const key = randomBytes(18).toString("base64url");
      await mkdir(join(root, key), { recursive: true });
      return void res.writeHead(303, { location: `/w/${key}` }).end();
    }

    const [route, key, ...rest] = parts;
    const ws = key ? await open(key) : undefined;
    if (route === "mcp") {
      if (!ws) {
        const message = key ? "No workspace with that key (it may have expired). Get a new connector URL at /new." : "Use your private connector URL, /mcp/<key>. Get one at /new.";
        return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
      }
      await touch(ws);
      return mcp(req, res, ws, key);
    }
    if (!ws) return html(res, 404, page("Workspace not found", `<p>There's no workspace at this address. It may have expired after ${options.workspaceDays ?? 7} idle days.</p><p><a class="button" href="/new">Create a workspace</a></p>`));
    await touch(ws);

    if (route === "w" && !rest.length && req.method === "GET") return html(res, 200, workspacePage(origin(req), key!, await listFiles(ws.dir)));
    if (route === "files") {
      const path = rest.map(decodeURIComponent).join("/");
      if (!path || rest.some((p) => PRIVATE.has(decodeURIComponent(p)))) return void res.writeHead(404).end();
      if (req.method === "PUT") return upload(req, res, ws, path, options);
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      let file: string;
      try {
        file = resolvePath(ws.dir, path, true);
      } catch {
        return void res.writeHead(404).end();
      }
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return void res.writeHead(404).end();
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const inline = type.startsWith("image/") && type !== "image/vnd.adobe.photoshop" && type !== "image/svg+xml";
      res.writeHead(200, {
        "content-type": type,
        "content-length": info.size,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${basename(file).replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
      if (req.method === "HEAD") return void res.end();
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  const host = options.host ?? (hosted ? "0.0.0.0" : "127.0.0.1");
  await new Promise<void>((done) => server.listen(options.port, host, done));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () =>
      new Promise((done) => {
        if (sweeper) clearInterval(sweeper);
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** At most 20 new workspaces an hour from one address. */
function allowCreate(created: Map<string, number[]>, address: string): boolean {
  const hour = Date.now() - 3_600_000;
  const recent = (created.get(address) ?? []).filter((t) => t > hour);
  if (recent.length >= 20) return false;
  created.set(address, [...recent, Date.now()]);
  return true;
}

/** Saves an upload under uploads/, within the upload and workspace limits. */
async function upload(req: IncomingMessage, res: ServerResponse, ws: Workspace, path: string, options: HttpOptions) {
  const name = basename(path).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "");
  if (!path.startsWith("uploads/") || !name) {
    return void res.writeHead(400, { "content-type": "text/plain" }).end("Upload to /files/<key>/uploads/<file name>\n");
  }
  const limit = (options.uploadMb ?? 100) * 1024 * 1024;
  const quota = (options.workspaceMb ?? 2048) * 1024 * 1024;
  const used = await folderSize(ws.dir);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit || used + size > quota) {
      req.destroy();
      return void res
        .writeHead(413, { "content-type": "text/plain" })
        .end(size > limit ? `Uploads are limited to ${options.uploadMb ?? 100} MB\n` : `This workspace is full (${options.workspaceMb ?? 2048} MB). Delete it or start a new one.\n`);
    }
    chunks.push(chunk as Buffer);
  }
  const dir = join(ws.dir, "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.concat(chunks));
  res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ path: `uploads/${name}`, bytes: size }));
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await folderSize(path) : ((await stat(path).catch(() => undefined))?.size ?? 0);
  }
  return total;
}

/** Files in the workspace, newest first, leaving out the private ones. */
async function listFiles(dir: string, prefix = ""): Promise<Array<{ path: string; bytes: number; modified: number }>> {
  const out: Array<{ path: string; bytes: number; modified: number }> = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true }).catch(() => [])) {
    if (PRIVATE.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, path)));
    else {
      const info = await stat(join(dir, path)).catch(() => undefined);
      if (info) out.push({ path, bytes: info.size, modified: info.mtimeMs });
    }
  }
  return prefix ? out : out.sort((a, b) => b.modified - a.modified).slice(0, 300);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const html = (res: ServerResponse, status: number, body: string) =>
  void res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }).end(body);

const page = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Gesso</title><link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#faf9f7;--fg:#1c1b19;--muted:#6b6862;--line:#e4e1db;--card:#fff;--accent:#1c1b19;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f1efe9;--muted:#a19d95;--line:#33312d;--card:#1f1e1c;--accent:#f1efe9;--accent-fg:#161514}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
p{color:var(--muted);margin:8px 0}a{color:inherit}code,.url{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.url{display:flex;gap:8px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-wrap:anywhere}
.url span{flex:1}.button,button{display:inline-block;background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:10px 16px;font:inherit;text-decoration:none;cursor:pointer}
.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);padding:6px 10px}
ul{list-style:none;padding:0;margin:0;border:1px solid var(--line);border-radius:8px;background:var(--card)}li{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--line)}li:first-child{border-top:0}
li a{overflow-wrap:anywhere}li small{color:var(--muted);white-space:nowrap}.warn{border-left:3px solid #c98a00;padding-left:12px}
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

const home = () =>
  page(
    "Hosted Gesso",
    `<h1>Gesso</h1><p>An agent-first image engine: your agent builds layered images and exports PSDs that stay editable in Photoshop.</p>
<p>Create a private workspace to get a connector URL for claude.ai or ChatGPT. Anyone with the URL can use the workspace, so keep it to yourself.</p>
<p><a class="button" href="/new">Create a workspace</a></p>`,
  );

function workspacePage(base: string, key: string, files: Array<{ path: string; bytes: number; modified: number }>) {
  const connector = `${base}/mcp/${key}`;
  const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const list = files.length
    ? `<ul>${files.map((f) => `<li><a href="/files/${key}/${f.path.split("/").map(encodeURIComponent).join("/")}">${escape(f.path)}</a><small>${size(f.bytes)}</small></li>`).join("")}</ul>`
    : "<p>No files yet.</p>";
  return page(
    "Your Gesso workspace",
    `<h1>Your Gesso workspace</h1>
<p class="warn">This page's address is the key to your workspace. Bookmark it, and don't share it: anyone with it can use your files.</p>
<h2>Connector URL</h2>
<div class="url"><span id="connector">${escape(connector)}</span><button class="ghost" onclick="navigator.clipboard.writeText(document.getElementById('connector').textContent)">Copy</button></div>
<p><b>claude.ai:</b> Settings › Connectors › Add custom connector, and paste the URL. <b>ChatGPT:</b> Settings › Apps › Advanced settings › Developer mode, then Create app with the URL.</p>
<h2>Upload images, fonts and PSDs</h2>
<p>Then tell your agent the path, for example <code>uploads/photo.jpg</code>.</p>
<p><input type="file" id="pick" multiple> <span id="status"></span></p>
<h2>Files</h2>${list}`,
    `document.getElementById("pick").addEventListener("change", async (e) => {
  const status = document.getElementById("status");
  for (const file of e.target.files) {
    status.textContent = "Uploading " + file.name + "…";
    const res = await fetch("/files/${key}/uploads/" + encodeURIComponent(file.name), { method: "PUT", body: file });
    if (!res.ok) { status.textContent = await res.text(); return; }
  }
  location.reload();
});`,
  );
}
