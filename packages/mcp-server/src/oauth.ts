import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { escape, html, page } from "./pages.js";
import { download } from "./paths.js";

// OAuth 2.1 for hosted Gesso, so claude.ai and ChatGPT connect to one URL (/mcp) and each person gets their
// own workspace. Gesso is its own authorization server: apps register themselves (Dynamic Client Registration,
// or a Client ID Metadata Document URL), the person approves on a consent page, optionally signing in with
// GitHub or Google, and the app gets a short-lived access token and a rotating refresh token. Client ids,
// codes and tokens are sealed with the server's secret (AES-256-GCM), so the only state kept is revocations.

export type Provider = "github" | "google";
type Credentials = { clientId: string; clientSecret: string };

export type OAuthOptions = {
  /** At least 32 bytes. Tokens, and the workspaces of people who sign in with an account, depend on it. */
  secret: Buffer;
  /** Where revocations are kept across restarts. */
  dir: string;
  /** The server's public origin for a request. */
  origin: (req: IncomingMessage) => string;
  /** Lets people connect without an account, with a new workspace each time (on by default). */
  anonymous?: boolean;
  github?: Credentials;
  google?: Credentials;
  /** Days an idle workspace is kept, for the consent page. */
  workspaceDays?: number;
  /** Creates a workspace folder if it doesn't exist. */
  ensureWorkspace: (key: string) => Promise<void>;
  workspaceExists: (key: string) => Promise<boolean>;
  /** False when this address (the person's browser) has made too many workspaces recently. */
  allowNew: (req: IncomingMessage) => boolean;
  /** True for workspace keys or accounts ("github:<id>", "google:<sub>") that are banned. */
  blocked: (id: string) => boolean;
  /** Reads a Client ID Metadata Document; downloads it from the public internet by default. */
  fetchClient?: (url: string) => Promise<unknown>;
  accessSeconds?: number;
  refreshSeconds?: number;
};

type Client = { redirect_uris: string[]; client_name?: string; method: "none" | "client_secret_post" | "client_secret_basic" };
/** An authorization request waiting for the person to approve it, tied to the browser that saw the consent page (`n`). */
type Pending = { cid: string; ru: string; cc: string; state?: string; scope?: string; n: string; exp: number };
type Code = { ws: string; cid: string; ru: string; cc: string; scope?: string; jti: string; exp: number };
type Token = { ws: string; cid: string; fam: string; jti?: string; scope?: string; exp: number };

const SCOPE = "gesso";
/** A refresh token used again this soon is an app retrying, not a copy: it gets a fresh pair instead of ending the sign-in. */
const RETRY_SECONDS = 60;
const now = () => Math.floor(Date.now() / 1000);
const b64 = (b: Buffer) => b.toString("base64url");
/** Client ids can be long; codes and tokens carry a short digest of one. */
const short = (clientId: string) => createHash("sha256").update(clientId).digest("base64url").slice(0, 22);

