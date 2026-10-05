// UI tests for the header, task rows, Today, brief, deadlines, overview, overlays,
// icons and fx, rendered into a tiny fake DOM (test/fixtures/ui-dom.js).
// "Today" is Mon 2026-10-05, America/New_York.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, text, words, mountAppShell } from './fixtures/ui-dom.js';

const dom = installDom();
window.__EF_NO_BOOT__ = true; // main.js boots only when a test asks it to

const { fixture, TODAY, NOW } = await import('./fixtures/engine-fixture.js');
const { DEFAULT_CATEGORIES } = await import('../src/engine/defaults.js');
const { normalizeCategory, INBOX_CATEGORY, emptyState, applyWrites } = await import('../src/engine/model.js');
const { OPS } = await import('../src/engine/ops.js');
const { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } = await import('../src/engine/views.js');
const { risks } = await import('../src/engine/schedule.js');
const { streak, weekStats, heatmap, wins } = await import('../src/engine/stats.js');
const { icon, ICON_NAMES, hasIcon } = await import('../src/ui/icons.js');
const { taskRow, COMPLETE_DELAY_MS, dueChip, dayTag, reopenUndo } = await import('../src/ui/views/taskrow.js');
const { renderToday } = await import('../src/ui/views/today.js');
const { renderBrief, updatedAgo } = await import('../src/ui/views/brief.js');
const { renderDeadlines } = await import('../src/ui/views/deadlines.js');
const { renderOverview } = await import('../src/ui/views/overview.js');
const { renderDrawer, renderMoveSheet, renderClockSheet } = await import('../src/ui/views/drawer.js');
const { mountHeader } = await import('../src/ui/views/header.js');
const { burst, stamp } = await import('../src/ui/fx/burst.js');
const { renderSetup } = await import('../src/ui/views/setup.js');
const { mount, isReplacing, isSaneDate } = await import('../src/ui/dom.js');
const { boot, DEFAULT_CONFIG } = await import('../src/ui/main.js');
const css = (name) => readFileSync(new URL(`../src/ui/styles/${name}`, import.meta.url), 'utf8');

function withCats(state) {
  const cats = { inbox: { ...INBOX_CATEGORY, aliases: [] } };
  for (const c of DEFAULT_CATEGORIES) cats[c.id] = normalizeCategory(c, { now: NOW });
  return { ...state, cats };
}

/** A ctx shaped like main.js buildCtx(), with act/setUI/toast recorders. */
function makeCtx(state = withCats(fixture()), { ui = {}, loaded = true, canWrite = true } = {}) {
  const calls = { act: [], ui: [], toast: [], open: [], fx: [] };
  const ctx = {
    state, today: TODAY, now: NOW, tz: 'America/New_York',
    vm: {
      today: todayView(state, TODAY),
      cal: calendarView(state, TODAY, 14, TODAY),
      deadlines: upcomingDeadlines(state, TODAY, 30),
      backlog: backlog(state),
      projects: projectView(state, TODAY),
      chores: choreView(state, TODAY),
      risks: risks(state, TODAY),
      streak: streak(state, TODAY),
      week: weekStats(state, TODAY),
      heatmap: heatmap(state, TODAY, 12),
      wins: wins(state, {}),
    },
    cat: (id) => state.cats?.[id] ?? state.cats?.inbox ?? INBOX_CATEGORY,
    cats: state.cats,
    ui: { tab: 'overview', drawer: null, move: null, clockSheet: null, filters: {}, ...ui },
    loaded,
    store: { mode: 'local', status: { kind: 'synced', at: NOW, message: 'ok' }, canWrite, refresh: () => calls.act.push(['refresh']) },
    config: {}, hasToken: false,
    act: (name, args, opts) => {
      calls.act.push([name, args, opts]);
      return Promise.resolve(canWrite ? { writes: [{ op: 'set', col: 'tasks', id: 't_new', data: { title: args?.title, plan: args?.plan ?? null, due: args?.due ?? null } }], activity: [] } : null);
    },
    setUI: (patch) => { calls.ui.push(patch); Object.assign(ctx.ui, patch); },
    rerender: () => {},
    openTask: (id) => calls.open.push(['task', id]),
    openMove: (id, blockId = null) => calls.open.push(['move', id, blockId]),
    openClock: (ref = null) => calls.open.push(['clock', ref]),
    closeOverlay: () => calls.open.push(['close']),
    toast: (msg, o) => calls.toast.push([msg, o]),
    fx: { burst: (el, c) => calls.fx.push(['burst', c]), stamp: (el, t) => calls.fx.push(['stamp', t]) },
    icon,
  };
  return { ctx, calls };
}

const find = (root, sel) => root.querySelector(sel);
const findAll = (root, sel) => root.querySelectorAll(sel);
const byText = (root, sel, re) => findAll(root, sel).find((el) => re.test(text(el)));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => dom.reset());

