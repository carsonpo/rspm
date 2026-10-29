// Printable Emergency Kit.

import { h } from './ui.js';

export function printKit({ username, accountKey }) {
  const kit = h('section', { class: 'print-kit' },
    h('h1', null, 'rspm Emergency Kit'),
    h('p', null, 'Keep this somewhere safe and separate from your password — a drawer at home, a safe, a sealed envelope. Anyone who has this page and your password can open your vault. Without it, no one — including you — can open your vault on a new device.'),
    h('dl', null,
      h('dt', null, 'Sign-in address'), h('dd', null, location.origin === 'null' ? 'https://rspm.me' : location.origin),
      h('dt', null, 'Username'), h('dd', null, username || '______________________________'),
      h('dt', null, 'Password'), h('dd', { class: 'blank' }, 'Write it here only if this page is stored securely: ______________________________'),
      h('dt', null, 'Account Key'), h('dd', { class: 'key' }, accountKey)),
    h('p', { class: 'small' }, 'There is no password reset. If you lose your username, password or Account Key, your data cannot be recovered by anyone.'));
  document.body.appendChild(kit);
  const done = () => { kit.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 60000);
}

export function kitText({ username, accountKey }) {
  return [
    'rspm Emergency Kit',
    '',
    'Keep this separate from your password. There is no password reset: if you lose',
    'your username, password or Account Key, your data cannot be recovered.',
    '',
    `Username:    ${username}`,
    `Account Key: ${accountKey}`,
    '',
  ].join('\n');
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { download: filename });
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
