// Password and passphrase generation, and a rough strength estimate.

import { WORDS } from './words.js';

/** Uniform random integer in [0, n) via rejection sampling. */
export function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!#$%&*+-=?@^_~',
};

export function generatePassword({ length = 20, digits = true, symbols = true } = {}) {
  const pools = [SETS.lower, SETS.upper, digits && SETS.digits, symbols && SETS.symbols].filter(Boolean);
  const all = pools.join('');
  for (;;) {
    const out = Array.from({ length }, () => all[randomInt(all.length)]).join('');
    // Ensure every chosen class appears (retry is cheap and keeps the distribution uniform over valid outputs).
    if (pools.every((p) => [...out].some((c) => p.includes(c)))) return out;
  }
}

export function generatePassphrase({ words = 6, separator = '-' } = {}) {
  return Array.from({ length: words }, () => WORDS[randomInt(WORDS.length)]).join(separator);
}

export const passphraseBits = (words) => words * 11;
export const passwordBits = ({ length, digits, symbols }) =>
  Math.floor(length * Math.log2(SETS.lower.length + SETS.upper.length + (digits ? SETS.digits.length : 0) + (symbols ? SETS.symbols.length : 0)));

const WORDSET = new Set(WORDS);

/**
 * Rough entropy estimate for a human-chosen password, in bits. Deliberately
 * conservative: it discounts character-class entropy heavily, because people
 * don't choose characters at random. Generated passphrases are scored exactly.
 */
export function estimateBits(pw) {
  if (!pw) return 0;
  const parts = pw.toLowerCase().split(/[\s\-_.,]+/).filter(Boolean);
  if (parts.length >= 3 && parts.every((w) => WORDSET.has(w))) return parts.length * 11;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  const effectiveLength = Math.min(pw.length, unique * 2);
  return Math.floor(effectiveLength * Math.log2(Math.max(pool, 2)) * 0.6);
}

export function strengthLabel(bits) {
  if (bits < 35) return { level: 0, label: 'Weak' };
  if (bits < 55) return { level: 1, label: 'Fair' };
  if (bits < 75) return { level: 2, label: 'Good' };
  return { level: 3, label: 'Strong' };
}
