# Install Gesso

Gesso is an MCP server. Once it's connected, Claude can build layered designs, show you previews, and export PNG, JPEG, WebP or PSD files that stay editable in Photoshop.

Pick the app you use:

| App | How | Time |
| --- | --- | --- |
| Claude Desktop | Install the extension | 1 minute |
| Claude Code | One terminal command | 1 minute |
| Claude Desktop, manual setup | Edit the config file | 3 minutes |
| claude.ai on the web | Custom connector | Not available yet |

## Claude Desktop (recommended)

1. Download **`gesso-<version>.mcpb`**, the Gesso extension.
2. Double-click the file. Claude Desktop opens an install screen with the Gesso icon.
3. Click **Install**.
4. Choose your **Gesso folder**. The default is `~/Documents/Gesso`. Gesso reads the images and fonts you give it from this folder, and saves its exports here.
5. Open the tools menu in a chat. **Gesso** is in the list with a toggle; make sure it's on.

Manage or remove it later under **Settings › Extensions**.

The extension includes everything it needs. You don't need Node or a terminal.

## Claude Code

Requires Node 22 or later (`node -v` to check).

```sh
claude mcp add gesso -- npx -y gesso-mcp
```

Start `claude` in the folder you want to work in. Gesso reads assets from that folder and writes exports into it. Run `/mcp` to confirm **gesso** shows as connected.

## Claude Desktop, manual setup

Use this if you'd rather not install the extension. Requires Node 22 or later.

1. In Claude Desktop, open **Settings › Developer › Edit Config**.
2. Add Gesso to `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "gesso": {
         "command": "npx",
         "args": ["-y", "gesso-mcp"],
         "env": { "GESSO_WORKDIR": "/Users/you/Documents/Gesso" }
       }
     }
   }
   ```

   Replace the `GESSO_WORKDIR` path with the folder you want Gesso to use. If the file already lists other servers, add the `"gesso"` entry next to them.
3. Quit Claude Desktop completely (⌘Q on a Mac) and open it again.

## claude.ai on the web

Not available yet. A web connector needs Gesso running on a public server. `npx -y gesso-mcp --http 3333` starts Gesso as a web server; behind HTTPS, add `https://your-host/mcp` under **Settings › Connectors › Add custom connector**. A hosted Gesso can't read files on your computer, so using your own images there waits on the planned `asset_import` tool.

## Try it

Ask Claude:

> Make a 1080×1350 poster that says "Hello from Gesso", show me a preview, then export a PSD.

You'll see Gesso's cards in the chat as it works: the document outline, the layers it changed, a preview, and finally your files with download buttons. (Claude Code shows the same steps as text.)

Text needs a font file. Put the font in your Gesso folder, or ask Claude to use one already installed on your computer.

## Troubleshooting

- **Gesso isn't in the tools list.** Restart Claude Desktop. For the manual setup, check **Settings › Developer**, which shows each server's status and any error.
- **"node: command not found" or a version error** (Claude Code and manual setup). Install the current Node from [nodejs.org](https://nodejs.org).
- **Exports aren't where you expected.** Claude Desktop saves into your Gesso folder; Claude Code saves into the folder you started `claude` in.

## Update

- **Extension:** download the new `.mcpb` and double-click it.
- **Claude Code and manual setup:** `npx -y gesso-mcp` fetches the latest version each time Gesso starts. Restart the app, or reconnect with `/mcp`.

---

## For the landing page

Copy for an **Install** or **Get started** section. It's written to match the guide above, so the page and the docs say the same thing.

### Section copy

**Heading:** Connect Gesso to Claude

**Intro:** Gesso runs inside Claude. Install it once, then ask for a design.

**Tab 1: Claude Desktop**
- Label: Recommended
- Steps: 1. Download the extension. 2. Double-click it. 3. Choose a folder for your files.
- Button: **Download for Claude Desktop** (links to the `.mcpb` file)
- Small print: macOS and Windows. Nothing else to install.

**Tab 2: Claude Code**
- Command, with a copy button: `claude mcp add gesso -- npx -y gesso-mcp`
- Small print: Requires Node 22 or later.

**Tab 3: Manual config**
- The JSON block from "Claude Desktop, manual setup" above, with a copy button.

**Tab 4: claude.ai**
- Status badge: Coming soon
- Line: Web connector support is in progress.

**After the tabs:** "Then ask Claude: *Make a 1080×1350 poster that says Hello from Gesso, show me a preview, then export a PSD.*" with a link to the full install guide (this file).

### Facts to keep accurate

- npm package: `gesso-mcp` (current version 0.3.1). Install command: `claude mcp add gesso -- npx -y gesso-mcp`.
- Extension file: `gesso-<version>.mcpb`, about 55 MB, built with `node packages/gesso-mcp/build-mcpb.mjs`. It includes macOS (Apple silicon and Intel), Windows and Linux support.
- Default Gesso folder: `~/Documents/Gesso`.
- Node 22 or later for the npm route only.
- claude.ai web connector: not available yet. Don't say it's supported.

### Hosting the extension download

The `.mcpb` file is too large to commit to the repo. Host it in one of these places and link the Download button to it:

- **GitHub Releases** (recommended): attach the file to a release; the link `https://github.com/bolenX/gesso/releases/latest/download/gesso-<version>.mcpb` then always points to the latest. While the repository is private, only people with access can download it, so make the repo public before launch.
- **The site's own hosting**: put the file next to the landing page, outside the git repository.
