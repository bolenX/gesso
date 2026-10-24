import { applyOps, PatchError, type ApplyOptions } from "./apply.js";
import type { Op, Patch, PatchResult } from "./patch.js";
import { Doc } from "./schema.js";

// The event log. Every revision records its ops and author; undo, revert and
// conflict handling come from it. Snapshots per revision keep v0.1 simple; a
// compacted log can replace them later without changing this interface.

export type Revision = {
  revision: number;
  author: string;
  at: string;
  ops: Op[];
  /** Set when this revision restored an earlier one. */
  revertedTo?: number;
};

export type Conflict = { conflict: true; currentRevision: number; opsSince: Op[] };

/** A history as stored on disk. */
export type SavedHistory = { format: "gesso-history"; version: 1; snapshots: Doc[]; log: Revision[] };

export class DocHistory {
  private snapshots: Doc[];
  private log: Revision[];

  constructor(doc: Doc, author = "system") {
    this.snapshots = [doc];
    this.log = [{ revision: doc.revision, author, at: new Date().toISOString(), ops: [] }];
  }

  /** Restores a history saved with toJSON. Snapshots are validated, so a hand-edited file can't load broken. */
  static fromJSON(data: unknown): DocHistory {
    const saved = data as Partial<SavedHistory>;
    if (saved?.format !== "gesso-history" || !Array.isArray(saved.snapshots) || !Array.isArray(saved.log) || saved.snapshots.length === 0) {
      throw new PatchError("not a saved Gesso document");
    }
    if (saved.snapshots.length !== saved.log.length) throw new PatchError("saved document is inconsistent: snapshots and log differ in length");
    const history = Object.create(DocHistory.prototype) as DocHistory;
    history.snapshots = saved.snapshots.map((s) => Doc.parse(s));
    history.log = saved.log;
    return history;
  }

  toJSON(): SavedHistory {
    return { format: "gesso-history", version: 1, snapshots: this.snapshots, log: this.log };
  }

  get head(): Doc {
    return this.snapshots[this.snapshots.length - 1]!;
  }

  revisions(): Revision[] {
    return [...this.log];
  }

  at(revision: number): Doc {
    const i = this.log.findIndex((r) => r.revision === revision);
    if (i < 0) throw new PatchError(`no revision ${revision}`);
    return this.snapshots[i]!;
  }

  /** Applies a patch, or returns the ops applied since its baseRevision so the agent can rebase. */
  apply(patch: Patch, author: string, options: ApplyOptions = {}): PatchResult | Conflict {
    const head = this.head;
    if (patch.doc !== head.id) throw new PatchError(`patch is for "${patch.doc}", not "${head.id}"`);
    if (patch.baseRevision !== head.revision) {
      const since = this.log.filter((r) => r.revision > patch.baseRevision);
      if (since.length === 0 && patch.baseRevision > head.revision) {
        throw new PatchError(`baseRevision ${patch.baseRevision} is ahead of ${head.revision}`);
      }
      return { conflict: true, currentRevision: head.revision, opsSince: since.flatMap((r) => r.ops) };
    }
    const { doc, changed, warnings } = applyOps(head, patch.ops, options);
    const revision = head.revision + 1;
    if (!patch.dryRun) this.commit({ ...doc, revision }, { author, ops: patch.ops });
    return { revision: patch.dryRun ? head.revision : revision, changed, warnings };
  }

  /** Restores an earlier revision as a new revision, so history is never rewritten. */
  revert(to: number, author: string): Doc {
    const target = this.at(to);
    const doc = { ...structuredClone(target), revision: this.head.revision + 1 };
    this.commit(doc, { author, ops: [], revertedTo: to });
    return doc;
  }

  private commit(doc: Doc, entry: Omit<Revision, "revision" | "at">): void {
    this.snapshots.push(doc);
    this.log.push({ ...entry, revision: doc.revision, at: new Date().toISOString() });
  }
}

export function isConflict(result: PatchResult | Conflict): result is Conflict {
  return "conflict" in result;
}
