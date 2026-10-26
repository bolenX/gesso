# Running mcp.gesso.run

This folder runs hosted Gesso at `https://mcp.gesso.run`, a shared server that claude.ai and ChatGPT can connect to without anyone installing anything. It's also what the Claude and ChatGPT directories need to list Gesso, because they need a fixed address. [docs/hosting.md](../docs/hosting.md) explains what hosted Gesso does and lists every setting.

People don't need this server to use Gesso from claude.ai or ChatGPT today: `npx -y gesso-mcp --tunnel` runs it on their own computer, for free (see [install.md](../docs/install.md#claudeai-and-chatgpt)).

## Free: any always-on machine and a Cloudflare Tunnel

Gesso needs a few seconds of real CPU per render. Free serverless plans don't allow that: Cloudflare Workers get 10 ms of CPU per request, and Hugging Face Docker Spaces now need a paid plan. So the server runs on a machine. A Cloudflare Tunnel, free on the Cloudflare account that already serves gesso.run, gives that machine the address `mcp.gesso.run`:
- no open ports, router setup or certificates
- HTTPS and DDoS protection from Cloudflare

**The machine can be:**
- **A computer that's always on:** an old laptop, a Mac mini, a home server or NAS. A Raspberry Pi 5 with 8 GB works too, though renders are slower.
- **Oracle Cloud's Always Free VM:** an Ampere A1 instance with 2 or more cores and 12 GB, free with no time limit. Oracle asks for a card to verify the account, but doesn't charge for Always Free resources unless you upgrade the account. Two caveats from Oracle's terms:
  - an instance that stays almost idle for a week can be reclaimed
  - the free allowance has been reduced before

  Keep backups of `gesso.env` and the ban list.

**The quickest way: one script, about 10 minutes.** On the always-on Mac or Linux computer, with Node 22 or later, run:
```sh
git clone https://github.com/bolenX/gesso && cd gesso
bash deploy/setup-tunnel.sh
```
It does everything except one click:
- installs `cloudflared` if it's missing
- builds Gesso from the clone
- makes the signing secret, kept in `~/.gesso/server/server.env`
- creates the tunnel and the `mcp.gesso.run` DNS record, after the one click: a browser window opens for you to log in to Cloudflare and choose gesso.run
- installs both as services that start with the computer (launchd on macOS, systemd on Linux)
- keeps the logs for 30 days, as the privacy policy says, with a daily job in `~/.gesso/server/logs` (`GESSO_LOG_DAYS` changes it)
- checks `https://mcp.gesso.run/health` from the internet

Then:
- **Update:** `git pull`, and run it again. It keeps the secret and the tunnel.
- **Remove:** `bash deploy/setup-tunnel.sh --uninstall` stops and removes the services. Data and the secret stay in `~/.gesso/server`.
- **Agent:** a Claude Code session running on that computer can run the script for you. You only click through the Cloudflare login.

**With Docker instead, about 20 minutes:**

1. **Create the tunnel.** In the Cloudflare dashboard, go to **Zero Trust › Networks › Tunnels › Create a tunnel**. Choose **Cloudflared**, name it `gesso`, and copy the token from the install command it shows. Don't run that command: the Compose file runs cloudflared for you.
2. **Give it the address.** On the tunnel's **Public hostname** tab, add hostname `mcp`, domain `gesso.run`, service type `HTTP`, and URL `gesso:8080`.
3. **On the machine,** with Docker installed, clone this repository and run:
   ```sh
   cp deploy/gesso.env.example deploy/gesso.env      # set GESSO_SECRET: openssl rand -hex 32
   TUNNEL_TOKEN=<token from step 1> docker compose -f deploy/compose.tunnel.yaml up -d --build
   ```
   Keep the token out of chats and the repository. It lets anyone run your tunnel.
4. **Check it:** `https://mcp.gesso.run/health` should answer `ok`. Then add `https://mcp.gesso.run/mcp` as a custom connector in claude.ai.

**Without Docker,** for example on a Mac, run the two parts as background services:
```sh
GESSO_PUBLIC_URL=https://mcp.gesso.run GESSO_WORKDIR=~/gesso-data GESSO_SECRET=… GESSO_CLIENT_IP_HEADER=cf-connecting-ip npx -y gesso-mcp --hosted
cloudflared tunnel run --token <token>    # with the public hostname's service set to http://localhost:3333
```

**To update:** `git pull`, then run the same `docker compose … up -d --build` command.

**What it can handle:** a 4-core machine with 8 GB serves a handful of people rendering at once. Each render takes a core while it runs. If the machine is busy or off, connectors show an error until it's back.

