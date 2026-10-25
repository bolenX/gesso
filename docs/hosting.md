# Host Gesso

claude.ai and ChatGPT only connect to MCP servers on the public internet. A hosted Gesso is one you run on a server so those connectors can reach it. Start it with:

```sh
npx -y gesso-mcp --hosted
```

or with the Docker image in this repository.

## What hosting gives you

**A private workspace per user.** Each visitor makes a workspace at `/new` and gets a secret key. The key is part of two addresses:

- **Workspace page:** `/w/<key>`. It shows the connector URL, has an upload button, and lists every file in the workspace.
- **Connector URL:** `/mcp/<key>`. Add it to claude.ai or ChatGPT.

**Uploads.** Images, fonts, LUTs and PSDs uploaded on the workspace page land in `uploads/`. Then tell the agent the path, for example "use `uploads/photo.jpg`". Agents can also bring in images from a URL with `asset_import`.

**Download links.** When the agent exports, each file comes back with a link under `/files/<key>/…`. In hosts that show Gesso's result card, the download buttons work too.

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

Put it behind HTTPS: connectors refuse plain HTTP. Then open `https://gesso.example.com/new` to make your workspace.

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

## Connect an agent

Copy the connector URL from your workspace page, then:

- **claude.ai:** go to **Settings › Connectors › Add custom connector** and paste the URL.
- **ChatGPT:** turn on **Settings › Apps › Advanced settings › Developer mode**, then **Create app** with the URL. Developer mode is limited to some ChatGPT plans.

The hosted server speaks the same Streamable HTTP these connectors use. It's tested with the MCP SDK's HTTP client, but not yet against claude.ai and ChatGPT themselves, so please report anything that goes wrong.

## Security model

**The key is the only credential.** Anyone with a workspace's key can use it, so treat the connector URL like a password. There are no accounts and no OAuth yet.

**Abuse limits.** One address can create 20 workspaces an hour. Uploads and workspaces have size limits, and so do renders. For a public service, also put the server behind a proxy or CDN that rate-limits requests.

**What a workspace can't do:**
- Tools can't reach other workspaces, the server's files outside the system fonts, or private network addresses. Downloads follow redirects only to public addresses, and are limited to 64 MB.
- Document histories (`.gesso/`) aren't served over `/files`.

## Local HTTP

`gesso-mcp --http [port]` runs the plain HTTP server for clients on your own computer: one Gesso folder, no workspaces, and the same tools as stdio. It listens on 127.0.0.1 unless `HOST` is set. Don't expose it to the internet: it can read any file the user running it can. Use `--hosted` for that.
