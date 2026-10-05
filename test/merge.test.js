// bin/ef-merge.mjs: the git merge driver for data/state.json (3-way JSON merge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeTexts, mergeStates, runDriver } from '../bin/ef-merge.mjs';
import { emptyState, normalizeTask, normalizeChore, normalizeCategory, normalizeState, serializeState } from '../src/engine/model.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { OPS } from '../src/engine/ops.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-10-05T14:00:00.000Z';
const MARKERS = /^(<{7}|={7}|>{7})( |$)/m;

function baseState() {
  const s = emptyState();
  for (const c of DEFAULT_CATEGORIES) s.cats[c.id] = normalizeCategory(c);
  const ctx = { now: NOW };
  const add = (t) => { const n = normalizeTask(t, ctx); s.tasks[n.id] = n; };
  add({ id: 't_rsa', title: 'RSA intro', cat: 'rsa', due: '2026-10-13', est: 300, spent: 0 });
  add({ id: 't_mike', title: 'Email Mike', cat: 'admin', plan: '2026-10-06', est: 10 });
  add({ id: 't_old', title: 'Old done thing', cat: 'admin', status: 'done', doneAt: '2026-06-01T12:00:00.000Z' });
  s.chores.c_ziggy = normalizeChore({ id: 'c_ziggy', title: 'Walk Ziggy', cat: 'ziggy', every: 1, perDay: 2, log: ['2026-10-04', '2026-10-04'] }, ctx);
  return normalizeState(JSON.parse(serializeState(s)));
}

/** Run engine ops as one side ('chat' or 'dash'). */
function side(state, ops, src) {
  let s = state;
  for (const [op, args] of ops) {
    const r = OPS[op](s, args, { now: NOW, today: '2026-10-05', src });
    assert.ok(r.writes.length, `${op} should change something`);
    s = r.state;
  }
  return s;
}

const text = (s) => serializeState(s);

test('merge: both sides\' subs, time, chore walks and settings survive (CLI-2)', () => {
  const base = baseState();
  const web = side(base, [
    ['addSub', { id: 't_rsa', t: 'find refs' }],
    ['logTime', { ref: 'task:t_rsa', minutes: 25 }],
    ['choreDone', { id: 'c_ziggy' }],
    ['editSettings', { patch: { offDays: ['2026-10-08', '2026-10-09'] } }],
  ], 'dash');
  const chat = side(base, [
    ['addSub', { id: 't_rsa', t: 'outline' }],
    ['addSub', { id: 't_rsa', t: 'lit review' }],
    ['logTime', { ref: 'task:t_rsa', minutes: 30 }],
    ['choreDone', { id: 'c_ziggy' }],
    ['editSettings', { patch: { cap: { sun: 60 } } }],
  ], 'chat');
  // git pull --rebase: %A = upstream (website), %B = our commit being replayed (chat)
  const { text: out, notes } = mergeTexts(text(base), text(web), text(chat));
  const m = JSON.parse(out);
  assert.deepEqual(m.tasks.t_rsa.subs.map((s) => s.t).sort(), ['find refs', 'lit review', 'outline']);
  assert.equal(new Set(m.tasks.t_rsa.subs.map((s) => s.id)).size, 3, 'sub ids stay unique');
  assert.equal(m.tasks.t_rsa.spent, 55, 'both sides\' minutes add up');
  assert.equal(m.chores.c_ziggy.log.filter((d) => d === '2026-10-05').length, 2, 'two walks logged, two walks kept');
  assert.deepEqual(m.settings.offDays, ['2026-10-08', '2026-10-09']);
  assert.equal(m.settings.cap.sun, 60);
  assert.equal(notes.length, 0, 'nothing was changed on both sides');
  // every activity entry from both sides is kept
  for (const id of [...Object.keys(web.activity), ...Object.keys(chat.activity)]) assert.ok(m.activity[id], `activity ${id} kept`);
  assert.equal(out, serializeState(normalizeState(m)), 'output is canonical state.json');
});

test('merge: same task, different fields both survive; same field keeps chat\'s value and reports it (CLI-11)', () => {
  const base = baseState();
  const web = side(base, [['moveTask', { id: 't_mike', to: '2026-10-09' }], ['editTask', { id: 't_rsa', patch: { notes: 'from the site' } }]], 'dash');
  const chat = side(base, [['moveTask', { id: 't_mike', to: '2026-10-08' }], ['editTask', { id: 't_rsa', patch: { est: 360 } }]], 'chat');
  const { text: out, notes } = mergeTexts(text(base), text(web), text(chat));
  const m = JSON.parse(out);
  assert.equal(m.tasks.t_rsa.notes, 'from the site');
  assert.equal(m.tasks.t_rsa.est, 360);
  assert.equal(m.tasks.t_mike.plan, '2026-10-08');
  assert.deepEqual(notes.map((n) => [n.id, n.field, n.kept, n.dropped]), [['t_mike', 'plan', '2026-10-08', '2026-10-09']]);
  assert.equal(notes[0].title, 'Email Mike');
});

