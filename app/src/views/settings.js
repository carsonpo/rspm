// Settings: account, device, handle, backup, credentials, about.

import { h, signal, when } from '../ui.js';
import { icon } from '../icons.js';
import { Button, Field, Input, PasswordInput, Select, Toggle, Notice, DialogHeader, openDialog, copy, toast, confirmDialog, Progress } from '../components.js';
import { session, store, save, config, replaceVault, lock } from '../session.js';
import { DeviceRows } from './device.js';
import { printKit, download } from '../kit.js';
import * as idb from '../idb.js';
import { formatAccountKey, deriveKeys, generateAccountKey, salt } from '../../../core/kdf.js';
import { createIdentity, publishHandle, unpublishHandle, lookupHandle, fingerprint, normalizeHandle } from '../../../core/share.js';
import { b64, b64decode, equal, utf8, fromUtf8, hex } from '../../../core/encoding.js';
import { aesKey, hkdf, seal, open, random } from '../../../core/crypto.js';
import { merge } from '../../../core/vault.js';
import * as mlkem from '../../../core/mlkem.js';
import { StrengthMeter, strongEnough } from './strength.js';

export const lockMinutes = signal(10);
idb.get('lock-minutes').then((m) => { if (m) lockMinutes.value = m; });

function Section({ title, description, children }) {
  return h('section', { class: 'settings-section' },
    h('div', { class: 'settings-section-head' }, h('h2', null, title), description && h('p', { class: 'muted small' }, description)),
    h('div', { class: 'settings-section-body' }, children));
}

function Row({ label, value, action }) {
  return h('div', { class: 'settings-row' },
    h('div', null, h('div', { class: 'settings-row-label' }, label), value && h('div', { class: 'settings-row-value' }, value)),
    action);
}

// ── Backup (PROTOCOL §10.1) ─────────────────────────────────────────────────

async function backupKey() {
  return aesKey(await hkdf(session.peek().vault.keys.encRaw, 'rspm/v1', 'backup'));
}

async function exportBackup() {
  const s = session.peek();
  const nonce = random(12);
  const ct = await seal(await backupKey(), nonce, utf8(JSON.stringify(s.vault.doc)), utf8('rspm/v1/backup'));
  const file = JSON.stringify({ rspm_backup: 1, nonce: b64(nonce), ct: b64(ct) });
  download(`rspm-backup-${new Date().toISOString().slice(0, 10)}.json`, file, 'application/json');
  toast('Encrypted backup downloaded');
}

async function importBackup() {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const b = JSON.parse(await file.text());
      if (b.rspm_backup !== 1) throw new Error('not an rspm backup');
      const pt = await open(await backupKey(), b64decode(b.nonce), b64decode(b.ct), utf8('rspm/v1/backup'));
      if (!pt) throw new Error('this backup was made with different credentials');
      const restored = JSON.parse(fromUtf8(pt));
      await save((d) => Object.assign(d, merge(d, { ...restored, identity: d.identity ?? restored.identity })), `Restored ${restored.items.length} items`);
    } catch (e) {
      toast(`Couldn’t import: ${e.message}`, { tone: 'danger' });
    }
  });
  input.click();
}

// ── Credentials ─────────────────────────────────────────────────────────────

