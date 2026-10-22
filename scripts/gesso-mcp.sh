#!/bin/sh
# Starts the Gesso MCP server over stdio, building it first if needed.
# Build output goes to stderr: stdout is the MCP channel and must stay clean.
set -e
cd "$(dirname "$0")/.."
if [ ! -f packages/mcp-server/dist/bin.js ] || [ -n "$(find packages/*/src -newer packages/mcp-server/dist/bin.js -name '*.ts' 2>/dev/null | head -1)" ]; then
  echo "gesso: building…" >&2
  [ -d node_modules ] || pnpm install --frozen-lockfile >&2
  pnpm -s build >&2
fi
exec node packages/mcp-server/dist/bin.js "$@"
