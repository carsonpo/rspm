import { createLinkShare, createRecipientShare, openShare, deleteShare, createIdentity, publishHandle,
  lookupHandle, unpublishHandle, parseShareFragment, normalizeHandle } from '../core/share.js';
import { random } from '../core/crypto.js';
import { testStore } from './helpers.js';
import { eq, ok } from '../tools/check.js';

const item = { id: 'x', type: 'login', name: 'Bank', username: 'me', password: 'hunter2', updated: 1 };

export async function linkShareRoundTrip() {
  const { store } = testStore();
  const { url, entry } = await createLinkShare(store, item, { hours: 2, burn: true, origin: 'https://rspm.link' });
  ok(url.startsWith('https://rspm.link/#l1.'));
  const frag = new URL(url).hash;
  const opened = await openShare(store, frag);
  eq(opened.item, item);
  eq(opened.meta.burn, true);
  await deleteShare(store, { kind: 'link', s: opened.s, hour: opened.hour, n: opened.meta.n });
  let err;
  try { await openShare(store, frag); } catch (e) { err = e; }
  ok(err && /expired or was revoked/.test(err.message));
  ok(entry.s && entry.n >= 1);
}

export async function largeShareSpansBlocks() {
  const { store } = testStore();
  const big = { ...item, notes: Array.from(random(6000), (b) => b.toString(36)).join('') };
  const { url } = await createLinkShare(store, big, { hours: 1 });
  eq((await openShare(store, new URL(url).hash)).item, big);
}

import { x25519, x25519Generate } from '../core/crypto.js';

const hasX25519 = await (async () => {
  try { const a = await x25519Generate(), b = await x25519Generate(); await x25519(a.sk, b.pk); return true; } catch { return false; }
})();

export async function recipientShareRoundTrip() {
  if (!hasX25519) { console.log('        (skipped: this runtime has no X25519 in WebCrypto)'); return; }
  const { store } = testStore();
  const alice = await createIdentity('Alice');
  const bob = await createIdentity('bob');
  const mallory = await createIdentity('mallory');
  ok(await publishHandle(store, bob), 'publish');
  ok(await publishHandle(store, bob), 'republish is idempotent');
  ok(!(await publishHandle(store, { ...mallory, handle: 'bob' })), 'handle squatting refused');

  const rec = await lookupHandle(store, 'BOB');
  ok(rec && /^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/.test(rec.fingerprint), 'fingerprint format');
  const { url, entry } = await createRecipientShare(store, item, rec, { hours: 1, from: alice.handle });
  const frag = new URL(url).hash;

  const got = await openShare(store, frag, bob);
  eq(got.item, item);
  eq(got.meta.from, 'alice');
  eq(got.meta.to, 'bob');

  for (const who of [mallory, null]) {
    let err;
    try { await openShare(store, frag, who); } catch (e) { err = e; }
    ok(err, 'non-recipient cannot open');
  }

  await deleteShare(store, entry);
  let err;
  try { await openShare(store, frag, bob); } catch (e) { err = e; }
  ok(err && /expired or was revoked/.test(err.message), 'revoked');

  ok(await unpublishHandle(store, bob), 'unpublish');
  eq(await lookupHandle(store, 'bob'), null);
}

export function fragments() {
  eq(parseShareFragment('#l1.482000.abc'), { kind: 'link', hour: 482000, value: 'abc' });
  eq(parseShareFragment('#x1.1.a'), null);
  eq(normalizeHandle(' Carson '), 'carson');
}
