import { HttpError, countLoginAttempt, json, limitedBody } from './worker.js';
import {
  digest,
  randomToken,
  passwordHash,
  verifyPassword,
  sameOrigin,
  secureHeaders,
  validAddress,
} from './security.js';
import { provider } from './cloudflare.js';
const now = () => new Date().toISOString();
const cookie = (request, token, seconds) =>
  `cm_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
async function hashPassword(value) {
  if (typeof value !== 'string' || value.length < 14 || value.length > 256)
    throw new HttpError(400, 'Use a password with 14–256 characters.');
  const salt = randomToken();
  return `${salt}:100000:${await passwordHash(value, salt)}`;
}
async function audit(env, admin, action, target) {
  await env.DB.prepare(
    'INSERT INTO audit_events(id,admin_id,action,target_id,created_at) VALUES (?,?,?,?,?)'
  )
    .bind(crypto.randomUUID(), admin.id, action, target, now())
    .run();
}
async function domainById(env, id) {
  const domain = await env.DB.prepare('SELECT * FROM domains WHERE id=?').bind(id).first();
  if (!domain) throw new HttpError(404, 'Domain not found.');
  return domain;
}
async function operation(env, id, target, kind, state, error = null) {
  await env.DB.prepare(
    'INSERT INTO provisioning_operations(id,target_id,kind,state,error,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,error=excluded.error,updated_at=excluded.updated_at'
  )
    .bind(id, target, kind, state, error, now())
    .run();
}
async function saveDomainState(env, domain, check) {
  const state = check.sendingReady && check.routingReady ? 'ready' : 'pending_dns';
  await env.DB.prepare(
    'UPDATE domains SET state=?,sending_ready=?,routing_ready=?,last_error=NULL,updated_at=? WHERE id=?'
  )
    .bind(state, check.sendingReady ? 1 : 0, check.routingReady ? 1 : 0, now(), domain.id)
    .run();
  return { ...check, state };
}
async function activateMailbox(env, mailbox) {
  const domain = await domainById(env, mailbox.domain_id);
  if (!domain.sending_ready || !domain.routing_ready)
    throw new HttpError(409, 'Enable and verify this domain first.');
  const operationId = `mailbox:${mailbox.id}`;
  await operation(env, operationId, mailbox.id, 'create_mailbox', 'running');
  try {
    const ruleId = await provider(env).rule(domain, mailbox.address, env.INBOUND_WORKER);
    await env.DB.prepare(
      "UPDATE mailboxes SET routing_rule_id=?,status='active' WHERE id=? AND status='provisioning'"
    )
      .bind(ruleId, mailbox.id)
      .run();
    await operation(env, operationId, mailbox.id, 'create_mailbox', 'complete');
  } catch (error) {
    await operation(
      env,
      operationId,
      mailbox.id,
      'create_mailbox',
      'failed',
      error instanceof HttpError ? error.message : 'Operation interrupted. Retry provisioning.'
    );
    throw error;
  }
}
async function deleteMailbox(env, mailbox) {
  const domain = await domainById(env, mailbox.domain_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE mailboxes SET status='deleting' WHERE id=?").bind(mailbox.id),
    env.DB.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id=?').bind(mailbox.id),
  ]);
  const id = `delete:${mailbox.id}`;
  await operation(env, id, mailbox.id, 'delete_mailbox', 'running');
  try {
    await provider(env).removeRule(domain, mailbox);
    let cursor;
    do {
      const page = await env.MAIL_STORAGE.list({
        prefix: `mailboxes/${mailbox.id}/`,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (page.objects.length)
        await env.MAIL_STORAGE.delete(page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE mailbox_id=?').bind(mailbox.id),
      env.DB.prepare('DELETE FROM mailboxes WHERE id=?').bind(mailbox.id),
    ]);
    await operation(env, id, mailbox.id, 'delete_mailbox', 'complete');
  } catch (error) {
    await operation(
      env,
      id,
      mailbox.id,
      'delete_mailbox',
      'failed',
      error instanceof HttpError ? error.message : 'Deletion interrupted. Retry to finish.'
    );
    throw error;
  }
}
async function route(request, env) {
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && url.hostname !== env.PANEL_HOST) throw new HttpError(403, 'Hostname not allowed.');
  env = { ...env, CURRENT_HOST_LOCAL: local };
  if (
    url.pathname.startsWith('/api/') &&
    !['GET', 'HEAD'].includes(request.method) &&
    !sameOrigin(request)
  )
    throw new HttpError(403, 'Invalid request origin.');
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const data = await limitedBody(request, 4096);
    const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase() : '';
    const attempt = await countLoginAttempt(env, 'admin-login', request, username);
    const admin = await env.DB.prepare('SELECT * FROM admin_users WHERE username=?')
      .bind(username)
      .first();
    const encoded =
      admin?.password_hash ||
      'dummy:100000:0000000000000000000000000000000000000000000000000000000000000000';
    const valid =
      typeof data?.password === 'string' &&
      data.password.length <= 256 &&
      (await verifyPassword(data.password, encoded));
    if (!admin || !valid) throw new HttpError(401, 'Incorrect username or password.');
    await attempt.refund();
    const token = randomToken();
    const expires = Math.floor(Date.now() / 1000) + 7200;
    await env.DB.prepare(
      'INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES (?,?,?)'
    )
      .bind(await digest(token), admin.id, expires)
      .run();
    return json({ username: admin.username }, 200, { 'Set-Cookie': cookie(request, token, 7200) });
  }
  if (!url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    return env.ASSETS.fetch(request);
  }
  const token = (request.headers.get('cookie') || '').match(
    /(?:^|;\s*)cm_admin=([a-f0-9]{64})(?:;|$)/
  )?.[1];
  const admin = token
    ? await env.DB.prepare(
        'SELECT a.id,a.username FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?'
      )
        .bind(await digest(token), Math.floor(Date.now() / 1000))
        .first()
    : null;
  if (!admin) throw new HttpError(401, 'Please sign in as an administrator.');
  if (url.pathname === '/api/me')
    return json({ username: admin.username, localMock: env.LOCAL_MOCK === 'true' && local });
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?')
      .bind(await digest(token))
      .run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  if (url.pathname === '/api/domains' && request.method === 'GET')
    return json({
      domains: (await env.DB.prepare('SELECT * FROM domains ORDER BY name').all()).results,
    });
  if (url.pathname === '/api/mailboxes' && request.method === 'GET')
    return json({
      mailboxes: (
        await env.DB.prepare(
          'SELECT m.id,m.address,m.display_name,m.status,m.forward_to,m.created_at,d.name AS domain FROM mailboxes m JOIN domains d ON d.id=m.domain_id ORDER BY m.created_at DESC'
        ).all()
      ).results,
    });
  if (url.pathname === '/api/operations' && request.method === 'GET')
    return json({
      operations: (
        await env.DB.prepare(
          'SELECT * FROM provisioning_operations ORDER BY updated_at DESC LIMIT 50'
        ).all()
      ).results,
    });
  if (url.pathname === '/api/audit' && request.method === 'GET')
    return json({
      events: (
        await env.DB.prepare(
          'SELECT action,target_id,created_at FROM audit_events ORDER BY created_at DESC LIMIT 50'
        ).all()
      ).results,
    });
  if (url.pathname === '/api/domains/sync' && request.method === 'POST') {
    const zones = await provider(env).zones();
    for (const zone of zones)
      await env.DB.prepare(
        "INSERT INTO domains(id,name,zone_id,state,updated_at) VALUES (?,?,?,'discovered',?) ON CONFLICT(zone_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at"
      )
        .bind(zone.id, zone.name, zone.id, now())
        .run();
    await audit(env, admin, 'sync_domains', null);
    return json({ count: zones.length });
  }
  const domainMatch = url.pathname.match(/^\/api\/domains\/([^/]+)\/(check|enable)$/);
  if (domainMatch && request.method === 'POST') {
    const domain = await domainById(env, domainMatch[1]);
    const kind = domainMatch[2];
    const id = `domain:${domain.id}:${kind}`;
    await operation(env, id, domain.id, kind, 'running');
    try {
      const check = await provider(env)[kind](domain);
      const result = await saveDomainState(env, domain, check);
      await operation(env, id, domain.id, kind, 'complete');
      await audit(env, admin, `${kind}_domain`, domain.id);
      return json(result);
    } catch (error) {
      const message =
        error instanceof HttpError ? error.message : 'Operation interrupted. Retry this action.';
      await operation(env, id, domain.id, kind, 'failed', message);
      await env.DB.prepare('UPDATE domains SET last_error=? WHERE id=?')
        .bind(message, domain.id)
        .run();
      throw error;
    }
  }
  if (url.pathname === '/api/mailboxes' && request.method === 'POST') {
    const data = await limitedBody(request, 4096);
    const domain = await domainById(env, data?.domainId);
    const localPart =
      typeof data?.localPart === 'string' ? data.localPart.trim().toLowerCase() : '';
    if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localPart) || localPart.includes('..'))
      throw new HttpError(400, 'Use a valid mailbox name (1–64 characters).');
    const address = `${localPart}@${domain.name}`;
    const password = await hashPassword(data.password);
    if (!domain.sending_ready || !domain.routing_ready)
      throw new HttpError(409, 'Enable and verify the domain before creating mailboxes.');
    if (await env.DB.prepare('SELECT id FROM mailboxes WHERE address=?').bind(address).first())
      throw new HttpError(
        409,
        'This mailbox already exists. Use Retry if provisioning is incomplete.'
      );
    const id = crypto.randomUUID();
    const displayName =
      typeof data.displayName === 'string' ? data.displayName.trim().slice(0, 100) : localPart;
    try {
      await env.DB.prepare(
        "INSERT INTO mailboxes(id,domain_id,address,display_name,password_hash,status,created_at) VALUES (?,?,?,?,?,'provisioning',?)"
      )
        .bind(id, domain.id, address, displayName || localPart, password, now())
        .run();
    } catch {
      throw new HttpError(
        409,
        'This mailbox already exists or could not be created. Refresh the list.'
      );
    }
    await audit(env, admin, 'create_mailbox', id);
    const mailbox = await env.DB.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
    await activateMailbox(env, mailbox);
    return json({ id, address, status: 'active' }, 201);
  }
  const mailboxMatch = url.pathname.match(
    /^\/api\/mailboxes\/([^/]+)(?:\/(retry|password|status|forwarding))?$/
  );
  if (mailboxMatch) {
    const mailbox = await env.DB.prepare('SELECT * FROM mailboxes WHERE id=?')
      .bind(mailboxMatch[1])
      .first();
    if (!mailbox) throw new HttpError(404, 'Mailbox not found.');
    const action = mailboxMatch[2];
    if (request.method === 'DELETE' && !action) {
      const data = await limitedBody(request, 4096);
      if (data.confirm !== mailbox.address)
        throw new HttpError(400, 'Type the full email address to confirm deletion.');
      await deleteMailbox(env, mailbox);
      await audit(env, admin, 'delete_mailbox', mailbox.id);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action === 'retry') {
      if (mailbox.status !== 'provisioning')
        throw new HttpError(409, 'Only incomplete provisioning can be retried.');
      await activateMailbox(env, mailbox);
      await audit(env, admin, 'retry_mailbox', mailbox.id);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action) {
      if (mailbox.status === 'deleting')
        throw new HttpError(409, 'Finish deleting this mailbox first.');
      const data = await limitedBody(request, 4096);
      if (action === 'password') {
        const hash = await hashPassword(data.password);
        await env.DB.batch([
          env.DB.prepare('UPDATE mailboxes SET password_hash=? WHERE id=?').bind(hash, mailbox.id),
          env.DB.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id=?').bind(mailbox.id),
        ]);
      } else if (action === 'status') {
        if (mailbox.status === 'provisioning' || !['active', 'suspended'].includes(data.status))
          throw new HttpError(400, 'Invalid status change.');
        await env.DB.batch([
          env.DB.prepare('UPDATE mailboxes SET status=? WHERE id=?').bind(data.status, mailbox.id),
          env.DB.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id=?').bind(mailbox.id),
        ]);
      } else if (action === 'forwarding') {
        const address = typeof data.address === 'string' ? data.address.trim().toLowerCase() : '';
        if (
          address &&
          (!validAddress(address) ||
            address === mailbox.address ||
            !(await provider(env).verifyForward(address)))
        )
          throw new HttpError(400, 'Choose a verified external Cloudflare forwarding destination.');
        await env.DB.prepare('UPDATE mailboxes SET forward_to=? WHERE id=?')
          .bind(address || null, mailbox.id)
          .run();
      }
      await audit(env, admin, `${action}_mailbox`, mailbox.id);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Endpoint not found.');
}
export default {
  async fetch(request, env) {
    try {
      return secureHeaders(await route(request, env), true);
    } catch (error) {
      return secureHeaders(
        json(
          {
            error:
              error instanceof HttpError
                ? error.message
                : 'Operation interrupted. Refresh and retry.',
            ...(error.details ? { details: error.details } : {}),
          },
          error instanceof HttpError ? error.status : 500
        )
      );
    }
  },
};