function changeCredentials() {
  return openDialog((close) => {
    const s = session.peek();
    const current = signal('');
    const username = signal(s.username);
    const pw = signal('');
    const pw2 = signal('');
    const rotate = signal(false);
    const error = signal(null);
    const busy = signal(false);
    const progress = signal(0);
    const newKey = signal(null);

    const submit = async () => {
      error.value = null;
      if (!username.peek().trim()) return void (error.value = 'Choose a username');
      if (!strongEnough(pw.peek())) return void (error.value = 'Choose a stronger password — at least 10 characters and rated Fair or better');
      if (pw.peek() !== pw2.peek()) return void (error.value = 'The new passwords don’t match');
      busy.value = true;
      try {
        const check = await deriveKeys(s.username, current.peek(), s.accountKey);
        if (!equal(check.loc, s.vault.keys.loc)) throw new Error('Your current password is incorrect');
        const key = rotate.peek() ? (await generateAccountKey()).bytes : s.accountKey;
        const keys = await deriveKeys(username.peek(), pw.peek(), key);
        const fresh = await s.vault.rekey(keys, (d, t) => { progress.value = d / t; });
        const rec = await idb.get(`device:${s.saltHex}`);
        const sameAccount = hex(await salt(username.peek())) === s.saltHex && key === s.accountKey;
        // A passkey wraps this exact key under this exact username. If either changed, never fall
        // back to storing the new key unprotected — forget it and ask for a fresh passkey instead.
        const rememberKey = sameAccount ? undefined : rec?.passkey ? false : rec?.akey ? true : undefined;
        await replaceVault(username.peek(), fresh, key, rememberKey);
        if (rec?.passkey && !sameAccount) toast('Set up your passkey again in Settings → This device', { ms: 6000 });
        if (rotate.peek()) newKey.value = await formatAccountKey(key);
        else { toast('Credentials changed'); close(); }
      } catch (e) {
        error.value = e.message;
      } finally { busy.value = false; }
    };

    return [
      DialogHeader({ title: 'Change username or password', close }),
      () => (newKey.value
        ? h('div', { class: 'dialog-body stack' },
          Notice({ tone: 'warn', title: 'Save your new Account Key now', children: 'Your old Account Key no longer works. Print or copy the new one before closing this window.' }),
          h('div', { class: 'account-key mono' }, newKey.value),
          h('div', { class: 'button-row' },
            Button({ label: 'Copy', icon: 'copy', onClick: () => copy(newKey.peek(), 'Account Key copied') }),
            Button({ label: 'Print Emergency Kit', icon: 'printer', onClick: () => printKit({ username: username.peek(), accountKey: newKey.peek() }) })),
          h('footer', { class: 'dialog-footer' }, Button({ label: 'I’ve saved it', kind: 'primary', onClick: () => close() })))
        : h('form', { class: 'dialog-body stack', on: { submit: (e) => { e.preventDefault(); submit(); } } },
          h('p', { class: 'muted small' }, 'This moves your vault to new credentials and deletes the old copy. Anyone who saved a copy of the old encrypted blocks could still open it with the old credentials.'),
          Field({ label: 'Current password', children: PasswordInput({ value: current, autocomplete: 'current-password', autofocus: true }) }),
          Field({ label: 'Username', children: Input({ value: username, autocomplete: 'username' }) }),
          Field({ label: 'New password', hint: () => StrengthMeter({ value: () => pw.value }), children: PasswordInput({ value: pw, autocomplete: 'new-password' }) }),
          Field({ label: 'Confirm new password', children: PasswordInput({ value: pw2, autocomplete: 'new-password' }) }),
          Toggle({ checked: rotate, label: 'Also generate a new Account Key', hint: 'Do this if your Emergency Kit may have been seen by someone else.' }),
          () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null),
          () => (busy.value ? Progress({ value: () => progress.value }) : null),
          h('footer', { class: 'dialog-footer' },
            Button({ label: 'Cancel', onClick: () => close() }),
            Button({ label: 'Change credentials', kind: 'primary', type: 'submit', busy: () => busy.value })))),
    ];
  }, { label: 'Change credentials' });
}

function showAccountKey() {
  const s = session.peek();
  return openDialog((close) => {
    const display = signal('');
    formatAccountKey(s.accountKey).then((v) => { display.value = v; });
    return [
      DialogHeader({ title: 'Your Account Key', close }),
      h('div', { class: 'dialog-body stack' },
        h('p', { class: 'muted small' }, 'You’ll need this, together with your username and password, to sign in on a new device.'),
        h('div', { class: 'account-key mono' }, () => display.value),
        h('div', { class: 'button-row' },
          Button({ label: 'Copy', icon: 'copy', onClick: () => copy(display.peek(), 'Account Key copied') }),
          Button({ label: 'Print Emergency Kit', icon: 'printer', onClick: () => printKit({ username: s.username, accountKey: display.peek() }) }))),
    ];
  }, { label: 'Account Key' });
}

// ── Handle ──────────────────────────────────────────────────────────────────

