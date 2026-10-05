import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWrites, emptyState, normalizeCategory, normalizeState, normalizeTask, serializeState,
} from '../src/engine/model.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { parseQuickAdd } from '../src/engine/parse.js';
import { allocate } from '../src/engine/schedule.js';
import { OPS } from '../src/engine/ops.js';
import { fixture, deepFreeze, TODAY, NOW } from './fixtures/engine-fixture.js';

const ctx = { now: NOW, today: TODAY, src: 'dash' };
const at = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();

/** Fixture + the real category registry, frozen to prove ops never mutate inputs. */
function base(mut) {
  const s = fixture();
  for (const c of DEFAULT_CATEGORIES) s.cats[c.id] = normalizeCategory({ ...c, created: '2026-09-01T12:00:00.000Z' });
  if (mut) mut(s);
  return deepFreeze(s);
}

const canonical = (s) => serializeState(normalizeState(JSON.parse(serializeState(s))));

/**
 * Run an op and check the invariants every op must keep:
 * writes replayed onto the old state give exactly the new state, every activity
 * entry is also a `set` write, and the new state is already in canonical form
 * (so `ef check` stays clean and git diffs stay minimal).
 */
function run(name, state, args, c = ctx) {
  const res = OPS[name](state, args, c);
  assert.ok(res && typeof res === 'object', `${name} returns an object`);
  assert.ok(Array.isArray(res.writes) && Array.isArray(res.activity), `${name} returns writes + activity`);
  assert.deepEqual(applyWrites(state, res.writes), res.state, `${name}: applyWrites(old, writes) == new state`);
  for (const a of res.activity) {
    const w = res.writes.find((x) => x.col === 'activity' && x.id === a.id);
    assert.ok(w && w.op === 'set', `${name}: activity ${a.type} is written`);
    assert.deepEqual(Object.keys(a), ['id', 'at', 'src', 'type', 'ref', 'title', 'from', 'to']);
    assert.match(a.id, /^a_[0-9a-z]{8}$/);
  }
  if (res.writes.length) assert.equal(serializeState(res.state), canonical(res.state), `${name}: state stays canonical`);
  return res;
}

const types = (res) => res.activity.map((a) => a.type);

// ---------------------------------------------------------------- registry + robustness

test('OPS registry has exactly the contract ops', () => {
  assert.deepEqual(Object.keys(OPS).sort(), [
    'addCategory', 'addChore', 'addMilestone', 'addProject', 'addSub', 'addTask', 'applyAllocation',
    'choreDone', 'clockIn', 'clockOut', 'completeTask', 'deleteChore', 'deleteTask', 'dropTask',
    'editCategory', 'editChore', 'editProject', 'editSettings', 'editTask', 'logTime', 'moveBlock',
    'moveTask', 'removeSub', 'reopenTask', 'setBrief', 'toggleBlock', 'toggleMilestone', 'toggleSub',
  ]);
  for (const fn of Object.values(OPS)) assert.equal(typeof fn, 'function');
});

test('fixture state is canonical to begin with', () => {
  const s = base();
  assert.equal(serializeState(s), canonical(s));
});

test('a missing id is a no-op for every op (same state, no writes)', () => {
  const s = base();
  const args = { id: 'nope', blockId: 'nope', subId: 'nope', msId: 'nope', to: '2026-10-07', patch: { title: 'x' }, t: 'x', ref: 'task:nope', minutes: 10 };
  for (const name of Object.keys(OPS)) {
    if (name === 'setBrief') continue; // always writes the brief
    const res = OPS[name](s, args, ctx);
    assert.equal(res.state, s, name);
    assert.deepEqual(res.writes, [], name);
    assert.deepEqual(res.activity, [], name);
  }
});

test('no op throws on junk args, junk ctx or a bare state', () => {
  const states = [base(), emptyState(), {}, null];
  const junk = [undefined, null, {}, 'x', 42, { id: 42, patch: 'x', to: {}, updates: 'x', ref: 7, minutes: -5 }];
  for (const name of Object.keys(OPS)) {
    for (const st of states) {
      for (const a of junk) {
        assert.doesNotThrow(() => OPS[name](st, a, undefined), `${name}(${JSON.stringify(a)})`);
        assert.doesNotThrow(() => OPS[name](st, a, { now: 'garbage', today: 'nope', src: 'weird' }), name);
      }
    }
  }
});

// ---------------------------------------------------------------- addTask

