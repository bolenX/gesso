# Claude Connectors Directory: submission kit

Everything the developer portal at [claude.ai/directory/manage](https://claude.ai/directory/manage) asks for, for **Submit new › MCP connector**, ready to paste. The steps follow the portal, as of October 2026. Check the portal itself, because the fields change.

**Before you submit:**
- [ ] `mcp.gesso.run` is deployed and `https://mcp.gesso.run/health` answers (see [deploy/README.md](../../deploy/README.md)).
- [ ] `https://gesso.run/privacy` and `https://gesso.run/terms` are published, from [docs/legal](../legal).
- [ ] You've added `https://mcp.gesso.run/mcp` as a custom connector in claude.ai and called every tool from a conversation. The portal asks you to confirm this.
- [ ] The carousel screenshots are ready (see below).
- [ ] Your account is on a paid Claude plan.

## 1. Connection

- **URL:** `https://mcp.gesso.run/mcp`
- **Users connect to different URLs:** no, everyone uses this one.

## 2. Tools

These sync from the server. Every tool has a `title` and `readOnlyHint`. Tools that change a document or files also have `destructiveHint: true`, so Claude asks before running them.

- **Read-only (7):** `canvas_list`, `canvas_outline`, `canvas_get`, `canvas_render`, `canvas_inspect`, `font_list`, `skill_read`.
- **Write (14):** everything else. `canvas_create`, `psd_import`, `gen_prepare` and `canvas_selection` only create new things or set the selection, so they're marked not destructive.

## 3. Listing

**Server name** (100 max)

> Gesso

**One-liner** (200 max, this is 172)

> Layered design and photo editing for Claude: build posters, social sizes and retouches as editable layers, check them up close, and export PSDs that open live in Photoshop.

**Description** (2,000 max)

> Gesso is an open-source image engine built for agents. Claude builds an image as layers it can name and edit: text, shapes, photos, adjustment layers, masks and layer styles. Every change is a revision you can undo.
>
> What Claude can do with it:
> - Design posters, social posts and banners, then adapt one design to a story, a square and a landscape so each looks designed for its size.
> - Retouch and grade photos non-destructively: curves and levels, colour balance, frequency separation, healing, dodge & burn, sky and colour fixes.
> - Composite with all 27 blend modes, Blend If, luminosity and channel masks, Select and Mask, and every Photoshop layer style.
> - Apply 74 Filter-menu filters as smart filters, plus Liquify, Puppet Warp and Camera Raw.
> - Check its own work: zoom into a region at up to 400%, compare with an earlier version, and measure tones, colour casts, sharpness and clipping like Photoshop's Histogram and Info panels.
> - Export PSD, TIFF, print PDF with bleed, SVG, PNG, JPEG and WebP, in RGB or CMYK. PSDs open in Photoshop with live text, shapes, adjustment layers, layer styles, smart objects and many smart filters.
>
> 30 bundled skills teach Claude professional workflows for beauty, product, real estate, compositing, restoration and graphic design.
>
> Gesso renders every pixel itself and never calls an AI image model. Your files stay in a private workspace that is deleted after 7 days without use. No account is needed: approve the connection and start. Free and open source (Apache-2.0).

**Categories:** Design, and also Productivity or Marketing if offered. Pick from the portal's list.

**Documentation URL:** `https://gesso.run`, or `https://github.com/bolenX/gesso/blob/main/docs/hosting.md`

**Privacy policy URL:** `https://gesso.run/privacy`

**Support contact:** `https://github.com/bolenX/gesso/issues`, or [support email]

**Icon:** `packages/mcp-server/assets/logo.svg`, exported as a square PNG of at least 512 px.

**URL slug:** `gesso`. It's permanent once published.

## 4. Use cases

- **Primary use cases:**
  - Social and marketing graphics in several sizes.
  - Photo retouching and colour grading.
  - Compositing and photo manipulation.
  - Print-ready exports (CMYK, PDF with bleed).
  - Layered PSDs to finish in Photoshop.
- **What users need first:** nothing. No account or plan. They can upload their own photos and fonts on the workspace's upload page.
- **Reads, writes or both:** both, within the user's own Gesso workspace only.

## 5. Company

[company name] · `https://gesso.run` · [primary contact name and email]

## 6. Authentication

- **Authentication requirement:** required. `/mcp` answers 401 until the app signs in.
- **Method:** OAuth 2.1 with Dynamic Client Registration (and Client ID Metadata Documents). Claude registers itself, so there's no client ID or secret to enter.
- **What users see:** Gesso's consent page. They choose **Continue without an account**, which gives a new private workspace. **Continue with GitHub/Google**, when set up on the server, gives the same workspace every time.

## 7. Data handling

- **Underlying API:** our own, first-party. The connector is the Gesso engine itself.
- **Personal health data:** no.
- **Sponsored content:** no.

## 8. Test & launch

**Reviewer instructions** (no credentials needed):

1. Add `https://mcp.gesso.run/mcp` as a connector and click **Connect**.
2. On Gesso's page, choose **Continue without an account**. This creates a private, empty workspace.
3. To fill it with sample work, ask Claude in turn:
   - "Make a 1080×1350 poster that says 'Open Studio, Sat 14 Nov' with a warm gradient background, show me a preview, then export a PNG and a PSD."
   - "Adapt it to a 1080×1920 story and a 1920×1080 banner, and show all three."
   - "Zoom into the headline at 200% and measure the background's colour."
4. Every tool can now be exercised on the "poster" document. For photo tools, use `asset_import` with any public image URL, for example a photo from Wikimedia Commons.

Confirm you've run every tool, with MCP Inspector or as a custom connector.

## 9. Compliance

Read all seven acknowledgements carefully. The one to think about is **AI media generation**:
- Gesso renders images itself, deterministically, like a design tool. Anthropic's criteria allow design tools that produce diagrams, charts and mockups.
- Gesso doesn't generate images with AI models.
- `gen_prepare` only writes files and instructions for an image tool the user has connected separately. Gesso never calls that tool.

If a reviewer treats `gen_prepare` as AI image generation, the server can drop it for the listing with `GESSO_DISABLE_TOOLS=gen_prepare` and a redeploy.

## Allowed link URIs (optional)

Download links and the upload page are on `https://mcp.gesso.run`, and the docs are on `https://gesso.run`. List both so the result card's buttons open without a confirmation prompt:

```
https://mcp.gesso.run
https://gesso.run
```

## Carousel screenshots (MCP App)

Gesso's tools show an interactive result card, so the listing has a carousel. It takes 3–5 PNG images at least 1,000 px wide. Crop each to the card only, with no prompt in the image, and give the prompt separately. Anthropic has a template in the [MCP Apps Figma file](https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude).

| # | Prompt | Screenshot |
| --- | --- | --- |
| 1 | "Make a 1080×1350 poster for an open studio night, with a bold headline and a warm gradient, and show me a preview." | The preview card with the poster |
| 2 | "Adapt this poster to a story and a landscape banner." | The card with all three sizes |
| 3 | "Brighten the skin and warm the shadows on this portrait, then compare with the original." | The before/after comparison |
| 4 | "Export a layered PSD and a print PDF with bleed." | The export card with download buttons |
| 5 | "Zoom into the eyes at 200% and check the sharpness." | The zoomed region with measurements |
