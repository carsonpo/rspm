// End-to-end test in headless Chrome against a throwaway local server and bucket.
// Covers what unit tests can't reach: the real UI, the browser's WebCrypto and
// WASM, share links, and passkey protection through a virtual WebAuthn
// authenticator with PRF (starting once from a platform authenticator, once from
// a USB key; the security-key run also adds a platform authenticator as a second passkey).
//
// Usage: node tools/e2e.js   (needs Chrome; set CHROME=/path/to/chrome if it isn't found)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, HELPERS } from './browser.js';
import { startDev } from './dev.js';

const bucketDir = mkdtempSync(join(tmpdir(), 'rspm-e2e-'));
const dev = await startDev({ port: Number(process.env.E2E_PORT ?? 4760), bucketDir, powBits: 12, quiet: true });
const browser = await launch({ port: 9340 });
// This scenario's device record: device:{hex(salt(username))}, PROTOCOL §3.3 and §10.
const DEVICE = `(async () => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rspm/v1/salt' + window.__user.trim().normalize('NFKC').toLowerCase())));
  const key = 'device:' + [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Promise((res) => { const r = indexedDB.open('rspm'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); }; });
})()`;
let failed = 0;
let cleanup = async () => {};

async function scenario(name, transport) {
  const page = await browser.page();
  const step = async (label, body) => {
    try {
      const r = await page.eval(HELPERS + body);
      console.log(`  ok    ${name} › ${label}${r && !String(r).includes('#') ? ` (${r})` : ''}`); // never log share secrets
      return r;
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name} › ${label}\n        ${err.message.split('\n')[0]}`);
      throw err;
    }
  };
  await page.send('WebAuthn.enable', { enableUI: false });
  const authenticator = async (t) => (await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: t, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  })).authenticatorId;
  const first = await authenticator(transport);
  // Virtual authenticators outlive their scenario otherwise, and Chrome may route the next one's requests to them.
  cleanup = () => page.send('WebAuthn.clearVirtualAuthenticators').catch(() => {});
  await page.size(1280, 860);
  await page.goto(`${dev.origin}/`);
  const user = `e2e-${transport}-${Date.now().toString(36)}`;
  const pw = 'violet-anchor-mosaic-tundra';

  await step('create a vault', `
    window.__user = '${user}';
    $t.click('Create a vault'); await $t.sleep(100);
    document.querySelector('.toggle input').click(); $t.click('Continue'); await $t.sleep(100);
    $t.type('Username', '${user}'); $t.type('Password', '${pw}'); $t.type('Confirm password', '${pw}');
    $t.click('Continue'); await $t.sleep(150);
    window.__key = document.querySelector('.account-key').textContent;
    $t.click('Copy'); $t.click('I’ve saved it'); await $t.sleep(100);
    $t.type('End of your Account Key', window.__key.split('-').slice(-2).join('-'));
    $t.click('Create vault');
    await $t.until(() => document.querySelector('dialog .passkey-hero'), 30000);`);

  await step('protect the Account Key with a passkey', `
    $t.click('Set up'); await $t.until(() => !document.querySelector('dialog'), 20000);
    const rec = await ${DEVICE};
    if (rec?.passkeys?.length !== 1) throw new Error('no passkey record stored');
    if ('akey' in rec) throw new Error('plaintext Account Key was stored alongside the passkey');
    return rec.passkeys[0].kind;`);

  await step('add a login', `
    $t.click('New item'); await $t.sleep(100); $t.click('Login'); await $t.sleep(100);
    $t.type('Name', 'GitHub'); $t.type('Username', 'me@example.com'); $t.type('Password', 'hunter2-but-longer');
    $t.click('Add to vault');
    await $t.until(() => document.querySelector('.detail-title')?.textContent === 'GitHub' && !document.querySelector('.editor'), 30000);`);

  const link = await step('create a share link', `
    $t.click('Share'); await $t.sleep(200); $t.click('Create share');
    await $t.until(() => document.querySelector('.share-result'), 30000);
    const url = document.querySelector('dialog code').textContent; $t.click('Done'); return url;`);

  const guest = await browser.page();
  await guest.goto(link);
  try {
    await guest.eval(HELPERS + `await $t.until(() => $t.text().includes('GitHub') && /shared with you/i.test($t.text()), 15000);
      if (location.hash) throw new Error('share secret left in the address bar');`);
    console.log(`  ok    ${name} › open the share link in another browser`);
  } catch (err) { failed++; console.log(`  FAIL  ${name} › open the share link\n        ${err.message}`); }

  // Hidden tabs don't render, and Chrome defers a hidden <dialog>'s close event until they do.
  await page.send('Page.bringToFront');
  await step('lock, then unlock with the passkey', `
    document.querySelector('.sidebar-foot .icon-btn').click();
    await $t.until(() => document.querySelector('.auth-card'));
    $t.type('Username', '${user}'); await $t.until(() => document.querySelector('.remembered-key'));
    $t.type('Password', '${pw}'); $t.click('Unlock');
    await $t.until(() => [...document.querySelectorAll('.item-row-name')].some((e) => e.textContent === 'GitHub'), 30000);`);

  await step('a wrong password still fails', `
    document.querySelector('.sidebar-foot .icon-btn').click(); await $t.until(() => document.querySelector('.auth-card'));
    $t.type('Username', '${user}'); await $t.until(() => document.querySelector('.remembered-key'));
    $t.type('Password', 'not-the-password'); $t.click('Unlock');
    await $t.until(() => document.querySelector('.notice-danger'), 30000);`);

  await step('unlock again', `
    $t.type('Password', '${pw}'); $t.click('Unlock');
    await $t.until(() => document.querySelector('.item-row-name'), 30000);`);

  // A second authenticator of the other kind: a YubiKey as a backup to Touch ID. Chrome's virtual
  // authenticators can't model the browser's picker, and a removed virtual platform authenticator
  // keeps receiving create() calls, so this runs from the security-key scenario only.
  let current = first;
  if (transport === 'usb') {
    await page.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: first });
    current = await authenticator('internal');
    await step('add a second passkey in Settings', `
      $t.click('Settings'); await $t.until(() => document.querySelector('.passkey-list'));
      $t.click('Add a passkey or security key'); await $t.sleep(100); $t.click('Add');
      await $t.until(() => {
        const err = document.querySelector('dialog .notice-danger'); if (err) throw new Error(err.textContent);
        return document.querySelectorAll('.passkey-row').length === 2;
      }, 20000);
      const rec = await ${DEVICE};
      return rec.passkeys.map((p) => p.kind).join(' + ');`);
  } else {
    await step('open Settings', `$t.click('Settings'); await $t.until(() => document.querySelector('.passkey-list'));`);
  }

  await step('turn on password-free unlock', `
    document.querySelector('.quick-toggle input').click(); await $t.sleep(100); $t.click('Turn on');
    try { await $t.until(() => document.querySelector('.quick-toggle input')?.checked && !document.querySelector('dialog')); } catch {
      throw new Error('toggle not on: ' + document.querySelector('.toasts')?.textContent + ' | dialogs: ' + document.querySelectorAll('dialog').length + ' | toggles: ' + document.querySelectorAll('.quick-toggle').length);
    }
    const rec = await ${DEVICE};
    if (!rec.quick) throw new Error('quick unlock not stored');
    if (JSON.stringify(rec).includes('${pw}')) throw new Error('password stored');`);

  await step('unlock with a passkey alone', `
    document.querySelector('.sidebar-foot .icon-btn').click(); await $t.until(() => document.querySelector('.auth-card'));
    $t.type('Username', '${user}'); await $t.until(() => document.querySelector('.remembered-key'));
    if ([...document.querySelectorAll('.field-label')].some((l) => l.textContent.startsWith('Password'))) throw new Error('password field still shown');
    $t.click('Unlock with passkey');
    await $t.until(() => [...document.querySelectorAll('.item-row-name')].some((e) => e.textContent === 'GitHub'), 30000);`);

  await page.send('WebAuthn.setUserVerified', { authenticatorId: current, isUserVerified: false });
  await step('a refused passkey shows a clear error', `
    document.querySelector('.sidebar-foot .icon-btn').click(); await $t.until(() => document.querySelector('.auth-card'));
    $t.type('Username', '${user}'); await $t.until(() => document.querySelector('.remembered-key'));
    $t.click('Unlock with passkey');
    await $t.until(() => /passkey request was cancelled/.test(document.querySelector('.notice-danger')?.textContent ?? ''), 30000);`);

  const errors = [...page.errors, ...guest.errors];
  if (errors.length) { failed++; console.log(`  FAIL  ${name} › page errors\n        ${errors.join('\n        ')}`); }
}

try {
  for (const [name, transport] of [['Touch ID', 'internal'], ['security key', 'usb']]) {
    try { await scenario(name, transport); } catch { /* reported in step() */ } finally { await cleanup(); }
  }
} finally {
  browser.close();
  dev.close();
  rmSync(bucketDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall end-to-end checks passed');
process.exit(failed ? 1 : 0);
