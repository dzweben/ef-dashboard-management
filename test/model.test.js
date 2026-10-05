import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, normalizeTask, normalizeChore, normalizeState, serializeState, applyWrites, diffWrites, normalizeProject,
  makeId, slugify, normalizeCategory, normalizeSettings,
} from '../src/engine/model.js';

const ctx = { now: '2026-10-05T14:00:00.000Z' };

test('makeId has prefix + 8 base36 chars', () => {
  const id = makeId('t_');
  assert.match(id, /^t_[0-9a-z]{8}$/);
  assert.notEqual(makeId('t_'), makeId('t_'));
});

test('normalizeTask fills defaults and rejects junk', () => {
  const t = normalizeTask({ title: '  Email Mike ', plan: '2026-10-06', est: '30', prio: 9, due: 'tomorrow', time: '3pm' }, ctx);
  assert.equal(t.title, 'Email Mike');
  assert.equal(t.plan, '2026-10-06');
  assert.equal(t.due, null);
  assert.equal(t.time, null);
  assert.equal(t.est, null);
  assert.equal(t.prio, 3);
  assert.equal(t.status, 'todo');
  assert.equal(t.doneAt, null);
  assert.equal(t.cat, 'inbox');
  assert.deepEqual(t.blocks, []);
});

test('normalizeTask keeps doneAt only for done tasks', () => {
  assert.equal(normalizeTask({ title: 'x', status: 'done' }, ctx).doneAt, ctx.now);
  assert.equal(normalizeTask({ title: 'x', status: 'todo', doneAt: ctx.now }, ctx).doneAt, null);
});

test('normalizeChore derives last from log and caps log', () => {
  const log = Array.from({ length: 120 }, (_, i) => `2026-0${(i % 9) + 1}-1${i % 9}`).sort();
  const c = normalizeChore({ title: 'Laundry', every: 7, log }, ctx);
  assert.equal(c.log.length, 90);
  assert.equal(c.last, c.log[c.log.length - 1]);
  assert.equal(c.perDay, 1);
});

test('slugify + normalizeCategory', () => {
  assert.equal(slugify('Neuro Seminar (Fall)'), 'neuro-seminar-fall');
  const c = normalizeCategory({ name: 'Neuro Seminar', group: 'coursework', color: '#ABCDEF', aliases: ['Neuro', 'neuro'] }, ctx);
  assert.equal(c.id, 'neuro-seminar');
  assert.equal(c.color, '#abcdef');
  assert.deepEqual(c.aliases, ['neuro']);
  assert.equal(c.glyph, 'NE');
});

test('normalizeSettings clamps and keeps cap keys', () => {
  const s = normalizeSettings({ cap: { mon: -5, tue: 100.4, bogus: 3 }, minBlock: 1, offDays: ['2026-11-26', 'nope'] });
  assert.equal(s.cap.mon, 0);
  assert.equal(s.cap.tue, 100);
  assert.equal(s.cap.bogus, undefined);
  assert.equal(s.minBlock, 5);
  assert.deepEqual(s.offDays, ['2026-11-26']);
});

test('serializeState is stable and round-trips', () => {
  const s = emptyState();
  const b = normalizeTask({ id: 't_b', title: 'B' }, ctx);
  const a = normalizeTask({ id: 't_a', title: 'A' }, ctx);
  s.tasks = { t_b: b, t_a: a };
  const out = serializeState(s);
  assert.ok(out.indexOf('"t_a"') < out.indexOf('"t_b"'));
  assert.ok(out.endsWith('\n'));
  assert.equal(serializeState(normalizeState(JSON.parse(out))), out);
});

test('normalizeState accepts arrays and maps, drops junk', () => {
  const s = normalizeState({ tasks: [{ id: 't_x', title: 'X' }, null, 5], chores: { c_1: { title: 'Laundry' } }, bogus: 1 });
  assert.equal(s.tasks.t_x.title, 'X');
  assert.equal(s.chores.c_1.id, 'c_1');
  assert.equal(s.bogus, undefined);
  assert.ok(s.cats.inbox);
});

