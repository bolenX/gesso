#!/usr/bin/env bash
# Sets up mcp.gesso.run on this computer, for free: Gesso's hosted server plus a Cloudflare named tunnel,
# both started again whenever the computer starts. Works on macOS and Linux. Run it from a clone of the
# repository, on a computer that stays on:
#
#   bash deploy/setup-tunnel.sh              # set up, or update after `git pull`
#   bash deploy/setup-tunnel.sh --status     # what's running and what answers, safe to share
#   bash deploy/setup-tunnel.sh --uninstall  # stop and remove the services (keeps the data)
#
# The one step that needs you: the first time, a browser window opens for you to log in to Cloudflare and
# choose gesso.run. The script then creates the tunnel and the DNS record itself.
#
# Settings: GESSO_DOMAIN (mcp.gesso.run), GESSO_TUNNEL_NAME (gesso), GESSO_PORT (3333), and GESSO_CHECK_URL for
# the final check (https://<domain>/health).
set -euo pipefail

DOMAIN="${GESSO_DOMAIN:-mcp.gesso.run}"
TUNNEL="${GESSO_TUNNEL_NAME:-gesso}"
PORT="${GESSO_PORT:-3333}"
HERE="$HOME/.gesso/server"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
LOGS="$HERE/logs"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

uninstall() {
  if [ "$OS" = Darwin ]; then
    for name in run.gesso.server run.gesso.tunnel; do
      launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$name.plist"
    done
  elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now gesso-server.service gesso-tunnel.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/gesso-server.service" "$HOME/.config/systemd/user/gesso-tunnel.service"
    systemctl --user daemon-reload || true
  fi
  for name in server tunnel; do
    [ -f "$HERE/$name.pid" ] && { pkill -TERM -P "$(cat "$HERE/$name.pid")" 2>/dev/null || true; kill "$(cat "$HERE/$name.pid")" 2>/dev/null || true; rm -f "$HERE/$name.pid"; }
  done
  echo "Stopped and removed. Workspaces, the secret and the tunnel are kept in $HERE and ~/.cloudflared."
}
status() {
  local port
  port="$(grep -E '^PORT=' "$HERE/server.env" 2>/dev/null | cut -d= -f2)"
  port="${port:-$PORT}"
  echo "== Gesso server status for $DOMAIN (safe to share: no secrets)"
  echo "system:       $OS $(uname -m), node $(node -v 2>/dev/null || echo missing), $(cloudflared --version 2>/dev/null | head -1 || echo 'cloudflared missing')"
  echo "settings:     $([ -f "$HERE/server.env" ] && echo "$HERE/server.env exists" || echo "not set up yet")"
  echo "cloudflare:   $([ -f "$HOME/.cloudflared/cert.pem" ] && echo "logged in" || echo "not logged in")"
  echo "== tunnels"
  cloudflared tunnel list 2>&1 | tail -n +1 | head -10 || true
  echo "== tunnel config"
  cat "$HERE/cloudflared.yml" 2>/dev/null || echo "none yet"
  echo "== services"
  if [ "$OS" = Darwin ]; then
    launchctl list 2>/dev/null | grep -E 'run\.gesso' || echo "no launchd services"
  elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    echo "server: $(systemctl --user is-active gesso-server.service 2>&1), tunnel: $(systemctl --user is-active gesso-tunnel.service 2>&1)"
  else
    for name in server tunnel; do
      if [ -f "$HERE/$name.pid" ] && kill -0 "$(cat "$HERE/$name.pid")" 2>/dev/null; then echo "$name: running"; else echo "$name: not running"; fi
    done
  fi
  echo "== checks"
  echo "on this computer:  $(curl -s -m 5 "http://127.0.0.1:$port/health" || echo 'no answer') (http://127.0.0.1:$port/health)"
  echo "from the internet: $(curl -s -m 10 "https://$DOMAIN/health" || echo 'no answer') (https://$DOMAIN/health)"
  for log in server tunnel; do
    echo "== last lines of $log.log"
    tail -n 15 "$LOGS/$log.log" 2>/dev/null || echo "no log yet"
  done
}