test('merge: a delete on one side and an edit on the other (archive racing a website edit)', () => {
  const base = baseState();
  const chat = structuredClone(base);
  delete chat.tasks.t_old; // ef archive
  const web = side(base, [['completeTask', { id: 't_mike' }], ['editTask', { id: 't_old', patch: { notes: 'edited on the site' } }]], 'dash');
  const { text: out, notes } = mergeTexts(text(base), text(web), text(chat));
  const m = JSON.parse(out);
  assert.equal(m.tasks.t_old, undefined);
  assert.equal(m.tasks.t_mike.status, 'done');
  assert.deepEqual(notes.map((n) => [n.id, n.kind, n.by]), [['t_old', 'deleted', 'other']], 'the edit lost to the delete is reported');
});

test('merge: an empty ancestor (file added on both sides) still merges; invalid JSON throws', () => {
  const base = baseState();
  const web = side(base, [['completeTask', { id: 't_mike' }]], 'dash');
  assert.doesNotThrow(() => mergeTexts('', text(web), text(base)));
  assert.throws(() => mergeTexts(text(base), '<<<<<<< HEAD\n{', text(base)), /not valid JSON/);
});

test('mergeStates never mutates its inputs', () => {
  const base = baseState();
  const web = side(base, [['addSub', { id: 't_rsa', t: 'a' }]], 'dash');
  const chat = side(base, [['addSub', { id: 't_rsa', t: 'b' }]], 'chat');
  const snap = JSON.stringify([base, web, chat]);
  mergeStates(base, web, chat);
  assert.equal(JSON.stringify([base, web, chat]), snap);
});

test('runDriver writes the merge into %A, appends notes to EF_MERGE_NOTES, and leaves %A alone on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ef-merge-'));
  const base = baseState();
  const web = side(base, [['moveTask', { id: 't_mike', to: '2026-10-09' }]], 'dash');
  const chat = side(base, [['moveTask', { id: 't_mike', to: '2026-10-08' }]], 'chat');
  const [o, a, b, notes] = ['o', 'a', 'b', 'notes.jsonl'].map((f) => join(dir, f));
  writeFileSync(o, text(base));
  writeFileSync(a, text(web));
  writeFileSync(b, text(chat));
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(runDriver([o, a, b], { EF_MERGE_NOTES: notes }), 0);
    assert.equal(JSON.parse(readFileSync(a, 'utf8')).tasks.t_mike.plan, '2026-10-08');
    assert.equal(JSON.parse(readFileSync(notes, 'utf8').trim()).field, 'plan');
    assert.match(errs.join('\n'), /both sides changed Email Mike · plan/);
    writeFileSync(a, text(web));
    writeFileSync(b, '{ not json');
    assert.equal(runDriver([o, a, b], {}), 1);
    assert.equal(readFileSync(a, 'utf8'), text(web), '%A untouched, so git keeps valid JSON');
  } finally {
    console.error = orig;
  }
});

test('git rebase with the efstate driver: no conflict markers, both sides kept (CLI-2, CLI-3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ef-merge-git-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('-c', 'init.defaultBranch=main', 'init', '-q');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'merge.efstate.driver', `"${process.execPath}" "${join(ROOT, 'bin/ef-merge.mjs')}" %O %A %B`);
  writeFileSync(join(dir, '.gitattributes'), readFileSync(join(ROOT, '.gitattributes'), 'utf8'));
  mkdirSync(join(dir, 'data'));
  const file = join(dir, 'data/state.json');
  const base = baseState();
  writeFileSync(file, text(base));
  g('add', '-A');
  g('commit', '-qm', 'seed');
  g('checkout', '-qb', 'web');
  // edits close together in the file: a text merge would conflict here
  writeFileSync(file, text(side(base, [['moveTask', { id: 't_mike', to: '2026-10-12' }], ['addSub', { id: 't_rsa', t: 'find refs' }]], 'dash')));
  g('commit', '-qam', 'web');
  g('checkout', '-q', 'main');
  writeFileSync(file, text(side(base, [['completeTask', { id: 't_mike' }], ['addSub', { id: 't_rsa', t: 'outline' }]], 'chat')));
  g('commit', '-qam', 'chat');
  const r = spawnSync('git', ['rebase', 'web'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(file, 'utf8');
  assert.doesNotMatch(out, MARKERS);
  const m = JSON.parse(out);
  assert.equal(m.tasks.t_mike.status, 'done');
  assert.equal(m.tasks.t_mike.plan, '2026-10-12');
  assert.deepEqual(m.tasks.t_rsa.subs.map((s) => s.t).sort(), ['find refs', 'outline']);
});
