import webmail, { receiveMail } from './worker.js';
import admin from './admin.js';
export default {
  email: receiveMail,
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return new Response('Local preview only', { status: 403 });
    if (url.pathname === '/panel') return Response.redirect(url.origin + '/panel/', 302);
    if (url.pathname.startsWith('/panel/')) {
      url.pathname = url.pathname.slice('/panel'.length);
      const assets = env.ASSETS;
      return admin.fetch(new Request(url, request), {
        ...env,
        LOCAL_MOCK: 'true',
        ASSETS: {
          fetch(inner) {
            const assetUrl = new URL(inner.url);
            assetUrl.pathname = '/panel' + assetUrl.pathname;
            return assets.fetch(new Request(assetUrl, inner));
          },
        },
      });
    }
    return webmail.fetch(request, env);
  },
};
