// What the service worker reports about the running build.

import { signal } from './ui.js';

/** SHA-256 (hex) of the HTML this page was served from, when known. */
export const buildHash = signal(null);
/** { hash } of a newer build waiting to be applied. */
export const pendingUpdate = signal(null);
