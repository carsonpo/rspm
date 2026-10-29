// Sign in and vault creation.

import { h, signal, effect, when, computed } from '../ui.js';
import { icon } from '../icons.js';
import { Button, Field, Input, PasswordInput, Toggle, Notice, Progress, copy, confirmDialog, id } from '../components.js';
import { signIn, createAccount, deviceRecord, lastUsername, SignInError } from '../session.js';
import { printKit, kitText, download } from '../kit.js';
import { generatePassphrase } from '../generator.js';
import { StrengthMeter, strongEnough } from './strength.js';
import { generateAccountKey, parseAccountKey, AccountKeyError } from '../../../core/kdf.js';
import { RollbackError } from '../../../core/vault.js';
import { passkeysAvailable, prfSupported, passkeyLabel } from '../passkey.js';
import { offerPasskeySetup } from './device.js';

function Brand() {
  return h('div', { class: 'brand' },
    h('span', { class: 'brand-mark' }, icon('lock', 18)),
    h('span', { class: 'brand-name' }, 'rspm'),
    h('span', { class: 'brand-tag' }, 'really simple password manager'));
}

function AuthFooter() {
  return h('p', { class: 'auth-footer' },
    'Everything is encrypted on this device before it leaves. There’s no password reset — not even we can open your vault.');
}

/** Whether to offer passkey protection: WebAuthn available and PRF not known to be missing. */
function canProtect() {
  const ok = signal(passkeysAvailable());
  prfSupported().then((v) => { if (v === false) ok.value = false; });
  return ok;
}

function RememberToggles({ rememberKey, protect, offer }) {
  return h('div', { class: 'stack-sm' },
    Toggle({ checked: rememberKey, label: 'Remember my Account Key on this device', hint: 'Only on devices you trust. You’ll still need your password.' }),
    when(() => rememberKey.value && offer.value, () => h('div', { class: 'toggle-indent' },
      Toggle({ checked: protect, label: 'Protect it with Touch ID, Face ID or a security key', hint: 'Recommended. Works with YubiKeys and other FIDO2 keys.' }))));
}

// ── Sign in ─────────────────────────────────────────────────────────────────

export function SignIn({ onCreate, notice }) {
  const username = signal('');
  const password = signal('');
  const keyText = signal('');
  const rememberKey = signal(true);
  const offer = canProtect();
  const protect = signal(true);
  const device = signal(null);
  const useOtherKey = signal(false);
  const busy = signal(false);
  const step = signal('');
  const error = signal(null);

  lastUsername().then((u) => { if (u && !username.peek()) username.value = u; });

  let seq = 0;
  effect(() => {
    const u = username.value;
    const mine = ++seq;
    deviceRecord(u).then((r) => { if (mine === seq) device.value = r; });
  });
  const hasDeviceKey = () => !!(device.value?.akey || device.value?.passkey) && !useOtherKey.value;

  const submit = async (allowRollback = false) => {
    error.value = null;
    if (!username.peek().trim() || !password.peek()) { error.value = 'Enter your username and password'; return; }
    let key = null;
    if (!hasDeviceKey()) {
      try { key = await parseAccountKey(keyText.peek()); } catch (e) {
        error.value = e instanceof AccountKeyError ? e.message : 'Enter your Account Key';
        return;
      }
    }
    const wantPasskey = !!key && rememberKey.peek() && offer.peek() && protect.peek();
    busy.value = true;
    try {
      await signIn({
        username: username.peek(), password: password.peek(), accountKey: key,
        // With passkey protection the key is stored only after the passkey is set up.
        rememberKey: key ? rememberKey.peek() && !wantPasskey : undefined, allowRollback,
      }, (s) => { step.value = s; });
      if (wantPasskey) offerPasskeySetup({ fallbackPlain: true });
    } catch (e) {
      if (e instanceof RollbackError) {
        busy.value = false;
        const go = await confirmDialog({
          title: 'Your vault looks older than expected',
          body: `This device has seen revision ${e.expected}, but the server returned revision ${e.found}. The server may be malfunctioning — or deliberately hiding recent changes. You can open the older revision read-only, but saving is disabled until the newer one returns.`,
          confirm: 'Open older revision', danger: true,
        });
        if (go) return submit(true);
        return;
      }
      error.value = e instanceof SignInError ? e.message : `Something went wrong: ${e.message}`;
    } finally {
      busy.value = false;
      step.value = '';
    }
  };

  const fid = { u: id('u'), p: id('p'), k: id('k') };
  return h('div', { class: 'auth' },
    h('form', { class: 'auth-card', on: { submit: (e) => { e.preventDefault(); submit(); } } },
      Brand(),
      h('div', null,
        h('h1', { class: 'auth-title' }, 'Unlock your vault'),
        h('p', { class: 'auth-subtitle' }, 'Enter the three things only you know.')),
      notice,
      Field({ label: 'Username', id: fid.u, children: Input({ value: username, id: fid.u, autocomplete: 'username', autofocus: true }) }),
      Field({ label: 'Password', id: fid.p, children: PasswordInput({ value: password, id: fid.p, autocomplete: 'current-password' }) }),
      () => (hasDeviceKey()
        ? h('div', { class: 'remembered-key' },
          icon(device.value.passkey ? 'shield' : 'key', 16),
          h('span', null, device.value.passkey ? `Account Key protected by ${passkeyLabel(device.value.passkey)}` : 'Account Key remembered on this device'),
          h('button', { type: 'button', class: 'link', on: { click: () => { useOtherKey.value = true; } } }, 'Use a different key'))
        : h('div', { class: 'stack-sm' },
          Field({ label: 'Account Key', id: fid.k, hint: 'From your Emergency Kit. Starts with RSPM1-.', children: Input({ value: keyText, id: fid.k, mono: true, placeholder: 'RSPM1-XXXX-XXXX-…' }) }),
          RememberToggles({ rememberKey, protect, offer }))),
      () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null),
      Button({ label: () => (busy.value ? step.value || 'Unlocking…' : 'Unlock'), kind: 'primary', size: 'lg', type: 'submit', busy: () => busy.value }),
      h('div', { class: 'auth-switch' }, 'New to rspm? ', h('button', { type: 'button', class: 'link', on: { click: onCreate } }, 'Create a vault')),
      AuthFooter()));
}

