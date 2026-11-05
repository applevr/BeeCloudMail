import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8788';
const demoPassword = 'local-demo-only-2026';
async function call(path, method = 'GET', body, cookie) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: await response.json() };
}
const login = await call('/panel/api/login', 'POST', { username: 'admin', password: demoPassword });
assert.equal(login.response.status, 200);
const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
const mailboxCookies = [];
try {
  for (const id of ['demo-zone-one', 'demo-zone-two'])
    assert.equal(
      (await call(`/panel/api/domains/${id}/check`, 'POST', {}, adminCookie)).response.status,
      200
    );
  for (const [domainId, localPart] of [
    ['demo-zone-one', 'hello'],
    ['demo-zone-two', 'support'],
  ]) {
    const created = await call(
      '/panel/api/mailboxes',
      'POST',
      {
        domainId,
        localPart,
        displayName: localPart === 'hello' ? 'Studio Team' : 'Game Support',
        password: demoPassword,
      },
      adminCookie
    );
    assert.ok([201, 409].includes(created.response.status));
  }
  const list = await call('/panel/api/mailboxes', 'GET', undefined, adminCookie);
  assert.equal(list.response.status, 200);
  assert.ok(list.data.mailboxes.length >= 2);
  assert.ok(list.data.mailboxes.every((row) => !('password_hash' in row)));
  for (const email of ['hello@studio.example', 'support@games.example']) {
    const login = await call('/api/login', 'POST', { email, password: demoPassword });
    assert.equal(login.response.status, 200);
    mailboxCookies.push(login.response.headers.get('set-cookie').split(';')[0]);
  }
  const raw = [
    'From: Partner <partner@example.invalid>',
    'To: hello@studio.example',
    'Subject: Welcome to your shared webmail',
    `Message-ID: <local-${crypto.randomUUID()}@example.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="demo-boundary"',
    '',
    '--demo-boundary',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div style="padding:30px;background:#faf8f1;font:15px/1.8 Arial,sans-serif"><h1 style="font-family:Georgia,serif">Hello, Studio Team.</h1><p>This sample message lives only in the local demo.</p><table cellpadding="12" style="background:white"><tr><td>Your domains</td><td>Your private mailboxes</td></tr></table><p><img src="https://example.invalid/logo.png" alt="External images are blocked until you choose Show images."></p></div>',
    '--demo-boundary',
    'Content-Type: text/plain',
    'Content-Disposition: attachment; filename="welcome.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'V2VsY29tZSB0byBCZWVDbG91ZE1haWwu',
    '--demo-boundary--',
    '',
  ].join('\r\n');
  const received = await fetch(
    base + '/cdn-cgi/local/email?from=partner%40example.invalid&to=hello%40studio.example',
    { method: 'POST', body: raw }
  );
  assert.equal(received.status, 200);
  const inbox = await call('/api/messages', 'GET', undefined, mailboxCookies[0]);
  const message = inbox.data.messages.find(
    (message) => message.subject === 'Welcome to your shared webmail'
  );
  assert.ok(message);
  const peer = await call('/api/messages', 'GET', undefined, mailboxCookies[1]);
  assert.ok(!peer.data.messages.some((row) => row.id === message.id));
  for (const suffix of ['', '/render', '/raw', '/attachment/0'])
    assert.equal(
      (
        await fetch(base + `/api/messages/${message.id}${suffix}`, {
          headers: { Cookie: mailboxCookies[1] },
        })
      ).status,
      404
    );
  const render = await fetch(base + `/api/messages/${message.id}/render`, {
    headers: { Cookie: mailboxCookies[0] },
  });
  assert.equal(render.status, 200);
  assert.match(render.headers.get('content-security-policy'), /img-src data:;/);
  const attachment = await fetch(base + `/api/messages/${message.id}/attachment/0`, {
    headers: { Cookie: mailboxCookies[0] },
  });
  assert.equal(await attachment.text(), 'Welcome to BeeCloudMail.');
  const suspended = list.data.mailboxes.find((row) => row.address === 'support@games.example');
  assert.equal(
    (
      await call(
        `/panel/api/mailboxes/${suspended.id}/status`,
        'POST',
        { status: 'suspended' },
        adminCookie
      )
    ).response.status,
    200
  );
  assert.equal((await call('/api/me', 'GET', undefined, mailboxCookies[1])).response.status, 401);
  await call(
    `/panel/api/mailboxes/${suspended.id}/status`,
    'POST',
    { status: 'active' },
    adminCookie
  );
  console.log(
    'PASS: real local Worker serves panel and webmail, provisions two demo mailboxes on two domains, logs into each, stores incoming MIME and attachment in D1/R2, denies cross-mailbox access, and revokes suspended sessions. No real Cloudflare mutations or outbound emails.'
  );
} finally {
  for (const cookie of mailboxCookies) await call('/api/logout', 'POST', {}, cookie);
  await call('/panel/api/logout', 'POST', {}, adminCookie);
}
