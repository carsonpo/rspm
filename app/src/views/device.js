// "This device" controls: how the Account Key is remembered here.

import { h, signal } from '../ui.js';
import { icon } from '../icons.js';
import { Button, Notice, DialogHeader, openDialog, toast, confirmDialog } from '../components.js';
import { session, protectWithPasskey, rememberPlain, forgetDevice } from '../session.js';
import { passkeysAvailable, prfSupported, passkeyLabel } from '../passkey.js';
import * as idb from '../idb.js';

/** Signal of this account's device record ({ akey?, passkey?, maxGen }). */
export function deviceState() {
  const s = session.peek();
  const state = signal(null);
  const reload = async () => { state.value = (await idb.get(`device:${s.saltHex}`)) ?? {}; };
  reload();
  return { state, reload };
}

/**
 * Offers to protect the Account Key with a passkey. The button inside the
 * dialog provides the fresh user gesture WebAuthn requires.
 */
export function offerPasskeySetup({ fallbackPlain = false } = {}) {
  return openDialog((close) => {
    const busy = signal(false);
    const error = signal(null);
    const go = async () => {
      busy.value = true;
      error.value = null;
      try {
        await protectWithPasskey();
        toast('Your Account Key is protected on this device');
        close(true);
      } catch (e) { error.value = e.message; } finally { busy.value = false; }
    };
    const skip = async () => {
      if (fallbackPlain) await rememberPlain();
      close(false);
    };
    return [
      DialogHeader({ title: 'Protect your Account Key', close: () => skip() }),
      h('div', { class: 'dialog-body stack' },
        h('div', { class: 'passkey-hero' }, h('span', { class: 'passkey-icon' }, icon('key', 22)),
          h('p', null, 'Use Touch ID, Face ID, Windows Hello or a security key like a YubiKey. This device will keep your Account Key encrypted, and only your fingerprint, face or key can release it.')),
        h('p', { class: 'muted small' }, 'You’ll still need your password. Your Emergency Kit keeps working everywhere — this only changes how this device remembers the key.'),
        () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null)),
      h('footer', { class: 'dialog-footer' },
        Button({ label: fallbackPlain ? 'Remember without it' : 'Not now', kind: 'ghost', onClick: skip }),
        Button({ label: 'Set up', icon: 'key', kind: 'primary', onClick: go, busy: () => busy.value })),
    ];
  }, { label: 'Protect your Account Key' });
}

/** Settings rows for this device. */
export function DeviceRows({ Row }) {
  const { state, reload } = deviceState();
  const canPasskey = passkeysAvailable();
  const prf = signal(null);
  prfSupported().then((v) => { prf.value = v; });

  const forget = async () => {
    const ok = await confirmDialog({ title: 'Forget your Account Key on this device?', body: 'You’ll need your Emergency Kit the next time you sign in here.', confirm: 'Forget' });
    if (!ok) return;
    await forgetDevice();
    await reload();
    toast('This device no longer remembers your Account Key');
  };
  const protect = async () => { await offerPasskeySetup(); await reload(); };

  return () => {
    const st = state.value;
    if (!st) return null;
    if (st.passkey) {
      return Row({
        label: 'Remembered Account Key',
        value: h('span', { class: 'status-ok' }, icon('shield', 14), `Protected by ${passkeyLabel(st.passkey)}`),
        action: Button({ label: 'Forget', size: 'sm', onClick: forget }),
      });
    }
    if (st.akey) {
      return [
        Row({
          label: 'Remembered Account Key',
          value: 'Stored on this device without extra protection',
          action: h('div', { class: 'button-row' },
            canPasskey && prf.value !== false ? Button({ label: 'Protect…', icon: 'key', size: 'sm', onClick: protect }) : null,
            Button({ label: 'Forget', size: 'sm', onClick: forget })),
        }),
      ];
    }
    return Row({
      label: 'Remembered Account Key',
      value: 'You enter your Account Key each time you sign in here',
      action: h('div', { class: 'button-row' },
        canPasskey && prf.value !== false ? Button({ label: 'Remember with passkey…', icon: 'key', size: 'sm', onClick: protect }) : null),
    });
  };
}
