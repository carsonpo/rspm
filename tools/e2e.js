// End-to-end test in headless Chrome against a throwaway local server and bucket.
// Covers what unit tests can't reach: the real UI, the browser's WebCrypto and
// WASM, share links, and passkey protection through a virtual WebAuthn
// authenticator with PRF (starting once from a platform authenticator, once from
// a USB key; the security-key run also adds a platform authenticator as a second passkey).
//
// Usage: node tools/e2e.js   (needs Chrome; set CHROME=/path/to/chrome if it isn't found)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, HELPERS } from './browser.js';
import { startDev } from './dev.js';
import { encode, fillVersion, render, placed, migrationUri } from '../test/qr-encode.js';

const bucketDir = mkdtempSync(join(tmpdir(), 'rspm-e2e-'));
const dev = await startDev({ port: Number(process.env.E2E_PORT ?? 4760), bucketDir, powBits: 12, quiet: true });

// What the fake camera shows: a QR code that isn't for two-factor, then a
// GitHub setup code, looping. And a "screenshot" of a Google Authenticator export.
const SCANNED = 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
const camera = join(bucketDir, 'camera.y4m');
{
  const W = 480, H = 360, frames = [];
  for (const [text, deg] of [['https://example.com/not-a-setup-code', 6], [SCANNED, -8]]) {
    const q = encode(text, { level: 'M', mask: 2 });
    const { data } = render(q, { width: W, height: H, corners: placed(q.size, { scale: Math.floor(220 / q.size), W, H, deg }), noise: 12 });
    const frame = Buffer.alloc(W * H * 1.5, 128);
    for (let i = 0; i < W * H; i++) frame[i] = data[i * 4];
    for (let n = 0; n < 20; n++) frames.push(Buffer.from('FRAME\n'), frame); // 2 seconds each at 10 fps
  }
  writeFileSync(camera, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
}
const utf8 = (x) => new TextEncoder().encode(x);
const EXPORT = migrationUri([
  { secret: utf8('12345678901234567890'), name: 'Bank & Co:me@example.com', issuer: 'Bank & Co' },
  { secret: utf8('abcdefghij'), name: 'alice@example.com', issuer: 'Example', algorithm: 2, digits: 2 },
  { secret: utf8('abcdefghij'), name: 'counter', issuer: 'Old', type: 1 },
]);
const screenshot = join(bucketDir, 'screenshot.png');
writeFileSync(screenshot, png(render(encode(EXPORT, { level: 'L', mask: 0 }), { scale: 5 })));

/** RGBA → PNG, with Node's zlib. */
function png({ data, width, height }) {
  const chunk = (type, body) => {
    const t = Buffer.concat([Buffer.from(type), body]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const browser = await launch({
  port: 9340,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`],
});
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
    let rec;
    for (let i = 0; i < 100 && !rec?.quick; i++) { await $t.sleep(50); rec = await ${DEVICE}; }
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

/**
 * Failure handling in the real UI, with the network failing on cue: a share
 * whose vault save fails, a revoke whose deletes fail, and locking with a
 * secret dialog open (security review findings 2, 5 and 6).
 */
async function failures() {
  const name = 'failures';
  const page = await browser.page();
  const step = async (label, body) => {
    try {
      const r = await page.eval(HELPERS + body);
      console.log(`  ok    ${name} › ${label}${r && !String(r).includes('#') ? ` (${r})` : ''}`);
      return r;
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name} › ${label}\n        ${err.message.split('\n')[0]}`);
      throw err;
    }
  };
  // Fail matching requests with a 503 while `failing` is set.
  let failing = null;
  page.listeners.push((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (failing && request.method === failing.method && request.url.includes(failing.path)) {
      page.send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }], body: btoa('unavailable') });
    } else page.send('Fetch.continueRequest', { requestId });
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/v1/*', requestStage: 'Request' }] });
  await page.size(1280, 860);
  await page.goto(`${dev.origin}/`);
  const user = `e2e-failures-${Date.now().toString(36)}`;
  const pw = 'violet-anchor-mosaic-tundra';

  await step('create a vault and a login', `
    $t.click('Create a vault'); await $t.sleep(100);
    document.querySelector('.toggle input').click(); $t.click('Continue'); await $t.sleep(100);
    $t.type('Username', '${user}'); $t.type('Password', '${pw}'); $t.type('Confirm password', '${pw}');
    $t.click('Continue'); await $t.sleep(150);
    const key = document.querySelector('.account-key').textContent;
    $t.click('Copy'); $t.click('I’ve saved it'); await $t.sleep(100);
    $t.type('End of your Account Key', key.split('-').slice(-2).join('-'));
    $t.click('Create vault');
    await $t.until(() => document.querySelector('dialog .passkey-hero'), 30000);
    $t.click('Remember without it'); await $t.until(() => !document.querySelector('dialog'));
    $t.click('New item'); await $t.sleep(100); $t.click('Login'); await $t.sleep(100);
    $t.type('Name', 'GitHub'); $t.type('Password', 'hunter2-but-longer'); $t.click('Add to vault');
    await $t.until(() => document.querySelector('.detail-title')?.textContent === 'GitHub' && !document.querySelector('.editor'), 30000);`);

  failing = { method: 'PUT', path: '/v1/b/' };
  await step('a share whose vault save fails is deleted, not shown', `
    $t.click('Share'); await $t.sleep(200); $t.click('Create share');
    await $t.until(() => /so it was deleted/.test(document.querySelector('.toasts')?.textContent ?? ''), 30000);
    if (document.querySelector('.share-result')) throw new Error('an untracked link was shown');
    [...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Cancel').click();
    await $t.until(() => !document.querySelector('dialog'));`);
  failing = null;

  await step('create a share normally', `
    $t.click('Share'); await $t.sleep(200); $t.click('Create share');
    await $t.until(() => document.querySelector('.share-result'), 30000);
    $t.click('Done'); await $t.until(() => !document.querySelector('dialog'));
    $t.click('Shares'); await $t.until(() => document.querySelectorAll('.share-row').length === 1);`);

  failing = { method: 'DELETE', path: '/v1/e/' };
  await step('a revoke whose deletes fail says so and keeps the share', `
    $t.click('Revoke'); await $t.sleep(100); document.querySelector('dialog .btn-danger').click();
    await $t.until(() => /Couldn’t revoke/.test(document.querySelector('.toasts')?.textContent ?? ''), 30000);
    if (document.querySelectorAll('.share-row').length !== 1) throw new Error('the share was dropped from Active shares');`);
  failing = null;

  await step('retrying the revoke succeeds', `
    $t.click('Revoke'); await $t.sleep(100); document.querySelector('dialog .btn-danger').click();
    await $t.until(() => !document.querySelector('.share-row'), 30000);`);

  await step('locking closes the Account Key dialog', `
    $t.click('Settings'); await $t.until(() => document.querySelector('.settings-section'));
    [...document.querySelectorAll('.toggle')].find((t) => t.textContent.includes('goes to the background')).querySelector('input').click();
    $t.click('Show'); const key = await $t.until(() => /^RSPM1-/.test(document.querySelector('dialog .account-key')?.textContent ?? '') && document.querySelector('dialog .account-key').textContent);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await $t.until(() => document.querySelector('.auth-card'));
    if (document.querySelector('dialog')) throw new Error('a dialog survived the lock');
    if (document.body.innerHTML.includes(key)) throw new Error('the Account Key is still in the page');
    // Preferences are per origin; don't leave lock-on-hide on for the next scenarios.
    await new Promise((res) => { const r = indexedDB.open('rspm'); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(false, 'lock-on-hide'); t.oncomplete = res; }; });`);

  if (page.errors.length) { failed++; console.log(`  FAIL  ${name} › page errors\n        ${page.errors.join('\n        ')}`); }
}

/**
 * Two-factor QR codes: our encoder against Chrome's own reader, the camera
 * (a fake device playing a file) and a screenshot through the file picker,
 * and the camera stopping when the vault locks.
 */
async function scanning() {
  const name = 'scanning';
  const page = await browser.page();
  const step = async (label, body) => {
    try {
      const r = await page.eval(HELPERS + body, { userGesture: true });
      console.log(`  ok    ${name} › ${label}${r ? ` (${r})` : ''}`);
      return r;
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name} › ${label}\n        ${err.message.split('\n')[0]}`);
      err.reported = true;
      throw err;
    }
  };
  await page.send('DOM.enable');
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  page.listeners.push((m) => {
    if (m.method === 'Page.fileChooserOpened') {
      page.send('DOM.setFileInputFiles', { files: [screenshot], backendNodeId: m.params.backendNodeId }).catch((e) => page.errors.push(`file chooser: ${e.message}`));
    }
  });
  await page.size(1280, 860);
  await page.goto(`${dev.origin}/`);

  // An independent check of the tables both our encoder and decoder use.
  const codes = [];
  for (let v = 1; v <= 40; v++) {
    const level = 'LMQH'[v % 4], text = fillVersion(v, level, `${v}-${level} `);
    const q = encode(text, { level, version: v, mask: v % 8 });
    codes.push({ text, size: q.size, bits: Buffer.from(q.modules).toString('base64') });
  }
  await step('Chrome’s BarcodeDetector reads our test encoder’s codes, versions 1–40', `
    if (!('BarcodeDetector' in window)) return 'skipped: no BarcodeDetector here';
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    for (const c of ${JSON.stringify(codes)}) {
      const m = Uint8Array.from(atob(c.bits), (x) => x.charCodeAt(0)), s = 4, q = 4, n = c.size + 2 * q;
      const canvas = new OffscreenCanvas(n * s, n * s), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n * s, n * s); ctx.fillStyle = '#000';
      for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) if (m[y * c.size + x]) ctx.fillRect((x + q) * s, (y + q) * s, s, s);
      const [hit] = await detector.detect(await createImageBitmap(canvas));
      if (hit?.rawValue !== c.text) throw new Error(c.text.slice(0, 16) + ': read ' + JSON.stringify(hit?.rawValue));
    }
    return '40 codes';`);

  const user = `e2e-scan-${Date.now().toString(36)}`;
  const pw = 'violet-anchor-mosaic-tundra';
  await step('create a vault', `
    $t.click('Create a vault'); await $t.sleep(100);
    document.querySelector('.toggle input').click(); $t.click('Continue'); await $t.sleep(100);
    $t.type('Username', '${user}'); $t.type('Password', '${pw}'); $t.type('Confirm password', '${pw}');
    $t.click('Continue'); await $t.sleep(150);
    const key = document.querySelector('.account-key').textContent;
    $t.click('Copy'); $t.click('I’ve saved it'); await $t.sleep(100);
    $t.type('End of your Account Key', key.split('-').slice(-2).join('-'));
    $t.click('Create vault');
    await $t.until(() => document.querySelector('dialog .passkey-hero'), 30000);
    $t.click('Remember without it'); await $t.until(() => !document.querySelector('dialog'));`);

  await step('the camera ignores other QR codes, then reads the setup code', `
    $t.click('New item'); await $t.sleep(100); $t.click('Two-factor code'); await $t.sleep(100);
    $t.click('Scan QR code');
    await $t.until(() => /isn’t a two-factor setup code/.test(document.querySelector('dialog .scan-problem')?.textContent ?? ''), 20000);
    await $t.until(() => !document.querySelector('dialog'), 20000);
    if ($t.field('Setup key').value !== ${JSON.stringify(SCANNED)}) throw new Error('setup key: ' + $t.field('Setup key').value);
    if ($t.field('Name').value !== 'GitHub') throw new Error('name: ' + $t.field('Name').value);
    $t.click('Add to vault');
    await $t.until(() => document.querySelector('.detail-title')?.textContent === 'GitHub' && /^[0-9]{3} ?[0-9]{3}$/.test(document.querySelector('.totp-code')?.textContent.trim() ?? ''), 30000);`);

  await step('a Google Authenticator export screenshot adds every account', `
    $t.click('New item'); await $t.sleep(100); $t.click('Two-factor code'); await $t.sleep(100);
    $t.click('From a screenshot');
    await $t.until(() => /2 accounts in this export/.test(document.querySelector('dialog')?.textContent ?? ''), 20000)
      .catch(() => { throw new Error('no accounts dialog; toasts: ' + [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / ')); });
    if (!/1 counter-based/.test(document.querySelector('dialog').textContent)) throw new Error('the HOTP entry wasn’t reported');
    $t.click('Add all 2');
    await $t.until(() => document.querySelectorAll('.item-row').length === 3, 30000);
    const names = [...document.querySelectorAll('.item-row-name')].map((e) => e.textContent).sort();
    if (names.join() !== 'Bank & Co,Example,GitHub') throw new Error(names.join());
    const subs = [...document.querySelectorAll('.item-row-sub')].map((e) => e.textContent).join();
    if (!subs.includes('Bank & Co · me@example.com')) throw new Error('subtitles: ' + subs);`);

  await step('a code copies straight from the list', `
    const copied = [];
    navigator.clipboard.writeText = async (t) => { copied.push(t); };
    const before = document.querySelector('.detail-title')?.textContent ?? null;
    const li = [...document.querySelectorAll('.item-li')].find((e) => e.querySelector('.item-row-name')?.textContent === 'Example');
    await $t.until(() => /^[0-9]{3,4} [0-9]{3,4}$/.test(li.querySelector('.totp-compact')?.textContent.trim() ?? ''), 10000);
    const shown = li.querySelector('.totp-compact').textContent.trim().replace(' ', '');
    li.querySelector('.totp-compact').click();
    await $t.until(() => copied.length, 5000);
    if (copied[0] !== shown) throw new Error('copied ' + copied[0] + ', showing ' + shown);
    if ((document.querySelector('.detail-title')?.textContent ?? null) !== before) throw new Error('copying opened the item');`);

  await step('locking stops the camera', `
    $t.click('Settings'); await $t.until(() => document.querySelector('.settings-section'));
    [...document.querySelectorAll('.toggle')].find((t) => t.textContent.includes('goes to the background')).querySelector('input').click();
    const streams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); streams.push(s); return s; };
    $t.click('New item'); await $t.sleep(100); $t.click('Two-factor code'); await $t.sleep(100);
    $t.click('Scan QR code');
    // Lock while it's showing the other code, so the dialog is certainly open.
    await $t.until(() => streams.length && /isn’t a two-factor/.test(document.querySelector('dialog .scan-problem')?.textContent ?? ''), 20000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await $t.until(() => document.querySelector('.auth-card'));
    if (document.querySelector('dialog, video')) throw new Error('the scanner survived the lock');
    if (!streams[0].getTracks().every((t) => t.readyState === 'ended')) throw new Error('the camera is still running');
    await new Promise((res) => { const r = indexedDB.open('rspm'); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(false, 'lock-on-hide'); t.oncomplete = res; }; });`);

  if (page.errors.length) { failed++; console.log(`  FAIL  ${name} › page errors\n        ${page.errors.join('\n        ')}`); }
}

try {
  try { await scanning(); } catch (e) { if (!e.reported) { failed++; console.log(`  FAIL  scanning\n        ${e.message}`); } }
  try { await failures(); } catch { /* reported in step() */ }
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
