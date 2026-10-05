import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } from '../src/engine/views.js';
import { fixture, makeState, TODAY, deepFreeze } from './fixtures/engine-fixture.js';

const ids = (xs) => xs.map((x) => x.id);

describe('todayView', () => {
  const v = todayView(fixture(), TODAY);

  test('buckets follow the contract rules', () => {
    assert.deepEqual(ids(v.triage), ['t_triage']);
    assert.deepEqual(ids(v.overdue), ['t_irb']);
    assert.deepEqual(ids(v.dueToday), ['t_hw']);
    assert.deepEqual(ids(v.meetings), ['t_lab']);
    assert.deepEqual(ids(v.planned), ['t_email']); // dropped task with plan today is ignored
    assert.deepEqual(ids(v.carried), ['t_reimb']);
  });

  test('work blocks today come with their task', () => {
    assert.deepEqual(v.blocks.map(({ task, block }) => [task.id, block.id, block.m]), [['t_glm', 'b_glm1', 60]]);
  });

  test('doneToday uses the local date of doneAt (tz boundary)', () => {
    // 2026-10-06T02:00Z is 10pm Mon in New York → today; 2026-10-05T03:30Z is Sun 11:30pm → not today.
    assert.deepEqual(ids(v.doneToday), ['t_notes']);
  });

  test('chores: active and due, most urgent first', () => {
    assert.deepEqual(ids(v.chores), ['c_trash', 'c_plants', 'c_ziggy']);
  });

  test('counts: distinct open tasks (incl. block-only) and done', () => {
    assert.deepEqual(v.counts, { open: 7, done: 1, total: 8 });
  });

  test('first matching bucket wins', () => {
    const st = makeState({ tasks: [
      { id: 'tri_over', due: '2026-10-01', triage: true },
      { id: 'meet_due', kind: 'meeting', due: TODAY, time: '10:00' },
      { id: 'over_plan', due: '2026-10-02', plan: TODAY },
      { id: 'plan_due_later', plan: TODAY, due: '2026-10-09' },
      { id: 'carry_due_today', plan: '2026-10-01', due: TODAY },
      { id: 'carry_due_later', plan: '2026-10-01', due: '2026-10-20' },
      { id: 'appt', kind: 'appt', plan: TODAY, time: '09:00' },
      { id: 'meet_late', kind: 'meeting', plan: TODAY, time: '16:30' },
      { id: 'meet_untimed', kind: 'meeting', plan: TODAY },
    ] });
    const tv = todayView(st, TODAY);
    assert.deepEqual(ids(tv.triage), ['tri_over']);
    assert.deepEqual(ids(tv.overdue), ['over_plan']);
    assert.deepEqual(ids(tv.dueToday).sort(), ['carry_due_today', 'meet_due']);
    assert.deepEqual(ids(tv.meetings), ['appt', 'meet_late', 'meet_untimed']);
    assert.deepEqual(ids(tv.planned), ['plan_due_later']);
    assert.deepEqual(ids(tv.carried), ['carry_due_later']);
  });

  test('planned sorts by prio desc', () => {
    const st = makeState({ tasks: [
      { id: 'a', title: 'A', plan: TODAY, prio: 1 },
      { id: 'b', title: 'B', plan: TODAY, prio: 3 },
      { id: 'c', title: 'C', plan: TODAY, prio: 0 },
    ] });
    assert.deepEqual(ids(todayView(st, TODAY).planned), ['b', 'a', 'c']);
  });

  test('empty state', () => {
    const tv = todayView(makeState(), TODAY);
    assert.deepEqual(tv.counts, { open: 0, done: 0, total: 0 });
    for (const k of ['overdue', 'dueToday', 'meetings', 'planned', 'carried', 'blocks', 'triage', 'chores', 'doneToday']) assert.deepEqual(tv[k], []);
    assert.doesNotThrow(() => todayView({}, TODAY));
    assert.doesNotThrow(() => todayView(null, TODAY));
  });
});

