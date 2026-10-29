// "Unlocking on this device": passkeys, password-free unlock, and auto-lock.

import { h, signal } from '../ui.js';
import { icon } from '../icons.js';
import { Button, Notice, DialogHeader, Select, Toggle, openDialog, toast, confirmDialog } from '../components.js';
import { session, addPasskey, removePasskey, setQuickUnlock, rememberPlain, forgetDevice } from '../session.js';
import { passkeysAvailable, prfSupported, kindLabel } from '../passkey.js';
import { LOCK_OPTIONS, lockMinutes, lockOnHide, setLockMinutes, setLockOnHide } from '../lock.js';
import * as idb from '../idb.js';

/**
 * Offers to protect the Account Key with a passkey (or to add another one).
 * The button inside the dialog provides the fresh user gesture WebAuthn requires.
 */
export function offerPasskeySetup({ fallbackPlain = false, another = false } = {}) {
  return openDialog((close) => {
    const busy = signal(false);
    const error = signal(null);
    const go = async () => {
      busy.value = true;
      error.value = null;
      try {
        await addPasskey();
        toast(another ? 'Passkey added' : 'Your Account Key is protected on this device');
        close(true);
      } catch (e) { error.value = e.message; } finally { busy.value = false; }
    };
    const skip = async () => {
      if (fallbackPlain) await rememberPlain();
      close(false);
    };
    return [
      DialogHeader({ title: another ? 'Add a passkey or security key' : 'Protect your Account Key', close: () => skip() }),
      h('div', { class: 'dialog-body stack' },
        h('div', { class: 'passkey-hero' }, h('span', { class: 'passkey-icon' }, icon('key', 22)),
          h('p', null, another
            ? 'Register another way to unlock on this device — for example a YubiKey as a backup to Face ID. Any one of them will work.'
            : 'Use Touch ID, Face ID, Windows Hello or a security key like a YubiKey. This device will keep your Account Key encrypted, and only your fingerprint, face or key can release it.')),
        h('p', { class: 'muted small' }, another
          ? 'If you’re asked to choose, pick the authenticator you haven’t added yet.'
          : 'You can add more passkeys later in Settings. Your Emergency Kit keeps working everywhere — this only changes how this device remembers the key.'),
        () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null)),
      h('footer', { class: 'dialog-footer' },
        Button({ label: fallbackPlain ? 'Remember without it' : 'Not now', kind: 'ghost', onClick: skip }),
        Button({ label: another ? 'Add' : 'Set up', icon: 'key', kind: 'primary', onClick: go, busy: () => busy.value })),
    ];
  }, { label: 'Protect your Account Key' });
}

