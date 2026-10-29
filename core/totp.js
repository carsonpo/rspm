// RFC 6238 TOTP / RFC 4226 HOTP, and otpauth:// URIs.

const ALGS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** Lenient RFC 4648 base32 (any case, spaces and padding allowed), as authenticator apps expect. */
export function decodeSecret(str) {
  const s = str.toUpperCase().replace(/[\s=-]/g, '');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out = [];
  let bits = 0, acc = 0;
  for (const c of s) {
    const v = A.indexOf(c);
    if (v < 0) throw new Error('The secret contains characters that are not base32');
    acc = ((acc << 5) | v) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  if (!out.length) throw new Error('The secret is empty');
  return new Uint8Array(out);
}

export function parseOtpauth(uri) {
  let u;
  try { u = new URL(uri.trim()); } catch { u = null; }
  if (!u || u.protocol !== 'otpauth:') {
    // Bare secret: default parameters.
    return { secret: decodeSecret(uri), algorithm: 'SHA1', digits: 6, period: 30, issuer: '', account: '' };
  }
  if (u.hostname !== 'totp') throw new Error('Only time-based (TOTP) codes are supported');
  const p = u.searchParams;
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const [issuerFromLabel, account] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  const algorithm = (p.get('algorithm') ?? 'SHA1').toUpperCase();
  if (!(algorithm in ALGS)) throw new Error(`Unsupported algorithm ${algorithm}`);
  const digits = Number(p.get('digits') ?? 6);
  const period = Number(p.get('period') ?? 30);
  if (![6, 7, 8].includes(digits)) throw new Error('Codes must be 6–8 digits');
  if (!(period >= 1 && period <= 300)) throw new Error('Invalid period');
  return { secret: decodeSecret(p.get('secret') ?? ''), algorithm, digits, period, issuer: p.get('issuer') ?? issuerFromLabel, account: account.trim() };
}

export async function hotp(secret, counter, { algorithm = 'SHA1', digits = 6 } = {}) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: ALGS[algorithm] }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** { code, remaining } for an otpauth URI or bare secret at time `now` (ms). */
export async function totp(uriOrSecret, now = Date.now()) {
  const p = typeof uriOrSecret === 'string' ? parseOtpauth(uriOrSecret) : uriOrSecret;
  const t = Math.floor(now / 1000);
  const code = await hotp(p.secret, Math.floor(t / p.period), p);
  return { code, remaining: p.period - (t % p.period), period: p.period };
}
