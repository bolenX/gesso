# Privacy Policy

> **Draft for review, not legal advice.** It describes what the code in this repository does with data. Before publishing it at `gesso.run/privacy`:
> - fill in the bracketed parts
> - check the hosting details against how you actually run the server
> - have it reviewed by a lawyer for the places your users live

**Effective date:** [date]

This policy covers Gesso, the open-source image engine, in two forms:
- **Gesso on your computer:** the `gesso-mcp` npm package, the Claude Desktop extension, and the Claude plugin.
- **Hosted Gesso:** the server at `mcp.gesso.run`, which claude.ai, ChatGPT and other apps connect to.

Gesso is run by [operator name] ("we"). Contact: [contact email].

## Gesso on your computer

Gesso runs entirely on your computer. We don't receive anything from it: there are no accounts, no telemetry and no analytics.

- **Files.** Gesso reads and writes files only in the folder you choose, and in folders your agent names when you allow it.
- **Downloads.** When you or your agent give Gesso the web address of an image or font, Gesso downloads it straight from that site to your computer. That site sees the request.
- **AI jobs.** Gesso never calls an image model. For generative jobs (expand, fill, segment, upscale and the rest), Gesso writes the files to your folder, and your agent sends them to an image tool you've connected. That tool's own terms and privacy policy apply.
- **Installing.** Installing with `npx` downloads the package from npm, under npm's privacy policy.

## Hosted Gesso (mcp.gesso.run)

### What we keep, and for how long

| What | Why | How long |
| --- | --- | --- |
| **Your workspace:** documents and their history, files you upload, images imported from web addresses, exports, and job files | To do what you ask: edit, render and export your images | Deleted automatically 7 days after the workspace was last used, or sooner when you ask |
| **Revoked sign-ins:** random ids of signed-out or replaced tokens | So a signed-out token can't be used again | Until the token would have expired, at most 60 days |
| **Request logs:** time, request type, tool name, result, duration, and a one-way hash of the workspace | To keep the service running and find problems | [up to 30 days] |
| **Addresses (IP):** kept in memory to limit how many workspaces one address can create | To prevent abuse | One hour, in memory only |

The logs never contain your documents, images, prompts or workspace keys.

### Signing in

When you connect an app to hosted Gesso, you approve it on Gesso's sign-in page. You can continue without an account, or sign in with GitHub or Google where that's offered.

- **No account.** You get a new workspace with a random key.
- **GitHub or Google.**
  - We ask that service for your account's id only: no email, repositories or files.
  - We turn the id into your workspace key with a one-way function, and we don't store the id itself.
  - GitHub's or Google's privacy policy applies to signing in with them.
- **Tokens.** The app you connected gets tokens that let it use your workspace. They're encrypted, and we don't store them.
- **Cookie.** While you're signing in, your browser holds one cookie for up to 15 minutes. It makes sure the approval comes from you, not from another website. We use no other cookies.

### Who else is involved

- **Our hosting provider** stores and runs the service for us: [Fly.io, Inc., in the United States]. Its network may also log addresses for security, under its own policy.
- **Websites your agent imports from.** When your agent imports an image from a web address, our server downloads it, so that site sees a request from our server.
- **The app you connect** (for example Claude or ChatGPT) receives what Gesso's tools return, such as previews, measurements and download links. Its own privacy policy covers what it does with them.

We don't sell your data, use it for advertising, or use your content to train AI models. We don't share it with anyone else unless the law requires it.

### Security

- Connections use HTTPS.
- Each workspace is kept separate: tools can't reach other workspaces or our internal network.
- Download and upload links are signed and expire.

No system is perfectly secure. Treat a workspace key like a password, and report security problems to [security contact email].

### Your choices and rights

- **See or download your files.** Use your workspace's upload page, or ask your agent to export.
- **Delete your workspace.** Email [contact email] with the address of a download link from it, or with its key. A workspace left unused is deleted after 7 days anyway.
- **Disconnect an app.** Remove the connector in that app, and it stops using its tokens. To cut off every app at once, ask us to delete your workspace.

Depending on where you live (for example the EU, the UK or California), you may have more rights, such as access, correction, deletion and objection. Contact us to use them. Where the GDPR applies:
- **Your workspace** is processed to provide the service you asked for.
- **Logs and abuse limits** are processed for our legitimate interest in keeping the service secure and working.

### Children

Gesso isn't directed at children under [13]. Don't use hosted Gesso if you're under that age.

## Changes

If we change this policy, we'll update the date at the top. If the changes are significant, we'll also say so on gesso.run.

## Contact

[operator name] · [contact email] · [postal address, if required]