const added = (p) => (p.created ? `Added ${new Date(p.created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : '');

/** Settings section for how this device unlocks and locks. */
export function UnlockSection({ Section, Row }) {
  const s = session.peek();
  const state = signal(null);
  const reload = async () => { state.value = (await idb.get(`device:${s.saltHex}`)) ?? {}; };
  reload();
  const prf = signal(null);
  prfSupported().then((v) => { prf.value = v; });
  const canAdd = () => passkeysAvailable() && prf.value !== false;

  const forget = async () => {
    const ok = await confirmDialog({ title: 'Forget your Account Key on this device?', body: 'Your passkeys will be removed from this device, and you’ll need your Emergency Kit the next time you sign in here.', confirm: 'Forget' });
    if (!ok) return;
    await forgetDevice();
    await reload();
    toast('This device no longer remembers your Account Key');
  };
  const add = async (another) => { await offerPasskeySetup({ another }); await reload(); };
  const remove = async (p, last) => {
    const ok = await confirmDialog({
      title: `Remove this ${p.kind === 'security-key' ? 'security key' : 'passkey'}?`,
      body: last
        ? 'It’s the only one, so this device will also forget your Account Key. You’ll need your Emergency Kit to sign in here again.'
        : 'It will no longer unlock rspm on this device. The others keep working.',
      confirm: 'Remove', danger: last,
    });
    if (!ok) return;
    await removePasskey(p.id);
    await reload();
    toast('Removed');
  };
  const quickBusy = signal(false);
  const toggleQuick = async (on) => {
    if (on) {
      const ok = await confirmDialog({
        title: 'Unlock without your password?',
        body: 'On this device, your passkey alone will open your vault. Anyone who has this device and can pass its Face ID, Touch ID, PIN — or holds your security key — won’t need your password. Your password is still needed everywhere else.',
        confirm: 'Turn on',
      });
      if (!ok) { await reload(); return; }
    }
    quickBusy.value = true;
    try {
      await setQuickUnlock(on);
      toast(on ? 'Password-free unlock is on for this device' : 'Your password is required again');
    } catch (e) { toast(e.message, { tone: 'danger' }); } finally { quickBusy.value = false; await reload(); }
  };

  const keyRows = () => {
    const st = state.value;
    if (!st) return null;
    const passkeys = st.passkeys ?? (st.passkey ? [st.passkey] : []);
    if (passkeys.length) {
      const quick = signal(!!st.quick);
      const toggle = Toggle({
        checked: quick,
        label: 'Unlock without your password',
        hint: 'Like Face ID in other password managers: one touch opens your vault on this device. Off by default.',
      });
      toggle.addEventListener('change', () => toggleQuick(quick.peek()));
      return [
        Row({
          label: 'Account Key',
          value: h('span', { class: 'status-ok' }, icon('shield', 14), passkeys.length === 1 ? 'Protected by a passkey' : `Protected by ${passkeys.length} passkeys`),
          action: Button({ label: 'Forget', size: 'sm', onClick: forget }),
        }),
        h('ul', { class: 'passkey-list' }, passkeys.map((p) => h('li', { class: 'passkey-row' },
          h('span', { class: 'passkey-row-icon' }, icon(p.kind === 'security-key' ? 'key' : 'shield', 16)),
          h('div', { class: 'passkey-row-text' }, h('div', { class: 'passkey-row-name' }, kindLabel(p.kind)), h('div', { class: 'muted small' }, added(p))),
          st.passkeys ? Button({ label: 'Remove', kind: 'ghost', size: 'sm', onClick: () => remove(p, passkeys.length === 1) }) : null))),
        () => (canAdd() && st.passkeys ? h('div', null, Button({ label: 'Add a passkey or security key', icon: 'plus', size: 'sm', onClick: () => add(true) })) : null),
        st.passkeys
          ? h('div', { class: () => ['quick-toggle', quickBusy.value && 'is-busy'] }, toggle)
          : h('p', { class: 'muted small' }, 'Sign out and unlock once with your passkey to manage it here.'),
      ];
    }
    if (st.akey) {
      return Row({
        label: 'Account Key',
        value: 'Stored on this device without extra protection',
        action: h('div', { class: 'button-row' },
          () => (canAdd() ? Button({ label: 'Protect…', icon: 'key', size: 'sm', onClick: () => add(false) }) : null),
          Button({ label: 'Forget', size: 'sm', onClick: forget })),
      });
    }
    return Row({
      label: 'Account Key',
      value: 'You enter it each time you sign in here',
      action: () => (canAdd() ? Button({ label: 'Remember with passkey…', icon: 'key', size: 'sm', onClick: () => add(false) }) : null),
    });
  };

  const lockSel = signal(String(lockMinutes.peek()));
  const select = Select({ value: lockSel, options: LOCK_OPTIONS });
  select.addEventListener('change', () => setLockMinutes(select.value));
  const hide = signal(lockOnHide.peek());
  const hideToggle = Toggle({ checked: hide, label: 'Also lock when rspm goes to the background', hint: 'Switching apps or tabs, or locking your screen, locks the vault.' });
  hideToggle.addEventListener('change', () => setLockOnHide(hide.peek()));

  return Section({
    title: 'Unlocking',
    description: 'How this device remembers your Account Key and when it locks. Your Emergency Kit works everywhere regardless.',
    children: [
      keyRows,
      Row({ label: 'Lock automatically', value: 'When you haven’t used rspm for', action: select }),
      hideToggle,
    ],
  });
}
