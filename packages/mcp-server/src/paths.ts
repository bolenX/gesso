import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";

// Where paths resolve, and the rules a hosted Gesso adds: everything stays inside the workspace,
// and downloads only reach public addresses.

/** Resolves a path given to a tool. Confined (hosted), it must stay inside baseDir: no absolute paths, ~ or "..". */
export function resolvePath(baseDir: string, path: string, confined = false): string {
  if (!confined) return resolve(baseDir, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  const full = resolve(baseDir, path);
  if (!inside(baseDir, full)) throw new Error(`"${path}" is outside your workspace. Use a path relative to it, like "uploads/photo.jpg" or "out".`);
  return full;
}

/** Whether a path is the folder itself or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Largest download a hosted Gesso accepts. */
export const MAX_DOWNLOAD = 64 * 1024 * 1024;

/**
 * Fetches a URL's bytes. Confined, every hop (redirects are followed by hand) must be http(s) on a public
 * address, so a hosted server can't be pointed at its own network, and the body is capped at MAX_DOWNLOAD.
 */
export async function download(url: string, confined = false): Promise<{ bytes: Uint8Array; type: string | null; url: string }> {
  if (!confined) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't download ${url}: HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type"), url: res.url || url };
  }
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(current);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`Only http and https downloads are allowed, not ${target.protocol}`);
    await assertPublic(target.hostname);
    const res = await fetch(target, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, target).href;
      continue;
    }
    if (!res.ok) throw new Error(`Couldn't download ${url}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new Error(`${url} is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD) throw new Error(`${url} is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB`);
        chunks.push(chunk);
      }
    }
    return { bytes: Buffer.concat(chunks), type: res.headers.get("content-type"), url: current };
  }
  throw new Error(`${url} redirects too many times`);
}

/** Throws unless every address the host name resolves to is public. */
async function assertPublic(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivate)) throw new Error(`${hostname} is a private or local address; a hosted Gesso only downloads from the public internet`);
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges, in IPv4 and IPv6. */
export function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivate(mapped[1]!);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}
