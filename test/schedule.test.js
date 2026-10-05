import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  capacityFor, remaining, allocatedFuture, shortfall, dayLoad, dayLoads, runway, allocate, risks, planStart, isPastEvent,
} from '../src/engine/schedule.js';
import { normalizeSettings } from '../src/engine/model.js';
import { diffDays } from '../src/engine/dates.js';
import { fixture, makeState, TODAY, deepFreeze, withBlocks } from './fixtures/engine-fixture.js';

const sum = (blocks) => blocks.reduce((s, b) => s + b.m, 0);
const undoneFuture = (blocks, today = TODAY) => sum(blocks.filter((b) => !b.done && b.d >= today));
const dm = (blocks) => blocks.map((b) => `${b.d}:${b.m}`);
const ALL60 = { cap: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 60, sun: 60 } };

describe('capacityFor', () => {
  const s = normalizeSettings({ offDays: ['2026-10-07'] });
  test('weekday caps from settings', () => {
    assert.equal(capacityFor(s, '2026-10-05'), 240); // Mon
    assert.equal(capacityFor(s, '2026-10-09'), 180); // Fri
    assert.equal(capacityFor(s, '2026-10-10'), 90); // Sat
    assert.equal(capacityFor(s, '2026-10-11'), 150); // Sun
  });
  test('0 on offDays and on garbage dates', () => {
    assert.equal(capacityFor(s, '2026-10-07'), 0);
    assert.equal(capacityFor(s, 'nope'), 0);
    assert.equal(capacityFor(s, null), 0);
  });
  test('missing settings fall back to defaults', () => {
    assert.equal(capacityFor(undefined, '2026-10-05'), 240);
    assert.equal(capacityFor({ cap: { mon: 30 } }, '2026-10-05'), 30);
    assert.equal(capacityFor({ cap: { mon: 30 } }, '2026-10-06'), 240);
  });
  test('CLI-10: a one-day capOverride replaces that date only; offDays still win', () => {
    const o = normalizeSettings({ offDays: ['2026-10-07'], capOverrides: { '2026-10-06': 90, '2026-10-07': 200, '2026-10-08': 0 } });
    assert.equal(capacityFor(o, '2026-10-06'), 90, 'Tue 10/6 only');
    assert.equal(capacityFor(o, '2026-10-13'), 240, 'next Tuesday keeps the weekly cap');
    assert.equal(capacityFor(o, '2026-10-07'), 0, 'an off day stays off');
    assert.equal(capacityFor(o, '2026-10-08'), 0, 'an override of 0 is honoured');
    const st = makeState({ settings: o });
    assert.equal(dayLoad(st, '2026-10-06').cap, 90, 'dayLoad / the calendar use the override');
  });
});

describe('remaining / allocatedFuture / shortfall', () => {
  const t = {
    est: 300, spent: 60,
    blocks: [
      { id: 'a', d: '2026-10-02', m: 60, done: true, auto: true },
      { id: 'b', d: '2026-10-04', m: 30, done: false, auto: true }, // past, missed
      { id: 'c', d: '2026-10-05', m: 45, done: false, auto: true },
      { id: 'd', d: '2026-10-08', m: 90, done: false, auto: false },
    ],
  };
  test('remaining is est − spent, floored at 0', () => {
    assert.equal(remaining(t), 240);
    assert.equal(remaining({ est: 30, spent: 50 }), 0);
    assert.equal(remaining({ est: null, spent: 0 }), 0);
    assert.equal(remaining(null), 0);
  });
  test('allocatedFuture counts undone blocks on/after today only', () => {
    assert.equal(allocatedFuture(t, TODAY), 135);
    assert.equal(allocatedFuture({}, TODAY), 0);
  });
  test('shortfall = remaining − allocatedFuture; null without est', () => {
    assert.equal(shortfall(t, TODAY), 105);
    assert.equal(shortfall({ est: 30, blocks: [{ id: 'x', d: TODAY, m: 60 }] }, TODAY), -30);
    assert.equal(shortfall({ est: null }, TODAY), null);
  });
});

