import type { ServerResponse } from "node:http";

// The few HTML pages a hosted Gesso serves: workspaces, uploads and sign-in.

export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sends a page that other sites can't frame, so a consent button can't be clicked through a disguise. */
export const html = (res: ServerResponse, status: number, body: string) =>
  void res
    .writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "cache-control": "no-store",
    })
    .end(body);

export const page = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Gesso</title><link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#faf9f7;--fg:#1c1b19;--muted:#6b6862;--line:#e4e1db;--card:#fff;--accent:#1c1b19;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f1efe9;--muted:#a19d95;--line:#33312d;--card:#1f1e1c;--accent:#f1efe9;--accent-fg:#161514}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
p{color:var(--muted);margin:8px 0}a{color:inherit}code,.url{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.url{display:flex;gap:8px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-wrap:anywhere}
.url span{flex:1}.button,button{display:inline-block;background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:10px 16px;font:inherit;text-decoration:none;cursor:pointer}
.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);padding:6px 10px}
.stack{display:flex;flex-direction:column;gap:8px;margin:20px 0;max-width:360px}.stack button{width:100%}
input[type=text]{width:100%;font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
details{margin:16px 0}summary{cursor:pointer;color:var(--muted)}
ul{list-style:none;padding:0;margin:0;border:1px solid var(--line);border-radius:8px;background:var(--card)}li{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--line)}li:first-child{border-top:0}
li a{overflow-wrap:anywhere}li small{color:var(--muted);white-space:nowrap}.warn{border-left:3px solid #c98a00;padding-left:12px}.small{font-size:14px}
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