test('addTask stores a normalized task with src from ctx and logs "add"', () => {
  const s = base();
  const res = run('addTask', s, { title: '  Email Mike ', plan: '2026-10-06', est: 10, kind: 'email', cat: 'admin' }, { ...ctx, src: 'chat' });
  const w = res.writes.find((x) => x.col === 'tasks');
  assert.equal(w.op, 'set');
  const t = res.state.tasks[w.id];
  assert.match(t.id, /^t_[0-9a-z]{8}$/);
  assert.equal(t.title, 'Email Mike');
  assert.equal(t.plan, '2026-10-06');
  assert.equal(t.cat, 'admin');
  assert.equal(t.src, 'chat');
  assert.equal(t.created, NOW);
  assert.equal(t.updated, NOW);
  assert.deepEqual(Object.keys(t), Object.keys(normalizeTask({}, ctx)));
  assert.deepEqual(types(res), ['add']);
  assert.equal(res.activity[0].src, 'chat');
  assert.equal(res.activity[0].to, '2026-10-06');
  assert.equal(res.activity[0].ref, t.id);
});

test('addTask from parseQuickAdd strips parse-only fields', () => {
  const s = base();
  const parsed = parseQuickAdd('email mike - tomorrow ~10m', { today: TODAY, cats: s.cats });
  assert.ok(parsed.tokens.length);
  const res = run('addTask', s, parsed);
  const t = res.state.tasks[res.writes.find((w) => w.col === 'tasks').id];
  assert.equal(t.title, 'Email Mike');
  for (const k of ['tokens', 'catConfidence', 'catReason', 'newCatName', 'recurring']) assert.ok(!(k in t), k);
  assert.equal(t.plan, '2026-10-06');
  assert.equal(t.est, 10);
  assert.equal(t.src, 'dash');
});

