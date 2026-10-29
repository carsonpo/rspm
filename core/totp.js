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

/** RFC 4648 base32, unpadded. */
export function encodeSecret(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += A[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += A[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Google Authenticator's "Export accounts" QR codes:
 * otpauth-migration://offline?data=<base64 protobuf MigrationPayload>.
 * Returns { accounts: [{ name, issuer, uri }], skipped } where skipped counts
 * entries we can't use (counter-based HOTP, MD5).
 */
export function parseMigration(uri) {
  let u;
  try { u = new URL(uri.trim()); } catch { u = null; }
  if (!u || u.protocol !== 'otpauth-migration:') throw new Error('Not a Google Authenticator export');
  const b64 = (u.searchParams.get('data') ?? '').replace(/-/g, '+').replace(/_/g, '/');
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw new Error('The export data is damaged'); }

  const accounts = [];
  let skipped = 0;
  for (const [field, value] of protobufFields(bytes)) {
    if (field !== 1 || !(value instanceof Uint8Array)) continue;
    const p = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2 };
    for (const [f, v] of protobufFields(value)) {
      if (f === 1 && v instanceof Uint8Array) p.secret = v;
      else if (f === 2 && v instanceof Uint8Array) p.name = new TextDecoder().decode(v);
      else if (f === 3 && v instanceof Uint8Array) p.issuer = new TextDecoder().decode(v);
      else if (f === 4 && typeof v === 'number') p.algorithm = v;
      else if (f === 5 && typeof v === 'number') p.digits = v;
      else if (f === 6 && typeof v === 'number') p.type = v;
    }
    // Algorithm: 0/1 SHA1, 2 SHA256, 3 SHA512, 4 MD5. Digits: 0/1 six, 2 eight. Type: 1 HOTP, 2 TOTP.
    const algorithm = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[p.algorithm];
    if (!p.secret?.length || p.type === 1 || !algorithm) { skipped++; continue; }
    const digits = p.digits === 2 ? 8 : 6;
    // The name is often "Issuer:account" already.
    const account = p.issuer && p.name.startsWith(`${p.issuer}:`) ? p.name.slice(p.issuer.length + 1) : p.name;
    const label = p.issuer ? `${encodeURIComponent(p.issuer)}:${encodeURIComponent(account)}` : encodeURIComponent(account);
    const q = new URLSearchParams({ secret: encodeSecret(p.secret) });
    if (p.issuer) q.set('issuer', p.issuer);
    if (algorithm !== 'SHA1') q.set('algorithm', algorithm);
    if (digits !== 6) q.set('digits', String(digits));
    accounts.push({ name: p.issuer || account, account, issuer: p.issuer, uri: `otpauth://totp/${label}?${q}` });
  }
  if (!accounts.length && !skipped) throw new Error('The export has no accounts');
  return { accounts, skipped };
}

/** Minimal protobuf reader: yields [field, value], value a number (varint) or Uint8Array (length-delimited). */
function* protobufFields(b) {
  let i = 0;
  const varint = () => {
    let v = 0, mul = 1;
    for (;;) {
      if (i >= b.length) throw new Error('The export data is damaged');
      const x = b[i++];
      v += (x & 0x7f) * mul;
      if (!(x & 0x80)) return v;
      mul *= 128;
      if (mul > 2 ** 63) throw new Error('The export data is damaged');
    }
  };
  while (i < b.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) yield [field, varint()];
    else if (wire === 2) {
      const n = varint();
      if (i + n > b.length) throw new Error('The export data is damaged');
      yield [field, b.subarray(i, i + n)];
      i += n;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('The export data is damaged');
  }
}
