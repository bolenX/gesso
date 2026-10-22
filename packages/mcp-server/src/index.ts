import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Doc, isConflict, outline, Patch, select, semanticErrors } from "@gesso/core";
import { z } from "zod";
import { DocStore } from "./store.js";

export { DocStore };

// The v0.1 tool surface. See docs/spec-v0.1.md, "Agent interface".
export const TOOL_NAMES = [
  "canvas_create",
  "canvas_outline",
  "canvas_get",
  "canvas_selection",
  "canvas_patch",
  "canvas_render",
  "artboard_create",
  "canvas_export",
  "asset_import",
  "canvas_history",
  "gen_prepare",
] as const;

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Turns expected failures (bad selectors, invalid patches) into tool errors the agent can act on. */
async function guard(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error) return error(err.message);
    throw err;
  }
}

const notImplemented = (tool: string) => async (): Promise<CallToolResult> => ({
  isError: true,
  content: [{ type: "text", text: `${tool} is not implemented yet` }],
});

export type ServerOptions = { store?: DocStore; author?: string };

export function createServer({ store = new DocStore(), author = "agent" }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "gesso", version: "0.0.0" });
  const docId = z.string().describe("Document ID");

  server.registerTool(
    "canvas_create",
    {
      description: "Create a document from a full spec. Returns the outline.",
      inputSchema: { doc: z.unknown().describe("A complete Gesso document") },
    },
    async ({ doc }) => {
      const parsed = Doc.safeParse(doc);
      if (!parsed.success) return error(parsed.error.message);
      const problems = semanticErrors(parsed.data);
      if (problems.length > 0) return error(problems.join("; "));
      store.put(parsed.data, author);
      return text(outline(parsed.data));
    },
  );

  server.registerTool(
    "canvas_outline",
    {
      description: "Compact tree of artboards and layers. The default read.",
      inputSchema: { doc: docId },
    },
    async ({ doc }) => guard(() => text(outline(store.get(doc)))),
  );

  server.registerTool(
    "canvas_get",
    {
      description: "Full JSON for the layers matching the given selectors.",
      inputSchema: { doc: docId, selectors: z.array(z.string()).min(1) },
    },
    async ({ doc, selectors }) =>
      guard(() => {
        const d = store.get(doc);
        return json(selectors.flatMap((s) => select(d, s, store.selection(doc))));
      }),
  );

  server.registerTool(
    "canvas_selection",
    {
      description: "Read the current selection, or set it by passing layer IDs.",
      inputSchema: { doc: docId, set: z.array(z.string()).optional() },
    },
    async ({ doc, set }) =>
      guard(() => {
        store.get(doc);
        if (set) store.setSelection(doc, set);
        return text(JSON.stringify(store.selection(doc)));
      }),
  );

  server.registerTool(
    "canvas_patch",
    {
      description: "Apply atomic, ID-addressed operations against a baseRevision.",
      inputSchema: Patch.shape,
    },
    async (args) =>
      guard(() => {
        const patch = Patch.parse(args);
        const history = store.history(patch.doc);
        const result = history.apply(patch, author, { selection: store.selection(patch.doc) });
        if (isConflict(result)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Stale baseRevision; rebase onto the ops below.\n${JSON.stringify(result, null, 2)}` }],
          };
        }
        if (patch.dryRun) return json({ ...result, dryRun: true });
        return json({ ...result, outline: outline(history.head) });
      }),
  );

  server.registerTool(
    "canvas_history",
    {
      description: "List revisions, or revert to an earlier one (recorded as a new revision).",
      inputSchema: { doc: docId, revertTo: z.number().int().nonnegative().optional() },
    },
    async ({ doc, revertTo }) =>
      guard(() => {
        const history = store.history(doc);
        if (revertTo !== undefined) {
          const reverted = history.revert(revertTo, author);
          return json({ revision: reverted.revision, outline: outline(reverted) });
        }
        return json(history.revisions());
      }),
  );

  const stubs: Array<[string, string]> = [
    ["canvas_render", "Preview render at a scale, with an optional region or annotated mode."],
    ["artboard_create", "New artboard from a preset or size, or duplicate one with reflow."],
    ["canvas_export", "Export PNG per artboard, PSD, and the manifest."],
    ["asset_import", "Import an asset from a URL or path."],
    ["gen_prepare", "Build a provider-neutral generative job spec."],
  ];
  for (const [name, description] of stubs) {
    server.registerTool(
      name,
      { description, inputSchema: { doc: docId, args: z.record(z.unknown()).optional() } },
      notImplemented(name),
    );
  }

  return server;
}
