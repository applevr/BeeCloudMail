import { createServer } from 'node:http';
import { randomToken } from '../src/security.js';
import { readAdminConfig, wranglerToken } from './lib/cloudflare-auth.mjs';
const config = readAdminConfig();
const account = config.account_id;
const oauth = wranglerToken();
const nonce = randomToken(),
  port = 8982;
const page = (error) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeeCloudMail · Cloudflare connection</title><style>body{font:15px/1.6 system-ui;background:#f2f5ec;color:#254633;margin:0;display:grid;place-items:center;min-height:100vh}form{background:white;padding:30px;border-radius:14px;width:min(560px,90vw)}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:10px;border:1px solid #d5dece;border-radius:7px;font:inherit}button{background:#176b50;color:white}li{margin:6px 0}</style></head><body><form method="POST" action="/setup"><h2>Connect Cloudflare</h2><p>Create a custom API token named <strong>BeeCloudMail Panel</strong> in <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Cloudflare API Tokens</a>.</p><p>Restrict account resources to your account and zone resources to the domains you want this panel to manage.</p><ul><li>Zone: Zone — Read</li><li>Zone: DNS — Read</li><li>Zone: Zone Settings — Edit</li><li>Zone: Email Routing Rules — Edit</li><li>Account: Email Sending — Edit</li><li>Account: Email Routing Addresses — Read</li></ul><p>${error || `Paste the token below. It will be stored only as an encrypted secret on ${config.name}, never in source files or logs.`}</p><input type="hidden" name="csrf" value="${nonce}"><label>Cloudflare API token<input name="token" type="password" autocomplete="off" required maxlength="512"></label><button>Validate and save token</button></form></body></html>`;
let busy = false;
async function api(path, token, method = 'GET', body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error('Cloudflare denied the request.');
  return data.result;
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  if (request.headers.host !== `127.0.0.1:${port}`) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  if (request.method === 'GET' && request.url === '/') {
    response.end(page());
    return;
  }
  if (request.method !== 'POST' || request.url !== '/setup') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  if (busy) {
    response.writeHead(409);
    response.end('Setup is already in progress.');
    return;
  }
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) throw new Error('Request too large.');
    }
    const values = new URLSearchParams(body),
      token = (values.get('token') || '').trim();
    if (values.get('csrf') !== nonce) {
      response.writeHead(403);
      response.end('Reload this page.');
      return;
    }
    if (token.length < 20 || token.length > 512) {
      response.writeHead(400);
      response.end(page('Enter the complete API token.'));
      return;
    }
    busy = true;
    const zones = await api(`/zones?account.id=${account}&per_page=5`, token);
    if (!zones.length) throw new Error('The token must include at least one domain.');
    const zone = zones[0].id;
    await Promise.all([
      api(`/zones/${zone}/dns_records?per_page=5`, token),
      api(`/zones/${zone}/email/routing`, token),
      api(`/zones/${zone}/email/routing/rules?per_page=5`, token),
      api(`/zones/${zone}/email/sending/subdomains`, token),
      api(`/accounts/${account}/email/routing/addresses?per_page=5`, token),
    ]);
    await api(`/accounts/${account}/workers/scripts/${config.name}/secrets`, oauth, 'PUT', {
      name: 'CF_API_TOKEN',
      text: token,
      type: 'secret_text',
    });
    response.end(
      `<h2>Cloudflare connected.</h2><p>Read permissions were verified. Onboarding will also check write permissions when you enable a domain.</p><p><a href="https://${config.vars.PANEL_HOST}/">Open control panel</a></p>`
    );
    console.log(
      `Cloudflare runtime token saved securely to ${config.name}. No credential was printed or written locally.`
    );
    server.close();
  } catch {
    busy = false;
    response.writeHead(400);
    response.end(
      page(
        'Validation failed. Check token permissions, account and zone scope, then retry. No credential was printed.'
      )
    );
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Cloudflare token setup: http://127.0.0.1:${port}`)
);
setTimeout(() => server.close(), 1800000).unref();
