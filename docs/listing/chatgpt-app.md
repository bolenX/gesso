# OpenAI plugin directory (ChatGPT and Codex): submission kit

OpenAI's app directory is now its plugin directory. One listing reaches both ChatGPT and Codex, and it's submitted as a ZIP of the plugin at [platform.openai.com/plugins](https://platform.openai.com/plugins). This follows OpenAI's [submission guide](https://developers.openai.com/plugins/deploy/submission) and [App Submission Guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) as of October 2026. Check them too, because the details change.

**Before you submit:**
- [ ] `mcp.gesso.run` works in ChatGPT developer mode (**Settings › Apps › Advanced settings › Developer mode › Create app**, with OAuth), and you've run every tool from a conversation.
- [ ] Your organization is verified as an individual or business in OpenAI's organization settings. The directory shows that name as the developer.
- [ ] You're an organization owner, or have the Apps Management Write role.
- [ ] `developerName` in `plugins/gesso/plugin.json` matches your verified name, and `category` matches one of the dashboard's categories.
- [ ] The walkthrough video is recorded, at a link reviewers can open.

**The server URL can't be changed after you submit** (only OpenAI support can), so submit `https://mcp.gesso.run/mcp` only once it's final.

## What's ready

Everything the review reads is in `plugins/gesso/plugin.json`, under `extensions.com.openai`, and the tests check it against OpenAI's limits:

| | |
| --- | --- |
| Listing | `displayName` "Gesso", `shortDescription` "Layered images, editable PSDs" (30 characters at most), `longDescription`, `category`, website, support, privacy and terms URLs |
| Starter prompts | `defaultPrompt`: three, 128 characters at most |
| Icons | `logo` `./assets/icon.png` (512 px), `composerIcon` `./assets/icon.svg` |
| Brand colours | `#FF4F1A`, and `#FF6430` on dark, both above the 2:1 contrast minimum |
| Onboarding | `skills/get-started/SKILL.md` |
| Test cases | the 5 positive and 3 negative cases the review needs, below |
| Tool hints | every tool states `readOnlyHint`, `destructiveHint` and `openWorldHint` |
| Result card | the MCP App resource, which ChatGPT renders; it declares an empty CSP, since it loads nothing from the web |

## 1. Build the ZIP

```sh
node scripts/build-openai-plugin.mjs --demo https://<your video link>
```

It writes `dist/gesso-openai-<version>.zip`. Compared with the plugin folder, the ZIP:
- declares the server's sign-in as OAuth with Dynamic Client Registration, so there's no client ID or secret (`mcp.json` in the repository can't carry it, because the Agent Plugins schema Copilot and Cursor read doesn't allow the field)
- adds the video link as `demo_recording_url`
- leaves out the Claude and Cursor manifests

## 2. Verify the domain

OpenAI shows a challenge token. Serve it at `https://mcp.gesso.run/.well-known/openai-apps-challenge`:

1. On the Mac, open `~/.gesso/server/server.env` in a text editor and add a line:
   ```
   GESSO_VERIFY="/.well-known/openai-apps-challenge=<token>"
   ```
   Don't paste that file anywhere: it holds the server's signing secret.
2. Restart the server: `cd ~/gesso && bash deploy/setup-tunnel.sh`.
3. Check it: `curl https://mcp.gesso.run/.well-known/openai-apps-challenge` prints the token and nothing else.

## 3. Upload and submit

1. Upload the ZIP at [platform.openai.com/plugins](https://platform.openai.com/plugins), and fix anything the validation or skill scan finds.
2. Connect the server. ChatGPT registers itself and opens Gesso's sign-in page: choose **Continue without an account**.
3. **Review details** (a secure form): no credentials are needed. Paste:
   > Connect the app and choose "Continue without an account" on Gesso's page. No account or password is needed. The workspace starts empty: the starter prompts and test cases create everything else.
4. Submit, and publish once it's approved. Reviews have taken from two weeks to three months, and OpenAI calls the directory a beta.

## Test cases

They're in the manifest, so they import with the ZIP; the dashboard can't edit them. Change them in `plugin.json` and upload again.

**Positive:**

| # | Prompt | Tools | Expected |
| --- | --- | --- | --- |
| 1 | "Make a 1080×1350 poster that says 'Open Studio · Sat 14 Nov' on a warm gradient, and show me a preview." | `canvas_create`, `canvas_render` | A document with background, headline and date layers, and a preview card |
| 2 | "Now adapt it to a 1080×1920 story and a 1920×1080 banner." | `artboard_create`, `canvas_patch`, `canvas_render` | Two more artboards, laid out for their sizes, and all three previewed |
| 3 | "Export it as a layered PSD and a PNG." | `canvas_export` | Download links for a `.psd` and a `.png` per artboard |
| 4 | "Import this photo from (Wikimedia's Example.jpg), make it warmer with a curves adjustment, then compare with before." | `asset_import`, `canvas_patch`, `canvas_render` | The photo, a curves layer, and a before and after comparison |
| 5 | "Zoom into the headline at 200% and check the text isn't too small for a story." | `canvas_render`, `canvas_inspect` | The zoomed region, and preflight results for type size and safe zones |

**Negative:**

| # | Prompt | Expected |
| --- | --- | --- |
| 1 | "Generate a photorealistic picture of a celebrity at a party." | Explains that Gesso doesn't generate images with AI, and offers to design a poster or edit the user's own photo. No document is created. |
| 2 | "Open the file /etc/passwd from the server." | Refuses: tools only read the user's own workspace, and return "outside your workspace". |
| 3 | "Edit my image." (with no image and no details) | Asks which image and what to change, before calling any tool. |

## Walkthrough video

About 2 minutes. The same recording can be the launch demo.

1. Connect the app, and show the sign-in page and **Continue without an account**.
2. Run starter prompt 1 and show the preview card.
3. Adapt it to two more sizes.
4. Export a PSD, and open it in Photoshop, showing the live layers.
5. A quick photo retouch, with the before and after comparison.

## Codex without the directory

Codex users can install the plugin today: `codex plugin marketplace add bolenX/gesso`, then `/plugins`. The marketplace file is `.agents/plugins/marketplace.json`.

## Release notes (first version)

> First release of Gesso for ChatGPT and Codex: layered design and photo editing, all 121 Filter-menu filters, every adjustment layer and blend mode, a masking engine for hair and glass, before and after checks, and PSD, TIFF, PDF, SVG, PNG, JPEG and WebP export.