// ------------------------------------------------------------ icons
describe('icons', () => {
  test('icon() builds a 24px stroked svg with square caps', () => {
    const el = icon('check');
    assert.equal(el.localName, 'svg');
    assert.equal(el.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(el.getAttribute('stroke-width'), '2');
    assert.equal(el.getAttribute('stroke-linecap'), 'square');
    assert.equal(el.getAttribute('aria-hidden'), 'true');
    assert.ok(el.classList.contains('icon-check'));
    assert.ok(el.children.length >= 1);
  });
  test('every tab icon in main.js exists and each call is a fresh element', () => {
    for (const n of ['bolt', 'calendar', 'folder', 'trophy', 'list', 'settings']) assert.ok(ICON_NAMES.includes(n), n);
    assert.notEqual(icon('bolt'), icon('bolt'));
  });
  test('aliases resolve and unknown names fall back to a square', () => {
    assert.ok(icon('pencil').classList.contains('icon-edit'));
    assert.ok(hasIcon('gear'));
    const unk = icon('definitely-not-an-icon');
    assert.ok(unk.classList.contains('icon-unknown'));
    assert.equal(unk.children[0].localName, 'rect');
    assert.doesNotThrow(() => icon(null));
    assert.doesNotThrow(() => icon(undefined, null));
  });
  test('title option makes it a labelled image', () => {
    const el = icon('clock', { title: 'Clock', size: 18 });
    assert.equal(el.getAttribute('role'), 'img');
    assert.equal(el.getAttribute('aria-label'), 'Clock');
    assert.equal(el.getAttribute('width'), '18');
  });
});

// ------------------------------------------------------------ task rows
describe('taskRow', () => {
  test('chips: overdue, due today, est left, pushed, project', () => {
    const { ctx } = makeCtx();
    const s = ctx.state;
    const irb = taskRow(s.tasks.t_irb, ctx, { context: 'today', overdue: true });
    assert.match(text(irb), /OVERDUE 3D/);
    assert.ok(irb.classList.contains('is-overdue'));
    assert.equal(irb.dataset.taskId, 't_irb');
    const hw = taskRow(s.tasks.t_hw, ctx, { context: 'today' });
    assert.match(text(hw), /DUE TODAY/);
    assert.match(text(hw), /1H LEFT/);
    const big = taskRow({ ...s.tasks.t_big, moved: 3 }, ctx, { context: 'today' });
    assert.match(text(big), /PUSHED ×3/);
    assert.match(text(big), /DUE WED 10\/21/);
  });
  test('block rows show block minutes and carry the block id', () => {
    const { ctx } = makeCtx();
    const t = ctx.state.tasks.t_glm;
    const row = taskRow(t, ctx, { context: 'today', block: t.blocks[0] });
    assert.match(text(row), /BLOCK 1H/);
    assert.equal(row.dataset.blockId, 'b_glm1');
    assert.ok(row.classList.contains('is-block'));
  });
  test('carried rows say where they came from and push to tomorrow in one tap', () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_reimb, ctx, { context: 'today', carried: true });
    assert.match(text(row), /FROM FRI/);
    find(row, '.is-tmrw').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveTask', { id: 't_reimb', to: '2026-10-06' }]);
  });
  test('triage rows get Yes / Today / Drop', async () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_triage, ctx, { context: 'today', triage: true });
    const labels = findAll(row, '.trow-btn').map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(labels, ['Yes, it happened', 'Move to today', 'Drop it']);
    findAll(row, '.trow-btn')[1].click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveTask', { id: 't_triage', to: TODAY }]);
    findAll(row, '.trow-btn')[2].click();
    assert.equal(calls.act.at(-1)[0], 'dropTask');
    findAll(row, '.trow-btn')[0].click();
    assert.equal(calls.act.at(-1)[0], 'completeTask');
  });
  test('actions: start 5 min, push, edit, open by title', () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_email, ctx, { context: 'today' });
    find(row, '.is-clock').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['clockIn', { ref: 'task:t_email', title: 'Email Mike', cat: 'admin', goal: 5 }]);
    find(row, '.is-move').click();
    find(row, '.is-edit').click();
    find(row, '.trow-title').click();
    assert.deepEqual(calls.open, [['move', 't_email', null], ['task', 't_email'], ['task', 't_email']]);
  });
  test('checking a row fires fx at once and completes after the stamp; unchecking in time cancels', async () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_email, ctx, { context: 'today' });
    const check = find(row, '.check');
    check.click();
    assert.ok(row.classList.contains('is-completing'));
    assert.deepEqual(calls.fx, [['burst', 'var(--acid)'], ['stamp', 'DONE']]);
    assert.equal(calls.act.length, 0);
    await tick(COMPLETE_DELAY_MS + 30);
    assert.equal(calls.act.at(-1)[0], 'completeTask');
    assert.equal(typeof calls.act.at(-1)[2].undo, 'function');

    const row2 = taskRow(ctx.state.tasks.t_lab, ctx, { context: 'today' });
    const c2 = find(row2, '.check');
    c2.click();
    c2.click();
    await tick(COMPLETE_DELAY_MS + 30);
    assert.equal(calls.act.filter((a) => a[1]?.id === 't_lab').length, 0);
    assert.ok(!row2.classList.contains('is-completing'));
  });
  test('done rows: checked, struck, reopen on uncheck; block rows toggle the block', async () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_notes, ctx, { context: 'today' });
    assert.ok(row.classList.contains('is-done'));
    assert.equal(find(row, '.check').checked, true);
    assert.match(text(row), /DONE/);
    find(row, '.check').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['reopenTask', { id: 't_notes' }]);
    const t = ctx.state.tasks.t_glm;
    const brow = taskRow(t, ctx, { block: t.blocks[0] });
    find(brow, '.check').click();
    await tick(COMPLETE_DELAY_MS + 30);
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['toggleBlock', { id: 't_glm', blockId: 'b_glm1' }]);
  });
  test('read-only: the check reverts instead of stamping', async () => {
    const { ctx, calls } = makeCtx(undefined, { canWrite: false });
    const row = taskRow(ctx.state.tasks.t_email, ctx, {});
    const check = find(row, '.check');
    check.click();
    assert.equal(calls.fx.length, 0);
    await tick(5);
    assert.equal(check.checked, false);
  });
  test('odd input never throws', () => {
    const { ctx } = makeCtx();
    for (const t of [null, undefined, {}, { id: 't_x' }, { id: 't_y', title: '', due: 'garbage', est: 'lots', subs: 'nope', blocks: null, prio: 9, moved: -1 }]) {
      assert.doesNotThrow(() => taskRow(t, ctx, { context: 'today' }));
    }
    assert.doesNotThrow(() => taskRow({ id: 't_z', title: 'x' }, { today: TODAY }, null));
    assert.match(text(taskRow({}, ctx)), /Untitled/);
  });
  test('dueChip and dayTag helpers', () => {
    assert.equal(text(dueChip('2026-10-09', TODAY)), 'DUE FRI');
    assert.equal(text(dueChip('2026-10-06', TODAY)), 'DUE TMRW');
    assert.equal(text(dueChip('2026-10-16', TODAY)), 'DUE FRI 10/16');
    assert.equal(dueChip('nope', TODAY), null);
    assert.equal(dayTag('2026-10-05', TODAY), 'TODAY');
    assert.equal(dayTag('2026-10-07', TODAY), 'WED');
  });
});

// ------------------------------------------------------------ today
describe('renderToday', () => {
  test('sections in contract order with counts', () => {
    const { ctx } = makeCtx();
    const el = renderToday(ctx);
    const labels = findAll(el, '.tsec-head .tsec-label').map(text);
    assert.deepEqual(labels, ['Did these happen?', 'Overdue', 'Due today', 'Meetings', 'Planned', 'Work blocks', 'Rolled over']);
    assert.ok(find(el, '.tone-crit .hazard'), 'overdue has a hazard stripe');
    assert.ok(find(el, '.trow.is-triage'));
    assert.match(text(el), /FROM FRI/);
    assert.match(text(find(el, '.today-num')), /^1\/\d+$/);
  });
  test('done today is collapsed to a count and expands via ui', () => {
    const { ctx, calls } = makeCtx();
    let el = renderToday(ctx);
    const toggle = find(el, '.tsec-toggle');
    assert.match(words(toggle), /Done today 01/);
    assert.equal(findAll(el, '.tsec-done .trow').length, 0);
    toggle.click();
    assert.deepEqual(calls.ui.at(-1), { todayDoneOpen: true });
    el = renderToday(ctx);
    assert.equal(findAll(el, '.tsec-done .trow').length, 1);
  });
  test('empty board shows the sticker', () => {
    const { ctx } = makeCtx(withCats(emptyState()));
    const el = renderToday(ctx);
    assert.match(text(el), /Clear board\./);
    assert.equal(findAll(el, '.trow').length, 0);
  });
  test('survives a missing vm', () => {
    const { ctx } = makeCtx();
    assert.doesNotThrow(() => renderToday({ ...ctx, vm: {} }));
    assert.doesNotThrow(() => renderToday({ ...ctx, vm: { today: { overdue: null, counts: null } } }));
  });
});

