import { receiveMail } from './worker.js';
export default {
  email: receiveMail,
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
