const $ = (selector) => document.querySelector(selector);
const state = {
  view: 'domains',
  domains: [],
  mailboxes: [],
  action: null,
  selected: null,
  busy: false,
};
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#password').value = '';
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
}
async function api(path, method = 'GET', body) {
  const prefix = location.pathname.startsWith('/panel/') ? '/panel' : '';
  const response = await fetch(prefix + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (response.status === 401 && path !== '/api/login') showLogin();
  if (!response.ok)
    throw new Error(
      data.error +
        (data.details?.mx
          ? '\nExisting MX: ' + data.details.mx.map((mx) => mx.content).join(', ')
          : '')
    );
  return data;
}
async function openApp() {
  const me = await api('/api/me');
  $('#admin-name').textContent = me.username;
  $('#local-banner').hidden = !me.localMock;
  $('#login').hidden = true;
  $('#app').hidden = false;
  await refresh();
}
function showView(view) {
  state.view = view;
  for (const name of ['domains', 'mailboxes', 'operations'])
    $('#' + name + '-view').hidden = name !== view;
  $('#view-title').textContent = view[0].toUpperCase() + view.slice(1);
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.classList.toggle('active', button.dataset.view === view));
}
async function run(button, action) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  $('#page-error').textContent = '';
  try {
    await action();
    await refresh();
  } catch (error) {
    $('#page-error').textContent = error.message;
    await refresh();
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}
function button(text, handler, className = 'secondary') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', () => run(element, handler));
  return element;
}
async function refresh() {
  try {
    const [domains, mailboxes, operations, audit] = await Promise.all([
      api('/api/domains'),
      api('/api/mailboxes'),
      api('/api/operations'),
      api('/api/audit'),
    ]);
    state.domains = domains.domains;
    state.mailboxes = mailboxes.mailboxes;
    $('#domain-count').textContent = state.domains.length;
    $('#ready-count').textContent = state.domains.filter(
      (domain) => domain.state === 'ready'
    ).length;
    $('#mailbox-count').textContent = state.mailboxes.length;
    renderDomains();
    renderMailboxes();
    renderOperations(operations.operations, audit.events);
  } catch (error) {
    $('#page-error').textContent = error.message;
  }
}
function renderDomains() {
  const root = $('#domains');
  root.replaceChildren();
  if (!state.domains.length)
    root.append(
      node(
        'div',
        'Sync Cloudflare to discover your domains. No domain is enabled automatically.',
        'empty'
      )
    );
  for (const domain of state.domains) {
    const card = node('article', undefined, 'domain-card');
    const top = node('div', undefined, 'card-top');
    top.append(
      node('h3', domain.name),
      node('span', domain.state.replaceAll('_', ' '), 'pill ' + domain.state)
    );
    const checks = node('div', undefined, 'checks');
    checks.append(
      node(
        'span',
        (domain.sending_ready ? '✓' : '○') + ' Sending',
        domain.sending_ready ? 'yes' : ''
      ),
      node(
        'span',
        (domain.routing_ready ? '✓' : '○') + ' Receiving',
        domain.routing_ready ? 'yes' : ''
      )
    );
    const actions = node('div', undefined, 'domain-actions');
    actions.append(
      button('Check DNS', () => api(`/api/domains/${domain.id}/check`, 'POST', {})),
      button(
        domain.state === 'ready' ? 'Recheck setup' : 'Enable email',
        async () => {
          if (
            domain.state !== 'ready' &&
            !confirm(
              `Enable Cloudflare email for ${domain.name}?\nThe panel checks existing MX records before making changes.`
            )
          )
            return;
          await api(`/api/domains/${domain.id}/enable`, 'POST', {});
        },
        'primary'
      )
    );
    card.append(top, checks);
    if (domain.last_error) card.append(node('p', domain.last_error, 'error'));
    card.append(actions);
    root.append(card);
  }
}
function renderMailboxes() {
  const root = $('#mailboxes');
  root.replaceChildren();
  if (!state.mailboxes.length) {
    const row = node('tr');
    const cell = node('td', 'No mailboxes yet. Enable a domain, then create your first address.');
    cell.colSpan = 4;
    row.append(cell);
    root.append(row);
  }
  for (const mailbox of state.mailboxes) {
    const row = node('tr');
    const identity = node('td');
    identity.append(node('strong', mailbox.address), node('small', mailbox.display_name));
    const status = node('td');
    status.append(node('span', mailbox.status, 'pill ' + mailbox.status));
    const actions = node('div', undefined, 'row-actions');
    if (mailbox.status === 'provisioning')
      actions.append(button('Retry', () => api(`/api/mailboxes/${mailbox.id}/retry`, 'POST', {})));
    else if (mailbox.status !== 'deleting') {
      actions.append(
        button(mailbox.status === 'active' ? 'Suspend' : 'Activate', () =>
          api(`/api/mailboxes/${mailbox.id}/status`, 'POST', {
            status: mailbox.status === 'active' ? 'suspended' : 'active',
          })
        )
      );
      actions.append(
        button('Password', () => openAction('password', mailbox)),
        button('Forwarding', () => openAction('forwarding', mailbox))
      );
    }
    actions.append(
      button(
        mailbox.status === 'deleting' ? 'Finish deletion' : 'Delete',
        () => openAction('delete', mailbox),
        'delete'
      )
    );
    const cell = node('td');
    cell.append(actions);
    row.append(identity, node('td', mailbox.domain), status, cell);
    root.append(row);
  }
}
function renderOperations(operations, events) {
  const root = $('#operations');
  root.replaceChildren();
  if (!operations.length) root.append(node('p', 'No provisioning operations yet.', 'empty'));
  for (const operation of operations) {
    const item = node('div', undefined, 'operation');
    const info = node('div');
    info.append(
      node('strong', operation.kind.replaceAll('_', ' ')),
      node('small', new Date(operation.updated_at).toLocaleString('en-GB'))
    );
    if (operation.error) info.append(node('p', operation.error));
    item.append(info, node('span', operation.state, 'pill ' + operation.state));
    root.append(item);
  }
  const history = $('#audit');
  history.replaceChildren();
  for (const event of events) {
    const item = node(
      'p',
      `${new Date(event.created_at).toLocaleString('en-GB')} · ${event.action.replaceAll('_', ' ')}`
    );
    history.append(item);
  }
}
function openAction(action, mailbox) {
  state.action = action;
  state.selected = mailbox;
  $('#action-error').textContent = '';
  $('#action-value').value = action === 'forwarding' ? mailbox.forward_to || '' : '';
  $('#action-value').type = action === 'password' ? 'password' : 'text';
  $('#action-value').required = action !== 'forwarding';
  $('#action-value').minLength = action === 'password' ? 14 : 0;
  $('#action-value').autocomplete = action === 'password' ? 'new-password' : 'off';
  $('#action-title').textContent =
    action === 'delete'
      ? 'Delete mailbox'
      : action === 'password'
        ? 'Reset password'
        : 'Forwarding';
  $('#action-description').textContent =
    action === 'delete'
      ? `This permanently removes messages and attachments for ${mailbox.address}. Type the email address to confirm.`
      : action === 'password'
        ? `All sessions for ${mailbox.address} will be revoked.`
        : 'Use an external destination already verified in Cloudflare. Leave empty to disable forwarding.';
  $('#action-label').textContent =
    action === 'delete' ? 'Email address' : action === 'password' ? 'New password' : 'Destination';
  $('#action-submit').textContent = action === 'delete' ? 'Delete permanently' : 'Save';
  $('#action-dialog').showModal();
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', 'POST', {
      username: $('#username').value,
      password: $('#password').value,
    });
    $('#password').value = '';
    await openApp();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST', {});
    showLogin();
  } catch (error) {
    toast(error.message);
  }
});
document
  .querySelectorAll('[data-view]')
  .forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#refresh').addEventListener('click', () => refresh());