// ------------------------------------------------------------ brief
describe('renderBrief', () => {
  test('no brief → prompt to message Claude', () => {
    const { ctx } = makeCtx();
    assert.match(text(renderBrief(ctx)), /No check-in yet/);
  });
  test('headline, lines, asks, focus and freshness', () => {
    const base = withCats(fixture());
    const state = { ...base, brief: { at: '2026-10-05T12:00:00.000Z', headline: '3 things today.', lines: ['RSA is due Thu.'], asks: ['Did ABCD happen?'], focus: ['t_email', 't_gone'] } };
    const { ctx, calls } = makeCtx(state);
    const el = renderBrief(ctx);
    assert.match(text(el), /3 things today\./);
    assert.match(text(el), /RSA is due Thu\./);
    assert.match(text(find(el, '.brief-asks')), /\?\s*Did ABCD happen\?/);
    assert.match(text(el), /updated 2h ago/);
    const focus = findAll(el, '.brief-focus-btn');
    assert.equal(focus.length, 1);
    focus[0].click();
    assert.deepEqual(calls.open.at(-1), ['task', 't_email']);
    assert.ok(!find(el, '.brief-card').classList.contains('is-stale'));
  });
  test('stale brief is marked', () => {
    const state = { ...withCats(fixture()), brief: { at: '2026-10-03T12:00:00.000Z', headline: 'old', lines: [], asks: [], focus: [] } };
    const { ctx } = makeCtx(state);
    const el = renderBrief(ctx);
    assert.ok(find(el, '.brief-card').classList.contains('is-stale'));
  });
  test('updatedAgo', () => {
    const ctx = { now: NOW, today: TODAY, tz: 'America/New_York' };
    assert.equal(updatedAgo('2026-10-05T13:59:40.000Z', ctx), 'just now');
    assert.equal(updatedAgo('2026-10-05T13:15:00.000Z', ctx), '45m ago');
    assert.equal(updatedAgo('2026-10-04T23:00:00.000Z', ctx), 'yesterday 7pm');
    assert.equal(updatedAgo('nope', ctx), '');
  });
});

// ------------------------------------------------------------ deadlines
describe('renderDeadlines', () => {
  test('rows with countdowns, statuses and auto-plan', () => {
    const { ctx, calls } = makeCtx();
    const el = renderDeadlines(ctx);
    const rows = findAll(el, '.dl-row');
    assert.equal(rows.length, ctx.vm.deadlines.length);
    assert.ok(rows.length > 0);
    assert.match(text(el), /Incoming/);
    const due = ctx.vm.deadlines.map((d) => d.status);
    for (const st of due) assert.ok(find(el, `.st-${st}`), st);
    const plan = find(el, '.dl-plan:not(.btn-ghost)');
    if (plan) {
      plan.click();
      const last = calls.act.at(-1) ?? calls.toast.at(-1);
      assert.ok(last);
    }
    const est = findAll(el, '.dl-plan.btn-ghost')[0];
    if (est) {
      est.click();
      assert.equal(calls.open.at(-1)[0], 'task');
    }
  });
  test('empty → wide open; overbooked risks show as hazard lines', () => {
    const { ctx } = makeCtx(withCats(emptyState()));
    assert.match(text(renderDeadlines(ctx)), /Wide open/);
    const { ctx: c2 } = makeCtx();
    c2.vm = { ...c2.vm, risks: [{ type: 'overbooked', d: TODAY, message: 'Mon 10/5 is overbooked by 1h' }] };
    assert.match(text(renderDeadlines(c2)), /overbooked by 1h/);
  });
});

// ------------------------------------------------------------ overview
describe('renderOverview', () => {
  test('skeletons before load', () => {
    const { ctx } = makeCtx(undefined, { loaded: false });
    const el = renderOverview(ctx);
    assert.equal(findAll(el, '.skel').length, 7);
    assert.equal(findAll(el, '.ov-cell').length, 7);
  });
  test('loaded: seven areas in phone order, never throws', () => {
    const { ctx } = makeCtx();
    const el = renderOverview(ctx);
    const areas = findAll(el, '.ov-cell').map((c) => c.className.replace('ov-cell', '').trim());
    assert.deepEqual(areas, ['ov-today', 'ov-brief', 'ov-chores', 'ov-cal', 'ov-dead', 'ov-proj', 'ov-wins']);
    assert.ok(find(el, '.ov-today .today'));
    const { ctx: empty } = makeCtx(withCats(emptyState()));
    assert.doesNotThrow(() => renderOverview(empty));
  });
});

// ------------------------------------------------------------ overlays
describe('drawer', () => {
  test('missing task renders a "gone" sheet', () => {
    const { ctx } = makeCtx(undefined, { ui: { drawer: { taskId: 't_nope' } } });
    assert.match(text(renderDrawer(ctx)), /Gone\./);
  });
  test('fields reflect the task and commit on change', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_predis' } } });
    const el = renderDrawer(ctx);
    assert.ok(find(el, '.overlay-backdrop'));
    assert.equal(find(el, '#dr-title').value, 'Predis lit review');
    assert.equal(find(el, '#dr-due').value, '2026-10-12');
    assert.equal(find(el, '#dr-est').value, '5h');
    assert.equal(find(el, '#dr-cat').value, 'predis');
    assert.equal(findAll(el, '.dr-block').length, 3);
    assert.equal(find(el, '#dr-prio-1').getAttribute('aria-pressed'), 'true');

    const title = find(el, '#dr-title');
    title.value = 'Predis lit review v2';
    title.dispatchEvent(new Event('input'));
    assert.equal(ctx.ui.drawerDraft.values['dr-title'], 'Predis lit review v2');
    title.dispatchEvent(new Event('change'));
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { title: 'Predis lit review v2' } }]);
    assert.equal(ctx.ui.drawerDraft.values['dr-title'], undefined);

    const est = find(el, '#dr-est');
    est.value = 'a while';
    est.dispatchEvent(new Event('change'));
    assert.equal(calls.toast.at(-1)[1].kind, 'error');
    est.value = '1h30';
    est.dispatchEvent(new Event('change'));
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { est: 90 } }]);

    find(el, '#dr-prio-3').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { prio: 3 } }]);
    find(el, '#dr-plan').value = '';
    find(el, '#dr-due').value = '';
    find(el, '#dr-due').dispatchEvent(new Event('change'));
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { due: null } }]);
  });
  test('drafts survive a re-render; Enter commits once', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_email' }, drawerDraft: { taskId: 't_email', values: { 'dr-title': 'Email Mike re: grant', 'dr-notes': 'half-typed' } } } });
    const el = renderDrawer(ctx);
    assert.equal(find(el, '#dr-title').value, 'Email Mike re: grant');
    assert.equal(find(el, '#dr-notes').value, 'half-typed');
    const ev = new Event('keydown');
    ev.key = 'Enter';
    ev.preventDefault = () => {};
    find(el, '#dr-title').dispatchEvent(ev);
    find(el, '#dr-title').dispatchEvent(new Event('change'));
    assert.equal(calls.act.filter((a) => a[0] === 'editTask').length, 1);
    // another task's draft is ignored
    const { ctx: c2 } = makeCtx(undefined, { ui: { drawer: { taskId: 't_lab' }, drawerDraft: { taskId: 't_email', values: { 'dr-title': 'x' } } } });
    assert.equal(find(renderDrawer(c2), '#dr-title').value, 'Lab meeting');
  });
  test('subtasks, auto-plan, delete is two-step', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_big' } } });
    let el = renderDrawer(ctx);
    const sub = find(el, '#dr-sub-new');
    sub.value = 'Outline intro';
    find(el, '#dr-sub-add').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['addSub', { id: 't_big', t: 'Outline intro' }]);
    find(el, '#dr-autoplan').click();
    const last = calls.act.at(-1);
    assert.equal(last[0], 'applyAllocation');
    assert.ok(Array.isArray(last[1].updates.t_big));
    find(el, '#dr-delete').click();
    assert.deepEqual(calls.ui.at(-1), { drawerConfirm: 't_big' });
    el = renderDrawer(ctx);
    assert.match(text(find(el, '#dr-delete')), /Really delete\?/);
    find(el, '#dr-delete').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['deleteTask', { id: 't_big' }]);
  });
  test('auto-plan is disabled without an estimate + due date', () => {
    const { ctx } = makeCtx(undefined, { ui: { drawer: { taskId: 't_closet' } } });
    assert.equal(find(renderDrawer(ctx), '#dr-autoplan').disabled, true);
  });
  test('odd task data never throws', () => {
    const state = withCats(fixture());
    state.tasks = { ...state.tasks, t_odd: { id: 't_odd', title: null, cat: 'nope', subs: [null, 'x', { t: 3 }], blocks: [{}, null, { d: '2026-10-07', m: 'x' }], est: 'n/a', prio: 'hi' } };
    const { ctx } = makeCtx(state, { ui: { drawer: { taskId: 't_odd' } } });
    assert.doesNotThrow(() => renderDrawer(ctx));
  });
});

