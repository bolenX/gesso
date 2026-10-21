import { z } from "zod";
import { parseSelector } from "./selector.js";

// Patches are the only way to change a document. Ops are ID-addressed, never
// index-addressed, and apply atomically. See docs/spec-v0.1.md, "Patch format".

export const SelectorString = z.string().superRefine((value, ctx) => {
  try {
    parseSelector(value);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
  }
});

export const SetOp = z.object({
  op: z.literal("set"),
  target: SelectorString,
  /** Dot path into the layer, e.g. "style.fill". */
  path: z.string().min(1),
  value: z.unknown(),
  /** Matching more than one layer is an error unless this is true. */
  many: z.boolean().optional(),
});

/** Inserted layers are validated against the full Layer schema when the patch is applied. */
const PartialLayer = z.object({ id: z.string(), type: z.string() }).passthrough();

export const InsertOp = z
  .object({
    op: z.literal("insert"),
    after: SelectorString.optional(),
    before: SelectorString.optional(),
    /** Insert as the last child of a group or artboard. */
    into: SelectorString.optional(),
    layer: PartialLayer,
  })
  .refine((o) => [o.after, o.before, o.into].filter((v) => v !== undefined).length === 1, {
    message: "insert needs exactly one of after, before or into",
  });

export const MoveOp = z.object({
  op: z.literal("move"),
  target: SelectorString,
  to: z.union([
    z.enum(["top", "bottom", "up", "down"]),
    z.object({ after: SelectorString }),
    z.object({ before: SelectorString }),
  ]),
});

export const RemoveOp = z.object({
  op: z.literal("remove"),
  target: SelectorString,
  many: z.boolean().optional(),
});

export const Op = z.union([SetOp, InsertOp, MoveOp, RemoveOp]);
export type Op = z.infer<typeof Op>;

export const Patch = z.object({
  doc: z.string(),
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(Op).min(1),
  dryRun: z.boolean().optional(),
  /** Preview scale to return with the response, 0 for none. */
  returnPreview: z.number().min(0).max(1).optional(),
});
export type Patch = z.infer<typeof Patch>;

export const PatchResult = z.object({
  revision: z.number().int().nonnegative(),
  changed: z.array(z.string()),
  warnings: z.array(z.string()),
  preview: z.string().optional(),
});
export type PatchResult = z.infer<typeof PatchResult>;

/** Returned on a stale baseRevision, so the agent rebases instead of overwriting. */
export const PatchConflict = z.object({
  conflict: z.literal(true),
  currentRevision: z.number().int().nonnegative(),
  opsSince: z.array(Op),
});