describe('dayLoad', () => {
  const st = fixture();
  test('planned counts plan-day tasks without undone blocks; blocks counts undone blocks', () => {
    const l = dayLoad(st, TODAY);
    // Lab meeting 60 + Email Mike 10 planned; GLM block 60. Dropped task ignored.
    assert.deepEqual(l, { d: TODAY, planned: 70, blocks: 60, total: 130, cap: 240, free: 110, ratio: 130 / 240 });
  });
  test('est null uses defaultEst; spent is subtracted', () => {
    // Thu: mentee meeting (no est → 20) + RA tutorial 120 + groceries 45.
    assert.equal(dayLoad(st, '2026-10-08').planned, 185);
    const s2 = makeState({ tasks: [{ id: 'a', plan: TODAY, est: 90, spent: 30 }, { id: 'b', plan: TODAY, est: 20, spent: 50 }] });
    assert.equal(dayLoad(s2, TODAY).planned, 60);
  });
  test('a task with undone blocks does not also count on its plan day', () => {
    const s2 = makeState({ tasks: [{ id: 'a', plan: TODAY, est: 200, blocks: [{ id: 'b1', d: '2026-10-06', m: 60 }] }] });
    assert.equal(dayLoad(s2, TODAY).total, 0);
    assert.equal(dayLoad(s2, '2026-10-06').blocks, 60);
  });
  test('done tasks and done blocks add no load', () => {
    const s2 = makeState({ tasks: [
      { id: 'a', plan: TODAY, est: 60, status: 'done', doneAt: '2026-10-05T15:00:00.000Z' },
      { id: 'b', est: 200, due: '2026-10-09', blocks: [{ id: 'x', d: TODAY, m: 60, done: true }] },
    ] });
    assert.equal(dayLoad(s2, TODAY).total, 0);
  });
  test('off day: cap 0, ratio Infinity only when something is scheduled', () => {
    const l = dayLoad(st, '2026-10-10');
    assert.equal(l.cap, 0);
    assert.equal(l.free, 0);
    assert.equal(l.ratio, 0);
    const s2 = makeState({ settings: { offDays: [TODAY] }, tasks: [{ id: 'a', plan: TODAY, est: 30 }] });
    assert.equal(dayLoad(s2, TODAY).ratio, Infinity);
  });
  test('dayLoads matches dayLoad', () => {
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
    assert.deepEqual(dayLoads(st, days), days.map((d) => dayLoad(st, d)));
  });
  test('empty and garbage state do not throw', () => {
    assert.equal(dayLoad({}, TODAY).total, 0);
    assert.equal(dayLoad(null, TODAY).cap, 240);
    assert.equal(dayLoad({ tasks: { x: null, y: { plan: TODAY, blocks: 'nope' } } }, TODAY).planned, 20);
  });
});

describe('runway', () => {
  test('free minutes before due exclude the task’s own load', () => {
    const st = fixture();
    // Predis: Mon 110 + Tue 180 + Wed 150 + Thu 55 + Fri 180 + Sat(off) 0 + Sun 150.
    assert.deepEqual(runway(st, st.tasks.t_predis, TODAY), { available: 825, deficit: 0 });
  });
  test('due today uses today only; overdue has no runway', () => {
    const st = makeState({ tasks: [{ id: 'a', est: 300, due: TODAY }, { id: 'b', est: 30, due: '2026-10-01' }] });
    assert.deepEqual(runway(st, st.tasks.a, TODAY), { available: 240, deficit: 60 });
    assert.deepEqual(runway(st, st.tasks.b, TODAY), { available: 0, deficit: 30 });
  });
});

