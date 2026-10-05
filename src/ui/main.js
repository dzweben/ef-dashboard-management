// EF Console boot: picks a store, owns app state, renders views, dispatches ops.
import { h, mount, safeStorage } from './dom.js';
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
});

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

function readConfig() {
  try {
    const raw = storage.get('ef.gh.config');
    const cfg = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function tabFromHash() {
  const t = (location.hash || '').replace(/^#/, '');
  return TABS.some((x) => x.id === t) ? t : 'overview';
}

export function boot(root = document) {
  const els = {
    header: root.getElementById('ef-header'),
    tabs: root.getElementById('ef-tabs'),
    main: root.getElementById('ef-main'),
    overlay: root.getElementById('ef-overlay'),
    toasts: root.getElementById('ef-toasts'),
  };

  const app = {
    state: emptyState(),
    loaded: false,
    config: readConfig(),
    token: storage.get('ef.gh.token') || '',
    store: null,
    status: { kind: 'loading', at: null, message: 'Loading…' },
    ui: { tab: tabFromHash(), drawer: null, move: null, clockSheet: null, filters: {}, flash: null },
    renderQueued: false,
    header: null,
    unsub: null,
  };

  // ---------- store ----------
  function pickStore() {
    if (app.unsub) app.unsub();
    if (app.store && app.store.dispose) app.store.dispose();
    const preview = window.__EF_PREVIEW__;
    if (preview) {
      app.store = createLocalStore(normalizeState(preview), { key: 'ef.preview.v1' });
    } else {
      app.store = createGitHubStore({ ...app.config, token: app.token || null });
    }
    app.unsub = app.store.subscribe((state) => {
      app.state = state;
      app.loaded = true;
      schedule();
    });
    if (app.store.onStatus) {
      app.store.onStatus((st) => {
        app.status = st;
        schedule();
      });
    }
    app.store.load().catch((err) => {
      app.status = { kind: 'error', at: nowISO(), message: err?.message || String(err) };
      schedule();
    });
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
      act, setUI, rerender: schedule,
      openTask: (id) => setUI({ drawer: { taskId: id }, move: null, clockSheet: null }),
      openMove: (taskId, blockId = null) => setUI({ move: { taskId, blockId }, drawer: null, clockSheet: null }),
      openClock: (ref = null) => setUI({ clockSheet: { ref }, drawer: null, move: null }),
      closeOverlay: () => setUI({ drawer: null, move: null, clockSheet: null }),
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
      cal: calendarView(state, today, 14),
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
      toast(`Couldn't save: ${err?.message || err}`, { kind: 'error' });
      return null;
    }
    if (opts.toast) toast(opts.toast, { kind: opts.kind ?? 'good', action: opts.undo ? { label: 'Undo', fn: opts.undo } : null });
    return res;
  }

  function setUI(patch) {
    app.ui = { ...app.ui, ...patch };
    schedule();
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
    app.config = { ...DEFAULT_CONFIG, ...cfg };
    storage.set('ef.gh.config', JSON.stringify(app.config));
    pickStore();
  }

  // ---------- toasts ----------
  function toast(message, { kind = 'info', action = null, ms = 4200 } = {}) {
    const el = h('div.toast', { class: kind === 'error' ? 'is-error' : kind === 'good' ? 'is-good' : '', role: 'status' },
      h('span', message),
      action ? h('button.btn.btn-sm', { type: 'button', onclick: () => { el.remove(); action.fn(); } }, action.label) : null,
    );
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
    setTimeout(() => el.remove(), ms);
  }

  // ---------- render ----------
  function schedule() {
    if (app.renderQueued) return;
    app.renderQueued = true;
    requestAnimationFrame(() => {
      app.renderQueued = false;
      render();
    });
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
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
    let overlay = null;
    try {
      if (ctx.ui.drawer) overlay = renderDrawer(ctx);
      else if (ctx.ui.move) overlay = renderMoveSheet(ctx);
      else if (ctx.ui.clockSheet) overlay = renderClockSheet(ctx);
    } catch (err) {
      console.error(err);
    }
    if (overlay) {
      if (els.overlay.firstChild !== overlay) mount(els.overlay, overlay);
      els.overlay.hidden = false;
    } else {
      els.overlay.replaceChildren();
      els.overlay.hidden = true;
    }
  }

  // ---------- global listeners ----------
  window.addEventListener('hashchange', () => setTab(tabFromHash()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (app.ui.drawer || app.ui.move || app.ui.clockSheet)) {
      setUI({ drawer: null, move: null, clockSheet: null });
    }
  });
  // tick: keeps the clock widget, "today", and relative times fresh
  setInterval(() => app.header && app.header.tick && app.header.tick(buildCtx()), 1000);
  setInterval(schedule, 60 * 1000);

  pickStore();
  schedule();
  return app;
}

if (typeof window !== 'undefined' && !window.__EF_NO_BOOT__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot());
  else boot();
}
