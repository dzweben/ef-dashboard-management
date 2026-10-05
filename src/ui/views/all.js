// All tasks: search, status + category filters, sort, grouped by category group.
import { h, catStyle } from '../dom.js';
import { GROUPS } from '../../engine/model.js';
import { taskRow } from './taskrow.js';
import { catOf, ic, keepFocus } from './setup.js';

const STATUSES = [
  ['open', 'Open'],
  ['done', 'Done'],
  ['dropped', 'Dropped'],
  ['all', 'All'],
];
const SORTS = [
  ['due', 'Due date'],
  ['plan', 'Plan date'],
  ['cat', 'Category'],
  ['new', 'Newest'],
];
const PAGE = 150;

const STATUS_OF = { open: 'todo', done: 'done', dropped: 'dropped' };

/** Filters from ctx.ui.filters with defaults and junk removed. */
export function normFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    q: typeof f.q === 'string' ? f.q : '',
    status: STATUSES.some(([k]) => k === f.status) ? f.status : 'open',
    cats: Array.isArray(f.cats) ? [...new Set(f.cats.filter((c) => typeof c === 'string' && c))] : [],
    sort: SORTS.some(([k]) => k === f.sort) ? f.sort : 'due',
    limit: Number.isFinite(f.limit) && f.limit > 0 ? f.limit : PAGE,
  };
}

const taskStatus = (t) => (t.status === 'done' || t.status === 'dropped' ? t.status : 'todo');

function haystack(t) {
  const subs = Array.isArray(t.subs) ? t.subs.map((s) => (s && typeof s === 'object' ? s.t : s)).join(' ') : '';
  return `${t.title ?? ''} ${t.notes ?? ''} ${subs}`.toLowerCase();
}

