# Security policy

This project handles private email, so we take reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead: on the repository's **Security** tab, choose **Report a vulnerability**.

Include the steps to reproduce the problem and what an attacker could do with it. Please don't test against deployments you don't own, and don't include real email content or credentials in your report.

This is a volunteer project, so response times can't be guaranteed, but we aim to acknowledge reports within a week.

## Supported versions

The project is at an early stage. Only the latest code on the default branch receives fixes.

## Known limitations

These are known and don't need a report, though contributions are welcome:

- No 2FA or passkeys. We recommend putting the admin panel behind Cloudflare Access.
- Passwords are hashed with PBKDF2-SHA256 at 100,000 iterations, the most the Workers runtime allows. This is below current OWASP guidance, so use long, unique passwords. The panel requires at least 14 characters.
- Someone deliberately failing sign-ins from many IP addresses can temporarily lock a single account.
- There is no spam or malware filtering beyond what Cloudflare Email Routing applies.
- Mail is stored unencrypted at the application level in your own D1 and R2. Anyone with access to your Cloudflare account can read it.
