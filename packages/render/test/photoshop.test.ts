import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePsd } from "@gesso/psd";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { defaultAssetLoader, difference, encode, renderArtboard, type Rendered } from "../src/index.js";
import { CASES, groupDoc, H, W, type Group } from "./photoshop-cases.js";

// Gesso against Photoshop. reference/README.md explains the loop:
//   REFERENCE_KIT=1 pnpm test photoshop    writes reference/kit/: PSDs to open in Photoshop, and what to do
//   (export each artboard from Photoshop as a PNG into reference/photoshop/)
//   pnpm test photoshop                    compares Gesso's renders with them and writes reference/report/
// reference/scores.json holds each case's accepted score; a case that gets worse fails. After an
// improvement, UPDATE_REFERENCE=1 pnpm test photoshop records the new scores.

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../reference");
const loader = defaultAssetLoader(root);
const GROUPS: Group[] = ["adjustments", "blend-modes", "layer-styles", "filters"];

/** The test chart: colour patches, a grey ramp, gradients, hue sweeps, skin-like tones, fine lines and edges. */
function chartSvg(): string {
  const checker = ["#735244", "#C29682", "#627A9D", "#576C43", "#8580B1", "#67BDAA", "#D67E2C", "#505BA6", "#C15A63", "#5E3C6C", "#9DBC40", "#E0A32E", "#383D96", "#469449", "#AF363C", "#E7C71F", "#BB5695", "#0885A1", "#F3F3F2", "#C8C8C8", "#A0A0A0", "#7A7A79", "#555555", "#343434"];
  const patches = checker.map((c, i) => `<rect x="${(i % 12) * (W / 12)}" y="${Math.floor(i / 12) * 40}" width="${W / 12}" height="40" fill="${c}"/>`).join("");
  const ramp = Array.from({ length: 32 }, (_, i) => `<rect x="${i * 16}" y="80" width="16" height="32" fill="rgb(${Math.round((i * 255) / 31)},${Math.round((i * 255) / 31)},${Math.round((i * 255) / 31)})"/>`).join("");
  const hues = Array.from({ length: 7 }, (_, i) => `<stop offset="${i / 6}" stop-color="hsl(${i * 60},100%,50%)"/>`).join("");
  const soft = Array.from({ length: 7 }, (_, i) => `<stop offset="${i / 6}" stop-color="hsl(${i * 60},35%,60%)"/>`).join("");
  const lines = Array.from({ length: 12 }, (_, i) => `<rect x="${384 + i * 10}" y="208" width="${1 + (i % 3)}" height="80" fill="#111"/>`).join("");
  const checks = Array.from({ length: 64 }, (_, i) => ((i % 8) + Math.floor(i / 8)) % 2 ? `<rect x="${384 + (i % 8) * 16}" y="${288 + Math.floor(i / 8) * 12}" width="16" height="12" fill="#111"/>` : "").join("");
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="grey"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
<linearGradient id="hue">${hues}</linearGradient><linearGradient id="soft">${soft}</linearGradient>
<radialGradient id="skin" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#F2CDB5"/><stop offset="0.6" stop-color="#C98E6E"/><stop offset="1" stop-color="#6B3F2C"/></radialGradient>
<radialGradient id="sky" cx="0.5" cy="0" r="1"><stop offset="0" stop-color="#E6F0FA"/><stop offset="1" stop-color="#2E62A8"/></radialGradient>
<radialGradient id="leaf" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#9CCB5A"/><stop offset="1" stop-color="#1E4A1C"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="#808080"/>
${patches}${ramp}
<rect y="112" width="${W}" height="32" fill="url(#grey)"/>
<rect y="144" width="${W}" height="32" fill="url(#hue)"/>
<rect y="176" width="${W}" height="32" fill="url(#soft)"/>
<rect y="208" width="128" height="176" fill="url(#sky)"/>
<ellipse cx="96" cy="300" rx="70" ry="60" fill="url(#leaf)"/>
<rect x="128" y="208" width="128" height="176" fill="#2B2420"/>
<ellipse cx="192" cy="296" rx="52" ry="68" fill="url(#skin)"/>
<rect x="256" y="208" width="128" height="176" fill="#F4EFE6"/>
<circle cx="320" cy="260" r="34" fill="#E8471A"/><rect x="284" y="310" width="72" height="48" fill="#2440E6"/>
<path d="M 268 370 L 372 220" stroke="#111" stroke-width="2"/>
${lines}${checks}
</svg>`;
}

/** The overlay for blend modes: hue across, brightness down, on the top part; a grey ramp across the bottom. */
function overlaySvg(): string {
  const hues = Array.from({ length: 7 }, (_, i) => `<stop offset="${i / 6}" stop-color="hsl(${i * 60},100%,50%)"/>`).join("");
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="hue">${hues}</linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.8"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient>
<linearGradient id="grey"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
<rect width="${W}" height="256" fill="url(#hue)"/><rect width="${W}" height="256" fill="url(#fade)"/>
<rect y="256" width="${W}" height="128" fill="url(#grey)"/>
</svg>`;
}

/** The chart and overlay are committed, so every machine compares against the same pixels. */
async function ensureSources() {
  for (const [name, svg] of [["chart.png", chartSvg()], ["overlay.png", overlaySvg()]] as const) {
    const path = join(root, name);
    if (!existsSync(path)) await writeFile(path, await sharp(Buffer.from(svg)).png().toBuffer());
  }
}

/** A Photoshop export as RGBA, flattened on white like an artboard. */
async function load(path: string): Promise<Rendered> {
  const { data, info } = await sharp(path).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { artboard: "", width: info.width, height: info.height, pixels: new Uint8Array(data), warnings: [] };
}

