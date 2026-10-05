// The check-off moment: square confetti that bursts from the checkbox and a
// rubber stamp that thunks onto the row. Both live in document.body (fixed
// position) so they survive the re-render that follows the state change.
import { prefersReducedMotion } from '../dom.js';

const BITS = 14;
const DURATION = 620;
const ACCENTS = ['var(--pink)', 'var(--cyan)', 'var(--ink)'];

function anchorRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const target = (el.matches && el.matches('input, .check') ? el : el.querySelector?.('.check, input[type="checkbox"]')) || el;
  const r = target.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return r;
}

/**
 * ~14 small squares (4–7px) fly out of the element's checkbox, fall with
 * gravity, fade, and are removed after ~600ms. No-op under reduced motion.
 */
export function burst(el, color = 'var(--acid)') {
  try {
    if (prefersReducedMotion() || typeof document === 'undefined') return;
    const r = anchorRect(el);
    if (!r) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < BITS; i++) {
      const bit = document.createElement('i');
      bit.className = 'fx-bit';
      const size = 4 + Math.floor(Math.random() * 4);
      const accent = i % 5 === 4 ? ACCENTS[i % ACCENTS.length] : color;
      bit.style.width = `${size}px`;
      bit.style.height = `${size}px`;
      bit.style.left = `${cx - size / 2}px`;
      bit.style.top = `${cy - size / 2}px`;
      bit.style.background = accent;
      layer.appendChild(bit);
      // ballistic path: biased up and to the right, gravity pulls it down
      const angle = (-Math.PI / 2) + (Math.random() - 0.35) * Math.PI * 1.1;
      const speed = 70 + Math.random() * 110;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const g = 420;
      const spin = (Math.random() - 0.5) * 540;
      const frames = [];
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * (DURATION / 1000);
        const x = vx * t;
        const y = vy * t + 0.5 * g * t * t;
        frames.push({
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(spin * (k / steps)).toFixed(0)}deg) scale(${(1 - 0.35 * (k / steps)).toFixed(2)})`,
          opacity: k < steps - 2 ? 1 : k === steps ? 0 : 0.6,
        });
      }
      if (typeof bit.animate === 'function') {
        bit.animate(frames, { duration: DURATION, easing: 'linear', fill: 'forwards' });
      } else {
        bit.style.transform = frames[steps].transform;
        bit.style.opacity = '0';
      }
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), DURATION + 80);
  } catch {
    /* decoration only: never break a check-off */
  }
}

/**
 * A rotated (−8°) bordered stamp with `text` in stencil type, centered on the
 * element. Scales 1.6 → 1 with a thunk, holds ~700ms, fades, removes itself.
 * Under reduced motion it simply appears and disappears.
 */
export function stamp(el, text = 'DONE', opts = {}) {
  try {
    if (typeof document === 'undefined' || !el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return;
    const tone = opts && opts.tone === 'pink' ? 'is-pink' : opts && opts.tone === 'cyan' ? 'is-cyan' : '';
    const node = document.createElement('div');
    node.className = `fx-stamp ${tone}`.trim();
    node.setAttribute('aria-hidden', 'true');
    node.textContent = String(text ?? 'DONE');
    // centered over the title area (a bit right of the row's left edge)
    const x = r.left + Math.min(r.width * 0.5, Math.max(120, r.width * 0.38));
    const y = r.top + r.height / 2;
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    if (prefersReducedMotion()) node.classList.add('is-static');
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 1050);
  } catch {
    /* decoration only */
  }
}
