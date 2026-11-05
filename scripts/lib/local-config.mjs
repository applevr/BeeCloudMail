// Generates the configuration for the local preview. It never reads your real configuration, so
// the preview cannot touch production resources.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

export function writeLocalConfig() {
  const preview = new URL('.dev/preview/', root);
  mkdirSync(preview, { recursive: true });
  cpSync(new URL('public/', root), preview, { recursive: true });
  cpSync(new URL('panel/', root), new URL('panel/', preview), { recursive: true });

  const config = JSON.parse(readFileSync(new URL('wrangler.webmail.example.jsonc', root), 'utf8'));
  delete config.routes;
  delete config.account_id;
  config.name = 'beecloudmail-local';
  config.main = 'src/local.js';
  config.assets.directory = '.dev/preview';
  config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000001';
  Object.assign(config.vars, {
    MAIL_HOST: 'mail.example.invalid',
    PANEL_HOST: 'panel.example.invalid',
    CF_ACCOUNT_ID: '',
    LOCAL_MOCK: 'true',
  });
  writeFileSync(new URL('wrangler.local.jsonc', root), JSON.stringify(config, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeLocalConfig();