test('applyWrites set/update/delete + meta, without mutating input', () => {
  const s = emptyState();
  const frozen = JSON.stringify(s);
  const t = normalizeTask({ id: 't_1', title: 'One' }, ctx);
  const next = applyWrites(s, [
    { op: 'set', col: 'tasks', id: 't_1', data: t },
    { op: 'update', col: 'tasks', id: 't_1', data: { status: 'done' } },
    { op: 'update', col: 'tasks', id: 't_missing', data: { status: 'done' } },
    { op: 'set', col: 'meta', id: 'clock', data: { active: true, ref: 'free', title: 'x', cat: 'inbox', start: ctx.now, goal: 5 } },
    { op: 'set', col: 'bogus', id: 'x', data: {} },
  ]);
  assert.equal(JSON.stringify(s), frozen);
  assert.equal(next.tasks.t_1.status, 'done');
  assert.equal(next.tasks.t_missing, undefined);
  assert.equal(next.clock.active, true);
  const gone = applyWrites(next, [{ op: 'delete', col: 'tasks', id: 't_1' }, { op: 'delete', col: 'meta', id: 'clock' }]);
  assert.equal(gone.tasks.t_1, undefined);
  assert.deepEqual(gone.clock, { active: false });
});

test('diffWrites replays one side onto another (3-way merge)', () => {
  const base = emptyState();
  base.tasks = {
    t_1: normalizeTask({ id: 't_1', title: 'One', plan: '2026-10-05' }, ctx),
    t_2: normalizeTask({ id: 't_2', title: 'Two' }, ctx),
    t_3: normalizeTask({ id: 't_3', title: 'Three' }, ctx),
  };
  // ours: complete t_1, delete t_3, add t_4
  const ours = applyWrites(base, [
    { op: 'update', col: 'tasks', id: 't_1', data: { status: 'done', doneAt: ctx.now } },
    { op: 'delete', col: 'tasks', id: 't_3' },
    { op: 'set', col: 'tasks', id: 't_4', data: normalizeTask({ id: 't_4', title: 'Four' }, ctx) },
  ]);
  // theirs: move t_1 (different field), rename t_2
  const theirs = applyWrites(base, [
    { op: 'update', col: 'tasks', id: 't_1', data: { plan: '2026-10-07' } },
    { op: 'update', col: 'tasks', id: 't_2', data: { title: 'Two!' } },
  ]);
  const merged = applyWrites(theirs, diffWrites(base, ours));
  assert.equal(merged.tasks.t_1.status, 'done');
  assert.equal(merged.tasks.t_1.plan, '2026-10-07');
  assert.equal(merged.tasks.t_2.title, 'Two!');
  assert.equal(merged.tasks.t_3, undefined);
  assert.equal(merged.tasks.t_4.title, 'Four');
  assert.deepEqual(diffWrites(base, base), []);
});

// ---------------------------------------------------------------- fine-grained writes (inc / arr) + 3-way merge

import { OPS } from '../src/engine/ops.js';
import { allocate } from '../src/engine/schedule.js';
import { fixture, deepFreeze, TODAY, NOW } from './fixtures/engine-fixture.js';

const chat = { now: NOW, today: TODAY, src: 'chat' };
const dash = { now: '2026-10-05T14:01:00.000Z', today: TODAY, src: 'dash' };
/** Run a list of [op, args] on a state; returns the final state. */
const play = (state, steps, c) => steps.reduce((s, [op, args]) => OPS[op](s, args, c).state, state);
/** The CLI / store merge: our changes since `base`, replayed on top of `theirs`. */
const merge = (base, ours, theirs) => applyWrites(theirs, diffWrites(base, ours));
const subsOf = (s, id) => s.tasks[id].subs.map((x) => `${x.id}:${x.t}:${x.done ? 'x' : '-'}`);

