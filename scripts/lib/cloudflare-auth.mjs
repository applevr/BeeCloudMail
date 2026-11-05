// Shared by the setup helpers: reads your admin configuration and your Wrangler credentials.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

export function readAdminConfig() {
  const file = new URL('wrangler.admin.jsonc', root);
  if (!existsSync(file))
    throw new Error('wrangler.admin.jsonc not found. Run npm run init-config.');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const database = config.d1_databases[0].database_id;
  if (/^0+$/.test(config.account_id || '0') || database.startsWith('00000000')) {
    throw new Error('wrangler.admin.jsonc has placeholder IDs. Run npm run init-config.');
  }
  return config;
}

// Uses Wrangler's own command so the credential location and token refresh stay Wrangler's concern.
export function wranglerToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const wrangler = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', root));
  const result = spawnSync(process.execPath, [wrangler, 'auth', 'token', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  let token;
  try {
    token = JSON.parse(result.stdout).token;
  } catch {
    token = undefined;
  }
  if (result.status !== 0 || !token) throw new Error('Sign in first with: npx wrangler login');
  return token;
}
