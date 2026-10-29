// Entry point.

import { h, signal, mount, untrack, effect } from './ui.js';
import { icon } from './icons.js';
import { ToastHost, Button, Notice } from './components.js';
import { session } from './session.js';
import { buildHash, pendingUpdate } from './build-info.js';
import { SignIn, CreateVault } from './views/auth.js';
import { VaultView } from './views/vault.js';
import { ReceivedShare } from './views/share.js';
import { startAutoLock } from './lock.js';
import { parseShareFragment } from '../../core/share.js';

const screen = signal('signin');
// Once signed in, the next locked screen is always sign-in — never back to vault creation.
effect(() => { if (session.value) screen.value = 'signin'; });
const share = signal(null); // { fragment, waiting }

function takeShareFragment() {
  if (!parseShareFragment(location.hash)) return;
  share.value = { fragment: location.hash, waiting: false };
  // Keep the share secret out of the address bar and this history entry.
  history.replaceState(null, '', location.pathname + location.search);
}
takeShareFragment();
window.addEventListener('hashchange', takeShareFragment);

function App() {
  return [
    () => {
      const sh = share.value;
      const signedIn = !!session.value;
      const scr = screen.value;
      return untrack(() => {
        if (sh && (!sh.waiting || signedIn)) {
          return ReceivedShare({
            fragment: sh.fragment,
            onDone: (opts = {}) => { share.value = opts.signIn ? { ...sh, waiting: true } : null; },
          });
        }
        if (signedIn) return VaultView();
        if (scr === 'create') return CreateVault({ onCancel: () => { screen.value = 'signin'; } });
        return SignIn({
          onCreate: () => { screen.value = 'create'; },
          notice: sh?.waiting ? Notice({ tone: 'info', title: 'Sign in to open the item shared with you' }) : null,
        });
      });
    },
    UpdateBanner(),
    ToastHost(),
  ];
}

function UpdateBanner() {
  return () => {
    const u = pendingUpdate.value;
    if (!u) return null;
    return h('aside', { class: 'update-banner', role: 'status' },
      icon('download', 18),
      h('div', { class: 'update-text' },
        h('strong', null, 'A new version of rspm is available'),
        h('span', { class: 'muted small' }, 'Fingerprint ', h('code', null, u.hash.slice(0, 16)), ' — compare it with the release on GitHub before updating.')),
      Button({ label: 'Later', kind: 'ghost', size: 'sm', onClick: () => { pendingUpdate.value = null; } }),
      Button({ label: 'Update', kind: 'primary', size: 'sm', onClick: () => navigator.serviceWorker.controller?.postMessage({ type: 'apply-update' }) }));
  };
}

startAutoLock();

// ── Service worker (installed PWA) ──────────────────────────────────────────

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const policy = window.trustedTypes?.createPolicy('rspm-sw', {
    createScriptURL: (u) => { if (u !== '/sw.js') throw new Error('blocked script URL'); return u; },
  });
  navigator.serviceWorker.register(policy ? policy.createScriptURL('/sw.js') : '/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'update-available') pendingUpdate.value = { hash: e.data.hash };
    if (e.data?.type === 'build-hash') buildHash.value = e.data.hash;
    if (e.data?.type === 'updated') location.reload();
  });
  navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'get-hash' }));
}

mount(document.getElementById('app'), App);
