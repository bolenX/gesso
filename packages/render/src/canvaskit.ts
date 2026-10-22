import { createRequire } from "node:module";
import type { CanvasKit } from "canvaskit-wasm";

const require = createRequire(import.meta.url);
let instance: Promise<CanvasKit> | undefined;

/** Loads the CanvasKit (Skia Wasm) module once per process. */
export function loadCanvasKit(): Promise<CanvasKit> {
  instance ??= (require("canvaskit-wasm") as (opts?: object) => Promise<CanvasKit>)();
  return instance;
}
