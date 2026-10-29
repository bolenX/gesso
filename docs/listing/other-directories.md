# Other directories: submission kit

Every directory besides Anthropic's and OpenAI's, with what each needs and the text to paste. Checked in October 2026; each one's own page is the final word.

## Listed automatically

### Official MCP Registry

[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) feeds VS Code, GitHub, Glama, Zed and other directories.

- **Ready:** `server.json` at the root lists the npm package and the hosted server under `io.github.bolenX/gesso`. `mcpName` in `packages/gesso-mcp/package.json` proves the package is ours. Keep the capital X: the registry matches the GitHub owner exactly.
- **Publishing:** the `registry` job in `.github/workflows/publish.yml` runs after each new npm version. It signs in with the workflow's GitHub identity, so there's no secret to set.
- **You do:** release 0.13.1, the first version published with `mcpName`. Then check: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=gesso"`.
- A version can't be changed once published. To fix only the listing, publish a prerelease such as `0.13.1-1`.

### Gemini CLI extensions

- **Ready:** `gemini-extension.json` at the root. It runs `npx -y gesso-mcp`, asks for the Gesso folder, and loads `skills/`.
- **You do:** add the topic `gemini-cli-extension` to the GitHub repository (**About › ⚙ › Topics**). The [gallery](https://geminicli.com/extensions) crawls daily.
- **Install:** `gemini extensions install https://github.com/bolenX/gesso`.
- Gemini CLI now mostly serves API-key and Code Assist users; Google's subscribers moved to **Antigravity CLI**, which takes Gemini extensions as plugins. Its marketplace is curated: apply with the [interest form](https://forms.gle/2EX5RFYPoJe1UgxR9).

### skills.sh

Nothing to submit. `npx skills add bolenX/gesso` installs the skills from `skills/` into most agents, and [skills.sh](https://skills.sh) ranks them by installs. The skills need Gesso's server to do anything, which `skills/README.md` says.

### PulseMCP

[Submissions are paused](https://www.pulsemcp.com/submit). It picks up servers from the official registry once it reopens.

## Forms, issues and pull requests

### Cursor Marketplace

- **Ready:** `.cursor-plugin/marketplace.json` at the root, and `plugins/gesso/.cursor-plugin/plugin.json` with the logo and the hosted server.
- **You do:** submit the repository at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish). It has to be public and open source, and a person reviews it.
- Paste as the description: "Layered design and photo editing: build posters, social sizes, retouches and cut-outs as editable layers, and export PSDs that open live in Photoshop. Connects to Gesso's free hosted server, and adds 31 professional workflow skills."
- The plugin uses the hosted server, so it avoids the `npx` bug in Cursor's Agents window ([install.md](../install.md#if-gesso-shows-an-error-in-cursor)).

### GitHub Copilot

Two separate lists:

**awesome-copilot**, Copilot's default plugin marketplace. Open an issue at [github/awesome-copilot](https://github.com/github/awesome-copilot/issues/new/choose) and choose **External plugin**:

> **Name:** Gesso
> **Repository:** https://github.com/bolenX/gesso
> **Path:** plugins/gesso
> **Ref:** gesso-mcp-v0.13.1 (the release tag)
> **License:** Apache-2.0
> **Description:** Layered design and photo editing with editable PSD export. An Agent Plugins 1.0 plugin: the hosted Gesso MCP server plus 31 workflow skills.

**GitHub MCP Registry** (github.com/mcp and VS Code's `@mcp` gallery) is curated, and new versions sync from the official registry. Once Gesso is in the official registry, email partnerships@github.com:

> Subject: Listing request: Gesso MCP server (io.github.bolenX/gesso)
>
> Gesso is an open-source (Apache-2.0) MCP server for layered image editing that exports editable Photoshop files. It's in the official MCP Registry as io.github.bolenX/gesso, with an npm package (gesso-mcp) and a hosted server (https://mcp.gesso.run/mcp, OAuth with dynamic registration, free). We'd like it listed in the GitHub MCP Registry. Repository: https://github.com/bolenX/gesso.

### Docker MCP Catalog

A pull request to [docker/mcp-registry](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md) adding `servers/gesso/` (their `task remote-wizard` writes it). List the hosted server only: a local container doesn't suit a tool that works on your own files.

`server.yaml`:
```yaml
name: gesso
type: remote
dynamic:
  tools: true
meta:
  category: productivity
  tags: [image, design, photoshop, remote]
about:
  title: Gesso
  description: Layered image editing with editable PSD export
  icon: https://raw.githubusercontent.com/bolenX/gesso/main/plugins/gesso/assets/icon.png
remote:
  transport_type: streamable-http
  url: https://mcp.gesso.run/mcp
```
Plus `tools.json` containing `[]`, and `readme.md` with a link to `https://github.com/bolenX/gesso`. Their template may ask for an `oauth` block; follow the wizard. It's unconfirmed whether Docker's sign-in handles Gesso's client registration, so try it in Docker Desktop's MCP Toolkit before opening the PR.

### Cline

Open an issue at [cline/mcp-marketplace](https://github.com/cline/mcp-marketplace/issues/new):

> **Repository:** https://github.com/bolenX/gesso
> **Logo:** attach `docs/listing/assets/icon-400.png` (400×400)
> **Why:** Gesso lets Cline build and edit layered images (designs, retouches, cut-outs) and export PSDs that stay editable in Photoshop. It installs with `npx -y gesso-mcp`, or connects to the free hosted server.

### Devin (formerly Windsurf)

A pull request to [CognitionAI/devin-marketplace](https://github.com/CognitionAI/devin-marketplace), under their CLA. Devin reads `.claude-plugin/`, so `plugins/gesso` works as it is.

### Goose

A pull request to [aaif-goose/goose](https://github.com/aaif-goose/goose) adding this to `documentation/static/servers.json`, usually with a short tutorial page:

```json
{
  "id": "gesso",
  "name": "Gesso",
  "description": "Layered image editing with editable PSD export",
  "command": "npx -y gesso-mcp",
  "link": "https://github.com/bolenX/gesso",
  "is_builtin": false,
  "endorsed": false,
  "environmentVariables": [{ "name": "GESSO_WORKDIR", "description": "Folder for images, fonts and exports", "required": false }]
}
```

### Smithery

With a Smithery account and its CLI: `smithery mcp publish "https://mcp.gesso.run/mcp" -n bolenX/gesso`, or use [smithery.ai/new](https://smithery.ai/new). Gesso answers unsigned requests with 401, which is what Smithery needs to find the sign-in.

### Glama

- **Ready:** `glama.json` at the root names `bolenX` as the maintainer. If `bolenX` is an organization rather than your own GitHub username, put your username there instead.
- **You do:** sign in to [glama.ai](https://glama.ai) with GitHub and claim the server.

### mcp.so and MCP Market

Forms: [mcp.so/submit](https://mcp.so/submit) and [mcpmarket.com/submit](https://mcpmarket.com/submit). Give the repository URL, choose **Remote server** for `https://mcp.gesso.run/mcp` (submit the local server separately if the form asks for one type only), and paste the Cursor description above. Both offer paid fast-track review; the free route takes days to weeks.

## Nothing to submit

- **Zed:** reads the official registry.
- **JetBrains AI Assistant:** no catalog; people paste the config from [install.md](../install.md).
- **LM Studio:** no catalog, but it has an install link for the website: `lmstudio://add_mcp?name=gesso&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdlc3NvLW1jcCJdLCJlbnYiOnsiR0VTU09fV09SS0RJUiI6In4vRG9jdW1lbnRzL0dlc3NvIn19`.
- **Microsoft 365 Copilot and Copilot Studio:** they need a business verified in Partner Center, and a pre-registered OAuth client with a secret, which Gesso doesn't use. Leave these until there's a business to publish under.

## Install links for the website

GitHub won't link app schemes like `cursor://`, but a website can. The `https://` versions work anywhere:

| Agent | Link |
| --- | --- |
| Cursor | `https://cursor.com/install-mcp?name=gesso&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdlc3NvLW1jcCJdLCJlbnYiOnsiR0VTU09fV09SS0RJUiI6In4vRG9jdW1lbnRzL0dlc3NvIn19` (Cursor's button images: `https://cursor.com/deeplink/mcp-install-dark.svg` and `-light.svg`) |
| VS Code | `https://insiders.vscode.dev/redirect/mcp/install?name=gesso&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22gesso-mcp%22%5D%2C%22env%22%3A%7B%22GESSO_WORKDIR%22%3A%22~%2FDocuments%2FGesso%22%7D%7D` |
| VS Code, hosted | `https://insiders.vscode.dev/redirect/mcp/install?name=gesso&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.gesso.run%2Fmcp%22%7D` |
| LM Studio | the `lmstudio://` link above |
