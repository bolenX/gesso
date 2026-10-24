import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";

// Reads the names out of font files without loading them whole, so a scan of the
// system fonts stays fast, and pulls single faces out of .ttc collections, which
// the renderer can only load one face at a time.

export type FontFace = {
  /** Family as apps group it, e.g. "Inter". */
  family: string;
  /** Style within the family, e.g. "Bold Italic". */
  style: string;
  /** Full name, unique per face, e.g. "Inter Bold Italic". */
  fullName: string;
  postscriptName?: string;
  /** usWeightClass: 400 regular, 700 bold. */
  weight: number;
  italic: boolean;
  /** Face index inside a .ttc collection; 0 for a single-face file. */
  face: number;
};

export type InstalledFont = FontFace & { path: string };

type Read = (offset: number, length: number) => Promise<Uint8Array>;

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Every face in a font file, read through `read`. */
export async function readFontFaces(read: Read): Promise<FontFace[]> {
  const head = await read(0, 12);
  if (head.length < 12) return [];
  if (tag(head, 0) !== "ttcf") {
    const face = await readFace(read, 0, 0);
    return face ? [face] : [];
  }
  const count = view(head).getUint32(8);
  const offsets = view(await read(12, count * 4));
  const faces: FontFace[] = [];
  for (let i = 0; i < count; i++) {
    const face = await readFace(read, offsets.getUint32(i * 4), i);
    if (face) faces.push(face);
  }
  return faces;
}

async function tables(read: Read, at: number): Promise<Map<string, { offset: number; length: number }>> {
  const n = view(await read(at + 4, 2)).getUint16(0);
  const dir = await read(at + 12, n * 16);
  const found = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const d = view(dir);
    found.set(tag(dir, i * 16), { offset: d.getUint32(i * 16 + 8), length: d.getUint32(i * 16 + 12) });
  }
  return found;
}

async function readFace(read: Read, at: number, index: number): Promise<FontFace | undefined> {
  const dir = await tables(read, at);
  const nameTable = dir.get("name");
  if (!nameTable) return undefined;
  const names = parseNames(await read(nameTable.offset, nameTable.length));
  const os2 = dir.get("OS/2");
  let weight = 400;
  let italic = false;
  if (os2 && os2.length >= 64) {
    const o = view(await read(os2.offset, 64));
    weight = o.getUint16(4);
    italic = (o.getUint16(62) & 1) === 1;
  }
  const family = names.get(16) ?? names.get(1);
  if (!family) return undefined;
  const style = names.get(17) ?? names.get(2) ?? "Regular";
  return {
    family,
    style,
    fullName: names.get(4) ?? `${family} ${style}`,
    postscriptName: names.get(6),
    weight,
    italic: italic || /italic|oblique/i.test(style),
    face: index,
  };
}

/** Name IDs to strings, preferring Windows English, then any Windows, then Mac Roman. */
function parseNames(b: Uint8Array): Map<number, string> {
  const d = view(b);
  const count = d.getUint16(2);
  const strings = d.getUint16(4);
  const best = new Map<number, { rank: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > b.length) break;
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((k) => d.getUint16(r + k)) as [number, number, number, number, number, number];
    const start = strings + offset;
    if (start + length > b.length) continue;
    const raw = b.subarray(start, start + length);
    let rank: number;
    let value: string;
    if (platform === 3 || platform === 0) {
      rank = platform === 3 && language === 0x409 ? 0 : 1;
      value = utf16be(raw);
    } else if (platform === 1 && language === 0) {
      rank = 2;
      value = String.fromCharCode(...raw);
    } else continue;
    const current = best.get(id);
    if (value.trim() && (!current || rank < current.rank)) best.set(id, { rank, value: value.trim() });
  }
  return new Map([...best].map(([id, { value }]) => [id, value]));
}

function utf16be(raw: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < raw.length; i += 2) out += String.fromCharCode((raw[i]! << 8) | raw[i + 1]!);
  return out;
}

/** True for .ttc/.otc collections. */
export function isCollection(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && tag(bytes, 0) === "ttcf";
}

/** One face from a collection as a standalone font file. Single-face files come back unchanged. */
export function extractFace(bytes: Uint8Array, index = 0): Uint8Array {
  if (!isCollection(bytes)) return bytes;
  const d = view(bytes);
  const count = d.getUint32(8);
  if (index >= count) throw new Error(`The font collection has ${count} faces; face ${index} doesn't exist`);
  const at = d.getUint32(12 + index * 4);
  const n = d.getUint16(at + 4);
  const records = Array.from({ length: n }, (_, i) => ({
    record: at + 12 + i * 16,
    offset: d.getUint32(at + 12 + i * 16 + 8),
    length: d.getUint32(at + 12 + i * 16 + 12),
  }));
  const headerSize = 12 + n * 16;
  const size = records.reduce((sum, r) => sum + ((r.length + 3) & ~3), headerSize);
  const out = new Uint8Array(size);
  const o = view(out);
  out.set(bytes.subarray(at, at + headerSize));
  let cursor = headerSize;
  records.forEach((r, i) => {
    out.set(bytes.subarray(r.offset, r.offset + r.length), cursor);
    o.setUint32(12 + i * 16 + 8, cursor);
    cursor += (r.length + 3) & ~3;
  });
  return out;
}

/** Where fonts are installed on this computer, most specific first. */
export function systemFontDirs(): string[] {
  const home = homedir();
  if (process.platform === "darwin") return [join(home, "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(local, "Microsoft", "Windows", "Fonts"), join(process.env.WINDIR ?? "C:\\Windows", "Fonts")];
  }
  return [join(home, ".local/share/fonts"), join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

/** Every font face in the folders, searched a few levels deep. Unreadable files are skipped. */
export async function scanFonts(dirs: string[], depth = 4): Promise<InstalledFont[]> {
  const found: InstalledFont[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0) await walk(path, left - 1);
      } else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !seen.has(path)) {
        seen.add(path);
        try {
          const file = await open(path, "r");
          try {
            const read: Read = async (offset, length) => {
              const buf = new Uint8Array(length);
              const { bytesRead } = await file.read(buf, 0, length, offset);
              return buf.subarray(0, bytesRead);
            };
            for (const face of await readFontFaces(read)) found.push({ ...face, path });
          } finally {
            await file.close();
          }
        } catch {
          // not a font we can read
        }
      }
    }
  };
  for (const dir of dirs) await walk(dir, depth);
  return found;
}

/** A path for the asset: relative inside the Gesso folder, absolute elsewhere. */
export function fontUri(path: string, baseDir: string): string {
  const rel = relative(baseDir, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel) ? rel.split(sep).join("/") : path;
}