function HandleSection() {
  const s = session.peek();
  const identity = signal(s.vault.doc.identity);
  const fp = signal('');
  const handle = signal('');
  const error = signal(null);
  const busy = signal(false);
  const refreshFp = async () => {
    const id = identity.peek();
    if (!id) return;
    const { ek } = mlkem.keygen(b64decode(id.mlkem_seed));
    fp.value = await fingerprint(b64decode(id.x25519_pk), ek);
  };
  refreshFp();

  const publish = async () => {
    error.value = null;
    let name;
    try { name = normalizeHandle(handle.peek()); } catch (e) { error.value = e.message; return; }
    busy.value = true;
    try {
      if (await lookupHandle(store, name)) throw new Error(`@${name} is already taken`);
      const id = await createIdentity(name);
      if (!(await publishHandle(store, id, s.vault.keys.loc))) throw new Error(`@${name} is already taken`);
      if (!(await save((d) => { d.identity = id; }, `You’re now @${name}`))) {
        await unpublishHandle(store, id, s.vault.keys.loc).catch(() => {});
        return;
      }
      identity.value = id;
      refreshFp();
    } catch (e) { error.value = e.message; } finally { busy.value = false; }
  };

  const unpublish = async () => {
    const id = identity.peek();
    const ok = await confirmDialog({ title: `Remove @${id.handle}?`, body: 'People will no longer be able to share items with this handle. Links already sent to you will stop opening. Someone else could claim the handle afterwards.', confirm: 'Remove handle', danger: true });
    if (!ok) return;
    try {
      await unpublishHandle(store, id, s.vault.keys.loc);
      if (await save((d) => { d.identity = null; }, 'Handle removed')) identity.value = null;
    } catch (e) { toast(`Couldn’t remove: ${e.message}`, { tone: 'danger' }); }
  };

  return Section({
    title: 'Your handle',
    description: 'A public name others can use to send you items securely. It’s not your username, and it can’t be used to sign in.',
    children: () => (identity.value
      ? [
        Row({ label: `@${identity.value.handle}`, value: 'Published', action: Button({ label: 'Remove', kind: 'ghost', size: 'sm', onClick: unpublish }) }),
        h('div', { class: 'fingerprint-box' },
          h('div', { class: 'fingerprint-label' }, 'Your fingerprint'),
          h('div', { class: 'fingerprint mono' }, () => fp.value),
          h('p', { class: 'muted small' }, 'When someone shares with you for the first time, they’ll ask you to read this out. It proves the handle really belongs to you.')),
      ]
      : h('div', { class: 'stack' },
        Field({
          label: 'Choose a handle', error: () => error.value, hint: '3–32 characters: letters, numbers, _ and -. Handles are public.',
          children: h('div', { class: 'input-row' }, h('span', { class: 'input-prefix' }, '@'), Input({ value: handle, placeholder: 'yourname', onEnter: publish }),
            Button({ label: 'Publish', kind: 'primary', onClick: publish, busy: () => busy.value })),
        }))),
  });
}

// ── Page ────────────────────────────────────────────────────────────────────

export function SettingsPage({ back }) {
  const s = session.peek();
  const lockSel = signal(String(lockMinutes.peek()));
  const setLock = (v) => { lockMinutes.value = Number(v); idb.set('lock-minutes', Number(v)); };

  return h('div', { class: 'page' },
    h('header', { class: 'page-header' }, back, h('div', null, h('h1', { class: 'page-title' }, 'Settings'))),

    Section({
      title: 'Account',
      children: [
        Row({ label: 'Username', value: s.username }),
        Row({ label: 'Account Key', value: 'Needed to sign in on a new device', action: Button({ label: 'Show', size: 'sm', onClick: showAccountKey }) }),
        Row({ label: 'Username & password', value: 'Move your vault to new credentials', action: Button({ label: 'Change…', size: 'sm', onClick: changeCredentials }) }),
      ],
    }),

    Section({
      title: 'This device',
      children: [
        DeviceRows({ Row }),
        Row({
          label: 'Lock automatically',
          action: (() => { const el = Select({ value: lockSel, options: [['1', 'After 1 minute'], ['5', 'After 5 minutes'], ['10', 'After 10 minutes'], ['30', 'After 30 minutes'], ['60', 'After 1 hour']] }); el.addEventListener('change', () => setLock(el.value)); return el; })(),
        }),
      ],
    }),

    HandleSection(),

    Section({
      title: 'Backup',
      description: 'Backups are encrypted with your current credentials, so only you can restore them.',
      children: [
        Row({ label: 'Export', value: 'Download an encrypted copy of your vault', action: Button({ label: 'Export', icon: 'download', size: 'sm', onClick: exportBackup }) }),
        Row({ label: 'Import', value: 'Merge items from a backup into this vault', action: Button({ label: 'Import', icon: 'upload', size: 'sm', onClick: importBackup }) }),
      ],
    }),

    Section({
      title: 'About',
      children: [
        Row({ label: 'Version', value: config.version }),
        Row({ label: 'Vault revision', value: () => String(s.vault.gen) }),
        Row({ label: 'Server', value: new URL(config.api).host }),
        h('p', { class: 'muted small' }, 'Check that this app is the published build: save the page and compare ',
          h('code', null, 'shasum -a 256 index.html'), ' with the release hash on GitHub. The protocol and threat model are in the repository’s docs folder.'),
      ],
    }),

    h('div', { class: 'settings-footer' }, Button({ label: 'Lock now', icon: 'lock', onClick: lock })));
}
