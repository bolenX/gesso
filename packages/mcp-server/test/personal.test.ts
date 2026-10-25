import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { INSTALL_CLOUDFLARED, startTunnel } from "../src/tunnel.js";

type Text = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: unknown) => (result as Text).content.map((c) => c.text ?? "").join("\n");
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

describe("Gesso on your own computer (--tunnel)", () => {
  let base: string;
  let folder: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "gesso-mine-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: folder, personal: { code: "4821-7735" }, oauthDir: await mkdtemp(join(tmpdir(), "gesso-mine-oauth-")), jsonResponse: true });
    ({ url: base, close } = started);
  });
  afterAll(() => close());

  /** Registers an app and opens the consent page, returning what's needed to approve it. */
  const begin = async () => {
    const client = (await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const page = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
    const html = await page.text();
    return { clientId: client.client_id, verifier, html, cookie: page.headers.get("set-cookie")!.split(";")[0]!, request: /name="request" value="([^"]+)"/.exec(html)![1]! };
  };
  const approve = (flow: Awaited<ReturnType<typeof begin>>, code: string) =>
    fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: flow.cookie }, body: new URLSearchParams({ request: flow.request, action: "pair", code }) });

  it("asks for the pairing code, then works in the user's own Gesso folder", async () => {
    const flow = await begin();
    expect(flow.html).toContain("Connect Claude to Gesso on your computer");
    expect(flow.html).toContain("pairing code");
    expect(flow.html).not.toContain("without an account");

    const wrong = await approve(flow, "1111-2222");
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Check the code shown where you started Gesso");

    // Spaces and missing dashes are fine.
    const right = await approve(flow, " 48217735 ");
    expect(right.status).toBe(302);
    const code = new URL(right.headers.get("location")!).searchParams.get("code")!;
    const tokens = (await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: flow.verifier, client_id: flow.clientId }) })).json()) as { access_token: string };

    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const doc = { id: "poster", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 40, h: 30 }, background: "#FF8800", layers: [] }] };
    expect((await client.callTool({ name: "canvas_create", arguments: { doc } })).isError).toBeFalsy();
    const exported = JSON.parse(textOf(await client.callTool({ name: "canvas_export", arguments: { doc: "poster", outDir: "out", format: "png" } }))) as { files: Array<{ url: string }> };
    // The files land in the user's folder, and come back as links through the tunnel's address.
    expect(await readdir(join(folder, "out"))).toContain("a.png");
    expect(exported.files[0]!.url).toMatch(new RegExp(`^${base}/dl/`));
    expect((await fetch(exported.files[0]!.url)).status).toBe(200);
    // Tools still can't reach outside it.
    expect(textOf(await client.callTool({ name: "asset_import", arguments: { doc: "poster", id: "x", source: "/etc/hosts" } }))).toMatch(/outside your workspace/);

    // No workspaces folder, key URLs or sign-up in someone's own Gesso folder.
    expect(await readdir(folder)).not.toContain("workspaces");
    expect((await fetch(`${base}/new`, { redirect: "manual" })).status).toBe(404);
  });

  it("answers with plain JSON, which every tunnel passes through", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    const flow = await begin();
    const right = await approve(flow, "4821-7735");
    const code = new URL(right.headers.get("location")!).searchParams.get("code")!;
    const { access_token } = (await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: flow.verifier, client_id: flow.clientId }) })).json()) as { access_token: string };
    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.headers.get("content-type")).toMatch(/^application\/json/);
    expect(((await listed.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(20);
  });

  it("pauses pairing after too many wrong codes", async () => {
    const flow = await begin();
    let status = 0;
    for (let i = 0; i < 12 && status !== 429; i++) status = (await approve(flow, "0000-0000")).status;
    expect(status).toBe(429);
    // Even the right code waits now.
    expect((await approve(flow, "4821-7735")).status).toBe(429);
  });
});

describe("Cloudflare quick tunnels", () => {
  /** A stand-in for cloudflared that prints what the real one does. */
  const fake = async (lines: string[], stay = true) => {
    const dir = await mkdtemp(join(tmpdir(), "gesso-cloudflared-"));
    const file = join(dir, "cloudflared");
    await writeFile(file, `#!/usr/bin/env node\n${lines.map((l) => `process.stderr.write(${JSON.stringify(`${l}\n`)});`).join("\n")}\n${stay ? "setInterval(() => {}, 1000);" : "process.exit(3);"}\n`);
    await chmod(file, 0o755);
    return file;
  };

  it("reads the tunnel's address from cloudflared", async () => {
    const binary = await fake([
      "INF Requesting new quick Tunnel on trycloudflare.com...",
      "INF calling https://api.trycloudflare.com/tunnel",
      "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "INF |  https://tender-quiet-river-blue.trycloudflare.com                                         |",
      "INF Registered tunnel connection connIndex=0 connection=0a1b event=0 ip=198.41.192.7 location=ams01 protocol=quic",
    ]);
    const tunnel = await startTunnel(3333, { binary });
    expect(tunnel.url).toBe("https://tender-quiet-river-blue.trycloudflare.com");
    tunnel.stop();
  });

  it("says how to install cloudflared when it's missing, and reports a tunnel that fails", async () => {
    await expect(startTunnel(3333, { binary: "/nonexistent/cloudflared" })).rejects.toThrow(INSTALL_CLOUDFLARED.split("\n")[0]!);
    await expect(startTunnel(3333, { binary: await fake(["ERR failed to request quick Tunnel"], false) })).rejects.toThrow(/stopped before the tunnel opened[\s\S]*failed to request/);
    // An address but no connection, as behind a firewall that blocks port 7844.
    const blocked = await fake(["INF |  https://lonely-island.trycloudflare.com  |", "ERR edge discovery: error looking up Cloudflare edge IPs"]);
    await expect(startTunnel(3333, { binary: blocked, timeoutMs: 500 })).rejects.toThrow(/lonely-island[\s\S]*port 7844/);
  });
});
