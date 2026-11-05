import PostalMime from 'postal-mime';
import { composeContent, renderHtmlDocument } from './mail-html.js';
import {
  digest,
  hex,
  randomToken,
  verifyPassword,
  validAddress,
  sessionToken,
  sameOrigin,
  secureHeaders,
} from './security.js';

const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_RAW = 25 * 1024 * 1024;
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_FAILURES_PER_IP = 10;
const LOGIN_FAILURES_PER_ACCOUNT = 50;
const MAX_REFERENCES = 900;
const ID = /^[a-f0-9-]{36}$/;
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export async function limitedBody(request, limit = MAX_REQUEST) {
  if (Number(request.headers.get('content-length')) > limit)
    throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Request body is missing.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid request data.');
  }
}

export async function rateLimit(env, bucket, maximum, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits(bucket, attempts, expires_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires_at <= ? THEN 1 ELSE attempts+1 END,
    expires_at=CASE WHEN expires_at <= ? THEN ? ELSE expires_at END RETURNING attempts`
  )
    .bind(bucket, now + windowSeconds, now, now, now + windowSeconds)
    .first();
  if (row.attempts > maximum)
    throw new HttpError(429, 'Too many attempts. Please try again later.');
}
// Limits failed sign-ins per IP and per account. Each attempt is counted up front so concurrent
// guesses cannot slip past, and refunded on success. There is deliberately no global limit: it
// would let anyone lock every user out by exhausting it.
export async function countLoginAttempt(env, scope, request, identity) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const buckets = [`${scope}:ip:${await digest(ip)}`, `${scope}:account:${await digest(identity)}`];
  await rateLimit(env, buckets[0], LOGIN_FAILURES_PER_IP, LOGIN_WINDOW_SECONDS);
  await rateLimit(env, buckets[1], LOGIN_FAILURES_PER_ACCOUNT, LOGIN_WINDOW_SECONDS);
  return {
    async refund() {
      await env.DB.batch(
        buckets.map((bucket) =>
          env.DB.prepare('UPDATE rate_limits SET attempts=MAX(attempts-1,0) WHERE bucket=?').bind(
            bucket
          )
        )
      );
    },
  };
}
// Keeps the thread's first and most recent messages if the chain outgrows the header limit.
function referencesHeader(original) {
  const chain = [...String(original.references || '').matchAll(/<[^<>\s]+>/g)].map(
    (match) => match[0]
  );
  if (!chain.includes(original.message_id)) chain.push(original.message_id);
  while (chain.length > 1 && chain.join(' ').length >= MAX_REFERENCES) {
    chain.splice(chain.length > 2 ? 1 : 0, 1);
  }
  return chain.join(' ');
}
async function authorized(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT m.*, d.sending_ready FROM mailbox_sessions s JOIN mailboxes m ON m.id=s.mailbox_id JOIN domains d ON d.id=m.domain_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active'"
  )
    .bind(await digest(token), Math.floor(Date.now() / 1000))
    .first();
}
function cookie(request, token, age) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `cm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}
async function getMessage(env, id) {
  if (!ID.test(id)) throw new HttpError(404, 'Message not found.');
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id=? AND mailbox_id=?')
    .bind(id, env.MAILBOX_ID)
    .first();
  if (!row) throw new HttpError(404, 'Message not found.');
  return row;
}

export async function sendMail(request, env) {
  if (!env.SENDING_READY) throw new HttpError(409, 'This domain is not ready to send email.');
  await rateLimit(env, `send:${env.MAILBOX_ID}`, 20, 3600);
  await rateLimit(env, 'send:account', 200, 3600);
  const id = request.headers.get('Idempotency-Key') || '';
  if (!ID.test(id)) throw new HttpError(400, 'Send attempt ID is missing.');
  const existing = await env.DB.prepare(
    'SELECT delivery_status, error_code FROM messages WHERE id=? AND mailbox_id=?'
  )
    .bind(id, env.MAILBOX_ID)
    .first();
  if (existing)
    return json(
      { id, status: existing.delivery_status, errorCode: existing.error_code, duplicate: true },
      existing.delivery_status === 'sent' ? 200 : 409
    );
  const data = await limitedBody(request);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new HttpError(400, 'Invalid request data.');
  const to =
    typeof data.to === 'string'
      ? data.to
          .split(/[;,]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  if (!to.length || to.length > 10 || !to.every(validAddress))
    throw new HttpError(400, 'Enter up to 10 valid recipient addresses.');
  if (
    typeof data.subject !== 'string' ||
    !data.subject.trim() ||
    data.subject.length > 500 ||
    /[\r\n]/.test(data.subject)
  )
    throw new HttpError(400, 'Invalid subject.');
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000)
    throw new HttpError(400, 'The message must contain 1 to 100,000 characters.');
  const attachments = data.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 10)
    throw new HttpError(400, 'Up to 10 attachments are allowed.');
  let attachmentBytes = 0;
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment.filename !== 'string' ||
      attachment.filename.length > 200 ||
      /[\r\n\0]/.test(attachment.filename) ||
      typeof attachment.content !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.content)
    )
      throw new HttpError(400, 'Invalid attachment.');
    attachmentBytes += attachment.content.length;
  }
  if (attachmentBytes > 3.5 * 1024 * 1024)
    throw new HttpError(413, 'Attachments must total no more than 2.5 MB.');
  const attachmentBytesList = attachments.map((attachment) =>
    Uint8Array.from(atob(attachment.content), (c) => c.charCodeAt(0))
  );
  const headers = {};
  let originalContent;
  if (data.replyId) {
    const original = await getMessage(env, data.replyId);
    const storedOriginal = await env.MAIL_STORAGE.get(original.body_key);
    if (!storedOriginal)
      throw new HttpError(
        503,
        'The original message is unavailable. Your reply has not been sent.'
      );
    originalContent = { ...original, ...(await storedOriginal.json()) };
    if (
      original.message_id &&
      original.message_id.length < MAX_REFERENCES &&
      !/[\r\n]/.test(original.message_id)
    ) {
      headers['In-Reply-To'] = original.message_id;
      headers.References = referencesHeader(originalContent);
    }
  }
  const content = composeContent(data.text, originalContent);
  if (new TextEncoder().encode(content.html).byteLength > 600000)
    throw new HttpError(413, 'The quoted message is too large. Start a new message instead.');
  const bodyKey = `mailboxes/${env.MAILBOX_ID}/messages/${id}/body.json`;
  const body = {
    ...content,
    replyTo: env.MAILBOX,
    references: headers.References,
    attachments: [],
  };
  // Persist the intent before sending. A repeated attempt cannot send a second copy.
  try {
    await env.DB.prepare(
      `INSERT INTO messages(id,mailbox_id,folder,sender,recipients,subject,snippet,received_at,is_read,body_key,delivery_status,attachment_count)
      VALUES (?,?,'sent',?,?,?,?,?,1,?,'preparing',?)`
    )
      .bind(
        id,
        env.MAILBOX_ID,
        env.MAILBOX,
        JSON.stringify(to),
        data.subject.trim(),
        data.text.slice(0, 160),
        new Date().toISOString(),
        bodyKey,
        attachments.length
      )
      .run();
  } catch (error) {
    const reserved = await env.DB.prepare(
      'SELECT delivery_status FROM messages WHERE id=? AND mailbox_id=?'
    )
      .bind(id, env.MAILBOX_ID)
      .first();
    if (reserved) return json({ id, status: reserved.delivery_status, duplicate: true }, 409);
    throw new HttpError(409, 'This send attempt ID is unavailable. Start a new message.');
  }
  try {
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      const key = `mailboxes/${env.MAILBOX_ID}/messages/${id}/attachment-${index}`;
      const bytes = attachmentBytesList[index];
      await env.MAIL_STORAGE.put(key, bytes);
      body.attachments.push({
        filename: attachment.filename || 'attachment',
        type: attachment.type || 'application/octet-stream',
        size: bytes.length,
        key,
      });
    }
    await env.MAIL_STORAGE.put(bodyKey, JSON.stringify(body));
  } catch {
    await env.DB.prepare(
      "UPDATE messages SET delivery_status='failed', error_code='STORAGE_FAILED' WHERE id=?"
    )
      .bind(id)
      .run();
    return json(
      { id, status: 'failed', error: 'Could not save the message. It has not been sent.' },
      503
    );
  }
  await env.DB.prepare("UPDATE messages SET delivery_status='sending' WHERE id=?").bind(id).run();
  let result;
  try {
    result = await env.EMAIL.send({
      from: { email: env.MAILBOX, name: env.DISPLAY_NAME },
      to,
      subject: data.subject.trim(),
      text: content.text,
      html: content.html,
      headers,
      // Pass raw bytes: the binding delivers string content as literal text, not decoded base64.
      attachments: attachments.map((a, index) => ({
        filename: a.filename || 'attachment',
        type: a.type || 'application/octet-stream',
        content: attachmentBytesList[index],
        disposition: 'attachment',
      })),
    });
  } catch (error) {
    const rejected = new Set([
      'E_VALIDATION_ERROR',
      'E_FIELD_MISSING',
      'E_TOO_MANY_RECIPIENTS',
      'E_TOO_MANY_ATTACHMENTS',
      'E_SENDER_NOT_VERIFIED',
      'E_RECIPIENT_NOT_ALLOWED',
      'E_RECIPIENT_SUPPRESSED',
      'E_SENDER_DOMAIN_NOT_AVAILABLE',
      'E_CONTENT_TOO_LARGE',
      'E_RATE_LIMIT_EXCEEDED',
      'E_DAILY_LIMIT_EXCEEDED',
      'E_HEADER_NOT_ALLOWED',
      'E_HEADER_USE_API_FIELD',
      'E_HEADER_VALUE_INVALID',
      'E_HEADER_VALUE_TOO_LONG',
      'E_HEADER_NAME_INVALID',
      'E_HEADERS_TOO_LARGE',
      'E_HEADERS_TOO_MANY',
    ]);
    const status = rejected.has(error.code) ? 'failed' : 'uncertain';
    await env.DB.prepare('UPDATE messages SET delivery_status=?, error_code=? WHERE id=?')
      .bind(status, typeof error.code === 'string' ? error.code.slice(0, 100) : 'SEND_UNKNOWN', id)
      .run();
    return json(
      {
        id,
        status,
        error:
          status === 'failed'
            ? 'Cloudflare rejected the message. Check your configuration or sending limits.'
            : 'Send status unknown. Check Email Logs before sending again.',
        errorCode: error.code || 'SEND_UNKNOWN',
      },
      502
    );
  }
  // After provider acceptance, a database failure must never be presented as safe to retry.
  try {
    await env.DB.prepare(
      "UPDATE messages SET delivery_status='sent',message_id=?,error_code=NULL WHERE id=?"
    )
      .bind(result.messageId, id)
      .run();
  } catch {
    return json(
      {
        id,
        status: 'uncertain',
        error:
          'Cloudflare accepted the message, but its status could not be saved. Do not send it again.',
      },
      202
    );
  }
  return json({ id, status: 'sent', messageId: result.messageId });
}