/** Tasks matching status + search (+ categories unless skipCats). Pure. */
export function filterTasks(tasks, filters, { skipCats = false } = {}) {
  const f = normFilters(filters);
  const want = f.status === 'all' ? null : STATUS_OF[f.status];
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const cats = new Set(f.cats);
  const list = Array.isArray(tasks) ? tasks : Object.values(tasks ?? {});
  return list.filter((t) => {
    if (!t || typeof t !== 'object' || !t.id) return false;
    if (want && taskStatus(t) !== want) return false;
    if (!skipCats && cats.size && !cats.has(t.cat || 'inbox')) return false;
    if (terms.length) {
      const hay = haystack(t);
      if (!terms.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const s = (v) => (typeof v === 'string' ? v : '');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nullsLast = (a, b) => (a === b ? 0 : !a ? 1 : !b ? -1 : cmp(a, b));
const byTitle = (a, b) => cmp(s(a.title).toLowerCase(), s(b.title).toLowerCase());
const prio = (t) => (Number.isFinite(t.prio) ? t.prio : 1);

/** Sort a task list in place-free fashion. cats: the state.cats map (for 'cat'). */
export function sortTasks(list, sort, cats = {}) {
  const arr = [...list];
  const catKey = (t) => {
    const c = cats?.[t.cat] ?? cats?.inbox;
    return `${String(Number.isFinite(c?.order) ? c.order : 999).padStart(5, '0')}|${s(c?.name).toLowerCase()}`;
  };
  const doneOrder = (a, b) => cmp(s(b.doneAt), s(a.doneAt));
  switch (sort) {
    case 'plan':
      return arr.sort((a, b) => nullsLast(s(a.plan), s(b.plan)) || nullsLast(s(a.due), s(b.due)) || prio(b) - prio(a) || byTitle(a, b));
    case 'cat':
      return arr.sort((a, b) => cmp(catKey(a), catKey(b)) || nullsLast(s(a.due) || s(a.plan), s(b.due) || s(b.plan)) || byTitle(a, b));
    case 'new':
      return arr.sort((a, b) => cmp(s(b.created), s(a.created)) || byTitle(a, b));
    case 'due':
    default:
      return arr.sort((a, b) => {
        if (taskStatus(a) === 'done' && taskStatus(b) === 'done' && !a.due && !b.due) return doneOrder(a, b) || byTitle(a, b);
        return nullsLast(s(a.due), s(b.due)) || nullsLast(s(a.plan), s(b.plan)) || prio(b) - prio(a) || byTitle(a, b);
      });
  }
}

/** Group by category group in GROUPS order (unknown groups land in admin). */
export function groupTasks(list, cats = {}) {
  const ids = new Set(GROUPS.map((g) => g.id));
  const buckets = new Map(GROUPS.map((g) => [g.id, []]));
  for (const t of list) {
    const c = cats?.[t.cat] ?? cats?.inbox;
    const g = ids.has(c?.group) ? c.group : 'admin';
    buckets.get(g).push(t);
  }
  return GROUPS.map((g) => ({ group: g, tasks: buckets.get(g.id) })).filter((x) => x.tasks.length);
}

/** Counts per status for the toggle chips (respecting search + categories). */
export function statusCounts(tasks, filters) {
  const f = normFilters(filters);
  const out = { open: 0, done: 0, dropped: 0, all: 0 };
  for (const t of filterTasks(tasks, { ...f, status: 'all' })) {
    out.all += 1;
    const st = taskStatus(t);
    if (st === 'todo') out.open += 1;
    else out[st] += 1;
  }
  return out;
}

export function renderAll(ctx) {
  const restore = keepFocus();
  const f = normFilters(ctx?.ui?.filters);
  const set = (patch) => ctx?.setUI?.({ filters: { ...f, limit: PAGE, ...patch } });
  const tasks = Object.values(ctx?.state?.tasks ?? {});
  const cats = ctx?.state?.cats ?? {};
  const loaded = ctx?.loaded !== false;

  const counts = statusCounts(tasks, f);
  const results = sortTasks(filterTasks(tasks, f), f.sort, cats);
  const shown = results.slice(0, f.limit);
  const groups = groupTasks(shown, cats);

  // category chips: counts within the current status + search, ignoring the cat filter itself
  const catCounts = new Map();
  for (const t of filterTasks(tasks, f, { skipCats: true })) catCounts.set(t.cat || 'inbox', (catCounts.get(t.cat || 'inbox') ?? 0) + 1);
  const catChips = Object.values(cats)
    .filter((c) => c && c.id && (catCounts.get(c.id) || f.cats.includes(c.id)))
    .sort((a, b) => GROUPS.findIndex((g) => g.id === a.group) - GROUPS.findIndex((g) => g.id === b.group) || (a.order ?? 500) - (b.order ?? 500) || String(a.name).localeCompare(String(b.name)));

  const searchBox = h('div.all-search',
    h('span.all-prompt', { 'aria-hidden': 'true' }, '>'),
    h('label.sr-only', { for: 'all-search' }, 'Search to-dos'),
    h('input.field#all-search', {
      type: 'search',
      value: f.q,
      placeholder: 'grep your to-dos…',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      oninput: (e) => set({ q: e.currentTarget.value }),
      onkeydown: (e) => {
        if (e.key === 'Escape' && f.q) {
          e.preventDefault();
          e.stopPropagation();
          set({ q: '' });
        }
      },
    }),
    f.q ? h('button.btn.btn-ghost.btn-sm.all-clear-q', { type: 'button', 'aria-label': 'Clear search', onclick: () => set({ q: '' }) }, ic(ctx, 'x')) : null,
  );

  const statusBar = h('div.all-status', { role: 'group', 'aria-label': 'Status' },
    STATUSES.map(([k, label]) => h('button.all-seg', {
      type: 'button',
      'aria-pressed': String(f.status === k),
      class: `is-${k}`,
      onclick: () => set({ status: k }),
    }, h('span', label), h('b', String(counts[k] ?? 0)))),
  );

  const sortSel = h('label.all-sort',
    h('span.label', 'sort'),
    h('select.field#all-sort', {
      'aria-label': 'Sort by',
      onchange: (e) => set({ sort: e.currentTarget.value }),
    }, SORTS.map(([k, label]) => h('option', { value: k, selected: f.sort === k }, label))),
  );

  const catBar = catChips.length
    ? h('div.all-cats', { role: 'group', 'aria-label': 'Categories' },
        catChips.map((c) => {
          const on = f.cats.includes(c.id);
          return h('button.all-cat', {
            type: 'button',
            'aria-pressed': String(on),
            style: catStyle(c),
            title: c.name,
            onclick: () => set({ cats: on ? f.cats.filter((x) => x !== c.id) : [...f.cats, c.id] }),
          }, h('span.catdot', { style: catStyle(c) }), h('span', c.name), h('b', String(catCounts.get(c.id) ?? 0)));
        }),
        f.cats.length ? h('button.all-cat.is-reset', { type: 'button', onclick: () => set({ cats: [] }) }, ic(ctx, 'x'), 'clear') : null,
      )
    : null;

  const anyFilter = f.q || f.cats.length || f.status !== 'open';
  const body = !loaded
    ? h('p.label', 'LOADING…')
    : groups.length
      ? h('div.all-groups', groups.map(({ group, tasks: list }) =>
          h('section.all-group', { 'aria-label': `${group.label}: ${list.length}` },
            h('h3.all-group-h', h('span.all-group-name', group.label), h('span.all-group-n', String(list.length)), h('span.all-group-rule', { 'aria-hidden': 'true' })),
            h('div.all-rows', list.map((t) => taskRow(t, ctx, { context: 'all', showDate: true }))),
          )))
      : h('div.empty.all-empty',
          h('p.scrawl', f.q ? `Nothing matches “${f.q}”.` : f.status === 'open' ? 'Zero open to-dos. Unreal.' : 'Nothing here.'),
          anyFilter ? h('button.btn.btn-sm', { type: 'button', onclick: () => ctx?.setUI?.({ filters: {} }) }, 'Reset filters') : h('p', 'Type a to-do in the terminal up top.'),
        );

  const root = h('section.panel.all', { 'aria-labelledby': 'all-h' },
    h('header.panel-head.all-head',
      h('h2#all-h', h('span.slash', '//'), 'All to-dos'),
      h('p.all-readout',
        h('b.shout', String(results.length)),
        h('span.label', `${f.status === 'all' ? 'total' : f.status}${f.q || f.cats.length ? ' · filtered' : ''}`),
      ),
    ),
    h('div.panel-body',
      h('div.all-bar', searchBox, statusBar, sortSel),
      catBar,
      body,
      results.length > shown.length
        ? h('button.btn.all-more', { type: 'button', onclick: () => ctx?.setUI?.({ filters: { ...f, limit: f.limit + PAGE } }) },
            `Show ${Math.min(PAGE, results.length - shown.length)} more (${results.length - shown.length} left)`)
        : null,
    ),
  );
  restore(root);
  return root;
}
