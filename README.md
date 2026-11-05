# BeeCloudMail

Real mailboxes for all the domains in your Cloudflare account, with webmail and an admin panel. No servers to run: everything runs on Cloudflare Workers, D1 and R2.

> **Early project.** Receiving, sending, replying and attachments have been tried on one real deployment with Gmail. Forwarding and sign-up or password-reset emails from other services have not been tested yet. Don't make this your only mailbox for now. Reports from real deployments are very welcome.

## Why this project

BeeCloudMail was built for running several online stores. Each domain needs only a few mailboxes: one to support customers, others to sign up for store, payment and bank accounts.

Email forwarding handles the receiving, but when a customer has a problem with an order, you need to answer from the store's own address. BeeCloudMail gives each of those addresses a real inbox that can reply, all from one place:

- **Domain onboarding from the panel.** Discover your domains, check DNS, and enable email. If a domain already receives mail through another provider, onboarding stops and shows the conflicting MX records instead of replacing them.
- **Separate mailboxes.** Each mailbox has its own login, messages and files. Tests cover access between mailboxes.
- **Careful with untrusted mail.** HTML renders in a sandboxed iframe with no scripts, and remote images stay blocked until you choose to load them.
- **Careful when sending.** A repeated send attempt can't send a second copy, and an unknown result is reported as unknown rather than retried.
- **Small.** Plain JavaScript, no frontend framework or frontend build step, two runtime dependencies.

## What it does

**Webmail:** sign in with your full email address; inbox, sent and trash; search; HTML and plain-text reading; reply with quoted content; attachments; download the original EML.

**Admin panel:** sync domains; check and enable email; create mailboxes and retry incomplete ones; reset passwords; suspend, forward and delete mailboxes; view the audit log.

**Not available yet:** Cc/Bcc, reply all, drafts, threaded view, spam filtering, permanent delete, IMAP/POP3, changing your own password, 2FA or passkeys, and inline (CID) images in older messages.

## How it works

```mermaid
flowchart LR
  sender[Internet mail] --> routing[Cloudflare Email Routing]
  routing --> inbound[Inbound Worker]
  user[Mailbox user] --> webmail[Webmail Worker]
  owner[Administrator] --> admin[Admin Worker]
  webmail --> send[Cloudflare Email Sending]
  admin --> api[Cloudflare API]
  inbound --> db[(D1: metadata)]
  inbound --> r2[(R2: mail and files)]
  webmail --> db
  webmail --> r2
  admin --> db
  admin --> r2
```

The Cloudflare API token is available only to the Admin Worker. Only the Webmail Worker can send mail.

## Costs and requirements

