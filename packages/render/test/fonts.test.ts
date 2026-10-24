import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFace, fontUri, isCollection, readFontFaces, scanFonts } from "../src/index.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const TTC = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";
const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.subarray(offset, offset + length);

describe.skipIf(!existsSync(FONT))("font names", () => {
  it("reads family, style, PostScript name and weight", async () => {
    expect(await readFontFaces(reader(readFileSync(FONT)))).toEqual([
      { family: "DejaVu Sans", style: "Bold", fullName: "DejaVu Sans Bold", postscriptName: "DejaVuSans-Bold", weight: 700, italic: false, face: 0 },
    ]);
  });

  it("finds fonts in a folder, with paths relative to the Gesso folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gesso-fonts-"));
    await copyFile(FONT, join(dir, "Brand.ttf"));
    const [found] = await scanFonts([dir]);
    expect(found).toMatchObject({ fullName: "DejaVu Sans Bold", path: join(dir, "Brand.ttf") });
    expect(fontUri(found!.path, dir)).toBe("Brand.ttf");
    expect(fontUri("/elsewhere/A.ttf", dir)).toBe("/elsewhere/A.ttf");
  });
});

describe.skipIf(!existsSync(TTC))("font collections", () => {
  it("pulls one face out as a standalone font", async () => {
    const bytes = readFileSync(TTC);
    expect(isCollection(bytes)).toBe(true);
    const faces = await readFontFaces(reader(bytes));
    expect(faces.length).toBeGreaterThan(1);
    const second = extractFace(bytes, 1);
    expect(isCollection(second)).toBe(false);
    expect((await readFontFaces(reader(second)))[0]!.fullName).toBe(faces[1]!.fullName);
    expect(() => extractFace(bytes, 99)).toThrow(/doesn't exist/);
  });
});