describe('move sheet', () => {
  test('quick picks resolve from Mon 10/5 and run moveTask', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { move: { taskId: 't_email', blockId: null } } });
    const el = renderMoveSheet(ctx);
    const picks = findAll(el, '.mv-quick').map((b) => words(b));
    assert.deepEqual(picks, ['Today Mon 10/5', 'Tomorrow Tue 10/6', '+2 days Wed 10/7', 'Next Mon Mon 10/12', 'This weekend Sat 10/10']);
    assert.equal(findAll(el, '.mv-day').length, 14);
    assert.ok(find(el, '#mv-d-2026-10-05').classList.contains('is-current'));
    find(el, '#mv-q-tomorrow').click();
    assert.equal(calls.open.at(-1)[0], 'close');
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveTask', { id: 't_email', to: '2026-10-06' }]);
    assert.match(calls.act.at(-1)[2].toast, /Pushed to Tue 10\/6/);
    find(el, '#mv-backlog').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveTask', { id: 't_email', to: null }]);
  });
  test('blocks move with moveBlock; a missing block says so', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { move: { taskId: 't_predis', blockId: 'b_p_auto' } } });
    const el = renderMoveSheet(ctx);
    find(el, '#mv-d-2026-10-08').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveBlock', { id: 't_predis', blockId: 'b_p_auto', to: '2026-10-08' }]);
    assert.equal(find(el, '#mv-backlog'), null);
    const { ctx: c2 } = makeCtx(undefined, { ui: { move: { taskId: 't_predis', blockId: 'b_zzz' } } });
    assert.match(text(renderMoveSheet(c2)), /Gone\./);
  });
});

describe('clock sheet', () => {
  test('due chores first, then today\'s tasks; tap starts the clock', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { clockSheet: { ref: null } } });
    const el = renderClockSheet(ctx);
    const items = findAll(el, '.ck-item');
    assert.ok(items.length > 2);
    assert.match(text(items[0]), /chore/);
    items[0].click();
    const [name, args] = calls.act.at(-1);
    assert.equal(name, 'clockIn');
    assert.match(args.ref, /^chore:/);
    assert.equal(args.goal, ctx.state.chores[args.ref.slice(6)].min);
  });
  test('a given ref becomes the primary button; goal picker and free text', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { clockSheet: { ref: 'task:t_hw' }, clockGoal: 15 } });
    const el = renderClockSheet(ctx);
    assert.match(text(find(el, '#ck-primary')), /Multivariate HW 3/);
    find(el, '#ck-primary').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['clockIn', { ref: 'task:t_hw', title: 'Multivariate HW 3', cat: 'multivar', goal: 15 }]);
    find(el, '#ck-goal-5').click();
    assert.deepEqual(calls.ui.at(-1), { clockGoal: 5 });
    const free = find(el, '#ck-free');
    free.value = 'Desk reset';
    find(el, '#ck-free-go').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['clockIn', { ref: 'free', title: 'Desk reset', cat: 'inbox', goal: 15 }]);
  });
});

// ------------------------------------------------------------ header
describe('header', () => {
  test('mounts once, previews the parse, adds on submit', async () => {
    const { ctx, calls } = makeCtx();
    const host = document.createElement('header');
    document.body.appendChild(host);
    const hdr = mountHeader(host, ctx);
    assert.equal(typeof hdr.update, 'function');
    assert.equal(typeof hdr.tick, 'function');
    assert.match(text(host), /EF\/\/CONSOLE/);
    const input = find(host, '#ef-quickadd');
    input.value = 'email mike - tomorrow ~10m';
    input.dispatchEvent(new Event('input'));
    const preview = text(find(host, '#ef-qa-preview'));
    assert.match(preview, /Email Mike/);
    assert.match(preview, /DO TUE 10\/6/);
    assert.match(preview, /~10M/);
    find(host, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(5);
    const [name, fields] = calls.act.at(-1);
    assert.equal(name, 'addTask');
    assert.equal(fields.title, 'Email Mike');
    assert.equal(fields.plan, '2026-10-06');
    assert.equal(fields.est, 10);
    assert.equal(input.value, '');
    assert.match(calls.toast.at(-1)[0], /Added: Email Mike → Tue 10\/6/);
    // update() keeps the very same input element
    hdr.update(ctx);
    assert.equal(find(host, '#ef-quickadd'), input);
  });
  test('new category and recurring previews', () => {
    const { ctx } = makeCtx();
    const host = document.createElement('header');
    mountHeader(host, ctx);
    const input = find(host, '#ef-quickadd');
    input.value = 'water cactus every 3 days #plantz';
    input.dispatchEvent(new Event('input'));
    const preview = text(find(host, '#ef-qa-preview'));
    assert.match(preview, /NEW CATEGORY: plantz/);
    assert.match(preview, /EVERY 3D CHORE/);
  });
  test('vitals and sync light', () => {
    const { ctx } = makeCtx();
    const host = document.createElement('header');
    mountHeader(host, ctx);
    const vitals = words(find(host, '.hdr-vitals'));
    assert.match(vitals, /Today 1 \/ \d+ done/);
    assert.match(vitals, /Overdue 01 late \+1 to triage/);
    assert.match(vitals, /Due 7d 04 due next: today · Multivariate HW 3/);
    assert.match(vitals, /Streak \d+ days best \d+/);
    assert.match(text(find(host, '.hdr-sync')), /SAVED LOCAL/);
    assert.match(words(find(host, '.hdr-sub')), /^DANNY \/\/ MON 10\.05 \/\/ \d\d:\d\d:\d\d ET$/);
  });
  test('clock widget: start button, then a running clock', () => {
    const { ctx, calls } = makeCtx();
    const host = document.createElement('header');
    const hdr = mountHeader(host, ctx);
    find(host, '.clk-start').click();
    assert.deepEqual(calls.open.at(-1), ['clock', null]);
    const start = new Date(Date.now() - 6 * 60000).toISOString();
    const running = { ...ctx, state: { ...ctx.state, clock: { active: true, ref: 'chore:c_laundry', title: 'Laundry', cat: 'home', start, goal: 5 } } };
    hdr.update(running);
    hdr.tick(running);
    assert.match(text(find(host, '.clk')), /5 min done\. keep going\?/);
    assert.match(text(find(host, '.clk-time')), /^06:0\d$/);
    find(host, '.clk-stop').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['clockOut', { markDone: false }]);
  });
  test('loading and read-only states', () => {
    const { ctx } = makeCtx(withCats(emptyState()), { loaded: false, canWrite: false });
    ctx.store = { mode: 'readonly', status: { kind: 'readonly' }, canWrite: false, refresh() {} };
    const host = document.createElement('header');
    mountHeader(host, ctx);
    assert.match(text(find(host, '.hdr-vitals')), /--/);
    assert.match(text(find(host, '.hdr-sync')), /READ-ONLY/);
    assert.equal(find(host, '.hdr-connect').hidden, false);
    assert.match(find(host, '#ef-quickadd').getAttribute('placeholder'), /read-only/);
  });
});

