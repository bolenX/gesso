import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, TOOL_NAMES } from "../src/index.js";
import { promo } from "../../core/test/fixtures.js";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("gesso MCP server", () => {
  it("registers the v0.1 tool surface", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("creates a document and reads it back", async () => {
    const client = await connect();
    const created = await client.callTool({ name: "canvas_create", arguments: { doc: promo } });
    expect(created.isError).toBeFalsy();

    const got = await client.callTool({
      name: "canvas_get",
      arguments: { doc: "promo-01", selectors: ["#headline"] },
    });
    const [first] = got.content as Array<{ text: string }>;
    expect(JSON.parse(first!.text)[0].layer.content).toBe("Summer Edit");
  });

  it("reports unimplemented tools as errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "canvas_render", arguments: { doc: "promo-01" } });
    expect(result.isError).toBe(true);
  });
});