async function route(request, env) {
  const url = new URL(request.url);
  const development = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!development && url.hostname !== env.MAIL_HOST)
    throw new HttpError(403, 'This hostname is not allowed.');
  if (
    url.pathname.startsWith('/api/') &&
    !['GET', 'HEAD'].includes(request.method) &&
    !sameOrigin(request)
  )
    throw new HttpError(403, 'Invalid request.');
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const data = await limitedBody(request, 4096);
    const address = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    const attempt = await countLoginAttempt(env, 'login', request, address);
    const mailbox = await env.DB.prepare(
      "SELECT * FROM mailboxes WHERE address=? AND status='active'"
    )
      .bind(address)
      .first();
    const hash =
      mailbox?.password_hash ||
      'dummy:100000:0000000000000000000000000000000000000000000000000000000000000000';
    const valid =
      typeof data?.password === 'string' &&
      data.password.length <= 256 &&
      (await verifyPassword(data.password, hash));
    if (!mailbox || !valid) throw new HttpError(401, 'Incorrect email or password.');
    await attempt.refund();
    const token = randomToken();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mailbox_sessions WHERE expires_at<=?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now),
      env.DB.prepare(
        'INSERT INTO mailbox_sessions(token_hash,mailbox_id,expires_at) VALUES (?,?,?)'
      ).bind(await digest(token), mailbox.id, now + SESSION_SECONDS),
    ]);
    return json({ mailbox: mailbox.address }, 200, {
      'Set-Cookie': cookie(request, token, SESSION_SECONDS),
    });
  }
  if (url.pathname.startsWith('/api/')) {
    const mailbox = await authorized(request, env);
    if (!mailbox) throw new HttpError(401, 'Please sign in.');
    env = {
      ...env,
      MAILBOX: mailbox.address,
      MAILBOX_ID: mailbox.id,
      DISPLAY_NAME: mailbox.display_name,
      SENDING_READY: mailbox.sending_ready,
    };
    if (url.pathname === '/api/me' && request.method === 'GET')
      return json({ mailbox: env.MAILBOX, displayName: env.DISPLAY_NAME });
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM mailbox_sessions WHERE token_hash=?')
        .bind(await digest(sessionToken(request)))
        .run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
    }
    if (url.pathname === '/api/messages' && request.method === 'GET') {
      const folder = url.searchParams.get('folder') || 'inbox';
      if (!['inbox', 'sent', 'trash'].includes(folder)) throw new HttpError(400, 'Invalid folder.');
      const search = (url.searchParams.get('q') || '').slice(0, 100);
      const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
      const match = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const { results } = await env.DB.prepare(
        `SELECT id,folder,sender,recipients,subject,snippet,received_at,is_read,delivery_status,error_code,attachment_count FROM messages
        WHERE mailbox_id=? AND folder=? AND (subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR recipients LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\') ORDER BY received_at DESC LIMIT 51 OFFSET ?`
      )
        .bind(env.MAILBOX_ID, folder, match, match, match, match, offset)
        .all();
      const unread = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE mailbox_id=? AND folder='inbox' AND is_read=0"
      )
        .bind(env.MAILBOX_ID)
        .first();
      return json({
        messages: results.slice(0, 50),
        hasMore: results.length > 50,
        unread: unread.count,
      });
    }
    if (url.pathname === '/api/send' && request.method === 'POST') return sendMail(request, env);
    const path = url.pathname.match(
      /^\/api\/messages\/([^/]+)(?:\/(raw|attachment|render)\/?(\d+)?)?$/
    );
    if (path) {
      const row = await getMessage(env, path[1]);
      if (request.method === 'GET' && path[2] === 'raw') {
        if (!row.raw_key) throw new HttpError(404, 'No original EML is available.');
        const object = await env.MAIL_STORAGE.get(row.raw_key);
        if (!object) throw new HttpError(404, 'Original message not found.');
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${row.id}.eml"`,
          },
        });
      }
      if (request.method === 'GET') {
        const stored = await env.MAIL_STORAGE.get(row.body_key);
        if (!stored)
          throw new HttpError(
            503,
            'Message content is not available yet. Check its status or download the original.'
          );
        const body = await stored.json();
        if (path[2] === 'render')
          return renderHtmlDocument(body.html || '', url.searchParams.get('images') === '1');
        if (path[2] === 'attachment') {
          const attachment = body.attachments?.[Number(path[3])];
          if (!path[3] || !attachment) throw new HttpError(404, 'Attachment not found.');
          const object = await env.MAIL_STORAGE.get(attachment.key);
          if (!object) throw new HttpError(404, 'Attachment not found.');
          return new Response(object.body, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/'/g, '%27')}`,
            },
          });
        }
        return json({
          ...row,
          ...body,
          recipients: JSON.parse(row.recipients),
          attachments: body.attachments.map(({ key, ...a }, index) => ({
            ...a,
            url: `/api/messages/${row.id}/attachment/${index}`,
          })),
        });
      }
      if (request.method === 'PATCH' && !path[2]) {
        const data = await limitedBody(request, 4096);
        if (typeof data?.isRead === 'boolean')
          await env.DB.prepare('UPDATE messages SET is_read=? WHERE id=?')
            .bind(data.isRead ? 1 : 0, row.id)
            .run();
        if (data?.folder === 'trash' && row.folder !== 'trash')
          await env.DB.prepare(
            "UPDATE messages SET previous_folder=folder,folder='trash' WHERE id=?"
          )
            .bind(row.id)
            .run();
        if (data?.folder === 'restore' && row.folder === 'trash')
          await env.DB.prepare(
            "UPDATE messages SET folder=COALESCE(previous_folder,'inbox'),previous_folder=NULL WHERE id=?"
          )
            .bind(row.id)
            .run();
        return json({ ok: true });
      }
    }
    throw new HttpError(404, 'Endpoint not found.');
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
  return env.ASSETS.fetch(request);
}