[ "${1:-}" = "--uninstall" ] && { uninstall; exit 0; }
[ "${1:-}" = "--status" ] && { status; exit 0; }

# ── 1. Node 22 or later ─────────────────────────────────────────────────────────────────────────
have node || fail "Install Node 22 or later from https://nodejs.org, then run this again."
NODE="$(command -v node)"
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Gesso needs Node 22 or later (found $("$NODE" -v)). Update it from https://nodejs.org."

# ── 2. cloudflared ──────────────────────────────────────────────────────────────────────────────
if ! have cloudflared; then
  say "Installing Cloudflare's cloudflared"
  if [ "$OS" = Darwin ]; then
    have brew || fail "Install Homebrew (https://brew.sh) or cloudflared itself, then run this again."
    brew install cloudflared
  elif [ "$OS" = Linux ]; then
    case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; armv7l) arch=arm ;; *) fail "No cloudflared download for $(uname -m)." ;; esac
    mkdir -p "$HOME/.local/bin"
    curl -fsSL -o "$HOME/.local/bin/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
    chmod +x "$HOME/.local/bin/cloudflared"
    export PATH="$HOME/.local/bin:$PATH"
  else
    fail "Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  fi
fi
CLOUDFLARED="$(command -v cloudflared)"

# ── 3. Build Gesso from this checkout ───────────────────────────────────────────────────────────
say "Building Gesso from $REPO"
cd "$REPO"
# CI=true: no questions, since this often runs without a terminal (for example from an agent).
CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile
"$NODE" packages/gesso-mcp/build.mjs
ENTRY="$REPO/packages/gesso-mcp/dist/bin.mjs"

