import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { digest, passwordHash, randomToken } from '../src/security.js';
export const demoPassword = 'local-demo-only-2026';
const hash = `salt:100000:${await passwordHash(demoPassword, 'salt')}`;
export async function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_suite.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      let params = [];
      return {
        bind(...args) {
          params = args;
          return this;
        },
        async first() {
          return statement.get(...params) || null;
        },
        async all() {
          return { results: statement.all(...params) };
        },
        async run() {
          return statement.run(...params);
        },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const objects = new Map();
  const sent = [];
  const calls = [];
  const provider = {
    async zones() {
      return [
        { id: 'zone-a', name: 'studio.example' },
        { id: 'zone-b', name: 'games.example' },
      ];
    },
    async check() {
      return { sendingReady: true, routingReady: true, externalMx: [] };
    },
    async enable(domain) {
      calls.push(['enable', domain.name]);
      return this.check(domain);
    },
    async rule(domain, address) {
      calls.push(['rule', address]);
      return `rule-${address}`;
    },
    async removeRule(domain, mailbox) {
      calls.push(['remove', mailbox.address]);
    },
    async verifyForward() {
      return true;
    },
  };
  const env = {
    DB: db,
    MAIL_HOST: 'mail.example.invalid',
    PANEL_HOST: 'panel.example.invalid',
    INBOUND_WORKER: 'beecloudmail-inbound',
    TEST_PROVIDER: provider,
    ASSETS: {
      async fetch() {
        return new Response('assets');
      },
    },
    EMAIL: {
      async send(data) {
        sent.push(data);
        return { messageId: '<sent@example.com>' };
      },
    },
    MAIL_STORAGE: {
      async put(key, value) {
        objects.set(key, value);
      },
      async get(key) {
        const value = objects.get(key);
        if (value === undefined) return null;
        return {
          body: value,
          async json() {
            return JSON.parse(value);
          },
        };
      },
      async list({ prefix, limit = 500, cursor }) {
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
          .sort();
        return {
          objects: keys.slice(0, limit).map((key) => ({ key })),
          truncated: keys.length > limit,
          cursor: keys[limit - 1],
        };
      },
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    },
  };
  for (const [id, name] of [
    ['zone-a', 'studio.example'],
    ['zone-b', 'games.example'],
  ])
    await db
      .prepare(
        "INSERT INTO domains(id,name,zone_id,state,sending_ready,routing_ready,updated_at) VALUES (?,?,?,'ready',1,1,?)"
      )
      .bind(id, name, id, new Date().toISOString())
      .run();
  const mailboxes = [];
  const tokens = [];
  for (const [domain, address] of [
    ['zone-a', 'hello@studio.example'],
    ['zone-b', 'support@games.example'],
  ]) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO mailboxes(id,domain_id,address,display_name,password_hash,status,created_at) VALUES (?,?,?,?,?,'active',?)"
      )
      .bind(id, domain, address, address, hash, new Date().toISOString())
      .run();
    const token = randomToken();
    await db
      .prepare('INSERT INTO mailbox_sessions(token_hash,mailbox_id,expires_at) VALUES (?,?,?)')
      .bind(await digest(token), id, Math.floor(Date.now() / 1000) + 3600)
      .run();
    mailboxes.push({ id, address, domain_id: domain });
    tokens.push(token);
  }
  const adminToken = randomToken();
  await db
    .prepare('INSERT INTO admin_users(id,username,password_hash) VALUES (?,?,?)')
    .bind('admin', 'admin', hash)
    .run();
  await db
    .prepare('INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES (?,?,?)')
    .bind(await digest(adminToken), 'admin', Math.floor(Date.now() / 1000) + 3600)
    .run();
  return { env, sql, db, objects, sent, calls, provider, mailboxes, tokens, adminToken };
}
export function request(path, token, body, admin = false, method, extra = {}) {
  const origin = admin ? 'https://panel.example.invalid' : 'https://mail.example.invalid';
  return new Request(origin + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      Origin: origin,
      Cookie: `${admin ? 'cm_admin' : 'cm_session'}=${token || ''}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
