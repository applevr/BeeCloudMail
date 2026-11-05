import { test } from 'node:test';
import assert from 'node:assert/strict';
import mail, { receiveMail } from '../src/worker.js';
import admin from '../src/admin.js';
import { fixture, request, demoPassword } from './helpers.js';

const envelope = 'bounce-123@mailer.example';

function inbound(mailbox, raw, overrides = {}) {
  return {
    to: mailbox.address,
    from: envelope,
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(),
    async forward() {},
    setReject() {
      assert.fail('Should accept active mailbox');
    },
    ...overrides,
  };
}
const rawMessage = (headers = '') =>
  `From: Partner <partner@example.com>\r\nSubject: Hello\r\nMessage-ID: <m2@example.com>\r\n${headers}\r\nBody\r\n`;
const stored = (f, mailbox) =>
  f.db.prepare('SELECT * FROM messages WHERE mailbox_id=?').bind(mailbox.id).first();

test('a forwarding failure keeps the message and flags it', async () => {
  const f = await fixture();
  const [mailbox] = f.mailboxes;
  await f.db
    .prepare('UPDATE mailboxes SET forward_to=? WHERE id=?')
    .bind('me@example.net', mailbox.id)
    .run();
  const failing = inbound(mailbox, rawMessage(), {
    async forward() {
      throw new Error('destination unavailable');
    },
  });
  await receiveMail(failing, f.env);
  const row = await stored(f, mailbox);
  assert.equal(row.subject, 'Hello');
  assert.equal(row.error_code, 'FORWARD_FAILED');
});

test('forwarding happens after saving, and a retried delivery does not forward again', async () => {
  const f = await fixture();
  const [mailbox] = f.mailboxes;
  await f.db
    .prepare('UPDATE mailboxes SET forward_to=? WHERE id=?')
    .bind('me@example.net', mailbox.id)
    .run();
  let forwards = 0;
  const forward = async (address) => {
    assert.equal(address, 'me@example.net');
    assert.ok(await stored(f, mailbox), 'message must be saved before forwarding');
    forwards++;
  };
  await receiveMail(inbound(mailbox, rawMessage(), { forward }), f.env);
  await receiveMail(inbound(mailbox, rawMessage(), { forward }), f.env);
  assert.equal(forwards, 1);
});

test('the header sender is shown and replied to, with the envelope kept', async () => {
  const f = await fixture();
  const [mailbox] = f.mailboxes;
  await receiveMail(inbound(mailbox, rawMessage()), f.env);
  const row = await stored(f, mailbox);
  assert.equal(row.sender, 'partner@example.com');
  const detail = await (
    await mail.fetch(request(`/api/messages/${row.id}`, f.tokens[0]), f.env)
  ).json();
  assert.equal(detail.replyTo, 'partner@example.com');
  assert.equal(detail.envelopeFrom, envelope);
});

test('Reply-To wins, and a message without a usable From falls back to the envelope', async () => {
  const f = await fixture();
  const [first, second] = f.mailboxes;
  await receiveMail(inbound(first, rawMessage('Reply-To: desk@example.com\r\n')), f.env);
  const replied = await stored(f, first);
  const detail = await (
    await mail.fetch(request(`/api/messages/${replied.id}`, f.tokens[0]), f.env)
  ).json();
  assert.equal(detail.replyTo, 'desk@example.com');

  await receiveMail(inbound(second, 'Subject: No sender\r\n\r\nBody\r\n'), f.env);
  assert.equal((await stored(f, second)).sender, envelope);
});

test('replies extend the References chain, also when replying to your own sent message', async () => {
  const f = await fixture();
  const [mailbox] = f.mailboxes;
  await receiveMail(inbound(mailbox, rawMessage('References: <m1@example.com>\r\n')), f.env);
  const original = await stored(f, mailbox);
  const reply = (replyId) =>
    mail.fetch(
      request(
        '/api/send',
        f.tokens[0],
        { to: 'partner@example.com', subject: 'Re: Hello', text: 'Thanks', replyId },
        false,
        'POST',
        { 'Idempotency-Key': crypto.randomUUID() }
      ),
      f.env
    );
  const first = await (await reply(original.id)).json();
  assert.equal(f.sent[0].headers['In-Reply-To'], '<m2@example.com>');
  assert.equal(f.sent[0].headers.References, '<m1@example.com> <m2@example.com>');
  await reply(first.id);
  assert.equal(
    f.sent[1].headers.References,
    '<m1@example.com> <m2@example.com> <sent@example.com>'
  );
});

test('an oversized References chain keeps the first and latest messages', async () => {
  const f = await fixture();
  const [mailbox] = f.mailboxes;
  const chain = Array.from({ length: 60 }, (_, i) => `<thread-${i}-padding@example.com>`).join(' ');
  await receiveMail(inbound(mailbox, rawMessage(`References: ${chain}\r\n`)), f.env);
  const original = await stored(f, mailbox);
  await mail.fetch(
    request(
      '/api/send',
      f.tokens[0],
      { to: 'partner@example.com', subject: 'Re', text: 'Thanks', replyId: original.id },
      false,
      'POST',
      { 'Idempotency-Key': crypto.randomUUID() }
    ),
    f.env
  );
  const { References } = f.sent[0].headers;
  assert.ok(References.length < 900);
  assert.ok(References.startsWith('<thread-0-padding@example.com>'));
  assert.ok(References.endsWith('<thread-59-padding@example.com> <m2@example.com>'));
});

const signIn = (f, ip, email, password) =>
  mail.fetch(
    request('/api/login', '', { email, password }, false, 'POST', { 'CF-Connecting-IP': ip }),
    f.env
  );

test('successful sign-ins are not counted and failed ones from one IP are limited', async () => {
  const f = await fixture();
  const { address } = f.mailboxes[0];
  for (let i = 0; i < 15; i++)
    assert.equal((await signIn(f, 'a', address, demoPassword)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await signIn(f, 'b', address, 'wrong')).status, 401);
  assert.equal((await signIn(f, 'b', address, demoPassword)).status, 429);
  assert.equal((await signIn(f, 'c', address, demoPassword)).status, 200);
});

test('an attack on one account does not lock out other accounts', async () => {
  const f = await fixture();
  const [target, other] = f.mailboxes;
  for (let i = 0; i < 50; i++)
    assert.equal((await signIn(f, `ip-${i}`, target.address, 'wrong')).status, 401);
  assert.equal((await signIn(f, 'fresh', target.address, demoPassword)).status, 429);
  assert.equal((await signIn(f, 'fresh', other.address, demoPassword)).status, 200);
});

test('failed mailbox sign-ins do not affect the administrator', async () => {
  const f = await fixture();
  const { address } = f.mailboxes[0];
  for (let i = 0; i < 11; i++) await signIn(f, 'shared', address, 'wrong');
  const response = await admin.fetch(
    request('/api/login', '', { username: 'admin', password: demoPassword }, true, 'POST', {
      'CF-Connecting-IP': 'shared',
    }),
    f.env
  );
  assert.equal(response.status, 200);
});
