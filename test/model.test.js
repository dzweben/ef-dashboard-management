import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, normalizeTask, normalizeChore, normalizeState, serializeState, applyWrites, diffWrites,
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