describe('allocate', () => {
  test('big multi-day task spreads evenly, skips the off day, never past due', () => {
    const st = fixture();
    const { updates, risks: r } = allocate(st, { today: TODAY, taskIds: ['t_big'] });
    assert.deepEqual(Object.keys(updates), ['t_big']);
    const blocks = updates.t_big;
    assert.equal(sum(blocks), 900);
    assert.deepEqual(r, []);
    for (const b of blocks) {
      assert.match(b.id, /^b_[0-9a-z]{8}$/);
      assert.equal(b.auto, true);
      assert.equal(b.done, false);
      assert.ok(b.d >= TODAY && b.d < '2026-10-21', b.d);
      assert.notEqual(b.d, '2026-10-10');
      assert.ok(b.m >= 30 && b.m <= 120, `${b.d}:${b.m}`);
    }
    // ~1h a day across the 15 working days (Thu only had 55m free).
    assert.equal(blocks.length, 15);
    assert.equal(blocks.find((b) => b.d === '2026-10-08').m, 55);
    // Sorted by date and no day goes over its capacity afterwards.
    assert.deepEqual(blocks.map((b) => b.d), [...blocks.map((b) => b.d)].sort());
    const after = withBlocks(st, updates);
    for (const b of blocks) {
      const l = dayLoad(after, b.d);
      assert.ok(l.total <= l.cap, `${b.d} ${l.total}/${l.cap}`);
    }
  });

  test('re-running on its own output changes nothing (ids reused, no churn)', () => {
    const st = fixture();
    const first = allocate(st, { today: TODAY });
    const second = allocate(withBlocks(st, first.updates), { today: TODAY });
    assert.deepEqual(second.updates, {});
  });

  test('due today: one block today', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 90, due: TODAY }] });
    const { updates, risks: r } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.t1), ['2026-10-05:90']);
    assert.deepEqual(r, []);
  });

  test('due tomorrow: everything lands today, capped at maxBlock', () => {
    const st = makeState({ tasks: [{ id: 'small', est: 60, due: '2026-10-06' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY }).updates.small), ['2026-10-05:60']);

    const big = makeState({ tasks: [{ id: 'big', title: 'Grant section', est: 150, due: '2026-10-06' }] });
    const { updates, risks: r } = allocate(big, { today: TODAY });
    assert.deepEqual(dm(updates.big), ['2026-10-05:120']);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'under-allocated');
    assert.equal(r[0].taskId, 'big');
    assert.equal(r[0].minutes, 30);
    assert.equal(r[0].d, '2026-10-06');
    assert.match(r[0].message, /Grant section/);
  });

  test('plan after today: window starts at plan', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 120, plan: '2026-10-08', due: '2026-10-12' }] });
    const { updates } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.t1), ['2026-10-08:30', '2026-10-09:30', '2026-10-10:30', '2026-10-11:30']);
  });

  test('plan == due: the due day only; plan in the past starts today', () => {
    const st = makeState({ tasks: [
      { id: 'same', est: 45, plan: '2026-10-08', due: '2026-10-08' },
      { id: 'past', est: 60, plan: '2026-10-01', due: '2026-10-07' },
    ] });
    const { updates } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.same), ['2026-10-08:45']);
    assert.deepEqual(dm(updates.past), ['2026-10-05:30', '2026-10-06:30']);
  });

  test('manual and done blocks are preserved; manual undone blocks count as allocated', () => {
    const st = fixture();
    const before = st.tasks.t_predis.blocks;
    const { updates } = allocate(st, { today: TODAY, taskIds: ['t_predis'] });
    const blocks = updates.t_predis;
    assert.deepEqual(blocks.find((b) => b.id === 'b_p_done'), before[0]);
    assert.deepEqual(blocks.find((b) => b.id === 'b_p_man'), before[1]);
    // remaining 240 = manual 90 + 150 newly placed auto minutes
    assert.equal(undoneFuture(blocks), 240);
    assert.equal(sum(blocks.filter((b) => b.auto && !b.done)), 150);
    // The old auto block's id is reused for the new block on the same day.
    assert.ok(blocks.some((b) => b.id === 'b_p_auto' && b.d === '2026-10-07'));
    // Tuesday already has the 90m manual block, so auto adds at most 30 there (maxBlock 120/day).
    assert.equal(sum(blocks.filter((b) => b.d === '2026-10-06')), 120);
  });

  test('done blocks are counted through spent, not double-counted', () => {
    const st = makeState({ tasks: [{
      id: 't1', est: 200, spent: 80, due: '2026-10-08',
      blocks: [{ id: 'bd', d: '2026-10-02', m: 80, done: true, auto: true }],
    }] });
    const { updates } = allocate(st, { today: TODAY });
    assert.deepEqual(updates.t1[0], { id: 'bd', d: '2026-10-02', m: 80, done: true, auto: true });
    assert.deepEqual(dm(updates.t1.slice(1)), ['2026-10-05:40', '2026-10-06:40', '2026-10-07:40']);
  });

  test('offDays get no blocks', () => {
    const st = makeState({ settings: { offDays: ['2026-10-06', '2026-10-07'] }, tasks: [{ id: 't1', est: 120, due: '2026-10-09' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY }).updates.t1), ['2026-10-05:60', '2026-10-08:60']);
  });

  test('capacity exhausted → partial blocks + under-allocated risk', () => {
    const st = makeState({ settings: ALL60, tasks: [
      { id: 'busy', title: 'Busy Monday', plan: TODAY, est: 60 },
      { id: 't1', title: 'Stats final', est: 300, due: '2026-10-08' },
    ] });
    const { updates, risks: r } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.t1), ['2026-10-06:60', '2026-10-07:60']);
    assert.equal(updates.busy, undefined);
    assert.deepEqual(r.map((x) => [x.type, x.taskId, x.minutes, x.d]), [['under-allocated', 't1', 180, '2026-10-08']]);
    assert.match(r[0].message, /Stats final: 3h won't fit before Thu 10\/8/);
  });

  test('replan:false only adds the shortfall and keeps existing blocks', () => {
    const st = makeState({ tasks: [{
      id: 't1', est: 240, due: '2026-10-09',
      blocks: [
        { id: 'b_a1', d: '2026-10-05', m: 60, done: false, auto: true },
        { id: 'b_m1', d: '2026-10-06', m: 60, done: false, auto: false },
      ],
    }] });
    const { updates } = allocate(st, { today: TODAY, replan: false });
    const blocks = updates.t1;
    assert.equal(undoneFuture(blocks), 240);
    assert.equal(sum(blocks) - 120, 120); // exactly the 120m shortfall added
    assert.deepEqual(blocks.find((b) => b.id === 'b_m1'), { id: 'b_m1', d: '2026-10-06', m: 60, done: false, auto: false });
    assert.ok(blocks.find((b) => b.id === 'b_a1' && b.d === '2026-10-05'));
    // Fully allocated → nothing to do.
    const again = allocate(withBlocks(st, updates), { today: TODAY, replan: false });
    assert.deepEqual(again.updates, {});
  });

  test('replan:true re-places auto blocks but leaves an unchanged plan alone', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 90, due: TODAY, blocks: [{ id: 'b_keep', d: TODAY, m: 90 }] }] });
    assert.deepEqual(allocate(st, { today: TODAY }).updates, {});
  });

  test('replan drops auto blocks that manual blocks already make redundant', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 60, due: '2026-10-09', blocks: [
      { id: 'man', d: '2026-10-06', m: 60, auto: false },
      { id: 'auto', d: '2026-10-07', m: 30 },
    ] }] });
    assert.deepEqual(allocate(st, { today: TODAY }).updates, { t1: [{ id: 'man', d: '2026-10-06', m: 60, done: false, auto: false }] });
  });

  test('plan after due: the due day only', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 60, plan: '2026-10-12', due: '2026-10-08' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY }).updates.t1), ['2026-10-08:60']);
  });

  test('stale past auto blocks are dropped on replan', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 120, due: '2026-10-07', blocks: [{ id: 'b_old', d: '2026-10-02', m: 60 }] }] });
    const { updates } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.t1), ['2026-10-05:60', '2026-10-06:60']);
    assert.ok(!updates.t1.some((b) => b.id === 'b_old'));
  });

  test('own auto blocks do not eat their own capacity when replanning', () => {
    const st = makeState({ settings: ALL60, tasks: [{ id: 't1', est: 60, due: '2026-10-06', blocks: [{ id: 'b1', d: TODAY, m: 60 }] }] });
    const { updates, risks: r } = allocate(st, { today: TODAY });
    assert.deepEqual(updates, {});
    assert.deepEqual(r, []);
  });

  test('EDF order: earlier due first, then higher prio wins contested capacity', () => {
    const st = makeState({ settings: ALL60, tasks: [
      { id: 'a', title: 'Normal', est: 60, due: '2026-10-06', prio: 1, created: '2026-09-01T00:00:00.000Z' },
      { id: 'b', title: 'Critical', est: 60, due: '2026-10-06', prio: 3, created: '2026-09-02T00:00:00.000Z' },
      { id: 'c', title: 'Later', est: 60, due: '2026-10-08', prio: 3 },
    ] });
    const { updates, risks: r } = allocate(st, { today: TODAY });
    assert.deepEqual(dm(updates.b), ['2026-10-05:60']);
    assert.equal(updates.a, undefined);
    assert.deepEqual(dm(updates.c), ['2026-10-06:30', '2026-10-07:30']);
    assert.deepEqual(r.map((x) => [x.taskId, x.minutes]), [['a', 60]]);
  });

  test('taskIds limits the run; other tasks’ blocks count as load', () => {
    const st = makeState({ settings: ALL60, tasks: [
      { id: 'x', est: 60, due: '2026-10-06', blocks: [{ id: 'bx', d: TODAY, m: 60 }] },
      { id: 'y', est: 60, due: '2026-10-06' },
    ] });
    const { updates, risks: r } = allocate(st, { today: TODAY, taskIds: ['y'] });
    assert.deepEqual(updates, {});
    assert.deepEqual(r.map((x) => [x.type, x.taskId, x.minutes]), [['under-allocated', 'y', 60]]);
    assert.deepEqual(Object.keys(allocate(st, { today: TODAY, taskIds: 'x' }).updates), []);
  });

  test('overdue tasks get no blocks and come back as crunch', () => {
    const st = fixture();
    const { updates, risks: r } = allocate(st, { today: TODAY, taskIds: ['t_irb'] });
    assert.deepEqual(updates, {});
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'crunch');
    assert.equal(r[0].taskId, 't_irb');
    assert.match(r[0].message, /overdue/);
  });

  test('a tiny tail is folded into the last block instead of leaving a crumb', () => {
    const st = makeState({ tasks: [{ id: 't1', est: 40, due: '2026-10-15' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY }).updates.t1), ['2026-10-05:40']);
    const st2 = makeState({ tasks: [{ id: 't1', est: 100, due: '2026-10-15' }] });
    assert.deepEqual(dm(allocate(st2, { today: TODAY }).updates.t1), ['2026-10-05:30', '2026-10-07:30', '2026-10-10:40']);
  });

  test('ignores tasks without est/due, done, dropped, or with nothing remaining', () => {
    const st = makeState({ tasks: [
      { id: 'noest', due: '2026-10-08' },
      { id: 'nodue', est: 60 },
      { id: 'done', est: 60, due: '2026-10-08', status: 'done', doneAt: '2026-10-04T12:00:00.000Z' },
      { id: 'dropped', est: 60, due: '2026-10-08', status: 'dropped' },
      { id: 'spent', est: 60, spent: 60, due: '2026-10-08' },
    ] });
    assert.deepEqual(allocate(st, { today: TODAY }), { updates: {}, risks: [] });
  });

  test('empty / garbage input does not throw', () => {
    assert.deepEqual(allocate({}, { today: TODAY }), { updates: {}, risks: [] });
    assert.deepEqual(allocate(null, { today: TODAY }), { updates: {}, risks: [] });
    assert.deepEqual(allocate({ tasks: { a: null, b: { est: 'x', due: 7 } } }, { today: TODAY }), { updates: {}, risks: [] });
  });

  test('never mutates its input', () => {
    const st = deepFreeze(fixture());
    const snapshot = JSON.stringify(st);
    allocate(st, { today: TODAY });
    allocate(st, { today: TODAY, replan: false });
    risks(st, TODAY);
    dayLoad(st, TODAY);
    assert.equal(JSON.stringify(st), snapshot);
  });
});

