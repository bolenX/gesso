import { DocHistory, type Doc } from "@gesso/core";

/** In-memory document store, one event log per document. Persistence replaces this later. */
export class DocStore {
  private docs = new Map<string, DocHistory>();
  private selections = new Map<string, string[]>();

  put(doc: Doc, author: string): void {
    this.docs.set(doc.id, new DocHistory(doc, author));
  }

  history(id: string): DocHistory {
    const history = this.docs.get(id);
    if (!history) throw new Error(`No document "${id}"`);
    return history;
  }

  get(id: string): Doc {
    return this.history(id).head;
  }

  selection(id: string): string[] {
    return this.selections.get(id) ?? [];
  }

  setSelection(id: string, layerIds: string[]): void {
    this.selections.set(id, layerIds);
  }
}
