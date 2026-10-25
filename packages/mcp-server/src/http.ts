import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join, relative, sep } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FAVICON_SVG } from "./brand.js";
import { createServer, DocStore, newServerState, type ServerState } from "./index.js";
import { OAuth } from "./oauth.js";
import { escape, html, page } from "./pages.js";
import { inside, resolvePath } from "./paths.js";

// Gesso over Streamable HTTP, at /mcp.
//
// Local (`--http`): one Gesso folder, as over stdio, listening on 127.0.0.1 unless HOST says otherwise.
//
// Hosted (`--http --hosted`), for claude.ai and ChatGPT connectors: everyone gets a private workspace.
// - Connecting to /mcp signs in with OAuth (see oauth.ts): the app registers itself, the person approves,
//   and the token says which workspace to use. Exports come back as signed download links (/dl/…), and the
//   server's instructions carry a signed upload page (/u/…).
// - A workspace from /new also has a private key URL, /mcp/<key>, for connectors without OAuth; its page
//   /w/<key> uploads and lists files, and /files/<key>/... serves them.
// Tools only read and write inside their own workspace and only download from public addresses. Idle
// workspaces are deleted. Each workspace gets a request rate and concurrency limit.

export type HttpOptions = {
  port: number;
  host?: string;
  /** The Gesso folder (local), or the folder that holds every workspace (hosted). */
  baseDir: string;
  hosted?: boolean;
  /** The server's public origin, e.g. https://mcp.gesso.run; read from the request headers when unset. */
  publicUrl?: string;
  /** Hosted: delete workspaces nobody has used for this many days. */
  workspaceDays?: number;
  /** Hosted: most a workspace may hold, in MB. */
  workspaceMb?: number;
  /** Hosted: largest upload, in MB. */
  uploadMb?: number;
  /** Hosted: largest artboard render, in megapixels. */
  maxMegapixels?: number;
  /** Hosted: largest MCP request body, in MB (images passed as base64 data count). */
  requestMb?: number;
  /** Hosted: signs tokens and links. Kept in the data folder when not given; keep it the same across restarts. */
  secret?: Buffer;
  /** Hosted: sign-in with an account, in addition to (or, with anonymous off, instead of) none. */
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  /** Hosted: let people connect without an account (default true). */
  anonymous?: boolean;
  /** Hosted: also serve the private key URLs from /new (default true). */
  keyUrls?: boolean;
  /** Hosted: a file of banned workspace keys and accounts ("github:<id>", "google:<sub>"), one per line. */
  blocklist?: string;
  /** Hosted: how many proxies in front of Gesso append to X-Forwarded-For (default 1). 0 uses the socket address. */
  proxyHops?: number;
  /** Hosted: per-workspace limits. */
  limits?: { burst?: number; perSecond?: number; concurrent?: number; total?: number };
  /** Gets one line per MCP request: no content, no keys, only a short hash of the workspace. */
  log?: (entry: Record<string, unknown>) => void;
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

/** Workspace keys: 24 URL-safe characters (144 random bits) from /new, or 32 for accounts. */
const KEY = /^[A-Za-z0-9_-]{24,64}$/;

/** Kept out of file listings and downloads: the documents' history and the activity marker. */
const PRIVATE = new Set([".gesso", ".last"]);

type Workspace = { key: string; dir: string; store: DocStore; state: ServerState; seen: number; touched: number };
type Meter = { tokens: number; at: number; busy: number };

/** A short, one-way name for a workspace in logs. */
const tag = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 10);

