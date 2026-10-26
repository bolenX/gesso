# Install Gesso

Gesso is an MCP server. Once it's connected to your agent, the agent can build layered designs, edit and retouch photos, show you previews, and export PSD files that stay editable in Photoshop, as well as PNG, JPEG, WebP, TIFF, SVG and print PDF.

Pick the agent you use:

| Agent | How | Status |
| --- | --- | --- |
| Claude Desktop | Install the extension | Ready |
| Claude Code | One terminal command | Ready |
| Cursor | Add to `mcp.json` | Ready |
| VS Code (Copilot agent mode) | One terminal command | Ready |
| Gemini CLI | Add to `settings.json` | Ready |
| Hermes Agent | Add to `config.yaml` | Ready |
| claude.ai (web and mobile) | Custom connector to `https://mcp.gesso.run/mcp`, or `--tunnel` on your computer | Ready, free |
| ChatGPT | Developer-mode app with `https://mcp.gesso.run/mcp`, or `--tunnel` on your computer | Ready, free |

Every route except the Claude Desktop extension runs Gesso with `npx`, so it needs **Node 22 or later** (`node -v` to check; get it from [nodejs.org](https://nodejs.org)).

## Your Gesso folder

Gesso reads the images and fonts you give it from one folder, and saves its exports there. The configs below use `~/Documents/Gesso`, set with `GESSO_WORKDIR`; Gesso creates the folder if it doesn't exist. Change the path to use a different folder. Without `GESSO_WORKDIR`, Gesso uses the folder the agent started in.

Gesso also saves every document it's working on in a hidden `.gesso` folder inside your Gesso folder, with its full edit history. Close the agent, come back tomorrow, and ask it to continue the poster: it picks up where it left off. Delete a file in `.gesso` to forget that document.

## Claude Desktop (recommended)

1. Download **`gesso-<version>.mcpb`**, the Gesso extension.
2. Double-click the file. Claude Desktop opens an install screen with the Gesso icon.
3. Click **Install**, then choose your Gesso folder (default `~/Documents/Gesso`).
4. Open the tools menu in a chat. **Gesso** is in the list with a toggle; make sure it's on.

Manage or remove it under **Settings › Extensions**. The extension includes everything it needs, with no Node or terminal required.

Prefer editing the config instead? Open **Settings › Developer › Edit Config**, add the entry below to `claude_desktop_config.json`, then quit Claude Desktop completely (⌘Q on a Mac) and reopen it:

```json
{
  "mcpServers": {
    "gesso": {
      "command": "npx",
      "args": ["-y", "gesso-mcp"],
      "env": { "GESSO_WORKDIR": "~/Documents/Gesso" }
    }
  }
}
```

If the file already lists servers, add the `"gesso"` entry next to them.

## Claude Code

```sh
claude mcp add gesso -- npx -y gesso-mcp
```

Gesso uses the folder you start `claude` in. Run `/mcp` to confirm **gesso** shows as connected.

## Cursor

Add Gesso to `~/.cursor/mcp.json` (all projects), or `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "gesso": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "gesso-mcp"],
      "env": { "GESSO_WORKDIR": "~/Documents/Gesso" }
    }
  }
}
```

Then check **Cursor Settings › MCP**: **gesso** should be listed and enabled.

## VS Code (Copilot agent mode)

```sh
code --add-mcp '{"name":"gesso","type":"stdio","command":"npx","args":["-y","gesso-mcp"],"env":{"GESSO_WORKDIR":"~/Documents/Gesso"}}'
```

This adds Gesso to your VS Code user profile. Open Copilot Chat in **Agent** mode; Gesso's tools appear in the tools picker. You can also run **MCP: Add Server** from the Command Palette, choose **Command (stdio)** and enter `npx -y gesso-mcp`.

## Gemini CLI

Add Gesso to `~/.gemini/settings.json` (all projects), or `.gemini/settings.json` in one project:

```json
{
  "mcpServers": {
    "gesso": {
      "command": "npx",
      "args": ["-y", "gesso-mcp"],
      "env": { "GESSO_WORKDIR": "~/Documents/Gesso" }
    }
  }
}
```

Start `gemini` and run `/mcp` to see Gesso's tools.

## Hermes Agent

Add Gesso to the `mcp_servers` block in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  gesso:
    command: "npx"
    args: ["-y", "gesso-mcp"]
    env:
      GESSO_WORKDIR: "~/Documents/Gesso"
```

Start `hermes chat`. If Hermes is already running, run `/reload-mcp`. Gesso's tools appear as `mcp_gesso_<tool>`.

## claude.ai and ChatGPT

claude.ai and ChatGPT only connect to MCP servers on the internet, over HTTPS. There are two free ways.

### The shared server: nothing to install

Connect to `https://mcp.gesso.run/mcp`:
- **claude.ai:** go to **Settings › Connectors › Add custom connector** and paste the address.
- **ChatGPT:** turn on **Settings › Apps › Advanced settings › Developer mode**, then **Create app** with the address and OAuth.

On Gesso's page, choose **Continue without an account**. You get a private workspace, which is deleted after 7 days without use. To bring in your own images, the agent gives you an upload link, or imports them from a web address.

### From your own computer

Gesso can also be that server from your own computer, through a free Cloudflare tunnel. Your files stay in your Gesso folder, and nothing goes through a shared server.

1. **Install Cloudflare's `cloudflared`, once.** You don't need a Cloudflare account.
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Linux: [Cloudflare's packages](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. **Run** `npx -y gesso-mcp --tunnel`. It prints an address like `https://quiet-river.trycloudflare.com/mcp` and a pairing code.
3. **Connect:**
   - **claude.ai:** go to **Settings › Connectors › Add custom connector** and paste the address. When Gesso asks, enter the pairing code.
   - **ChatGPT:** turn on **Settings › Apps › Advanced settings › Developer mode**, then **Create app** with the address and OAuth, and enter the pairing code. Developer mode is limited to some ChatGPT plans.

Notes:
- It works as long as the command is running. The address changes each time you start it, so edit the connector then.
- Files are read from and saved to `~/Documents/Gesso`. Set `GESSO_WORKDIR` to use another folder. The agent can't reach anything outside it.
- Exports come back as download links that go through the tunnel.
- The pairing code means only you can connect, even if someone sees the address. After 10 wrong codes in 15 minutes, pairing pauses.
- If your network blocks Cloudflare's tunnel, Gesso says so. The tunnel needs outgoing port 7844, which some office networks and VPNs block.

**An address that doesn't change.** With a free Cloudflare account and a domain of your own, run a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to this computer. Then start Gesso with `GESSO_PUBLIC_URL=https://your.address npx -y gesso-mcp --personal`.

**A shared server** for many people is covered in [hosting.md](hosting.md).

## Try it

Ask your agent:

> Make a 1080×1350 poster that says "Hello from Gesso", show me a preview, then export a PSD.

In agents that support MCP Apps, such as Claude Desktop, you'll see Gesso's cards as it works: the document outline, the layers it changed, a preview, and finally your files with download buttons. Other agents show the same steps as text, and the files land in your Gesso folder.

Text uses fonts installed on your computer or put in your Gesso folder. The agent looks them up by name, so you can ask for "Inter Bold" or "a serif that's installed".

## Troubleshooting

- **Gesso doesn't show up.** Restart the agent after changing its config. Check that the JSON or YAML is valid: a missing comma breaks the whole file.
- **"node: command not found" or a version error.** Install Node 22 or later from [nodejs.org](https://nodejs.org), then restart the agent.
- **Exports aren't where you expected.** They go to `GESSO_WORKDIR` when it's set (the Claude Desktop extension always sets it), otherwise to the folder the agent started in.

## Update

- **Claude Desktop extension:** download the new `.mcpb` and double-click it.
- **Everything else:** `npx -y gesso-mcp` fetches the latest version when Gesso starts. Restart the agent, or reconnect Gesso from its MCP menu.

---

## For the landing page

Copy for the **Install** or **Get started** section, matching the guide above. For the rest of the page (features, positioning and claims to avoid), see [landing-page-brief.md](landing-page-brief.md). The logos are in [`brand/agents/`](../brand/agents/), from Lobe Icons, Iconify and Devicon: colour and mono icons for every agent, plus wordmarks. Use the colour icon where there is one, otherwise the mono icon, inlined so it follows the text colour.

### Section copy

**Heading:** Connect Gesso to your agent

**Intro:** Gesso runs inside the AI tools you already use. Install it once, then ask for a design.

**Tabs**, in this order. Each tab shows its logo before the name.

| Tab | Logo | Badge | Content |
| --- | --- | --- | --- |
| Claude Desktop | `color/claude.svg` | Recommended | Steps: 1. Download the extension. 2. Double-click it. 3. Choose a folder for your files (default `~/Documents/Gesso`). Button: **Download for Claude Desktop**. Small print: macOS and Windows. Nothing else to install. |
| Claude Code | `color/claude-code.svg` | | Command with a copy button: `claude mcp add gesso -- npx -y gesso-mcp` |
| Cursor | `color/cursor.svg` (mono on dark) | | The `mcp.json` block from the Cursor section, with a copy button. Line: Add to `~/.cursor/mcp.json`. |
| VS Code | `color/vscode.svg` | | The `code --add-mcp …` command, with a copy button. Line: Then use Copilot Chat in Agent mode. |
| Gemini CLI | `color/gemini-cli.svg` | | The `settings.json` block, with a copy button. Line: Add to `~/.gemini/settings.json`. |
| Hermes | `mono/hermes.svg` | | The `config.yaml` block, with a copy button. Line: Add to `~/.hermes/config.yaml`, then `/reload-mcp`. |
| claude.ai | `color/claude.svg` | Free | Steps: 1. In claude.ai, go to Settings › Connectors › Add custom connector. 2. Paste `https://mcp.gesso.run/mcp`, with a copy button. 3. Choose **Continue without an account** on Gesso's page. Small print: Nothing to install. Or run Gesso on your own computer with `npx -y gesso-mcp --tunnel` (link to the full install guide). |
| ChatGPT | `mono/chatgpt.svg` | Free | Steps: 1. In ChatGPT, go to Settings › Apps › Advanced settings › Developer mode › Create app. 2. Paste `https://mcp.gesso.run/mcp` and choose OAuth. 3. Choose **Continue without an account** on Gesso's page. Small print: Developer mode is on some ChatGPT plans. |

**Under the tabs, for every route except the Desktop extension:** Requires Node 22 or later.

**After the tabs:** "Then ask: *Make a 1080×1350 poster that says Hello from Gesso, show me a preview, then export a PSD.*" with a **Full install guide** link to this file.

With eight tabs, let the tab row scroll sideways on phones rather than wrapping.

### Facts to keep accurate

- npm package: `gesso-mcp`. Every config runs `npx -y gesso-mcp`.
- Extension file: `gesso-<version>.mcpb`, about 62 MB, built with `node packages/gesso-mcp/build-mcpb.mjs`. Includes macOS (Apple silicon and Intel), Windows and Linux support.
- Default Gesso folder: `~/Documents/Gesso`, set with `GESSO_WORKDIR`.
- claude.ai and ChatGPT connect to the shared server at `https://mcp.gesso.run/mcp`, or to Gesso on the user's own computer with `npx -y gesso-mcp --tunnel`. Both are free.
- `mcp.gesso.run` passed a live end-to-end check from the internet with the MCP SDK's OAuth client: registration, consent, tokens, tool calls, rendering, export, download and revocation. Until it has also been tried in claude.ai and ChatGPT themselves, say "connect with a custom connector", not "official integration". It isn't in either directory yet.
- Logos are the official marks from Lobe Icons, Iconify and Devicon (see `brand/agents/README.md`). Don't redraw or recolour them.

### Hosting the extension download

The `.mcpb` file is too large to commit to the repo. Host it in one of these places and link the Download button to it:

- **GitHub Releases** (recommended): every version bump that lands on `main` creates a release with the extension attached, as `gesso-<version>.mcpb` and as `gesso.mcpb`. Link the button to `https://github.com/bolenX/gesso/releases/latest/download/gesso.mcpb`, which always points to the newest version and works for anyone.
- **The site's own hosting:** put the file next to the landing page, outside the git repository.
