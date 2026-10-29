// End-to-end test in headless Chrome against a throwaway local server and bucket.
// Covers what unit tests can't reach: the real UI, the browser's WebCrypto and
// WASM, share links, and passkey protection through a virtual WebAuthn
// authenticator with PRF (once as a platform authenticator, once as a USB key).
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
let failed = 0;

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
  const { authenticatorId } = await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.size(1280, 860);
  await page.goto(`${dev.origin}/`);
  const user = `e2e-${transport}-${Date.now().toString(36)}`;
  const pw = 'violet-anchor-mosaic-tundra';

  await step('create a vault', `
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
    const rec = await new Promise((res) => { const r = indexedDB.open('rspm'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => res(q.result.find((x) => x?.maxGen !== undefined)); }; });
    if (!rec?.passkey) throw new Error('no passkey record stored');
    if ('akey' in rec) throw new Error('plaintext Account Key was stored alongside the passkey');
    return rec.passkey.kind;`);

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

  await page.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await step('a refused passkey shows a clear error', `
    $t.type('Password', '${pw}'); $t.click('Unlock');
    await $t.until(() => /passkey request was cancelled/.test(document.querySelector('.notice-danger')?.textContent ?? ''), 30000);`);

  const errors = [...page.errors, ...guest.errors];
  if (errors.length) { failed++; console.log(`  FAIL  ${name} › page errors\n        ${errors.join('\n        ')}`); }
}

try {
  for (const [name, transport] of [['Touch ID', 'internal'], ['security key', 'usb']]) {
    try { await scenario(name, transport); } catch { /* reported in step() */ }
  }
} finally {
  browser.close();
  dev.close();
  rmSync(bucketDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall end-to-end checks passed');
process.exit(failed ? 1 : 0);
