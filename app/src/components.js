// Shared UI components.

import { h, signal, effect, onCleanup, list, root, append } from './ui.js';
import { icon } from './icons.js';

let uid = 0;
export const id = (p = 'f') => `${p}${++uid}`;

// ── Toasts ──────────────────────────────────────────────────────────────────

export const toasts = signal([]);

export function toast(message, { tone = 'neutral', ms = 3200 } = {}) {
  const t = { id: ++uid, message, tone };
  toasts.value = [...toasts.peek(), t];
  setTimeout(() => { toasts.value = toasts.peek().filter((x) => x !== t); }, ms);
}

export function ToastHost() {
  return h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' },
    list(() => toasts.value, (t) => t.id, (t) => h('div', { class: () => `toast toast-${t().tone}` },
      t().tone === 'danger' ? icon('alert', 16) : icon('check', 16), h('span', null, () => t().message))));
}

// ── Clipboard ───────────────────────────────────────────────────────────────

let clearTimer;
export async function copy(text, what = 'Copied', { sensitive = true } = {}) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Copy failed — your browser blocked clipboard access', { tone: 'danger' });
    return;
  }
  clearTimeout(clearTimer);
  if (sensitive) {
    toast(`${what} · clears in 30 s`);
    clearTimer = setTimeout(() => { if (document.hasFocus()) navigator.clipboard.writeText('').catch(() => {}); }, 30000);
  } else toast(what);
}

// ── Buttons ─────────────────────────────────────────────────────────────────

export function Button({ label, icon: ic, kind = 'secondary', onClick, type = 'button', disabled, busy, size, title }) {
  return h('button', {
    type, title,
    class: () => ['btn', `btn-${kind}`, size && `btn-${size}`, busy?.() && 'is-busy'],
    disabled: () => (typeof disabled === 'function' ? disabled() : !!disabled) || !!busy?.(),
    on: onClick ? { click: onClick } : {},
  }, busy ? () => (busy() ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : ic ? icon(ic, 16) : null) : ic && icon(ic, 16),
  label && h('span', null, label));
}

export function IconButton({ icon: ic, label, onClick, kind = 'ghost', pressed }) {
  return h('button', {
    type: 'button', class: `icon-btn icon-btn-${kind}`, title: label, 'aria-label': label,
    'aria-pressed': pressed ? () => String(!!pressed()) : null,
    on: { click: onClick },
  }, typeof ic === 'function' ? () => icon(ic(), 18) : icon(ic, 18));
}

// ── Form fields ─────────────────────────────────────────────────────────────

export function Field({ label, hint, error, children, id: fid, optional }) {
  return h('div', { class: () => ['field', error?.() && 'has-error'] },
    label && h('label', { class: 'field-label', for: fid }, label, optional && h('span', { class: 'field-optional' }, 'optional')),
    children,
    () => (error?.() ? h('p', { class: 'field-error', role: 'alert' }, error()) : hint ? h('p', { class: 'field-hint' }, typeof hint === 'function' ? hint() : hint) : null));
}

export function Input({ value, placeholder, type = 'text', id: fid, autocomplete = 'off', mono, onEnter, autofocus, spellcheck = false, inputmode, readonly }) {
  const el = h('input', {
    id: fid, type, placeholder, autocomplete, spellcheck: String(spellcheck), inputmode,
    class: ['input', mono && 'mono'], readonly: readonly || null,
    value: () => value.value ?? '',
    on: {
      input: (e) => { value.value = e.target.value; },
      keydown: (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } },
    },
  });
  if (autofocus) queueMicrotask(() => el.focus());
  return el;
}

export function Textarea({ value, placeholder, id: fid, rows = 4, mono }) {
  return h('textarea', {
    id: fid, placeholder, rows, spellcheck: 'false', class: ['input', 'textarea', mono && 'mono'],
    value: () => value.value ?? '',
    on: { input: (e) => { value.value = e.target.value; } },
  });
}

export function PasswordInput({ value, id: fid, placeholder, autocomplete = 'off', onEnter, autofocus, extra }) {
  const shown = signal(false);
  const input = h('input', {
    id: fid, placeholder, autocomplete, spellcheck: 'false', class: 'input mono',
    type: () => (shown.value ? 'text' : 'password'),
    value: () => value.value ?? '',
    on: {
      input: (e) => { value.value = e.target.value; },
      keydown: (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } },
    },
  });
  if (autofocus) queueMicrotask(() => input.focus());
  return h('div', { class: 'input-group' }, input,
    extra,
    IconButton({ icon: () => (shown.value ? 'eyeOff' : 'eye'), label: 'Show or hide', pressed: () => shown.value, onClick: () => { shown.value = !shown.peek(); } }));
}

export function Toggle({ checked, label, hint }) {
  const fid = id('t');
  return h('label', { class: 'toggle', for: fid },
    h('input', { id: fid, type: 'checkbox', role: 'switch', checked: () => checked.value, on: { change: (e) => { checked.value = e.target.checked; } } }),
    h('span', { class: 'toggle-track', 'aria-hidden': 'true' }, h('span', { class: 'toggle-thumb' })),
    h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint && h('span', { class: 'toggle-hint' }, hint)));
}

