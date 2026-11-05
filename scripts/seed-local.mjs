import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { passwordHash } from '../src/security.js';
const root = new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url);
const files = existsSync(root)
  ? readdirSync(root).filter((file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
  : [];
if (!files.length)
  throw new Error('Initialize the suite local database with npm run db:local first.');
// Older local databases may remain here; db:local has just migrated the newest one.
const newest = files.sort(
  (a, b) => statSync(new URL(b, root)).mtimeMs - statSync(new URL(a, root)).mtimeMs
)[0];
const db = new DatabaseSync(new URL(newest, root));
// Disposable local fixture. This never reads Cloudflare credentials or calls its APIs.
const hash = `local-demo-salt:100000:${await passwordHash('local-demo-only-2026', 'local-demo-salt')}`;
db.prepare(
  'INSERT INTO admin_users(id,username,password_hash) VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash'
).run('local-admin', 'admin', hash);
for (const [id, name] of [
  ['demo-zone-one', 'studio.example'],
  ['demo-zone-two', 'games.example'],
])
  db.prepare(
    "INSERT INTO domains(id,name,zone_id,state,updated_at) VALUES (?,?,?,'discovered',?) ON CONFLICT(id) DO NOTHING"
  ).run(id, name, id, new Date().toISOString());
db.close();
console.log(
  'Local demo initialized. See README for disposable demo credentials. No production resources were changed.'
);
