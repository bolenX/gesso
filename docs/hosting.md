# Host Gesso

claude.ai and ChatGPT only connect to MCP servers on the public internet. A hosted Gesso is one you run on a server so those connectors can reach it. Start it with:

```sh
npx -y gesso-mcp --hosted
```

or with the Docker image in this repository.

## What hosting gives you

**One connector URL, with sign-in.** Everyone adds the same address, `https://<your server>/mcp`. The first time, claude.ai or ChatGPT opens Gesso's consent page. The person approves, and gets a private workspace. Under the hood this is OAuth 2.1, as the MCP spec describes:
- The app finds the sign-in server from `/.well-known/oauth-protected-resource`.
- It registers itself, by Dynamic Client Registration or a Client ID Metadata Document.
- It signs in with PKCE, and gets a one-hour access token and a refresh token that rotates on every use.

People can connect without an account, which gives them a new workspace each time, or reconnect to a workspace by pasting its key. If you set up GitHub or Google sign-in, signing in with an account gives the same workspace every time.

**Uploads.** Gesso's instructions to the agent include a private upload page for the workspace, which works for a day. Images, fonts, LUTs and PSDs uploaded there land in `uploads/`. Then the agent uses the path, for example `uploads/photo.jpg`. Agents can also bring in images from a URL, or as base64 data, with `asset_import`.

**Download links.** When the agent exports, each file comes back with a signed link under `/dl/…`. A link opens that one file, for as long as the workspace is kept, and doesn't reveal the workspace. In hosts that show Gesso's result card, the download buttons work too.

**Private key URLs (optional).** For clients that can't sign in, `/new` makes a workspace with a secret key in two addresses:
- `/mcp/<key>`, the connector URL
- `/w/<key>`, a page to upload and list files

Turn this off with `GESSO_KEY_URLS=0`.

**Isolation.**
- Tools can only read and write inside their own workspace.
- Downloads (`asset_import` URLs, image URLs in documents) only reach public internet addresses, never the server's own network.
- Renders are limited in size.
- Workspaces nobody has used for 7 days are deleted.

## Run it with Docker

```sh
docker build -t gesso .
docker run -p 8080:8080 -v gesso-data:/data -e GESSO_PUBLIC_URL=https://gesso.example.com gesso
```

Put it behind HTTPS: connectors refuse plain HTTP, and so does OAuth. Then add `https://gesso.example.com/mcp` as a connector.

**The secret.** Gesso signs tokens and links with a secret it keeps in `/data/oauth/secret`, made on first start. You can set it yourself with `GESSO_SECRET`, for example from `openssl rand -hex 32`. Keep it the same across restarts and deploys. Changing it signs everyone out and breaks old download links. People who signed in with an account would also get new, empty workspaces.

**Workspaces.** They live in `/data`. Keep it on a persistent volume, or they disappear when the container restarts. Run one instance per volume: workspaces are plain folders on that disk, so several instances only work if they share it.

**Fonts.** The image includes DejaVu, Liberation and Noto fonts. Users can upload more on their workspace page.

**Memory.** Allow 2 GB of memory. Large photos with stacked filters use a lot of it.

### Example: Fly.io

```toml
# fly.toml
app = "my-gesso"

[env]
  GESSO_PUBLIC_URL = "https://my-gesso.fly.dev"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true

[[mounts]]
  source = "gesso_data"
  destination = "/data"

[[vm]]
  memory = "2gb"
```

```sh
fly launch --no-deploy
fly volumes create gesso_data --size 10
fly deploy
```

