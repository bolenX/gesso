# Changelog

Versions of `gesso-mcp`, the npm package and Claude Desktop extension. Each version's notes become its GitHub release.

## 0.12.0 (2026-10-25)

0.12.0 makes Gesso usable from claude.ai and ChatGPT for free: on your own computer with `npx -y gesso-mcp --tunnel`, or on a shared server with sign-in.

- **One-script setup for `mcp.gesso.run`:** on any always-on Mac or Linux computer, `bash deploy/setup-tunnel.sh` installs `cloudflared`, builds Gesso, makes the signing secret, creates the Cloudflare tunnel and its DNS record (after one browser login), installs both as services that start with the computer, and checks the address from the internet. Running it again updates; `--uninstall` removes the services.

- **Sign-in for hosted Gesso:** claude.ai and ChatGPT connect to one URL, `/mcp`, and sign in with OAuth 2.1:
  - Dynamic Client Registration and Client ID Metadata Documents
  - PKCE
  - one-hour access tokens, and refresh tokens that rotate, with reuse detection and revocation
  The consent page gives each person a private workspace. They can connect without an account, sign in with GitHub or Google (if the server sets them up) to get the same workspace each time, or reconnect with a workspace key. Tested end to end with the MCP SDK's own OAuth client.
- **Signed links:** exports come back as `/dl/…` links that open one file without revealing the workspace, and Gesso's instructions give the agent a private upload page for the workspace.
- **Limits and safety for hosted servers:**
  - each workspace has a request rate and concurrency limit, and the whole server has a cap
  - requests are limited in size
  - a ban list for workspaces and accounts
  - rate limits use the address the nearest proxy saw, so a forged `X-Forwarded-For` doesn't get around them
  - one JSON log line per request, never with content or keys
- **claude.ai and ChatGPT from your own computer, free:** `npx -y gesso-mcp --tunnel` runs Gesso on your computer and opens a free Cloudflare quick tunnel, with no account and no server anyone pays for. It prints the address to add as a custom connector, and a pairing code. Connecting signs in with that code, so only you can use it. After 10 wrong codes, pairing pauses for 15 minutes.
  - Tools work in your Gesso folder and can't reach outside it.
  - Answers are plain JSON, which every tunnel passes through.
  - Gesso waits until Cloudflare is actually connected before printing the address, and says so if a firewall blocks the tunnel.
  - `--personal` does the same behind a tunnel you run yourself, such as a named Cloudflare tunnel with a fixed address.
- **`mcp.gesso.run` for free:** `deploy/compose.tunnel.yaml` runs hosted Gesso on any always-on machine behind a Cloudflare Tunnel (no open ports, and HTTPS from Cloudflare). `GESSO_CLIENT_IP_HEADER` reads the visitor's address from Cloudflare's header. The runbook puts this first; paid hosts are optional.
- **Worker processes for hosted servers:** tool calls run in worker processes, one per core up to 4. Each workspace always goes to the same worker, so one long render no longer holds up everyone else, and sign-in, pages and downloads keep answering. A worker that crashes is restarted, and only its requests in flight fail.
- **Deploying hosted Gesso:** `deploy/` has a Fly.io configuration and a Docker Compose setup with Caddy for HTTPS, plus a runbook for `mcp.gesso.run`. It covers the volume, the secret, DNS, GitHub and Google sign-in, logs, bans and costs. A new workflow deploys each release when a `FLY_API_TOKEN` secret is set.
- **Hosted settings:**
  - `GESSO_DISABLE_TOOLS` leaves out tools, for example `gen_prepare` for a directory listing.
  - `GESSO_VERIFY` serves domain-verification files.
- **Launch kit:**
  - `docs/legal` has drafts of a privacy policy and terms of service, written from what the code does with data. They need review before publishing.
  - `docs/listing` has the fields for the Claude Connectors Directory and the ChatGPT app directory, ChatGPT's test cases, and a launch checklist.
- **npm provenance:** packages are published with `--provenance`, now that the repository is public.
- **Tool hints:** every tool has a title and says whether it only reads, or changes documents and files, so hosts can let read-only tools run without asking.
- **Directory readiness:**
  - Gesso no longer asks agents to credit it when handing over files. Exported files still carry Gesso in their metadata.
  - Job instructions no longer name third-party image services.
  - The npm and extension pages link to gesso.run and to GitHub issues for support.

## 0.11.0 (2026-10-25)