test('addTask with newCatName creates the category first, in the same op', () => {
  const s = base();
  const parsed = parseQuickAdd('call grandma #wedplan - fri', { today: TODAY, cats: s.cats });
  assert.equal(parsed.newCatName, 'wedplan');
  const res = run('addTask', s, parsed);
  const catW = res.writes.find((w) => w.col === 'cats');
  assert.equal(catW.op, 'set');
  const cat = res.state.cats[catW.id];
  assert.equal(cat.name, 'wedplan');
  assert.equal(cat.group, 'admin');
  assert.match(cat.color, /^#[0-9a-f]{6}$/);
  const t = Object.values(res.state.tasks).find((x) => x.title === 'Call Grandma');
  assert.equal(t.cat, catW.id);
  assert.deepEqual(types(res), ['cat', 'add']);
  // the category write comes before the task write
  assert.ok(res.writes.indexOf(catW) < res.writes.findIndex((w) => w.col === 'tasks'));
});

test('addTask: newCatGroup picks the group; an existing match reuses the category', () => {
  const s = base();
  const a = run('addTask', s, { title: 'Book venue', newCatName: 'Wedding stuff', newCatGroup: 'life' });
  const cat = Object.values(a.state.cats).find((c) => c.name === 'Wedding stuff');
  assert.equal(cat.group, 'life');
  const b = run('addTask', s, { title: 'Walk', cat: 'inbox', newCatName: 'ziggy' });
  assert.ok(!b.writes.some((w) => w.col === 'cats'));
  assert.equal(Object.values(b.state.tasks).find((t) => t.title === 'Walk').cat, 'ziggy');
});

test('addTask with recurring makes a chore instead of a task', () => {
  const s = base();
  const parsed = parseQuickAdd('walk ziggy twice a day', { today: TODAY, cats: s.cats });
  const res = run('addTask', s, parsed);
  assert.ok(!res.writes.some((w) => w.col === 'tasks'));
  const w = res.writes.find((x) => x.col === 'chores');
  const ch = res.state.chores[w.id];
  assert.match(ch.id, /^c_/);
  assert.equal(ch.every, 1);
  assert.equal(ch.perDay, 2);
  assert.equal(ch.cat, 'ziggy');
  assert.deepEqual(ch.log, []);
  assert.deepEqual(types(res), ['add']);
  // an unknown category on a recurring add falls back to home
  const r2 = run('addTask', s, { title: 'Water the thing', recurring: { every: 3, perDay: 1 } });
  assert.equal(Object.values(r2.state.chores).find((c) => c.title === 'Water the thing').cat, 'home');
});

test('addTask coerces loose values and never overwrites an existing id', () => {
  const s = base();
  const res = run('addTask', s, { id: 't_email', title: 'Dup', time: '3pm', est: '1h30', prio: 'high', due: 'fri', cat: 'Multivariate', project: 'RSA manuscript' });
  const t = Object.values(res.state.tasks).find((x) => x.title === 'Dup');
  assert.notEqual(t.id, 't_email');
  assert.equal(res.state.tasks.t_email.title, 'Email Mike');
  assert.equal(t.time, '15:00');
  assert.equal(t.est, 90);
  assert.equal(t.prio, 2);
  assert.equal(t.due, '2026-10-09');
  assert.equal(t.cat, 'multivar');
  assert.equal(t.project, 'p_rsa');
});

test('addTask: unknown category → inbox; empty title → no-op', () => {
  const s = base();
  const res = run('addTask', s, { title: 'Mystery', cat: 'zzzz-nothing' });
  assert.equal(Object.values(res.state.tasks).find((t) => t.title === 'Mystery').cat, 'inbox');
  assert.deepEqual(run('addTask', s, { title: '   ' }).writes, []);
});

// ---------------------------------------------------------------- status changes

test('completeTask: done, doneAt now, triage cleared; twice is a no-op', () => {
  const s = base();
  const res = run('completeTask', s, { id: 't_triage' });
  const t = res.state.tasks.t_triage;
  assert.equal(t.status, 'done');
  assert.equal(t.doneAt, NOW);
  assert.equal(t.triage, false);
  assert.equal(t.updated, NOW);
  assert.deepEqual(types(res), ['done']);
  assert.equal(res.activity[0].title, 'ABCD review meeting');
  const w = res.writes.find((x) => x.col === 'tasks');
  assert.equal(w.op, 'update');
  assert.deepEqual(Object.keys(w.data).sort(), ['doneAt', 'status', 'triage', 'updated']);
  assert.deepEqual(run('completeTask', res.state, { id: 't_triage' }).writes, []);
});

test('reopenTask and dropTask', () => {
  const s = base();
  const r = run('reopenTask', s, { id: 't_notes' });
  assert.equal(r.state.tasks.t_notes.status, 'todo');
  assert.equal(r.state.tasks.t_notes.doneAt, null);
  assert.deepEqual(types(r), ['undone']);
  assert.deepEqual(run('reopenTask', s, { id: 't_email' }).writes, []);

  const d = run('dropTask', s, { id: 't_triage' });
  assert.equal(d.state.tasks.t_triage.status, 'dropped');
  assert.equal(d.state.tasks.t_triage.triage, false);
  assert.deepEqual(types(d), ['drop']);
  const d2 = run('dropTask', s, { id: 't_notes' }); // done → dropped clears doneAt
  assert.equal(d2.state.tasks.t_notes.doneAt, null);
  assert.deepEqual(run('dropTask', s, { id: 't_dropped' }).writes, []);
});

test('deleteTask removes the task and logs its title', () => {
  const s = base();
  const res = run('deleteTask', s, { id: 't_email' });
  assert.ok(!('t_email' in res.state.tasks));
  assert.deepEqual(res.writes[0], { op: 'delete', col: 'tasks', id: 't_email' });
  assert.equal(res.activity[0].type, 'delete');
  assert.equal(res.activity[0].title, 'Email Mike');
});

// ---------------------------------------------------------------- moves

test('moveTask: later plan bumps moved, earlier does not; from/to logged', () => {
  const s = base();
  const later = run('moveTask', s, { id: 't_email', to: '2026-10-08' });
  assert.equal(later.state.tasks.t_email.plan, '2026-10-08');
  assert.equal(later.state.tasks.t_email.moved, 1);
  assert.deepEqual(types(later), ['move']);
  assert.equal(later.activity[0].from, '2026-10-05');
  assert.equal(later.activity[0].to, '2026-10-08');
  const back = run('moveTask', later.state, { id: 't_email', to: '2026-10-06' });
  assert.equal(back.state.tasks.t_email.moved, 1);
  const w = later.writes.find((x) => x.col === 'tasks');
  assert.deepEqual(Object.keys(w.data).sort(), ['moved', 'plan', 'updated']);
});

test('moveTask: no previous plan counts against the due date; nothing → no bump', () => {
  const s = base();
  // t_irb: plan null, due 10/02 → moving to 10/07 is a push
  assert.equal(run('moveTask', s, { id: 't_irb', to: '2026-10-07' }).state.tasks.t_irb.moved, 1);
  // t_closet: no plan, no due → scheduling it is not a push
  assert.equal(run('moveTask', s, { id: 't_closet', to: '2026-10-07' }).state.tasks.t_closet.moved, 0);
  // t_big: due 10/21, moving plan to 10/10 (before due) is not a push
  assert.equal(run('moveTask', s, { id: 't_big', to: '2026-10-10' }).state.tasks.t_big.moved, 0);
});

test('moveTask clears triage, takes date phrases, null = backlog; junk/same → no-op', () => {
  const s = base();
  const t = run('moveTask', s, { id: 't_triage', to: 'tomorrow' });
  assert.equal(t.state.tasks.t_triage.plan, '2026-10-06');
  assert.equal(t.state.tasks.t_triage.triage, false);
  const bl = run('moveTask', s, { id: 't_email', to: null });
  assert.equal(bl.state.tasks.t_email.plan, null);
  assert.equal(bl.state.tasks.t_email.moved, 0);
  assert.equal(bl.activity[0].to, null);
  assert.deepEqual(run('moveTask', s, { id: 't_email', to: 'someday maybe' }).writes, []);
  assert.deepEqual(run('moveTask', s, { id: 't_email', to: '2026-10-05' }).writes, []);
  assert.deepEqual(run('moveTask', s, { id: 't_email' }).writes, []);
});

test('moveBlock changes the day and pins the block (auto:false)', () => {
  const s = base();
  const res = run('moveBlock', s, { id: 't_predis', blockId: 'b_p_auto', to: '2026-10-09' });
  const b = res.state.tasks.t_predis.blocks.find((x) => x.id === 'b_p_auto');
  assert.equal(b.d, '2026-10-09');
  assert.equal(b.auto, false);
  assert.equal(res.state.tasks.t_predis.blocks.length, 3);
  assert.deepEqual(types(res), ['block']);
  assert.equal(res.activity[0].from, '2026-10-07');
  assert.equal(res.activity[0].to, '2026-10-09');
  assert.deepEqual(run('moveBlock', s, { id: 't_predis', blockId: 'b_p_man', to: '2026-10-06' }).writes, []);
  assert.deepEqual(run('moveBlock', s, { id: 't_predis', blockId: 'b_p_auto', to: 'garbage' }).writes, []);
});

test('toggleBlock adds / removes block minutes from spent, never below 0', () => {
  const s = base();
  const on = run('toggleBlock', s, { id: 't_glm', blockId: 'b_glm1' });
  assert.equal(on.state.tasks.t_glm.blocks[0].done, true);
  assert.equal(on.state.tasks.t_glm.spent, 60);
  const off = run('toggleBlock', on.state, { id: 't_glm', blockId: 'b_glm1' });
  assert.equal(off.state.tasks.t_glm.blocks[0].done, false);
  assert.equal(off.state.tasks.t_glm.spent, 0);
  // t_predis has spent 60 and a done 60m block; force spent 0 then un-check
  const s2 = base((x) => { x.tasks.t_predis.spent = 0; });
  assert.equal(run('toggleBlock', s2, { id: 't_predis', blockId: 'b_p_done' }).state.tasks.t_predis.spent, 0);
});

// ---------------------------------------------------------------- editTask

test('editTask writes only fields that changed, normalized', () => {
  const s = base();
  const res = run('editTask', s, { id: 't_email', patch: { est: '30m', notes: 're: grant', title: 'Email Mike', cat: 'Admin', spent: 999, id: 'x', created: 'x' } });
  const w = res.writes.find((x) => x.col === 'tasks');
  assert.equal(w.op, 'update');
  assert.deepEqual(Object.keys(w.data).sort(), ['est', 'notes', 'updated']);
  assert.equal(res.state.tasks.t_email.est, 30);
  assert.equal(res.state.tasks.t_email.spent, 0);
  assert.equal(res.state.tasks.t_email.id, 't_email');
  assert.deepEqual(types(res), ['edit']);
  assert.equal(res.activity[0].to, 'est,notes');
});

test('editTask: status done sets doneAt; plan later bumps moved; bad values ignored', () => {
  const s = base();
  const done = run('editTask', s, { id: 't_email', patch: { status: 'done' } });
  assert.equal(done.state.tasks.t_email.doneAt, NOW);
  assert.deepEqual(types(done), ['done']);
  const undone = run('editTask', done.state, { id: 't_email', patch: { status: 'todo' } });
  assert.equal(undone.state.tasks.t_email.doneAt, null);
  assert.deepEqual(types(undone), ['undone']);

  const mv = run('editTask', s, { id: 't_triage', patch: { plan: '2026-10-09' } });
  assert.equal(mv.state.tasks.t_triage.moved, 1); // due 9/28 → plan 10/9 is a push
  assert.equal(mv.state.tasks.t_triage.triage, false);
  assert.deepEqual(types(mv), ['move']);

  const bad = run('editTask', s, { id: 't_email', patch: { due: 'not a date', prio: 'urgentish', kind: 'party', cat: 'zzzz' } });
  assert.deepEqual(bad.writes, []);
  const clear = run('editTask', s, { id: 't_hw', patch: { due: null, est: null } });
  assert.equal(clear.state.tasks.t_hw.due, null);
  assert.equal(clear.state.tasks.t_hw.est, null);
  assert.deepEqual(run('editTask', s, { id: 't_email', patch: { title: 'Email Mike', est: 10 } }).writes, []);
});

test('editTask can replace subs and blocks wholesale (normalized)', () => {
  const s = base();
  const res = run('editTask', s, { id: 't_big', patch: { subs: [{ t: 'Outline' }, 'Intro'], blocks: [{ id: 'b_x', d: '2026-10-07', m: 60 }, { d: 'bad', m: 30 }] } });
  const t = res.state.tasks.t_big;
  assert.deepEqual(t.subs, [{ id: 's1', t: 'Outline', done: false }, { id: 's2', t: 'Intro', done: false }]);
  assert.deepEqual(t.blocks, [{ id: 'b_x', d: '2026-10-07', m: 60, done: false, auto: true }]);
});

// ---------------------------------------------------------------- subtasks

test('addSub / toggleSub / removeSub', () => {
  const s = base();
  const a = run('addSub', s, { id: 't_big', t: 'Read manual', est: '3h' });
  assert.deepEqual(a.state.tasks.t_big.subs, [{ id: 's1', t: 'Read manual', done: false, est: 180 }]);
  const b = run('addSub', a.state, { id: 't_big', t: 'Draft methods' });
  assert.equal(b.state.tasks.t_big.subs[1].id, 's2');
  const c = run('toggleSub', b.state, { id: 't_big', subId: 's1' });
  assert.equal(c.state.tasks.t_big.subs[0].done, true);
  assert.equal(c.activity[0].type, 'sub');
  assert.equal(c.activity[0].to, 'done');
  const d = run('removeSub', c.state, { id: 't_big', subId: 's1' });
  assert.deepEqual(d.state.tasks.t_big.subs.map((x) => x.id), ['s2']);
  const e = run('addSub', d.state, { id: 't_big', t: 'Again' });
  assert.equal(e.state.tasks.t_big.subs[1].id, 's3');
  assert.deepEqual(run('addSub', s, { id: 't_big', t: '  ' }).writes, []);
});

// ---------------------------------------------------------------- clock

test('clockIn sets the meta clock; same ref again is a no-op', () => {
  const s = base();
  const res = run('clockIn', s, { ref: 'chore:c_laundry', title: 'Laundry', cat: 'home', goal: 5 });
  assert.deepEqual(res.state.clock, { active: true, ref: 'chore:c_laundry', title: 'Laundry', cat: 'home', start: NOW, goal: 5 });
  const w = res.writes.find((x) => x.col === 'meta');
  assert.equal(w.op, 'set');
  assert.equal(w.id, 'clock');
  assert.deepEqual(types(res), ['clock']);
  assert.deepEqual(run('clockIn', res.state, { ref: 'chore:c_laundry' }, { ...ctx, now: at(3) }).writes, []);
});

test('clockIn fills title/cat/goal from the ref', () => {
  const s = base();
  const t = run('clockIn', s, { ref: 'task:t_email' });
  assert.equal(t.state.clock.title, 'Email Mike');
  assert.equal(t.state.clock.cat, 'admin');
  assert.equal(t.state.clock.goal, 5);
  const free = run('clockIn', s, { title: 'Inbox zero' });
  assert.equal(free.state.clock.ref, 'free');
  assert.equal(free.state.clock.title, 'Inbox zero');
  assert.deepEqual(run('clockIn', s, { ref: 'task:t_nope' }).writes, []);
});

test('clockIn while another clock runs logs the running one first (not marked done)', () => {
  const s = base();
  const one = run('clockIn', s, { ref: 'task:t_email' });
  const two = run('clockIn', one.state, { ref: 'chore:c_laundry' }, { ...ctx, now: at(7) });
  const sessions = Object.values(two.state.sessions).filter((x) => x.ref === 'task:t_email');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].min, 7);
  assert.equal(two.state.tasks.t_email.spent, 7);
  assert.equal(two.state.tasks.t_email.status, 'todo');
  assert.equal(two.state.clock.ref, 'chore:c_laundry');
  assert.equal(two.state.clock.start, at(7));
  assert.deepEqual(types(two), ['clock', 'clock']);
  // a different free-text clock is not "the same ref"
  const f1 = run('clockIn', s, { title: 'Inbox zero' });
  const f2 = run('clockIn', f1.state, { title: 'Desk reset' }, { ...ctx, now: at(4) });
  assert.equal(f2.state.clock.title, 'Desk reset');
});

