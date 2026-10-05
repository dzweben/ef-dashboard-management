// End-to-end tests for bin/ef.mjs against a temp copy of a small state file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, normalizeTask, normalizeChore, serializeState } from '../src/engine/model.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { normalizeCategory } from '../src/engine/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-10-05T14:00:00.000Z'; // Mon 10:00 ET

function fixture() {
  const s = emptyState();
  for (const c of DEFAULT_CATEGORIES) s.cats[c.id] = normalizeCategory(c);
  const ctx = { now: NOW };
  const add = (t) => { const n = normalizeTask(t, ctx); s.tasks[n.id] = n; };
  add({ id: 't_dentist', title: 'Reschedule dentist', cat: 'health', plan: '2026-10-05', est: 10 });
  add({ id: 't_ocd', title: 'OCD pres: build workshop', cat: 'cbt', due: '2026-10-13', est: 300, spent: 60 });
  add({ id: 't_abcd', title: 'ABCD review meeting', cat: 'manuscripts', due: '2026-09-28', triage: true });
  add({ id: 't_rsa1', title: 'RSA manuscript update 1/3', cat: 'rsa', plan: '2026-10-08', est: 180 });
  add({ id: 't_rsa2', title: 'RSA participant data fixes', cat: 'rsa', plan: '2026-10-06', est: 45 });
  const ch = normalizeChore({ id: 'c_laundry', title: 'Laundry', cat: 'home', every: 7, log: ['2026-09-19'] }, ctx);
  s.chores[ch.id] = ch;
  const dir = mkdtempSync(join(tmpdir(), 'ef-cli-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, serializeState(s));
  return file;
}

function ef(file, ...args) {
  return execFileSync(process.execPath, [join(ROOT, 'bin/ef.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, EF_STATE: file, EF_NOW: NOW },
  });
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('add parses quick-add text and files it', () => {
  const f = fixture();
  const out = ef(f, 'add', 'email mike - tomorrow');
  assert.match(out, /Email Mike/);
  const t = Object.values(read(f).tasks).find((x) => x.title === 'Email Mike');
  assert.equal(t.plan, '2026-10-06');
  assert.equal(t.cat, 'admin');
  assert.equal(t.src, 'chat');
});

test('add with a recurring phrase creates a chore', () => {
  const f = fixture();
  ef(f, 'add', 'walk ziggy 2x a day');
  const c = Object.values(read(f).chores).find((x) => /ziggy/i.test(x.title));
  assert.ok(c);
  assert.equal(c.every, 1);
  assert.equal(c.perDay, 2);
});

test('done / undo / move / drop by fuzzy title', () => {
  const f = fixture();
  ef(f, 'done', 'dentist');
  assert.equal(read(f).tasks.t_dentist.status, 'done');
  ef(f, 'undo', 'dentist');
  assert.equal(read(f).tasks.t_dentist.status, 'todo');
  ef(f, 'move', 'participant data', 'thu');
  assert.equal(read(f).tasks.t_rsa2.plan, '2026-10-08');
  ef(f, 'drop', 'ABCD review');
  assert.equal(read(f).tasks.t_abcd.status, 'dropped');
});

test('ambiguous query exits 2 and lists candidates', () => {
  const f = fixture();
  assert.throws(() => ef(f, 'done', 'rsa'), (err) => err.status === 2 && /matches 2 tasks/.test(err.stderr));
});

test('plan books blocks before the deadline', () => {
  const f = fixture();
  ef(f, 'plan');
  const t = read(f).tasks.t_ocd;
  const booked = t.blocks.filter((b) => !b.done).reduce((n, b) => n + b.m, 0);
  assert.equal(booked, 240);
  assert.ok(t.blocks.every((b) => b.d >= '2026-10-05' && b.d < '2026-10-13'));
});

test('chore done + clock in/out', () => {
  const f = fixture();
  ef(f, 'chore', 'done', 'laundry');
  assert.equal(read(f).chores.c_laundry.last, '2026-10-05');
  ef(f, 'clock', 'in', 'laundry');
  assert.equal(read(f).clock.active, true);
  ef(f, 'clock', 'out');
  const s = read(f);
  assert.equal(s.clock.active, false);
  assert.equal(Object.keys(s.sessions).length, 1);
});

test('brief --write stores a brief; today prints the board', () => {
  const f = fixture();
  const out = ef(f, 'brief', '--write');
  assert.ok(out.length > 20);
  assert.ok(read(f).brief?.headline);
  const today = ef(f, 'today');
  assert.match(today, /TODAY Mon 10\/5/);
  assert.match(today, /Reschedule dentist/);
});

test('check validates canonical form', () => {
  const f = fixture();
  assert.match(ef(f, 'check'), /^ok/);
});
