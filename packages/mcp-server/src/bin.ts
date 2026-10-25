#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.js";
import { createServer } from "./index.js";

// stdio by default (Claude Code, Desktop). `--http [port]` serves Streamable HTTP at /mcp on this
// computer; add `--hosted` to serve claude.ai and ChatGPT connectors, with a private workspace per user
// (see docs/hosting.md).
const httpFlag = process.argv.indexOf("--http");
const hosted = process.argv.includes("--hosted");

// GESSO_WORKDIR is where assets resolve and exports land. The Claude Desktop extension sets it
// (hosts often start servers in a folder that isn't writable); otherwise it's the current folder.
// A leading "~" is expanded, since configs often say "~/Documents/Gesso" and the shell isn't there to do it.
// Hosted, it's the folder that holds every workspace.
const workdir = process.env.GESSO_WORKDIR?.trim();
const baseDir = workdir ? workdir.replace(/^~(?=$|[\\/])/, homedir()) : process.cwd();
mkdirSync(baseDir, { recursive: true });

const number = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);

if (httpFlag === -1 && !hosted) {
  await createServer({ baseDir }).connect(new StdioServerTransport());
} else {
  const arg = process.argv[httpFlag + 1];
  const port = Number(arg && /^\d+$/.test(arg) ? arg : (process.env.PORT ?? 3333));
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
  });
  console.error(hosted ? `Hosted Gesso on ${url}: create a workspace at ${url}/new` : `Gesso MCP server on ${url}/mcp`);
}
