// Cloudflare entry point. All logic lives in handler.js.

import { handle, expire } from './handler.js';
import tagModule from '../../wasm/tag.wasm';

const tagFn = new WebAssembly.Instance(tagModule).exports.tag;
const tag = (window) => (tagFn(window) >>> 0).toString(16).padStart(8, '0');

const deps = {
  async verifyTag(header, now) {
    const w = Math.floor(now / 30);
    return header === tag(w) || header === tag(w - 1);
  },
};

export default {
  fetch: (request, env) => handle(request, env, deps),
  scheduled: (_event, env, ctx) => ctx.waitUntil(expire(env)),
};