export async function receiveMail(message, env) {
  const mailbox = await env.DB.prepare(
    "SELECT m.* FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE m.address=? AND m.status='active' AND d.routing_ready=1"
  )
    .bind(message.to.toLowerCase())
    .first();
  if (!mailbox) {
    message.setReject('Mailbox unavailable');
    return;
  }
  env = {
    ...env,
    MAILBOX: mailbox.address,
    MAILBOX_ID: mailbox.id,
    FORWARD_TO: mailbox.forward_to || '',
  };
  if (message.rawSize > MAX_RAW) {
    message.setReject('Message exceeds 25 MB');
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const fingerprint = await digest(
    `${message.from.toLowerCase()}\0${message.to.toLowerCase()}\0${hex(await crypto.subtle.digest('SHA-256', raw))}`
  );
  const id = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-${fingerprint.slice(12, 16)}-${fingerprint.slice(16, 20)}-${fingerprint.slice(20, 32)}`;
  if (await env.DB.prepare('SELECT id FROM messages WHERE id=?').bind(id).first()) return;
  const rawKey = `mailboxes/${env.MAILBOX_ID}/messages/${id}/raw.eml`;
  const bodyKey = `mailboxes/${env.MAILBOX_ID}/messages/${id}/body.json`;
  await env.MAIL_STORAGE.put(rawKey, raw);
  let parsed;
  try {
    parsed = await PostalMime.parse(raw, { maxNestingDepth: 40, maxHeadersSize: 256 * 1024 });
  } catch {
    parsed = {
      subject: message.headers.get('subject') || '(Subject could not be decoded)',
      text: 'Could not parse this message. Download the original EML.',
      attachments: [],
    };
  }
  // message.from is the envelope sender, often a bounce address at a mailing service. Show and
  // reply to the header address, and keep the envelope so the reader can reveal a mismatch.
  const sender = validAddress(parsed.from?.address) ? parsed.from.address : message.from;
  const replyAddress = parsed.replyTo?.[0]?.address;
  const body = {
    text: parsed.text || '',
    html: parsed.html || '',
    replyTo: validAddress(replyAddress) ? replyAddress : sender,
    envelopeFrom: message.from,
    references: parsed.references,
    attachments: [],
  };
  for (let index = 0; index < parsed.attachments.length; index++) {
    const attachment = parsed.attachments[index];
    const key = `mailboxes/${env.MAILBOX_ID}/messages/${id}/attachment-${index}`;
    await env.MAIL_STORAGE.put(key, attachment.content);
    body.attachments.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      type: attachment.mimeType,
      size: attachment.content.byteLength,
      key,
    });
  }
  await env.MAIL_STORAGE.put(bodyKey, JSON.stringify(body));
  await env.DB.prepare(
    `INSERT INTO messages(id,mailbox_id,folder,sender,recipients,subject,snippet,received_at,body_key,raw_key,message_id,attachment_count)
    VALUES (?,?,'inbox',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
  )
    .bind(
      id,
      env.MAILBOX_ID,
      sender,
      JSON.stringify([message.to]),
      parsed.subject || '(No subject)',
      (parsed.text || '').replace(/\s+/g, ' ').slice(0, 160),
      new Date().toISOString(),
      bodyKey,
      rawKey,
      parsed.messageId || message.headers.get('message-id'),
      body.attachments.length
    )
    .run();
  // Forward only once the message is safe, so a forwarding failure cannot lose it. A retry stops at
  // the duplicate check above, so it cannot forward a second copy either.
  if (env.FORWARD_TO && env.FORWARD_TO.toLowerCase() !== env.MAILBOX.toLowerCase()) {
    try {
      await message.forward(env.FORWARD_TO);
    } catch {
      console.error('Forwarding failed');
      await env.DB.prepare("UPDATE messages SET error_code='FORWARD_FAILED' WHERE id=?")
        .bind(id)
        .run();
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return secureHeaders(await route(request, env), true);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed');
      return secureHeaders(
        json(
          {
            error:
              error instanceof HttpError
                ? error.message
                : 'A system error occurred. Please try again later.',
          },
          error.status || 500
        )
      );
    }
  },
};