describe('risks', () => {
  test('fixture: overdue crunch, under-allocated work, needs-estimate (triage skipped)', () => {
    const r = risks(fixture(), TODAY);
    assert.deepEqual(r.map((x) => [x.type, x.taskId, x.minutes ?? null]), [
      ['crunch', 't_irb', 60],
      ['under-allocated', 't_predis', 90],
      ['under-allocated', 't_big', 900],
      ['needs-estimate', 't_poster', null],
    ]);
    assert.equal(r[0].message, 'Submit IRB amendment is overdue (was due Fri 10/2, 3d ago), 1h of work left');
    assert.equal(r[3].message, 'SDN poster (due Thu 10/15) needs a time estimate');
  });

  test('allocating clears under-allocated risks', () => {
    const st = fixture();
    const after = withBlocks(st, allocate(st, { today: TODAY }).updates);
    assert.deepEqual(risks(after, TODAY).map((x) => x.type), ['crunch', 'needs-estimate']);
  });

  test('overbooked days within 14 days (> cap × 1.15)', () => {
    const over = makeState({ tasks: [
      { id: 'a', plan: '2026-10-08', est: 150 },
      { id: 'b', plan: '2026-10-08', est: 150 },
      { id: 'far', plan: '2026-10-25', est: 600 },
    ] });
    const r = risks(over, TODAY);
    assert.deepEqual(r, [{ type: 'overbooked', d: '2026-10-08', minutes: 60, message: 'Thu 10/8 is overbooked: 5h planned vs 4h' }]);

    const ok = makeState({ tasks: [{ id: 'a', plan: '2026-10-08', est: 150 }, { id: 'b', plan: '2026-10-08', est: 120 }] });
    assert.deepEqual(risks(ok, TODAY), []);

    const offDay = makeState({ settings: { offDays: ['2026-10-08'] }, tasks: [{ id: 'a', plan: '2026-10-08', est: 150 }] });
    assert.deepEqual(risks(offDay, TODAY), []);
  });

  test('crunch when remaining work exceeds free time before due', () => {
    const st = makeState({ tasks: [
      { id: 'tmrw', title: 'Chapter draft', est: 600, due: '2026-10-06' },
      { id: 'tdy', title: 'Slides', est: 300, due: TODAY },
    ] });
    const r = risks(st, TODAY);
    const byId = Object.fromEntries(r.map((x) => [x.taskId, x]));
    assert.equal(byId.tmrw.type, 'crunch');
    // Both compete for Monday: each sees Mon free minus the other's (unblocked → no) load.
    assert.equal(byId.tmrw.minutes, 360);
    assert.equal(byId.tmrw.message, 'Chapter draft needs 10h but only 4h is free before Tue 10/6');
    assert.equal(byId.tdy.type, 'crunch');
    assert.equal(byId.tdy.minutes, 60);
    assert.match(byId.tdy.message, /free today$/);
  });

  test('needs-estimate: 21-day window, deadline-ish kinds, project, or title words', () => {
    const st = makeState({ tasks: [
      { id: 'w21', title: 'Lit section', kind: 'writing', due: '2026-10-26' },
      { id: 'w22', title: 'Lit section 2', kind: 'writing', due: '2026-10-27' },
      { id: 'email', title: 'Email Mike', kind: 'email', due: '2026-10-07' },
      { id: 'proj', title: 'Thing for a project', due: '2026-10-07', project: 'p_x' },
      { id: 'talk', title: 'Prep job talk', due: '2026-10-07' },
      { id: 'tri', title: 'Draft paper', kind: 'writing', due: '2026-10-07', triage: true },
    ] });
    assert.deepEqual(risks(st, TODAY).filter((x) => x.type === 'needs-estimate').map((x) => x.taskId).sort(), ['proj', 'talk', 'w21']);
  });

  test('small single-sitting tasks are not nagged; blocked work that falls short is', () => {
    const st = makeState({ tasks: [
      { id: 'small', est: 30, due: '2026-10-08' },
      { id: 'short', est: 120, due: '2026-10-08', blocks: [{ id: 'b', d: '2026-10-06', m: 60 }] },
    ] });
    assert.deepEqual(risks(st, TODAY).map((x) => [x.type, x.taskId, x.minutes]), [['under-allocated', 'short', 60]]);
  });

  test('empty state → no risks', () => {
    assert.deepEqual(risks({}, TODAY), []);
    assert.deepEqual(risks(makeState(), TODAY), []);
  });
});

