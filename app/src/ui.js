// A tiny reactive UI layer: signals, effects, and DOM construction.
//
// Safety rule: this module can only produce text nodes and elements built
// with createElement. There is no path to innerHTML, outerHTML,
// insertAdjacentHTML, or attribute-based event handlers, so vault data can
// never be interpreted as markup. Trusted Types (see index.html CSP) enforce
// the same thing at the browser level.

let owner = null;    // effect that owns newly created effects (disposal tree)
let listener = null; // effect currently tracking signal reads
let batching = 0;
const queue = new Set();

function makeOwner(fn = null) {
  const o = { fn, deps: new Set(), cleanups: [], children: [], disposed: false, parent: owner };
  if (owner) owner.children.push(o);
  return o;
}

function clean(o) {
  for (const d of o.deps) d.delete(o);
  o.deps.clear();
  for (const c of o.children.splice(0)) dispose(c);
  for (const c of o.cleanups.splice(0)) c();
}

function dispose(o) {
  if (o.disposed) return;
  o.disposed = true;
  clean(o);
}

function run(o) {
  if (o.disposed) return;
  clean(o);
  const [po, pl] = [owner, listener];
  owner = listener = o;
  try { o.fn(); } finally { [owner, listener] = [po, pl]; }
}

function schedule(o) {
  if (batching) queue.add(o);
  else run(o);
}

/** A reactive value. Read `.value` inside an effect to subscribe. */
export function signal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get value() {
      if (listener) { subs.add(listener); listener.deps.add(subs); }
      return value;
    },
    set value(v) {
      if (Object.is(v, value)) return;
      value = v;
      for (const s of [...subs]) schedule(s);
    },
    peek: () => value,
    update(fn) { this.value = fn(value); },
  };
}

/** Runs `fn` now and again whenever a signal it read changes. Returns a disposer. */
export function effect(fn) {
  const o = makeOwner(fn);
  run(o);
  return () => dispose(o);
}

/** A derived, read-only signal. */
export function computed(fn) {
  const s = signal();
  effect(() => { s.value = fn(); });
  return { get value() { return s.value; }, peek: s.peek };
}

/** Groups signal writes so dependent effects run once. */
export function batch(fn) {
  batching++;
  try { return fn(); } finally {
    if (--batching === 0) {
      const pending = [...queue];
      queue.clear();
      pending.forEach(run);
    }
  }
}

/** Reads signals inside `fn` without subscribing. */
export function untrack(fn) {
  const pl = listener;
  listener = null;
  try { return fn(); } finally { listener = pl; }
}

/** Runs `fn` when the current owner re-runs or is disposed. */
export function onCleanup(fn) {
  owner?.cleanups.push(fn);
}

/** Creates an independent ownership scope. `fn` receives its disposer. */
export function root(fn) {
  const [po, pl] = [owner, listener];
  const o = makeOwner();
  owner = o; listener = null;
  try { return fn(() => dispose(o)); } finally { [owner, listener] = [po, pl]; }
}

// ── DOM ─────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse']);
const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

function setProp(el, key, value) {
  if (FORBIDDEN.has(key) || /^on/i.test(key)) throw new Error(`ui: refusing to set ${key}`);
  if (key === 'class') {
    const v = Array.isArray(value) ? value.filter(Boolean).join(' ') : value ?? '';
    if (el instanceof SVGElement) el.setAttribute('class', v);
    else el.className = v;
  } else if (key === 'style') {
    for (const [k, v] of Object.entries(value ?? {})) {
      if (k.startsWith('--')) el.style.setProperty(k, v);
      else el.style[k] = v;
    }
  } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'textContent' || key === 'open') {
    el[key] = value;
  } else if (key === 'href' || key === 'src' || key === 'action') {
    const v = String(value ?? '');
    if (/^\s*(javascript|data|vbscript):/i.test(v)) throw new Error(`ui: refusing ${key}=${v.slice(0, 20)}`);
    el.setAttribute(key, v);
  } else if (value === false || value == null) {
    el.removeAttribute(key);
  } else {
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

/**
 * Creates an element. Props: `class`, `style` (object), `on:event` handlers
 * (as `onClick` etc. → use `on` object instead), `ref`, attributes. Any prop
 * value that is a function becomes reactive.
 *
 *   h('button', { class: 'btn', on: { click } }, 'Save')
 */
export function h(tag, props, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'ref') v(el);
      else if (typeof v === 'function') effect(() => setProp(el, k, v()));
      else setProp(el, k, v);
    }
  }
  append(el, children);
  return el;
}

