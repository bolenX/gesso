# Listing Gesso in every agent's directory

How Gesso gets into each agent's directory or marketplace, what's ready in this repository, and what only the owner can do. Checked against each directory's docs in October 2026; they change, so check the page itself before you submit.

## What there is to list

| Package | What it is | Where it lives |
| --- | --- | --- |
| **Connector** | The hosted server `https://mcp.gesso.run/mcp`, with its result card (an MCP App) | Running on the always-on Mac |
| **Plugin** | The connector plus Gesso's 31 skills and a get-started skill, in every agent's plugin format | [`plugins/gesso`](../../plugins/gesso) |
| **npm package** | `gesso-mcp`, run on the user's computer with `npx` | npm, and the official MCP Registry from the next release |
| **Desktop extension** | `gesso.mcpb`, for Claude Desktop | GitHub Releases. Anthropic's directory no longer takes extensions, so it's a download only. |

The plugin's manifests and the marketplace files are kept in step with the package by `node scripts/sync-plugin.mjs`; the tests fail if they drift.

## Where to list it

✅ means it's ready in this repository; the checkbox is what's left for you.

### Directories you submit to

| Directory | Reaches | Ready here | You do | Kit |
| --- | --- | --- | --- | --- |
| **Claude directory: connector** | claude.ai, Claude Desktop, Cowork, Claude Code | ✅ Tool hints, OAuth, result card | [ ] Submit at claude.ai/directory/manage, on a paid plan | [claude-connector.md](claude-connector.md) |
| **Claude directory: plugin** | the same, with the skills | ✅ `plugins/gesso`, passes `claude plugin validate` | [ ] Submit the plugin, and pair it with the connector | [claude-plugin.md](claude-plugin.md) |
| **OpenAI plugin directory** | ChatGPT and Codex | ✅ Manifest, listing, test cases, ZIP builder | [ ] Verify your organization and the domain, record the video, upload the ZIP | [chatgpt-app.md](chatgpt-app.md) |
| **Cursor Marketplace** | Cursor | ✅ `.cursor-plugin/` manifests | [ ] Submit the repository | [other-directories.md](other-directories.md#cursor-marketplace) |
| **awesome-copilot** | GitHub Copilot's default plugin list | ✅ Agent Plugins manifest | [ ] Open an "external plugin" issue | [other-directories.md](other-directories.md#github-copilot) |

### Directories that list it by themselves

| Directory | Ready here | You do |
| --- | --- | --- |
| **Official MCP Registry** (feeds VS Code, GitHub, Glama, Zed and others) | ✅ `server.json`, `mcpName`, and a release step that publishes each version | [ ] Release 0.13.1, the first version with `mcpName` |
| **Gemini CLI extensions gallery** | ✅ `gemini-extension.json` at the root | [ ] Add the `gemini-cli-extension` topic to the GitHub repository |
| **skills.sh** | ✅ `skills/` at the root | Nothing: `npx skills add bolenX/gesso` works now |
| **Your own marketplaces** (Claude Code, Cowork, Codex, Copilot CLI) | ✅ All four marketplace files | Nothing: the install commands in [install.md](../install.md#the-gesso-plugin) work now |

### Community directories

Docker MCP Catalog, Cline, Devin (was Windsurf), Goose, Smithery, Glama, mcp.so and MCP Market: each is a form, an issue or a small PR. Fields and steps are in [other-directories.md](other-directories.md).

## Before any submission

- [x] `https://gesso.run/privacy`, `/terms` and `/support` are live.
- [ ] **Try the hosted server from each agent** you submit to, and run every tool from a conversation. Both the Claude and OpenAI reviews ask you to confirm this.
- [ ] **Decide on `gen_prepare` for the listings.** Anthropic's directory policy rules out "image generation models … image editing … capabilities" that aren't purely design-focused. Gesso doesn't call a model, but `gen_prepare` writes jobs for one. Turning it off on `mcp.gesso.run` (`GESSO_DISABLE_TOOLS=gen_prepare`) before you submit lowers the risk of a rejection, and the skills fall back on masks without it. The trade-off is that hosted users lose generative fill and expand jobs.
- [ ] **Capacity.** Every listing sends people to `mcp.gesso.run` on one always-on Mac. Watch its load after each listing goes live; [hosting.md](../hosting.md) covers moving to a paid host.

## Things only you can do

- **Accounts and plans:** a paid Claude plan for Anthropic's portal, an OpenAI organization with **individual or business verification**, a Cursor account, and accounts on Smithery and Glama.
- **Repository settings:** the `gemini-cli-extension` topic. Connecting GitHub to claude.ai, if you want plugin updates to sync on push.
- **The npm release** that adds `mcpName` (0.13.1). Say when, and it goes out like the others.
- **Recordings and screenshots:** the walkthrough video for OpenAI, and 3–5 result-card screenshots for the Claude connector listing.
- **Legal:** the developer name shown in each directory. OpenAI shows your verified name, so set `developerName` in `plugins/gesso/plugin.json` to match it.