/** Tokens and ids only this server can make or read. The kind is authenticated too, so one can't pass for another. */
export class Sealer {
  private key: Buffer;
  private macKey: Buffer;
  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error("GESSO_SECRET must be at least 32 bytes");
    this.key = Buffer.from(hkdfSync("sha256", secret, "gesso", "oauth-seal", 32));
    this.macKey = Buffer.from(hkdfSync("sha256", secret, "gesso", "oauth-mac", 32));
  }
  seal(kind: string, payload: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(kind));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return `${kind}_${b64(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
  }
  /** The payload, or undefined if it's forged, of another kind, or past its `exp`. */
  open<T extends { exp?: number }>(kind: string, value: string | null | undefined): T | undefined {
    if (!value?.startsWith(`${kind}_`)) return undefined;
    try {
      const raw = Buffer.from(value.slice(kind.length + 1), "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(kind));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString()) as T;
      return payload.exp === undefined || payload.exp > now() ? payload : undefined;
    } catch {
      return undefined;
    }
  }
  mac(value: string): string {
    return b64(createHmac("sha256", this.macKey).update(value).digest());
  }
}

/** Refresh tokens already used and token families revoked, until they'd have expired anyway. */
class Revocations {
  private ids = new Map<string, number>();
  private saving: Promise<void> | undefined;
  constructor(private file: string) {}
  async load() {
    const saved = await readFile(this.file, "utf8").then((t) => JSON.parse(t) as Record<string, number>, () => ({}) as Record<string, number>);
    for (const [id, exp] of Object.entries(saved)) if (exp > now()) this.ids.set(id, exp);
  }
  has(id: string | undefined) {
    return id !== undefined && this.ids.has(id);
  }
  add(id: string, exp: number) {
    this.ids.set(id, exp);
    this.saving ??= (async () => {
      await new Promise((r) => setTimeout(r, 200));
      this.saving = undefined;
      for (const [k, e] of this.ids) if (e <= now()) this.ids.delete(k);
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.ids)));
      await rename(tmp, this.file);
    })();
  }
  async flush() {
    await this.saving;
  }
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** http(s) addresses only; plain http only back to this computer, for local apps (RFC 8252). */
function redirectOk(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** Exact match, except that apps on this computer may pick any port. */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const [a, b] = [new URL(registered), new URL(given)];
    const loopback = ["localhost", "127.0.0.1", "[::1]"];
    return a.protocol === "http:" && b.protocol === "http:" && loopback.includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new OAuthError("invalid_request", "Request too large");
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString();
  if (String(req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    } catch {
      throw new OAuthError("invalid_request", "The body isn't valid JSON");
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));

export class OAuth {
  readonly sealer: Sealer;
  private revoked: Revocations;
  private usedCodes = new Map<string, number>();
  /** When each refresh token was first used, for telling a retry from a replay. */
  private refreshedAt = new Map<string, number>();
  private clients = new Map<string, { client: Client; until: number }>();

  constructor(private o: OAuthOptions) {
    this.sealer = new Sealer(o.secret);
    this.revoked = new Revocations(join(o.dir, "revoked.json"));
  }

  async start() {
    await mkdir(this.o.dir, { recursive: true });
    await this.revoked.load();
  }

  async stop() {
    await this.revoked.flush();
  }

  /** The URL clients connect to; tokens are issued for it. */
  resource(req: IncomingMessage) {
    return `${this.o.origin(req)}/mcp`;
  }

  /** A workspace key that stays the same every time this account signs in. */
  workspaceFor(account: string) {
    return this.sealer.mac(`workspace:${account}`).slice(0, 32);
  }

  /** Answers the OAuth routes; false when the path is someone else's. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    try {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: this.resource(req), authorization_servers: [this.o.origin(req)], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "Gesso", resource_documentation: "https://gesso.run" });
      } else if (path === "/.well-known/oauth-authorization-server") {
        const at = this.o.origin(req);
        json(res, 200, {
          issuer: at,
          authorization_endpoint: `${at}/authorize`,
          token_endpoint: `${at}/token`,
          registration_endpoint: `${at}/register`,
          revocation_endpoint: `${at}/revoke`,
          scopes_supported: [SCOPE],
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
          service_documentation: "https://gesso.run",
        });
      } else if (path === "/register" && req.method === "POST") {
        await this.register(req, res);
      } else if (path === "/authorize" && req.method === "GET") {
        await this.authorizePage(req, res, url);
      } else if (path === "/authorize" && req.method === "POST") {
        await this.approve(req, res);
      } else if ((path === "/oauth/github/callback" || path === "/oauth/google/callback") && req.method === "GET") {
        await this.callback(req, res, url, path.includes("github") ? "github" : "google");
      } else if (path === "/token" && req.method === "POST") {
        await this.token(req, res);
      } else if (path === "/revoke" && req.method === "POST") {
        await this.revoke(req, res);
      } else {
        return false;
      }
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      json(res, err.status, { error: err.code, error_description: err.message }, err.status === 401 ? { "www-authenticate": 'Basic realm="gesso"' } : {});
    }
    return true;
  }

  /** The workspace an MCP request's bearer token is for. */
  authenticate(req: IncomingMessage): { workspace: string } | { error: "missing" | "invalid_token" } {
    const header = String(req.headers.authorization ?? "");
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return { error: "missing" };
    const token = this.sealer.open<Token>("gat", match[1]);
    if (!token || this.revoked.has(token.fam) || this.o.blocked(token.ws)) return { error: "invalid_token" };
    return { workspace: token.ws };
  }

  /** Tells the app where to sign in (RFC 9728). */
  challenge(req: IncomingMessage, res: ServerResponse, error?: "invalid_token") {
    const metadata = `${this.o.origin(req)}/.well-known/oauth-protected-resource/mcp`;
    res
      .writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="gesso", resource_metadata="${metadata}", scope="${SCOPE}"${error ? `, error="${error}", error_description="The access token is invalid or has expired"` : ""}`,
      })
      .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: error ? "The access token is invalid or has expired" : "Sign in to use Gesso" }, id: null }));
  }

  // ── Clients ──────────────────────────────────────────────────────────────────────────────

  /**
   * Not limited by address: claude.ai and ChatGPT register from their own servers, so one address stands for
   * everyone. Registering stores nothing (the client id is sealed), so there's nothing to fill up.
   */
  private async register(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    let uris: unknown;
    try {
      uris = JSON.parse(body.redirect_uris ?? "null");
    } catch {
      uris = undefined;
    }
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000 && redirectOk(u))) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1–10 https addresses (or http on localhost)");
    }
    const requested = body.token_endpoint_auth_method ?? "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(requested)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method "${requested}" isn't supported`);
    const grants = body.grant_types ? (JSON.parse(body.grant_types) as unknown) : ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
    const client: Client = { redirect_uris: uris as string[], method: requested as Client["method"], ...(body.client_name ? { client_name: body.client_name.slice(0, 100) } : {}) };
    const id = this.sealer.seal("gci", client);
    json(res, 201, {
      client_id: id,
      client_id_issued_at: now(),
      redirect_uris: client.redirect_uris,
      ...(client.client_name ? { client_name: client.client_name } : {}),
      token_endpoint_auth_method: client.method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(client.method === "none" ? {} : { client_secret: this.sealer.mac(`client:${id}`), client_secret_expires_at: 0 }),
    });
  }

  /** A registered client, or one described by a metadata document at its https client id. */
  private async client(id: string | null | undefined): Promise<Client | undefined> {
    if (!id || id.length > 4096) return undefined;
    if (!id.startsWith("https://")) return this.sealer.open<Client & { exp?: number }>("gci", id);
    const cached = this.clients.get(id);
    if (cached && cached.until > Date.now()) return cached.client;
    try {
      const doc = (await (this.o.fetchClient ?? (async (u: string) => JSON.parse(new TextDecoder().decode((await download(u, true)).bytes)) as unknown))(id)) as Record<string, unknown>;
      const uris = doc.redirect_uris;
      if (doc.client_id !== id || !Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && redirectOk(u))) return undefined;
      const client: Client = { redirect_uris: uris as string[], method: "none", ...(typeof doc.client_name === "string" ? { client_name: doc.client_name.slice(0, 100) } : {}) };
      this.clients.set(id, { client, until: Date.now() + 3_600_000 });
      return client;
    } catch {
      return undefined;
    }
  }

  private async clientAuth(req: IncomingMessage, body: Record<string, string>): Promise<{ id: string; client: Client }> {
    let id = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    if (basic) {
      const [user, pass] = Buffer.from(basic[1]!, "base64").toString().split(":");
      id = decodeURIComponent(user ?? "");
      secret = decodeURIComponent(pass ?? "");
    }
    const client = await this.client(id);
    if (!id || !client) throw new OAuthError("invalid_client", "Unknown client", 401);
    if (client.method !== "none") {
      const expected = Buffer.from(this.sealer.mac(`client:${id}`));
      const given = Buffer.from(secret ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuthError("invalid_client", "Wrong client secret", 401);
    }
    return { id, client };
  }

  // ── Authorization ────────────────────────────────────────────────────────────────────────

  private async authorizePage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const q = url.searchParams;
    const cid = q.get("client_id");
    const client = await this.client(cid);
    if (!client) return html(res, 400, page("Can't connect", "<h1>Can't connect</h1><p>The app asking to connect isn't registered with this Gesso server. Start again from the app.</p>"));
    const ru = q.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!ru || !client.redirect_uris.some((r) => sameRedirect(r, ru))) {
      return html(res, 400, page("Can't connect", "<h1>Can't connect</h1><p>The app's return address doesn't match the one it registered, so Gesso won't send you back to it.</p>"));
    }
    const state = q.get("state") ?? undefined;
    const back = (error: string, description: string) => this.redirect(req, res, ru, { error, error_description: description, ...(state ? { state } : {}) });
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only the authorization code flow is supported");
    const cc = q.get("code_challenge");
    if (!cc || q.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with code_challenge_method S256 is required");
    const resource = q.get("resource");
    if (resource && !this.ours(req, resource)) return back("invalid_target", `Tokens are only issued for ${this.resource(req)}`);
    const scope = q.get("scope") ?? undefined;
    // The browser that sees this page gets a cookie that only it can send back with its approval, so another
    // site can't approve for it with a form it submits in the background.
    const nonce = b64(randomBytes(16));
    const pending = this.sealer.seal("gpa", { cid: cid!, ru, cc, ...(state ? { state } : {}), ...(scope ? { scope } : {}), n: nonce, exp: now() + 900 } satisfies Pending);
    const secure = this.o.origin(req).startsWith("https:") ? "; Secure" : "";
    res.setHeader("set-cookie", `ga_${nonce.slice(0, 8)}=${nonce}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax${secure}`);
    html(res, 200, this.consent(client, ru, pending));
  }

  /** True when the request comes from the browser the consent page was shown to. */
  private sameBrowser(req: IncomingMessage, pending: Pending) {
    const cookies = String(req.headers.cookie ?? "").split(";").map((c) => c.trim());
    const expected = `ga_${pending.n.slice(0, 8)}=${pending.n}`;
    return cookies.some((c) => c.length === expected.length && timingSafeEqual(Buffer.from(c), Buffer.from(expected)));
  }

  private consent(client: Client, ru: string, pending: string, note = "") {
    const name = escape(client.client_name ?? "An app");
    const host = escape(new URL(ru).host);
    const days = this.o.workspaceDays ?? 7;
    const field = `<input type="hidden" name="request" value="${escape(pending)}">`;
    const buttons = [
      this.o.github ? `<button name="action" value="github">Continue with GitHub</button>` : "",
      this.o.google ? `<button name="action" value="google">Continue with Google</button>` : "",
      this.o.anonymous !== false ? `<button class="${this.o.github || this.o.google ? "ghost" : ""}" name="action" value="anonymous">Continue without an account</button>` : "",
    ].join("");
    return page(
      "Connect to Gesso",
      `<h1>Connect ${name} to Gesso</h1>
${note ? `<p class="warn">${escape(note)}</p>` : ""}
<p>${name} will be able to create, edit and export images in a private Gesso workspace: documents, the images and fonts you upload, and the files it exports. Workspaces nobody uses for ${days} days are deleted.</p>
${this.o.github || this.o.google ? "<p>Signing in with an account gives you the same workspace each time you connect. Gesso only reads an id from it, not your email, repositories or files.</p>" : ""}
<form method="post" action="/authorize">${field}<div class="stack">${buttons}</div>
<details><summary>Use a workspace you already have</summary><p class="small">Paste its key, or the address of its workspace page.</p>
<input type="text" name="key" autocomplete="off" spellcheck="false" placeholder="Workspace key"><p><button class="ghost" name="action" value="key">Connect this workspace</button></p></details></form>
<p class="small">You'll go back to <b>${host}</b>. Only continue if you started connecting there.</p>`,
    );
  }

  private async approve(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    const pending = this.sealer.open<Pending>("gpa", body.request);
    if (!pending) return html(res, 400, page("Start again", "<h1>This sign-in has expired</h1><p>Go back to the app and connect Gesso again.</p>"));
    if (!this.sameBrowser(req, pending)) return html(res, 403, page("Start again", "<h1>Start again from the app</h1><p>This approval didn't come from the browser that opened the sign-in page. Go back to the app and connect Gesso again.</p>"));
    const client = await this.client(pending.cid);
    if (!client) return html(res, 400, page("Can't connect", "<h1>Can't connect</h1><p>The app isn't registered any more. Start again from the app.</p>"));
    const action = body.action;
    if (action === "anonymous" && this.o.anonymous !== false) {
      if (!this.o.allowNew(req)) return html(res, 429, this.consent(client, pending.ru, body.request!, "Too many new workspaces from this address in the last hour. Try again later, or use a workspace you already have."));
      const key = randomBytes(18).toString("base64url");
      await this.o.ensureWorkspace(key);
      return this.finish(req, res, pending, key);
    }
    if (action === "key") {
      const key = (body.key ?? "").trim().replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? "";
      if (!(await this.o.workspaceExists(key)) || this.o.blocked(key)) return html(res, 400, this.consent(client, pending.ru, body.request!, "There's no workspace with that key. It may have expired."));
      return this.finish(req, res, pending, key);
    }
    if ((action === "github" && this.o.github) || (action === "google" && this.o.google)) {
      const provider = action as Provider;
      const state = this.sealer.seal("gps", { p: body.request, exp: now() + 900 });
      const back = `${this.o.origin(req)}/oauth/${provider}/callback`;
      const target =
        provider === "github"
          ? `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: this.o.github!.clientId, redirect_uri: back, state, allow_signup: "true", scope: "" })}`
          : `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: this.o.google!.clientId, redirect_uri: back, state, response_type: "code", scope: "openid", prompt: "select_account" })}`;
      return void res.writeHead(302, { location: target, "cache-control": "no-store" }).end();
    }
    html(res, 400, page("Can't connect", "<h1>Can't connect</h1><p>Choose one of the ways to continue.</p>"));
  }

  /** Back from GitHub or Google: the account's id picks its workspace. */
  private async callback(req: IncomingMessage, res: ServerResponse, url: URL, provider: Provider) {
    const failed = (why: string) => html(res, 400, page("Can't connect", `<h1>Sign-in didn't finish</h1><p>${escape(why)} Go back to the app and connect Gesso again.</p>`));
    const state = this.sealer.open<{ p: string; exp: number }>("gps", url.searchParams.get("state"));
    const pending = this.sealer.open<Pending>("gpa", state?.p);
    if (!state || !pending) return failed("This sign-in has expired.");
    if (!this.sameBrowser(req, pending)) return failed("This sign-in didn't start in this browser.");
    const code = url.searchParams.get("code");
    if (!code) return failed(url.searchParams.get("error_description") ?? "The sign-in was cancelled.");
    const back = `${this.o.origin(req)}/oauth/${provider}/callback`;
    let account: string;
    try {
      account = provider === "github" ? await this.githubAccount(code, back) : await this.googleAccount(code, back);
    } catch (err) {
      return failed(err instanceof Error ? err.message : "The account couldn't be read.");
    }
    if (this.o.blocked(account)) return failed("This account can't use this Gesso server.");
    const key = this.workspaceFor(account);
    await this.o.ensureWorkspace(key);
    await this.finish(req, res, pending, key);
  }

  private async githubAccount(code: string, redirect: string): Promise<string> {
    const { clientId, clientSecret } = this.o.github!;
    const token = (await (
      await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect }),
      })
    ).json()) as { access_token?: string; error_description?: string };
    if (!token.access_token) throw new Error(token.error_description ?? "GitHub didn't accept the sign-in.");
    const user = (await (await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "gesso" } })).json()) as { id?: number };
    if (!user.id) throw new Error("GitHub didn't return the account.");
    return `github:${user.id}`;
  }

  private async googleAccount(code: string, redirect: string): Promise<string> {
    const { clientId, clientSecret } = this.o.google!;
    const token = (await (
      await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
      })
    ).json()) as { access_token?: string; error_description?: string };
    if (!token.access_token) throw new Error(token.error_description ?? "Google didn't accept the sign-in.");
    const user = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } })).json()) as { sub?: string };
    if (!user.sub) throw new Error("Google didn't return the account.");
    return `google:${user.sub}`;
  }

  /** Sends the person back to the app with a one-time code for this workspace. */
  private finish(req: IncomingMessage, res: ServerResponse, pending: Pending, workspace: string) {
    const code = this.sealer.seal("gac", { ws: workspace, cid: short(pending.cid), ru: pending.ru, cc: pending.cc, ...(pending.scope ? { scope: pending.scope } : {}), jti: b64(randomBytes(12)), exp: now() + 600 } satisfies Code);
    this.redirect(req, res, pending.ru, { code, ...(pending.state ? { state: pending.state } : {}) });
  }

  private redirect(req: IncomingMessage, res: ServerResponse, to: string, params: Record<string, string>) {
    const target = new URL(to);
    for (const [k, v] of Object.entries({ ...params, iss: this.o.origin(req) })) target.searchParams.set(k, v);
    res.writeHead(302, { location: target.href, "cache-control": "no-store" }).end();
  }

  /** The resource an app asked for: this server's /mcp, with or without a trailing slash, or the origin itself. */
  private ours(req: IncomingMessage, resource: string) {
    const r = resource.replace(/\/+$/, "");
    return r === this.resource(req) || r === this.o.origin(req);
  }

  // ── Tokens ───────────────────────────────────────────────────────────────────────────────

  private async token(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    const { id } = await this.clientAuth(req, body);
    if (body.resource && !this.ours(req, body.resource)) throw new OAuthError("invalid_target", `Tokens are only issued for ${this.resource(req)}`);
    if (body.grant_type === "authorization_code") {
      const code = this.sealer.open<Code>("gac", body.code);
      if (!code || code.cid !== short(id)) throw new OAuthError("invalid_grant", "The code is invalid or has expired");
      if (this.usedCodes.has(code.jti)) throw new OAuthError("invalid_grant", "The code was already used");
      if (body.redirect_uri && body.redirect_uri !== code.ru) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the one the code was issued for");
      const verifier = body.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64(createHash("sha256").update(verifier).digest()) !== code.cc) throw new OAuthError("invalid_grant", "code_verifier doesn't match the code challenge");
      this.usedCodes.set(code.jti, code.exp);
      for (const [jti, exp] of this.usedCodes) if (exp <= now()) this.usedCodes.delete(jti);
      return json(res, 200, this.issue(code.ws, short(id), b64(randomBytes(12)), code.scope));
    }
    if (body.grant_type === "refresh_token") {
      const old = this.sealer.open<Token>("grt", body.refresh_token);
      if (!old || old.cid !== short(id) || this.revoked.has(old.fam) || this.o.blocked(old.ws)) throw new OAuthError("invalid_grant", "The refresh token is invalid or has expired");
      if (this.revoked.has(old.jti)) {
        const first = this.refreshedAt.get(old.jti!);
        if (first === undefined || now() - first > RETRY_SECONDS) {
          // Used again later: someone else may hold a copy, so end every token of this sign-in.
          this.revoked.add(old.fam, now() + (this.o.refreshSeconds ?? 60 * 86_400));
          throw new OAuthError("invalid_grant", "The refresh token was already used; sign in again");
        }
      } else {
        this.revoked.add(old.jti!, old.exp);
        this.refreshedAt.set(old.jti!, now());
        for (const [jti, at] of this.refreshedAt) if (now() - at > RETRY_SECONDS) this.refreshedAt.delete(jti);
      }
      await this.o.ensureWorkspace(old.ws);
      return json(res, 200, this.issue(old.ws, short(id), old.fam, old.scope));
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  private issue(ws: string, cid: string, fam: string, scope?: string) {
    const access = this.o.accessSeconds ?? 3600;
    const refresh = this.o.refreshSeconds ?? 60 * 86_400;
    return {
      access_token: this.sealer.seal("gat", { ws, cid, fam, exp: now() + access } satisfies Token),
      token_type: "Bearer",
      expires_in: access,
      refresh_token: this.sealer.seal("grt", { ws, cid, fam, jti: b64(randomBytes(12)), exp: now() + refresh } satisfies Token),
      scope: scope ?? SCOPE,
    };
  }

  private async revoke(req: IncomingMessage, res: ServerResponse) {
    const body = await readForm(req);
    await this.clientAuth(req, body);
    const token = this.sealer.open<Token>("grt", body.token) ?? this.sealer.open<Token>("gat", body.token);
    if (token) this.revoked.add(token.fam, now() + (this.o.refreshSeconds ?? 60 * 86_400));
    res.writeHead(200, { "cache-control": "no-store" }).end();
  }
}