// ------------------------------------------------------------ fx
describe('fx', () => {
  test('burst adds ~14 bits and cleans up; stamp adds a stamp', async () => {
    const el = document.createElement('div');
    el.appendChild(document.createElement('input')).className = 'check';
    burst(el, 'var(--acid)');
    assert.equal(document.body.querySelectorAll('.fx-bit').length, 14);
    stamp(el, 'DONE');
    assert.equal(text(document.body.querySelector('.fx-stamp')), 'DONE');
    await tick(1200);
    assert.equal(document.body.querySelectorAll('.fx-bit').length, 0);
    assert.equal(document.body.querySelectorAll('.fx-stamp').length, 0);
  });
  test('reduced motion: no burst, static stamp; junk input is ignored', () => {
    dom.media.reducedMotion = true;
    try {
      const el = document.createElement('div');
      burst(el);
      assert.equal(document.body.querySelectorAll('.fx-bit').length, 0);
      stamp(el, 'DONE');
      assert.ok(document.body.querySelector('.fx-stamp').classList.contains('is-static'));
      assert.doesNotThrow(() => burst(null));
      assert.doesNotThrow(() => stamp(undefined));
    } finally {
      dom.media.reducedMotion = false;
    }
  });
});

// ------------------------------------------------------------ regression: review findings
const frames = async (n = 3) => { for (let i = 0; i < n; i++) await tick(2); };
const keydown = (el, key) => {
  const ev = new Event('keydown');
  ev.key = key;
  el.dispatchEvent(ev);
  return ev;
};

/** A store shaped like githubstore's public API, driven by the test. */
function fakeStore(options) {
  const subs = new Set();
  const statusSubs = new Set();
  let state = null;
  let resolveLoad;
  let rejectLoad;
  const loading = new Promise((res, rej) => { resolveLoad = res; rejectLoad = rej; });
  loading.catch(() => {});
  const store = {
    mode: 'github',
    options,
    applied: [],
    load: () => loading,
    subscribe(fn) { subs.add(fn); if (state) fn(state); return () => subs.delete(fn); },
    onStatus(fn) { statusSubs.add(fn); return () => statusSubs.delete(fn); },
    async apply(writes) {
      store.applied.push(...writes);
      state = applyWrites(state ?? emptyState(), writes);
      for (const fn of [...subs]) fn(state);
      return state;
    },
    refresh() {},
    getState: () => state,
    dispose() { store.disposed = true; },
    // test controls
    deliver(s, { resolve = true } = {}) {
      state = s;
      for (const fn of [...subs]) fn(s);
      if (resolve) resolveLoad(s);
    },
    status(kind, message = '') { for (const fn of [...statusSubs]) fn({ kind, at: NOW, message }); },
    fail(message) { rejectLoad(Object.assign(new Error(message), { status: 401 })); },
  };
  return store;
}

async function bootApp() {
  window.localStorage.removeItem('ef.gh.token');
  window.localStorage.removeItem('ef.gh.config');
  const shell = mountAppShell(document);
  const stores = [];
  const app = boot(document, { createStore: (o) => { const s = fakeStore(o); stores.push(s); return s; } });
  await frames();
  return { app, shell, stores, store: () => stores.at(-1) };
}