# ── 4. Settings, with a signing secret made once and kept ───────────────────────────────────────
mkdir -p "$HERE/data" "$LOGS"
chmod 700 "$HERE"
ENV_FILE="$HERE/server.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Making the signing secret (kept in $ENV_FILE)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Hosted Gesso for $DOMAIN (docs/hosting.md lists every setting). Keep GESSO_SECRET: changing it signs everyone out.
GESSO_SECRET=$("$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
GESSO_PUBLIC_URL="https://$DOMAIN"
GESSO_WORKDIR="$HERE/data"
HOST=127.0.0.1
PORT=$PORT
GESSO_CLIENT_IP_HEADER=cf-connecting-ip
GESSO_BLOCKLIST="$HERE/blocklist.txt"
EOF
  umask 022
fi
touch "$HERE/blocklist.txt"

# ── 5. The Cloudflare tunnel and its DNS record ─────────────────────────────────────────────────
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "Log in to Cloudflare in the browser window that opens, and choose gesso.run"
  echo "(If no window opens, copy the address cloudflared prints into any browser.)"
  "$CLOUDFLARED" tunnel login
fi
if ! "$CLOUDFLARED" tunnel info "$TUNNEL" >/dev/null 2>&1; then
  say "Creating the tunnel \"$TUNNEL\""
  "$CLOUDFLARED" tunnel create "$TUNNEL"
fi
TUNNEL_ID="$("$CLOUDFLARED" tunnel list --name "$TUNNEL" --output json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(t=>!t.deleted_at||t.deleted_at.startsWith("0001"));if(!t)process.exit(1);process.stdout.write(t.id)})')" ||
  fail "Couldn't find the tunnel \"$TUNNEL\" after creating it."
CREDENTIALS="$HOME/.cloudflared/$TUNNEL_ID.json"
[ -f "$CREDENTIALS" ] || fail "The tunnel's credentials ($CREDENTIALS) aren't on this computer. It was made elsewhere: delete it with \`cloudflared tunnel delete $TUNNEL\` and run this again, or set GESSO_TUNNEL_NAME to a new name."

say "Pointing $DOMAIN at the tunnel"
ROUTE="$("$CLOUDFLARED" tunnel route dns --overwrite-dns "$TUNNEL" "$DOMAIN" 2>&1)" || { echo "$ROUTE"; fail "Cloudflare didn't add the DNS record for $DOMAIN."; }
echo "$ROUTE"
# cloudflared's login is for one domain. If another one was chosen, it quietly adds "$DOMAIN.<that domain>".
if printf '%s' "$ROUTE" | grep -Eq "${DOMAIN//./\\.}\\.[A-Za-z0-9-]"; then
  fail "Cloudflare added the record under another domain: at the login, a different domain than ${DOMAIN#*.} was chosen.
Fix: in the Cloudflare dashboard, delete the stray record shown above. Then run:
  rm ~/.cloudflared/cert.pem
  bash deploy/setup-tunnel.sh
and choose ${DOMAIN#*.} when the browser asks."
fi

TUNNEL_CONFIG="$HERE/cloudflared.yml"
cat > "$TUNNEL_CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS
ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

# ── 6. Services that start with the computer ────────────────────────────────────────────────────
SERVER_CMD="set -a; . '$ENV_FILE'; set +a; exec '$NODE' '$ENTRY' --hosted"
TUNNEL_CMD="exec '$CLOUDFLARED' tunnel --no-autoupdate --config '$TUNNEL_CONFIG' run '$TUNNEL'"

if [ "$OS" = Darwin ]; then
  say "Installing the services (launchd)"
  mkdir -p "$HOME/Library/LaunchAgents"
  plist() { # name, command, log
    cat > "$HOME/Library/LaunchAgents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>$2</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/$3.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$3.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$1.plist"
  }
  plist run.gesso.server "$SERVER_CMD" server
  plist run.gesso.tunnel "$TUNNEL_CMD" tunnel
elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  say "Installing the services (systemd)"
  mkdir -p "$HOME/.config/systemd/user"
  unit() { # name, description, command
    cat > "$HOME/.config/systemd/user/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target

[Service]
ExecStart=/bin/sh -c "$3"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  }
  unit gesso-server "Gesso hosted server for $DOMAIN" "$SERVER_CMD"
  unit gesso-tunnel "Cloudflare tunnel for $DOMAIN" "$TUNNEL_CMD"
  systemctl --user daemon-reload
  systemctl --user enable gesso-server.service gesso-tunnel.service
  systemctl --user restart gesso-server.service gesso-tunnel.service
  # Keep running after logging out, and start at boot without logging in.
  loginctl enable-linger "$USER" 2>/dev/null || echo "Run \`sudo loginctl enable-linger $USER\` so the services start at boot without logging in."
else
  say "No service manager found: starting both in the background"
  # Stop the copies an earlier run started, so an update replaces them.
  for name in server tunnel; do
    if [ -f "$HERE/$name.pid" ]; then
      pkill -TERM -P "$(cat "$HERE/$name.pid")" 2>/dev/null || true
      kill "$(cat "$HERE/$name.pid")" 2>/dev/null || true
    fi
  done
  sleep 2
  nohup /bin/sh -c "$SERVER_CMD" >>"$LOGS/server.log" 2>&1 &
  echo $! >"$HERE/server.pid"
  nohup /bin/sh -c "$TUNNEL_CMD" >>"$LOGS/tunnel.log" 2>&1 &
  echo $! >"$HERE/tunnel.pid"
  echo "They won't restart on their own after a reboot: run this script again then."
fi

# ── 7. Check it from the internet ───────────────────────────────────────────────────────────────
CHECK="${GESSO_CHECK_URL:-https://$DOMAIN/health}"
say "Waiting for $CHECK to answer"
for _ in $(seq 1 60); do
  if [ "$(curl -s -m 5 "$CHECK" || true)" = "ok" ]; then
    printf '\n\033[32m%s\033[0m\n' "mcp.gesso.run is live."
    cat <<EOF

  Connector address:  https://$DOMAIN/mcp
  claude.ai:          Settings › Connectors › Add custom connector
  ChatGPT:            Settings › Apps › Advanced settings › Developer mode › Create app (OAuth)

  Logs:      $LOGS
  Data:      $HERE/data
  Update:    git pull, then run this script again.
  Keep this computer awake: on a Mac, System Settings › Energy › "Prevent automatic sleeping".
EOF
    exit 0
  fi
  sleep 5
done
fail "https://$DOMAIN didn't answer within 5 minutes. Check $LOGS/server.log and $LOGS/tunnel.log."