describe('allocate: preferred session length + plan start', () => {
  test('prefBlock 60 books hour-long sessions spaced across the window', () => {
    const st = makeState({ settings: { prefBlock: 60 }, tasks: [{ id: 'w', est: 240, due: '2026-10-13' }] });
    const { updates } = allocate(st, { today: TODAY });
    const blocks = updates.w;
    assert.equal(sum(blocks), 240);
    assert.ok(blocks.every((b) => b.m === 60), dm(blocks).join(' '));
    assert.equal(blocks.length, 4);
    // spaced, not four days in a row
    assert.ok(blocks.some((b, i) => i > 0 && diffDays(blocks[i - 1].d, b.d) > 1), dm(blocks).join(' '));
  });

  test('small work stays a single block even with prefBlock 60', () => {
    const st = makeState({ settings: { prefBlock: 60 }, tasks: [{ id: 's', est: 45, due: '2026-10-09' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY }).updates.s), ['2026-10-05:45']);
  });

  test('from skips today; planStart flips to tomorrow at 5pm local', () => {
    const st = makeState({ settings: { prefBlock: 60 }, tasks: [{ id: 'x', est: 60, due: '2026-10-09' }] });
    assert.deepEqual(dm(allocate(st, { today: TODAY, from: '2026-10-06' }).updates.x), ['2026-10-06:60']);
    assert.equal(planStart('2026-10-05T20:59:00.000Z', 'America/New_York'), '2026-10-05'); // 4:59pm ET
    assert.equal(planStart('2026-10-05T21:00:00.000Z', 'America/New_York'), '2026-10-06'); // 5:00pm ET
    assert.equal(planStart('2026-10-06T03:30:00.000Z', 'America/New_York'), '2026-10-06'); // 11:30pm ET → tomorrow
  });
});

