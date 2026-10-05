import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { doneOn, heatmap, streak, weekStats, wins } from '../src/engine/stats.js';
import { fixture, makeState, TODAY, deepFreeze } from './fixtures/engine-fixture.js';

const ids = (xs) => xs.map((x) => x.id);

describe('doneOn', () => {
  test('uses the local date in the settings timezone', () => {
    const st = fixture();
    assert.deepEqual(ids(doneOn(st, '2026-10-05')), ['t_notes']); // 02:00Z on 10/6 = 10pm ET 10/5
    assert.deepEqual(ids(doneOn(st, '2026-10-04')), ['t_read']); // 03:30Z on 10/5 = 11:30pm ET 10/4
    assert.deepEqual(ids(doneOn(st, '2026-10-06')), []);
  });
  test('timezone setting is honored', () => {
    const st = fixture();
    const utc = { ...st, settings: { ...st.settings, tz: 'UTC' } };
    assert.deepEqual(ids(doneOn(utc, '2026-10-06')), ['t_notes']);
  });
  test('ignores dropped/todo, bad dates, empty state', () => {
    const st = makeState({ tasks: [{ id: 'a', status: 'dropped' }, { id: 'b', plan: TODAY }] });
    assert.deepEqual(doneOn(st, TODAY), []);
    assert.deepEqual(doneOn({}, TODAY), []);
    assert.deepEqual(doneOn(fixture(), 'garbage'), []);
  });
});

describe('heatmap', () => {
  const hm = heatmap(fixture(), TODAY, 12);
  test('aligned to week start, oldest first, ending today', () => {
    assert.equal(hm.length, 78); // 11 full weeks + Monday
    assert.equal(hm[0].d, '2026-07-20'); // a Monday
    assert.equal(hm.at(-1).d, TODAY);
    for (let i = 1; i < hm.length; i++) assert.ok(hm[i - 1].d < hm[i].d);
  });
  test('count = tasks done + chore check-offs; minutes = clock-ins', () => {
    const at = (d) => hm.find((c) => c.d === d);
    assert.deepEqual(at(TODAY), { d: TODAY, count: 2, minutes: 15, tasks: 1, chores: 1 });
    assert.deepEqual(at('2026-10-04'), { d: '2026-10-04', count: 3, minutes: 25, tasks: 1, chores: 2 });
    assert.deepEqual(at('2026-10-02'), { d: '2026-10-02', count: 0, minutes: 0, tasks: 0, chores: 0 });
    // derived minutes from start/end when `min` is missing
    assert.equal(at('2026-09-17').minutes, 20);
    // derived date from `start` when `d` is missing
    assert.equal(at('2026-09-16').minutes, 10);
  });
  test('Sunday week start and other sizes', () => {
    const st = fixture();
    const sun = heatmap({ ...st, settings: { ...st.settings, weekStart: 'sun' } }, TODAY, 1);
    assert.deepEqual(sun.map((c) => c.d), ['2026-10-04', '2026-10-05']);
    assert.equal(heatmap(makeState(), TODAY).length, 78);
    assert.equal(heatmap({}, TODAY, 'x').length, 78);
  });
});

describe('streak', () => {
  test('fixture: current 3 (Sat–Mon), best 5 (Sep 14–18)', () => {
    assert.deepEqual(streak(fixture(), TODAY), { current: 3, best: 5 });
  });
  test('current counts from yesterday while today is still empty', () => {
    const st = makeState({ chores: [{ id: 'c', every: 1, log: ['2026-10-02', '2026-10-03', '2026-10-04'] }] });
    assert.deepEqual(streak(st, TODAY), { current: 3, best: 3 });
  });
  test('a gap of a day breaks it', () => {
    const st = makeState({ chores: [{ id: 'c', every: 1, log: ['2026-10-01', '2026-10-02', '2026-10-04'] }] });
    assert.deepEqual(streak(st, '2026-10-06'), { current: 0, best: 2 });
  });
  test('tasks, chores and sessions each count', () => {
    const st = makeState({
      tasks: [{ id: 't', status: 'done', doneAt: '2026-10-05T15:00:00.000Z' }],
      chores: [{ id: 'c', every: 7, log: ['2026-10-04'] }],
      sessions: [{ id: 's', ref: 'free', start: '2026-10-03T15:00:00.000Z', end: '2026-10-03T15:05:00.000Z', min: 5, d: '2026-10-03' }],
    });
    assert.deepEqual(streak(st, TODAY), { current: 3, best: 3 });
  });
  test('empty', () => {
    assert.deepEqual(streak(makeState(), TODAY), { current: 0, best: 0 });
    assert.deepEqual(streak({}, TODAY), { current: 0, best: 0 });
  });
});

