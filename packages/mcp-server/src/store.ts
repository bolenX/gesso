import type { Doc } from "@gesso/core";

/** In-memory document store. The event log and persistence replace this later. */
export class DocStore {
  private docs = new Map<string, Doc>();
  private selections = new Map<string, string[]>();

  put(doc: Doc): void {
    this.docs.set(doc.id, doc);
  }

  get(id: string): Doc {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`No document "${id}"`);
    return doc;
  }

  selection(id: string): string[] {
    return this.selections.get(id) ?? [];
  }

  setSelection(id: string, layerIds: string[]): void {
    this.selections.set(id, layerIds);
  }
}
