# Running mcp.gesso.run

This folder runs hosted Gesso at `https://mcp.gesso.run`, the server claude.ai and ChatGPT connect to. [docs/hosting.md](../docs/hosting.md) explains what hosted Gesso does and lists every setting. This page covers the official server: first-time setup, deploys, and day-to-day operations.

Two ways to run it:
- **Fly.io** (`fly.toml`) is the default, and GitHub Actions can deploy to it.
- **Any Linux server** with Docker (`compose.yaml` and `Caddyfile`), for example a small VPS.

## Sizing and cost

| | Fly.io (as configured) | VPS |
| --- | --- | --- |
| Machine | 2 shared CPUs, 4 GB, always on | 2–4 vCPUs, 4–8 GB |
| Disk | 20 GB volume for workspaces | the server's disk |
| Rough cost | about $25–35 a month | about €5–15 a month |

Check current prices with the provider: these change.

What to watch as use grows:
- **CPU:** each render takes a core while it runs.
- **Memory:** large photos with stacked filters can use 1 GB or more per worker.
- **Disk:** workspaces stay for 7 idle days, and each can hold up to 2 GB.

The first limit you'll hit is CPU. Scale up the machine and raise `GESSO_WORKERS` to match its cores, up to about one worker per core.

## First-time setup from GitHub (nothing to install)

1. **Create a Fly.io account** at fly.io and add a payment method.
2. **Create a token.** In the Fly.io dashboard, go to **Account › Access Tokens** and create one.
3. **Save the token in GitHub.** In this repository, go to **Settings › Secrets and variables › Actions › New repository secret**, name it `FLY_API_TOKEN`, and paste the token there. Never paste it anywhere else, such as a chat or an issue.
4. **Run the setup.** Go to **Actions › Deploy mcp.gesso.run › Run workflow**, tick **First-time setup**, pick a region, and run it. It:
   - creates the app `gesso-mcp`
   - creates its 20 GB volume
   - generates the signing secret, which is stored in Fly.io and never printed
   - deploys
   - requests the certificate for `mcp.gesso.run`

   If the name `gesso-mcp` is taken on Fly.io, set a repository variable `FLY_APP` to another name first, under the **Variables** tab next to Secrets.
5. **Add the DNS record.** The run's summary shows it: a **CNAME** named `mcp` pointing at `gesso-mcp.fly.dev`, added where `gesso.run`'s DNS is managed. On Cloudflare, set it to **DNS only**. Fly.io issues the certificate within minutes.
6. **Check it:** open `https://mcp.gesso.run/health`, then add `https://mcp.gesso.run/mcp` as a custom connector in claude.ai.

After that, every new release deploys itself. Afterwards you can swap the account token for one limited to this app (`fly tokens create deploy --app gesso-mcp`).

## First-time setup on Fly.io from your computer

You need a Fly.io account and `flyctl`, and you run these from the repository root.

1. **Create the app and its volume:**
   ```sh
   fly apps create gesso-mcp
   fly volumes create gesso_data --app gesso-mcp --region iad --size 20
   ```
   Pick the region closest to most users. Change `primary_region` in `fly.toml` to match.
2. **Set the secret.** It signs sign-in tokens and links. Make it once and keep it safe; changing it later signs everyone out.
   ```sh
   fly secrets set --app gesso-mcp GESSO_SECRET=$(openssl rand -hex 32)
   ```
3. **Deploy:**
   ```sh
   fly deploy --config deploy/fly.toml --dockerfile Dockerfile
   ```
4. **Point the domain at it.** Run `fly certs add mcp.gesso.run --app gesso-mcp`. Then add the DNS records it prints to `gesso.run`'s DNS: a CNAME for `mcp`, or A and AAAA records. Wait for `fly certs show mcp.gesso.run` to say the certificate is issued.
5. **Check it works:**
   ```sh
   curl https://mcp.gesso.run/health
   curl https://mcp.gesso.run/.well-known/oauth-protected-resource
   ```
   Then add `https://mcp.gesso.run/mcp` as a custom connector in claude.ai, approve on Gesso's page, and ask for a poster.

