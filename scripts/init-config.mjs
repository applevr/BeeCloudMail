// Creates wrangler.{webmail,admin,inbound}.jsonc from the tracked examples. The generated files are
// ignored by git because they identify your Cloudflare account.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const usage = `Usage: npm run init-config -- --account-id <id> --database-id <uuid> --domain <domain>

  --account-id   Cloudflare account ID (32 hex characters)
  --database-id  ID of your D1 database (from: npx wrangler d1 create beecloudmail)
  --domain       Domain that hosts the apps: serves mail.<domain> and panel.<domain>
  --force        Replace existing configuration files`;

const { values } = parseArgs({
  options: {
    'account-id': { type: 'string' },
    'database-id': { type: 'string' },
    domain: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});
const account = values['account-id'] || '';
const database = values['database-id'] || '';
const domain = (values.domain || '').toLowerCase();
const valid =
  /^[a-f0-9]{32}$/.test(account) &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(database) &&
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
if (!valid) {
  console.error(usage);
  process.exit(1);
}

const surfaces = ['webmail', 'admin', 'inbound'];
const target = (surface) => new URL(`../wrangler.${surface}.jsonc`, import.meta.url);
const existing = surfaces.filter((surface) => existsSync(target(surface)));
if (existing.length && !values.force) {
  console.error(
    `Configuration already exists for: ${existing.join(', ')}. Use --force to replace.`
  );
  process.exit(1);
}

for (const surface of surfaces) {
  const example = new URL(`../wrangler.${surface}.example.jsonc`, import.meta.url);
  const text = readFileSync(example, 'utf8')
    .replaceAll('00000000000000000000000000000000', account)
    .replaceAll('00000000-0000-0000-0000-000000000000', database)
    .replaceAll('example.com', domain);
  writeFileSync(target(surface), text);
}
console.log(`Wrote configuration for mail.${domain} and panel.${domain}.`);
