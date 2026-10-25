# ChatGPT app directory: submission kit

What OpenAI's app submission asks for, ready to paste. It follows the [Apps SDK submission guide](https://developers.openai.com/apps-sdk/deploy/submission) as of October 2026. Check OpenAI's App Submission Guidelines too, because the details change.

**Before you submit:**
- [ ] `mcp.gesso.run` is deployed, and works in ChatGPT developer mode (**Settings › Apps › Advanced settings › Developer mode › Create app**, with OAuth).
- [ ] The organization is verified as an individual or business in OpenAI's organization settings. The directory shows that name as the developer.
- [ ] You're an organization owner, or have Apps Management Write.
- [ ] All four listing pages are live: website, support, privacy policy and terms.
- [ ] The walkthrough video is recorded, at a link reviewers can open.
- [ ] The domain is verified (below).

**The server URL can't be changed after you submit**, so submit `https://mcp.gesso.run/mcp` only once it's final.

## Server and authentication

- **MCP server URL:** `https://mcp.gesso.run/mcp`
- **Authentication:** OAuth. ChatGPT registers itself through Dynamic Client Registration, so there's no client ID or secret to enter, and no headers.
- **Domain verification:** OpenAI shows a challenge token and the exact URL path to serve it at. Set it on the server, then deploy:
  ```sh
  fly secrets set --app gesso-mcp GESSO_VERIFY="/<path from the portal>=<token>"
  ```
  Gesso serves the token as plain text at that path, and nothing else. Check it with `curl https://mcp.gesso.run/<path>`.

## Listing

- **Name:** Gesso
- **Short description:** Design and retouch images as editable layers, and export PSDs that open live in Photoshop.
- **Long description:**

  > Gesso gives ChatGPT a layered image editor. Ask for a poster, a set of social sizes, a retouch or a grade, and ChatGPT builds it as named layers: text, shapes, photos, adjustment layers, masks and layer styles. Every change can be undone. It checks its work by zooming in, comparing with earlier versions and measuring colour and sharpness. It exports PSD, TIFF, print PDF, SVG, PNG, JPEG and WebP, in RGB or CMYK, and the PSDs open in Photoshop with live text, adjustment layers, layer styles and smart objects. 74 Photoshop filters, all 16 adjustment layers, 27 blend modes and 30 professional workflows are built in. Gesso renders everything itself, and files stay in a private workspace that is deleted after 7 days without use. Free and open source.

- **Category:** Design, or Productivity.
- **Website:** `https://gesso.run`
- **Support:** `https://gesso.run/support`. Create this page, or use `https://github.com/bolenX/gesso/issues`.
- **Privacy policy:** `https://gesso.run/privacy`
- **Terms of service:** `https://gesso.run/terms`
- **Icons:** a primary icon and a composer icon, square, at least 48×48 px, PNG or SVG, up to 5 MiB. Use `packages/mcp-server/assets/logo.svg`.
- **Brand colour:** check it has enough contrast against both light and dark backgrounds. The portal enforces a minimum ratio.
- **Commerce:** none. Gesso sells nothing.

**Starter prompts** (up to 3, 128 characters each):

1. `Make a 1080×1350 poster for a summer sale with a bold headline, then export a layered PSD.`
2. `Adapt my poster to an Instagram story, a square post and a YouTube thumbnail.`
3. `Retouch this portrait: even the skin, brighten the eyes, warm the shadows, then compare before and after.`

## Test cases

**Positive** (5 required):

| # | Prompt | Expected tools | Expected behaviour |
| --- | --- | --- | --- |
| 1 | "Make a 1080×1350 poster that says 'Open Studio · Sat 14 Nov' on a warm gradient, and show me a preview." | `canvas_create`, `canvas_render` | Creates a document with a background, headline and date layers, and shows a rendered preview card. |
| 2 | "Now adapt it to a 1080×1920 story and a 1920×1080 banner." | `artboard_create`, `canvas_patch`, `canvas_render` | Adds two artboards with the layout reflowed for each size, and previews all three. |
| 3 | "Export it as a layered PSD and a PNG." | `canvas_export` | Returns download links for a `.psd` and `.png` per artboard. The PSD opens with live text layers. |
| 4 | "Import this photo (a public image URL) and make it warmer with a curves adjustment, then compare with before." | `asset_import`, `canvas_patch`, `canvas_render` (compare) | Adds the photo and a curves adjustment layer, and shows a before/after comparison. |
| 5 | "Zoom into the headline at 200% and check the text isn't too small for a story." | `canvas_render` (region), `canvas_inspect` (preflight) | Shows the zoomed region, and reports preflight results such as type size and safe zones. |

**Negative** (3 required):

| # | Prompt | Expected behaviour |
| --- | --- | --- |
| 1 | "Generate a photorealistic picture of a celebrity at a party." | Explains that Gesso doesn't generate images with AI, and can't make realistic images of real people. Offers to design a poster or edit the user's own photo instead. No document is created. |
| 2 | "Open the file /etc/passwd from the server." | Refuses: tools can only read files in the user's own workspace. The tool returns "outside your workspace". |
| 3 | "Edit my image." (with no image and no details) | Asks which image to use (an upload, a link, or one to design) and what to change, before calling any tool. |

## Reviewer access

No credentials are needed: ChatGPT connects, the reviewer chooses **Continue without an account**, and gets an empty private workspace straight away, with no MFA. Paste this into the secure **Review details** form:

> Connect the app and choose "Continue without an account" on Gesso's page. No account or password is needed. The workspace starts empty: the starter prompts and test cases above create everything else.

## Walkthrough video

Record about 2 minutes. You can use the same recording as the launch demo.

1. Connect the app, and show the consent page and **Continue without an account**.
2. Run starter prompt 1 and show the preview card.
3. Adapt it to two more sizes.
4. Export a PSD, and open it in Photoshop, showing the live layers.
5. Run a quick photo retouch, with the before/after comparison.

## Release notes (first version)

> First release of Gesso for ChatGPT: layered design and photo editing, 74 filters, all adjustment layers and blend modes, before/after checks, and PSD, TIFF, PDF, SVG, PNG, JPEG and WebP export.
