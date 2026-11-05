import { HttpError } from './worker.js';
export class Cloudflare {
  constructor(env) {
    this.env = env;
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
      throw new HttpError(503, 'Cloudflare credentials have not been configured.');
  }
  async request(path, method = 'GET', body) {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new HttpError(
        response.status === 403 ? 403 : 502,
        `Cloudflare could not complete this operation (${result.errors?.[0]?.code || response.status}). Check permissions and retry.`
      );
    return result;
  }
  async pages(path) {
    const output = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(
        `${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`
      );
      output.push(...data.result);
      if (page >= (data.result_info?.total_pages || 1)) break;
    }
    return output;
  }
  async zones() {
    return this.pages(`/zones?account.id=${this.env.CF_ACCOUNT_ID}&status=active`);
  }
  async check(domain) {
    const [routing, sending, dns] = await Promise.all([
      this.request(`/zones/${domain.zone_id}/email/routing`),
      this.request(`/zones/${domain.zone_id}/email/sending/subdomains`),
      this.pages(`/zones/${domain.zone_id}/dns_records`),
    ]);
    const externalMx = dns.filter(
      (record) =>
        record.type === 'MX' &&
        record.name === domain.name &&
        !/\.mx\.cloudflare\.net\.?$/.test(record.content)
    );
    const sendingDomain = sending.result.find((row) => row.name === domain.name && row.enabled);
    let sendingReady = false;
    if (sendingDomain) {
      const expected = (
        await this.request(
          `/zones/${domain.zone_id}/email/sending/subdomains/${sendingDomain.id || sendingDomain.tag}/dns`
        )
      ).result;
      const norm = (value, type) =>
        type === 'TXT'
          ? String(value).replace(/"\s*"/g, '').replace(/^"|"$/g, '')
          : String(value).replace(/\.$/, '').toLowerCase();
      sendingReady =
        expected.length > 0 &&
        expected.every((record) =>
          dns.some(
            (actual) =>
              actual.type === record.type &&
              actual.name === record.name &&
              (record.name.startsWith('_dmarc.')
                ? /v=DMARC1/i.test(actual.content)
                : norm(actual.content, actual.type) === norm(record.content, record.type))
          )
        );
    }
    const routingReady =
      routing.result.enabled && routing.result.status === 'ready' && externalMx.length === 0;
    return { sendingReady: !!sendingReady, routingReady: !!routingReady, externalMx };
  }
  async enable(domain) {
    const before = await this.check(domain);
    if (before.externalMx.length) {
      const error = new HttpError(
        409,
        'This domain receives mail through another provider. Review the existing MX records before migrating.'
      );
      error.details = {
        mx: before.externalMx.map(({ name, content, priority }) => ({ name, content, priority })),
      };
      throw error;
    }
    if (!before.sendingReady)
      await this.request(`/zones/${domain.zone_id}/email/sending/subdomains`, 'POST', {
        name: domain.name,
      });
    if (!before.routingReady)
      await this.request(`/zones/${domain.zone_id}/email/routing/dns`, 'POST', {});
    return this.check(domain);
  }
  async rule(domain, address, worker) {
    const rules = await this.pages(`/zones/${domain.zone_id}/email/routing/rules`);
    const current = rules.find((rule) =>
      rule.matchers?.some(
        (matcher) =>
          matcher.type === 'literal' &&
          matcher.field === 'to' &&
          matcher.value?.toLowerCase() === address
      )
    );
    if (current) {
      if (
        current.enabled &&
        current.actions?.length === 1 &&
        current.actions[0].type === 'worker' &&
        current.actions[0].value?.[0] === worker
      )
        return current.id || current.tag;
      throw new HttpError(
        409,
        'An existing routing rule uses this address. Resolve it before creating this mailbox.'
      );
    }
    const created = await this.request(`/zones/${domain.zone_id}/email/routing/rules`, 'POST', {
      name: `BeeCloudMail ${address}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: address }],
      actions: [{ type: 'worker', value: [worker] }],
    });
    return created.result.id || created.result.tag;
  }
  async removeRule(domain, mailbox) {
    if (!mailbox.routing_rule_id) return;
    const lookup = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${domain.zone_id}/email/routing/rules/${mailbox.routing_rule_id}`,
      {
        headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        signal: AbortSignal.timeout(20000),
      }
    );
    if (lookup.status === 404) return;
    const current = await lookup.json();
    if (!lookup.ok || !current.success)
      throw new HttpError(502, 'Could not check the routing rule. Retry deletion.');
    const rule = current.result;
    if (
      !rule.matchers?.some((m) => m.value === mailbox.address) ||
      rule.actions?.[0]?.type !== 'worker' ||
      rule.actions[0].value?.[0] !== this.env.INBOUND_WORKER
    )
      throw new HttpError(
        409,
        'Routing changed outside this panel. Review it before deleting this mailbox.'
      );
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${domain.zone_id}/email/routing/rules/${mailbox.routing_rule_id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        signal: AbortSignal.timeout(20000),
      }
    );
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new HttpError(502, 'Could not remove the mailbox routing rule. Retry deletion.');
  }
  async verifyForward(address) {
    const rows = await this.pages(`/accounts/${this.env.CF_ACCOUNT_ID}/email/routing/addresses`);
    return rows.some(
      (row) =>
        row.email.toLowerCase() === address.toLowerCase() &&
        (row.verified || row.status === 'verified')
    );
  }
}
class LocalMock {
  async zones() {
    return [
      { id: 'demo-zone-one', name: 'studio.example', status: 'active' },
      { id: 'demo-zone-two', name: 'games.example', status: 'active' },
    ];
  }
  async check() {
    return { sendingReady: true, routingReady: true, externalMx: [] };
  }
  async enable(domain) {
    return this.check(domain);
  }
  async rule(domain, address) {
    return `local:${address}`;
  }
  async removeRule() {}
  async verifyForward() {
    return false;
  }
}
export function provider(env) {
  if (env.TEST_PROVIDER) return env.TEST_PROVIDER;
  if (env.LOCAL_MOCK === 'true' && env.CURRENT_HOST_LOCAL) return new LocalMock();
  return new Cloudflare(env);
}