test('ENG-4: past meetings / appointments ask "did it happen?" (triage) instead of rolling over as carried', () => {
  const st = makeState({ tasks: [
    { id: 'dentist', title: 'Dentist appt', kind: 'appt', plan: '2026-10-07', time: '09:30' },
    { id: 'lab', title: 'Lab meeting', kind: 'meeting', plan: '2026-10-08', time: '14:00' },
    { id: 'mike', title: 'Email Mike', kind: 'email', plan: '2026-10-08' },
    { id: 'due_meet', title: 'Advisor meeting', kind: 'meeting', due: '2026-10-09' },
    { id: 'prep', title: 'Committee meeting prep', kind: 'meeting', plan: '2026-10-09', due: '2026-10-20' },
    { id: 'today_meet', title: 'Standup', kind: 'meeting', plan: '2026-10-12', time: '10:00' },
    { id: 'next_meet', title: 'Seminar', kind: 'meeting', plan: '2026-10-14' },
    { id: 'done_meet', title: 'Old 1:1', kind: 'meeting', plan: '2026-10-06', status: 'done', doneAt: '2026-10-06T15:00:00.000Z' },
  ] });
  const tv = todayView(st, '2026-10-12');
  assert.deepEqual(ids(tv.triage), ['dentist', 'lab', 'due_meet']);
  assert.deepEqual(ids(tv.carried), ['mike', 'prep']); // a deadline still ahead keeps it carried
  assert.deepEqual(ids(tv.overdue), []);
  assert.deepEqual(ids(tv.meetings), ['today_meet']);
  // before its day it is a normal meeting
  assert.deepEqual(ids(todayView(st, '2026-10-07').meetings), ['dentist']);
});

describe('calendarView', () => {
  const cal = calendarView(fixture(), TODAY, 14, TODAY);
  const day = (d) => cal.find((c) => c.d === d);
  const items = (d) => day(d).items.map((i) => `${i.type}:${i.task.id}`);

  test('14 rolling days with flags', () => {
    assert.equal(cal.length, 14);
    assert.equal(cal[0].d, TODAY);
    assert.equal(cal[13].d, '2026-10-18');
    assert.equal(cal[0].isToday, true);
    assert.equal(cal.filter((c) => c.isToday).length, 1);
    assert.equal(cal.some((c) => c.isPast), false);
    assert.equal(day('2026-10-10').isOff, true);
    assert.equal(day('2026-10-10').isWeekend, true);
    assert.equal(day('2026-10-09').isOff, false);
    assert.equal(day('2026-10-09').isWeekend, false);
  });

  test('load comes from dayLoad', () => {
    assert.equal(day(TODAY).load.total, 130);
    assert.equal(day(TODAY).load.cap, 240);
    assert.equal(day('2026-10-08').load.planned, 185);
  });

  test('item order: due pins, meetings by time, plan chips, block chips (prio desc, title)', () => {
    assert.deepEqual(items(TODAY), ['due:t_hw', 'meeting:t_lab', 'plan:t_email', 'block:t_glm']);
    assert.deepEqual(items('2026-10-08'), ['due:t_quiz', 'meeting:t_mentee', 'plan:t_tutorial', 'plan:t_grocery']);
    assert.deepEqual(items('2026-10-07'), ['meeting:t_dentist', 'block:t_predis']);
    assert.deepEqual(items('2026-10-06'), ['block:t_predis', 'block:t_glm']);
    assert.equal(day('2026-10-07').items[1].block.id, 'b_p_auto');
  });

  test('inactive tasks never appear as items', () => {
    for (const c of cal) for (const i of c.items) assert.equal(i.task.status, 'todo');
  });

  test('done lists use the local completion date', () => {
    assert.deepEqual(ids(day(TODAY).done), ['t_notes']);
    const past = calendarView(fixture(), '2026-10-02', 4, TODAY);
    assert.deepEqual(past.map((c) => [c.d, c.isPast, ids(c.done)]), [
      ['2026-10-02', true, []],
      ['2026-10-03', true, ['t_abstract']],
      ['2026-10-04', true, ['t_read']],
      ['2026-10-05', false, ['t_notes']],
    ]);
    // Past cells show no chores; the done block on Fri 10/2 is not a chip (still-open pins/plans are).
    assert.deepEqual(past[0].chores, []);
    assert.deepEqual(past[0].items.map((i) => `${i.type}:${i.task.id}`), ['due:t_irb', 'plan:t_reimb']);
  });

  test('chores: daily every day, others on their next due date and repeats; overdue ones on today', () => {
    const ch = (d) => ids(day(d).chores);
    assert.deepEqual(ch(TODAY), ['c_ziggy', 'c_plants', 'c_trash']);
    assert.deepEqual(ch('2026-10-07'), ['c_ziggy', 'c_laundry']);
    assert.deepEqual(ch('2026-10-08'), ['c_ziggy', 'c_plants']);
    assert.deepEqual(ch('2026-10-12'), ['c_ziggy', 'c_trash']);
    assert.deepEqual(ch('2026-10-14'), ['c_ziggy', 'c_plants', 'c_laundry']);
    for (const c of cal) assert.ok(!ids(c.chores).includes('c_off'));
  });

  test('meeting with only a due date shows once, as a meeting', () => {
    const st = makeState({ tasks: [
      { id: 'm1', kind: 'meeting', due: '2026-10-06', time: '15:00' },
      { id: 'm2', kind: 'appt', plan: '2026-10-06', time: '09:00' },
      { id: 'pd', title: 'Same day', plan: '2026-10-06', due: '2026-10-06' },
    ] });
    const c = calendarView(st, TODAY, 3, TODAY)[1];
    assert.deepEqual(c.items.map((i) => `${i.type}:${i.task.id}`), ['due:pd', 'meeting:m2', 'meeting:m1']);
  });

  test('defaults and odd input', () => {
    assert.equal(calendarView(makeState(), TODAY, undefined, TODAY).length, 14);
    assert.equal(calendarView({}, TODAY, 3, TODAY).length, 3);
    assert.doesNotThrow(() => calendarView({ tasks: { a: { plan: TODAY, blocks: [null] } } }, TODAY, 2, TODAY));
  });
});

