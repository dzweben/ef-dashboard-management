// A tiny DOM for UI tests in plain Node (no jsdom: the repo has no deps).
// Covers what src/ui/dom.js and the views use: elements, text, attributes,
// classList, dataset, style, events (via Node's EventTarget), simple selectors.
// Focus follows Chromium: focus()/blur() also fire `focusout` on the document, and
// removing a subtree that holds the focused field fires that field's `change` (when
// its value moved since focus) and `blur` while it is still attached, like Chrome does.
// Import it before any src/ui module: `import { installDom } from './fixtures/ui-dom.js'; installDom();`

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

class FakeNode extends EventTarget {
  constructor() {
    super();
    this.parentNode = null;
    this.childNodes = [];
  }
  get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get isConnected() {
    let n = this;
    while (n) {
      if (n === globalThis.document) return true;
      n = n.parentNode;
    }
    return false;
  }
  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    loseFocusInside(child);
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? globalThis.document.createTextNode(n) : n);
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === 'string' ? globalThis.document.createTextNode(n) : n, first);
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(globalThis.document.createTextNode(String(v ?? ''))); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

/** Chromium: a focused field inside a removed subtree reports change + blur, then focus goes to body. */
function loseFocusInside(node) {
  const d = globalThis.document;
  const a = d?.activeElement;
  if (!a || a === d.body || !(node instanceof FakeNode) || !node.contains(a)) return;
  if (a._focusValue !== undefined && a.value !== a._focusValue) {
    a._focusValue = a.value;
    a.dispatchEvent(new Event('change'));
  }
  if (d.activeElement !== a) return; // a handler moved focus already
  a.dispatchEvent(new Event('blur'));
  d.dispatchEvent(new Event('focusout'));
  d.activeElement = d.body;
}

