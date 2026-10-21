// Selectors: #id, @role, .tag, $selection, optionally scoped by artboard
// ("story-9x16 #headline"). See docs/spec-v0.1.md, "Agent interface".

export type SelectorTerm =
  | { kind: "id"; value: string }
  | { kind: "role"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "selection" };

export type Selector = { artboard?: string; term: SelectorTerm };

const NAME = /^[a-z0-9][a-z0-9-]*$/i;

export class SelectorError extends Error {
  override name = "SelectorError";
}

export function parseSelector(input: string): Selector {
  const parts = input.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "" || parts.length > 2) {
    throw new SelectorError(`Invalid selector "${input}": expected "[artboard] <term>"`);
  }
  let artboard: string | undefined;
  if (parts.length === 2) {
    artboard = parts[0]!;
    if (!NAME.test(artboard)) throw new SelectorError(`Invalid artboard scope "${artboard}"`);
  }
  const raw = parts[parts.length - 1]!;
  const term = parseTerm(raw);
  return artboard === undefined ? { term } : { artboard, term };
}

function parseTerm(raw: string): SelectorTerm {
  if (raw === "$selection") return { kind: "selection" };
  const sigil = raw[0];
  const value = raw.slice(1);
  const kind = sigil === "#" ? "id" : sigil === "@" ? "role" : sigil === "." ? "tag" : undefined;
  if (!kind || !NAME.test(value)) {
    throw new SelectorError(`Invalid selector term "${raw}": use #id, @role, .tag or $selection`);
  }
  return { kind, value };
}