describe('upcomingDeadlines', () => {
  test('fixture statuses, soonest first, overdue excluded', () => {
    const rows = upcomingDeadlines(fixture(), TODAY);
    assert.deepEqual(rows.map((r) => [r.task.id, r.daysLeft, r.remaining, r.allocated, r.shortfall, r.status]), [
      ['t_hw', 0, 60, 0, 60, 'unplanned'],
      ['t_quiz', 3, 30, 0, 30, 'unplanned'],
      ['t_glm', 4, 120, 120, 0, 'ok'],
      ['t_predis', 7, 240, 150, 90, 'tight'],
      ['t_poster', 10, 0, 0, null, 'no-estimate'],
      ['t_big', 16, 900, 0, 900, 'unplanned'],
    ]);
  });

  test('days window', () => {
    assert.deepEqual(upcomingDeadlines(fixture(), TODAY, 7).map((r) => r.task.id), ['t_hw', 't_quiz', 't_glm', 't_predis']);
  });

  test('at-risk when free time before due cannot cover it; ok for a small planned task', () => {
    const st = makeState({ tasks: [
      { id: 'risk', est: 600, due: '2026-10-06', blocks: [{ id: 'b', d: TODAY, m: 120 }] },
      { id: 'planned', est: 30, plan: '2026-10-07', due: '2026-10-09' },
      { id: 'bigplanned', est: 300, plan: '2026-10-07', due: '2026-10-09' },
      { id: 'over', est: 30, spent: 45, due: '2026-10-09' },
    ] });
    const by = Object.fromEntries(upcomingDeadlines(st, TODAY).map((r) => [r.task.id, r.status]));
    assert.deepEqual(by, { risk: 'at-risk', planned: 'ok', bigplanned: 'tight', over: 'ok' });
  });

  test('empty', () => {
    assert.deepEqual(upcomingDeadlines(makeState(), TODAY), []);
    assert.deepEqual(upcomingDeadlines({}, TODAY), []);
  });
});

