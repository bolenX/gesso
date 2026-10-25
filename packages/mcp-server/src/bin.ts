#!/usr/bin/env node
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.js";
import { createServer } from "./index.js";
import { startTunnel } from "./tunnel.js";
import { startWorker } from "./workers.js";

// stdio by default (Claude Code, Desktop). `--http [port]` serves Streamable HTTP at /mcp on this
// computer; add `--hosted` to serve claude.ai and ChatGPT connectors, with OAuth sign-in and a private
// workspace per user (see docs/hosting.md). `--tunnel` makes this computer reachable from claude.ai and
// ChatGPT through a free Cloudflare tunnel, for one person, with a pairing code; `--personal` does the same
// behind a tunnel you run yourself (GESSO_PUBLIC_URL).
const httpFlag = process.argv.indexOf("--http");
const hosted = process.argv.includes("--hosted");
const tunnel = process.argv.includes("--tunnel");
const personal = tunnel || process.argv.includes("--personal");

// GESSO_WORKDIR is where assets resolve and exports land. The Claude Desktop extension sets it
// (hosts often start servers in a folder that isn't writable); otherwise it's the current folder.
// A leading "~" is expanded, since configs often say "~/Documents/Gesso" and the shell isn't there to do it.
// Hosted, it's the folder that holds every workspace.
const workdir = process.env.GESSO_WORKDIR?.trim() || (personal ? "~/Documents/Gesso" : undefined);
const baseDir = workdir ? workdir.replace(/^~(?=$|[\\/])/, homedir()) : process.cwd();
mkdirSync(baseDir, { recursive: true });

const number = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
const off = (name: string) => /^(0|false|no|off)$/i.test(process.env[name] ?? "");
/** Both halves of an OAuth app's credentials, or nothing. */
const credentials = (prefix: string) => {
  const [clientId, clientSecret] = [process.env[`${prefix}_CLIENT_ID`], process.env[`${prefix}_CLIENT_SECRET`]];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};
/** GESSO_VERIFY: `/path=content` pairs, separated by commas or new lines, served as plain text (domain verification). */
const verification = (value: string) =>
  Object.fromEntries(
    value
      .split(/[,\n]/)
      .map((pair) => pair.trim())
      .filter((pair) => pair.startsWith("/") && pair.includes("="))
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
/** GESSO_SECRET as 64 hex characters, or any string of at least 32 characters. */
const secret = () => {
  const value = process.env.GESSO_SECRET?.trim();
  if (!value) return undefined;
  const bytes = /^[0-9a-f]{64,}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value);
  if (bytes.length < 32) throw new Error("GESSO_SECRET must be at least 32 bytes (for example 64 hex characters from `openssl rand -hex 32`)");
  return bytes;
};

