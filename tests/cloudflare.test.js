import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cloudflare, provider } from '../src/cloudflare.js';
const domain = { id: 'zone', zone_id: 'zone', name: 'studio.example' };
const environment = {
  CF_API_TOKEN: 'test-only-placeholder',
  CF_ACCOUNT_ID: 'account',
  INBOUND_WORKER: 'beecloudmail-inbound',
};
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({
      success: status === 200,
      result: data,
      errors: status === 200 ? [] : [{ code: 10000 }],
      result_info: { total_pages: 1 },
    }),
    { status }
  );
async function mockFetch(handler, task) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await task();
  } finally {
    globalThis.fetch = original;
  }
}
test('missing credentials and production hosts cannot use the local mock provider', () => {
  assert.throws(() => provider({ LOCAL_MOCK: 'true', CURRENT_HOST_LOCAL: false }), /credentials/);
  assert.ok(provider({ LOCAL_MOCK: 'true', CURRENT_HOST_LOCAL: true }));
});
test('external MX is reported without any mutating API calls', async () => {
  const calls = [];
  const cf = new Cloudflare(environment);
  await mockFetch(
    async (url, options) => {
      calls.push(options.method);
      const path = new URL(url).pathname;
      if (path.endsWith('/email/routing'))
        return result({ enabled: false, status: 'unconfigured' });
      if (path.endsWith('/email/sending/subdomains')) return result([]);
      if (path.endsWith('/dns_records'))
        return result([
          {
            type: 'MX',
            name: 'studio.example',
            content: 'mx.existing-provider.example',
            priority: 10,
          },
        ]);
      throw new Error('Unexpected API call');
    },
    async () => {
      await assert.rejects(
        cf.enable(domain),
        (error) => error.status === 409 && error.details.mx.length === 1
      );
      assert.ok(calls.every((method) => method === 'GET'));
    }
  );
});
test('DNS readiness compares actual records, and onboarding uses the documented endpoints', async () => {
  const calls = [];
  const cf = new Cloudflare(environment);
  let enabled = false;
  const records = [
    { type: 'MX', name: 'studio.example', content: 'route1.mx.cloudflare.net' },
    {
      type: 'TXT',
      name: 'cf-bounce.studio.example',
      content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
    },
    { type: 'TXT', name: 'cf-bounce._domainkey.studio.example', content: 'v=DKIM1; p=abc' },
    { type: 'TXT', name: '_dmarc.studio.example', content: 'v=DMARC1; p=none' },
  ];
  await mockFetch(
    async (url, options) => {
      const path = new URL(url).pathname;
      calls.push([options.method, path]);
      if (path.endsWith('/email/routing/dns') && options.method === 'POST') {
        enabled = true;
        return result({ enabled: true, status: 'ready' });
      }
      if (path.endsWith('/email/routing'))
        return result({ enabled, status: enabled ? 'ready' : 'unconfigured' });
      if (path.endsWith('/email/sending/subdomains') && options.method === 'POST') {
        assert.equal(JSON.parse(options.body).name, 'studio.example');
        return result({ id: 'sending' });
      }
      if (path.endsWith('/email/sending/subdomains'))
        return result(enabled ? [{ id: 'sending', name: 'studio.example', enabled: true }] : []);
      if (path.endsWith('/subdomains/sending/dns')) return result(records.slice(1));
      if (path.endsWith('/dns_records')) return result(records);
      throw new Error('Unexpected API call');
    },
    async () => {
      const check = await cf.enable(domain);
      assert.equal(check.sendingReady, true);
      assert.equal(check.routingReady, true);
      assert.ok(
        calls.some(([method, path]) => method === 'POST' && path.endsWith('/email/routing/dns'))
      );
    }
  );
});
test('existing address rules are reused only when they target this inbound worker', async () => {
  const cf = new Cloudflare(environment);
  let target = 'beecloudmail-inbound';
  let writes = 0;
  await mockFetch(
    async (url, options) => {
      if (options.method !== 'GET') writes++;
      return result([
        {
          id: 'existing',
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: 'hello@studio.example' }],
          actions: [{ type: 'worker', value: [target] }],
        },
      ]);
    },
    async () => {
      assert.equal(
        await cf.rule(domain, 'hello@studio.example', 'beecloudmail-inbound'),
        'existing'
      );
      target = 'another-worker';
      await assert.rejects(
        cf.rule(domain, 'hello@studio.example', 'beecloudmail-inbound'),
        (error) => error.status === 409
      );
      assert.equal(writes, 0);
    }
  );
});
test('deletion retries tolerate a rule already removed and reject changed routing', async () => {
  const cf = new Cloudflare(environment);
  await mockFetch(
    async () => result(null, 404),
    async () => {
      await cf.removeRule(domain, { address: 'hello@studio.example', routing_rule_id: 'gone' });
    }
  );
  await mockFetch(
    async () =>
      result({
        matchers: [{ value: 'hello@studio.example' }],
        actions: [{ type: 'forward', value: ['someone@example.com'] }],
      }),
    async () => {
      await assert.rejects(
        cf.removeRule(domain, { address: 'hello@studio.example', routing_rule_id: 'changed' }),
        (error) => error.status === 409
      );
    }
  );
});
