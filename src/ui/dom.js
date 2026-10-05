// Tiny DOM helpers. No framework: views are functions that return Elements.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.panel.is-pink#id', { onclick, style: {...}, dataset: {...}, attrs }, ...children)
 * - tag may carry .classes and #id
 * - props: on* functions become listeners; `class`/`className` append classes;
 *   `style` object or string; `dataset` object; boolean false/null/undefined props are skipped;
 *   anything else is set as an attribute (or a property for value/checked/disabled/hidden/indeterminate).
 * - children: strings, numbers, Nodes, arrays (flattened), null/false (skipped).
 */
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props === 'string' || typeof props === 'number' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  const { name, id, classes } = parseTag(tag);
  const el = document.createElement(name);
  if (id) el.id = id;
  if (classes.length) el.classList.add(...classes);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** Same as h() but for SVG elements. */
export function s(tag, props, ...children) {
  const { name, id, classes } = parseTag(tag);
  const el = document.createElementNS(SVG_NS, name);
  if (id) el.setAttribute('id', id);
  if (classes.length) el.setAttribute('class', classes.join(' '));
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class' || k === 'className') el.setAttribute('class', [el.getAttribute('class'), v].filter(Boolean).join(' '));
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function parseTag(tag) {
  const m = String(tag).match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  const name = (m && m[1]) || 'div';
  let id = null;
  const classes = [];
  const rest = (m && m[2]) || '';
  for (const part of rest.match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '#') id = part.slice(1);
    else classes.push(part.slice(1));
  }
  return { name, id, classes };
}

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'indeterminate', 'selected', 'textContent', 'htmlFor', 'tabIndex']);

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) {
      if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = false;
      continue;
    }
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class' || k === 'className') {
      for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList.add(c);
    } else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined || sv === false) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
    } else if (PROP_KEYS.has(k)) {
      el[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// The focused element that mount() is swapping for a same-id twin, while the swap runs.
let replacing = null;

/** True while `el` is the focused field mount() is replacing with a twin of the same id. */
export function isReplacing(el) {
  return !!el && el === replacing;
}

function holdsId(node, id) {
  if (!node || typeof node !== 'object') return false;
  if (node.id === id) return true;
  for (const c of node.children ?? []) if (holdsId(c, id)) return true;
  return false;
}

/**
 * Replace all children of `el` with `nodes`.
 * Chromium fires `change` and `blur` on a focused field while it is being removed.
 * When the new nodes carry a field with the same id (a re-render, not a close),
 * those events are not the user leaving the field: handlers check isReplacing()
 * and skip committing, because the twin already shows the draft and gets focus back.
 */
export function mount(el, ...nodes) {
  const list = nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
  let active = null;
  try { active = typeof document !== 'undefined' ? document.activeElement : null; } catch { active = null; }
  const prev = replacing;
  if (active && active !== el && active.id && typeof el.contains === 'function' && el.contains(active) && list.some((n) => holdsId(n, active.id))) {
    replacing = active;
  }
  try {
    el.replaceChildren(...list);
  } finally {
    replacing = prev;
  }
  return el;
}

/** Inputs typed segment by segment (mm/dd/yyyy, hh:mm): rebuilding one mid-typing resets the segment caret. */
export function isSegmented(el) {
  if (!el || String(el.localName || el.tagName || '').toLowerCase() !== 'input') return false;
  return /^(date|time|datetime-local|month|week)$/.test(String(el.type || ''));
}

/** A typed date worth saving: '' (cleared) unless `required`, else a real YYYY-MM-DD in 1900..2199. */
export function isSaneDate(v, { required = false } = {}) {
  const s = String(v ?? '');
  if (!s) return !required;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2199 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Inline style variables for a category color: { '--c': '#89b7ff' } */
export function catStyle(cat) {
  return { '--c': cat?.color ?? '#7a776f' };
}

/** A category mark element (colored square patch with its glyph). */
export function catMark(cat, title) {
  return h('span.catmark', { style: catStyle(cat), title: title ?? cat?.name ?? '', 'aria-hidden': 'true' }, cat?.glyph ?? '··');
}

/** Drag payload helpers shared by every draggable task/block. */
export const DRAG_MIME = 'application/x-ef-item';
export function setDragData(ev, payload) {
  const json = JSON.stringify(payload);
  ev.dataTransfer.setData(DRAG_MIME, json);
  ev.dataTransfer.setData('text/plain', json);
  ev.dataTransfer.effectAllowed = 'move';
}
export function getDragData(ev) {
  const raw = ev.dataTransfer.getData(DRAG_MIME) || ev.dataTransfer.getData('text/plain');
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && v.taskId ? v : null;
  } catch {
    return null;
  }
}

export function safeStorage() {
  const get = (k) => { try { return window.localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { window.localStorage.setItem(k, v); return true; } catch { return false; } };
  const del = (k) => { try { window.localStorage.removeItem(k); } catch { /* ignore */ } };
  return { get, set, del };
}

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
