// Share dialog, active shares, and the "shared with you" page.

import { h, signal, when, list } from '../ui.js';
import { icon } from '../icons.js';
import { Button, Field, Input, Segmented, Select, Toggle, Notice, DialogHeader, openDialog, copy, toast, relativeHours, Empty, IconButton, confirmDialog } from '../components.js';
import { session, store, save, writable, config } from '../session.js';
import { ItemFields, TYPES } from './item.js';
import { createLinkShare, createRecipientShare, lookupHandle, openShare, deleteShare, normalizeHandle } from '../../../core/share.js';
import { putItem } from '../../../core/vault.js';

const EXPIRY = [['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days']];

function shareable(item) {
  const { id, updated, ...rest } = item;
  return rest;
}

export function openShareDialog(item) {
  return openDialog((close) => {
    const mode = signal('link');
    const hours = signal('24');
    const burn = signal(false);
    const handle = signal('');
    const recipient = signal(null);
    const verified = signal(false);
    const lookupError = signal(null);
    const busy = signal(false);
    const result = signal(null);

    const lookup = async () => {
      lookupError.value = null;
      recipient.value = null;
      verified.value = false;
      let name;
      try { name = normalizeHandle(handle.peek()); } catch (e) { lookupError.value = e.message; return; }
      busy.value = true;
      try {
        const r = await lookupHandle(store, name);
        if (!r) lookupError.value = `No one has published the handle @${name}`;
        else recipient.value = r;
      } catch (e) { lookupError.value = e.message; } finally { busy.value = false; }
    };

    const create = async () => {
      if (!writable()) return;
      busy.value = true;
      try {
        const from = session.peek()?.vault.doc.identity?.handle ?? null;
        const opts = { hours: Number(hours.peek()), burn: burn.peek(), from, origin: config.link };
        const { url, entry } = mode.peek() === 'link'
          ? await createLinkShare(store, shareable(item), opts)
          : await createRecipientShare(store, shareable(item), recipient.peek(), opts);
        // Show the link only once it's tracked in Active shares, so it can always be revoked.
        if (await save((d) => { d.shares = [...(d.shares ?? []), entry]; }, null)) {
          result.value = url;
          return;
        }
        try {
          await deleteShare(store, entry);
          toast('The share couldn’t be added to your vault, so it was deleted. Try again.', { tone: 'danger', ms: 6000 });
        } catch {
          toast(`The share couldn’t be added to your vault or deleted. Anyone with the link can open it until it expires ${relativeHours(entry.hour)}.`, { tone: 'danger', ms: 12000 });
        }
      } catch (e) {
        toast(`Couldn’t create the share: ${e.message}`, { tone: 'danger' });
      } finally { busy.value = false; }
    };

    const canCreate = () => !busy.value && (mode.value === 'link' || (recipient.value && verified.value));

    return [
      DialogHeader({ title: `Share “${item.name}”`, close }),
      h('div', { class: 'dialog-body' }, () => (result.value
        ? h('div', { class: 'stack' },
          h('div', { class: 'share-result' },
            h('div', { class: 'share-result-icon' }, icon('check', 20)),
            h('div', null, h('strong', null, 'Share created'),
              h('p', { class: 'muted small' }, mode.peek() === 'link'
                ? 'Anyone with this link can view the item until it expires. Send it over a channel you trust.'
                : `Only @${recipient.peek().handle} can open this link, even if someone else gets hold of it.`))),
          h('div', { class: 'code-line' }, h('code', { class: 'break' }, result.value),
            IconButton({ icon: 'copy', label: 'Copy link', onClick: () => copy(result.value, 'Link copied', { sensitive: mode.peek() === 'link' }) })),
          Notice({ tone: 'warn', title: 'Sharing is permanent', children: 'Expiry deletes the encrypted copy, but it can’t make anyone forget what they saw. If this secret matters, change it after they’re done.' }))
        : h('div', { class: 'stack' },
          Segmented({ value: mode, label: 'Share type', options: [['link', 'Anyone with the link'], ['handle', 'A specific person']] }),
          when(() => mode.value === 'handle', () => h('div', { class: 'stack' },
            Field({
              label: 'Their handle', error: () => lookupError.value,
              hint: 'They publish a handle in Settings. It’s separate from their login username.',
              children: h('div', { class: 'input-row' },
                h('span', { class: 'input-prefix' }, '@'),
                Input({ value: handle, placeholder: 'handle', onEnter: lookup }),
                Button({ label: 'Look up', onClick: lookup, busy: () => busy.value && !recipient.value })),
            }),
            () => (recipient.value ? h('div', { class: 'fingerprint-box' },
              h('div', { class: 'fingerprint-label' }, `Fingerprint for @${recipient.value.handle}`),
              h('div', { class: 'fingerprint mono' }, recipient.value.fingerprint),
              h('p', { class: 'muted small' }, 'Ask them to read out the fingerprint shown in their Settings. If it doesn’t match exactly, don’t share — someone may be impersonating them.'),
              Toggle({ checked: verified, label: 'The fingerprints match' })) : null))),
          h('div', { class: 'grid-2' },
            Field({ label: 'Expires after', children: Select({ value: hours, options: EXPIRY }) }),
            h('div', { class: 'field field-toggle' }, Toggle({ checked: burn, label: 'Delete after it’s opened', hint: 'The first browser to open it deletes it from the server. Not a guarantee: a modified app can skip deleting, and two people opening it at once can both see it.' }))),
          item.type === 'totp' || item.otpauth ? Notice({ tone: 'warn', title: 'This shares a two-factor secret', children: 'Whoever opens it can generate codes for this account indefinitely.' }) : null))),
      () => (result.value
        ? h('footer', { class: 'dialog-footer' }, Button({ label: 'Done', kind: 'primary', onClick: () => close() }))
        : h('footer', { class: 'dialog-footer' },
          Button({ label: 'Cancel', onClick: () => close() }),
          Button({ label: 'Create share', icon: 'link', kind: 'primary', onClick: create, disabled: () => !canCreate(), busy: () => busy.value && (mode.value === 'link' || !!recipient.value) }))),
    ];
  }, { label: 'Share item' });
}