describe('weekStats', () => {
  test('Monday: just today so far', () => {
    const w = weekStats(fixture(), TODAY);
    assert.equal(w.done, 1);
    assert.deepEqual(w.byCat, { psc: 1 });
    assert.equal(w.minutes, 15);
    assert.deepEqual(w.wins, []);
    assert.equal(w.chores, 1);
  });
  test('Sunday: the whole Mon–Sun week, wins flagged', () => {
    const w = weekStats(fixture(), '2026-10-04');
    assert.equal(w.done, 3);
    assert.deepEqual(w.byCat, { cbt: 1, sdn: 1, rsa: 1 });
    assert.equal(w.minutes, 37);
    assert.deepEqual(ids(w.wins), ['t_abstract']);
    assert.equal(w.chores, 5);
  });
  test('critical-priority completions count as wins', () => {
    const st = makeState({ tasks: [
      { id: 'crit', prio: 3, status: 'done', doneAt: '2026-10-05T15:00:00.000Z' },
      { id: 'meh', prio: 1, status: 'done', doneAt: '2026-10-05T16:00:00.000Z' },
    ] });
    assert.deepEqual(ids(weekStats(st, TODAY).wins), ['crit']);
  });
  test('empty', () => {
    const w = weekStats({}, TODAY);
    assert.equal(w.done, 0);
    assert.deepEqual(w.byCat, {});
    assert.equal(w.minutes, 0);
    assert.deepEqual(w.wins, []);
    assert.equal(w.chores, 0);
  });
});

describe('wins', () => {
  test('done tasks and milestones, newest first', () => {
    const w = wins(fixture(), {});
    assert.deepEqual(w.map((x) => [x.kind, x.title]), [
      ['task', 'Session notes'],
      ['task', 'Read chapter 4'],
      ['task', 'Submit SfN abstract'],
      ['task', 'RSA figures'],
      ['milestone', 'Methods'],
      ['milestone', 'Final'],
    ]);
    assert.deepEqual(w[4], {
      at: '2026-09-20T15:00:00.000Z', title: 'Methods', cat: 'rsa', kind: 'milestone', ref: 'p_rsa', win: true, project: 'RSA manuscript',
    });
    assert.equal(w[2].win, true);
    assert.equal(w[0].win, false);
    assert.equal(w[0].cat, 'psc');
  });
  test('since: local date or ISO timestamp; limit', () => {
    assert.deepEqual(wins(fixture(), { since: '2026-10-04' }).map((x) => x.title), ['Session notes', 'Read chapter 4']);
    assert.deepEqual(wins(fixture(), { since: '2026-10-05T12:00:00.000Z' }).map((x) => x.title), ['Session notes']);
    assert.deepEqual(wins(fixture(), { limit: 2 }).map((x) => x.title), ['Session notes', 'Read chapter 4']);
  });
  test('empty and odd input', () => {
    assert.deepEqual(wins({}), []);
    assert.deepEqual(wins(makeState()), []);
    assert.deepEqual(wins({ projects: { p: { milestones: [{ t: 'x', done: true }] } } }, null), []);
  });
});

test('stats never mutate their input', () => {
  const st = deepFreeze(fixture());
  const snap = JSON.stringify(st);
  doneOn(st, TODAY);
  heatmap(st, TODAY);
  streak(st, TODAY);
  weekStats(st, TODAY);
  wins(st, {});
  assert.equal(JSON.stringify(st), snap);
});

test('ENG-3: a forgotten timer counts at most 180 minutes toward the week', async () => {
  const { OPS } = await import('../src/engine/ops.js');
  const st = fixture();
  const before = weekStats(st, TODAY).minutes;
  const on = OPS.clockIn(st, { ref: 'chore:c_laundry' }, { now: '2026-10-05T14:00:00.000Z', today: TODAY, src: 'dash' }).state;
  const off = OPS.clockIn(on, { ref: 'task:t_email' }, { now: '2026-10-07T13:00:00.000Z', today: '2026-10-07', src: 'dash' }).state;
  assert.equal(weekStats(off, '2026-10-07').minutes, before + 180);
  // a hand-made session without `min` is capped the same way
  const raw = makeState({ sessions: [{ id: 's_x', ref: 'free', title: 'x', cat: 'admin', start: '2026-10-05T12:00:00.000Z', end: '2026-10-06T12:00:00.000Z', d: TODAY }] });
  assert.equal(weekStats(raw, TODAY).minutes, 180);
});