test('clockOut on a task: session, spent += minutes, markDone completes it', () => {
  const s = base();
  const on = run('clockIn', s, { ref: 'task:t_hw' });
  const off = run('clockOut', on.state, { markDone: true }, { ...ctx, now: at(12) });
  const sess = Object.values(off.state.sessions).find((x) => x.ref === 'task:t_hw');
  assert.match(sess.id, /^s_[0-9a-z]{8}$/);
  assert.deepEqual({ ...sess, id: 'x' }, { id: 'x', ref: 'task:t_hw', title: 'Multivariate HW 3', cat: 'multivar', start: NOW, end: at(12), min: 12, d: TODAY });
  assert.equal(off.state.tasks.t_hw.spent, 42);
  assert.equal(off.state.tasks.t_hw.status, 'done');
  assert.equal(off.state.tasks.t_hw.doneAt, at(12));
  assert.deepEqual(off.state.clock, { active: false });
  assert.deepEqual(types(off), ['clock', 'done']);
  assert.equal(off.activity[0].to, '12m');
});

test('clockOut: at least 1 minute; session day is the local date of the start', () => {
  const start = '2026-10-06T02:00:00.000Z'; // 22:00 ET on 10/5
  const s = base((x) => { x.clock = { active: true, ref: 'free', title: 'Late night', cat: 'inbox', start, goal: 5 }; });
  const off = run('clockOut', s, {}, { ...ctx, now: '2026-10-06T02:00:20.000Z', today: '2026-10-05' });
  const sess = Object.values(off.state.sessions).find((x) => x.title === 'Late night');
  assert.equal(sess.min, 1);
  assert.equal(sess.d, '2026-10-05');
  assert.deepEqual(run('clockOut', base(), {}).writes, []);
});