export function SharesPage({ back }) {
  const s = session.peek();
  const active = () => (s.vault.doc.shares ?? []).filter((x) => x.hour * 3600000 > Date.now()).sort((a, b) => b.created - a.created);
  const shares = signal(active());
  const revoke = async (entry) => {
    const ok = await confirmDialog({ title: 'Revoke this share?', body: 'The link stops working immediately. Anyone who already opened it may still have the contents.', confirm: 'Revoke', danger: true });
    if (!ok) return;
    try {
      await deleteShare(store, entry);
      await save((d) => {
        d.shares = (d.shares ?? []).filter((x) => x.s !== entry.s);
        d.tombstones[`share:${entry.s}`] = Math.floor(Date.now() / 1000) + 1;
      }, 'Share revoked');
      shares.value = active();
    } catch (e) { toast(`Couldn’t revoke: ${e.message}`, { tone: 'danger' }); }
  };
  return h('div', { class: 'page' },
    h('header', { class: 'page-header' }, back, h('div', null, h('h1', { class: 'page-title' }, 'Active shares'),
      h('p', { class: 'page-subtitle' }, 'Links you’ve created that haven’t expired yet.'))),
    () => (shares.value.length
      ? h('ul', { class: 'share-list' }, list(() => shares.value, (x) => x.s, (x) => h('li', { class: 'share-row' },
        h('span', { class: 'share-row-icon' }, icon(x().kind === 'link' ? 'link' : 'at', 18)),
        h('div', { class: 'share-row-main' },
          h('div', { class: 'share-row-name' }, x().name || 'Untitled item'),
          h('div', { class: 'muted small' }, x().kind === 'link' ? 'Anyone with the link' : `Only @${x().to}`, ' · expires ', relativeHours(x().hour))),
        Button({ label: 'Revoke', kind: 'ghost', size: 'sm', onClick: () => revoke(x()) }))))
      : Empty({ icon: 'link', title: 'Nothing shared right now', body: 'Use Share on any item to create a link that expires on its own.' })));
}

/** Full-page view for a share link opened in the browser. */
export function ReceivedShare({ fragment, onDone }) {
  const state = signal({ loading: true });
  const load = async () => {
    state.value = { loading: true };
    try {
      const identity = session.peek()?.vault.doc.identity ?? null;
      const r = await openShare(store, fragment, identity);
      let burned = false, burnError = null;
      if (r.meta.burn) {
        try {
          await deleteShare(store, { kind: r.kind, s: r.s, hour: r.hour, n: r.meta.n });
          burned = true;
        } catch (e) { burnError = e.message; }
      }
      state.value = { share: r, burned, burnError };
    } catch (e) {
      state.value = { error: e.message };
    }
  };
  load();
  const saveIt = async () => {
    const item = state.peek().share.item;
    if (await save((d) => { putItem(d, { ...item, id: undefined, updated: 0 }); }, `Saved “${item.name}” to your vault`)) onDone();
  };
  return h('div', { class: 'auth' },
    h('div', { class: 'auth-card auth-card-wide' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('lock', 18)), h('span', { class: 'brand-name' }, 'rspm')),
      () => {
        const st = state.value;
        if (st.loading) return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Decrypting…');
        if (st.error) {
          return h('div', { class: 'stack' },
            h('h1', { class: 'auth-title' }, 'This share can’t be opened'),
            h('p', { class: 'muted' }, st.error),
            st.error.includes('Sign in') ? Button({ label: 'Sign in', kind: 'primary', onClick: () => onDone({ signIn: true }) }) : Button({ label: 'Go to rspm', onClick: () => onDone() }));
        }
        const { share, burned, burnError } = st;
        const item = share.item;
        return h('div', { class: 'stack' },
          h('div', null,
            h('p', { class: 'eyebrow' }, share.meta.from ? `Shared by @${share.meta.from}` : 'Shared with you'),
            h('h1', { class: 'auth-title' }, item.name || 'Untitled'),
            h('p', { class: 'muted small' }, TYPES[item.type]?.label ?? 'Item', burned ? ' · deleted from the server now that you’ve opened it' : ` · expires ${relativeHours(share.hour)}`)),
          burned && Notice({ tone: 'warn', title: 'Deleted from the server', children: 'Copy what you need before leaving this page — this link won’t open again.' }),
          burnError && Notice({ tone: 'danger', title: 'This share couldn’t be deleted from the server', children: `It was meant to be deleted once opened, so it may still open for others until it expires ${relativeHours(share.hour)}. ${burnError}` }),
          ItemFields({ item }),
          h('div', { class: 'button-row' },
            session.value
              ? Button({ label: 'Save to my vault', icon: 'download', kind: 'primary', onClick: saveIt })
              : Button({ label: 'Sign in to save it', onClick: () => onDone({ signIn: true, keep: true }) }),
            Button({ label: 'Close', kind: 'ghost', onClick: () => onDone() })));
      }));
}
