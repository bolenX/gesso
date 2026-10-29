import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttp } from "../src/http.js";
import { FILE_TOOL } from "../src/index.js";
import { OAuth } from "../src/oauth.js";

type Text = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: unknown) => (result as Text).content.map((c) => c.text ?? "").join("\n");

const REDIRECT = "https://app.example.com/oauth/callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe("hosted sign-in (OAuth)", () => {
  let base: string;
  let root: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gesso-oauth-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true, limits: { burst: 1000, perSecond: 100 } });
    base = started.url;
    close = started.close;
  });
  afterAll(() => close());

  const register = async (body: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test <app>", token_endpoint_auth_method: "none", ...body }) });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };

  /** Runs the consent page and returns where it sent the browser. */
  const authorize = async (clientId: string, challenge: string, form: Record<string, string> = { action: "anonymous" }, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${base}/mcp`, ...extra });
    const consent = await fetch(`${base}/authorize?${query}`);
    const html = await consent.text();
    const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
    if (!request) return { status: consent.status, html, location: consent.headers.get("location") };
    const cookie = consent.headers.get("set-cookie")!.split(";")[0]!;
    const approved = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ request, ...form }) });
    return { status: approved.status, html, location: approved.headers.get("location") };
  };

  const token = async (params: Record<string, string>) => {
    const res = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };

  /** A whole sign-in: register, approve, exchange the code. */
  const signIn = async (form?: Record<string, string>) => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const { location } = await authorize(client.client_id!, challenge, form);
    const code = new URL(location!).searchParams.get("code")!;
    const { body } = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id!, redirect_uri: REDIRECT, resource: `${base}/mcp` });
    return { clientId: client.client_id!, ...body } as { clientId: string; access_token: string; refresh_token: string };
  };

  const connect = async (access: string) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
    return client;
  };

  it("tells apps where to sign in", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(server).toMatchObject({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ["S256"] });
  });

  it("signs in, works in a private workspace, and links files without giving the workspace away", async () => {
    const before = new Set(await readdir(join(root, "workspaces")));
    const { access_token } = await signIn();
    const key = (await readdir(join(root, "workspaces"))).find((k) => !before.has(k))!;
    expect(key).toBeDefined();
    const client = await connect(access_token);

    // Read-only tools say so; tools that change things ask first. The app directories require every hint, on every tool.
    const all = (await client.listTools()).tools;
    const tools = all.filter((t) => t.name !== FILE_TOOL);
    expect(tools).toHaveLength(21);
    for (const tool of all) {
      expect(tool.annotations?.title, tool.name).toBeTruthy();
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe("boolean");
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual(["canvas_get", "canvas_inspect", "canvas_list", "canvas_outline", "canvas_render", "font_list", "skill_read"]);

    // The instructions carry an upload page for this workspace.
    const upload = /(http:\/\/[^\s]+\/u\/[^\s)]+)/.exec(client.getInstructions() ?? "")?.[1];
    expect(upload).toBeDefined();
    expect(upload).not.toContain(key);
    expect(await (await fetch(upload!)).text()).toContain("Upload to your Gesso workspace");
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#3366ff" } }).png().toBuffer();
    expect((await fetch(`${upload}/uploads/blue.png`, { method: "PUT", body: png })).status).toBe(201);

    const doc = { id: "card", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 80, h: 60 }, background: "#FFFFFF", layers: [] }] };
    expect((await client.callTool({ name: "canvas_create", arguments: { doc } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "asset_import", arguments: { doc: "card", id: "photo", source: "uploads/blue.png" } })).isError).toBeFalsy();
    const missing = await client.callTool({ name: "asset_import", arguments: { doc: "card", id: "x", source: "uploads/nope.png" } });
    expect(textOf(missing)).toContain("/u/");

    const exported = JSON.parse(textOf(await client.callTool({ name: "canvas_export", arguments: { doc: "card", outDir: "out", format: "png" } }))) as { files: Array<{ url: string }> };
    const link = exported.files[0]!.url;
    expect(link).toMatch(new RegExp(`^${base}/dl/`));
    expect(link).not.toContain(key);
    const file = await fetch(link);
    expect(file.status).toBe(200);
    expect((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width).toBe(80);
    expect((await fetch(link.replace("/dl/gdl_", "/dl/gdl_x"))).status).toBe(404);

    // Another sign-in gets a different workspace.
    const other = await connect((await signIn()).access_token);
    expect(textOf(await other.callTool({ name: "canvas_list", arguments: {} }))).toMatch(/No documents/);
  });

  it("refuses a wrong code verifier, a reused code and a code for another app", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const { location } = await authorize(client.client_id!, challenge);
    const back = new URL(location!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(base);
    const code = back.searchParams.get("code")!;
    expect((await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id! })).body.error).toBe("invalid_grant");
    const { body: other } = await register();
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: other.client_id! })).body.error).toBe("invalid_grant");
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id! })).status).toBe(200);
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id! })).body.error).toBe("invalid_grant");
  });

  it("won't send codes to addresses the app didn't register, and needs PKCE", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const wrong = await authorize(client.client_id!, challenge, undefined, { redirect_uri: "https://evil.example.net/cb" });
    expect(wrong.status).toBe(400);
    expect(wrong.location).toBeNull();
    const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: REDIRECT, state: "x" })}`, { redirect: "manual" });
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://example.com/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://127.0.0.1:9999/cb"] })).status).toBe(201);
    // The app's name is shown escaped, with where the browser goes back to.
    const consent = await authorize(client.client_id!, challenge, {});
    expect(consent.html).toContain("Test &#60;app&#62;");
    expect(consent.html).toContain("app.example.com");
  });

  it("rotates refresh tokens and ends the sign-in when an old one comes back", async () => {
    const first = await signIn();
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    const client = await connect(refreshed.body.access_token!);
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);

    // An app retrying straight away gets another pair.
    expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId })).status).toBe(200);
    // Later, reusing it means it leaked: every token from this sign-in stops working.
    vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ["Date"] });
    try {
      expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId })).body.error).toBe("invalid_grant");
    } finally {
      vi.useRealTimers();
    }
    expect((await token({ grant_type: "refresh_token", refresh_token: refreshed.body.refresh_token!, client_id: first.clientId })).body.error).toBe("invalid_grant");
    const after = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${refreshed.body.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("only takes approvals from the browser that opened the consent page", async () => {
    const { body: client } = await register();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const consent = await fetch(`${base}/authorize?${query}`);
    expect(consent.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect(consent.headers.get("x-frame-options")).toBe("DENY");
    const request = /name="request" value="([^"]+)"/.exec(await consent.text())![1]!;
    // Another site submitting the form in the background has no cookie to send.
    const forged = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, action: "anonymous" }) });
    expect(forged.status).toBe(403);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("revokes a sign-in", async () => {
    const signedIn = await signIn();
    await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: signedIn.refresh_token, client_id: signedIn.clientId }) });
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signedIn.access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("reconnects to a workspace with its key", async () => {
    const before = new Set(await readdir(join(root, "workspaces")));
    const first = await connect((await signIn()).access_token);
    const key = (await readdir(join(root, "workspaces"))).find((k) => !before.has(k))!;
    await first.callTool({ name: "canvas_create", arguments: { doc: { id: "kept", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 10, h: 10 }, layers: [] }] } } });
    const again = await connect((await signIn({ action: "key", key: `https://gesso.example/w/${key}` })).access_token);
    expect(textOf(await again.callTool({ name: "canvas_list", arguments: {} }))).toContain("kept");
    const { body: client } = await register();
    const unknown = await authorize(client.client_id!, pkce().challenge, { action: "key", key: "z".repeat(24) });
    expect(unknown.status).toBe(400);
  });

  it("issues confidential clients a secret and checks it", async () => {
    const { body: client } = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toBeTruthy();
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(client.client_id!, challenge)).location!).searchParams.get("code")!;
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id!, client_secret: "wrong" })).status).toBe(401);
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id!, client_secret: client.client_secret! })).status).toBe(200);
  });
});

