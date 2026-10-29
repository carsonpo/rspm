// Auto-lock: after a period of inactivity, and optionally whenever the app is
// hidden. Both are per-device preferences.

import { signal } from './ui.js';
import * as idb from './idb.js';
import { session, lock } from './session.js';

export const LOCK_OPTIONS = [
  ['1', '1 minute'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'],
  ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['480', '8 hours'],
];

export const lockMinutes = signal(10);
export const lockOnHide = signal(false);
idb.get('lock-minutes').then((m) => { if (LOCK_OPTIONS.some(([v]) => Number(v) === m)) lockMinutes.value = m; });
idb.get('lock-on-hide').then((v) => { lockOnHide.value = v === true; });

export function setLockMinutes(m) { lockMinutes.value = Number(m); idb.set('lock-minutes', Number(m)); }
export function setLockOnHide(on) { lockOnHide.value = on; idb.set('lock-on-hide', on); }

/** Starts watching for inactivity. Called once at startup. */
export function startAutoLock() {
  let lastActive = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true });
  }
  // Checked on an interval and on return, since timers pause while a device sleeps.
  const check = () => { if (session.peek() && Date.now() - lastActive > lockMinutes.peek() * 60000) lock(); };
  setInterval(check, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && lockOnHide.peek()) lock();
    else check();
  });
}