// ── Create ──────────────────────────────────────────────────────────────────

const STEPS = ['Understand', 'Credentials', 'Account Key', 'Confirm'];

export function CreateVault({ onCancel }) {
  const step = signal(0);
  const understood = signal(false);
  const username = signal('');
  const password = signal('');
  const password2 = signal('');
  const key = signal(null); // { bytes, display }
  const savedKit = signal(false);
  const rememberKey = signal(true);
  const offer = canProtect();
  const protect = signal(true);
  const confirmText = signal('');
  const error = signal(null);
  const busy = signal(false);
  const phase = signal('');
  const progress = signal(0);

  generateAccountKey().then((k) => { key.value = k; });

  const next = () => {
    error.value = null;
    if (step.peek() === 1) {
      if (!username.peek().trim()) return void (error.value = 'Choose a username');
      if (!strongEnough(password.peek())) return void (error.value = 'Choose a stronger password — at least 10 characters and rated Fair or better');
      if (password.peek() !== password2.peek()) return void (error.value = 'The passwords don’t match');
    }
    step.value = step.peek() + 1;
  };

  const lastGroup = () => key.value?.display.split('-').slice(-2).join('-') ?? '';

  const create = async () => {
    error.value = null;
    if (confirmText.peek().trim().toUpperCase().replace(/\s/g, '') !== lastGroup()) {
      error.value = 'That doesn’t match the end of your Account Key';
      return;
    }
    busy.value = true;
    try {
      const wantPasskey = rememberKey.peek() && offer.peek() && protect.peek();
      await createAccount({ username: username.peek(), password: password.peek(), accountKey: key.peek().bytes, rememberKey: rememberKey.peek() && !wantPasskey },
        (p) => { phase.value = p; }, (d, t) => { progress.value = d / t; });
      if (wantPasskey) offerPasskeySetup({ fallbackPlain: true });
    } catch (e) {
      error.value = e.message.includes('already exists')
        ? 'A vault already exists for exactly these credentials. Choose a different username.'
        : `Couldn’t create your vault: ${e.message}`;
      busy.value = false;
    }
  };

  const suggest = () => {
    const p = generatePassphrase({ words: 5 });
    password.value = p;
    password2.value = '';
  };

  const fid = { u: id('u'), p: id('p'), p2: id('p'), c: id('c') };
  const views = [
    // 0 — understand
    () => h('div', { class: 'stack' },
      h('div', null, h('h1', { class: 'auth-title' }, 'Create your vault'), h('p', { class: 'auth-subtitle' }, 'Three things to know before you start.')),
      h('ol', { class: 'principles' },
        h('li', null, h('span', { class: 'principle-icon' }, icon('shield', 18)), h('div', null, h('strong', null, 'Your secrets never leave this device unencrypted.'), h('p', null, 'Your username and password are never sent anywhere — they’re used here to derive the keys that lock your vault.'))),
        h('li', null, h('span', { class: 'principle-icon' }, icon('key', 18)), h('div', null, h('strong', null, 'You’ll get an Account Key.'), h('p', null, 'A long random code that works alongside your password. It makes your vault impossible to guess, even with a simple password.'))),
        h('li', null, h('span', { class: 'principle-icon' }, icon('alert', 18)), h('div', null, h('strong', null, 'There is no recovery.'), h('p', null, 'If you lose your username, password, or Account Key, your data is gone for good. Nobody can reset it — that’s what keeps it safe.')))),
      Toggle({ checked: understood, label: 'I understand nobody can recover my vault' }),
      h('div', { class: 'auth-actions' }, Button({ label: 'Cancel', kind: 'ghost', onClick: onCancel }), Button({ label: 'Continue', kind: 'primary', onClick: next, disabled: () => !understood.value }))),
    // 1 — credentials
    () => h('form', { class: 'stack', on: { submit: (e) => { e.preventDefault(); next(); } } },
      h('div', null, h('h1', { class: 'auth-title' }, 'Choose your credentials'), h('p', { class: 'auth-subtitle' }, 'Pick something you’ll remember. You’ll need both every time you sign in.')),
      Field({ label: 'Username', id: fid.u, hint: 'Private, and not tied to an email address. Anything unique to you works.', children: Input({ value: username, id: fid.u, autocomplete: 'username', autofocus: true }) }),
      Field({
        label: 'Password', id: fid.p, hint: () => StrengthMeter({ value: () => password.value }),
        children: PasswordInput({ value: password, id: fid.p, autocomplete: 'new-password', extra: h('button', { type: 'button', class: 'input-suffix-btn', on: { click: suggest } }, icon('dice', 16), 'Suggest') }),
      }),
      Field({ label: 'Confirm password', id: fid.p2, children: PasswordInput({ value: password2, id: fid.p2, autocomplete: 'new-password' }) }),
      () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null),
      h('div', { class: 'auth-actions' }, Button({ label: 'Back', kind: 'ghost', onClick: () => { step.value = 0; } }), Button({ label: 'Continue', kind: 'primary', type: 'submit' }))),
    // 2 — account key
    () => h('div', { class: 'stack' },
      h('div', null, h('h1', { class: 'auth-title' }, 'Save your Account Key'), h('p', { class: 'auth-subtitle' }, 'You’ll need it to sign in on any new device. Keep it somewhere separate from your password.')),
      h('div', { class: 'account-key mono', 'aria-label': 'Account Key' }, () => key.value?.display ?? ''),
      h('div', { class: 'button-row' },
        Button({ label: 'Print Emergency Kit', icon: 'printer', onClick: () => { printKit({ username: username.peek(), accountKey: key.peek().display }); savedKit.value = true; } }),
        Button({ label: 'Download', icon: 'download', onClick: () => { download('rspm-emergency-kit.txt', kitText({ username: username.peek(), accountKey: key.peek().display })); savedKit.value = true; } }),
        Button({ label: 'Copy', icon: 'copy', onClick: () => { copy(key.peek().display, 'Account Key copied'); savedKit.value = true; } })),
      RememberToggles({ rememberKey, protect, offer }),
      h('div', { class: 'auth-actions' }, Button({ label: 'Back', kind: 'ghost', onClick: () => { step.value = 1; } }), Button({ label: 'I’ve saved it', kind: 'primary', onClick: next, disabled: () => !savedKit.value }))),
    // 3 — confirm
    () => h('form', { class: 'stack', on: { submit: (e) => { e.preventDefault(); create(); } } },
      h('div', null, h('h1', { class: 'auth-title' }, 'One last check'), h('p', { class: 'auth-subtitle' }, 'Type the last two groups of your Account Key to confirm you’ve saved it.')),
      Field({ label: 'End of your Account Key', id: fid.c, hint: 'e.g. ABCD-EF', children: Input({ value: confirmText, id: fid.c, mono: true, autofocus: true, placeholder: 'XXXX-XX' }) }),
      () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null),
      () => (busy.value ? h('div', { class: 'stack-sm' }, h('p', { class: 'muted small' }, () => phase.value), Progress({ value: () => progress.value })) : null),
      h('div', { class: 'auth-actions' },
        Button({ label: 'Back', kind: 'ghost', onClick: () => { step.value = 2; }, disabled: () => busy.value }),
        Button({ label: 'Create vault', kind: 'primary', type: 'submit', busy: () => busy.value }))),
  ];

  return h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      Brand(),
      h('ol', { class: 'steps', 'aria-label': 'Progress' }, STEPS.map((label, i) => h('li', {
        class: () => ['step', step.value === i && 'is-current', step.value > i && 'is-done'],
        'aria-current': () => (step.value === i ? 'step' : null),
      }, h('span', { class: 'step-dot' }, () => (step.value > i ? icon('check', 12) : String(i + 1))), h('span', { class: 'step-label' }, label)))),
      () => views[step.value](),
      AuthFooter()));
}
