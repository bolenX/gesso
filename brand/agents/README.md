# Agent logos

Logos for the agents on the landing page's install section, taken unchanged from open icon libraries. Only the fixed `1em` width and height were removed, so the page can size them.

## Which file to use

Use the **colour** logo where one exists; otherwise use the **mono** one.

| Agent | Colour | Mono | Library |
| --- | --- | --- | --- |
| Claude Desktop, claude.ai | `color/claude.svg` | `mono/claude.svg` | Lobe Icons |
| Claude Code | `color/claude-code.svg` | `mono/claude-code.svg` | Lobe Icons |
| Cursor | | `mono/cursor.svg` | Lobe Icons |
| VS Code | `color/vscode.svg` | | Iconify `logos` |
| Gemini CLI | `color/gemini-cli.svg` | `mono/gemini-cli.svg` | Lobe Icons |
| Hermes Agent | | `mono/hermes.svg` | Lobe Icons |
| ChatGPT | | `mono/chatgpt.svg` | Lobe Icons (OpenAI mark) |

Cursor, Hermes Agent and ChatGPT have no colour logo: their official marks are single-colour. VS Code has no single-colour version in these libraries.

**Mono files fill with `currentColor`.** Inline them in the HTML (not as `<img>`), so they take the surrounding text colour and stay visible in both light and dark themes. Colour files work either way.

## Sources and licences

- [Lobe Icons](https://github.com/lobehub/lobe-icons) `@lobehub/icons-static-svg` 1.98.0, MIT.
- [Iconify](https://iconify.design) `@iconify-json/logos` 1.2.17 (from [gilbarbara/logos](https://github.com/gilbarbara/logos)), CC0-1.0.

The icon files are openly licensed, but the marks remain the trademarks of their owners. Use them as each brand's guidelines allow: to show that Gesso works with the product, without implying endorsement.