## Paid hosts (optional)

If Gesso ever outgrows a free machine, the same server runs on any paid host.

| | Fly.io (`fly.toml`) | VPS (`compose.yaml` with Caddy) |
| --- | --- | --- |
| Machine | 2 shared CPUs, 4 GB, always on | 2–4 vCPUs, 4–8 GB |
| Disk | 20 GB volume for workspaces | the server's disk |
| Rough cost | about $25–35 a month | about €5–15 a month |

Check current prices with the provider: these change. The first limit you'll hit is CPU. Raise `GESSO_WORKERS` to match the machine's cores.

### Fly.io from GitHub (nothing to install)

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

### Fly.io from your computer

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

#### Deploy from GitHub

Create a deploy token with `fly tokens create deploy --app gesso-mcp`, and save it as the `FLY_API_TOKEN` repository secret under Settings › Secrets and variables › Actions. After that:
- every new release deploys automatically, after the npm package and the GitHub release
- **Actions › Deploy mcp.gesso.run › Run workflow** deploys by hand

The workflow uses `superfly/flyctl-actions/setup-flyctl@master`, as Fly's docs recommend. To lock it down, pin it to a commit SHA.

### On a VPS with Caddy

```sh
cp deploy/gesso.env.example deploy/gesso.env    # fill in GESSO_SECRET and the rest
GESSO_DOMAIN=mcp.gesso.run docker compose -f deploy/compose.yaml up -d --build
```

Point `mcp.gesso.run`'s A and AAAA records at the server first: Caddy gets the HTTPS certificate when it starts. To update, pull the repository and run the same command again.

## Sign in with GitHub or Google (optional)

Without these, people connect without an account and get a new workspace each time. They can also paste a workspace key to reconnect. With an account, they get the same workspace every time they connect.

**GitHub:**
1. Go to Settings › Developer settings › OAuth Apps › New OAuth App.
2. Use the homepage `https://gesso.run` and the callback URL `https://mcp.gesso.run/oauth/github/callback`.
3. Add `GESSO_GITHUB_CLIENT_ID` and `GESSO_GITHUB_CLIENT_SECRET` to `deploy/gesso.env` and restart, or use `fly secrets set` on Fly.io.

**Google:**
1. In Google Cloud Console, go to APIs & Services › Credentials › Create credentials › OAuth client ID.
2. Choose **Web application**, with the authorized redirect URI `https://mcp.gesso.run/oauth/google/callback`.
3. Set up the consent screen with the `openid` scope only. Use the app name Gesso, the homepage `https://gesso.run`, and the privacy policy and terms URLs.
4. Add `GESSO_GOOGLE_CLIENT_ID` and `GESSO_GOOGLE_CLIENT_SECRET` to `deploy/gesso.env` and restart, or use `fly secrets set` on Fly.io.

Gesso asks GitHub and Google for nothing but the account's id. It doesn't ask for email, repositories or files. It turns the id into a workspace key with the secret, and doesn't store the id.

To require an account, set `GESSO_ANONYMOUS=0`. That cuts down on throwaway workspaces, but adds a step for everyone.

## Running it

**Logs.**
- `docker compose -f deploy/compose.tunnel.yaml logs -f gesso` (or `fly logs` on Fly.io) shows one JSON line per MCP request: time, method, tool, status, duration and a short hash of the workspace.
- Content and keys are never logged.
- Worker restarts show up as `Gesso worker N stopped`.

**Ban a workspace or an account.**
- Add its key, or `github:<id>` or `google:<sub>`, as a line in `/data/blocklist.txt`. Lines starting with `#` are comments.
- Gesso rereads the file within a minute:
  ```sh
  docker compose -f deploy/compose.tunnel.yaml exec gesso sh -c 'echo github:12345 >> /data/blocklist.txt'
  ```

**Find a workspace from a log line.** The log's `ws` is the first 10 hex characters of `sha256(key)`. On the server:
```sh
for k in /data/workspaces/*; do echo "$(printf %s "$(basename $k)" | sha256sum | cut -c1-10) $k"; done | grep <ws>
```

**Delete everything for someone who asks.** Delete their workspace folder under `/data/workspaces/`. Their tokens stop finding files right away. A signed-in account gets a new, empty workspace the next time it connects.

**Backups.** Workspaces are meant to be temporary, so they aren't backed up. The two things to keep are the secret (`GESSO_SECRET`, in `deploy/gesso.env` or Fly's secrets) and the ban list.

**Restarts and updates.** An update restarts Gesso, which takes a few seconds. Exports still running are lost and need running again. Documents and files are on the volume, so they stay.
