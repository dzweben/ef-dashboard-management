// EF Console boot: picks a store, owns app state, renders views, dispatches ops.
import { h, mount, safeStorage, isSegmented } from './dom.js';
import { todayISO, nowISO } from '../engine/dates.js';
import { OPS } from '../engine/ops.js';
import { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } from '../engine/views.js';
import { risks } from '../engine/schedule.js';
import { streak, weekStats, heatmap, wins } from '../engine/stats.js';
import { normalizeState, emptyState, INBOX_CATEGORY } from '../engine/model.js';
import { createGitHubStore } from '../store/githubstore.js';
import { createLocalStore } from '../store/localstore.js';
import { mountHeader } from './views/header.js';
import { renderOverview } from './views/overview.js';
import { renderCalendar } from './views/calendar.js';
import { renderProjects } from './views/projects.js';
import { renderWins } from './views/wins.js';
import { renderAll } from './views/all.js';
import { renderSetup } from './views/setup.js';
import { renderDrawer, renderMoveSheet, renderClockSheet } from './views/drawer.js';
import { burst, stamp } from './fx/burst.js';
import { icon } from './icons.js';

const storage = safeStorage();

export const DEFAULT_CONFIG = Object.freeze({
  owner: 'dzweben',
  repo: 'ef-dashboard-management',
  branch: '', // '' = the repo's default branch
  path: 'data/state.json',
  // Author + committer of every website commit (GitHub's noreply address, never a personal email).
  author: Object.freeze({ name: 'Danny Zweben', email: '176344411+dzweben@users.noreply.github.com' }),
});

/** Statuses that mean the store is talking to its backend fine. */
const HEALTHY = new Set(['synced', 'saving', 'pending']);
/** After pointerup with no click (drag-select, a press that slid off), how long renders stay held. */
const POINTER_RELEASE_MS = 400;
/** A held pointer never blocks renders longer than this. */
const POINTER_HOLD_MAX_MS = 5000;

export const TABS = [
  { id: 'overview', label: 'Today', icon: 'bolt' },
  { id: 'calendar', label: '14 days', icon: 'calendar' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'wins', label: 'Wins', icon: 'trophy' },
  { id: 'all', label: 'All', icon: 'list' },
  { id: 'setup', label: 'Setup', icon: 'settings' },
];

const VIEWS = {
  overview: renderOverview,
  calendar: (ctx) => renderCalendar(ctx, { days: 14 }),
  projects: (ctx) => renderProjects(ctx, {}),
  wins: (ctx) => renderWins(ctx, {}),
  all: renderAll,
  setup: renderSetup,
};

const CONFIG_KEYS = ['owner', 'repo', 'branch', 'path'];

/** owner/repo/branch/path from `cfg` over the defaults; author always comes from DEFAULT_CONFIG. */
function pickConfig(cfg) {
  const out = { ...DEFAULT_CONFIG };
  if (cfg && typeof cfg === 'object') {
    for (const k of CONFIG_KEYS) if (typeof cfg[k] === 'string') out[k] = cfg[k];
  }
  return out;
}

function readConfig() {
  try {
    const raw = storage.get('ef.gh.config');
    return pickConfig(raw ? JSON.parse(raw) : {});
  } catch {
    return pickConfig({});
  }
}

