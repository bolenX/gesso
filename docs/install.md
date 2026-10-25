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
| claude.ai on the web | Custom connector to a hosted Gesso | Self-host; official hosting coming soon |
| ChatGPT | Developer-mode app with a hosted Gesso | Self-host; official hosting coming soon |

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

Both connect only to MCP servers on the public internet over HTTPS, so they need a hosted Gesso. There's no official one yet, but you can run your own with `npx -y gesso-mcp --hosted` or the Docker image: [hosting.md](hosting.md) has the steps. Open `https://your-host/new` to make a private workspace; its page shows your connector URL, `https://your-host/mcp/<key>`. Then:

- **claude.ai:** **Settings › Connectors › Add custom connector** with your connector URL.
- **ChatGPT:** turn on **Settings › Apps › Advanced settings › Developer mode**, then **Create app** with your connector URL. Developer mode is limited to some ChatGPT plans.

A hosted Gesso can't read files on your computer. Upload images and fonts on your workspace page, or the agent brings them in from a URL with `asset_import`. Exports come back as download links.

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
| claude.ai | `color/claude.svg` | Coming soon | Line: Official hosting is in progress. You can host your own today: link to the hosting guide. |
| ChatGPT | `mono/chatgpt.svg` | Coming soon | Line: Official hosting is in progress. You can host your own today: link to the hosting guide. |

**Under the tabs, for every route except the Desktop extension:** Requires Node 22 or later.

**After the tabs:** "Then ask: *Make a 1080×1350 poster that says Hello from Gesso, show me a preview, then export a PSD.*" with a **Full install guide** link to this file.

With eight tabs, let the tab row scroll sideways on phones rather than wrapping.

### Facts to keep accurate

- npm package: `gesso-mcp`. Every config runs `npx -y gesso-mcp`.
- Extension file: `gesso-<version>.mcpb`, about 62 MB, built with `node packages/gesso-mcp/build-mcpb.mjs`. Includes macOS (Apple silicon and Intel), Windows and Linux support.
- Default Gesso folder: `~/Documents/Gesso`, set with `GESSO_WORKDIR`.
- claude.ai and ChatGPT: there's no official hosted Gesso yet. A self-hosted one ([hosting.md](hosting.md)) works over the same protocol, but hasn't been tested against those connectors yet. Don't say they're supported out of the box.
- Logos are the official marks from Lobe Icons, Iconify and Devicon (see `brand/agents/README.md`). Don't redraw or recolour them.

### Hosting the extension download

The `.mcpb` file is too large to commit to the repo. Host it in one of these places and link the Download button to it:

- **GitHub Releases** (recommended): every version bump that lands on `main` creates a release with the extension attached, as `gesso-<version>.mcpb` and as `gesso.mcpb`. Link the button to `https://github.com/bolenX/gesso/releases/latest/download/gesso.mcpb`, which always points to the newest version. While the repository is private, only people with access can download it, so make the repo public before launch.
- **The site's own hosting:** put the file next to the landing page, outside the git repository.