### Deploy from GitHub

Create a deploy token with `fly tokens create deploy --app gesso-mcp`, and save it as the `FLY_API_TOKEN` repository secret under Settings › Secrets and variables › Actions. After that:
- every new release deploys automatically, after the npm package and the GitHub release
- **Actions › Deploy mcp.gesso.run › Run workflow** deploys by hand

The workflow uses `superfly/flyctl-actions/setup-flyctl@master`, as Fly's docs recommend. To lock it down, pin it to a commit SHA.

## Sign in with GitHub or Google (optional)

Without these, people connect without an account and get a new workspace each time. They can also paste a workspace key to reconnect. With an account, they get the same workspace every time they connect.

**GitHub:**
1. Go to Settings › Developer settings › OAuth Apps › New OAuth App.
2. Use the homepage `https://gesso.run` and the callback URL `https://mcp.gesso.run/oauth/github/callback`.
3. Save the credentials:
   ```sh
   fly secrets set --app gesso-mcp GESSO_GITHUB_CLIENT_ID=… GESSO_GITHUB_CLIENT_SECRET=…
   ```

**Google:**
1. In Google Cloud Console, go to APIs & Services › Credentials › Create credentials › OAuth client ID.
2. Choose **Web application**, with the authorized redirect URI `https://mcp.gesso.run/oauth/google/callback`.
3. Set up the consent screen with the `openid` scope only. Use the app name Gesso, the homepage `https://gesso.run`, and the privacy policy and terms URLs.
4. Save the credentials:
   ```sh
   fly secrets set --app gesso-mcp GESSO_GOOGLE_CLIENT_ID=… GESSO_GOOGLE_CLIENT_SECRET=…
   ```

Gesso asks GitHub and Google for nothing but the account's id. It doesn't ask for email, repositories or files. It turns the id into a workspace key with the secret, and doesn't store the id.

To require an account, set `GESSO_ANONYMOUS=0`. That cuts down on throwaway workspaces, but adds a step for everyone.

## Running it

**Logs.**
- `fly logs --app gesso-mcp` shows one JSON line per MCP request: time, method, tool, status, duration and a short hash of the workspace.
- Content and keys are never logged.
- Worker restarts show up as `Gesso worker N stopped`.

**Ban a workspace or an account.**
- Add its key, or `github:<id>` or `google:<sub>`, as a line in `/data/blocklist.txt`. Lines starting with `#` are comments.
- Gesso rereads the file within a minute:
  ```sh
  fly ssh console --app gesso-mcp -C "sh -c 'echo github:12345 >> /data/blocklist.txt'"
  ```

**Find a workspace from a log line.** The log's `ws` is the first 10 hex characters of `sha256(key)`. On the server:
```sh
for k in /data/workspaces/*; do echo "$(printf %s "$(basename $k)" | sha256sum | cut -c1-10) $k"; done | grep <ws>
```

**Delete everything for someone who asks.** Delete their workspace folder under `/data/workspaces/`. Their tokens stop finding files right away. A signed-in account gets a new, empty workspace the next time it connects.

**Backups.** Workspaces are meant to be temporary, so they aren't backed up. The two things to keep are the secret (`GESSO_SECRET`, set as a Fly secret) and the ban list.

**Restarts and deploys.** A deploy restarts the machine, which takes a few seconds. Exports still running are lost and need running again. Documents and files are on the volume, so they stay.

## On a VPS instead

```sh
cp deploy/gesso.env.example deploy/gesso.env    # fill in GESSO_SECRET and the rest
GESSO_DOMAIN=mcp.gesso.run docker compose -f deploy/compose.yaml up -d --build
```

Point `mcp.gesso.run`'s A and AAAA records at the server first: Caddy gets the HTTPS certificate when it starts. To update, pull the repository and run the same command again.
