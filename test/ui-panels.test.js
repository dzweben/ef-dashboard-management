// Calendar / Chores / Projects / Wins / All / Setup views: pure helpers + smoke renders
// against a tiny self-contained DOM shim (no jsdom: zero dependencies).
// "Today" is Mon 2026-10-05, America/New_York.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------ minimal DOM shim

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? new FakeText(n) : n); }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...ns) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...ns);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}
class FakeText extends FakeNode {
  constructor(t) { super(); this.data = String(t); }
  get textContent() { return this.data; }
}
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.classList = new ClassList();
    this.dataset = {};
    this.listeners = {};
    const style = {};
    style.setProperty = (k, v) => { style[k] = v; };
    this.style = style;
    this.id = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) {
    const ev = { type, currentTarget: this, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(ev);
    return ev;
  }
  get className() { return [...this.classList.set].join(' '); }
  matches(sel) { return matchSel(this, sel); }
  closest(sel) {
    for (let x = this; x instanceof FakeElement; x = x.parentNode) if (matchSel(x, sel)) return x;
    return null;
  }
  querySelectorAll(sel) { return all(this).filter((e) => e !== this && sel.split(',').some((s) => matchSel(e, s.trim()))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  focus() { globalThis.document.activeElement = this; }
}
/** Simple selectors only: tag, .class, #id, [attr] / [attr=value] (no combinators). */
function matchSel(el, sel) {
  const m = String(sel).match(/^([a-z]*)((?:[.#][\w-]+)*)(?:\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\])?$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '#' && el.id !== part.slice(1)) return false;
    if (part[0] === '.' && !el.classList.contains(part.slice(1))) return false;
  }
  if (m[3]) {
    const v = m[3].startsWith('data-') ? el.dataset[m[3].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : el.getAttribute(m[3]);
    if (v === undefined || v === null) return false;
    if (m[4] !== undefined && String(v) !== m[4]) return false;
  }
  return true;
}
function all(root) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) if (c instanceof FakeElement) { out.push(c); walk(c); } };
  out.push(root);
  walk(root);
  return out;
}

// Install only what isn't there already (keeps this file independent of other UI test shims).
const prevNode = globalThis.Node;
const prevDocument = globalThis.document;
const body = new FakeElement('body');
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (_ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  body,
  documentElement: new FakeElement('html'),
  activeElement: body,
  getElementById: () => null,
};
void prevNode; void prevDocument;

const $$ = (root, sel) => root.querySelectorAll(sel);
const $ = (root, sel) => root.querySelector(sel);
const text = (el) => (el ? el.textContent : '');

// ------------------------------------------------------------------ app modules (after the shim)

const { renderCalendar, loadLevel, emptyRuns, calSummary, calendarDays, dailyChores, dropOn, LED_SEGS } = await import('../src/ui/views/calendar.js');
const { renderChores, cadenceLabel, choreState } = await import('../src/ui/views/chores.js');
const { renderProjects, countdown, doneProjects } = await import('../src/ui/views/projects.js');
const { renderWins, heatLevel, heatWeeks, winsByDay, recentByCat, lastWeekDone } = await import('../src/ui/views/wins.js');
const { renderAll, normFilters, filterTasks, sortTasks, groupTasks, statusCounts } = await import('../src/ui/views/all.js');
const { renderSetup, tokenWarning, tokenUrl, capTotals, shortMin, agoLabel, draftGet, draftSet, draftClear } = await import('../src/ui/views/setup.js');
const { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } = await import('../src/engine/views.js');
const { risks } = await import('../src/engine/schedule.js');
const { streak, weekStats, heatmap, wins } = await import('../src/engine/stats.js');
const { emptyState, normalizeState, INBOX_CATEGORY } = await import('../src/engine/model.js');
const { icon } = await import('../src/ui/icons.js');
const { fixture, makeState, TODAY, NOW } = await import('./fixtures/engine-fixture.js');

const TZ = 'America/New_York';

function vmFor(state, today) {
  return {
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
}

function makeCtx(state, { today = TODAY, ui = {}, ...extra } = {}) {
  const calls = [];
  const ctx = {
    state, today, now: NOW, tz: TZ,
    vm: vmFor(state, today),
    cat: (id) => state.cats?.[id] ?? state.cats?.inbox ?? INBOX_CATEGORY,
    cats: state.cats,
    ui: { tab: 'calendar', drawer: null, move: null, clockSheet: null, filters: {}, flash: null, ...ui },
    loaded: true,
    store: { mode: 'local', status: { kind: 'synced', at: NOW, message: 'Saved locally.' }, canWrite: true, refresh: () => calls.push({ op: 'refresh' }) },
    config: { owner: 'dzweben', repo: 'ef-dashboard-management', branch: '', path: 'data/state.json' },
    hasToken: false,
    act: async (op, args, opts) => { calls.push({ op, args, opts }); return { writes: [{ op: 'update' }], activity: [] }; },
    setUI(patch) { calls.push({ op: 'setUI', patch }); Object.assign(ctx.ui, patch); },
    rerender: () => {},
    openTask: (id) => calls.push({ op: 'openTask', id }),
    openMove: (taskId, blockId) => calls.push({ op: 'openMove', taskId, blockId }),
    openClock: (ref) => calls.push({ op: 'openClock', ref }),
    closeOverlay: () => {},
    toast: (msg, o) => calls.push({ op: 'toast', msg, o }),
    fx: { burst: () => calls.push({ op: 'burst' }), stamp: (_el, t) => calls.push({ op: 'stamp', t }) },
    icon,
    setToken: (t) => calls.push({ op: 'setToken', t }),
    clearToken: () => calls.push({ op: 'clearToken' }),
    saveConfig: (c) => calls.push({ op: 'saveConfig', c }),
    calls,
    ...extra,
  };
  return ctx;
}

function seedState() {
  try {
    return normalizeState(JSON.parse(readFileSync(new URL('../data/state.json', import.meta.url), 'utf8')));
  } catch {
    return null;
  }
}

/** A fixture with blocks, a meeting, an off day, chores, a paused + a done project. */
function richState() {
  const s = makeState({
    settings: { offDays: ['2026-10-10'] },
    tasks: [
      { id: 't_big', title: 'RSA manuscript draft', cat: 'inbox', kind: 'writing', est: 300, due: '2026-10-12', prio: 3, project: 'p_rsa',
        blocks: [{ id: 'b1', d: '2026-10-06', m: 60 }, { id: 'b2', d: '2026-10-07', m: 120, auto: false }, { id: 'b0', d: '2026-10-05', m: 30, done: true }] },
      { id: 't_lab', title: 'Lab meeting', kind: 'meeting', plan: '2026-10-05', time: '14:00', est: 60 },
      { id: 't_p1', title: 'One', plan: '2026-10-05', est: 10 },
      { id: 't_p2', title: 'Two', plan: '2026-10-05', est: 10 },
      { id: 't_p3', title: 'Three', plan: '2026-10-05', est: 10 },
      { id: 't_p4', title: 'Four', plan: '2026-10-05', est: 10 },
      { id: 't_off', title: 'Booked on an off day', plan: '2026-10-10', est: 30 },
      { id: 't_back', title: 'Backlog thing', notes: 'needle in the notes' },
      { id: 't_drop', title: 'Dropped thing', status: 'dropped' },
      { id: 't_done', title: 'Done thing', status: 'done', doneAt: '2026-10-05T15:00:00.000Z', win: true },
    ],
    chores: [
      { id: 'c_walk', title: 'Walk dog', every: 1, perDay: 2, log: ['2026-10-05'] },
      { id: 'c_wk', title: 'Laundry', every: 7, last: '2026-09-20', log: ['2026-09-20'] },
      { id: 'c_new', title: 'Never done', every: 3 },
      { id: 'c_fresh', title: 'Fresh', every: 14, last: '2026-10-04', log: ['2026-10-04'] },
    ],
    projects: [
      { id: 'p_rsa', name: 'RSA manuscript', status: 'active', due: '2026-10-21', milestones: [{ id: 'm1', t: 'Methods', done: true, doneAt: '2026-10-01T12:00:00.000Z' }, { id: 'm2', t: 'Results', due: '2026-10-09' }] },
      { id: 'p_pause', name: 'Side quest', status: 'paused' },
      { id: 'p_done', name: 'Shipped thing', status: 'done' },
    ],
  });
  s.cats.home = { id: 'home', name: 'Home', group: 'life', color: '#6ccea6', glyph: 'HM', aliases: [], order: 1, archived: false };
  return s;
}

// ------------------------------------------------------------------ pure helpers

describe('calendar helpers', () => {
  test('loadLevel tones and LED count', () => {
    assert.deepEqual([loadLevel({ total: 0, cap: 240 }).tone, loadLevel({ total: 0, cap: 240 }).lit], ['idle', 0]);
    assert.equal(loadLevel({ total: 60, cap: 240 }).tone, 'ok');
    assert.equal(loadLevel({ total: 60, cap: 240 }).lit, 3);
    assert.equal(loadLevel({ total: 200, cap: 240 }).tone, 'warn');
    assert.equal(loadLevel({ total: 260, cap: 240 }).tone, 'hot');
    assert.equal(loadLevel({ total: 260, cap: 240 }).lit, LED_SEGS);
    assert.equal(loadLevel({ total: 320, cap: 240 }).tone, 'crit');
    assert.equal(loadLevel({ total: 1, cap: 240 }).lit, 1, 'any load lights at least one segment');
    assert.equal(loadLevel({ total: 240, cap: 240 }).lit, LED_SEGS);
    assert.equal(loadLevel({ total: 240, cap: 240 }).tone, 'warn', 'exactly full is not over');
  });
  test('loadLevel: off days and junk', () => {
    assert.deepEqual([loadLevel({ total: 0, cap: 0 }).tone, loadLevel({ total: 0, cap: 0 }).label], ['off', 'OFF']);
    assert.equal(loadLevel({ total: 30, cap: 240 }, true).tone, 'crit');
    assert.match(loadLevel({ total: 30, cap: 0 }).label, /^OFF \+30m$/);
    assert.equal(loadLevel(undefined).tone, 'off');
    assert.equal(loadLevel({ total: NaN, cap: 'x' }).tone, 'off');
    assert.equal(loadLevel({ total: 90, cap: 240 }).label, '1h30/4h');
    assert.equal(loadLevel({ total: 0, cap: 90 }).label, '0/1h30');
  });
  test('shortMin', () => {
    assert.deepEqual([0, 45, 60, 100, 600, -5, 'x'].map(shortMin), ['0m', '45m', '1h', '1h40', '10h', '0m', '0m']);
  });
  test('emptyRuns collapses ≥2 consecutive blank days, never today or off days', () => {
    const blank = (d) => ({ d, items: [], chores: [], done: [] });
    const days = [
      { ...blank('2026-10-05'), isToday: true },
      blank('2026-10-06'), blank('2026-10-07'),
      { ...blank('2026-10-08'), items: [{ type: 'plan', task: { id: 'x' } }] },
      blank('2026-10-09'),
      blank('2026-10-10'), { ...blank('2026-10-11'), isOff: true }, blank('2026-10-12'), blank('2026-10-13'), blank('2026-10-14'),
      { ...blank('2026-10-15'), chores: [{ id: 'c_daily' }] },
      { ...blank('2026-10-16'), chores: [{ id: 'c_daily' }] },
    ];
    const runs = emptyRuns(days, new Set(['c_daily']));
    assert.deepEqual(runs.map((r) => r.days), [[1, 2], [4, 5], [7, 8, 9, 10, 11]]);
    assert.deepEqual(emptyRuns([]), []);
  });
  test('calSummary + dailyChores', () => {
    const s = richState();
    const days = calendarView(s, TODAY, 14, TODAY);
    const sum = calSummary(days);
    assert.equal(sum.dues, 1);
    assert.ok(sum.load > 0 && sum.cap > 0);
    assert.ok(sum.over >= 1, 'the off day with a booking counts as over');
    assert.deepEqual(dailyChores(s).map((c) => c.id), ['c_walk']);
    assert.deepEqual(dailyChores(undefined), []);
  });
  test('calendarDays uses vm.cal, computes when the request is longer, survives junk', () => {
    const ctx = makeCtx(richState());
    assert.equal(calendarDays(ctx, 7).length, 7);
    assert.equal(calendarDays(ctx, 7)[0], ctx.vm.cal[0]);
    assert.equal(calendarDays(ctx, 21).length, 21);
    assert.deepEqual(calendarDays({}, 14), []);
    assert.deepEqual(calendarDays(null), []);
  });
});

describe('dropOn (drag and drop → ops)', () => {
  test('task → day runs moveTask with an undo back to the old plan', async () => {
    const ctx = makeCtx(richState());
    await dropOn(ctx, { taskId: 't_p1', blockId: null }, '2026-10-08');
    const call = ctx.calls.find((c) => c.op === 'moveTask');
    assert.deepEqual(call.args, { id: 't_p1', to: '2026-10-08' });
    assert.equal(typeof call.opts.undo, 'function');
    call.opts.undo();
    assert.deepEqual(ctx.calls.at(-1).args, { id: 't_p1', to: '2026-10-05' });
  });
  test('block → day runs moveBlock; same day is a no-op; block → backlog is refused', async () => {
    const ctx = makeCtx(richState());
    await dropOn(ctx, { taskId: 't_big', blockId: 'b1' }, '2026-10-09');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'moveBlock').args, { id: 't_big', blockId: 'b1', to: '2026-10-09' });
    const n = ctx.calls.length;
    assert.equal(dropOn(ctx, { taskId: 't_big', blockId: 'b1' }, '2026-10-06'), null);
    assert.equal(dropOn(ctx, { taskId: 't_big', blockId: 'b1' }, null), null);
    assert.equal(ctx.calls.filter((c) => c.op === 'moveBlock').length, 1);
    assert.ok(ctx.calls.length > n, 'refusal explains itself in a toast');
  });
  test('task → backlog (null) unschedules; planning past the due date warns', async () => {
    const ctx = makeCtx(richState());
    await dropOn(ctx, { taskId: 't_p2', blockId: null }, null);
    assert.deepEqual(ctx.calls.find((c) => c.op === 'moveTask').args, { id: 't_p2', to: null });
    await dropOn(ctx, { taskId: 't_big', blockId: null }, '2026-10-15');
    const late = ctx.calls.filter((c) => c.op === 'moveTask').at(-1);
    assert.match(late.opts.toast, /due/i);
  });
  test('unknown ids and junk payloads do nothing', () => {
    const ctx = makeCtx(richState());
    assert.equal(dropOn(ctx, { taskId: 'nope' }, '2026-10-06'), null);
    assert.equal(dropOn(ctx, null, '2026-10-06'), null);
    assert.equal(dropOn(ctx, { taskId: 't_back', blockId: null }, null), null, 'already unscheduled');
    assert.equal(ctx.calls.length, 0);
  });
});

describe('chores helpers', () => {
  test('cadenceLabel', () => {
    assert.deepEqual(
      [{ every: 1 }, { every: 1, perDay: 2 }, { every: 7 }, { every: 14 }, { every: 30 }, { every: 21 }, { every: 3 }, {}, null].map(cadenceLabel),
      ['DAILY', 'DAILY ×2', 'WEEKLY', 'EVERY 2W', 'MONTHLY', 'EVERY 3W', 'EVERY 3D', 'WEEKLY', 'WEEKLY'],
    );
  });
  test('choreState: fresh → due → overdue, daily pips, never logged', () => {
    const rows = Object.fromEntries(choreView(richState(), TODAY).map((r) => [r.chore.id, r]));
    const walk = choreState(rows.c_walk, TODAY);
    assert.equal(walk.tone, 'due');
    assert.deepEqual(walk.pips, { done: 1, of: 2 });
    assert.equal(walk.text, '1/2 TODAY');
    const wk = choreState(rows.c_wk, TODAY);
    assert.equal(wk.tone, 'over');
    assert.equal(wk.text, 'OVERDUE 8D');
    assert.equal(wk.last, 'last: 15d ago');
    const never = choreState(rows.c_new, TODAY);
    assert.equal(never.tone, 'due');
    assert.equal(never.last, 'never logged');
    const fresh = choreState(rows.c_fresh, TODAY);
    assert.equal(fresh.tone, 'fresh');
    assert.match(fresh.text, /^NEXT /);
    assert.equal(choreState({ chore: { every: 7 }, daysSince: 7 }, TODAY).text, 'DUE TODAY');
    assert.equal(choreState({ chore: { every: 1, perDay: 1 }, todayCount: 3 }, TODAY).tone, 'done');
    assert.doesNotThrow(() => choreState(undefined, undefined));
    // a new chore set to start later ("laundry every week - sat") is not DUE yet
    const later = choreState({ chore: { every: 7, start: '2026-10-10' }, due: false, daysSince: null, nextDue: '2026-10-10' }, TODAY);
    assert.equal(later.tone, 'fresh');
    assert.equal(later.text, 'STARTS SAT');
    assert.equal(later.last, 'never logged');
  });
});

describe('projects helpers', () => {
  test('countdown tones', () => {
    assert.equal(countdown(null, TODAY), null);
    assert.deepEqual(countdown('2026-10-03', TODAY), { n: -2, label: '2D LATE', tone: 'late' });
    assert.equal(countdown('2026-10-05', TODAY).label, 'TODAY');
    assert.equal(countdown('2026-10-12', TODAY).tone, 'hot');
    assert.equal(countdown('2026-10-19', TODAY).tone, 'warn');
    assert.equal(countdown('2026-11-30', TODAY).tone, 'calm');
  });
  test('doneProjects', () => {
    assert.deepEqual(doneProjects(richState()).map((p) => p.id), ['p_done']);
    assert.deepEqual(doneProjects({}), []);
  });
});

describe('wins helpers', () => {
  test('heatLevel scales to the busiest day', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((c) => heatLevel(c, 3)), [0, 1, 2, 3, 4, 4]);
    assert.deepEqual([1, 2, 3, 4, 7, 8].map((c) => heatLevel(c, 8)), [1, 1, 2, 2, 4, 4]);
    assert.equal(heatLevel('x', 0), 0);
  });
  test('heatWeeks + lastWeekDone', () => {
    const cells = heatmap(fixture(), TODAY, 12);
    const weeks = heatWeeks(cells);
    assert.equal(weeks.length, 12);
    assert.equal(weeks.at(-1).length, 1, 'Monday: this week has one day so far');
    assert.equal(weeks[0][0].d, '2026-07-20');
    assert.equal(lastWeekDone(cells), 3, 'Mon 9/28 – Sun 10/4: figs, abstract, read');
    assert.equal(lastWeekDone([]), null);
    assert.deepEqual(heatWeeks(null), []);
  });
  test('winsByDay groups by local day (tz boundary)', () => {
    const g = winsByDay(wins(fixture(), {}), TZ);
    assert.equal(g[0].d, '2026-10-05', 'notes at 02:00Z on 10/6 is 22:00 ET on 10/5');
    assert.ok(g.every((x, i) => i === 0 || x.d < g[i - 1].d));
    assert.deepEqual(winsByDay(undefined, TZ), []);
  });
  test('recentByCat windows', () => {
    const list = wins(fixture(), {});
    assert.deepEqual(recentByCat(list, TODAY, TZ, 7), { psc: 1, cbt: 1, sdn: 1, rsa: 1 });
    assert.deepEqual(recentByCat(list, TODAY, TZ, 1), { psc: 1 });
    assert.deepEqual(recentByCat(null, TODAY, TZ), {});
    assert.deepEqual(recentByCat(list, 'nope', TZ), {});
  });
});

