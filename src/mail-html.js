import sanitizeHtml from 'sanitize-html';

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}
export function cleanEmailHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'style', 'img', 'font', 'center'],
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': [
        'style',
        'class',
        'id',
        'align',
        'valign',
        'bgcolor',
        'width',
        'height',
        'dir',
        'lang',
        'role',
        'aria-label',
      ],
      a: ['href', 'name', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'border', 'style'],
      table: [
        'style',
        'class',
        'id',
        'align',
        'bgcolor',
        'width',
        'height',
        'border',
        'cellpadding',
        'cellspacing',
        'role',
      ],
      td: ['style', 'class', 'align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
      th: ['style', 'class', 'align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
      font: ['color', 'size', 'face', 'style'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['https', 'http', 'cid', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    },
  });
}
export function composeContent(text, original) {
  const answer = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#202124;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  if (!original) return { text, html: answer };
  const date =
    new Date(original.received_at).toLocaleString('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' UTC';
  const attribution = `On ${date}, ${original.sender} wrote:`;
  const quoted = original.html
    ? cleanEmailHtml(original.html)
    : `<div style="white-space:pre-wrap">${escapeHtml(original.text || '')}</div>`;
  return {
    text: `${text}\n\n${attribution}\n${(original.text || '[HTML message]')
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n')}`,
    html: `${answer}<div style="margin-top:24px;font:12px/1.5 Arial,sans-serif;color:#666">${escapeHtml(attribution)}</div><blockquote style="margin:12px 0 0 0;padding-left:16px;border-left:2px solid #ddd">${quoted}</blockquote>`,
  };
}
export function renderHtmlDocument(html, images = false) {
  const imagePolicy = images ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imagePolicy}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox`;
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.6 Arial,sans-serif;color:#202124;margin:12px;overflow-wrap:anywhere}img,table{max-width:100%}</style></head><body>${cleanEmailHtml(html)}</body></html>`;
  return new Response(document, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}