- A Cloudflare account, with your domains using Cloudflare DNS.
- **Workers Paid is required to send to any recipient.** It includes 3,000 emails per month, then $0.35 per 1,000. Receiving through Email Routing is available on the free plan. See [Cloudflare's pricing](https://developers.cloudflare.com/email-service/platform/pricing/) for current details.
- [Email Sending](https://developers.cloudflare.com/email-service/) is in beta and Cloudflare presents it as a transactional email service. Limits and terms may change, so check that it suits your use.
- Node.js 24 or newer.

## Get the code

You need this for both the local demo and a real deployment.

```bash
git clone https://github.com/applevr/BeeCloudMail.git
```

```bash
cd BeeCloudMail
```

```bash
npm ci
```

## Try it locally

No Cloudflare account needed. The demo uses local storage and simulated Cloudflare responses, and sends no mail.

```bash
npm run db:local
npm run seed:local
npm run dev
```

|         |                              |                                      |
| ------- | ---------------------------- | ------------------------------------ |
| Panel   | http://127.0.0.1:8788/panel/ | `admin` / `local-demo-only-2026`     |
| Webmail | http://127.0.0.1:8788/       | Created by the smoke test, see below |

With the dev server running, `npm run smoke:local` creates two demo mailboxes, delivers a sample message and checks access control. You can then sign in as `hello@studio.example` or `support@games.example`, with the same password.

The demo password is public, so it must never be used on a real deployment.

## Deploy

> This guide has been run from a fresh clone on a Cloudflare account that already used Workers and R2, but not yet on a brand-new account. If a step fails, please open an issue with what you saw.

Run these commands from the project folder, after completing [Get the code](#get-the-code). Your domains must be active on the Cloudflare account you sign in with.

**1. Create the resources**

```bash
npx wrangler login
```

```bash
npx wrangler d1 create beecloudmail
```

The output of this command includes a `database_id`. Keep it for step 2.

```bash
npx wrangler r2 bucket create beecloudmail
```

Both commands also print a configuration snippet. You can ignore it, because step 2 generates the configuration for you. If Wrangler says R2 isn't enabled, enable it in the Cloudflare dashboard and run the command again.

**2. Generate your configuration**

The apps are served from `mail.<domain>` and `panel.<domain>`. Make sure neither hostname is already in use. The generated `wrangler.*.jsonc` files are ignored by git.

```bash
npm run init-config -- --account-id <account-id> --database-id <database-id> --domain <domain>
```

- `<account-id>`: run `npx wrangler whoami` and copy the 32-character Account ID.
- `<database-id>`: the `database_id` from step 1.
- `<domain>`: the domain that hosts the apps, without `mail.` or `panel.`, for example `example.com`.

**3. Create the tables and deploy the Workers**

```bash
npx wrangler d1 migrations apply DB --remote -c wrangler.webmail.jsonc
```

```bash
npx wrangler deploy -c wrangler.inbound.jsonc
```

```bash
npx wrangler deploy -c wrangler.webmail.jsonc
```

```bash
npx wrangler deploy -c wrangler.admin.jsonc
```

The inbound Worker reports `No targets deployed`. That's expected, because it only receives mail. A new `mail.` or `panel.` hostname can take a few minutes to open on your machine.

**4. Set the administrator password**

This starts a setup page on your own machine and prints its address. Open that address and choose a password of at least 14 characters. The username is always `admin`. The page stores only a password hash, and it won't replace an existing administrator.

```bash
npm run set-admin
```

**5. Connect the panel to Cloudflare**

This starts a local page and prints its address. Create a custom token at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) with these permissions, then paste it into the page. Don't use a Global API Key.

| Group   | Permission              | Access |
| ------- | ----------------------- | ------ |
| Account | Email Routing Addresses | Read   |
| Account | Email Sending           | Edit   |
| Zone    | Zone                    | Read   |
| Zone    | DNS                     | Read   |
| Zone    | Zone Settings           | Edit   |
| Zone    | Email Routing Rules     | Edit   |

Limit the token to your account. For zones, choose either the specific domains the panel should manage, or all zones in the account if you want new domains to appear automatically. The second option gives the panel more reach if it's ever compromised.

The page checks read access, then stores the token as a secret on the Admin Worker. Write access is checked when you enable a domain.

```bash
npm run set-token
```

**6. Add your first mailbox**

Sign in to `https://panel.<domain>/` with the username `admin` and the password from step 4, choose **Sync domains**, enable email on a domain, and create a mailbox. Then sign in at `https://mail.<domain>/` and send yourself a test in both directions.

We recommend also putting the panel behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/), because it has a single administrator and no 2FA yet.

**If something stops you**

- **A domain shows conflicting MX records:** it receives mail through another provider. Removing those records stops delivery to that provider, so move your mail first, then enable the domain again.
- **A mailbox says a routing rule already uses its address:** open Email Routing for that domain in Cloudflare, and remove or change the rule for that address.
- **Sync doesn't show a domain:** check that the domain is active and that your token's zone resources include it.

## Good to know

- **Sign-in limits:** 10 failed attempts per IP and 50 per account in 15 minutes. Someone deliberately failing sign-ins from many IPs can temporarily block one account, but not others.
- **Sender shown:** the inbox shows the address in the `From` header. If the delivering domain differs, the reader shows `via <domain>`. A `via` you don't expect can be a sign of a forged sender.
- **Forwarding:** destinations must be verified in Cloudflare first. Messages are saved before forwarding, so a failed forward doesn't lose mail, and the reader shows a warning.
- **Storage:** messages in Trash are kept, and nothing is deleted automatically. Deleting a mailbox removes its messages and files.
- **Size limits:** incoming messages up to 25 MB; outgoing attachments up to 2.5 MB in total.

## Development

```bash
npm run check
```

```bash
npm run format
```

```bash
npm run build
```

`npm run check` runs syntax checks and the tests. `npm run build` bundles all three Workers without publishing them.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