if (process.argv.includes("--hosted-worker")) {
  // Started by a hosted server to run tool calls; it passes the settings and gets the port back.
  const port = await startWorker(JSON.parse(process.env.GESSO_WORKER ?? "{}"));
  process.send?.({ ready: port });
  process.on("disconnect", () => process.exit(0));
} else if (personal) {
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0").replace(/^(\d{4})/, "$1-");
  const port = Number(process.env.PORT ?? 0);
  const started = await startHttp({
    port,
    host: "127.0.0.1",
    baseDir,
    personal: { code },
    // Quick tunnels don't pass event streams through reliably; plain JSON answers always work.
    jsonResponse: true,
    ...(process.env.GESSO_PUBLIC_URL ? { publicUrl: process.env.GESSO_PUBLIC_URL } : {}),
    ...(number("GESSO_MAX_MEGAPIXELS") ? { maxMegapixels: number("GESSO_MAX_MEGAPIXELS")! } : {}),
  });
  let address = process.env.GESSO_PUBLIC_URL?.replace(/\/$/, "");
  if (tunnel) {
    try {
      const opened = await startTunnel(Number(new URL(started.url).port), {
        onClose: (why) => {
          console.error(`\nThe Cloudflare tunnel closed (${why}). Start Gesso again to get a new address.`);
          process.exit(1);
        },
      });
      address = opened.url;
      started.setPublicUrl(opened.url);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (opened.stop(), process.exit(0)));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (!address) {
    console.error("--personal needs GESSO_PUBLIC_URL: the https address your tunnel gives this computer. Or use --tunnel for a free Cloudflare one.");
    process.exit(1);
  }
  console.error(
    [
      "",
      "Gesso is running on this computer. Connect claude.ai or ChatGPT to:",
      "",
      `    ${address}/mcp`,
      "",
      "  claude.ai: Settings › Connectors › Add custom connector, and paste the address.",
      "  ChatGPT:   Settings › Apps › Advanced settings › Developer mode › Create app, with the address and OAuth.",
      "",
      `When Gesso asks for a pairing code, enter:  ${code}`,
      "",
      `Your files are in ${baseDir}.`,
      tunnel ? "Keep this window open. The address changes each time you start Gesso, so update the connector then." : "Keep this window open.",
      "",
    ].join("\n"),
  );
} else if (httpFlag === -1 && !hosted) {
  await createServer({ baseDir }).connect(new StdioServerTransport());
} else {
  const arg = process.argv[httpFlag + 1];
  const port = Number(arg && /^\d+$/.test(arg) ? arg : (process.env.PORT ?? 3333));
  const github = credentials("GESSO_GITHUB");
  const google = credentials("GESSO_GOOGLE");
  const key = secret();
  // Tool calls run in worker processes, one per core up to 4, so one long render doesn't hold up everyone.
  const workers = number("GESSO_WORKERS") ?? Math.min(availableParallelism(), 4);
  const { url } = await startHttp({
    port,
    baseDir,
    hosted,
    ...(process.env.HOST ? { host: process.env.HOST } : {}),
    ...(process.env.GESSO_PUBLIC_URL ? { publicUrl: process.env.GESSO_PUBLIC_URL } : {}),
    ...(number("GESSO_WORKSPACE_DAYS") ? { workspaceDays: number("GESSO_WORKSPACE_DAYS")! } : {}),
    ...(number("GESSO_WORKSPACE_MB") ? { workspaceMb: number("GESSO_WORKSPACE_MB")! } : {}),
    ...(number("GESSO_UPLOAD_MB") ? { uploadMb: number("GESSO_UPLOAD_MB")! } : {}),
    ...(number("GESSO_MAX_MEGAPIXELS") ? { maxMegapixels: number("GESSO_MAX_MEGAPIXELS")! } : {}),
    ...(number("GESSO_REQUEST_MB") ? { requestMb: number("GESSO_REQUEST_MB")! } : {}),
    ...(number("GESSO_PROXY_HOPS") !== undefined ? { proxyHops: number("GESSO_PROXY_HOPS")! } : {}),
    ...(process.env.GESSO_CLIENT_IP_HEADER ? { clientIpHeader: process.env.GESSO_CLIENT_IP_HEADER } : {}),
    ...(number("GESSO_MAX_REQUESTS") ? { limits: { total: number("GESSO_MAX_REQUESTS")! } } : {}),
    ...(key ? { secret: key } : {}),
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
    ...(off("GESSO_ANONYMOUS") ? { anonymous: false } : {}),
    ...(off("GESSO_KEY_URLS") ? { keyUrls: false } : {}),
    ...(process.env.GESSO_BLOCKLIST ? { blocklist: process.env.GESSO_BLOCKLIST } : {}),
    ...(hosted && !off("GESSO_LOG") ? { log: (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)) } : {}),
    ...(process.env.GESSO_DISABLE_TOOLS ? { disabledTools: process.env.GESSO_DISABLE_TOOLS.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    ...(process.env.GESSO_VERIFY ? { verification: verification(process.env.GESSO_VERIFY) } : {}),
    ...(hosted && workers >= 2 ? { workers: { count: workers, entry: fileURLToPath(import.meta.url), ...(number("GESSO_WORKER_MB") ? { memoryMb: number("GESSO_WORKER_MB")! } : {}) } } : {}),
  });
  if (hosted && !process.env.GESSO_PUBLIC_URL) console.error("Set GESSO_PUBLIC_URL to the server's https address: sign-in and links use it.");
  if (hosted && off("GESSO_ANONYMOUS") && !github && !google) console.error("GESSO_ANONYMOUS is off but no GitHub or Google sign-in is set up, so nobody can connect over /mcp.");
  console.error(hosted ? `Hosted Gesso on ${url}: connect to ${process.env.GESSO_PUBLIC_URL ?? url}/mcp` : `Gesso MCP server on ${url}/mcp`);
}