function tabFromHash() {
  const t = (location.hash || '').replace(/^#/, '');
  return TABS.some((x) => x.id === t) ? t : 'overview';
}

/**
 * Mount the app into `root` (a document). `opts.createStore(storeOptions)` swaps in a
 * store (tests); by default the preview seed picks the local store, else GitHub with
 * storeOptions = { owner, repo, branch, path, author, token }.
 * Returns the app object; `app.dispose()` removes timers and listeners.
 */
export function boot(root = document, opts = {}) {
  const els = {
    header: root.getElementById('ef-header'),
    tabs: root.getElementById('ef-tabs'),
    main: root.getElementById('ef-main'),
    overlay: root.getElementById('ef-overlay'),
    toasts: root.getElementById('ef-toasts'),
  };

  const app = {
    state: emptyState(),
    loaded: false, // the current store has delivered real state at least once
    loadFailed: false, // the current store's first load failed (cleared once it reports healthy)
    config: readConfig(),
    token: storage.get('ef.gh.token') || '',
    store: null,
    status: { kind: 'loading', at: null, message: 'Loading…' },
    ui: { tab: tabFromHash(), drawer: null, move: null, clockSheet: null, filters: {}, flash: null },
    renderQueued: false,
    renderHeld: false, // a render was skipped while the pointer was down
    pointerHold: false,
    holdTimer: null,
    focusHeld: false, // a view/overlay kept its DOM because a date/time field in it is being typed in
    renderedTab: null,
    header: null,
    unsub: null,
    unstatus: null,
  };

  // ---------- store ----------
  function defaultStore(storeOptions) {
    const preview = window.__EF_PREVIEW__;
    if (preview) return createLocalStore(normalizeState(preview), { key: 'ef.preview.v1' });
    return createGitHubStore(storeOptions);
  }

  function pickStore() {
    if (app.unsub) app.unsub();
    if (app.unstatus) app.unstatus();
    app.unsub = app.unstatus = null;
    if (app.store && app.store.dispose) app.store.dispose();
    // A new store (new token / repo) starts unloaded: nothing may be written until
    // it has delivered real state, or writes would be computed against a stale/empty board.
    app.loaded = false;
    app.loadFailed = false;
    app.status = { kind: 'loading', at: null, message: 'Loading…' };
    const storeOptions = { ...app.config, author: { ...DEFAULT_CONFIG.author }, token: app.token || null };
    const store = typeof opts.createStore === 'function' ? opts.createStore(storeOptions) : defaultStore(storeOptions);
    app.store = store;
    const current = () => app.store === store;
    app.unsub = store.subscribe((state) => {
      if (!current() || !state) return;
      app.state = state;
      app.loaded = true;
      schedule();
    });
    if (store.onStatus) {
      const off = store.onStatus((st) => {
        if (!current() || !st) return;
        app.status = st;
        if (HEALTHY.has(st.kind)) app.loadFailed = false;
        schedule();
      });
      app.unstatus = typeof off === 'function' ? off : null;
    }
    let loading;
    try {
      loading = Promise.resolve(store.load());
    } catch (err) {
      loading = Promise.reject(err);
    }
    loading.then(
      () => {
        if (!current()) return;
        // e.g. a rejected token with a read-only fallback: the board shows, writes stay off
        if (app.status.kind === 'error') app.loadFailed = true;
        schedule();
      },
      (err) => {
        if (!current()) return;
        app.loadFailed = true;
        if (app.status.kind === 'loading') app.status = { kind: 'error', at: nowISO(), message: err?.message || String(err) };
        schedule();
      },
    );
  }

  /** Why writes are refused right now (still loading / the first load failed), or null. */
  function notReadyReason() {
    const st = app.status ?? {};
    const why = (st.kind === 'error' || st.kind === 'offline') && st.message ? ` ${st.message}` : '';
    if (!app.loaded) return `Still loading your board…${why}`;
    if (app.loadFailed && st.kind === 'error') return `Still loading your board…${why || ' GitHub load failed.'}`;
    // The store's own answer: a read-only fallback copy (after a rejected token) is
    // on screen but was never loaded through the API, so it is not a base to write on.
    if (typeof app.store?.isLoaded === 'function' && app.store.isLoaded() === false) return `Still loading your board…${why || ' GitHub load failed.'}`;
    return null;
  }

  // ---------- context passed to every view ----------
  function buildCtx() {
    const state = app.state;
    const tz = state.settings?.tz || 'America/New_York';
    const today = todayISO(tz);
    const now = nowISO();
    const cat = (id) => state.cats?.[id] ?? state.cats?.inbox ?? INBOX_CATEGORY;
    const vm = memoVm(state, today);
    const canWrite = !!app.store && app.store.mode !== 'readonly';
    return {
      state, today, now, tz, vm, cat, cats: state.cats,
      ui: app.ui,
      loaded: app.loaded,
      store: { mode: app.store?.mode ?? 'readonly', status: app.status, canWrite, refresh: () => app.store?.refresh?.() },
      config: app.config,
      hasToken: !!app.token,
      act, setUI, setTab, rerender: schedule,
      // every overlay change disarms the drawer's "Really delete?"
      openTask: (id) => setUI({ drawer: { taskId: id }, move: null, clockSheet: null, drawerConfirm: null }),
      openMove: (taskId, blockId = null) => setUI({ move: { taskId, blockId }, drawer: null, clockSheet: null, drawerConfirm: null }),
      openClock: (ref = null) => setUI({ clockSheet: { ref }, drawer: null, move: null, drawerConfirm: null }),
      closeOverlay,
      toast,
      fx: { burst, stamp },
      icon,
      setToken, clearToken, saveConfig,
    };
  }

  let vmCache = { state: null, today: null, vm: null };
  function memoVm(state, today) {
    if (vmCache.state === state && vmCache.today === today) return vmCache.vm;
    const vm = {
      today: todayView(state, today),
      cal: calendarView(state, today, 14, today),
      deadlines: upcomingDeadlines(state, today, 30),
      backlog: backlog(state),
      projects: projectView(state, today),
      chores: choreView(state, today),
      risks: risks(state, today),
      streak: streak(state, today),
      week: weekStats(state, today),
      heatmap: heatmap(state, today, 12),
      wins: wins(state, {}),
    };
    vmCache = { state, today, vm };
    return vm;
  }

  // ---------- actions ----------
  /** Run an op by name. Returns { writes } or null. Never throws to the caller. */
  async function act(name, args = {}, opts = {}) {
    const fn = OPS[name];
    if (!fn) {
      toast(`Unknown action: ${name}`, { kind: 'error' });
      return null;
    }
    if (!app.store || app.store.mode === 'readonly') {
      toast('Read-only. Connect GitHub in Setup to save changes.', { kind: 'error', action: { label: 'Setup', fn: () => setTab('setup') } });
      return null;
    }
    const notReady = notReadyReason();
    if (notReady) {
      toast(notReady, { kind: 'error', action: app.status?.kind === 'error' ? { label: 'Setup', fn: () => setTab('setup') } : null });
      return null;
    }
    const tz = app.state.settings?.tz || 'America/New_York';
    const ctx = { now: nowISO(), today: todayISO(tz), src: 'dash' };
    let res;
    try {
      res = fn(app.state, args, ctx);
    } catch (err) {
      console.error(err);
      toast(`That didn't work: ${err?.message || err}`, { kind: 'error' });
      return null;
    }
    if (!res || !res.writes || res.writes.length === 0) return res;
    try {
      await app.store.apply(res.writes, res.activity ?? []);
    } catch (err) {
      console.error(err);
      // the store refused because it has no loaded base yet: its message is already user-ready
      if (err?.code === 'not_loaded') toast(err.message || 'Still loading your board…', { kind: 'error', action: app.status?.kind === 'error' ? { label: 'Setup', fn: () => setTab('setup') } : null });
      else toast(`Couldn't save: ${err?.message || err}`, { kind: 'error' });
      return null;
    }
    if (opts.toast) toast(opts.toast, { kind: opts.kind ?? 'good', action: opts.undo ? { label: 'Undo', fn: opts.undo } : null });
    return res;
  }

  function setUI(patch) {
    app.ui = { ...app.ui, ...patch };
    schedule();
  }

  function closeOverlay() {
    setUI({ drawer: null, move: null, clockSheet: null, drawerConfirm: null });
  }

  function setTab(tab) {
    if (!TABS.some((t) => t.id === tab)) return;
    app.ui = { ...app.ui, tab };
    try { history.replaceState(null, '', `#${tab}`); } catch { /* sandboxed */ }
    schedule();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function setToken(token) {
    app.token = String(token || '').trim();
    if (app.token) storage.set('ef.gh.token', app.token);
    else storage.del('ef.gh.token');
    pickStore();
  }
  function clearToken() { setToken(''); }
  function saveConfig(cfg) {
    app.config = pickConfig(cfg);
    const saved = {};
    for (const k of CONFIG_KEYS) saved[k] = app.config[k];
    storage.set('ef.gh.config', JSON.stringify(saved));
    pickStore();
  }

  // ---------- toasts ----------
  const toastTimers = new Set();
  function toast(message, { kind = 'info', action = null, ms = 4200 } = {}) {
    const el = h('div.toast', { class: kind === 'error' ? 'is-error' : kind === 'good' ? 'is-good' : '', role: 'status' },
      h('span', message),
      action ? h('button.btn.btn-sm', { type: 'button', onclick: () => { el.remove(); action.fn(); } }, action.label) : null,
    );
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
    const t = setTimeout(() => {
      toastTimers.delete(t);
      el.remove();
    }, ms);
    toastTimers.add(t);
  }

  // ---------- render ----------
  function schedule() {
    if (app.renderQueued || app.disposed) return;
    app.renderQueued = true;
    requestAnimationFrame(() => {
      app.renderQueued = false;
      if (app.disposed) return;
      // Never swap the element under a pressed pointer: a blur-commit on mousedown
      // would otherwise re-render before mouseup and the click would be lost.
      if (app.pointerHold) {
        app.renderHeld = true;
        return;
      }
      render();
    });
  }

  // pointer gate: hold renders from pointerdown until the click has been handled
  function holdRenders() {
    app.pointerHold = true;
    clearTimeout(app.holdTimer);
    app.holdTimer = setTimeout(releaseRenders, POINTER_HOLD_MAX_MS);
  }
  function releaseSoon(ms) {
    if (!app.pointerHold) return;
    clearTimeout(app.holdTimer);
    app.holdTimer = setTimeout(releaseRenders, ms);
  }
  function releaseRenders() {
    clearTimeout(app.holdTimer);
    app.holdTimer = null;
    if (!app.pointerHold) return;
    app.pointerHold = false;
    if (app.renderHeld) {
      app.renderHeld = false;
      schedule();
    }
  }

  /** A date/time field inside `container` has focus (typing it segment by segment). */
  function typingSegmented(container) {
    const a = document.activeElement;
    return !!a && a !== container && typeof container.contains === 'function' && container.contains(a) && isSegmented(a);
  }

  function renderTabs(ctx) {
    return h('div.tabs', { role: 'tablist', 'aria-label': 'Views' },
      TABS.map((t) => h('button.tab', {
        type: 'button', role: 'tab',
        'aria-selected': String(ctx.ui.tab === t.id),
        class: ctx.ui.tab === t.id ? 'is-active' : '',
        onclick: () => setTab(t.id),
      }, icon(t.icon), h('span', t.label))),
    );
  }

  function render() {
    const ctx = buildCtx();
    if (!app.header) app.header = mountHeader(els.header, ctx);
    app.header.update(ctx);
    mount(els.tabs, renderTabs(ctx));
    // A date/time field being typed in keeps its DOM until it loses focus: rebuilding
    // it resets the segment caret, so the next digits land in the month.
    if (app.renderedTab === ctx.ui.tab && typingSegmented(els.main)) {
      app.focusHeld = true;
    } else {
      const view = VIEWS[ctx.ui.tab] ?? VIEWS.overview;
      let node;
      try {
        node = view(ctx);
      } catch (err) {
        console.error(err);
        node = h('div.panel', h('div.panel-body', h('p', `This view crashed: ${err?.message || err}`)));
      }
      const y = window.scrollY;
      mount(els.main, node);
      app.renderedTab = ctx.ui.tab;
      if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
    }
    let overlay = null;
    try {
      if (ctx.ui.drawer) overlay = renderDrawer(ctx);
      else if (ctx.ui.move) overlay = renderMoveSheet(ctx);
      else if (ctx.ui.clockSheet) overlay = renderClockSheet(ctx);
    } catch (err) {
      console.error(err);
    }
    els.toasts.classList.toggle('is-beside-sheet', !!overlay && overlay.classList.contains('is-side'));
    if (overlay) {
      const shown = els.overlay.firstChild;
      const sameSheet = !!shown && shown.dataset?.key != null && shown.dataset.key === overlay.dataset?.key;
      if (sameSheet && typingSegmented(els.overlay)) app.focusHeld = true;
      else if (shown !== overlay) mount(els.overlay, overlay);
      els.overlay.hidden = false;
    } else {
      els.overlay.replaceChildren();
      els.overlay.hidden = true;
    }
  }

  // ---------- global listeners ----------
  const listeners = [];
  const listen = (target, type, fn, capture = false) => {
    target.addEventListener(type, fn, capture);
    listeners.push(() => target.removeEventListener(type, fn, capture));
  };
  listen(window, 'hashchange', () => setTab(tabFromHash()));
  listen(document, 'keydown', (e) => {
    if (e.key === 'Escape' && (app.ui.drawer || app.ui.move || app.ui.clockSheet)) closeOverlay();
  });
  listen(document, 'pointerdown', holdRenders, true);
  listen(document, 'pointerup', () => releaseSoon(POINTER_RELEASE_MS), true);
  listen(document, 'pointercancel', releaseRenders, true);
  listen(document, 'dragstart', releaseRenders, true);
  listen(document, 'click', () => releaseSoon(0), true); // after this click's own handlers
  listen(window, 'blur', releaseRenders);
  listen(document, 'focusout', () => {
    if (!app.focusHeld) return;
    app.focusHeld = false;
    schedule(); // re-checks focus on the next frame, after it has moved
  }, true);
  // tick: keeps the clock widget, "today", and relative times fresh
  const timers = [
    setInterval(() => app.header && app.header.tick && app.header.tick(buildCtx()), 1000),
    setInterval(schedule, 60 * 1000),
  ];

  app.act = act;
  app.buildCtx = buildCtx;
  app.dispose = () => {
    app.disposed = true;
    for (const t of timers) clearInterval(t);
    for (const t of toastTimers) clearTimeout(t);
    clearTimeout(app.holdTimer);
    for (const off of listeners.splice(0)) off();
    if (app.unsub) app.unsub();
    if (app.unstatus) app.unstatus();
    if (app.store && app.store.dispose) app.store.dispose();
  };

  pickStore();
  schedule();
  return app;
}

if (typeof window !== 'undefined' && !window.__EF_NO_BOOT__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot());
  else boot();
}
