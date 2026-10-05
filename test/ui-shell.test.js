// UI tests for the header, task rows, Today, brief, deadlines, overview, overlays,
// icons and fx, rendered into a tiny fake DOM (test/fixtures/ui-dom.js).
// "Today" is Mon 2026-10-05, America/New_York.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, words } from './fixtures/ui-dom.js';

const dom = installDom();

const { fixture, TODAY, NOW } = await import('./fixtures/engine-fixture.js');
const { DEFAULT_CATEGORIES } = await import('../src/engine/defaults.js');
const { normalizeCategory, INBOX_CATEGORY, emptyState } = await import('../src/engine/model.js');
const { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } = await import('../src/engine/views.js');
const { risks } = await import('../src/engine/schedule.js');
const { streak, weekStats, heatmap, wins } = await import('../src/engine/stats.js');
const { icon, ICON_NAMES, hasIcon } = await import('../src/ui/icons.js');
const { taskRow, COMPLETE_DELAY_MS, dueChip, dayTag } = await import('../src/ui/views/taskrow.js');
const { renderToday } = await import('../src/ui/views/today.js');
const { renderBrief, updatedAgo } = await import('../src/ui/views/brief.js');
const { renderDeadlines } = await import('../src/ui/views/deadlines.js');
const { renderOverview } = await import('../src/ui/views/overview.js');
const { renderDrawer, renderMoveSheet, renderClockSheet } = await import('../src/ui/views/drawer.js');
const { mountHeader } = await import('../src/ui/views/header.js');
const { burst, stamp } = await import('../src/ui/fx/burst.js');

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
