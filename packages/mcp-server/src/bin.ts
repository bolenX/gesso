#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, DocStore } from "./index.js";

// stdio by default (Claude Code, Desktop). `--http [port]` serves Streamable HTTP
// at /mcp, which is what hosted connectors (for example a claude.ai custom
// connector) talk to. Documents live in memory for the life of the process.
const httpFlag = process.argv.indexOf("--http");

// GESSO_WORKDIR is where assets resolve and exports land. The Claude Desktop extension sets it
// (hosts often start servers in a folder that isn't writable); otherwise it's the current folder.
// A leading "~" is expanded, since configs often say "~/Documents/Gesso" and the shell isn't there to do it.
const workdir = process.env.GESSO_WORKDIR?.trim();
const baseDir = workdir ? workdir.replace(/^~(?=$|[\\/])/, homedir()) : process.cwd();
mkdirSync(baseDir, { recursive: true });

if (httpFlag === -1) {
  await createServer({ baseDir }).connect(new StdioServerTransport());
} else {
  const port = Number(process.argv[httpFlag + 1] ?? process.env.PORT ?? 3333);
  const store = new DocStore();
  createHttpServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/plain" }).end("Gesso MCP server. Connect to /mcp\n");
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await createServer({ store, baseDir }).connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`Gesso MCP server on http://localhost:${port}/mcp`));
}