describe('all-tasks helpers', () => {
  const s = richState();
  const tasks = Object.values(s.tasks);
  test('normFilters defaults and junk', () => {
    assert.deepEqual(normFilters(undefined), { q: '', status: 'open', cats: [], sort: 'due', limit: 150 });
    assert.deepEqual(normFilters({ q: 3, status: 'weird', cats: ['a', 'a', 7, ''], sort: 'zzz', limit: -1 }), { q: '', status: 'open', cats: ['a'], sort: 'due', limit: 150 });
  });
  test('filterTasks: status, search in notes, categories', () => {
    assert.equal(filterTasks(tasks, { status: 'all' }).length, tasks.length);
    assert.deepEqual(filterTasks(tasks, { status: 'dropped' }).map((t) => t.id), ['t_drop']);
    assert.deepEqual(filterTasks(tasks, { q: 'NEEDLE notes' }).map((t) => t.id), ['t_back']);
    assert.equal(filterTasks(tasks, { cats: ['nope'] }).length, 0);
    assert.equal(filterTasks(tasks, { cats: ['nope'] }, { skipCats: true }).length, filterTasks(tasks, {}).length);
    assert.deepEqual(filterTasks([null, 3, {}], {}), []);
  });
  test('sortTasks: due puts dated first, plan puts undated last', () => {
    const open = filterTasks(tasks, {});
    assert.equal(sortTasks(open, 'due', s.cats)[0].id, 't_big');
    const byPlan = sortTasks(open, 'plan', s.cats).map((t) => t.plan ?? null);
    const firstNull = byPlan.indexOf(null);
    assert.ok(byPlan.slice(firstNull).every((p) => p === null), 'undated last');
    assert.equal(sortTasks([], 'new').length, 0);
    assert.doesNotThrow(() => sortTasks(open, 'cat', undefined));
  });
  test('groupTasks + statusCounts', () => {
    const groups = groupTasks(filterTasks(tasks, { status: 'all' }), s.cats);
    assert.equal(groups.reduce((n, g) => n + g.tasks.length, 0), tasks.length);
    assert.deepEqual(statusCounts(tasks, {}), { open: 8, done: 1, dropped: 1, all: 10 });
    assert.deepEqual(statusCounts(tasks, { q: 'thing' }), { open: 1, done: 1, dropped: 1, all: 3 });
  });
});