describe("the MCP SDK's own OAuth client", () => {
  it("discovers, registers, signs in and calls tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "gesso-sdk-auth-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true });
    try {
      const saved: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; consent?: URL; cookie?: string } = {};
      const provider: OAuthClientProvider = {
        redirectUrl: REDIRECT,
        clientMetadata: { client_name: "SDK client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
        clientInformation: () => saved.client,
        saveClientInformation: (info) => void (saved.client = info),
        tokens: () => saved.tokens,
        saveTokens: (tokens) => void (saved.tokens = tokens),
        redirectToAuthorization: (url) => void (saved.consent = url),
        saveCodeVerifier: (v) => void (saved.verifier = v),
        codeVerifier: () => saved.verifier!,
      };
      const mcpUrl = new URL(`${started.url}/mcp`);
      const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
      await expect(new Client({ name: "sdk", version: "0" }).connect(first)).rejects.toThrow(/Unauthorized/);
      expect(saved.client?.client_id).toBeTruthy();

      // The browser part: the person approves on the consent page.
      const page = await fetch(saved.consent!);
      saved.cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const consent = await page.text();
      expect(consent).toContain("Connect SDK client to Gesso");
      const request = /name="request" value="([^"]+)"/.exec(consent)![1]!;
      const approved = await fetch(`${started.url}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: saved.cookie! }, body: new URLSearchParams({ request, action: "anonymous" }) });
      await first.finishAuth(new URL(approved.headers.get("location")!).searchParams.get("code")!);
      expect(saved.tokens?.access_token).toBeTruthy();

      const client = new Client({ name: "sdk", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
      expect(textOf(await client.callTool({ name: "canvas_list", arguments: {} }))).toMatch(/No documents/);
    } finally {
      await started.close();
    }
  });
});

describe("workspace limits", () => {
  it("slows down one workspace without stopping others", async () => {
    const root = await mkdtemp(join(tmpdir(), "gesso-limits-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true, limits: { burst: 4, perSecond: 0.01 } });
    try {
      const key = (await fetch(`${started.url}/new`, { redirect: "manual" })).headers.get("location")!.replace("/w/", "");
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${started.url}/mcp/${key}`)));
      await client.listTools();
      await client.listTools();
      await expect(client.listTools()).rejects.toThrow(/429|Too many requests/);
      const fresh = (await fetch(`${started.url}/new`, { redirect: "manual" })).headers.get("location")!.replace("/w/", "");
      const other = new Client({ name: "test", version: "0.0.0" });
      await other.connect(new StreamableHTTPClientTransport(new URL(`${started.url}/mcp/${fresh}`)));
      expect((await other.listTools()).tools.length).toBeGreaterThan(20);
    } finally {
      await started.close();
    }
  });
});

