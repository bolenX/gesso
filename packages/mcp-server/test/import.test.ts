import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { importAsset } from "../src/import.js";

it("imports a .cube colour lookup table as a lut asset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gesso-lut-"));
  const cube = `# made by hand\nTITLE "warm"\nLUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}\n`;
  await writeFile(join(dir, "warm.cube"), cube);
  expect(await importAsset({ id: "warm", source: "warm.cube" }, dir)).toMatchObject({ uri: "warm.cube", kind: "lut" });
  // Pasted data is kept in the Gesso folder with a .cube extension.
  expect(await importAsset({ id: "pasted", data: Buffer.from(cube).toString("base64") }, dir)).toMatchObject({ uri: "assets/pasted.cube", kind: "lut" });
  await writeFile(join(dir, "flat.cube"), "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
  await expect(importAsset({ id: "flat", source: "flat.cube" }, dir)).rejects.toThrow(/1D/);
});
