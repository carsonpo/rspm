// The unlocked vault: sidebar, item list, and detail pane.

import { h, signal, computed, when, list, onCleanup, untrack } from '../ui.js';
import { icon } from '../icons.js';
import { Button, IconButton, Monogram, Empty, Notice, confirmDialog, toast } from '../components.js';
import { session, doc, saving, save, lock, refresh } from '../session.js';
import { TYPES, subtitle, matches, ItemHeader, ItemFields, ItemEditor, TotpCode, EnvTools } from './item.js';
import { openShareDialog, SharesPage } from './share.js';
import { SettingsPage } from './settings.js';
import { putItem, removeItem } from '../../../core/vault.js';

const FILTERS = [
  ['all', 'All items', 'layers'],
  ['login', 'Logins', 'login'],
  ['totp', 'Two-factor', 'clock'],
  ['env', 'Environments', 'terminal'],
  ['note', 'Notes', 'note'],
];

export function VaultView() {
  const filter = signal('all');
  const query = signal('');
  const selected = signal(null); // item id
  const mode = signal('view');   // 'view' | 'edit' | 'new'
  const draftType = signal('login');
  const page = signal(null);     // null | 'settings' | 'shares'
  const pane = signal('list');   // mobile: which pane is visible
  const newMenu = signal(false);
  const busy = computed(() => !!saving.value);

  const items = computed(() => {
    const d = doc.value;
    if (!d) return [];
    return d.items
      .filter((i) => (filter.value === 'all' || i.type === filter.value) && matches(i, query.value))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
  });
  const counts = computed(() => {
    const c = { all: 0 };
    for (const i of doc.value?.items ?? []) { c.all++; c[i.type] = (c[i.type] ?? 0) + 1; }
    return c;
  });
  const current = computed(() => doc.value?.items.find((i) => i.id === selected.value) ?? null);

  const openItem = (id) => { page.value = null; selected.value = id; mode.value = 'view'; pane.value = 'detail'; };
  const startNew = (type) => { page.value = null; draftType.value = type; selected.value = null; mode.value = 'new'; pane.value = 'detail'; newMenu.value = false; };
  const openPage = (p) => { page.value = p; pane.value = 'detail'; };
  const back = () => { pane.value = 'list'; if (mode.peek() === 'new') mode.value = 'view'; };

  const onSave = async (item) => {
    let savedId;
    const ok = await save((d) => { savedId = putItem(d, item).id; }, mode.peek() === 'new' ? `Added “${item.name}”` : 'Changes saved');
    if (ok) { selected.value = savedId; mode.value = 'view'; }
  };

  const onDelete = async (item) => {
    const ok = await confirmDialog({ title: `Delete “${item.name}”?`, body: 'It will be removed from this vault on all your devices.', confirm: 'Delete', danger: true });
    if (!ok) return;
    if (await save((d) => removeItem(d, item.id), `Deleted “${item.name}”`)) { selected.value = null; pane.value = 'list'; }
  };

  // Keyboard: "/" focuses search; "n" starts a new login.
  let searchEl;
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === '/') { e.preventDefault(); searchEl?.focus(); }
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // Pick up changes from other devices when the window regains focus.
  const onFocus = () => refresh();
  window.addEventListener('focus', onFocus);
  onCleanup(() => window.removeEventListener('focus', onFocus));

  const BackButton = () => h('span', { class: 'only-mobile' }, IconButton({ icon: 'back', label: 'Back', onClick: back }));

  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Vault' },
    h('div', { class: 'sidebar-brand' }, h('span', { class: 'brand-mark' }, icon('lock', 16)), h('span', { class: 'brand-name' }, 'rspm')),
    h('div', { class: 'new-wrap' },
      Button({ label: 'New item', icon: 'plus', kind: 'primary', onClick: () => { newMenu.value = !newMenu.peek(); } }),
      when(() => newMenu.value, () => h('div', { class: 'menu', role: 'menu' },
        Object.entries(TYPES).map(([t, info]) => h('button', { type: 'button', role: 'menuitem', class: 'menu-item', on: { click: () => startNew(t) } }, icon(info.icon, 16), info.label))))),
    h('ul', { class: 'nav' }, FILTERS.map(([key, label, ic]) => h('li', null,
      h('button', {
        type: 'button', class: () => ['nav-item', !page.value && filter.value === key && 'is-active'],
        on: { click: () => { filter.value = key; page.value = null; pane.value = 'list'; } },
      }, icon(ic, 17), h('span', null, label), h('span', { class: 'nav-count' }, () => counts.value[key] ?? 0))))),
    h('ul', { class: 'nav nav-secondary' },
      h('li', null, h('button', { type: 'button', class: () => ['nav-item', page.value === 'shares' && 'is-active'], on: { click: () => openPage('shares') } }, icon('link', 17), h('span', null, 'Shares'))),
      h('li', null, h('button', { type: 'button', class: () => ['nav-item', page.value === 'settings' && 'is-active'], on: { click: () => openPage('settings') } }, icon('settings', 17), h('span', null, 'Settings')))),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'sync' }, () => (saving.value
        ? [h('span', { class: 'spinner spinner-sm' }), `Saving ${saving.value.done}/${saving.value.total}`]
        : [h('span', { class: 'sync-dot' }), `Saved · rev ${session.value?.vault.gen ?? ''}`])),
      IconButton({ icon: 'lock', label: 'Lock', onClick: lock })));

  const listPane = h('section', { class: 'list-pane', 'aria-label': 'Items' },
    h('div', { class: 'list-head' },
      h('div', { class: 'mobile-bar only-mobile' },
        h('span', { class: 'brand-mark' }, icon('lock', 16)),
        h('select', { class: 'mobile-filter', 'aria-label': 'Filter', on: { change: (e) => { const v = e.target.value; if (v === 'settings' || v === 'shares') { openPage(v); e.target.value = filter.peek(); } else { filter.value = v; } } } },
          FILTERS.map(([k, label]) => h('option', { value: k }, label)), h('option', { value: 'shares' }, 'Shares'), h('option', { value: 'settings' }, 'Settings')),
        IconButton({ icon: 'plus', label: 'New login', onClick: () => startNew(filter.peek() === 'all' ? 'login' : filter.peek()) }),
        IconButton({ icon: 'lock', label: 'Lock', onClick: lock })),
      h('label', { class: 'search' }, icon('search', 16),
        h('input', {
          ref: (el) => { searchEl = el; }, type: 'search', class: 'search-input', placeholder: 'Search', 'aria-label': 'Search items',
          value: () => query.value, on: { input: (e) => { query.value = e.target.value; } },
        }),
        h('kbd', { class: 'search-kbd' }, '/'))),
    session.peek().rollback ? Notice({ tone: 'danger', title: 'Showing an older revision', children: 'The server returned an older version of your vault than this device has seen. Saving is disabled.' }) : null,
    () => (items.value.length || query.value
      ? h('ul', { class: 'item-list', role: 'listbox', 'aria-label': 'Items' },
        list(() => items.value, (i) => i.id, (it) => h('li', { role: 'option', 'aria-selected': () => String(selected.value === it().id && !page.value) },
          h('button', { type: 'button', class: () => ['item-row', selected.value === it().id && !page.value && 'is-selected'], on: { click: () => openItem(it().id) } },
            () => Monogram({ name: it().name, type: it().type }),
            h('span', { class: 'item-row-text' },
              h('span', { class: 'item-row-name' }, () => it().name || 'Untitled'),
              h('span', { class: 'item-row-sub' }, () => subtitle(it()))),
            () => (it().type === 'totp' ? TotpCode({ uri: () => it().otpauth, compact: true }) : null)))),
        () => (query.value && !items.value.length ? h('li', { class: 'list-empty muted' }, `No items match “${query.value}”`) : null))
      : h('div', { class: 'list-empty-wrap' }, Empty({
        icon: filter.value === 'all' ? 'inbox' : TYPES[filter.value].icon,
        title: filter.value === 'all' ? 'Your vault is empty' : `No ${TYPES[filter.value].plural.toLowerCase()} yet`,
        body: filter.value === 'all' ? 'Add a login, a two-factor code, environment variables or a note.' : null,
        action: Button({ label: `New ${filter.value === 'all' ? 'login' : TYPES[filter.value].label.toLowerCase()}`, icon: 'plus', onClick: () => startNew(filter.value === 'all' ? 'login' : filter.value) }),
      }))));

  const detail = h('section', { class: 'detail-pane', 'aria-label': 'Details' },
    () => {
      if (page.value === 'settings') return SettingsPage({ back: BackButton() });
      if (page.value === 'shares') return SharesPage({ back: BackButton() });
      if (mode.value === 'new') {
        const t = draftType.value;
        return h('div', { class: 'detail' },
          h('header', { class: 'detail-header' }, BackButton(), h('div', { class: 'detail-heading' }, h('p', { class: 'eyebrow' }, 'New item'), h('h1', { class: 'detail-title' }, TYPES[t].label))),
          ItemEditor({ item: { type: t }, onSave, onCancel: back, busy: () => busy.value }));
      }
      // While editing, don't rebuild the form (and lose input) when a background refresh lands.
      const item = mode.value === 'edit' ? untrack(() => current.value) : current.value;
      if (!item) return h('div', { class: 'detail-empty' }, Empty({ icon: 'lock', title: 'Select an item', body: 'Its details stay encrypted until you open it here.' }));
      if (mode.value === 'edit') {
        return h('div', { class: 'detail' },
          h('header', { class: 'detail-header' }, BackButton(), h('div', { class: 'detail-heading' }, h('p', { class: 'eyebrow' }, 'Editing'), h('h1', { class: 'detail-title' }, item.name))),
          ItemEditor({ item, onSave, onCancel: () => { mode.value = 'view'; }, busy: () => busy.value }));
      }
      return h('div', { class: 'detail' },
        ItemHeader({
          item, back: BackButton(),
          actions: [
            IconButton({ icon: 'share', label: 'Share', onClick: () => openShareDialog(item) }),
            IconButton({ icon: 'edit', label: 'Edit', onClick: () => { mode.value = 'edit'; } }),
            IconButton({ icon: 'trash', label: 'Delete', onClick: () => onDelete(item) }),
          ],
        }),
        ItemFields({ item }),
        item.type === 'env' && EnvTools({ item }),
        h('p', { class: 'detail-meta muted small' }, `Last changed ${new Date(item.updated * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`));
    });

  return h('div', { class: 'shell', 'data-pane': () => pane.value }, sidebar, listPane, detail);
}