class FakeText extends FakeNode {
  constructor(text) { super(); this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FakeFragment extends FakeNode {}

class ClassList {
  constructor(el) { this.el = el; }
  get list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set(list) { this.el.setAttribute('class', [...new Set(list)].join(' ')); }
  add(...cs) { this.set([...this.list, ...cs]); }
  remove(...cs) { this.set(this.list.filter((c) => !cs.includes(c))); }
  contains(c) { return this.list.includes(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
  get length() { return this.list.length; }
}

function makeStyle() {
  const props = {};
  return new Proxy(props, {
    get(t, k) {
      if (k === 'setProperty') return (name, v) => { t[name] = String(v); };
      if (k === 'getPropertyValue') return (name) => t[name] ?? '';
      if (k === 'removeProperty') return (name) => { delete t[name]; };
      return t[k] ?? '';
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

class FakeElement extends FakeNode {
  constructor(name, ns = null) {
    super();
    this.localName = String(name).toLowerCase();
    this.tagName = ns ? this.localName : this.localName.toUpperCase();
    this.namespaceURI = ns;
    this.attrs = new Map();
    this.classList = new ClassList(this);
    this.style = makeStyle();
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.tabIndex = -1;
    const el = this;
    this.dataset = new Proxy({}, {
      get(t, k) { return typeof k === 'string' ? el.getAttribute(`data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`) ?? undefined : undefined; },
      set(t, k, v) { el.setAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, String(v)); return true; },
      has(t, k) { return el.hasAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`); },
    });
  }
  get value() {
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.selected) ?? opts[0];
      return sel ? sel.value : '';
    }
    if (this.localName === 'option' && !this.hasAttribute('value') && !this._valueSet) return this.textContent;
    return this._value;
  }
  set value(v) {
    if (this.localName === 'select') {
      for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v);
      return;
    }
    this._valueSet = true;
    this._value = String(v ?? '');
    this.selectionStart = this.selectionEnd = this._value.length;
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get type() { return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : ''); }
  setAttribute(k, v) {
    this.attrs.set(String(k), String(v));
    if (k === 'value' && this.localName === 'option') { this._value = String(v); this._valueSet = true; }
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  matches(sel) { return matches(this, sel, null); }
  closest(sel) {
    let n = this;
    while (n instanceof FakeElement) {
      if (n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  focus() {
    const d = globalThis.document;
    const prev = d.activeElement;
    if (prev === this) return;
    d.activeElement = this;
    if (prev && prev !== d.body) {
      prev.dispatchEvent(new Event('blur'));
      d.dispatchEvent(new Event('focusout'));
    }
    this._focusValue = this.value;
    this.dispatchEvent(new Event('focus'));
  }
  blur() {
    const d = globalThis.document;
    if (d.activeElement === this) {
      d.activeElement = d.body;
      this.dispatchEvent(new Event('blur'));
      d.dispatchEvent(new Event('focusout'));
    }
  }
  select() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  click() {
    if (this.disabled) return;
    if (this.localName === 'input' && (this.type === 'checkbox')) {
      this.checked = !this.checked;
      this.dispatchEvent(new Event('click'));
      this.dispatchEvent(new Event('change'));
      return;
    }
    const ev = new Event('click', { bubbles: true });
    this.dispatchEvent(ev);
    if (this.localName === 'button' && this.getAttribute('type') === 'submit') {
      const form = this.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }
  getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 40, right: 310, bottom: 60, x: 10, y: 20 }; }
  get offsetWidth() { return 300; }
  animate() { return { cancel() {}, finished: Promise.resolve() }; }
  get outerHTML() {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    return `<${this.localName}${attrs}>${this.childNodes.map((c) => (c instanceof FakeText ? c.data : c.outerHTML)).join('')}</${this.localName}>`;
  }
}

// ---- selectors: comma lists, descendant combinator, tag/.class/#id/[attr]/[attr="v"]/:not(x)
function parseCompound(s) {
  const out = { tag: null, classes: [], id: null, attrs: [], nots: [] };
  let rest = s;
  const tag = rest.match(/^[a-zA-Z][\w-]*|^\*/);
  if (tag) { out.tag = tag[0] === '*' ? null : tag[0].toLowerCase(); rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = rest.match(/^\.([\w-]+)/))) out.classes.push(m[1]);
    else if ((m = rest.match(/^#([\w-]+)/))) out.id = m[1];
    else if ((m = rest.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/))) out.attrs.push([m[1], m[2]]);
    else if ((m = rest.match(/^:not\(([^)]*)\)/))) out.nots.push(m[1]);
    else throw new Error(`ui-dom: unsupported selector part "${rest}" in "${s}"`);
    rest = rest.slice(m[0].length);
  }
  return out;
}
function matchCompound(el, c) {
  if (!(el instanceof FakeElement)) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [k, v] of c.attrs) {
    if (!el.hasAttribute(k) && !(k === 'type' && el.localName === 'input')) return false;
    if (v !== undefined && (k === 'type' ? el.type : el.getAttribute(k)) !== v) return false;
  }
  for (const n of c.nots) if (matches(el, n, null)) return false;
  return true;
}
function matches(el, sel, scope) {
  return String(sel).split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node && !matchCompound(node, chain[i])) {
        if (node === scope) return false;
        node = node.parentNode;
      }
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class FakeDocument extends FakeNode {
  constructor() {
    super();
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.readyState = 'complete';
  }
  createElement(name) { return new FakeElement(name); }
  createElementNS(ns, name) { return new FakeElement(name, ns); }
  createTextNode(t) { return new FakeText(t); }
  createDocumentFragment() { return new FakeFragment(); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

/** Install globals (document, window, Node, matchMedia, rAF). Returns { document, window, reset, media }. */
export function installDom({ reducedMotion = false, finePointer = true } = {}) {
  const document = new FakeDocument();
  const media = { reducedMotion, finePointer };
  const listeners = new EventTarget();
  const store = new Map();
  const window = {
    document,
    matchMedia: (q) => ({
      matches: /prefers-reduced-motion/.test(q) ? media.reducedMotion : /pointer:\s*fine|hover:\s*hover/.test(q) ? media.finePointer : false,
      addEventListener() {}, removeEventListener() {},
    }),
    addEventListener: listeners.addEventListener.bind(listeners),
    removeEventListener: listeners.removeEventListener.bind(listeners),
    dispatchEvent: listeners.dispatchEvent.bind(listeners),
    scrollTo() {},
    scrollY: 0,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { hash: '' },
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.history = { replaceState() {} };
  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.matchMedia = window.matchMedia;
  return {
    document,
    window,
    media,
    reset() {
      document.body.replaceChildren();
      document.activeElement = document.body;
    },
  };
}

/** The page skeleton main.js boots into (src/ui/template.html's ids). */
export function mountAppShell(document) {
  document.body.replaceChildren();
  for (const [tag, id] of [['header', 'ef-header'], ['nav', 'ef-tabs'], ['main', 'ef-main'], ['div', 'ef-overlay'], ['div', 'ef-toasts']]) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.appendChild(el);
  }
  return {
    header: document.getElementById('ef-header'),
    tabs: document.getElementById('ef-tabs'),
    main: document.getElementById('ef-main'),
    overlay: document.getElementById('ef-overlay'),
    toasts: document.getElementById('ef-toasts'),
  };
}

/** Collect the visible text of an element, whitespace-collapsed. */
export function text(el) {
  return String(el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Text of every text node joined with spaces (so adjacent spans don't run together). */
export function words(el) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n instanceof FakeText) out.push(n.data);
    else for (const c of n.childNodes ?? []) walk(c);
  };
  walk(el);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Fire a DOM-ish event on an element. */
export function fire(el, type, init = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, init);
  el.dispatchEvent(ev);
  return ev;
}
