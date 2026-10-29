// Item types: detail views and editors.

import { h, signal, effect, onCleanup, when, list, computed } from '../ui.js';
import { icon } from '../icons.js';
import { Button, IconButton, Field, Input, Textarea, PasswordInput, ValueRow, Monogram, Notice, Toggle, Segmented, copy, id, now, toast } from '../components.js';
import { generatePassword, generatePassphrase, passwordBits, passphraseBits } from '../generator.js';
import { totp, parseOtpauth } from '../../../core/totp.js';

export const TYPES = {
  login: { label: 'Login', plural: 'Logins', icon: 'login' },
  totp: { label: 'Two-factor code', plural: 'Two-factor', icon: 'clock' },
  env: { label: 'Environment', plural: 'Environments', icon: 'terminal' },
  note: { label: 'Secure note', plural: 'Notes', icon: 'note' },
};

const host = (url) => {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname; } catch { return url; }
};

export function subtitle(item) {
  switch (item.type) {
    case 'login': return item.username || (item.url ? host(item.url) : '');
    case 'totp': {
      try { const p = parseOtpauth(item.otpauth); return [p.issuer, p.account].filter(Boolean).join(' · '); } catch { return ''; }
    }
    case 'env': { const n = Object.keys(item.vars ?? {}).length; return `${n} variable${n === 1 ? '' : 's'}`; }
    case 'note': return (item.body ?? '').split('\n')[0].slice(0, 80);
    default: return '';
  }
}

export function matches(item, q) {
  if (!q) return true;
  const hay = [item.name, item.username, item.url, subtitle(item), ...Object.keys(item.vars ?? {})].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

// ── TOTP ────────────────────────────────────────────────────────────────────

/** Live code display. `compact` is the list-row variant. */
export function TotpCode({ uri, compact = false }) {
  const state = signal(null);
  const err = signal(null);
  let last = -1;
  effect(() => {
    const t = now.value;
    const u = uri();
    const step = Math.floor(t / 1000);
    if (step === last) return;
    last = step;
    totp(u, t).then((r) => { state.value = r; err.value = null; }, (e) => { err.value = e.message; });
  });
  const fmt = (c) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);
  const R = compact ? 7 : 9;
  const C = 2 * Math.PI * R;
  const ring = () => h('svg', { class: 'totp-ring', width: R * 2 + 4, height: R * 2 + 4, viewBox: `0 0 ${R * 2 + 4} ${R * 2 + 4}`, 'aria-hidden': 'true' },
    h('circle', { class: 'totp-ring-track', cx: R + 2, cy: R + 2, r: R }),
    h('circle', {
      class: () => ['totp-ring-fill', state.value?.remaining <= 5 && 'is-low'], cx: R + 2, cy: R + 2, r: R,
      'stroke-dasharray': C, 'stroke-dashoffset': () => (state.value ? C * (1 - state.value.remaining / state.value.period) : C),
      transform: `rotate(-90 ${R + 2} ${R + 2})`,
    }));
  if (compact) {
    return h('span', { class: 'totp-compact' }, () => (state.value ? fmt(state.value.code) : '··· ···'), ring());
  }
  return h('div', { class: 'totp' },
    () => (err.value
      ? Notice({ tone: 'danger', title: 'This code can’t be generated', children: err.value })
      : h('div', { class: 'totp-main' },
        h('button', {
          type: 'button', class: () => ['totp-code', state.value?.remaining <= 5 && 'is-low'], title: 'Copy code',
          on: { click: () => state.peek() && copy(state.peek().code, 'Code copied', { sensitive: false }) },
        }, () => (state.value ? fmt(state.value.code) : '··· ···')),
        h('div', { class: 'totp-meta' }, ring(), h('span', null, () => (state.value ? `${state.value.remaining}s` : ''))),
        IconButton({ icon: 'copy', label: 'Copy code', onClick: () => state.peek() && copy(state.peek().code, 'Code copied', { sensitive: false }) }))));
}

// ── Detail view ─────────────────────────────────────────────────────────────

