import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocHistory, type Doc } from "@gesso/core";

export type SavedDoc = { id: string; revision: number; artboards: number; modified: string };

/**
 * Documents and their revision histories. With a folder, every change is saved to
 * <folder>/.gesso/<id>.json and documents reopen on first use, so they survive
 * restarts and new sessions. Without one, documents live in memory only.
 */
export class DocStore {
  private docs = new Map<string, DocHistory>();
  private selections = new Map<string, string[]>();
  private readonly dir: string | undefined;

  constructor(folder?: string) {
    this.dir = folder ? join(folder, ".gesso") : undefined;
  }

  /** Starts a document's history. Callers check exists() first so nothing is replaced by accident. */
  put(doc: Doc, author: string): void {
    this.docs.set(doc.id, new DocHistory(doc, author));
    this.save(doc.id);
  }

  exists(id: string): boolean {
    const file = this.file(id);
    return this.docs.has(id) || (file !== undefined && safeStat(file) !== undefined);
  }

  history(id: string): DocHistory {
    const open = this.docs.get(id);
    if (open) return open;
    const file = this.file(id);
    if (file && safeStat(file)) {
      const history = DocHistory.fromJSON(JSON.parse(readFileSync(file, "utf8")));
      this.docs.set(id, history);
      return history;
    }
    throw new Error(`No document "${id}". canvas_list shows the saved ones; canvas_create starts a new one.`);
  }

  get(id: string): Doc {
    return this.history(id).head;
  }

  /** Writes a document's history to disk, via a temporary file so a crash never leaves half a file. */
  save(id: string): void {
    const file = this.file(id);
    const history = this.docs.get(id);
    if (!file || !history) return;
    mkdirSync(this.dir!, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(history));
    renameSync(tmp, file);
  }

  /** Saved and open documents, most recently changed first. */
  list(): SavedDoc[] {
    const found = new Map<string, SavedDoc>();
    if (this.dir && safeStat(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        try {
          const head = this.get(id);
          found.set(id, { id, revision: head.revision, artboards: head.artboards.length, modified: safeStat(join(this.dir, name))!.mtime.toISOString() });
        } catch {
          // Not a Gesso document, or unreadable: leave it out of the list.
        }
      }
    }
    for (const [id, history] of this.docs) {
      if (!found.has(id)) found.set(id, { id, revision: history.head.revision, artboards: history.head.artboards.length, modified: new Date().toISOString() });
    }
    return [...found.values()].sort((a, b) => b.modified.localeCompare(a.modified));
  }

  selection(id: string): string[] {
    return this.selections.get(id) ?? [];
  }

  setSelection(id: string, layerIds: string[]): void {
    this.selections.set(id, layerIds);
  }

  private file(id: string): string | undefined {
    // Document IDs are letters, digits and dashes (the schema enforces it), so they're safe as file names.
    return this.dir && /^[a-z0-9][a-z0-9-]*$/i.test(id) ? join(this.dir, `${id}.json`) : undefined;
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
