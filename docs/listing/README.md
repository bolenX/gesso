# Launching hosted Gesso

The order to take hosted Gesso from code to the Claude and ChatGPT directories, and what each step needs. ✅ means it's done in this repository.

## 1. The server

- ✅ OAuth sign-in on one URL, signed links, limits, worker processes, and tool hints (`packages/mcp-server`).
- ✅ Deploy configuration and runbook: [deploy/README.md](../../deploy/README.md).
- ✅ `npx -y gesso-mcp --tunnel`: anyone can use claude.ai and ChatGPT with Gesso today, free, on their own computer.
- ✅ **`mcp.gesso.run` is live,** on an always-on Mac through a Cloudflare Tunnel, set up with `bash deploy/setup-tunnel.sh`. It passed a live end-to-end check from the internet: sign-in, tool calls, render, export, download and revocation.
- [ ] Optional: set up GitHub and Google sign-in, so people get the same workspace every time.
- [ ] Optional, paid only: on Fly.io, save `FLY_API_TOKEN` as a repository secret, so every release deploys itself.

## 2. The website (gesso.run)

The site needs three pages that don't exist yet. Right now `/privacy`, `/terms` and `/support` all show the homepage. Both directories require them.

- [ ] **`/privacy`:** publish [docs/legal/privacy.md](../legal/privacy.md) after filling in the bracketed parts and having it reviewed.
- [ ] **`/terms`:** publish [docs/legal/terms.md](../legal/terms.md), the same way.
- [ ] **`/support`:** a short page. Report problems at `https://github.com/bolenX/gesso/issues`, security issues privately to [security email], and anything else to [contact email].
- [ ] **Install section.** Swap the claude.ai and ChatGPT cards' "Coming soon" for `https://mcp.gesso.run/mcp`. The exact copy is in [install.md](../install.md), in the landing-page tabs table.

## 3. Try it as a custom connector

- [ ] Add `https://mcp.gesso.run/mcp` in claude.ai and in ChatGPT developer mode, and run every tool from a conversation. Both directories ask you to confirm this. Fix anything that goes wrong before submitting.
- [ ] Use it yourself for a week or two, and watch the server's logs for errors and slow tools.

## 4. Submit

- [ ] **Claude Connectors Directory:** [claude-connector.md](claude-connector.md) has every field.
- [ ] **ChatGPT app directory:** [chatgpt-app.md](chatgpt-app.md) has every field, test case and the video plan.
- [ ] **Claude plugin** (local Gesso, separately): bundles the 30 skills with the `npx -y gesso-mcp` server. Still to build.

## Things only you can decide or do

- **Where to host:** which always-on machine runs `mcp.gesso.run`, at $0. Paid hosts are optional.
- **Legal:** who runs the service, the contact emails, governing law, and a lawyer's review of the privacy policy and terms.
- **Sign-in:** whether to require an account (`GESSO_ANONYMOUS=0`), and creating the GitHub and Google OAuth apps.
- **Verification:** verifying your organization with OpenAI, and the paid Claude plan for submitting.
