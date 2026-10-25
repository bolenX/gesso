import { spawn } from "node:child_process";

// `gesso-mcp --tunnel`: Gesso on the user's own computer, reachable from claude.ai and ChatGPT through a free
// Cloudflare quick tunnel. Cloudflare's `cloudflared` opens it without an account and gives a random
// https://….trycloudflare.com address; nothing runs on a server anyone pays for.

/** The address a quick tunnel prints (not its API host). */
const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export const INSTALL_CLOUDFLARED = `--tunnel uses Cloudflare's free cloudflared to reach this computer from claude.ai and ChatGPT. Install it, then run Gesso again:
  macOS:    brew install cloudflared
  Windows:  winget install --id Cloudflare.cloudflared
  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
Or set GESSO_CLOUDFLARED to where cloudflared is.`;

export type Tunnel = { url: string; stop: () => void };

/** cloudflared's line once Cloudflare's edge can reach this computer. */
const CONNECTED = /Registered tunnel connection/;

/**
 * Opens a quick tunnel to a local port and resolves with its public address, once Cloudflare is actually
 * connected to this computer (the address comes first, and is useless if the connection never follows).
 */
export function startTunnel(port: number, options: { binary?: string; onClose?: (why: string) => void; timeoutMs?: number; protocol?: string } = {}): Promise<Tunnel> {
  const binary = options.binary ?? process.env.GESSO_CLOUDFLARED ?? "cloudflared";
  const protocol = options.protocol ?? process.env.GESSO_TUNNEL_PROTOCOL;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["tunnel", "--no-autoupdate", ...(protocol ? ["--protocol", protocol] : []), "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let settled = false;
    let open = false;
    const timer = setTimeout(() => {
      const url = QUICK_URL.exec(log)?.[0];
      fail(
        new Error(
          url
            ? `Cloudflare gave this computer the address ${url}, but couldn't connect to it. Tunnels need outgoing connections on port 7844 (UDP, or TCP with GESSO_TUNNEL_PROTOCOL=http2), which a firewall, VPN or office network may block.`
            : `Cloudflare didn't open a tunnel within a minute. Its last words:\n${log.slice(-1500)}`,
        ),
      );
    }, options.timeoutMs ?? 60_000);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(err);
    };
    const read = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-20_000);
      const found = QUICK_URL.exec(log);
      if (found && CONNECTED.test(log) && !settled) {
        settled = true;
        open = true;
        clearTimeout(timer);
        resolve({ url: found[0], stop: () => child.kill() });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (err: NodeJS.ErrnoException) => fail(err.code === "ENOENT" ? new Error(INSTALL_CLOUDFLARED) : err));
    child.on("exit", (code, signal) => {
      if (!settled) return fail(new Error(`cloudflared stopped before the tunnel opened (${signal ?? `exit ${code}`}):\n${log.slice(-1500)}`));
      if (open) options.onClose?.(signal ?? `exit ${code}`);
    });
  });
}