0.11.0 gives the agent ways to check its own work, tested recipes for 30 skills, Photoshop's selection and merging tools, and PSDs that keep more of the work live.

### Selections and masks

- **Select and Mask:** every raster, vector and computed mask takes `refine`, Photoshop's Refine Edge. It snaps a rough mask's edge to hair, fur and leaves by estimating each edge pixel's coverage from the nearby subject and background colours. It has `radius`, `smooth`, `contrast`, `shift` and Decontaminate Colors, which replaces the old background's colour in the edge with the subject's own.
- **Calculations:** a new `calculations` mask blends two channels (red, green, blue or gray, from any layer or from everything below) in one of 10 modes, then applies levels. It stays live, like the other computed masks.
- **Masks that follow a photo:** raster masks take `of`, the image layer they were made from. The mask then follows that photo's frame, crop, focus, rotation, flips, skew, distortion and warp, so one selection lines up on an adjustment, a group or the photo itself. They export to PSD as pixel masks.
- **Brush strokes:** vector masks take `stroke`, a width, so a path becomes a round-ended brush stroke along it. Shape strokes take `cap` (butt, round, square) and `join` (miter, round, bevel), and both round-trip through PSD.

### AI jobs on the user's own tools

- **Select Subject, Select Sky and face parts:** `gen_prepare` has a new `segment` job. It takes `targets` like subject, person, sky, background, skin, face, hair, eyes, brows, lips, teeth or clothes, or a short description, and returns one mask per target with a prompt for the user's segmentation, face-parsing or background-removal tool. With `onto`, the ops put the first mask on a layer straight away.
- **Mask import:** `asset_import` with `kind: "mask"` saves a grey mask, from a cut-out's transparency or a black-and-white image's brightness.
- **One plate for every size:** an `expand` job with `artboards` sizes one plate for all of them and places it in each, lined up with the photo. That's one generation, and the same background in every size. Where a frame doesn't fill its artboard, the plate is masked to the frame.
- Job ops are scoped to their artboard, so they work on adapted sizes that share layer ids.

### Merging exposures

- **Auto-Align:** the new `canvas_align` tool lines up layers shot from nearly the same place, by phase correlation, to sub-pixel accuracy. It can also find small zoom (focus breathing) and rotation, and reports a confidence for each layer.
- **Auto-Blend:** the new `canvas_stack` tool blends them with raster masks: `focus` keeps each pixel from the sharpest frame, and `exposure` fuses brackets (Mertens exposure fusion).

### Retouching

- Content-aware fill and healing keep the surrounding grain and texture instead of smoothing it. Before, they kept 60–75% of it; now 95–100%.
- High Pass uses the same blur as Gaussian Blur, as in Photoshop. Frequency separation now rebuilds the original to within ΔE 3 in the tests, dark detail included.
- High Pass has a new `scale` option for 8-bit frequency separation.

### PSD fidelity

- Image layers whose filters all exist in Photoshop export as smart objects with live smart filters, with Fade opacity and blend modes. There are 25 filters, including Gaussian, Box, Motion and Surface Blur, Unsharp Mask, High Pass, Median, Dust & Scratches, Emboss, Mosaic, Twirl, Pinch, Spherize, Polar Coordinates and Offset. Opening the PSD in Gesso brings them back as filters.
- Distorted (quad) image, shape and text layers export as smart objects pinned by their four corners, so text and shapes inside stay editable.
- Warped layers export as smart objects with a Photoshop custom warp, fitted to Gesso's warp surface.
- Photoshop custom warps on smart objects import as Gesso warps.
- PSDs embed an sRGB colour profile.

### Checking work

- **Seeing detail:** `canvas_render` zooms into a region at up to 400%, pixel for pixel, and compares with an earlier revision or with layers hidden. The comparison is side by side or as a difference image, with the share of pixels changed, ΔE and where the changes are.
- **Measuring:** the new `canvas_inspect` tool works like Photoshop's Histogram and Info panels. It reports tonal range, clipping per channel, contrast, colour cast, chroma, sharpness and noise. Its eyedropper gives hex, RGB, HSB, Lab and the vectorscope angle against the skin-tone line. It also returns clipping and sharpness maps. It can measure a region, some layers on their own, or an earlier revision.
- **Preflight:** `canvas_inspect` with `preflight: true` lists:
  - text and logos in a preset's safe zones or off the artboard
  - type too small for the format
  - images enlarged past their pixels
  - hidden or empty layers
