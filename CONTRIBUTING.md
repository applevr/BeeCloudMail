# Contributing

Thanks for helping out. Testing on a real domain and reporting what happened is one of the most useful contributions right now.

## Set up

You need Node.js 24 or newer. Follow [Try it locally](README.md#try-it-locally); you don't need a Cloudflare account.

## Project layout

| Path                | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `src/worker.js`     | Webmail API, sending, and handling of incoming mail      |
| `src/admin.js`      | Admin panel API                                          |
| `src/cloudflare.js` | Cloudflare API calls, and the mock for the local demo    |
| `src/mail-html.js`  | Email HTML sanitizing and rendering                      |
| `src/security.js`   | Passwords, sessions, and security headers                |
| `src/local.js`      | Local preview entry point. Never deploy this             |
| `public/`, `panel/` | Webmail and panel frontends, with no build step          |
| `migrations/`       | D1 schema                                                |
| `scripts/`          | Local demo and setup helpers                             |
| `tests/`            | Tests, using an in-memory database and fake mail storage |

## Before you open a pull request

```bash
npm run format
```

```bash
npm run check
```

```bash
npm run build
```

Also:

- Add a test for any bug fix or behavior change.
- Keep pull requests focused on one thing. For a large change, open an issue first to agree on the approach.
- Add schema changes as a new file in `migrations/`. Never edit a migration that has already shipped.
- Don't commit your `wrangler.*.jsonc` files, account IDs, domains, tokens or real email content. Use `example.com` or `*.example` in tests.
- Keep dependencies to a minimum. Explain why in the pull request if you add one.

## Rules worth protecting

These are easy to break by accident, so please keep them in mind when you review or write code:

- Every message or file lookup must be limited to the signed-in mailbox.
- Email content is untrusted. Render it only inside the sandboxed iframe, and keep remote images opt-in.
- Save incoming mail before doing anything else that can fail.
- Never automatically resend a message whose delivery status is unknown.
- Never replace another provider's MX records or an existing routing rule automatically.
- Only the Admin Worker may hold the Cloudflare API token.