test('applyWrites inc: adds a delta to the current value (missing → 0), floored at 0', () => {
  const s = emptyState();
  s.tasks.t_1 = normalizeTask({ id: 't_1', title: 'One', spent: 30 }, ctx);
  const frozen = JSON.stringify(s);
  const next = applyWrites(s, [
    { op: 'update', col: 'tasks', id: 't_1', data: { notes: 'x' }, inc: { spent: 25, moved: 1 } },
    { op: 'update', col: 'tasks', id: 't_1', inc: { spent: 10, bogus: 'x' } },
    { op: 'update', col: 'tasks', id: 't_missing', inc: { spent: 10 } },
  ]);
  assert.equal(JSON.stringify(s), frozen);
  assert.equal(next.tasks.t_1.spent, 65);
  assert.equal(next.tasks.t_1.moved, 1);
  assert.equal(next.tasks.t_1.notes, 'x');
  assert.equal(next.tasks.t_missing, undefined);
  const t = { ...next.tasks.t_1 };
  delete t.moved;
  next.tasks.t_1 = t;
  assert.equal(applyWrites(next, [{ op: 'update', col: 'tasks', id: 't_1', inc: { moved: 2, spent: -500 } }]).tasks.t_1.moved, 2);
  assert.equal(applyWrites(next, [{ op: 'update', col: 'tasks', id: 't_1', inc: { spent: -500 } }]).tasks.t_1.spent, 0);
  // inc runs after data's shallow merge
  assert.equal(applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_1', data: { spent: 100 }, inc: { spent: 5 } }]).tasks.t_1.spent, 105);
});

test('applyWrites arr on id arrays: upsert replaces in place or appends; remove by id', () => {
  const s = emptyState();
  s.tasks.t_1 = normalizeTask({ id: 't_1', title: 'One', subs: [{ id: 's1', t: 'A' }, { id: 's2', t: 'B' }, { id: 's3', t: 'C' }] }, ctx);
  s.projects.p_1 = normalizeProject({ id: 'p_1', name: 'P', milestones: [{ id: 'm1', t: 'M1' }] }, ctx);
  const next = applyWrites(s, [
    { op: 'update', col: 'tasks', id: 't_1', arr: { subs: { upsert: [{ id: 's2', t: 'B!', done: true }, { id: 's9', t: 'Z', done: false }], remove: ['s1'] } } },
    { op: 'update', col: 'projects', id: 'p_1', arr: { milestones: { upsert: [{ id: 'm2', t: 'M2', due: null, done: false, doneAt: null }] } } },
  ]);
  assert.deepEqual(subsOf(next, 't_1'), ['s2:B!:x', 's3:C:-', 's9:Z:-']);
  assert.deepEqual(next.projects.p_1.milestones.map((m) => m.id), ['m1', 'm2']);
  // insert never overwrites a different element that already has the id; patch merges fields; was guards a remove
  const more = applyWrites(next, [{ op: 'update', col: 'tasks', id: 't_1', arr: { subs: {
    insert: [{ id: 's3', t: 'Mine', done: false }, { id: 's9', t: 'Z', done: false }],
    patch: { s2: { t: 'B2' }, s404: { t: 'gone' } },
    remove: ['s9', 's3'], was: { s3: { id: 's3', t: 'C (old)', done: false } },
  } } }]);
  // order: remove (s9 goes; s3 changed since `was`, so it stays), upsert, insert (s3 taken → s4; s9 re-added), patch
  assert.deepEqual(subsOf(more, 't_1'), ['s2:B2:x', 's3:C:-', 's4:Mine:-', 's9:Z:-']);
});

test('applyWrites arr on value arrays: chores.log is a multiset (sorted, last 90); offDays and aliases are sets', () => {
  const s = emptyState();
  s.chores.c_z = normalizeChore({ id: 'c_z', title: 'Walk Ziggy', every: 1, perDay: 2, log: ['2026-10-04', '2026-10-05'] }, ctx);
  s.cats.rsa = normalizeCategory({ id: 'rsa', name: 'RSA', aliases: ['rsa'] }, ctx);
  s.settings = normalizeSettings({ offDays: ['2026-10-09'] });
  const next = applyWrites(s, [
    { op: 'update', col: 'chores', id: 'c_z', arr: { log: { add: ['2026-10-05', '2026-10-03'], remove: ['2026-10-04'] } } },
    { op: 'update', col: 'cats', id: 'rsa', arr: { aliases: { add: ['nyx', 'rsa'] } } },
    { op: 'update', col: 'meta', id: 'settings', arr: { offDays: { add: ['2026-10-08', '2026-10-09'], remove: ['nope'] } } },
  ]);
  assert.deepEqual(next.chores.c_z.log, ['2026-10-03', '2026-10-05', '2026-10-05']);
  assert.deepEqual(next.cats.rsa.aliases, ['rsa', 'nyx']);
  assert.deepEqual(next.settings.offDays, ['2026-10-09', '2026-10-08']);
  assert.deepEqual(applyWrites(next, [{ op: 'update', col: 'meta', id: 'settings', arr: { offDays: { remove: ['2026-10-09'] } } }]).settings.offDays, ['2026-10-08']);
  const long = Array.from({ length: 90 }, (_, i) => `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`);
  s.chores.c_z = { ...s.chores.c_z, log: long };
  const capped = applyWrites(s, [{ op: 'update', col: 'chores', id: 'c_z', arr: { log: { add: ['2026-10-05'] } } }]).chores.c_z.log;
  assert.equal(capped.length, 90);
  assert.equal(capped[89], '2026-10-05');
  assert.equal(capped[0], long[1]);
});

test('applyWrites meta settings update: data merges into cap one level deep', () => {
  const s = emptyState();
  const next = applyWrites(s, [{ op: 'update', col: 'meta', id: 'settings', data: { cap: { mon: 90 }, maxBlock: 90 } }]);
  assert.equal(next.settings.cap.mon, 90);
  assert.equal(next.settings.cap.tue, 240);
  assert.equal(next.settings.cap.sun, 150);
  assert.equal(next.settings.maxBlock, 90);
  // a whole-doc set still replaces; update on a null brief is ignored
  assert.equal(applyWrites(next, [{ op: 'set', col: 'meta', id: 'settings', data: normalizeSettings({}) }]).settings.cap.mon, 240);
  assert.equal(applyWrites(s, [{ op: 'update', col: 'meta', id: 'brief', data: { headline: 'x' } }]).brief, null);
});

test('CLI-10: normalizeSettings keeps capOverrides (valid dates, whole minutes, sorted) and they merge per date', () => {
  const s = normalizeSettings({ capOverrides: { '2026-10-09': 120.4, '2026-10-06': 90, tomorrow: 30, '2026-10-07': null, '2026-10-08': 'x', '2026-10-10': -5 } });
  assert.deepEqual(s.capOverrides, { '2026-10-06': 90, '2026-10-09': 120, '2026-10-10': 0 });
  assert.deepEqual(Object.keys(s.capOverrides), ['2026-10-06', '2026-10-09', '2026-10-10']);
  assert.deepEqual(normalizeSettings({}).capOverrides, {});
  assert.deepEqual(normalizeState({}).settings.capOverrides, {});
  // chat sets tomorrow while the website sets friday: both survive the 3-way merge
  const base = emptyState();
  const ours = { ...base, settings: normalizeSettings({ ...base.settings, capOverrides: { '2026-10-06': 90 } }) };
  const theirs = { ...base, settings: normalizeSettings({ ...base.settings, capOverrides: { '2026-10-09': 60 } }) };
  const merged = normalizeState(applyWrites(theirs, diffWrites(base, ours)));
  assert.deepEqual(merged.settings.capOverrides, { '2026-10-06': 90, '2026-10-09': 60 });
  // removing an override round-trips too
  const cleared = { ...ours, settings: normalizeSettings({ ...ours.settings, capOverrides: {} }) };
  assert.deepEqual(applyWrites(ours, diffWrites(ours, cleared)).settings.capOverrides, {});
});

test('diffWrites emits inc / arr for the known fields, field-level settings, and still round-trips', () => {
  const base = deepFreeze(fixture());
  const next = play(base, [
    ['logTime', { ref: 'task:t_big', minutes: 30 }],
    ['moveTask', { id: 't_email', to: '2026-10-08' }],
    ['addSub', { id: 't_big', t: 'Outline' }],
    ['toggleBlock', { id: 't_glm', blockId: 'b_glm1' }],
    ['choreDone', { id: 'c_ziggy' }],
    ['editSettings', { patch: { cap: { sun: 60 }, offDays: ['2026-10-10', '2026-10-17'] } }],
    ['toggleMilestone', { id: 'p_rsa', msId: 'm2' }],
  ], chat);
  const ws = diffWrites(base, next);
  const upd = (col, id) => ws.find((w) => w.op === 'update' && w.col === col && w.id === id);
  assert.deepEqual(upd('tasks', 't_big').inc, { spent: 30 });
  assert.deepEqual(upd('tasks', 't_big').arr.subs, { insert: [{ id: 's1', t: 'Outline', done: false }] });
  assert.ok(!('subs' in upd('tasks', 't_big').data) && !('spent' in upd('tasks', 't_big').data));
  assert.deepEqual(upd('tasks', 't_email').inc, { moved: 1 });
  assert.deepEqual(upd('tasks', 't_glm').arr.blocks, { patch: { b_glm1: { done: true } } });
  assert.deepEqual(upd('tasks', 't_glm').inc, { spent: 60 });
  assert.deepEqual(upd('chores', 'c_ziggy').arr.log, { add: [TODAY] });
  assert.deepEqual(upd('projects', 'p_rsa').arr.milestones.patch.m2, { done: true, doneAt: NOW });
  const st = upd('meta', 'settings');
  assert.deepEqual(st.data, { cap: { sun: 60 } });
  assert.deepEqual(st.arr, { offDays: { add: ['2026-10-17'] } });
  assert.ok(!ws.some((w) => w.col === 'meta' && w.id === 'settings' && w.op === 'set'));
  assert.equal(serializeState(applyWrites(base, ws)), serializeState(next));
  // clock / brief / sync stay whole-doc sets
  const clocked = OPS.clockIn(base, { ref: 'task:t_email' }, chat).state;
  assert.deepEqual(diffWrites(base, clocked).filter((w) => w.col === 'meta').map((w) => [w.op, w.id]), [['set', 'clock']]);
  // a re-plan reorders blocks: still exact
  const planned = OPS.applyAllocation(next, allocate(next, { today: TODAY }), chat).state;
  assert.equal(serializeState(applyWrites(next, diffWrites(next, planned))), serializeState(planned));
});

test('merge (SYNC-2 / CLI-2 a): both sides add substeps, the site checks one: nothing is lost', () => {
  const base = deepFreeze(play(fixture(), [['addSub', { id: 't_big', t: 'Intro' }], ['addSub', { id: 't_big', t: 'Methods' }]], chat));
  const ours = play(base, [['addSub', { id: 't_big', t: 'outline' }], ['addSub', { id: 't_big', t: 'lit review' }]], chat);
  const theirs = play(base, [['addSub', { id: 't_big', t: 'find refs' }], ['toggleSub', { id: 't_big', subId: 's1' }]], dash);
  const merged = merge(base, ours, theirs);
  assert.deepEqual(subsOf(merged, 't_big'), ['s1:Intro:x', 's2:Methods:-', 's3:find refs:-', 's4:outline:-', 's5:lit review:-']);
  // the website direction (store rebase: the site's queued diff on top of Claude's commit)
  const other = merge(base, theirs, ours);
  assert.deepEqual(other.tasks.t_big.subs.map((x) => x.t).sort(), ['Intro', 'Methods', 'find refs', 'lit review', 'outline']);
  assert.equal(other.tasks.t_big.subs.find((x) => x.t === 'Intro').done, true);
  assert.equal(new Set(other.tasks.t_big.subs.map((x) => x.id)).size, 5);
});

test('merge (SYNC-2 b): concurrent logged time adds up to the sessions', () => {
  const base = deepFreeze(fixture());
  const ours = play(base, [['logTime', { ref: 'task:t_big', minutes: 30 }]], chat);
  const theirs = play(base, [['logTime', { ref: 'task:t_big', minutes: 25 }]], dash);
  const merged = merge(base, ours, theirs);
  const sessions = Object.values(merged.sessions).filter((x) => x.ref === 'task:t_big');
  assert.equal(sessions.length, 2);
  assert.equal(merged.tasks.t_big.spent, 55);
  assert.equal(merged.tasks.t_big.spent, sessions.reduce((n, x) => n + x.min, 0));
  // pushes count on both sides too
  const m2 = merge(base, play(base, [['moveTask', { id: 't_email', to: '2026-10-07' }]], chat), play(base, [['moveTask', { id: 't_email', to: '2026-10-09' }]], dash));
  assert.equal(m2.tasks.t_email.moved, 2);
  assert.equal(m2.tasks.t_email.plan, '2026-10-07'); // scalars: ours wins, as before
});

test('merge (SYNC-2 c / CLI-2 d): a re-plan does not undo the block the site just checked', () => {
  const base = deepFreeze(fixture());
  // Claude: bigger estimate, then re-plan (moves/creates undone auto blocks)
  const edited = play(base, [['editTask', { id: 't_glm', patch: { est: 240 } }]], chat);
  const ours = OPS.applyAllocation(edited, allocate(edited, { today: TODAY }), chat).state;
  assert.notDeepEqual(ours.tasks.t_glm.blocks, base.tasks.t_glm.blocks);
  // the site checks today's block meanwhile
  const theirs = play(base, [['toggleBlock', { id: 't_glm', blockId: 'b_glm1' }]], dash);
  const merged = merge(base, ours, theirs);
  const b1 = merged.tasks.t_glm.blocks.find((b) => b.id === 'b_glm1');
  assert.ok(b1, 'the checked block survives');
  assert.equal(b1.done, true);
  assert.equal(merged.tasks.t_glm.spent, 60);
  assert.equal(merged.tasks.t_glm.est, 240);
  for (const b of ours.tasks.t_glm.blocks.filter((x) => x.id !== 'b_glm1')) assert.ok(merged.tasks.t_glm.blocks.some((x) => x.id === b.id), `new block ${b.id} kept`);
  // and the other way round (the site's queued toggle rebased onto Claude's re-plan)
  const back = merge(base, theirs, ours);
  assert.equal(back.tasks.t_glm.blocks.find((b) => b.id === 'b_glm1')?.done, true);
  assert.equal(back.tasks.t_glm.spent, 60);
});

test('merge (CLI-2 a): two walks logged on two sides are two walks', () => {
  const base = deepFreeze(fixture());
  const merged = merge(base, play(base, [['choreDone', { id: 'c_ziggy' }]], chat), play(base, [['choreDone', { id: 'c_ziggy' }]], dash));
  assert.deepEqual(merged.chores.c_ziggy.log.filter((d) => d === TODAY), [TODAY, TODAY, TODAY]);
  assert.equal(merged.chores.c_ziggy.last, TODAY);
});

test('merge (CLI-2 c): settings merge per weekday and per off day', () => {
  const base = deepFreeze(fixture()); // offDays ['2026-10-10']
  const ours = play(base, [['editSettings', { patch: { cap: { sun: 60 } } }]], chat);
  const theirs = play(base, [['editSettings', { patch: { offDays: ['2026-10-10', '2026-10-08', '2026-10-09'], cap: { mon: 120 } } }]], dash);
  const merged = merge(base, ours, theirs);
  assert.equal(merged.settings.cap.sun, 60);
  assert.equal(merged.settings.cap.mon, 120);
  assert.deepEqual(merged.settings.offDays, ['2026-10-10', '2026-10-08', '2026-10-09']);
  // both sides change off days: union of adds, minus each side's removals
  const o2 = play(base, [['editSettings', { patch: { offDays: ['2026-10-12'] } }]], chat); // drops 10/10, adds 10/12
  const merged2 = merge(base, o2, theirs);
  assert.deepEqual(merged2.settings.offDays, ['2026-10-08', '2026-10-09', '2026-10-12']);
});

test('merge: aliases and milestones merge per element; a delete never eats a concurrent edit', () => {
  const s0 = fixture();
  s0.cats.rsa = normalizeCategory({ id: 'rsa', name: 'RSA', group: 'research', aliases: ['rsa'] }, ctx);
  const base = deepFreeze(s0);
  const ours = play(base, [['editCategory', { id: 'rsa', patch: { aliases: ['rsa', 'nyx'] } }], ['addMilestone', { id: 'p_rsa', t: 'Submit' }]], chat);
  const theirs = play(base, [['editCategory', { id: 'rsa', patch: { aliases: ['rsa', 'rsa paper'] } }], ['toggleMilestone', { id: 'p_rsa', msId: 'm2' }]], dash);
  const merged = merge(base, ours, theirs);
  assert.deepEqual(merged.cats.rsa.aliases, ['rsa', 'rsa paper', 'nyx']);
  assert.deepEqual(merged.projects.p_rsa.milestones.map((m) => [m.id, m.t, m.done]), [['m1', 'Methods', true], ['m2', 'Results', true], ['m3', 'Discussion', false], ['m4', 'Submit', false]]);
  // Claude removes a substep the site just checked: the checked one stays; an untouched removal goes through
  const b2 = deepFreeze(play(fixture(), [['addSub', { id: 't_big', t: 'A' }], ['addSub', { id: 't_big', t: 'B' }]], chat));
  const o = play(b2, [['removeSub', { id: 't_big', subId: 's1' }], ['removeSub', { id: 't_big', subId: 's2' }]], chat);
  const t = play(b2, [['toggleSub', { id: 't_big', subId: 's1' }]], dash);
  assert.deepEqual(subsOf(merge(b2, o, t), 't_big'), ['s1:A:x']);
  // replaying the same diff twice does not duplicate inserted elements
  const once = merge(b2, play(b2, [['addSub', { id: 't_big', t: 'C' }]], chat), b2);
  const d = diffWrites(b2, play(b2, [['addSub', { id: 't_big', t: 'C' }]], chat)).filter((w) => w.col === 'tasks');
  assert.deepEqual(subsOf(applyWrites(once, d), 't_big'), subsOf(once, 't_big'));
});

test('diffWrites: whole-value writes from the existing ops still apply unchanged', () => {
  const base = deepFreeze(fixture());
  const res = OPS.toggleBlock(base, { id: 't_glm', blockId: 'b_glm1' }, dash);
  const w = res.writes.find((x) => x.col === 'tasks');
  assert.ok(Array.isArray(w.data.blocks) && w.data.spent === 60 && !w.inc && !w.arr);
  assert.deepEqual(applyWrites(base, res.writes), res.state);
});

test('merge: a queued burst (add a substep, then check it) follows the substep when its id was taken', () => {
  // The website store queues one diff per tap and replays the queue on the newer remote in one applyWrites.
  const base = deepFreeze(play(fixture(), [['addSub', { id: 't_big', t: 'A' }]], chat));
  const b1 = OPS.addSub(base, { id: 't_big', t: 'mine' }, dash).state; // s2
  const b2 = OPS.toggleSub(b1, { id: 't_big', subId: 's2' }, dash).state;
  const b3 = OPS.addSub(b2, { id: 't_big', t: 'mine too' }, dash).state; // s3
  const b4 = OPS.removeSub(b3, { id: 't_big', subId: 's2' }, dash).state;
  const queue = [...diffWrites(base, b1), ...diffWrites(b1, b2), ...diffWrites(b2, b3)];
  const remote = play(base, [['addSub', { id: 't_big', t: 'theirs' }], ['addSub', { id: 't_big', t: 'theirs 2' }]], chat); // s2, s3
  assert.deepEqual(subsOf(applyWrites(remote, queue), 't_big'), ['s1:A:-', 's2:theirs:-', 's3:theirs 2:-', 's4:mine:x', 's5:mine too:-']);
  const all = [...queue, ...diffWrites(b3, b4)];
  assert.deepEqual(subsOf(applyWrites(remote, all), 't_big'), ['s1:A:-', 's2:theirs:-', 's3:theirs 2:-', 's5:mine too:-']);
});

test('SYNC-1 (engine side): a set with ifAbsent only creates; addCategory marks its category create-only', () => {
  const base = deepFreeze(fixture());
  // a stale tab adds "#neuro" before it has seen the category Claude just made
  const tab = OPS.addTask(base, { title: 'Read chapter', newCatName: 'neuro' }, dash);
  const catWrite = tab.writes.find((w) => w.col === 'cats' && w.op === 'set');
  assert.equal(catWrite.ifAbsent, true, 'addTask -> addCategory emits a create-only set');
  const made = OPS.addCategory(base, { name: 'neuro', group: 'coursework', aliases: ['neuro seminar'] }, chat);
  const w = made.writes.find((x) => x.col === 'cats' && x.op === 'set');
  assert.equal(w.ifAbsent, true);
  // Claude's richer version is on GitHub already; replaying the tab's writes keeps it
  const remote = applyWrites(base, [{ op: 'set', col: 'cats', id: w.id, data: { ...w.data, name: 'Neuro Seminar', aliases: ['neuro', 'seminar'] } }]);
  const replayed = applyWrites(remote, made.writes);
  assert.equal(replayed.cats[w.id].name, 'Neuro Seminar');
  assert.deepEqual(replayed.cats[w.id].aliases, ['neuro', 'seminar']);
  // with nothing there yet it creates as usual, and a plain set still replaces
  assert.equal(applyWrites(base, made.writes).cats[w.id].name, w.data.name);
  assert.equal(applyWrites(remote, [{ ...w, ifAbsent: undefined }]).cats[w.id].name, w.data.name);
  const fromTab = applyWrites(remote, tab.writes);
  const task = Object.values(fromTab.tasks).find((t) => t.title === 'Read chapter');
  assert.equal(task.cat, w.id, 'the tab\'s task files under the existing category');
  assert.equal(fromTab.cats[w.id].name, 'Neuro Seminar');
});