export function ItemHeader({ item, actions, back }) {
  return h('header', { class: 'detail-header' },
    back,
    Monogram({ name: item.name, type: item.type }),
    h('div', { class: 'detail-heading' },
      h('h1', { class: 'detail-title' }, item.name || 'Untitled'),
      h('p', { class: 'detail-kind' }, icon(TYPES[item.type]?.icon ?? 'note', 14), TYPES[item.type]?.label ?? item.type)),
    h('div', { class: 'detail-actions' }, actions));
}

export function ItemFields({ item }) {
  const rows = [];
  if (item.type === 'login') {
    if (item.username) rows.push(ValueRow({ label: 'Username', value: item.username }));
    if (item.password) rows.push(ValueRow({ label: 'Password', value: item.password, secret: true }));
    if (item.url) rows.push(ValueRow({ label: 'Website', value: item.url, href: () => (/^https?:\/\//i.test(item.url) ? item.url : `https://${item.url}`) }));
    if (item.otpauth) rows.push(h('div', { class: 'value-row value-row-block' }, h('div', { class: 'value-row-label' }, 'Two-factor code'), TotpCode({ uri: () => item.otpauth })));
  }
  if (item.type === 'totp') {
    rows.push(h('div', { class: 'value-row value-row-block' }, h('div', { class: 'value-row-label' }, 'Current code'), TotpCode({ uri: () => item.otpauth })));
    rows.push(ValueRow({ label: 'Setup key', value: item.otpauth, secret: true }));
  }
  if (item.type === 'env') {
    const vars = Object.entries(item.vars ?? {});
    if (!vars.length) rows.push(h('p', { class: 'muted' }, 'No variables yet.'));
    for (const [k, v] of vars) rows.push(ValueRow({ label: k, value: v, secret: true, copyLabel: `${k} copied` }));
  }
  if (item.type === 'note' && item.body) rows.push(ValueRow({ label: 'Note', value: item.body, multiline: true }));
  if (item.notes) rows.push(ValueRow({ label: 'Notes', value: item.notes, multiline: true }));
  return h('div', { class: 'value-list' }, rows);
}

export function EnvTools({ item }) {
  const dotenv = () => Object.entries(item.vars ?? {}).map(([k, v]) => `${k}=${/[\s"'#$]/.test(v) ? JSON.stringify(v) : v}`).join('\n');
  const cli = `rspm run --env ${JSON.stringify(item.name).replace(/^"(.*)"$/, /\s/.test(item.name) ? '"$1"' : '$1')} -- npm start`;
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, 'Use these variables'),
    h('div', { class: 'button-row' },
      Button({ label: 'Copy as .env', icon: 'copy', onClick: () => copy(dotenv(), '.env copied') })),
    h('p', { class: 'muted small' }, 'Or inject them straight into a command with the CLI:'),
    h('div', { class: 'code-line' }, h('code', null, cli), IconButton({ icon: 'copy', label: 'Copy command', onClick: () => copy(cli, 'Command copied', { sensitive: false }) })));
}

// ── Editors ─────────────────────────────────────────────────────────────────

function GeneratorPanel({ onUse }) {
  const mode = signal('passphrase');
  const length = signal(20);
  const words = signal(5);
  const symbols = signal(true);
  const value = signal('');
  const regen = () => {
    value.value = mode.value === 'passphrase' ? generatePassphrase({ words: words.value }) : generatePassword({ length: length.value, symbols: symbols.value });
  };
  effect(regen);
  const bits = () => (mode.value === 'passphrase' ? passphraseBits(words.value) : passwordBits({ length: length.value, digits: true, symbols: symbols.value }));
  return h('div', { class: 'generator' },
    h('div', { class: 'generator-top' },
      Segmented({ value: mode, label: 'Generator type', options: [['passphrase', 'Passphrase'], ['password', 'Random']] }),
      h('span', { class: 'generator-bits' }, () => `${bits()} bits`)),
    h('div', { class: 'generator-value mono' }, () => value.value),
    () => (mode.value === 'passphrase'
      ? h('label', { class: 'range' }, h('span', null, () => `${words.value} words`),
        h('input', { type: 'range', min: 4, max: 10, value: () => words.value, on: { input: (e) => { words.value = Number(e.target.value); } } }))
      : h('div', { class: 'generator-opts' },
        h('label', { class: 'range' }, h('span', null, () => `${length.value} characters`),
          h('input', { type: 'range', min: 12, max: 64, value: () => length.value, on: { input: (e) => { length.value = Number(e.target.value); } } })),
        Toggle({ checked: symbols, label: 'Symbols' }))),
    h('div', { class: 'button-row' },
      Button({ label: 'Regenerate', icon: 'dice', onClick: regen }),
      Button({ label: 'Use this', kind: 'primary', icon: 'check', onClick: () => onUse(value.peek()) })));
}

/** Editor for any item type. `onSave(item)` receives the edited item. */
export function ItemEditor({ item, onSave, onCancel, busy }) {
  const type = item.type;
  const f = {
    name: signal(item.name ?? ''),
    username: signal(item.username ?? ''),
    password: signal(item.password ?? ''),
    url: signal(item.url ?? ''),
    otpauth: signal(item.otpauth ?? ''),
    body: signal(item.body ?? ''),
    notes: signal(item.notes ?? ''),
  };
  const vars = signal(Object.entries(item.vars ?? {}).map(([k, v], i) => ({ key: k, value: v, id: i })));
  let nextVar = vars.peek().length;
  const showGen = signal(false);
  const error = signal(null);
  const otpError = computed(() => {
    const v = f.otpauth.value.trim();
    if (!v) return null;
    try { parseOtpauth(v); return null; } catch (e) { return e.message; }
  });

  const submit = () => {
    if (!f.name.value.trim()) { error.value = 'Give this item a name'; return; }
    if ((type === 'totp' && !f.otpauth.value.trim())) { error.value = 'Paste the setup key or otpauth:// link'; return; }
    if (otpError.peek()) { error.value = otpError.peek(); return; }
    const out = { ...item, name: f.name.value.trim(), notes: f.notes.value || undefined };
    if (type === 'login') Object.assign(out, { username: f.username.value, password: f.password.value, url: f.url.value.trim(), otpauth: f.otpauth.value.trim() || undefined });
    if (type === 'totp') out.otpauth = f.otpauth.value.trim();
    if (type === 'note') out.body = f.body.value;
    if (type === 'env') {
      const entries = vars.peek().filter((v) => v.key.trim());
      const keys = entries.map((v) => v.key.trim());
      const bad = keys.find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      if (bad) { error.value = `“${bad}” isn’t a valid variable name`; return; }
      if (new Set(keys).size !== keys.length) { error.value = 'Variable names must be unique'; return; }
      out.vars = Object.fromEntries(entries.map((v) => [v.key.trim(), v.value]));
    }
    for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
    out.name = f.name.value.trim();
    error.value = null;
    onSave(out);
  };

  const showPaste = signal(false);
  const pasteText = signal('');
  const pasteEnv = () => {
    const text = pasteText.peek();
    showPaste.value = false;
    pasteText.value = '';
    if (!text.trim()) return;
    const parsed = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
      parsed.push({ key: m[1], value: v, id: nextVar++ });
    }
    const existing = vars.peek().filter((v) => v.key.trim() && !parsed.some((p) => p.key === v.key));
    vars.value = [...existing, ...parsed];
    toast(`Added ${parsed.length} variable${parsed.length === 1 ? '' : 's'}`, { tone: 'neutral' });
  };

  const fid = Object.fromEntries(['name', 'username', 'password', 'url', 'otpauth', 'body', 'notes'].map((k) => [k, id(k)]));
  return h('form', { class: 'editor', on: { submit: (e) => { e.preventDefault(); submit(); } } },
    Field({ label: 'Name', id: fid.name, children: Input({ value: f.name, id: fid.name, placeholder: { login: 'e.g. GitHub', totp: 'e.g. AWS root', env: 'e.g. my-api-prod', note: 'e.g. Wi-Fi details' }[type], autofocus: !item.id }) }),
    type === 'login' && [
      Field({ label: 'Username', id: fid.username, children: Input({ value: f.username, id: fid.username, placeholder: 'name@example.com' }) }),
      Field({
        label: 'Password', id: fid.password,
        children: [
          PasswordInput({ value: f.password, id: fid.password, extra: IconButton({ icon: 'dice', label: 'Generate a password', pressed: () => showGen.value, onClick: () => { showGen.value = !showGen.peek(); } }) }),
          when(() => showGen.value, () => GeneratorPanel({ onUse: (v) => { f.password.value = v; showGen.value = false; } })),
        ],
      }),
      Field({ label: 'Website', id: fid.url, optional: true, children: Input({ value: f.url, id: fid.url, placeholder: 'https://example.com', inputmode: 'url' }) }),
      Field({ label: 'Two-factor setup key', id: fid.otpauth, optional: true, error: () => otpError.value, hint: 'Paste an otpauth:// link or the key shown when you set up two-factor.', children: Input({ value: f.otpauth, id: fid.otpauth, mono: true, placeholder: 'otpauth://totp/… or JBSW Y3DP …' }) }),
    ],
    type === 'totp' && Field({ label: 'Setup key', id: fid.otpauth, error: () => otpError.value, hint: 'Paste the otpauth:// link (from “can’t scan the QR code?”) or the base32 key.', children: Input({ value: f.otpauth, id: fid.otpauth, mono: true, placeholder: 'otpauth://totp/… or JBSW Y3DP …' }) }),
    type === 'totp' && Notice({ tone: 'warn', title: 'Both factors, one vault', children: 'Keeping two-factor codes alongside passwords is convenient, but it means one vault unlocks both. For your most important accounts, consider a separate authenticator.' }),
    type === 'note' && Field({ label: 'Note', id: fid.body, children: Textarea({ value: f.body, id: fid.body, rows: 10 }) }),
    type === 'env' && h('div', { class: 'field' },
      h('div', { class: 'field-label' }, 'Variables'),
      h('div', { class: 'env-rows' },
        list(() => vars.value, (v) => v.id, (v) => {
          const key = signal(v().key), value = signal(v().value);
          effect(() => { const k = key.value, val = value.value; const cur = vars.peek().find((x) => x.id === v().id); if (cur) { cur.key = k; cur.value = val; } });
          return h('div', { class: 'env-row' },
            Input({ value: key, mono: true, placeholder: 'NAME' }),
            PasswordInput({ value: value, placeholder: 'value' }),
            IconButton({ icon: 'x', label: 'Remove variable', onClick: () => { vars.value = vars.peek().filter((x) => x.id !== v().id); } }));
        })),
      h('div', { class: 'button-row' },
        Button({ label: 'Add variable', icon: 'plus', onClick: () => { vars.value = [...vars.peek(), { key: '', value: '', id: nextVar++ }]; } }),
        Button({ label: 'Paste .env', icon: 'upload', kind: 'ghost', onClick: () => { showPaste.value = !showPaste.peek(); } })),
      when(() => showPaste.value, () => h('div', { class: 'paste-env' },
        Textarea({ value: pasteText, rows: 5, mono: true, placeholder: 'API_KEY=…\nDATABASE_URL=…' }),
        h('div', { class: 'button-row' },
          Button({ label: 'Cancel', kind: 'ghost', onClick: () => { showPaste.value = false; } }),
          Button({ label: 'Add variables', kind: 'primary', onClick: pasteEnv }))))),
    type !== 'note' && Field({ label: 'Notes', id: fid.notes, optional: true, children: Textarea({ value: f.notes, id: fid.notes, rows: 3 }) }),
    () => (error.value ? Notice({ tone: 'danger', title: error.value }) : null),
    h('footer', { class: 'editor-footer' },
      Button({ label: 'Cancel', onClick: onCancel }),
      Button({ label: item.id ? 'Save changes' : 'Add to vault', kind: 'primary', type: 'submit', busy })));
}