export function Segmented({ value, options, label }) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) => h('button', {
      type: 'button', role: 'radio', class: 'segmented-option',
      'aria-checked': () => String(value.value === v),
      on: { click: () => { value.value = v; } },
    }, text)));
}

export function Select({ value, options, id: fid }) {
  return h('select', { id: fid, class: 'input select', on: { change: (e) => { value.value = e.target.value; } } },
    options.map(([v, text]) => h('option', { value: v, selected: () => (String(value.value) === String(v) ? true : null) }, text)));
}

// ── Display ─────────────────────────────────────────────────────────────────

/** A read-only field row: label, value (optionally masked), and copy. */
export function ValueRow({ label, value, secret = false, mono = false, copyLabel, href, multiline }) {
  const shown = signal(!secret);
  const v = typeof value === 'function' ? value : () => value;
  return h('div', { class: 'value-row' },
    h('div', { class: 'value-row-main' },
      h('div', { class: 'value-row-label' }, label),
      h('div', { class: ['value-row-value', (mono || secret) && 'mono', multiline && 'multiline'] },
        () => (shown.value ? (href ? h('a', { href: href(), target: '_blank', rel: 'noopener noreferrer' }, v()) : v()) : '•'.repeat(Math.min(16, Math.max(8, v().length)))))),
    h('div', { class: 'value-row-actions' },
      secret && IconButton({ icon: () => (shown.value ? 'eyeOff' : 'eye'), label: () => (shown.value ? 'Hide' : 'Reveal'), pressed: () => shown.value, onClick: () => { shown.value = !shown.peek(); } }),
      IconButton({ icon: 'copy', label: `Copy ${label.toLowerCase()}`, onClick: () => copy(v(), copyLabel ?? `${label} copied`, { sensitive: secret }) })));
}

export function Monogram({ name, type }) {
  const letter = (name?.trim()?.[0] ?? '?').toUpperCase();
  return h('span', { class: `monogram monogram-${type}`, 'aria-hidden': 'true' }, letter);
}

export function Empty({ icon: ic, title, body, action }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(ic, 22)),
    h('h3', { class: 'empty-title' }, title),
    body && h('p', { class: 'empty-body' }, body),
    action);
}

export function Notice({ tone = 'info', title, children, icon: ic }) {
  return h('div', { class: `notice notice-${tone}`, role: tone === 'danger' ? 'alert' : null },
    icon(ic ?? (tone === 'info' ? 'shield' : 'alert'), 18),
    h('div', { class: 'notice-body' }, title && h('strong', null, title), children && h('div', null, children)));
}

export function Progress({ value }) {
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': () => Math.round(value() * 100) },
    h('div', { class: 'progress-bar', style: () => ({ width: `${Math.round(value() * 100)}%` }) }));
}

// ── Dialog ──────────────────────────────────────────────────────────────────

const openDialogs = new Set();

/** Opens a modal <dialog>. `content(close)` renders the body. Returns a promise resolved on close. */
export function openDialog(content, { label, wide } = {}) {
  return new Promise((resolve) => {
    let result, done = false;
    // Tear down synchronously rather than waiting for the close event, which
    // browsers may defer while the page is hidden.
    const finish = () => {
      if (done) return;
      done = true;
      openDialogs.delete(finish);
      if (dlg.open) dlg.close();
      dispose();
      dlg.remove();
      resolve(result);
    };
    const close = (r) => { result = r; finish(); };
    const dlg = h('dialog', { class: ['dialog', wide && 'dialog-wide'], 'aria-label': label });
    document.body.appendChild(dlg);
    const dispose = root((d) => { append(dlg, content(close)); return d; });
    dlg.addEventListener('close', finish);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    openDialogs.add(finish);
    dlg.showModal();
  });
}

/** Closes and removes every open dialog (on lock, so nothing secret stays on screen). */
export function closeAllDialogs() {
  for (const finish of [...openDialogs]) finish();
}

export function DialogHeader({ title, close, subtitle }) {
  return h('header', { class: 'dialog-header' },
    h('div', null, h('h2', { class: 'dialog-title' }, title), subtitle && h('p', { class: 'dialog-subtitle' }, subtitle)),
    IconButton({ icon: 'x', label: 'Close', onClick: () => close() }));
}

export async function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return openDialog((close) => [
    DialogHeader({ title, close: () => close(false) }),
    h('div', { class: 'dialog-body' }, h('p', { class: 'muted' }, body)),
    h('footer', { class: 'dialog-footer' },
      Button({ label: 'Cancel', onClick: () => close(false) }),
      Button({ label: confirm, kind: danger ? 'danger' : 'primary', onClick: () => close(true) })),
  ], { label: title });
}

// ── Time ────────────────────────────────────────────────────────────────────

/** A signal of the current time (ms), ticking every second while anything reads it. */
export const now = (() => {
  const s = signal(Date.now());
  setInterval(() => { s.value = Date.now(); }, 1000);
  return s;
})();

export function relativeHours(hour) {
  const ms = hour * 3600000 - Date.now();
  if (ms <= 0) return 'expired';
  const hrs = Math.round(ms / 3600000);
  if (hrs < 1) return 'in under an hour';
  if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `in ${Math.round(hrs / 24)} days`;
}

export { effect, onCleanup };
