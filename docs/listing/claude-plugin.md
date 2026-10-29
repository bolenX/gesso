# Claude directory: plugin submission kit

The plugin listing puts Gesso's skills and its connector in one place, in claude.ai's Discover page, in Cowork, and in Claude Code's `/plugin` directory. Submit it from the same portal as the connector, [claude.ai/directory/manage](https://claude.ai/directory/manage), with **Submit new › Plugin bundle**. Checked against Anthropic's [publishing guide](https://claude.com/docs/plugins/submit) and [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist) in October 2026.

**Before you submit:**
- [ ] `claude plugin validate --strict plugins/gesso` passes. It includes the directory's own pre-submission checks.
- [ ] `node scripts/sync-plugin.mjs --check` passes, so the skills and version match the release.
- [ ] Your account is on a paid plan, and GitHub is connected to claude.ai with push access to `bolenX/gesso`.
- [ ] You've decided about `gen_prepare` (see the [checklist](README.md#before-any-submission)). Skills that mention it may be held for a closer look.

## What's in the plugin

| | |
| --- | --- |
| Folder | `plugins/gesso` |
| Manifest | `plugins/gesso/.claude-plugin/plugin.json` |
| Server | `.mcp.json`: the hosted connector, `https://mcp.gesso.run/mcp` |
| Skills | 31 from `skills/`, copied by the sync script, plus `get-started` |
| Listing fields | `icon` (`./assets/icon.png`), `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, all read from the manifest |

The folder also holds the manifests for Codex, Copilot and Cursor (`plugin.json`, `mcp.json`, `.cursor-plugin/`). Claude ignores them.

## Submit

1. **Repository:** `bolenX/gesso`. **Plugin path:** `plugins/gesso`. **Branch:** `main`.
2. **Validate.** The portal runs the same checks as `claude plugin validate`, plus a security scan.
3. **Listing details.** The name, description and icon come from the manifest. Pick the **Design** category if it's offered.
4. **Data handling.** The plugin connects to Gesso's own server and nothing else. It stores the user's documents and uploads in a private workspace, deleted 7 days after its last use. No personal health data, no sponsored content.
5. **Compliance.** Read the four acknowledgements. For AI media, the answer is the same as the connector's: Gesso renders images itself and calls no model.
6. **Pair it with the connector** listing. Both use the same server URL, so people don't see two copies of Gesso's tools.

**Updates:** a new version is reviewed again. Bump the version with a release and run the sync script; the listing follows the `main` branch. A GitHub push webhook (needs admin access on the repository) makes it pick up changes straight away.

## Limits the plugin keeps to

The tests check these on every change:
- fewer than 512 files, and every file other than images under 256 KiB
- no symlinks, no `.DS_Store`, no top-level `bin/` (claude.ai and Cowork refuse one)
- every skill's `name` matches its folder

## Without the directory

People can install it today, before any review:
- **Claude Code:** `/plugin marketplace add bolenX/gesso`, then `/plugin install gesso@gesso`.
- **claude.ai and Cowork:** **Customize › Plugins › Add › Add marketplace**, then `bolenX/gesso`.