describe('setup helpers', () => {
  test('tokenWarning', () => {
    assert.equal(tokenWarning('github_pat_11ABCDEF'), null);
    assert.match(tokenWarning(''), /Paste/);
    assert.match(tokenWarning('ghp_abc'), /classic/);
    assert.match(tokenWarning('github_pat_ x'), /spaces/);
    assert.match(tokenWarning('hunter2'), /doesn't look/);
  });
  test('tokenUrl prefills the fine-grained token form', () => {
    const u = new URL(tokenUrl({ owner: 'dzweben', repo: 'ef-dashboard-management', path: 'data/state.json' }));
    assert.equal(u.origin + u.pathname, 'https://github.com/settings/personal-access-tokens/new');
    assert.equal(u.searchParams.get('target_name'), 'dzweben');
    assert.equal(u.searchParams.get('contents'), 'write');
    assert.equal(u.searchParams.get('expires_in'), '365');
    assert.doesNotThrow(() => tokenUrl());
  });
  test('capTotals + agoLabel + drafts', () => {
    assert.equal(capTotals({ mon: 60, tue: 'x' }).week, 60 + 240 * 3 + 180 + 90 + 150, 'junk falls back to the default');
    assert.equal(capTotals(null).max, 240);
    assert.equal(agoLabel('2026-10-05T13:00:00.000Z', NOW), '1h ago');
    assert.equal(agoLabel('2026-10-05T13:59:50.000Z', NOW), 'just now');
    assert.equal(agoLabel('junk', NOW), '');
    const ctx = { ui: {} };
    assert.equal(draftGet(ctx, 'k', 'd'), 'd');
    draftSet(ctx, 'k', 'v');
    assert.equal(draftGet(ctx, 'k'), 'v');
    draftClear(ctx, 'k');
    assert.equal(draftGet(ctx, 'k', 'gone'), 'gone');
    assert.doesNotThrow(() => { draftSet(null, 'k', 1); draftClear(undefined, 'k'); });
  });
});

// ------------------------------------------------------------------ smoke renders

const RENDERERS = {
  'calendar full': (ctx) => renderCalendar(ctx, { days: 14 }),
  'calendar compact': (ctx) => renderCalendar(ctx, { days: 14, compact: true }),
  'chores full': (ctx) => renderChores(ctx, {}),
  'chores compact': (ctx) => renderChores(ctx, { compact: true }),
  'projects full': (ctx) => renderProjects(ctx, {}),
  'projects compact': (ctx) => renderProjects(ctx, { compact: true }),
  'wins full': (ctx) => renderWins(ctx, {}),
  'wins compact': (ctx) => renderWins(ctx, { compact: true }),
  all: (ctx) => renderAll(ctx),
  setup: (ctx) => renderSetup(ctx),
};

const STATES = {
  empty: () => emptyState(),
  fixture: () => fixture(),
  rich: () => richState(),
  seed: () => seedState() ?? richState(),
};

describe('smoke: every view renders without throwing', () => {
  for (const [sname, mk] of Object.entries(STATES)) {
    for (const [vname, render] of Object.entries(RENDERERS)) {
      test(`${vname} · ${sname}`, () => {
        const el = render(makeCtx(mk()));
        assert.ok(el instanceof FakeElement);
        assert.ok(text(el).length > 0);
      });
    }
  }
  for (const [vname, render] of Object.entries(RENDERERS)) {
    test(`${vname} · not loaded yet`, () => {
      const ctx = makeCtx(emptyState());
      ctx.loaded = false;
      assert.ok(render(ctx) instanceof FakeElement);
    });
    test(`${vname} · junk ctx (no vm, weird state, read-only)`, () => {
      const ctx = {
        state: { tasks: { a: null, b: 7, c: { id: 'c' } }, cats: null, chores: [], projects: { p: { id: 'p', status: 'active' } }, settings: { cap: 'x' } },
        today: 'not-a-date', ui: {}, store: { canWrite: false }, loaded: true,
      };
      assert.doesNotThrow(() => render(ctx));
      assert.doesNotThrow(() => render({}));
    });
  }
});

describe('calendar render details', () => {
  test('full: 14 day cells, today first, off day hatched, backlog strip, legend', () => {
    const el = renderCalendar(makeCtx(richState()), { days: 14 });
    const cells = $$(el, '.cal-day');
    assert.equal(cells.length, 14);
    assert.ok(cells[0].classList.contains('is-today'));
    assert.equal(cells[0].dataset.date, TODAY);
    const off = cells.find((c) => c.dataset.date === '2026-10-10');
    assert.ok(off.classList.contains('is-off'));
    assert.ok(off.classList.contains('load-crit'), 'booked on an off day');
    assert.ok($(el, '.cal-backlog'));
    assert.ok($(el, '.cal-legend'));
    assert.equal($$(el, '.cal-run').length, 0, 'runs only in compact');
  });
  test('chips: due pin, meeting time, plan, block; daily chores lifted out of cells', () => {
    const el = renderCalendar(makeCtx(richState()), { days: 14 });
    const day = (d) => $$(el, '.cal-day').find((c) => c.dataset.date === d);
    assert.match(text($(day('2026-10-05'), '.cal-chip.is-meeting')), /2PM/);
    assert.ok($(day('2026-10-12'), '.cal-chip.is-due'));
    const block = $(day('2026-10-06'), '.cal-chip.is-block');
    assert.equal(block.dataset.blockId, 'b1');
    assert.equal($$(day('2026-10-05'), '.cal-chip.is-block').length, 0, 'done blocks are not drawn');
    assert.ok(!text($(el, '.cal-grid')).includes('Walk dog'), 'daily chore not repeated per cell');
    assert.match(text($(el, '.cal-daily')), /Walk dog/);
  });
  test('compact: max 4 chips per day, +N more, blank runs collapse, no backlog', () => {
    const el = renderCalendar(makeCtx(richState()), { days: 14, compact: true });
    const today = $$(el, '.cal-day')[0];
    assert.equal($$(today, '.cal-chip').length, 4);
    assert.match(text($(today, '.cal-more')), /\+1 more/);
    assert.ok($$(el, '.cal-run').length >= 1);
    assert.ok($$(el, '.cal-day.in-run').length >= 2);
    assert.equal($(el, '.cal-backlog'), null);
  });
  test('chip click opens the task; backlog chip opens the move sheet', () => {
    const ctx = makeCtx(richState());
    const el = renderCalendar(ctx, { days: 14 });
    $(el, '.cal-chip.is-plan').dispatch('click');
    assert.equal(ctx.calls.at(-1).op, 'openTask');
    $(el, '.cal-chip.is-backlog').dispatch('click');
    assert.deepEqual(ctx.calls.at(-1), { op: 'openMove', taskId: 't_back', blockId: null });
  });
  test('cells are drop targets: drop reads the payload and moves the task', () => {
    const ctx = makeCtx(richState());
    const el = renderCalendar(ctx, { days: 14 });
    const target = $$(el, '.cal-day').find((c) => c.dataset.date === '2026-10-08');
    const payload = JSON.stringify({ taskId: 't_p3', blockId: null });
    const dataTransfer = { types: ['application/x-ef-item'], getData: () => payload, dropEffect: 'none' };
    const over = target.dispatch('dragover', { dataTransfer });
    assert.ok(over.defaultPrevented);
    assert.ok(target.classList.contains('is-over'));
    target.dispatch('drop', { dataTransfer });
    assert.ok(!target.classList.contains('is-over'));
    assert.deepEqual(ctx.calls.find((c) => c.op === 'moveTask').args, { id: 't_p3', to: '2026-10-08' });
  });
  test('foreign drags (files, links) are ignored', () => {
    const ctx = makeCtx(richState());
    const target = $$(renderCalendar(ctx, { days: 14 }), '.cal-day')[2];
    const over = target.dispatch('dragover', { dataTransfer: { types: ['Files'] } });
    assert.equal(over.defaultPrevented, false);
  });
});

describe('interactions', () => {
  test('chores: DID IT bursts, stamps and runs choreDone with an undo', () => {
    const ctx = makeCtx(richState());
    const el = renderChores(ctx, { compact: true });
    const tile = $$(el, '.chore-tile').find((t) => t.dataset.choreId === 'c_wk');
    $(tile, '.chore-did').dispatch('click');
    const ops = ctx.calls.map((c) => c.op);
    assert.ok(ops.includes('burst') && ops.includes('stamp'));
    const done = ctx.calls.find((c) => c.op === 'choreDone');
    assert.deepEqual(done.args, { id: 'c_wk' });
    done.opts.undo();
    assert.deepEqual(ctx.calls.at(-1).args, { id: 'c_wk', patch: { log: ['2026-09-20'], last: '2026-09-20' } });
  });
  test('chores: 5 MIN clocks in with the chore minutes; running clock shows Stop', () => {
    const s = richState();
    s.clock = { active: true, ref: 'chore:c_new', title: 'Never done', cat: 'home', start: NOW, goal: 5 };
    const ctx = makeCtx(s);
    const el = renderChores(ctx, {});
    const walk = $$(el, '.chore-tile').find((t) => t.dataset.choreId === 'c_walk');
    $(walk, '.chore-go').dispatch('click');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'clockIn').args, { ref: 'chore:c_walk', title: 'Walk dog', cat: 'home', goal: 5 });
    const clocked = $$(el, '.chore-tile').find((t) => t.dataset.choreId === 'c_new');
    assert.ok(clocked.classList.contains('is-clocked'));
    $(clocked, '.chore-stop').dispatch('click');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'clockOut').args, { markDone: true });
  });
  test('chores: add form uses drafts and addChore', async () => {
    const ctx = makeCtx(richState());
    draftSet(ctx, 'chore-add.title', 'Water plants');
    draftSet(ctx, 'chore-add.every', '3');
    const el = renderChores(ctx, {});
    $(el, 'form.chore-add').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.calls.find((c) => c.op === 'addChore').args, { title: 'Water plants', every: 3 });
    assert.equal(draftGet(ctx, 'chore-add.title', null), null, 'draft cleared after add');
  });
  test('projects: milestone checkbox toggles; paused + shipped sections render', () => {
    const ctx = makeCtx(richState());
    const el = renderProjects(ctx, {});
    const box = $(el, '#ms-p_rsa-m2');
    box.checked = true;
    box.dispatch('change');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'toggleMilestone').args, { id: 'p_rsa', msId: 'm2' });
    assert.ok(ctx.calls.some((c) => c.op === 'stamp' && c.t === 'MILESTONE'));
    assert.ok($(el, '.proj-ms.is-next'), 'next milestone highlighted');
    assert.ok($(el, '.is-paused-sec') && $(el, '.is-done-sec'));
  });
  test('projects compact: active only, no milestone checklist, next milestone line', () => {
    const el = renderProjects(makeCtx(richState()), { compact: true });
    assert.equal($$(el, '.proj-card').length, 1);
    assert.equal($$(el, '.proj-ms').length, 0);
    assert.match(text($(el, '.proj-next')), /Results/);
  });
  test('all: status chip and search write ctx.ui.filters, keeping the others', () => {
    const ctx = makeCtx(richState());
    const el = renderAll(ctx);
    $$(el, '.all-seg').find((b) => text(b).startsWith('Done')).dispatch('click');
    assert.equal(ctx.ui.filters.status, 'done');
    const search = $(renderAll(ctx), '#all-search');
    search.value = 'needle';
    search.dispatch('input');
    assert.equal(ctx.ui.filters.q, 'needle');
    assert.equal(ctx.ui.filters.status, 'done', 'other filters kept');
  });
  test('all: grouped results and the big readout', () => {
    const el = renderAll(makeCtx(richState(), { ui: { filters: { status: 'all' } } }));
    assert.ok($$(el, '.all-group').length >= 1);
    assert.equal(text($($(el, '.all-readout'), 'b')), '10');
  });
  test('setup: token form trims + saves, forget clears, config needs owner/repo/path', () => {
    const ctx = makeCtx(richState(), { hasToken: true });
    const el = renderSetup(ctx);
    const form = $(el, 'form.setup-token');
    $(form, '#setup-token').value = '  github_pat_abc  ';
    form.dispatch('submit');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'setToken'), { op: 'setToken', t: 'github_pat_abc' });
    assert.equal($(form, '#setup-token').value, '', 'token never lingers in the field');
    $(el, '.setup-forget').dispatch('click');
    assert.ok(ctx.calls.some((c) => c.op === 'clearToken'));
    draftSet(ctx, 'cfg.owner', '  someone ');
    draftSet(ctx, 'cfg.path', '/data/state.json');
    $(el, 'form.setup-config').dispatch('submit');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'saveConfig').c, { owner: 'someone', repo: 'ef-dashboard-management', branch: '', path: 'data/state.json' });
    draftSet(ctx, 'cfg.repo', '   ');
    $(renderSetup(ctx), 'form.setup-config').dispatch('submit');
    assert.equal(ctx.calls.filter((c) => c.op === 'saveConfig').length, 1, 'blank repo refused');
  });
  test('setup: empty token is refused; capacity edit sends one weekday', () => {
    const ctx = makeCtx(richState());
    const el = renderSetup(ctx);
    $(el, 'form.setup-token').dispatch('submit');
    assert.ok(!ctx.calls.some((c) => c.op === 'setToken'));
    const tue = $(el, '#cap-tue');
    tue.value = '300';
    tue.dispatch('change');
    assert.deepEqual(ctx.calls.find((c) => c.op === 'editSettings').args, { patch: { cap: { tue: 300 } } });
  });
  test('setup: read-only disables edits and says why', () => {
    const ctx = makeCtx(richState());
    ctx.store = { ...ctx.store, mode: 'readonly', canWrite: false, status: { kind: 'readonly', at: NOW, message: 'Read-only.' } };
    const el = renderSetup(ctx);
    assert.ok($$(el, '.setup-ro').length >= 3);
    assert.equal($(el, '#cap-mon').disabled, true);
    assert.match(text($(el, '.setup-status')), /READ-ONLY/);
  });
  test('wins: compact shows streak, 12-week heatmap, ≤5 wins; full shows the record', () => {
    const ctx = makeCtx(fixture());
    const compact = renderWins(ctx, { compact: true });
    assert.ok($(compact, '.wins-streak'));
    assert.equal($$(compact, '.wins-hm-col').length, 12);
    assert.ok($$(compact, '.wins-row').length <= 5);
    assert.ok($(compact, '.wins-hm-cell.is-today'));
    const full = renderWins(ctx, {});
    assert.ok($(full, '.wins-log'));
    assert.ok($$(full, '.wins-day').length >= 3);
  });
});