export async function startHttp(options: HttpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const { hosted = false } = options;
  const root = hosted ? join(options.baseDir, "workspaces") : options.baseDir;
  await mkdir(root, { recursive: true });
  const workspaces = new Map<string, Workspace>();
  const local = { store: new DocStore(options.baseDir), state: newServerState() };
  const maxPixels = hosted ? (options.maxMegapixels ?? 40) * 1e6 : undefined;
  const created = new Map<string, number[]>();
  const days = options.workspaceDays ?? 7;

  const origin = (req: IncomingMessage) => {
    if (options.publicUrl) return options.publicUrl.replace(/\/$/, "");
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0]!.trim();
    return `${proto}://${host}`;
  };

  /** The visitor's address, as the nearest trusted proxy saw it: the entry it appended to X-Forwarded-For. */
  const address = (req: IncomingMessage) => {
    const hops = options.proxyHops ?? 1;
    const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return (hops > 0 && chain.length ? chain[Math.max(0, chain.length - hops)] : undefined) ?? req.socket.remoteAddress ?? "";
  };

  // ── Bans ───────────────────────────────────────────────────────────────────────────────────
  let banned = new Set<string>();
  let bansChecked = 0;
  let bansModified = 0;
  const refreshBans = async () => {
    if (!options.blocklist || Date.now() - bansChecked < 60_000) return;
    bansChecked = Date.now();
    const info = await stat(options.blocklist).catch(() => undefined);
    if (!info || info.mtimeMs === bansModified) return;
    bansModified = info.mtimeMs;
    const lines = (await readFile(options.blocklist, "utf8")).split("\n").map((l) => l.replace(/#.*/, "").trim());
    banned = new Set(lines.filter(Boolean));
  };
  const blocked = (id: string) => banned.has(id);

  /** The workspace for a key, if it exists. */
  const open = async (key: string): Promise<Workspace | undefined> => {
    if (!KEY.test(key) || blocked(key)) return undefined;
    const known = workspaces.get(key);
    if (known) {
      known.seen = Date.now();
      return known;
    }
    const dir = join(root, key);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) return undefined;
    const ws = { key, dir, store: new DocStore(dir), state: newServerState(), seen: Date.now(), touched: 0 };
    workspaces.set(key, ws);
    return ws;
  };
  const ensure = async (key: string) => {
    if (!KEY.test(key)) throw new Error("Bad workspace key");
    await mkdir(join(root, key), { recursive: true });
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
    for (const key of await readdir(root).catch(() => [])) {
      if (!KEY.test(key) || workspaces.has(key)) continue;
      const dir = join(root, key);
      const last = (await stat(join(dir, ".last")).catch(() => stat(dir))).mtimeMs;
      if (Date.now() - last > days * 86_400_000) await rm(dir, { recursive: true, force: true });
    }
  };
  const sweeper = hosted ? setInterval(() => void cleanup(), 3_600_000).unref() : undefined;
  if (hosted) await cleanup();

  // ── Sign-in ────────────────────────────────────────────────────────────────────────────────
  let oauth: OAuth | undefined;
  if (hosted) {
    oauth = new OAuth({
      secret: options.secret ?? (await loadSecret(join(options.baseDir, "oauth"))),
      dir: join(options.baseDir, "oauth"),
      origin,
      workspaceDays: days,
      ...(options.anonymous === false ? { anonymous: false } : {}),
      ...(options.github ? { github: options.github } : {}),
      ...(options.google ? { google: options.google } : {}),
      ensureWorkspace: ensure,
      workspaceExists: async (key) => (await open(key)) !== undefined,
      allowNew: (req) => allowCreate(created, address(req)),
      blocked,
    });
    await oauth.start();
  }
  const sealer = oauth?.sealer;
  /** A link to one exported file that works for as long as the workspace is kept, without giving away its key. */
  const signedFile = (base: string, ws: Workspace) => (path: string) =>
    inside(ws.dir, path) ? `${base}/dl/${sealer!.seal("gdl", { ws: ws.key, p: relative(ws.dir, path), exp: Math.floor(Date.now() / 1000) + days * 86_400 })}/${encodeURIComponent(basename(path))}` : undefined;
  const keyFile = (base: string, ws: Workspace) => (path: string) =>
    inside(ws.dir, path) ? `${base}/files/${ws.key}/${relative(ws.dir, path).split(sep).map(encodeURIComponent).join("/")}` : undefined;
  const uploadPage = (base: string, ws: Workspace) => `${base}/u/${sealer!.seal("gul", { ws: ws.key, exp: Math.floor(Date.now() / 1000) + 86_400 })}`;

  // ── Limits ─────────────────────────────────────────────────────────────────────────────────
  const limits = { burst: 120, perSecond: 2, concurrent: 4, total: 64, ...options.limits };
  const meters = new Map<string, Meter>();
  let inflight = 0;
  /** Takes a request slot for the workspace, or says why not. */
  const admit = (key: string): "ok" | "rate" | "busy" => {
    if (inflight >= limits.total) return "busy";
    const m = meters.get(key) ?? { tokens: limits.burst, at: Date.now(), busy: 0 };
    m.tokens = Math.min(limits.burst, m.tokens + ((Date.now() - m.at) / 1000) * limits.perSecond);
    m.at = Date.now();
    meters.set(key, m);
    if (m.busy >= limits.concurrent) return "busy";
    if (m.tokens < 1) return "rate";
    m.tokens -= 1;
    m.busy += 1;
    inflight += 1;
    return "ok";
  };
  const release = (key: string) => {
    const m = meters.get(key);
    if (m) m.busy = Math.max(0, m.busy - 1);
    inflight = Math.max(0, inflight - 1);
  };
  const meterSweeper = hosted
    ? setInterval(() => {
        for (const [key, m] of meters) if (!m.busy && Date.now() - m.at > 10 * 60_000) meters.delete(key);
      }, 600_000).unref()
    : undefined;

  const rpcError = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) =>
    void res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));

  /** Reads and parses an MCP request body within the size limit, so it can be logged and limited before it runs. */
  const readJson = async (req: IncomingMessage, res: ServerResponse): Promise<{ body?: unknown; ok: boolean }> => {
    if (req.method !== "POST") return { ok: true };
    const limit = (options.requestMb ?? 32) * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) {
        rpcError(res, 413, `Requests are limited to ${options.requestMb ?? 32} MB. Upload large images instead of passing them as data.`);
        req.destroy();
        return { ok: false };
      }
      chunks.push(chunk as Buffer);
    }
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString()), ok: true };
    } catch {
      void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return { ok: false };
    }
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse, ws: { dir: string; store: DocStore; state: ServerState }, extra: { fileUrl?: (path: string) => string | undefined; uploadUrl?: string; key?: string }) => {
    let body: unknown;
    if (hosted) {
      const read = await readJson(req, res);
      if (!read.ok) return;
      body = read.body;
    }
    // Only POSTs carry work; a GET for an event stream is refused by the stateless transport right away.
    if (hosted && req.method === "POST") {
      const verdict = admit(extra.key!);
      if (verdict !== "ok") {
        return rpcError(res, verdict === "rate" ? 429 : 503, verdict === "rate" ? "Too many requests for this workspace; slow down and retry shortly." : "The server is busy; retry in a few seconds.", { "retry-after": verdict === "rate" ? "5" : "2" });
      }
      const started = Date.now();
      const calls = (Array.isArray(body) ? body : [body]) as Array<{ method?: string; params?: { name?: string } }>;
      res.on("close", () => {
        release(extra.key!);
        options.log?.({ t: new Date().toISOString(), ws: tag(extra.key!), via: extra.uploadUrl ? "oauth" : "key", method: calls.map((c) => c?.method).join(","), tool: calls.map((c) => c?.params?.name).filter(Boolean).join(",") || undefined, status: res.statusCode, ms: Date.now() - started });
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    const server = createServer({
      store: ws.store,
      state: ws.state,
      baseDir: ws.dir,
      confined: hosted,
      ...(extra.fileUrl ? { fileUrl: extra.fileUrl } : {}),
      ...(extra.uploadUrl ? { uploadUrl: extra.uploadUrl } : {}),
      ...(maxPixels ? { maxPixels } : {}),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const sendFile = async (req: IncomingMessage, res: ServerResponse, file: string) => {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return void res.writeHead(404).end();
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const inline = type.startsWith("image/") && type !== "image/vnd.adobe.photoshop" && type !== "image/svg+xml";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${basename(file).replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://gesso");
    const parts = url.pathname.split("/").filter(Boolean);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (url.pathname === "/favicon.svg") return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(FAVICON_SVG);
    if (!hosted) {
      if (url.pathname === "/mcp") return mcp(req, res, { dir: options.baseDir, ...local }, {});
      return void res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "text/plain" }).end("Gesso MCP server. Connect to /mcp\n");
    }

    await refreshBans();
    if (await oauth!.handle(req, res, url)) return;

    // One URL for everyone: the token says whose workspace it is.
    if (url.pathname === "/mcp" || (url.pathname === "/" && req.method === "POST")) {
      const auth = oauth!.authenticate(req);
      if ("error" in auth) return oauth!.challenge(req, res, auth.error === "invalid_token" ? "invalid_token" : undefined);
      await ensure(auth.workspace);
      const ws = await open(auth.workspace);
      if (!ws) return oauth!.challenge(req, res, "invalid_token");
      await touch(ws);
      const base = origin(req);
      return mcp(req, res, ws, { key: ws.key, fileUrl: signedFile(base, ws), uploadUrl: uploadPage(base, ws) });
    }

    if (url.pathname === "/") return html(res, 200, home(origin(req), options.keyUrls !== false));

    const [route, token, ...rest] = parts;

    // Signed links: a download of one file, or an upload page for a day.
    if (route === "dl" && token) {
      const link = sealer!.open<{ ws: string; p: string; exp: number }>("gdl", token);
      const ws = link ? await open(link.ws) : undefined;
      if (!link || !ws || link.p.split(sep).some((p) => PRIVATE.has(p))) return html(res, 404, page("Link expired", "<h1>This link has expired</h1><p>Ask your agent to export the file again.</p>"));
      await touch(ws);
      let file: string;
      try {
        file = resolvePath(ws.dir, link.p, true);
      } catch {
        return void res.writeHead(404).end();
      }
      return sendFile(req, res, file);
    }
    if (route === "u" && token) {
      const link = sealer!.open<{ ws: string; exp: number }>("gul", token);
      const ws = link ? await open(link.ws) : undefined;
      if (!link || !ws) return html(res, 404, page("Link expired", "<h1>This upload link has expired</h1><p>Ask your agent for a new one: it's in Gesso's instructions for each conversation.</p>"));
      await touch(ws);
      if (!rest.length && req.method === "GET") return html(res, 200, uploadOnlyPage(`/u/${token}`, await listFiles(ws.dir)));
      if (req.method === "PUT") return upload(req, res, ws, rest.map(decodeURIComponent).join("/"), options, `/u/<link>/uploads/<file name>`);
      return void res.writeHead(405).end();
    }

    // Private key URLs, for connectors without OAuth.
    if (options.keyUrls === false) return void res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
    if (url.pathname === "/new") {
      if (!allowCreate(created, address(req))) {
        return html(res, 429, page("Slow down", "<p>Too many workspaces from this address in the last hour. Try again later.</p>"));
      }
      const key = randomBytes(18).toString("base64url");
      await mkdir(join(root, key), { recursive: true });
      return void res.writeHead(303, { location: `/w/${key}` }).end();
    }

    const key = token;
    const ws = key ? await open(key) : undefined;
    if (route === "mcp") {
      if (!ws) {
        const message = key ? "No workspace with that key (it may have expired). Get a new connector URL at /new." : "Use your private connector URL, /mcp/<key>. Get one at /new.";
        return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
      }
      await touch(ws);
      return mcp(req, res, ws, { key: ws.key, fileUrl: keyFile(origin(req), ws) });
    }
    if (!ws) return html(res, 404, page("Workspace not found", `<p>There's no workspace at this address. It may have expired after ${days} idle days.</p><p><a class="button" href="/new">Create a workspace</a></p>`));
    await touch(ws);

    if (route === "w" && !rest.length && req.method === "GET") return html(res, 200, workspacePage(origin(req), key!, await listFiles(ws.dir)));
    if (route === "files") {
      const path = rest.map(decodeURIComponent).join("/");
      if (!path || rest.some((p) => PRIVATE.has(decodeURIComponent(p)))) return void res.writeHead(404).end();
      if (req.method === "PUT") return upload(req, res, ws, path, options, `/files/<key>/uploads/<file name>`);
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      let file: string;
      try {
        file = resolvePath(ws.dir, path, true);
      } catch {
        return void res.writeHead(404).end();
      }
      return sendFile(req, res, file);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  // Renders can take a while; keep slow uploads and long tool calls from being cut off, but not idle sockets forever.
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 60_000;
  const host = options.host ?? (hosted ? "0.0.0.0" : "127.0.0.1");
  await new Promise<void>((done) => server.listen(options.port, host, done));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () =>
      new Promise((done) => {
        if (sweeper) clearInterval(sweeper);
        if (meterSweeper) clearInterval(meterSweeper);
        server.closeAllConnections();
        server.close(() => void (oauth ? oauth.stop() : Promise.resolve()).then(() => done()));
      }),
  };
}

/** The signing secret: kept in the data folder, made on first start. */
async function loadSecret(dir: string): Promise<Buffer> {
  const file = join(dir, "secret");
  const saved = await readFile(file).catch(() => undefined);
  if (saved && saved.length >= 32) return saved;
  await mkdir(dir, { recursive: true });
  const secret = randomBytes(32);
  await writeFile(file, secret, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return secret;
}

/** At most 20 new workspaces an hour from one address. */
function allowCreate(created: Map<string, number[]>, address: string): boolean {
  const hour = Date.now() - 3_600_000;
  const recent = (created.get(address) ?? []).filter((t) => t > hour);
  if (recent.length >= 20) return false;
  created.set(address, [...recent, Date.now()]);
  if (created.size > 10_000) for (const [a, times] of created) if (!times.some((t) => t > hour)) created.delete(a);
  return true;
}

/** Saves an upload under uploads/, within the upload and workspace limits. */
async function upload(req: IncomingMessage, res: ServerResponse, ws: Workspace, path: string, options: HttpOptions, usage: string) {
  const name = basename(path).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "");
  if (!path.startsWith("uploads/") || !name) {
    return void res.writeHead(400, { "content-type": "text/plain" }).end(`Upload to ${usage}\n`);
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

const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

const home = (base: string, keyUrls: boolean) =>
  page(
    "Hosted Gesso",
    `<h1>Gesso</h1><p>An agent-first image engine: your agent builds layered images and exports PSDs that stay editable in Photoshop.</p>
<h2>Connect</h2>
<div class="url"><span id="connector">${escape(`${base}/mcp`)}</span><button class="ghost" onclick="navigator.clipboard.writeText(document.getElementById('connector').textContent)">Copy</button></div>
<p><b>claude.ai:</b> Settings › Connectors › Add custom connector, and paste the URL. <b>ChatGPT:</b> Settings › Apps › Advanced settings › Developer mode, then Create app with the URL. You'll be asked to approve the connection, and you get a private workspace.</p>
${keyUrls ? `<p class="small">Using a client that can't sign in? <a href="/new">Create a workspace with a private connector URL</a> instead.</p>` : ""}`,
  );

const uploadScript = (target: string) => `document.getElementById("pick").addEventListener("change", async (e) => {
  const status = document.getElementById("status");
  for (const file of e.target.files) {
    status.textContent = "Uploading " + file.name + "…";
    const res = await fetch("${target}/uploads/" + encodeURIComponent(file.name), { method: "PUT", body: file });
    if (!res.ok) { status.textContent = await res.text(); return; }
  }
  location.reload();
});`;

const fileList = (files: Array<{ path: string; bytes: number }>, link?: (path: string) => string) =>
  files.length
    ? `<ul>${files.map((f) => `<li>${link ? `<a href="${link(f.path)}">${escape(f.path)}</a>` : `<span>${escape(f.path)}</span>`}<small>${size(f.bytes)}</small></li>`).join("")}</ul>`
    : "<p>No files yet.</p>";

/** The upload page an agent hands out: it uploads and lists files, and shows nothing that unlocks the workspace. */
function uploadOnlyPage(target: string, files: Array<{ path: string; bytes: number }>) {
  return page(
    "Upload to Gesso",
    `<h1>Upload to your Gesso workspace</h1>
<p>Images, fonts, LUTs and PSDs land in <code>uploads/</code>. Then tell your agent the path, for example <code>uploads/photo.jpg</code>. This link works for a day.</p>
<p><input type="file" id="pick" multiple> <span id="status"></span></p>
<h2>Files</h2>${fileList(files)}
<p class="small">Downloads come back to your conversation as links when your agent exports.</p>`,
    uploadScript(target),
  );
}

function workspacePage(base: string, key: string, files: Array<{ path: string; bytes: number }>) {
  const connector = `${base}/mcp/${key}`;
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
<h2>Files</h2>${fileList(files, (p) => `/files/${key}/${p.split("/").map(encodeURIComponent).join("/")}`)}`,
    uploadScript(`/files/${key}`),
  );
}
