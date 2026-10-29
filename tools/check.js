// Tiny assertion helpers for tests. Zero dependencies.

export class AssertionError extends Error {}

export function ok(value, msg = 'expected truthy value') {
  if (!value) throw new AssertionError(msg);
}

export function eq(actual, expected, msg) {
  const a = show(actual), e = show(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
}

export function throws(fn, pattern) {
  try { fn(); } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new AssertionError(`error "${err.message}" does not match ${pattern}`);
    return err;
  }
  throw new AssertionError('expected function to throw');
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function show(v) {
  if (v instanceof Uint8Array) return `bytes(${hex(v)})`;
  if (typeof v === 'bigint') return `${v}n`;
  return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
}