test('clockOut on a chore marks it done today, even after 5 minutes', () => {
  const s = base();
  const on = run('clockIn', s, { ref: 'chore:c_trash' });
  const off = run('clockOut', on.state, {}, { ...ctx, now: at(5) });
  assert.equal(off.state.chores.c_trash.last, TODAY);
  assert.deepEqual(off.state.chores.c_trash.log, ['2026-09-20', TODAY]);
  assert.deepEqual(types(off), ['clock', 'chore']);
});

test('logTime: a session ending now, with the clockOut side effects', () => {
  const s = base();
  const res = run('logTime', s, { ref: 'task:t_big', minutes: '45m' });
  const sess = Object.values(res.state.sessions).find((x) => x.ref === 'task:t_big');
  assert.equal(sess.min, 45);
  assert.equal(sess.end, NOW);
  assert.equal(sess.start, at(-45));
  assert.equal(sess.d, TODAY);
  assert.equal(res.state.tasks.t_big.spent, 45);
  assert.equal(res.state.tasks.t_big.status, 'todo');
  const ch = run('logTime', s, { ref: 'chore:c_plants', minutes: 5 });
  assert.equal(ch.state.chores.c_plants.last, TODAY);
  const free = run('logTime', s, { ref: 'free', minutes: 20, title: 'Admin sweep', cat: 'admin' });
  assert.equal(Object.values(free.state.sessions).find((x) => x.title === 'Admin sweep').cat, 'admin');
  assert.deepEqual(run('logTime', s, { ref: 'task:t_big', minutes: 0 }).writes, []);
  assert.deepEqual(run('logTime', s, { ref: 'task:t_big', minutes: 'lots' }).writes, []);
});