function toNodes(v, out = []) {
  if (v == null || v === false || v === true) return out;
  if (Array.isArray(v)) { for (const x of v) toNodes(x, out); return out; }
  if (v instanceof Node) { out.push(v); return out; }
  if (typeof v === 'function') { const f = document.createDocumentFragment(); append(f, [v]); out.push(f); return out; }
  out.push(document.createTextNode(String(v)));
  return out;
}

/** Appends children; function children become reactive regions. */
export function append(parent, children) {
  for (const child of [].concat(children)) {
    if (typeof child !== 'function') {
      for (const n of toNodes(child)) parent.appendChild(n);
      continue;
    }
    const start = document.createComment('');
    const end = document.createComment('');
    parent.appendChild(start);
    parent.appendChild(end);
    let text = null;
    effect(() => {
      const v = child();
      // Fast path: primitive → update a single text node in place.
      if (v == null || typeof v !== 'object' && typeof v !== 'function') {
        const s = v == null || v === false || v === true ? '' : String(v);
        if (text && text.previousSibling === start && text.nextSibling === end) { text.data = s; return; }
        clear(start, end);
        text = document.createTextNode(s);
        end.parentNode.insertBefore(text, end);
        return;
      }
      text = null;
      clear(start, end);
      for (const n of toNodes(v)) end.parentNode.insertBefore(n, end);
    });
  }
}

function clear(start, end) {
  while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
}

/** Renders `yes()` while `cond()` is truthy, otherwise `no()`. Only `cond` is tracked. */
export function when(cond, yes, no) {
  const c = computed(() => !!cond());
  return () => (c.value ? untrack(yes) : no ? untrack(no) : null);
}

/** Renders the branch for the current key: match(() => view.value, { list: () => …, edit: () => … }). */
export function match(key, branches) {
  const k = computed(key);
  return () => {
    const b = branches[k.value] ?? branches._;
    return b ? untrack(() => b(k.value)) : null;
  };
}

/**
 * Keyed list. `render(item, index)` receives getter functions so rows update
 * in place when an item with the same key changes.
 */
export function list(items, key, render) {
  const start = document.createComment('');
  const end = document.createComment('');
  const frag = document.createDocumentFragment();
  frag.append(start, end);
  let rows = new Map();
  onCleanup(() => { for (const r of rows.values()) r.dispose(); });
  effect(() => {
    const arr = items() ?? [];
    untrack(() => {
      const next = new Map();
      arr.forEach((it, i) => {
        const k = key(it, i);
        let r = rows.get(k);
        if (r) {
          r.item.value = it;
          r.index.value = i;
        } else {
          const item = signal(it), index = signal(i);
          r = root((dispose) => ({ item, index, dispose, nodes: toNodes(render(() => item.value, () => index.value)) }));
          r.nodes = r.nodes.flatMap((n) => (n instanceof DocumentFragment ? [...n.childNodes] : [n]));
        }
        next.set(k, r);
      });
      for (const [k, r] of rows) if (!next.has(k)) { r.nodes.forEach((n) => n.remove()); r.dispose(); }
      const parent = end.parentNode;
      if (parent) for (const r of next.values()) for (const n of r.nodes) parent.insertBefore(n, end);
      rows = next;
    });
  });
  // First run happens before the fragment is attached; insert rows into it.
  for (const r of rows.values()) for (const n of r.nodes) frag.insertBefore(n, end);
  return frag;
}

/** Mounts `component()` into `target`, replacing its contents. Returns a disposer. */
export function mount(target, component) {
  return root((dispose) => {
    target.replaceChildren(...toNodes(component()));
    return dispose;
  });
}