describe("client metadata documents", () => {
  it("accepts an https client id that describes itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gesso-cimd-"));
    const clientId = "https://client.example.com/oauth/metadata.json";
    const oauth = new OAuth({
      secret: randomBytes(32),
      dir,
      origin: (req: IncomingMessage) => `http://${req.headers.host}`,
      ensureWorkspace: async () => undefined,
      workspaceExists: async () => false,
      allowNew: () => true,
      blocked: () => false,
      fetchClient: async (url) => (url === clientId ? { client_id: clientId, client_name: "Metadata app", redirect_uris: [REDIRECT] } : {}),
    });
    await oauth.start();
    const server = createServer((req, res) => void oauth.handle(req, res, new URL(req.url!, "http://x")).then((handled) => handled || res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { verifier, challenge } = pkce();
      const page = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`);
      const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const consent = await page.text();
      expect(consent).toContain("Connect Metadata app to Gesso");
      const request = /name="request" value="([^"]+)"/.exec(consent)![1]!;
      const approved = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ request, action: "anonymous" }) });
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      const res = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { token_type: string }).token_type).toBe("Bearer");
      // A different document at a different address isn't a client.
      const bad = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://client.example.com/other.json", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`);
      expect(bad.status).toBe(400);
    } finally {
      server.close();
      await oauth.stop();
    }
  });
});
