const $ = (selector) => document.querySelector(selector);
const state = {
  folder: 'inbox',
  offset: 0,
  hasMore: false,
  current: null,
  replyId: null,
  sendId: null,
  sending: false,
  loadVersion: 0,
  readVersion: 0,
};
const folders = { inbox: 'Inbox', sent: 'Sent', trash: 'Trash' };
const statuses = {
  preparing: 'Preparing to send',
  sending: 'Send status unknown',
  sent: 'Accepted by Cloudflare',
  failed: 'Send failed',
  uncertain: 'Send status unknown',
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 5000);
}
function showLogin() {
  $('#login').hidden = false;
  $('#mail-app').hidden = true;
  $('#password').value = '';
  $('#compose-dialog').close();
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (response.status === 401 && path !== '/api/login') showLogin();
  if (!response.ok) {
    const error = new Error(
      result.error || (result.status ? statuses[result.status] : 'Could not complete this action.')
    );
    Object.assign(error, result);
    error.httpStatus = response.status;
    throw error;
  }
  return result;
}
async function openApp() {
  const me = await api('/api/me');
  $('#mailbox').textContent = me.mailbox;
  $('.sidebar-bottom strong').textContent = me.displayName;
  $('.dialog-header .eyebrow').textContent = 'FROM ' + me.mailbox.toUpperCase();
  $('#login').hidden = true;
  $('#mail-app').hidden = false;
  await loadMessages();
}
function time(value, full = false) {
  const date = new Date(value);
  return date.toLocaleString(
    'en-GB',
    full ? { dateStyle: 'medium', timeStyle: 'short' } : { day: '2-digit', month: '2-digit' }
  );
}
async function loadMessages() {
  const version = ++state.loadVersion;
  $('#folder-title').textContent = folders[state.folder];
  document
    .querySelectorAll('[data-folder]')
    .forEach((node) => node.classList.toggle('active', node.dataset.folder === state.folder));
  try {
    const data = await api(
      `/api/messages?folder=${state.folder}&offset=${state.offset}&q=${encodeURIComponent($('#search').value)}`
    );
    if (version !== state.loadVersion) return;
    $('#messages').replaceChildren();
    $('#unread').textContent = data.unread;
    state.hasMore = data.hasMore;
    $('#list-count').textContent = data.messages.length
      ? `${state.offset + 1}–${state.offset + data.messages.length} messages`
      : 'No messages yet';
    if (!data.messages.length)
      $('#messages').append(
        element(
          'div',
          $('#search').value
            ? 'No matching messages.'
            : 'Messages in this folder will appear here.',
          'empty-list'
        )
      );
    for (const message of data.messages) {
      const button = element(
        'button',
        undefined,
        `message ${message.is_read ? '' : 'unread'} ${state.current?.id === message.id ? 'selected' : ''}`
      );
      button.type = 'button';
      const row = element('div', undefined, 'row');
      let sender = message.sender;
      if (state.folder === 'sent')
        try {
          sender = JSON.parse(message.recipients).join(', ');
        } catch {}
      row.append(element('span', sender, 'sender'), element('time', time(message.received_at)));
      button.append(
        row,
        element('span', message.subject, 'subject'),
        element('span', (message.attachment_count ? '↗ ' : '') + message.snippet, 'snippet')
      );
      if (['preparing', 'sending', 'failed', 'uncertain'].includes(message.delivery_status))
        button.append(element('span', statuses[message.delivery_status], 'status'));
      button.addEventListener('click', () => readMessage(message.id));
      $('#messages').append(button);
    }
    $('#pagination').hidden = state.offset === 0 && !state.hasMore;
    $('#previous').disabled = state.offset === 0;
    $('#next').disabled = !state.hasMore;
    $('#page-number').textContent = `Page ${state.offset / 50 + 1}`;
  } catch (error) {
    if (version === state.loadVersion) toast(error.message);
  }
}
function clearReader() {
  state.current = null;
  state.readVersion++;
  $('.mail-workspace').classList.remove('reading');
  $('#reader').replaceChildren();
  const empty = element('div', undefined, 'empty-reader');
  empty.append(
    element('span', '✉', 'empty-symbol'),
    element('h2', 'Choose a message to read'),
    element('p', 'Your private BeeCloudMail inbox.')
  );
  $('#reader').append(empty);
}
function safeHtml(html, loadImages = false) {
  const documentBody = new DOMParser().parseFromString(html, 'text/html');
  documentBody
    .querySelectorAll(
      'script,iframe,frame,object,embed,form,input,button,textarea,select,meta,link,base,svg,math,video,audio,source'
    )
    .forEach((node) => node.remove());
  const styles = [...documentBody.head.querySelectorAll('style')]
    .map((node) => node.outerHTML)
    .join('');
  const allowed = new Set([
    'href',
    'src',
    'style',
    'class',
    'id',
    'align',
    'valign',
    'bgcolor',
    'border',
    'cellpadding',
    'cellspacing',
    'alt',
    'title',
    'width',
    'height',
    'colspan',
    'rowspan',
    'color',
    'size',
    'face',
    'dir',
    'lang',
    'role',
  ]);
  for (const node of documentBody.body.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || !allowed.has(name)) node.removeAttribute(attribute.name);
    }
    if (node.hasAttribute('src')) {
      let safe = false;
      try {
        safe =
          node.tagName === 'IMG' &&
          ['https:', 'http:', 'data:'].includes(new URL(node.getAttribute('src')).protocol);
      } catch {}
      if (!safe) node.removeAttribute('src');
    }
    if (node.hasAttribute('href')) {
      let safe = false;
      try {
        safe = ['https:', 'http:', 'mailto:'].includes(new URL(node.getAttribute('href')).protocol);
      } catch {}
      if (!safe) node.removeAttribute('href');
      else {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  const imagePolicy = loadImages ? 'data: https: http:' : 'data:';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imagePolicy}; base-uri 'none'; form-action 'none'"><style>body{font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere;color:#202124;margin:12px}img,table{max-width:100%}</style>${styles}</head><body>${documentBody.body.innerHTML}</body></html>`;
}
function htmlViewer(html, title, id) {
  const wrapper = element('div', undefined, 'html-viewer');
  const controls = element('div', undefined, 'html-controls');
  const notice = element('span', 'External images are hidden.', 'muted');
  const images = element('button', 'Show images', 'subtle');
  images.type = 'button';
  const frame = element('iframe', undefined, 'mail-html');
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  if (id) frame.src = `/api/messages/${id}/render`;
  else frame.srcdoc = safeHtml(html);
  images.addEventListener('click', () => {
    if (id) frame.src = `/api/messages/${id}/render?images=1`;
    else frame.srcdoc = safeHtml(html, true);
    notice.textContent = 'External images enabled for this view.';
    images.remove();
  });
  controls.append(notice, images);
  wrapper.append(controls, frame);
  return wrapper;
}
async function readMessage(id) {
  const version = ++state.readVersion;
  try {
    const message = await api(`/api/messages/${id}`);
    if (version !== state.readVersion) return;
    state.current = message;
    $('.mail-workspace').classList.add('reading');
    const reader = $('#reader');
    reader.replaceChildren();
    const toolbar = element('div', undefined, 'reader-toolbar');
    const left = element('div');
    const back = element('button', '← Messages', 'back-list');
    back.addEventListener('click', () => $('.mail-workspace').classList.remove('reading'));
    left.append(back);
    const reply = element('button', '↶ Reply');
    reply.addEventListener('click', () => compose(message));
    left.append(reply);
    const trash = element('button', message.folder === 'trash' ? 'Restore' : 'Move to trash');
    trash.addEventListener('click', async () => {
      try {
        await api(`/api/messages/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ folder: message.folder === 'trash' ? 'restore' : 'trash' }),
        });
        clearReader();
        await loadMessages();
      } catch (error) {
        toast(error.message);
      }
    });
    toolbar.append(left, trash);
    reader.append(toolbar, element('h2', message.subject));
    const meta = element('div', undefined, 'reader-meta');
    const info = element('div');
    const domainOf = (address) => String(address).split('@').pop().toLowerCase();
    info.append(element('strong', message.sender));
    if (message.envelopeFrom && domainOf(message.envelopeFrom) !== domainOf(message.sender))
      info.append(element('p', `via ${domainOf(message.envelopeFrom)}`));
    info.append(
      element('p', `To: ${message.recipients.join(', ')}`),
      element('time', time(message.received_at, true))
    );
    meta.append(element('span', message.sender.slice(0, 2).toUpperCase(), 'avatar'), info);
    reader.append(meta);
    if (['preparing', 'sending', 'uncertain', 'failed'].includes(message.delivery_status))
      reader.append(
        element(
          'p',
          `${statuses[message.delivery_status]}${message.error_code ? ` (${message.error_code})` : ''}. ${message.delivery_status === 'failed' ? 'This message was not accepted for sending.' : 'Check Cloudflare Email Logs before sending again.'}`,
          'reader-warning'
        )
      );
    if (message.error_code === 'FORWARD_FAILED')
      reader.append(
        element('p', 'This message could not be sent to your forwarding address.', 'reader-warning')
      );
    if (message.html) {
      reader.append(htmlViewer(message.html, 'HTML message content', message.id));
      if (message.text) {
        const details = element('details', undefined, 'text-version');
        details.append(
          element('summary', 'View plain text'),
          element('div', message.text, 'mail-text')
        );
        reader.append(details);
      }
    } else reader.append(element('div', message.text || 'This message is empty.', 'mail-text'));
    if (message.attachments.length) {
      const files = element('div', undefined, 'attachments');
      for (const attachment of message.attachments) {
        const a = element(
          'a',
          `↗ ${attachment.filename} · ${Math.ceil(attachment.size / 1024)} KB`
        );
        a.href = attachment.url;
        a.setAttribute('download', attachment.filename);
        files.append(a);
      }
      reader.append(files);
    }
    if (message.raw_key) {
      const a = element('a', 'Download original (.eml)', 'raw-link');
      a.href = `/api/messages/${id}/raw`;
      reader.append(a);
    }
    if (!message.is_read)
      await api(`/api/messages/${id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) });
    await loadMessages();
  } catch (error) {
    toast(error.message);
  }
}
function compose(message) {
  if (state.sending) return;
  $('#compose-form').reset();
  $('#compose-error').textContent = '';
  $('#file-list').textContent = '';
  state.sendId = crypto.randomUUID();
  state.replyId = message?.id || null;
  $('#send-submit').disabled = false;
  $('#send-submit').textContent = 'Send message ↗';
  const quote = $('#reply-quote');
  quote.replaceChildren();
  quote.hidden = !message;
  if (message) {
    $('#to').value =
      message.folder === 'sent' ? message.recipients.join('; ') : message.replyTo || message.sender;
    $('#subject').value = /^re:/i.test(message.subject)
      ? message.subject
      : `Re: ${message.subject}`;
    quote.append(element('p', 'The original message will be included below your reply.', 'muted'));
    if (message.html) quote.append(htmlViewer(message.html, 'Quoted original message', message.id));
    else quote.append(element('div', message.text || '', 'mail-text'));
  }
  $('#compose-dialog').showModal();
  (message ? $('#body') : $('#to')).focus();
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-submit').disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value }),
    });
    $('#password').value = '';
    await openApp();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    $('#login-submit').disabled = false;
  }
});
$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    showLogin();
    clearReader();
  } catch (error) {
    toast(error.message);
  }
});
$('#compose').addEventListener('click', () => compose());
$('#empty-compose').addEventListener('click', () => compose());
$('#close-compose').addEventListener('click', () => {
  if (!state.sending) $('#compose-dialog').close();
});
$('#compose-dialog').addEventListener('cancel', (event) => {
  if (state.sending) event.preventDefault();
});
document.querySelectorAll('[data-folder]').forEach((node) =>
  node.addEventListener('click', () => {
    state.folder = node.dataset.folder;
    state.offset = 0;
    $('#search').value = '';
    clearReader();
    loadMessages();
  })
);
$('#refresh').addEventListener('click', () => loadMessages());
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.offset = 0;
    loadMessages();
  }, 250);
});
$('#previous').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - 50);
  loadMessages();
});
$('#next').addEventListener('click', () => {
  state.offset += 50;
  loadMessages();
});
$('#files').addEventListener('change', () => {
  $('#file-list').textContent = [...$('#files').files].map((file) => file.name).join(' · ');
});
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.readAsDataURL(file);
  });
}
$('#compose-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sending) return;
  $('#compose-error').textContent = '';
  const files = [...$('#files').files];
  if (files.length > 10 || files.reduce((n, f) => n + f.size, 0) > 2.5 * 1024 * 1024) {
    $('#compose-error').textContent = 'Up to 10 files, with a total size of 2.5 MB.';
    return;
  }
  state.sending = true;
  $('#send-submit').disabled = true;
  $('#send-submit').textContent = 'Sending…';
  let blocked = false;
  try {
    const attachments = await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        type: file.type || 'application/octet-stream',
        content: await fileBase64(file),
      }))
    );
    const result = await api('/api/send', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.sendId },
      body: JSON.stringify({
        to: $('#to').value,
        subject: $('#subject').value,
        text: $('#body').value,
        replyId: state.replyId,
        attachments,
      }),
    });
    if (result.status !== 'sent') {
      blocked = true;
      $('#compose-error').textContent =
        result.error || 'Send status unknown. Check Email Logs before sending again.';
      return;
    }
    $('#compose-dialog').close();
    toast('Cloudflare accepted your message for sending.');
    state.folder = 'sent';
    state.offset = 0;
    $('#search').value = '';
    clearReader();
    await loadMessages();
  } catch (error) {
    $('#compose-error').textContent = error.message;
    if (error.status === 'failed') {
      state.sendId = crypto.randomUUID();
    } else if (!error.httpStatus || error.status || error.httpStatus >= 500) {
      blocked = true;
      $('#compose-error').textContent +=
        '\nThe result may not have been updated. Check Sent and Email Logs before starting a new send attempt.';
    }
  } finally {
    state.sending = false;
    $('#send-submit').disabled = blocked;
    $('#send-submit').textContent = blocked ? 'Check send status first' : 'Send message ↗';
  }
});
openApp().catch(() => {});
