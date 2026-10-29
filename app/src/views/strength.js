// Password strength meter.

import { h } from '../ui.js';
import { estimateBits, strengthLabel } from '../generator.js';

export const strongEnough = (pw) => pw.length >= 10 && estimateBits(pw) >= 35;

export function StrengthMeter({ value }) {
  return h('span', { class: 'strength' },
    h('span', { class: 'strength-bars', 'aria-hidden': 'true' },
      [0, 1, 2, 3].map((i) => h('span', { class: () => ['strength-bar', value() && strengthLabel(estimateBits(value())).level >= i && `is-on level-${strengthLabel(estimateBits(value())).level}`] }))),
    h('span', { class: 'strength-label' }, () => {
      const v = value();
      if (!v) return 'At least 10 characters. A few random words work well.';
      const bits = estimateBits(v);
      const { label } = strengthLabel(bits);
      return `${label} · about ${bits} bits${v.length < 10 ? ' · use at least 10 characters' : ''}`;
    }));
}
