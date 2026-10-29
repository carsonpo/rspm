// Minimal Chrome DevTools Protocol driver for screenshots and end-to-end checks.
// Uses only Node built-ins (fetch, WebSocket, child_process). Dev tooling only.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean);

export async function launch({ port = 9333, dataDir = mkdtempSync(join(tmpdir(), 'rspm-chrome-')) } = {}) {
  const { existsSync } = await import('node:fs');
  const bin = CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('no Chrome found; set CHROME=/path/to/chrome');
  const proc = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    proc,
    async page() {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      return Page.connect(t.webSocketDebuggerUrl);
    },
    close() { proc.kill(); },
  };
}

class Page {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const p = new Page(ws);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.errors = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
        for (const l of this.listeners) l(msg);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async size(width, height, { mobile = false, dark = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  }

  async goto(url) {
    const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { this.listeners = this.listeners.filter((x) => x !== l); r(); } }; this.listeners.push(l); });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluates an async function body in the page and returns its JSON value. */
  async eval(body) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async shot(path, clip) {
    const { writeFileSync } = await import('node:fs');
    const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
}

/** In-page helpers injected by `helpers()`: type into a field by label, click by text, wait for text. */
export const HELPERS = `
  window.$t = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async until(fn, ms = 15000) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + fn); await $t.sleep(50); } },
    field(label) {
      const l = [...document.querySelectorAll('label, .field-label')].find((x) => x.textContent.trim().startsWith(label));
      if (!l) throw new Error('no field ' + label);
      return l.htmlFor ? document.getElementById(l.htmlFor) : l.closest('.field').querySelector('input, textarea, select');
    },
    type(label, value) { const el = $t.field(label); el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); },
    click(text) {
      const el = [...document.querySelectorAll('button, [role=menuitem], label.toggle, a')].find((b) => b.offsetParent !== null && (b.textContent.trim() === text || b.getAttribute('aria-label') === text));
      if (!el) throw new Error('no button ' + text);
      el.click();
    },
    text: () => document.body.innerText,
  };
`;
