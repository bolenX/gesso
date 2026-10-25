import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { KEY, linksFor, readJson, rpcError, serveMcp } from "./http.js";
import { DocStore, newServerState, type ServerState } from "./index.js";
import { Sealer } from "./oauth.js";

// Worker processes for hosted Gesso. Rendering runs synchronously, so in one process a long export holds up
// every other request. The main process keeps sign-in, limits, pages and file downloads, and hands each MCP
// request to a worker: always the same one for a workspace, so its documents and running exports live in one
// place. A worker that crashes (most often from running out of memory on a huge render) is restarted, and only
// its requests in flight fail.

export type WorkerConfig = { baseDir: string; secret: string; days: number; maxPixels?: number; requestMb: number };

/** Which worker serves a workspace. */
export const shardOf = (key: string, count: number) => createHash("sha256").update(key).digest().readUInt32BE(0) % count;

/** Headers that belong to one connection, not to the response. */
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);

type Slot = { child?: ChildProcess; port?: number; crashes: number[] };

export class Pool {
  private slots: Slot[];
  /** Lets workers tell the main process's requests from anything else on the machine. */
  private token = randomBytes(24).toString("base64url");
  private stopping = false;

  constructor(private o: { count: number; entry: string; memoryMb?: number; config: WorkerConfig }) {
    this.slots = Array.from({ length: o.count }, () => ({ crashes: [] }));
  }

  async start() {
    await Promise.all(this.slots.map((_, i) => this.spawn(i)));
  }

  stop() {
    this.stopping = true;
    for (const slot of this.slots) slot.child?.kill();
  }

  pids(): number[] {
    return this.slots.flatMap((s) => (s.child?.pid ? [s.child.pid] : []));
  }

  private spawn(i: number): Promise<void> {
    const slot = this.slots[i]!;
    return new Promise((ready, fail) => {
      const child = fork(this.o.entry, ["--hosted-worker"], {
        env: { ...process.env, GESSO_WORKER: JSON.stringify({ ...this.o.config, token: this.token }) },
        execArgv: [...process.execArgv, ...(this.o.memoryMb ? [`--max-old-space-size=${this.o.memoryMb}`] : [])],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      slot.child = child;
      slot.port = undefined;
      let started = false;
      const timer = setTimeout(() => fail(new Error(`Gesso worker ${i} didn't start within a minute`)), 60_000);
      child.on("message", (message: { ready?: number }) => {
        if (!message?.ready) return;
        slot.port = message.ready;
        started = true;
        clearTimeout(timer);
        ready();
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (slot.child !== child) return;
        slot.child = undefined;
        slot.port = undefined;
        if (this.stopping) return;
        if (!started) return fail(new Error(`Gesso worker ${i} exited while starting (${signal ?? code})`));
        // Restart it, backing off if it keeps crashing.
        slot.crashes = [...slot.crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
        const wait = slot.crashes.length > 3 ? 30_000 : 1000;
        console.error(`Gesso worker ${i} stopped (${signal ?? `exit ${code}`}); restarting it in ${wait / 1000} s`);
        setTimeout(() => void this.spawn(i).catch((err: unknown) => console.error(String(err))), wait).unref();
      });
    });
  }

  /** Passes an MCP request (already read, limited and logged) to the workspace's worker, and its answer back. */
  forward(req: IncomingMessage, res: ServerResponse, key: string, body: unknown, extra: { base: string; via: string }): Promise<void> {
    const slot = this.slots[shardOf(key, this.slots.length)]!;
    if (!slot.port) {
      rpcError(res, 503, "Part of the server is restarting; retry in a few seconds.", { "retry-after": "3" });
      return Promise.resolve();
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: OutgoingHttpHeaders = { "x-gesso-token": this.token, "x-gesso-workspace": key, "x-gesso-base": extra.base, "x-gesso-via": extra.via };
    for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (payload) headers["content-length"] = payload.length;
    return new Promise((done) => {
      const out = request({ host: "127.0.0.1", port: slot.port, method: req.method, path: "/internal/mcp", headers }, (back) => {
        res.writeHead(back.statusCode ?? 502, Object.fromEntries(Object.entries(back.headers).filter(([k]) => !HOP.has(k))));
        back.pipe(res);
        back.on("end", () => done());
        back.on("error", () => {
          res.destroy();
          done();
        });
      });
      out.on("error", () => {
        if (!res.headersSent) {
          rpcError(res, 502, "The request stopped before it finished, most likely because it needed more memory than this server allows. Try a smaller scale, a smaller artboard or fewer filters.");
        } else res.destroy();
        done();
      });
      // The client went away: stop waiting for the worker.
      res.on("close", () => {
        if (!res.writableFinished) out.destroy();
      });
      out.end(payload);
    });
  }
}

type Open = { key: string; dir: string; store: DocStore; state: ServerState; seen: number };

/** A worker: serves MCP requests from the main process on a local port, which it reports when ready. */
export async function startWorker(config: WorkerConfig & { token: string }): Promise<number> {
  const root = join(config.baseDir, "workspaces");
  const sealer = new Sealer(Buffer.from(config.secret, "hex"));
  const expected = Buffer.from(config.token);
  const open = new Map<string, Open>();
  setInterval(() => {
    for (const [key, ws] of open) if (Date.now() - ws.seen > 30 * 60_000) open.delete(key);
  }, 600_000).unref();

  const workspace = async (key: string): Promise<Open | undefined> => {
    if (!KEY.test(key)) return undefined;
    const known = open.get(key);
    if (known) {
      known.seen = Date.now();
      return known;
    }
    const dir = join(root, key);
    await mkdir(dir, { recursive: true });
    const ws = { key, dir, store: new DocStore(dir), state: newServerState(), seen: Date.now() };
    open.set(key, ws);
    return ws;
  };

  const server = createHttpServer((req, res) => {
    void (async () => {
      const given = Buffer.from(String(req.headers["x-gesso-token"] ?? ""));
      if (req.url !== "/internal/mcp" || given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.writeHead(404).end();
      const ws = await workspace(String(req.headers["x-gesso-workspace"] ?? ""));
      if (!ws) return rpcError(res, 404, "No such workspace");
      const read = await readJson(req, res, config.requestMb);
      if (!read.ok) return;
      const via = req.headers["x-gesso-via"] === "key" ? "key" : "oauth";
      await serveMcp(req, res, ws, read.body, linksFor(sealer, config.days, String(req.headers["x-gesso-base"] ?? ""), ws, via), config.maxPixels, true);
    })().catch((err: unknown) => {
      if (!res.headersSent) rpcError(res, 500, err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
  server.requestTimeout = 10 * 60_000;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}