/** Photoshop's Export As names files after artboards; Artboards to Files adds the document name. */
async function references(): Promise<Map<string, string>> {
  const dir = join(root, "photoshop");
  const found = new Map<string, string>();
  for (const name of existsSync(dir) ? await readdir(dir) : []) {
    if (!/\.png$/i.test(name)) continue;
    const base = name.replace(/\.png$/i, "").toLowerCase().replace(/\s+/g, "-");
    const id = CASES.find((c) => base === c.id || base.endsWith(`_${c.id}`) || base.endsWith(`-${c.id}`))?.id;
    if (id) found.set(id, join(dir, name));
  }
  return found;
}

type Score = { meanDeltaE: number; p95DeltaE: number; over5: number };

/** CIE76 ΔE between two renders, per pixel: mean, 95th percentile and the share over 5 (a visible difference). */
function score(gesso: Rendered, photoshop: Rendered): Score {
  const e: number[] = [];
  const [a, b] = [new Float64Array(3), new Float64Array(3)];
  const lab = (p: Uint8Array, i: number, out: Float64Array) => {
    const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const [r, g, bl] = [lin(p[i]!), lin(p[i + 1]!), lin(p[i + 2]!)];
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const [x, y, z] = [f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047), f(0.2126 * r + 0.7152 * g + 0.0722 * bl), f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883)];
    out[0] = 116 * y - 16;
    out[1] = 500 * (x - y);
    out[2] = 200 * (y - z);
  };
  for (let i = 0; i < gesso.width * gesso.height * 4; i += 4) {
    lab(gesso.pixels, i, a);
    lab(photoshop.pixels, i, b);
    e.push(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
  }
  e.sort((x, y) => x - y);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { meanDeltaE: r(e.reduce((s, v) => s + v, 0) / e.length), p95DeltaE: r(e[Math.floor(e.length * 0.95)]!), over5: r((100 * e.filter((v) => v > 5).length) / e.length) };
}

describe("Photoshop reference kit", () => {
  it.runIf(process.env.REFERENCE_KIT)("writes the PSDs and instructions", { timeout: 300_000 }, async () => {
    await ensureSources();
    const kit = join(root, "kit");
    await mkdir(kit, { recursive: true });
    for (const group of GROUPS) {
      const { bytes } = await writePsd(groupDoc(group, true), { loader });
      await writeFile(join(kit, `${group}.psd`), bytes);
    }
    const steps = CASES.filter((c) => c.photoshop).map((c) => `| ${c.id} | ${c.photoshop} |`);
    await writeFile(
      join(kit, "filters.md"),
      `# Filters to apply in Photoshop\n\nIn filters.psd, select the Chart layer in each artboard and apply:\n\n| Artboard | Filter and settings |\n| --- | --- |\n${steps.join("\n")}\n`,
    );
  });
});

describe("Gesso against Photoshop", async () => {
  await ensureSources();
  const found = await references();
  const scoresPath = join(root, "scores.json");
  const accepted: Record<string, Score> = existsSync(scoresPath) ? JSON.parse(await readFile(scoresPath, "utf8")) : {};
  const results: Record<string, Score> = {};

  it.runIf(found.size > 0)("matches the Photoshop exports at least as well as before", { timeout: 600_000 }, async () => {
    const report = join(root, "report");
    await mkdir(report, { recursive: true });
    const rows: string[] = [];
    const worse: string[] = [];
    for (const group of GROUPS) {
      const doc = groupDoc(group, false);
      for (const artboard of doc.artboards) {
        const path = found.get(artboard.id);
        if (!path) continue;
        const photoshop = await load(path);
        if (photoshop.width !== W || photoshop.height !== H) {
          rows.push(`| ${artboard.id} | — | — | — | Photoshop export is ${photoshop.width}×${photoshop.height}, expected ${W}×${H} |`);
          continue;
        }
        const gesso = await renderArtboard(doc, artboard.id, { loader });
        const s = score(gesso, photoshop);
        results[artboard.id] = s;
        const { image } = difference(gesso, photoshop, 8);
        await writeFile(join(report, `${artboard.id}.png`), await sharp({ create: { width: W * 3 + 16, height: H, channels: 4, background: "#808080" } })
          .composite([
            { input: await encode(gesso, "png"), left: 0, top: 0 },
            { input: await encode(photoshop, "png"), left: W + 8, top: 0 },
            { input: await encode(image, "png"), left: 2 * W + 16, top: 0 },
          ])
          .png()
          .toBuffer());
        const before = accepted[artboard.id];
        const regressed = before && s.meanDeltaE > before.meanDeltaE + 0.25;
        if (regressed) worse.push(`${artboard.id}: mean ΔE ${before.meanDeltaE} → ${s.meanDeltaE}`);
        rows.push(`| ${artboard.id} | ${s.meanDeltaE} | ${s.p95DeltaE} | ${s.over5}% | ${regressed ? "worse" : before ? (s.meanDeltaE < before.meanDeltaE - 0.25 ? "better" : "same") : "new"} |`);
      }
    }
    rows.sort((a, b) => Number(b.split("|")[2]) - Number(a.split("|")[2]));
    await writeFile(
      join(report, "README.md"),
      `# Gesso against Photoshop\n\nCIE76 ΔE per pixel (under 2 is hard to see, over 5 is clearly different). Worst first. Each image in this folder shows Gesso, Photoshop and their difference (×8).\n\n| Case | Mean ΔE | 95th percentile | Pixels over 5 | Change |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
    );
    if (process.env.UPDATE_REFERENCE) await writeFile(scoresPath, `${JSON.stringify({ ...accepted, ...results }, null, 2)}\n`);
    else expect(worse, `Cases that got worse (see reference/report/):\n${worse.join("\n")}`).toEqual([]);
  });
});