- **Photoshop reference kit** (`reference/`): 73 cases (adjustments, blend modes, layer styles and filters) to render in Photoshop. A test scores Gesso against those exports in ΔE, writes a report, and fails if a case gets worse.

### Skills

- 15 new skills: duotone, double exposure, poster composition, typography hierarchy, layout grids, brand application, clean plates, typography reflow, social campaign sets, channel packs, safe zones, extreme-ratio relayout, RTL localisation, resolution adaptation, and data-driven variants.
- Every skill has a `checks.md`.
- 21 skills have recipes (51 in all): proven layer setups that the new `skill_apply` tool fills in and applies as one revision. `skill_read` lists them.
- Each recipe has an example, which applies it to a synthetic photo and checks the result with measurements in the test suite.
- The product, real-estate, beauty, compositing and manipulation skills use the new selection, merging and AI tools.

### Hosting and releases

- **Hosted Gesso** for claude.ai and ChatGPT connectors: `gesso-mcp --hosted` gives every user a private workspace, with a connector URL, an upload page, and download links for exports. Tools stay inside their own workspace, downloads only reach public addresses, renders are size-limited, and idle workspaces are deleted. There's a Dockerfile and a hosting guide.
- **Local HTTP** (`--http`) now listens on 127.0.0.1 only, and its download buttons work across requests.
- **Releases:** every version gets a GitHub release with the Claude Desktop extension attached, under its versioned name and as `gesso.mcpb`.

### Smaller changes

- `set` paths take list indexes and `+` to append, e.g. `filters.+` adds a filter and `filters.0.radius` tunes one.
- The `*` selector matches every layer.
- Filtered layers are cached by their content, so changing one layer doesn't re-run the filters on the others.
- Slice layer names can't write outside the export folder.

## 0.10.0 (2026-10-25)

- **Filters:** Photoshop's Filter menu as smart filters with Fade: Blur and Blur Gallery, Distort, Noise, Pixelate, Render, Sharpen, Stylize, Video and Other, plus Camera Raw, Liquify, Puppet Warp and Lens Correction.
- **Adjustments:** all 16 adjustment layers, including Colour Lookup with `.cube` LUTs, plus Shadows/Highlights, Desaturate, Equalize, Match Colour and Replace Colour.
- **Compositing:** all 27 blend modes, Blend If, and luminosity, colour-range and channel masks.
- **Layer styles:** all ten of Photoshop's layer styles.
- **Shapes and transforms:** boolean shapes, skew, distort, perspective and warp.
- **Retouching:** content-aware fill, healing, clone stamp and content-aware scale.
- **Production:** TIFF and CMYK export with ICC profiles, soft proofing, slices, `canvas_stamp` (stamp visible, merge, rasterize), `canvas_batch` (templates over images or data rows), and find and replace.
- **Skills:** 11 new skills: references for filters, adjustments, compositing, retouching and production, 50 core techniques, and 50 workflows for beauty, product, real estate, photo manipulation and restoration.

## 0.9.0

- SVG export.
- Print PDF with bleed, crop marks and page sizes.
- Text on a path.
- Radial blur, noise, sharpen, twirl, wave, shear and pixelate filters.

## 0.8.0

Glass refraction, path blur and motion blur.

## 0.7.0

Gradient maps and mesh gradients.

## 0.6.0

Background blur, fill opacity and the fractal-glass recipe.

## 0.5.1

Large documents no longer time out on export.

## 0.5.0

- **Documents:** saved to the Gesso folder and listed with `canvas_list`.
- **Layers:** rotation and flips.
- **Tools:**
  - `font_list` finds installed fonts.
  - `asset_import` adds images and fonts from a path, URL or data.
  - `artboard_create` adds sizes from presets, with the adapt-sizes skill.
  - `gen_prepare` prepares jobs for the user's image tools.
  - `psd_import` opens a PSD as an editable document.
- **PSD export:** live vector shapes and layer effects.
- **Text:** mixed styling within a text layer, with runs.
- **Reliability:** golden render tests and a decoded-image cache.

## 0.4.0 and earlier

- **0.4.0:** plain layers are drawn within their own bounds.
- **0.3.x:**
  - the Claude Desktop extension and `GESSO_WORKDIR`
  - install steps for more agents
  - teaching agents the document format
  - large-PSD export fixes
- **0.2.0:** exports as file cards with download buttons.
- **0.1.0:** the first npm release. It has the document format, patches with history, rendering, PSD export with artboards, live text, shapes, adjustments and smart objects.
