# Agent logos

Logos for the agents on the landing page's install section, taken unchanged from open icon libraries. Only fixed `1em` sizes were removed, so the page can size them.

## Files

| Agent | Icon, colour | Icon, mono | Wordmark |
| --- | --- | --- | --- |
| Claude Desktop, claude.ai | `color/claude.svg` | `mono/claude.svg` | `wordmark/claude.svg` |
| Claude Code | `color/claude-code.svg` | `mono/claude-code.svg` | `wordmark/claude-code.svg` |
| Cursor | `color/cursor.svg` | `mono/cursor.svg` | `wordmark/cursor.svg` |
| VS Code | `color/vscode.svg` | `mono/vscode.svg` | `wordmark/vscode.svg` (colour) |
| Gemini CLI | `color/gemini-cli.svg` | `mono/gemini-cli.svg` | `wordmark/gemini-cli.svg` |
| Hermes Agent | | `mono/hermes.svg` | `wordmark/hermes.svg` |
| ChatGPT | | `mono/chatgpt.svg` | `wordmark/chatgpt.svg` (OpenAI) |

Hermes Agent and ChatGPT have no colour icon: their official marks are black and white only.

## Using them

- **Mono icons and wordmarks fill with `currentColor`.** Inline them in the HTML (not as `<img>`), so they take the surrounding text colour and show in both light and dark themes.
- **Colour icons** work inline or as `<img>`. The colour Cursor icon is dark grey, so on a dark background use `mono/cursor.svg` instead.
- **Pick one style per row** of tabs: all mono for a quiet row, or colour where available with mono for the rest.

## Sources and licences

| Files | Library | Licence |
| --- | --- | --- |
| Claude, Claude Code, Gemini CLI, Hermes Agent and ChatGPT/OpenAI icons; Cursor mono icon; all wordmarks except VS Code | [Lobe Icons](https://github.com/lobehub/lobe-icons) `@lobehub/icons-static-svg` 1.98.0 | MIT |
| `color/vscode.svg` | [Iconify](https://iconify.design) `@iconify-json/logos` 1.2.17, from [gilbarbara/logos](https://github.com/gilbarbara/logos) | CC0-1.0 |
| `color/cursor.svg`, `mono/vscode.svg`, `wordmark/vscode.svg` | [Devicon](https://devicon.dev) via `@iconify-json/devicon` 1.2.71 and `@iconify-json/devicon-plain` 1.2.62 | MIT |

The icon files are openly licensed, but the marks remain the trademarks of their owners. Use them as each brand's guidelines allow: to show that Gesso works with the product, without implying endorsement.