// ---------------------------------------------------------------- chores

test('choreDone: last = today, log appended (repeats allowed), capped at 90', () => {
  const s = base();
  const res = run('choreDone', s, { id: 'c_ziggy' });
  assert.equal(res.state.chores.c_ziggy.last, TODAY);
  assert.deepEqual(res.state.chores.c_ziggy.log.slice(-2), [TODAY, TODAY]);
  assert.equal(res.state.chores.c_ziggy.updated, NOW);
  assert.deepEqual(types(res), ['chore']);
  const long = Array.from({ length: 90 }, (_, i) => `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`);
  const s2 = base((x) => { x.chores.c_laundry.log = long; });
  const r2 = run('choreDone', s2, { id: 'c_laundry' });
  assert.equal(r2.state.chores.c_laundry.log.length, 90);
  assert.equal(r2.state.chores.c_laundry.log[89], TODAY);
  assert.equal(r2.state.chores.c_laundry.log[0], long[1]);
});

test('addChore / editChore / deleteChore', () => {
  const s = base();
  const a = run('addChore', s, { title: 'Vacuum', every: 7, cat: 'home' });
  const id = a.writes.find((w) => w.col === 'chores').id;
  assert.equal(a.state.chores[id].every, 7);
  assert.equal(a.state.chores[id].min, 5);
  assert.equal(a.state.chores[id].created, NOW);
  const e = run('editChore', a.state, { id, patch: { every: 1, perDay: 2, title: '  Vacuum upstairs ' } });
  const w = e.writes.find((x) => x.col === 'chores');
  assert.deepEqual(Object.keys(w.data).sort(), ['every', 'perDay', 'title', 'updated']);
  assert.equal(e.state.chores[id].title, 'Vacuum upstairs');
  const e2 = run('editChore', e.state, { id, patch: { every: 3 } });
  assert.equal(e2.state.chores[id].perDay, 1); // perDay only applies to daily chores
  assert.deepEqual(run('editChore', e2.state, { id, patch: { every: 'often', log: 'x' } }).writes, []);
  const d = run('deleteChore', e2.state, { id });
  assert.ok(!(id in d.state.chores));
  assert.deepEqual(types(d), ['delete']);
});

