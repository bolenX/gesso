import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset } from "@gesso/core";

/** Fetches an asset's bytes. Swappable so servers can add caches, sandboxes or object stores. */
export type AssetLoader = (asset: Asset) => Promise<Uint8Array>;

export type LoaderOptions = {
  /** Files the loader may read; others are refused. Hosted servers use it to keep each workspace to itself. */
  allow?: (path: string) => boolean;
  /** Replaces fetch for http(s) assets, for example with one that refuses private addresses. */
  download?: (url: string) => Promise<Uint8Array>;
};

/** Loads file:// URIs, http(s) URLs and plain paths (relative to baseDir). */
export function defaultAssetLoader(baseDir = process.cwd(), options: LoaderOptions = {}): AssetLoader {
  return async ({ uri }) => {
    if (/^https?:\/\//.test(uri)) {
      if (options.download) return options.download(uri);
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`Failed to fetch ${uri}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    let path: string;
    if (uri.startsWith("file://")) {
      const url = new URL(uri);
      // "file://assets/x.png" is treated as relative to baseDir, "file:///abs/x.png" as absolute.
      path = url.host ? resolve(baseDir, url.host + url.pathname) : fileURLToPath(url);
    } else {
      path = isAbsolute(uri) ? uri : resolve(baseDir, uri);
    }
    if (options.allow && !options.allow(path)) throw new Error(`Asset "${uri}" is outside the workspace`);
    return readFile(path);
  };
}