describe('regression: writes wait for the board (UI-1, SYNC-1, UI-2)', () => {
  test('UI-1: "#rsa" quick-added while loading is refused, then files into the loaded RSA category', async () => {
    const { app, shell, store } = await bootApp();
    try {
      const input = find(shell.header, '#ef-quickadd');
      input.value = 'fix figure 2 #rsa';
      input.dispatchEvent(new Event('input'));
      const preview = text(find(shell.header, '#ef-qa-preview'));
      assert.doesNotMatch(preview, /NEW CATEGORY/, 'no "new category" guess against an empty board');
      assert.match(preview, /LOADING BOARD/);
      find(shell.header, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
      await frames();
      assert.equal(store().applied.length, 0, 'nothing reaches the store before the board loads');
      assert.match(text(shell.toasts), /Still loading your board…/);
      assert.equal(input.value, 'fix figure 2 #rsa', 'the typed line is kept');

      store().deliver(withCats(fixture()));
      store().status('synced', 'Synced with GitHub.');
      await frames();
      assert.match(text(find(shell.header, '#ef-qa-preview')), /RSA/);
      assert.doesNotMatch(text(find(shell.header, '#ef-qa-preview')), /NEW CATEGORY/);
      find(shell.header, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
      await frames();
      const writes = store().applied;
      assert.ok(!writes.some((w) => w.col === 'cats'), 'the RSA category is never rewritten');
      const task = writes.find((w) => w.col === 'tasks' && w.op === 'set');
      assert.equal(task.data.cat, 'rsa');
      assert.equal(task.data.title, 'Fix figure 2');
    } finally {
      app.dispose();
    }
  });

  test('SYNC-1: every action (clock, check-off, edits) is refused until the first state arrives', async () => {
    const { app, store } = await bootApp();
    try {
      for (const [name, args] of [['clockIn', { ref: 'free', title: 'Desk reset', goal: 5 }], ['addCategory', { name: 'Manuscripts' }], ['editSettings', { patch: { cap: { mon: 90 } } }]]) {
        assert.equal(await app.act(name, args), null, name);
      }
      assert.equal(store().applied.length, 0);
    } finally {
      app.dispose();
    }
  });

  test('UI-2: a rejected token refuses writes instead of applying them to an empty board, even with a read-only fallback', async () => {
    const { app, shell, store } = await bootApp();
    try {
      store().status('error', 'GitHub rejected the token. Check Setup.');
      store().fail('GitHub rejected the token. Check Setup.');
      await frames();
      assert.equal(await app.act('addTask', { title: 'Call Mom', plan: TODAY }), null);
      assert.match(text(shell.toasts), /Still loading your board… GitHub rejected the token/);
      assert.equal(store().applied.length, 0);
      assert.doesNotMatch(text(shell.toasts), /Added/);
      // the store shows the real board read-only, still in error: writes stay off
      store().deliver(withCats(fixture()), { resolve: false });
      await frames();
      assert.ok(app.loaded);
      assert.equal(await app.act('addTask', { title: 'Call Mom', plan: TODAY }), null);
      assert.equal(store().applied.length, 0);
      // GitHub answers again: writes flow
      store().status('synced', 'Synced with GitHub.');
      const res = await app.act('addTask', { title: 'Call Mom', plan: TODAY });
      assert.ok(res && res.writes.length);
      assert.ok(store().applied.some((w) => w.col === 'tasks'));
    } finally {
      app.dispose();
    }
  });

  test('UI-2: the store\'s isLoaded() is the last word; a not_loaded rejection toasts the store\'s own message', async () => {
    const { app, shell, store } = await bootApp();
    try {
      let loaded = false;
      store().isLoaded = () => loaded;
      // read-only fallback on screen, then a poll reports "offline" (not "error"): still no base to write on
      store().deliver(withCats(fixture()), { resolve: false });
      store().status('offline', 'Offline. Changes will sync when you reconnect.');
      await frames();
      assert.equal(await app.act('addTask', { title: 'Call Mom', plan: TODAY }), null);
      assert.equal(store().applied.length, 0);
      assert.match(text(shell.toasts), /Still loading your board…/);
      // the store loads for real: writes flow
      loaded = true;
      store().status('synced', 'Synced with GitHub.');
      assert.ok(await app.act('addTask', { title: 'Call Mom', plan: TODAY }));
      // a store that refuses anyway (race): its message, without "Couldn't save:"
      store().apply = () => Promise.reject(Object.assign(new Error('Still loading your board from GitHub. Try again in a moment.'), { code: 'not_loaded' }));
      assert.equal(await app.act('addTask', { title: 'Call Dad', plan: TODAY }), null);
      assert.match(text(shell.toasts), /Still loading your board from GitHub\. Try again in a moment\./);
      assert.doesNotMatch(text(shell.toasts), /Couldn't save: Still loading/);
    } finally {
      app.dispose();
    }
  });

  test('UI-2: when the first load fails the overview says why and offers Setup, instead of LOADING… forever', () => {
    const { ctx } = makeCtx(withCats(emptyState()), { loaded: false });
    let tab = null;
    ctx.setTab = (t) => { tab = t; };
    ctx.store = { ...ctx.store, mode: 'github', status: { kind: 'error', at: NOW, message: 'GitHub rejected the token. Check Setup.' } };
    const el = renderOverview(ctx);
    assert.match(text(el), /CAN'T LOAD YET/);
    assert.match(text(el), /GitHub rejected the token/);
    assert.doesNotMatch(text(el), /LOADING/);
    byText(el, 'button', /Setup/).click();
    assert.equal(tab, 'setup');
    // still just loading: the plain skeleton
    const { ctx: c2 } = makeCtx(withCats(emptyState()), { loaded: false });
    c2.store = { ...c2.store, status: { kind: 'loading', message: 'Loading…' } };
    assert.match(text(renderOverview(c2)), /LOADING/);
  });

  test('UI-2: a new token starts a new store that must load before anything is written', async () => {
    const { app, stores, store } = await bootApp();
    try {
      store().deliver(withCats(fixture()));
      await frames();
      assert.ok(await app.act('addTask', { title: 'One', plan: TODAY }));
      app.buildCtx().setToken('github_pat_FAKE');
      assert.equal(stores.length, 2);
      assert.equal(app.loaded, false);
      assert.equal(await app.act('addTask', { title: 'Two', plan: TODAY }), null);
      assert.equal(stores[1].applied.length, 0);
      assert.ok(stores[0].disposed);
    } finally {
      app.dispose();
    }
  });

  test('item 4: the GitHub store gets owner/repo/path and the noreply author + committer identity', async () => {
    const { app, store } = await bootApp();
    try {
      const o = store().options;
      assert.deepEqual(o.author, { name: 'Danny Zweben', email: '176344411+dzweben@users.noreply.github.com' });
      assert.deepEqual(DEFAULT_CONFIG.author, o.author);
      assert.equal(o.owner, 'dzweben');
      assert.equal(o.repo, 'ef-dashboard-management');
      assert.equal(o.path, 'data/state.json');
      assert.equal(o.token, null);
      // a saved repo config never drops or overrides the author
      app.buildCtx().saveConfig({ owner: 'someone', repo: 'r', branch: '', path: 'p.json', author: { name: 'X', email: 'x@gmail.com' } });
      assert.deepEqual(store().options.author, DEFAULT_CONFIG.author);
      assert.equal(store().options.owner, 'someone');
      assert.doesNotMatch(window.localStorage.getItem('ef.gh.config'), /author/);
    } finally {
      app.dispose();
    }
  });
});

describe('regression: re-renders never eat input (UI-3, UI-4, UI-6, UI-7, UI-10)', () => {
  test('UI-3: typing a date segment by segment commits once on blur, never year 0002', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_email' } } });
    const el = renderDrawer(ctx);
    document.body.appendChild(el);
    const due = find(el, '#dr-due');
    due.focus();
    // Chromium fires change each time a segment completes a valid date: 10/14/0002 … 2026
    for (const v of ['0002-10-14', '', '0020-10-14', '0202-10-14', '2026-10-14']) {
      keydown(due, '2');
      due.value = v;
      due.dispatchEvent(new Event('input'));
      due.dispatchEvent(new Event('change'));
    }
    assert.equal(calls.act.length, 0, 'nothing saved mid-typing');
    due.blur();
    assert.deepEqual(calls.act.map((a) => a.slice(0, 2)), [['editTask', { id: 't_email', patch: { due: '2026-10-14' } }]]);
  });

  test('UI-3: Enter commits the typed date; a year before 1900 is refused and reverted; a picker pick saves at once', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_predis' } } });
    const el = renderDrawer(ctx);
    document.body.appendChild(el);
    const plan = find(el, '#dr-plan');
    plan.focus();
    keydown(plan, 'ArrowRight');
    for (const v of ['', '2026-10-01', '2026-10-08']) {
      keydown(plan, '0');
      plan.value = v;
      plan.dispatchEvent(new Event('change'));
    }
    assert.equal(calls.act.length, 0);
    keydown(plan, 'Enter');
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { plan: '2026-10-08' } }]);

    const blk = find(el, '.dr-block input[type=date]');
    const before = blk.value;
    blk.focus();
    keydown(blk, '2');
    blk.value = '0002-06-05';
    blk.dispatchEvent(new Event('change'));
    blk.blur();
    assert.ok(!calls.act.some((a) => a[0] === 'moveBlock'), 'no block moved to year 0002');
    assert.equal(blk.value, before, 'reverted');
    assert.equal(calls.toast.at(-1)[1].kind, 'error');

    // native picker (no keys): commits on change, like before
    const due = find(el, '#dr-due');
    due.value = '2026-10-20';
    due.dispatchEvent(new Event('change'));
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_predis', patch: { due: '2026-10-20' } }]);
  });

  test('UI-3: isSaneDate', () => {
    assert.ok(isSaneDate('2026-10-14'));
    assert.ok(isSaneDate(''));
    assert.ok(!isSaneDate('', { required: true }));
    assert.ok(!isSaneDate('0002-10-14'));
    assert.ok(!isSaneDate('2026-02-30'));
    assert.ok(!isSaneDate('10/14/2026'));
  });

  test('UI-3: a re-render while a drawer date field is focused keeps that field (and its segment caret) until blur', async () => {
    const { app, shell, store } = await bootApp();
    try {
      const s = withCats(fixture());
      store().deliver(s);
      await frames();
      app.buildCtx().openTask('t_email');
      await frames();
      const plan = document.getElementById('dr-plan');
      plan.focus();
      keydown(plan, '1');
      // a sync status change / the minute tick lands mid-typing
      store().status('saving', 'Pushing 1 change…');
      store().deliver({ ...s, tasks: { ...s.tasks, t_lab: { ...s.tasks.t_lab, title: 'Lab meeting moved' } } });
      await frames();
      assert.ok(document.getElementById('dr-plan') === plan, 'the focused date field was not rebuilt');
      plan.blur();
      await frames();
      assert.ok(document.getElementById('dr-plan') !== plan, 'it catches up once focus leaves');
      assert.ok(shell.overlay.querySelector('.overlay-root'));
    } finally {
      app.dispose();
    }
  });

  test('UI-4: while the pointer is down nothing is re-rendered, so the click after a blur-commit hits the same Done button', async () => {
    const { app, shell, store } = await bootApp();
    try {
      store().deliver(withCats(fixture()));
      await frames();
      app.buildCtx().openTask('t_email');
      await frames();
      const notes = document.getElementById('dr-notes');
      notes.focus();
      notes.value = 'pinged her';
      notes.dispatchEvent(new Event('input'));
      const done = document.getElementById('dr-done');
      const sheet = shell.overlay.firstChild;
      // mousedown on Done: pointerdown, then the textarea blurs and commits
      document.dispatchEvent(new Event('pointerdown'));
      done.focus();
      notes.dispatchEvent(new Event('change'));
      await frames();
      assert.ok(store().applied.some((w) => w.col === 'tasks' && w.data?.notes === 'pinged her'), 'notes saved');
      assert.ok(shell.overlay.firstChild === sheet, 'drawer not rebuilt under the pressed pointer');
      assert.ok(done.isConnected, 'Done is still the element under the pointer');
      // mouseup + click
      document.dispatchEvent(new Event('pointerup'));
      document.dispatchEvent(new Event('click'));
      done.click();
      await frames(5);
      assert.equal(app.store.getState().tasks.t_email.status, 'done');
      assert.equal(app.ui.drawer, null);
      assert.equal(shell.overlay.hidden, true);
    } finally {
      app.dispose();
    }
  });

  test('UI-4: a press with no click releases the hold on its own', async () => {
    const { app, shell, store } = await bootApp();
    try {
      store().deliver(withCats(fixture()));
      await frames();
      const before = shell.main.firstChild;
      document.dispatchEvent(new Event('pointerdown'));
      store().status('synced', 'Pulled the latest from GitHub.');
      await frames();
      assert.ok(shell.main.firstChild === before, 'held while pressed');
      document.dispatchEvent(new Event('pointerup'));
      await tick(450);
      await frames();
      assert.ok(shell.main.firstChild !== before, 'released after pointerup with no click');
    } finally {
      app.dispose();
    }
  });

  test('UI-6: a Setup re-render mid-word keeps the typed name and caret, and saves the whole name once on leave', async () => {
    const { ctx, calls } = makeCtx();
    const host = document.createElement('main');
    host.id = 'ef-main';
    document.body.appendChild(host);
    mount(host, renderSetup(ctx));
    const name = find(host, '#cat-admin-name');
    name.focus();
    name.value = 'Admin stuff';
    name.dispatchEvent(new Event('input'));
    // the minute tick / a sync status re-renders the whole view; Chromium fires change+blur on the old field
    mount(host, renderSetup(ctx));
    await tick(0);
    assert.equal(calls.act.filter((a) => a[0] === 'editCategory').length, 0, 'the partial name is not saved');
    const twin = find(host, '#cat-admin-name');
    assert.ok(twin !== name, 'the view was rebuilt');
    assert.equal(twin.value, 'Admin stuff');
    assert.ok(document.activeElement === twin, 'focus is back in the field');
    assert.equal(twin.selectionStart, 11, 'caret stays at the end of what was typed');
    twin.value = 'Admin stuff more';
    twin.dispatchEvent(new Event('input'));
    twin.dispatchEvent(new Event('change'));
    twin.blur();
    const edits = calls.act.filter((a) => a[0] === 'editCategory');
    assert.deepEqual(edits.map((a) => a[1]), [{ id: 'admin', patch: { name: 'Admin stuff more' } }]);
    assert.equal(ctx.ui.drafts['cat-admin.name'], undefined, 'draft cleared after saving');
  });

  test('UI-6: leaving Setup with an edited field (the view goes away) still saves it', () => {
    const { ctx, calls } = makeCtx();
    const host = document.createElement('main');
    host.id = 'ef-main';
    document.body.appendChild(host);
    mount(host, renderSetup(ctx));
    const glyph = find(host, '#cat-home-glyph');
    glyph.focus();
    glyph.value = 'HO';
    glyph.dispatchEvent(new Event('input'));
    mount(host, document.createElement('div')); // tab switch on a phone: the field just disappears
    assert.deepEqual(calls.act.filter((a) => a[0] === 'editCategory').map((a) => a[1]), [{ id: 'home', patch: { glyph: 'HO' } }]);
  });

  test('dom.mount: a focused field swapped for a same-id twin reports isReplacing; one that goes away does not', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const a = document.createElement('input');
    a.id = 'f1';
    host.appendChild(a);
    const seen = [];
    a.addEventListener('blur', () => seen.push(isReplacing(a)));
    a.focus();
    const twin = document.createElement('input');
    twin.id = 'f1';
    mount(host, twin);
    twin.addEventListener('blur', () => seen.push(isReplacing(twin)));
    twin.focus();
    mount(host, document.createElement('p'));
    assert.deepEqual(seen, [true, false]);
    assert.equal(isReplacing(a), false, 'only during the swap');
  });

  test('UI-7: the move sheet keeps a picked date across a re-render and Move uses it', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { move: { taskId: 't_email', blockId: null } } });
    let el = renderMoveSheet(ctx);
    const d = find(el, '#mv-date');
    d.value = '2026-10-21';
    d.dispatchEvent(new Event('input'));
    el = renderMoveSheet(ctx); // minute tick / sync status
    assert.equal(find(el, '#mv-date').value, '2026-10-21');
    find(el, '#mv-go').click();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['moveTask', { id: 't_email', to: '2026-10-21' }]);
    // a fresh sheet starts from the task's own date again
    const { ctx: c2 } = makeCtx(undefined, { ui: { move: { taskId: 't_email', blockId: null } } });
    assert.equal(find(renderMoveSheet(c2), '#mv-date').value, '2026-10-05');
  });

  test('UI-10: a check-off waiting out its stamp survives a re-render, and unticking the new row cancels it', async () => {
    const { ctx, calls } = makeCtx();
    const row = taskRow(ctx.state.tasks.t_email, ctx, { context: 'today' });
    find(row, '.check').click();
    const twin = taskRow(ctx.state.tasks.t_email, ctx, { context: 'today' });
    assert.equal(find(twin, '.check').checked, true);
    assert.ok(twin.classList.contains('is-completing'));
    find(twin, '.check').click(); // untick: cancel
    assert.ok(!twin.classList.contains('is-completing'));
    await tick(COMPLETE_DELAY_MS + 30);
    assert.equal(calls.act.filter((a) => a[1]?.id === 't_email').length, 0);
    assert.equal(find(taskRow(ctx.state.tasks.t_email, ctx, {}), '.check').checked, false);

    // not cancelled: it still completes exactly once after the re-render
    find(taskRow(ctx.state.tasks.t_lab, ctx, {}), '.check').click();
    taskRow(ctx.state.tasks.t_lab, ctx, {});
    await tick(COMPLETE_DELAY_MS + 30);
    assert.deepEqual(calls.act.filter((a) => a[1]?.id === 't_lab').map((a) => a[0]), ['completeTask']);
  });
});

