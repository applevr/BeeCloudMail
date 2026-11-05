import { createServer } from 'node:http';
import { passwordHash, randomToken } from '../src/security.js';
import { readAdminConfig, wranglerToken } from './lib/cloudflare-auth.mjs';
const config = readAdminConfig();
const account = config.account_id;
const database = config.d1_databases[0].database_id;
const oauth = wranglerToken();
async function query(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${oauth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    }
  );
  const data = await response.json();
  if (!response.ok || !data.success)
    throw new Error('Cloudflare could not configure the administrator.');
  return data.result[0].results;
}
if ((await query('SELECT id FROM admin_users LIMIT 1')).length)
  throw new Error(
    'An administrator already exists. This initial setup does not reset existing accounts.'
  );
const nonce = randomToken();
const port = 8981;
const page = (error) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeeCloudMail · Administrator setup</title><style>body{font:15px/1.7 system-ui;background:#f2f5ec;color:#254633;margin:0;display:grid;place-items:center;min-height:100vh}form{background:white;padding:35px;border-radius:14px;width:min(380px,90vw)}label{display:block;margin-top:18px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:8px;border:1px solid #d5dece;border-radius:7px;font:inherit}button{background:#176b50;color:white;margin-top:25px}</style></head><body><form method="POST" action="/setup"><h2>Create your administrator</h2><p>Administrator username: <strong>admin</strong></p><p>${error || 'Choose a strong password. It will not be printed or saved in the source.'}</p><input type="hidden" name="csrf" value="${nonce}"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></label><button>Create administrator</button></form></body></html>`;
let busy = false;
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
    const values = new URLSearchParams(body);
    const password = values.get('password') || '';
    if (values.get('csrf') !== nonce) {
      response.writeHead(403);
      response.end('Reload the setup page.');
      return;
    }
    if (password.length < 14 || password.length > 256 || password !== values.get('confirm')) {
      response.writeHead(400);
      response.end(page('Use 14–256 characters and confirm the same password.'));
      return;
    }
    busy = true;
    const salt = randomToken();
    const hash = `${salt}:100000:${await passwordHash(password, salt)}`;
    await query('INSERT INTO admin_users(id,username,password_hash) VALUES (?,?,?)', [
      crypto.randomUUID(),
      'admin',
      hash,
    ]);
    response.end('<h2>Administrator created.</h2><p>You can now sign in to the control panel.</p>');
    console.log('Administrator configured successfully. No password was printed or saved locally.');
    server.close();
  } catch {
    busy = false;
    response.writeHead(500);
    response.end(page('Could not create the administrator. Check your configuration and retry.'));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Administrator setup: http://127.0.0.1:${port}`)
);
setTimeout(() => server.close(), 1800000).unref();