$('#sync').addEventListener('click', () =>
  run($('#sync'), () => api('/api/domains/sync', 'POST', {}))
);
$('#create').addEventListener('click', () => {
  const ready = state.domains.filter((domain) => domain.state === 'ready');
  if (!ready.length) {
    toast('Enable and verify a domain first.');
    return;
  }
  $('#mailbox-form').reset();
  $('#create-error').textContent = '';
  $('#domain-select').replaceChildren();
  for (const domain of ready) {
    const option = node('option', domain.name);
    option.value = domain.id;
    $('#domain-select').append(option);
  }
  previewAddress();
  $('#mailbox-dialog').showModal();
});
function previewAddress() {
  const domain = state.domains.find((domain) => domain.id === $('#domain-select').value);
  $('#address-preview').textContent =
    ($('#local-part').value || 'name') + '@' + (domain?.name || '');
}
$('#domain-select').addEventListener('change', previewAddress);
$('#local-part').addEventListener('input', previewAddress);
$('#mailbox-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#create-submit').disabled = true;
  $('#create-error').textContent = '';
  try {
    const result = await api('/api/mailboxes', 'POST', {
      domainId: $('#domain-select').value,
      localPart: $('#local-part').value,
      displayName: $('#display-name').value,
      password: $('#mailbox-password').value,
    });
    $('#mailbox-password').value = '';
    $('#mailbox-dialog').close();
    showView('mailboxes');
    toast('Created ' + result.address);
    await refresh();
  } catch (error) {
    $('#create-error').textContent = error.message;
    await refresh();
  } finally {
    $('#create-submit').disabled = false;
  }
});
$('#action-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#action-submit').disabled = true;
  $('#action-error').textContent = '';
  try {
    const id = state.selected.id;
    const value = $('#action-value').value;
    const action = state.action;
    await api(
      `/api/mailboxes/${id}` + (action === 'delete' ? '' : '/' + action),
      action === 'delete' ? 'DELETE' : 'POST',
      action === 'delete'
        ? { confirm: value }
        : action === 'password'
          ? { password: value }
          : { address: value }
    );
    $('#action-value').value = '';
    $('#action-dialog').close();
    toast('Mailbox updated.');
    await refresh();
  } catch (error) {
    $('#action-error').textContent = error.message;
    await refresh();
  } finally {
    $('#action-submit').disabled = false;
  }
});
document.querySelectorAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => {
    if (!$('#action-submit').disabled && !$('#create-submit').disabled)
      button.closest('dialog').close();
  })
);
openApp().catch(() => {});