test('ENG-4: past meetings / appointments are not late work (no crunch, no blocks)', () => {
  const st = makeState({ tasks: [
    { id: 'adv', title: 'Advisor meeting', kind: 'meeting', due: '2026-10-02', est: 60 },
    { id: 'appt', title: 'Dentist', kind: 'appt', plan: '2026-10-01', due: '2026-10-01', est: 90 },
    { id: 'late', title: 'IRB form', kind: 'deadline', due: '2026-10-02', est: 60 },
    { id: 'soon', title: 'Committee meeting', kind: 'meeting', plan: '2026-10-07', due: '2026-10-07', est: 60 },
  ] });
  const rs = risks(st, TODAY);
  assert.deepEqual(rs.filter((r) => r.type === 'crunch').map((r) => r.taskId), ['late']);
  const { updates, risks: ar } = allocate(st, { today: TODAY });
  assert.deepEqual(ar.map((r) => r.taskId), ['late']);
  assert.ok(!('adv' in updates) && !('appt' in updates));
  assert.ok(isPastEvent(st.tasks.adv, TODAY));
  assert.ok(!isPastEvent(st.tasks.soon, TODAY));
  assert.ok(!isPastEvent(st.tasks.late, TODAY));
  assert.ok(!isPastEvent({ ...st.tasks.adv, status: 'done' }, TODAY));
  assert.ok(!isPastEvent(null, TODAY));
});
