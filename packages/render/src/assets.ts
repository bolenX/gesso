import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset } from "@gesso/core";

/** Fetches an asset's bytes. Swappable so servers can add caches, sandboxes or object stores. */
export type AssetLoader = (asset: Asset) => Promise<Uint8Array>;

/** Loads file:// URIs, http(s) URLs and plain paths (relative to baseDir). */
export function defaultAssetLoader(baseDir = process.cwd()): AssetLoader {
  return async ({ uri }) => {
    if (/^https?:\/\//.test(uri)) {
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`Failed to fetch ${uri}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    if (uri.startsWith("file://")) {
      const url = new URL(uri);
      // "file://assets/x.png" is treated as relative to baseDir, "file:///abs/x.png" as absolute.
      const path = url.host ? resolve(baseDir, url.host + url.pathname) : fileURLToPath(url);
      return readFile(path);
    }
    return readFile(isAbsolute(uri) ? uri : resolve(baseDir, uri));
  };
}