Any host that runs a Docker image with a persistent disk works the same way, such as Render, Railway or a VPS with Caddy for HTTPS. Check your provider's docs for the exact steps.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3333` (`8080` in Docker) | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `GESSO_WORKDIR` | current folder (`/data` in Docker) | Folder that holds every workspace (in `workspaces/`) |
| `GESSO_PUBLIC_URL` | from the request's `Host` and `X-Forwarded-*` headers | The server's public address, used in connector URLs and download links |
| `GESSO_WORKSPACE_DAYS` | `7` | Delete workspaces idle for this many days |
| `GESSO_WORKSPACE_MB` | `2048` | Most a workspace may hold |
| `GESSO_UPLOAD_MB` | `100` | Largest single upload |
| `GESSO_MAX_MEGAPIXELS` | `40` | Largest artboard a render or export may produce, at its scale |
| `GESSO_REQUEST_MB` | `32` | Largest MCP request, which includes images passed as base64 data |
| `GESSO_SECRET` | made on first start, in `/data/oauth/secret` | Signs tokens and links: 64 hex characters, or any string of 32 or more |
| `GESSO_GITHUB_CLIENT_ID`, `GESSO_GITHUB_CLIENT_SECRET` | none | Offers **Continue with GitHub**. Create an OAuth app with the callback `https://<your server>/oauth/github/callback` |
| `GESSO_GOOGLE_CLIENT_ID`, `GESSO_GOOGLE_CLIENT_SECRET` | none | Offers **Continue with Google**. Create a web OAuth client with the redirect URI `https://<your server>/oauth/google/callback` |
| `GESSO_ANONYMOUS` | on | Set to `0` so people must sign in with GitHub or Google |
| `GESSO_KEY_URLS` | on | Set to `0` to turn off `/new` and the private key URLs |
| `GESSO_BLOCKLIST` | none | A file of banned workspace keys and accounts (`github:<id>`, `google:<sub>`), one per line. It's reread within a minute of changing |
| `GESSO_PROXY_HOPS` | `1` | How many proxies in front of Gesso add to `X-Forwarded-For`. The address the nearest one saw is used for rate limits; `0` uses the connection's own address |
| `GESSO_MAX_REQUESTS` | `64` | Requests the whole server works on at once before answering "busy" |
| `GESSO_LOG` | on | One JSON line per MCP request: time, method, tool name, status, duration and a short one-way hash of the workspace. Never content or keys. Set to `0` to turn it off |

## Connect an agent

Use `https://<your server>/mcp`:

- **claude.ai:** go to **Settings › Connectors › Add custom connector** and paste the URL, then approve on Gesso's page.
- **ChatGPT:** turn on **Settings › Apps › Advanced settings › Developer mode**, then **Create app** with the URL and OAuth. Developer mode is limited to some ChatGPT plans.

The sign-in is tested end to end with the MCP SDK's own OAuth client: discovery, registration, PKCE, refresh rotation and revocation. It hasn't been tried against claude.ai and ChatGPT themselves yet, so please report anything that goes wrong.

## Security model

**Tokens.**
- Access tokens last an hour. Refresh tokens last 60 days and change every time they're used.
- If an old refresh token comes back more than a minute after it was used, someone may have copied it, so every token from that sign-in stops working. Within that minute, it's treated as an app retrying.
- The consent page can't be framed. An approval only counts from the browser that opened the page, through an `HttpOnly`, `SameSite=Lax` cookie, so another site can't approve in the background.
- Tokens and links are sealed with the server's secret (AES-256-GCM). The server stores nothing about them except revocations.

**Workspace keys.**
- A workspace's key unlocks it, and with key URLs on, the key is part of the connector URL. Treat that URL like a password.
- Signed-in workspaces never show their key: downloads and uploads use signed links.

**Abuse limits.**
- **New workspaces:** one address can create 20 an hour, counted from the person's browser on the consent page.
- **Requests:** each workspace gets 120 at once, refilled at 2 a second, with at most 4 running together. The whole server works on at most 64 at a time.
- **Sizes:** uploads, workspaces and renders are size-limited.
- **Bans:** `GESSO_BLOCKLIST` turns off a workspace or an account.
- **Edge:** for a public service, also put the server behind a proxy or CDN that rate-limits requests.

**What a workspace can't do:**
- Tools can't reach other workspaces, the server's files outside the system fonts, or private network addresses. Downloads follow redirects only to public addresses, and are limited to 64 MB.
- Document histories (`.gesso/`) aren't served over `/files`.

## Local HTTP

`gesso-mcp --http [port]` runs the plain HTTP server for clients on your own computer: one Gesso folder, no workspaces, and the same tools as stdio. It listens on 127.0.0.1 unless `HOST` is set. Don't expose it to the internet: it can read any file the user running it can. Use `--hosted` for that.