// ---------------------------------------------------------------- categories

test('addCategory: unique slug id + color; exact duplicate is a no-op', () => {
  const s = base();
  const res = run('addCategory', s, { name: 'Wedding', group: 'life' });
  const cat = res.state.cats.wedding;
  assert.ok(cat);
  assert.equal(cat.group, 'life');
  assert.match(cat.color, /^#[0-9a-f]{6}$/);
  assert.equal(cat.created, NOW);
  assert.deepEqual(types(res), ['cat']);
  assert.deepEqual(run('addCategory', s, { name: 'RSA' }).writes, []);
  assert.deepEqual(run('addCategory', s, { name: '' }).writes, []);
  const clash = run('addCategory', s, { name: 'Home!' }); // slug "home" taken by a different name → home-2
  assert.ok(clash.state.cats['home-2']);
});

test('editCategory: changes allowed fields, never the id; inbox cannot be archived', () => {
  const s = base();
  const res = run('editCategory', s, { id: 'rsa', patch: { name: 'RSA paper', color: '#AABBCC', id: 'hacked', aliases: ['rsa', 'nyx', 'RSA'], group: 'nope' } });
  const cat = res.state.cats.rsa;
  assert.equal(cat.id, 'rsa');
  assert.ok(!res.state.cats.hacked);
  assert.equal(cat.name, 'RSA paper');
  assert.equal(cat.color, '#aabbcc');
  assert.deepEqual(cat.aliases, ['rsa', 'nyx']);
  assert.equal(cat.group, 'research');
  assert.deepEqual(run('editCategory', s, { id: 'rsa', patch: { color: 'red' } }).writes, []);
  assert.deepEqual(run('editCategory', s, { id: 'inbox', patch: { archived: true } }).writes, []);
  assert.equal(run('editCategory', s, { id: 'dev', patch: { archived: true } }).state.cats.dev.archived, true);
});

// ---------------------------------------------------------------- projects

test('addProject / editProject / addMilestone / toggleMilestone', () => {
  const s = base();
  const a = run('addProject', s, { name: 'DTI paper', cat: 'dti', due: '2026-12-15', goal: 'Submit' });
  const id = a.writes.find((w) => w.col === 'projects').id;
  assert.match(id, /^p_/);
  assert.equal(a.state.projects[id].status, 'active');
  assert.equal(a.state.projects[id].due, '2026-12-15');
  const e = run('editProject', a.state, { id, patch: { status: 'paused', name: 'DTI paper', notes: 'waiting on data' } });
  assert.deepEqual(Object.keys(e.writes.find((w) => w.col === 'projects').data).sort(), ['notes', 'status', 'updated']);
  const m = run('addMilestone', e.state, { id, t: 'Figures', due: 'nov 1' });
  assert.deepEqual(m.state.projects[id].milestones, [{ id: 'm1', t: 'Figures', due: '2026-11-01', done: false, doneAt: null }]);
  const t = run('toggleMilestone', m.state, { id, msId: 'm1' });
  assert.equal(t.state.projects[id].milestones[0].done, true);
  assert.equal(t.state.projects[id].milestones[0].doneAt, NOW);
  assert.deepEqual(types(t), ['milestone']);
  const u = run('toggleMilestone', t.state, { id, msId: 'm1' });
  assert.equal(u.state.projects[id].milestones[0].doneAt, null);
  assert.equal(run('addMilestone', s, { id: 'p_rsa', t: 'Submit' }).state.projects.p_rsa.milestones[3].id, 'm4');
});

// ---------------------------------------------------------------- allocation, brief, settings

test('applyAllocation writes each task\'s new blocks (one activity)', () => {
  const s = base();
  const { updates } = allocate(s, { today: TODAY });
  assert.ok(Object.keys(updates).length >= 1);
  const res = run('applyAllocation', s, { updates });
  for (const [id, blocks] of Object.entries(updates)) assert.deepEqual(res.state.tasks[id].blocks, blocks);
  assert.equal(res.activity.length, 1);
  assert.equal(res.activity[0].type, 'block');
  assert.deepEqual(run('applyAllocation', res.state, { updates }).writes, []);
  assert.deepEqual(run('applyAllocation', s, { updates: { t_nope: [] } }).writes, []);
});

test('setBrief stamps the brief with ctx.now (no activity)', () => {
  const s = base();
  const res = run('setBrief', s, { headline: 'Go.', lines: ['a'], asks: ['b?'], focus: ['t_email'], text: 'ignored', at: 'old' });
  assert.deepEqual(res.state.brief, { at: NOW, headline: 'Go.', lines: ['a'], asks: ['b?'], focus: ['t_email'] });
  assert.deepEqual(res.writes, [{ op: 'set', col: 'meta', id: 'brief', data: res.state.brief }]);
  assert.deepEqual(res.activity, []);
});

test('editSettings merges cap per day, validates tz, logs "settings"', () => {
  const s = base();
  const res = run('editSettings', s, { patch: { cap: { fri: 60 }, offDays: ['2026-11-26'], tz: 'Not/AZone' } });
  assert.equal(res.state.settings.cap.fri, 60);
  assert.equal(res.state.settings.cap.mon, 240);
  assert.deepEqual(res.state.settings.offDays, ['2026-11-26']);
  assert.equal(res.state.settings.tz, 'America/New_York');
  assert.deepEqual(types(res), ['settings']);
  assert.equal(res.activity[0].to, 'cap,offDays');
  assert.deepEqual(run('editSettings', s, { patch: { cap: { mon: 240 } } }).writes, []);
  assert.equal(run('editSettings', s, { patch: { tz: 'America/Chicago' } }).state.settings.tz, 'America/Chicago');
});

// ---------------------------------------------------------------- cross-cutting

test('activity src defaults to "dash"; ctx.src is honored', () => {
  const s = base();
  assert.equal(OPS.completeTask(s, { id: 't_email' }, { now: NOW, today: TODAY }).activity[0].src, 'dash');
  assert.equal(OPS.completeTask(s, { id: 't_email' }, { ...ctx, src: 'chat' }).activity[0].src, 'chat');
});

test('writes replay onto a newer remote state (the website conflict path)', () => {
  const s = base();
  const ours = run('moveTask', s, { id: 't_email', to: '2026-10-07' });
  // meanwhile Claude completed another task and edited this one's notes
  const remote = run('editTask', run('completeTask', s, { id: 't_hw' }, { ...ctx, src: 'chat' }).state, { id: 't_email', patch: { notes: 'from chat' } }).state;
  const merged = applyWrites(remote, ours.writes);
  assert.equal(merged.tasks.t_email.plan, '2026-10-07');
  assert.equal(merged.tasks.t_email.notes, 'from chat');
  assert.equal(merged.tasks.t_hw.status, 'done');
  assert.ok(merged.activity[ours.activity[0].id]);
});

test('ops work on a fresh empty state', () => {
  let s = deepFreeze(emptyState());
  const r1 = run('addTask', s, { title: 'First thing', newCatName: 'Stuff' });
  assert.equal(Object.keys(r1.state.tasks).length, 1);
  assert.ok(r1.state.cats.stuff);
  s = r1.state;
  const id = Object.keys(s.tasks)[0];
  const r2 = run('completeTask', s, { id });
  assert.equal(r2.state.tasks[id].status, 'done');
  const r3 = run('clockIn', r2.state, { title: 'Focus' });
  const r4 = run('clockOut', r3.state, {}, { ...ctx, now: at(30) });
  assert.equal(Object.values(r4.state.sessions)[0].min, 30);
});
