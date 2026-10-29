// Reading two-factor QR codes from the camera or from an image (a screenshot
// of a setup page, say). Decoding is core/qr.js, on this device; frames and
// images are never stored, and the camera stops as soon as the dialog closes —
// including when the vault locks.

import { h, signal, onCleanup } from '../ui.js';
import { icon } from '../icons.js';
import { Button, DialogHeader, openDialog } from '../components.js';
import { scan } from '../../../core/qr.js';

export const cameraAvailable = () => typeof navigator !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

const NO_CODE = 'No QR code found in that image. Try a sharper screenshot, cropped to the code.';

/** Decodes the first QR code in an image file, trying a couple of sizes. Returns its text or null. */
export async function scanImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That file isn’t an image this browser can read'); }
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const longest = Math.max(bitmap.width, bitmap.height);
    for (const max of [2048, 1024, 640]) {
      if (max !== 2048 && max >= longest) continue;
      const k = Math.min(1, max / longest);
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      ctx.fillStyle = '#fff'; // transparent PNGs: dark modules on white
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const text = scan(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (text !== null) return text;
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

/** Opens the photo library / file picker. Resolves with the file, or null if cancelled. */
export function pickImage() {
  return new Promise((resolve) => {
    // Attached while open: some mobile browsers ignore clicks on detached inputs.
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const done = (file) => { input.remove(); resolve(file); };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Picks an image and reads its QR code. `accept(text)` returns null to take
 * it, or a message explaining why not. Resolves with the text, or null.
 */
export async function scanFromImage(accept, onError) {
  const file = await pickImage();
  if (!file) return null;
  try {
    const text = await scanImage(file);
    if (text === null) { onError(NO_CODE); return null; }
    const why = accept(text);
    if (why) { onError(why); return null; }
    return text;
  } catch (e) {
    onError(e.message);
    return null;
  }
}

function cameraError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'Camera access is turned off for rspm. Allow it in your browser or system settings, or use a screenshot instead.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No camera was found. Use a screenshot instead.';
  if (e?.name === 'NotReadableError') return 'The camera is in use by another app.';
  return `The camera couldn’t start: ${e?.message ?? e}`;
}

/** The camera viewfinder. Resolves with the accepted QR text, or null. */
export function scanWithCamera(accept) {
  return openDialog((close) => {
    const status = signal('Starting the camera…');
    const problem = signal(null);
    const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
    video.muted = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null, timer = 0, stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      for (const t of stream?.getTracks() ?? []) t.stop();
      stream = null;
      video.srcObject = null;
    };
    onCleanup(stop);

    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        // Frames are scaled to at most 960 px: plenty for a code that fills the frame, and fast.
        const k = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const text = scan(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (text !== null) {
          const why = accept(text);
          if (!why) { stop(); close(text); return; }
          problem.value = why;
        }
      }
      timer = setTimeout(tick, 100);
    };

    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    }).then((s) => {
      if (stopped) { for (const t of s.getTracks()) t.stop(); return; }
      stream = s;
      video.srcObject = s;
      video.play().catch(() => {});
      status.value = 'Point the camera at the QR code';
      tick();
    }, (e) => {
      status.value = null;
      problem.value = cameraError(e);
    });

    const fromImage = async () => {
      const text = await scanFromImage(accept, (msg) => { problem.value = msg; });
      if (text !== null) { stop(); close(text); }
    };

    return [
      DialogHeader({ title: 'Scan QR code', close: () => close(null) }),
      h('div', { class: 'dialog-body stack' },
        h('div', { class: 'scan-view' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' })),
        () => (problem.value
          ? h('p', { class: 'scan-status scan-problem', role: 'alert' }, icon('alert', 16), problem.value)
          : status.value ? h('p', { class: 'scan-status muted' }, status.value) : null)),
      h('footer', { class: 'dialog-footer' },
        Button({ label: 'Use a screenshot', icon: 'image', kind: 'ghost', onClick: fromImage }),
        Button({ label: 'Cancel', onClick: () => close(null) })),
    ];
  }, { label: 'Scan QR code' });
}
