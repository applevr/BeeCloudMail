import { test } from 'node:test';
import assert from 'node:assert/strict';
import mail, { receiveMail, HttpError } from '../src/worker.js';
import admin from '../src/admin.js';
import { fixture, request, demoPassword } from './helpers.js';
const payload = {
  to: 'partner@example.com',
  subject: 'Hello',
  text: 'Thank you for the update.',
  attachments: [],
};
async function received(f, index = 0) {
  const m = f.mailboxes[index];
  const raw = `From: partner@example.com\r\nTo: ${m.address}\r\nSubject: Original\r\nMessage-ID: <original-${index}@partner.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<table><tr><td>Hello <img src="https://partner.example/logo.png"></td></tr></table>`;
  await receiveMail(
    {
      to: m.address,
      from: 'partner@example.com',
      raw: new Response(raw).body,
      rawSize: raw.length,
      headers: new Headers({ 'message-id': `<original-${index}@partner.example>` }),
      async forward() {},
      setReject() {
        assert.fail('Should accept active mailbox');
      },
    },
    f.env
  );
  return (await f.db.prepare('SELECT id FROM messages WHERE mailbox_id=?').bind(m.id).first()).id;
}
test('email login, admin login and cookies are separate; wrong passwords and CSRF fail', async () => {
  const f = await fixture();
  const login = await mail.fetch(
    request('/api/login', '', { email: f.mailboxes[0].address, password: demoPassword }),
    f.env
  );
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /cm_session=/);
  assert.equal(
    (
      await mail.fetch(
        request('/api/login', '', { email: f.mailboxes[0].address, password: 'wrong' }),
        f.env
      )
    ).status,
    401
  );
  assert.equal(
    (await admin.fetch(request('/api/me', f.tokens[0], undefined, true), f.env)).status,
    401
  );
  assert.equal((await mail.fetch(request('/api/me', f.adminToken), f.env)).status, 401);
  assert.equal(
    (
      await admin.fetch(
        request('/api/login', '', { username: 'admin', password: demoPassword }, true),
        f.env
      )
    ).status,
    200
  );
  assert.equal(
    (
      await admin.fetch(
        request('/api/domains/sync', f.adminToken, {}, true, 'POST', {
          Origin: 'https://evil.example',
        }),
        f.env
      )
    ).status,
    403
  );
});
test('mailbox isolation protects listing, read, render, raw, attachment, trash and reply references', async () => {
  const f = await fixture();
  const id = await received(f);
  const first = await (await mail.fetch(request('/api/messages', f.tokens[0]), f.env)).json();
  const second = await (await mail.fetch(request('/api/messages', f.tokens[1]), f.env)).json();
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 0);
  assert.equal(second.unread, 0);
  for (const suffix of ['', '/render', '/raw', '/attachment/0'])
    assert.equal(
      (await mail.fetch(request(`/api/messages/${id}${suffix}`, f.tokens[1]), f.env)).status,
      404
    );
  assert.equal(
    (
      await mail.fetch(
        request(`/api/messages/${id}`, f.tokens[1], { folder: 'trash' }, false, 'PATCH'),
        f.env
      )
    ).status,
    404
  );
  assert.equal(
    (
      await mail.fetch(
        request('/api/send', f.tokens[1], { ...payload, replyId: id }, false, 'POST', {
          'Idempotency-Key': crypto.randomUUID(),
        }),
        f.env
      )
    ).status,
    404
  );
  assert.equal(f.sent.length, 0);
});
test('sending fixes From to authenticated mailbox, keeps quoted HTML and deduplicates retries', async () => {
  const f = await fixture();
  const original = await received(f);
  const id = crypto.randomUUID();
  const data = { ...payload, from: f.mailboxes[1].address, replyId: original };
  const response = await mail.fetch(
    request('/api/send', f.tokens[0], data, false, 'POST', { 'Idempotency-Key': id }),
    f.env
  );
  assert.equal(response.status, 200);
  assert.equal(f.sent[0].from.email, f.mailboxes[0].address);
  assert.match(f.sent[0].html, /<blockquote/);
  assert.match(f.sent[0].html, /partner.example\/logo/);
  assert.equal(f.sent[0].headers['In-Reply-To'], '<original-0@partner.example>');
  assert.equal(
    (
      await mail.fetch(
        request('/api/send', f.tokens[0], data, false, 'POST', { 'Idempotency-Key': id }),
        f.env
      )
    ).status,
    200
  );
  assert.equal(f.sent.length, 1);
  assert.equal(
    (
      await mail.fetch(
        request('/api/send', f.tokens[1], payload, false, 'POST', { 'Idempotency-Key': id }),
        f.env
      )
    ).status,
    409
  );
  assert.equal(f.sent.length, 1);
});
test('attachments are sent as raw bytes, not base64 text', async () => {
  const f = await fixture();
  const original = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const content = btoa(String.fromCharCode(...original));
  const data = {
    ...payload,
    attachments: [{ filename: 'logo.png', type: 'image/png', content }],
  };
  const response = await mail.fetch(
    request('/api/send', f.tokens[0], data, false, 'POST', {
      'Idempotency-Key': crypto.randomUUID(),
    }),
    f.env
  );
  assert.equal(response.status, 200);
  const sent = f.sent[0].attachments[0];
  assert.ok(sent.content instanceof Uint8Array);
  assert.deepEqual([...sent.content], [...original]);
  assert.equal(sent.filename, 'logo.png');
  assert.equal(sent.type, 'image/png');
});
test('rendered HTML requires ownership and image loading is explicit', async () => {
  const f = await fixture();
  const id = await received(f);
  const response = await mail.fetch(request(`/api/messages/${id}/render`, f.tokens[0]), f.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /img-src data:;/);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  const shown = await mail.fetch(
    request(`/api/messages/${id}/render?images=1`, f.tokens[0]),
    f.env
  );
  assert.match(shown.headers.get('content-security-policy'), /img-src data: https: http:/);
  assert.equal((await mail.fetch(request(`/api/messages/${id}/render`, ''), f.env)).status, 401);
});
test('sync discovers domains without enabling them and mailbox creation requires readiness', async () => {
  const f = await fixture();
  await f.db.prepare("UPDATE domains SET sending_ready=0,routing_ready=0,state='discovered'").run();
  assert.equal(
    (await admin.fetch(request('/api/domains/sync', f.adminToken, {}, true), f.env)).status,
    200
  );
  assert.equal(f.calls.length, 0);
  const body = { domainId: 'zone-a', localPart: 'new', displayName: 'New', password: demoPassword };
  assert.equal(
    (await admin.fetch(request('/api/mailboxes', f.adminToken, body, true), f.env)).status,
    409
  );
  assert.equal(
    (await admin.fetch(request('/api/domains/zone-a/enable', f.adminToken, {}, true), f.env))
      .status,
    200
  );
  const created = await admin.fetch(request('/api/mailboxes', f.adminToken, body, true), f.env);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).address, 'new@studio.example');
  assert.equal(
    (await admin.fetch(request('/api/mailboxes', f.adminToken, body, true), f.env)).status,
    409
  );
  const list = await (
    await admin.fetch(request('/api/mailboxes', f.adminToken, undefined, true), f.env)
  ).json();
  assert.ok(list.mailboxes.every((mailbox) => !('password_hash' in mailbox)));
});
test('provisioning errors remain retryable without duplicate mailbox accounts', async () => {
  const f = await fixture();
  let failed = true;
  f.provider.rule = async () => {
    if (failed) throw new HttpError(502, 'Temporary provider failure');
    return 'rule-new';
  };
  const body = {
    domainId: 'zone-a',
    localPart: 'retry',
    displayName: 'Retry',
    password: demoPassword,
  };
  assert.equal(
    (await admin.fetch(request('/api/mailboxes', f.adminToken, body, true), f.env)).status,
    502
  );
  const mailbox = await f.db
    .prepare("SELECT * FROM mailboxes WHERE address='retry@studio.example'")
    .first();
  assert.equal(mailbox.status, 'provisioning');
  failed = false;
  assert.equal(
    (
      await admin.fetch(
        request(`/api/mailboxes/${mailbox.id}/retry`, f.adminToken, {}, true),
        f.env
      )
    ).status,
    200
  );
  assert.equal(
    (await f.db.prepare('SELECT status FROM mailboxes WHERE id=?').bind(mailbox.id).first()).status,
    'active'
  );
});
test('suspension and password resets revoke existing sessions; suspended inbound is rejected', async () => {
  const f = await fixture();
  const id = f.mailboxes[0].id;
  assert.equal(
    (
      await admin.fetch(
        request(`/api/mailboxes/${id}/status`, f.adminToken, { status: 'suspended' }, true),
        f.env
      )
    ).status,
    200
  );
  assert.equal((await mail.fetch(request('/api/me', f.tokens[0]), f.env)).status, 401);
  let rejected = false;
  await receiveMail(
    {
      to: f.mailboxes[0].address,
      setReject() {
        rejected = true;
      },
    },
    f.env
  );
  assert.equal(rejected, true);
  await admin.fetch(
    request(`/api/mailboxes/${id}/status`, f.adminToken, { status: 'active' }, true),
    f.env
  );
  assert.equal(
    (
      await admin.fetch(
        request(
          `/api/mailboxes/${id}/password`,
          f.adminToken,
          { password: 'new-local-password-2026' },
          true
        ),
        f.env
      )
    ).status,
    200
  );
  assert.equal(
    (
      await mail.fetch(
        request('/api/login', '', { email: f.mailboxes[0].address, password: demoPassword }),
        f.env
      )
    ).status,
    401
  );
  assert.equal(
    (
      await mail.fetch(
        request('/api/login', '', {
          email: f.mailboxes[0].address,
          password: 'new-local-password-2026',
        }),
        f.env
      )
    ).status,
    200
  );
});
test('deletion confirms the address and removes only the selected mailbox files/messages', async () => {
  const f = await fixture();
  const first = await received(f, 0);
  const second = await received(f, 1);
  const id = f.mailboxes[0].id;
  assert.equal(
    (
      await admin.fetch(
        request(`/api/mailboxes/${id}`, f.adminToken, { confirm: 'wrong' }, true, 'DELETE'),
        f.env
      )
    ).status,
    400
  );
  assert.equal(
    (
      await admin.fetch(
        request(
          `/api/mailboxes/${id}`,
          f.adminToken,
          { confirm: f.mailboxes[0].address },
          true,
          'DELETE'
        ),
        f.env
      )
    ).status,
    200
  );
  assert.equal(await f.db.prepare('SELECT id FROM messages WHERE id=?').bind(first).first(), null);
  assert.ok(await f.db.prepare('SELECT id FROM messages WHERE id=?').bind(second).first());
  assert.ok([...f.objects.keys()].every((key) => !key.startsWith(`mailboxes/${id}/`)));
  assert.ok([...f.objects.keys()].some((key) => key.startsWith(`mailboxes/${f.mailboxes[1].id}/`)));
});
test('failed deletion can resume and revokes login before provider or storage cleanup', async () => {
  const f = await fixture();
  const id = f.mailboxes[0].id;
  let failed = true;
  f.provider.removeRule = async () => {
    if (failed) throw new HttpError(502, 'Temporary provider failure');
  };
  assert.equal(
    (
      await admin.fetch(
        request(
          `/api/mailboxes/${id}`,
          f.adminToken,
          { confirm: f.mailboxes[0].address },
          true,
          'DELETE'
        ),
        f.env
      )
    ).status,
    502
  );
  assert.equal((await mail.fetch(request('/api/me', f.tokens[0]), f.env)).status, 401);
  assert.equal(
    (await f.db.prepare('SELECT status FROM mailboxes WHERE id=?').bind(id).first()).status,
    'deleting'
  );
  failed = false;
  assert.equal(
    (
      await admin.fetch(
        request(
          `/api/mailboxes/${id}`,
          f.adminToken,
          { confirm: f.mailboxes[0].address },
          true,
          'DELETE'
        ),
        f.env
      )
    ).status,
    200
  );
});
test('unknown domains, unverified forwarding and foreign MX cannot be silently accepted', async () => {
  const f = await fixture();
  assert.equal(
    (
      await admin.fetch(
        request(
          '/api/mailboxes',
          f.adminToken,
          { domainId: 'unknown', localPart: 'x', password: demoPassword },
          true
        ),
        f.env
      )
    ).status,
    404
  );
  f.provider.verifyForward = async () => false;
  assert.equal(
    (
      await admin.fetch(
        request(
          `/api/mailboxes/${f.mailboxes[0].id}/forwarding`,
          f.adminToken,
          { address: 'somebody@example.com' },
          true
        ),
        f.env
      )
    ).status,
    400
  );
  f.provider.enable = async () => {
    const error = new HttpError(409, 'External MX in use');
    error.details = { mx: [{ content: 'mx.other-provider.example' }] };
    throw error;
  };
  const result = await admin.fetch(
    request('/api/domains/zone-a/enable', f.adminToken, {}, true),
    f.env
  );
  assert.equal(result.status, 409);
  assert.equal((await result.json()).details.mx[0].content, 'mx.other-provider.example');
});
