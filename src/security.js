export const encoder = new TextEncoder();
export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export async function passwordHash(password, salt, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return hex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations },
      key,
      256
    )
  );
}
export async function verifyPassword(password, encoded) {
  const [salt, rounds, expected] = (encoded || '').split(':');
  if (!salt || Number(rounds) !== 100000 || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  const actual = await passwordHash(password, salt, Number(rounds));
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function validAddress(value) {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(value)
  );
}
export function sessionToken(request) {
  const match = (request.headers.get('cookie') || '').match(
    /(?:^|;\s*)cm_session=([a-f0-9]{64})(?:;|$)/
  );
  return match?.[1];
}
export function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}
export function secureHeaders(response, html = false) {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  if (!result.headers.has('X-Frame-Options')) result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (html && !result.headers.has('Content-Security-Policy'))
    result.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
  if (new URL(result.url || 'https://local.invalid').protocol === 'https:')
    result.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return result;
}