describe('backlog', () => {
  test('open, undated, unblocked, not triage; prio then newest', () => {
    assert.deepEqual(ids(backlog(fixture())), ['t_closet', 't_donate']);
    const st = makeState({ tasks: [
      { id: 'old', created: '2026-09-01T00:00:00.000Z' },
      { id: 'new', created: '2026-10-01T00:00:00.000Z' },
      { id: 'hi', prio: 2, created: '2026-08-01T00:00:00.000Z' },
      { id: 'blocked', blocks: [{ id: 'b', d: TODAY, m: 30 }] },
      { id: 'tri', triage: true },
      { id: 'done', status: 'done', doneAt: '2026-10-01T00:00:00.000Z' },
    ] });
    assert.deepEqual(ids(backlog(st)), ['hi', 'new', 'old']);
    assert.deepEqual(backlog({}), []);
  });
});

describe('projectView', () => {
  const rows = projectView(fixture(), TODAY);

  test('active (nearest next due first), then paused; done projects hidden', () => {
    assert.deepEqual(rows.map((r) => r.project.id), ['p_predis', 'p_rsa', 'p_dti']);
  });

  test('progress, next milestone and minutes', () => {
    const rsa = rows.find((r) => r.project.id === 'p_rsa');
    assert.equal(rsa.pct, 40); // (1 milestone + 1 task done) / (3 + 2)
    assert.equal(rsa.msDone, 1);
    assert.equal(rsa.msTotal, 3);
    assert.equal(rsa.tasksOpen, 1);
    assert.equal(rsa.tasksDone, 1);
    assert.equal(rsa.nextMilestone.t, 'Results');
    assert.equal(rsa.remainingMin, 900);
    assert.equal(rsa.allocatedMin, 0);

    const predis = rows.find((r) => r.project.id === 'p_predis');
    assert.equal(predis.nextMilestone.t, 'Lit review'); // earliest due, not list order
    assert.equal(predis.remainingMin, 240);
    assert.equal(predis.allocatedMin, 150);
    assert.equal(predis.pct, 0);

    const dti = rows.find((r) => r.project.id === 'p_dti');
    assert.equal(dti.pct, 0);
    assert.equal(dti.nextMilestone, null);
  });

  test('undated milestones keep list order', () => {
    const st = makeState({ projects: [{ id: 'p', name: 'P', milestones: [{ t: 'A', done: true }, { t: 'B' }, { t: 'C' }] }] });
    const [r] = projectView(st, TODAY);
    assert.equal(r.nextMilestone.t, 'B');
    assert.equal(r.pct, 33);
  });
});

describe('choreView', () => {
  test('due, urgency, counts, next due; most urgent first', () => {
    const rows = choreView(fixture(), TODAY);
    assert.deepEqual(rows.map((r) => [r.chore.id, r.due, Math.round(r.urgency * 100) / 100, r.todayCount, r.daysSince, r.nextDue]), [
      ['c_trash', true, 2.14, 0, 15, TODAY],
      ['c_plants', true, 1, 0, null, TODAY],
      ['c_ziggy', true, 0.5, 1, 0, TODAY],
      ['c_laundry', false, 0.71, 0, 5, '2026-10-07'],
    ]);
  });

  test('daily chore done perDay times is not due; next due tomorrow', () => {
    const st = makeState({ chores: [{ id: 'c', title: 'Walk', every: 1, perDay: 2, log: [TODAY, TODAY] }] });
    const [r] = choreView(st, TODAY);
    assert.equal(r.due, false);
    assert.equal(r.urgency, 0);
    assert.equal(r.nextDue, '2026-10-06');
    assert.deepEqual(todayView(st, TODAY).chores, []);
  });

  test('empty', () => {
    assert.deepEqual(choreView(makeState(), TODAY), []);
    assert.deepEqual(choreView({ chores: { x: { title: 'raw', every: 2 } } }, TODAY).map((r) => r.due), [true]);
  });
});

test('views never mutate their input', () => {
  const st = deepFreeze(fixture());
  const snap = JSON.stringify(st);
  todayView(st, TODAY);
  calendarView(st, TODAY, 14, TODAY);
  upcomingDeadlines(st, TODAY);
  backlog(st);
  projectView(st, TODAY);
  choreView(st, TODAY);
  assert.equal(JSON.stringify(st), snap);
});