describe('regression: small UI fixes (UI-5, UI-8, UI-9, UI-11, UI-12, UI-13)', () => {
  test('UI-8: closing the drawer disarms "Really delete?"', async () => {
    const { app, store } = await bootApp();
    try {
      store().deliver(withCats(fixture()));
      await frames();
      for (const close of [() => document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })), () => app.buildCtx().closeOverlay(), () => app.buildCtx().openMove('t_email')]) {
        app.buildCtx().openTask('t_email');
        await frames();
        document.getElementById('dr-delete').click();
        await frames();
        assert.match(text(document.getElementById('dr-delete')), /Really delete\?/);
        close();
        await frames();
        assert.equal(app.ui.drawerConfirm, null, 'closing disarms it');
        app.buildCtx().openTask('t_email');
        await frames();
        assert.equal(text(document.getElementById('dr-delete')), 'Delete');
        document.getElementById('dr-delete').click(); // one click only arms it again
        await frames();
        assert.equal(app.store.getState().tasks.t_email.status, 'todo');
        assert.ok(app.store.getState().tasks.t_email);
        app.buildCtx().closeOverlay();
        await frames();
      }
    } finally {
      app.dispose();
    }
  });

  test('UI-9: undo after triage Yes / Drop puts the task back in "Did these happen?"', () => {
    const c = { now: NOW, today: TODAY, src: 'dash' };
    for (const btn of [0, 2]) {
      const { ctx, calls } = makeCtx();
      const row = taskRow(ctx.state.tasks.t_triage, ctx, { context: 'today', triage: true });
      findAll(row, '.trow-btn')[btn].click();
      const [op, args, opts] = calls.act.at(-1);
      opts.undo();
      const [undoOp, undoArgs] = calls.act.at(-1);
      let st = OPS[op](ctx.state, args, c).state;
      assert.equal(st.tasks.t_triage.triage, false);
      st = OPS[undoOp](st, undoArgs, c).state;
      assert.equal(st.tasks.t_triage.status, 'todo');
      assert.equal(st.tasks.t_triage.triage, true);
      assert.equal(st.tasks.t_triage.doneAt, null);
      assert.ok(todayView(st, TODAY).triage.some((t) => t.id === 't_triage'), `${op} → undo → back in triage`);
    }
    // ordinary rows keep the plain reopen
    const calls = [];
    reopenUndo((...a) => calls.push(a), { id: 't_email', triage: false })();
    assert.deepEqual(calls, [['reopenTask', { id: 't_email' }]]);
  });

  test('UI-9: the drawer\'s Done undo also restores triage', () => {
    const { ctx, calls } = makeCtx(undefined, { ui: { drawer: { taskId: 't_triage' } } });
    find(renderDrawer(ctx), '#dr-done').click();
    calls.act.at(-1)[2].undo();
    assert.deepEqual(calls.act.at(-1).slice(0, 2), ['editTask', { id: 't_triage', patch: { status: 'todo', triage: true } }]);
  });

  test('UI-11: the quick-add preview files an untagged chore under Home, like addChore does', () => {
    const { ctx } = makeCtx();
    const host = document.createElement('header');
    mountHeader(host, ctx);
    const input = find(host, '#ef-quickadd');
    input.value = 'water the cactus every 3 days';
    input.dispatchEvent(new Event('input'));
    const preview = text(find(host, '#ef-qa-preview'));
    assert.match(preview, /HOME/);
    assert.doesNotMatch(preview, /INBOX/);
    assert.match(preview, /EVERY 3D CHORE/);
    const saved = OPS.addTask(ctx.state, { title: 'Water the cactus', cat: 'inbox', recurring: { every: 3, perDay: 1 } }, { now: NOW, today: TODAY, src: 'dash' });
    const chore = saved.writes.find((w) => w.col === 'chores');
    assert.equal(chore.data.cat, 'home', 'preview matches what is saved');
    // a one-off untagged task still says inbox
    input.value = 'think about stuff';
    input.dispatchEvent(new Event('input'));
    assert.match(text(find(host, '#ef-qa-preview')), /INBOX/);
  });

  test('UI-1: the header preview says LOADING instead of guessing "new category" before the board loads', () => {
    const { ctx } = makeCtx(withCats(emptyState()), { loaded: false });
    ctx.state.cats = { inbox: ctx.state.cats.inbox };
    const host = document.createElement('header');
    mountHeader(host, ctx);
    const input = find(host, '#ef-quickadd');
    assert.match(input.getAttribute('placeholder'), /loading your board/);
    input.value = 'fix figure 2 #rsa';
    input.dispatchEvent(new Event('input'));
    assert.doesNotMatch(text(find(host, '#ef-qa-preview')), /NEW CATEGORY/);
  });

  test('UI-5: pinned triage actions never move on hover / focus', () => {
    const rules = css('taskrow.css').match(/[^{}]*\{[^{}]*translate\(0, -50%\)[^{}]*\}/g) ?? [];
    assert.ok(rules.length >= 1);
    for (const r of rules) {
      const selectors = r.slice(0, r.indexOf('{')).split(',').map((x) => x.trim()).filter((x) => /trow-acts/.test(x));
      for (const sel of selectors) assert.match(sel, /\.trow-acts:not\(\.is-pinned\)/, `"${sel}" would shift the pinned triage bar`);
    }
  });

  test('UI-12: an open side drawer moves the toasts beside it', async () => {
    const rule = css('base.css').match(/@media \(min-width: 721px\)\s*\{\s*\.toasts\.is-beside-sheet\s*\{([^}]*)\}/);
    assert.ok(rule, 'base.css offsets .toasts.is-beside-sheet from 721px');
    assert.match(rule[1], /left: calc\(\(100vw - 468px\) \/ 2\)/);
    const { app, shell, store } = await bootApp();
    try {
      store().deliver(withCats(fixture()));
      await frames();
      assert.ok(!shell.toasts.classList.contains('is-beside-sheet'));
      app.buildCtx().openTask('t_email');
      await frames();
      assert.ok(shell.toasts.classList.contains('is-beside-sheet'));
      app.buildCtx().openMove('t_email'); // centered sheet: no offset
      await frames();
      assert.ok(!shell.toasts.classList.contains('is-beside-sheet'));
    } finally {
      app.dispose();
    }
  });

  test('UI-13: the Load vital wraps its cap under the number instead of clipping it', () => {
    assert.match(css('header.css'), /\.v-load \.vital-val\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  test('UI-13: move-sheet quick-pick labels ("TOMORROW") scale with their button and never run past it', () => {
    const d = css('drawer.css');
    assert.match(d, /\.mv-quick\s*\{[^}]*container-type:\s*inline-size/);
    const label = d.match(/\.mv-quick-label\s*\{([^}]*)\}/)[1];
    assert.match(label, /font-size:\s*min\(1\.15rem,\s*\d+cqi\)/, 'shrinks with the button, never grows past 1.15rem');
    assert.match(label, /overflow-wrap:\s*anywhere/, 'a wider fallback font wraps inside the button');
  });
});
