// End-to-end tests for bin/ef.mjs against a temp copy of a small state file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, appendFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, normalizeTask, normalizeChore, serializeState, normalizeCategory, normalizeState } from '../src/engine/model.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { OPS } from '../src/engine/ops.js';
import { commitMessage } from '../src/engine/brief.js';
import { capacityFor } from '../src/engine/schedule.js';
import { previewTag } from '../scripts/build.mjs';

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

test('ENG-13: a bare time gets today, but --due / --plan replace that assumed day instead of adding to it', () => {
  const f = fixture();
  ef(f, 'add', 'lab meeting 2pm');
  const lab = Object.values(read(f).tasks).find((x) => x.title === 'Lab meeting');
  assert.equal(lab.plan, '2026-10-05');
  assert.equal(lab.time, '14:00');
  ef(f, 'add', 'advisor meeting 3pm', '--due', 'fri');
  const adv = Object.values(read(f).tasks).find((x) => x.title === 'Advisor meeting');
  assert.equal(adv.due, '2026-10-09');
  assert.equal(adv.plan, null, 'no stray plan for today');
  assert.equal(adv.time, '15:00');
  ef(f, 'add', 'send form by 5pm', '--plan', 'wed');
  const form = Object.values(read(f).tasks).find((x) => x.title === 'Send form');
  assert.equal(form.plan, '2026-10-07');
  assert.equal(form.due, null, 'the assumed "due today" gives way to the flag');
  // an explicit day in the text is kept alongside a flag
  ef(f, 'add', 'team meeting 2pm thu', '--due', 'fri');
  const team = Object.values(read(f).tasks).find((x) => x.title === 'Team meeting');
  assert.deepEqual([team.plan, team.due], ['2026-10-08', '2026-10-09']);
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

test('ENG-3: clock out after a forgotten timer says it was capped and how to log the rest', () => {
  const f = fixture();
  efr(f, ['clock', 'in', 't_rsa2'], { env: { EF_NOW: '2026-10-05T01:00:00.000Z' } });
  const r = efr(f, ['clock', 'out'], { env: { EF_NOW: NOW } }); // 13h later
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /clocked out: RSA participant data fixes · 3h/);
  assert.match(r.stdout, /capped at 3h \(the clock ran 13h/);
  assert.match(r.stdout, /ef log t_rsa2 <minutes>/);
  assert.equal(read(f).tasks.t_rsa2.spent, 180);
  const again = efr(f, ['clock', 'out']);
  assert.equal(again.code, 1, 'nothing was running: exits 1 like every no-op');
  assert.match(again.stderr, /no clock was running/);
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

// ---------------------------------------------------------------- regressions (review fixes)

const MARKERS = /^(<{7}|={7}|>{7})( |$)/m;

/** ef with stdin and a non-throwing result: { code, out, stdout, stderr }. */
function efr(file, args, { input, env = {}, cwd = ROOT, bin = join(ROOT, 'bin/ef.mjs') } = {}) {
  const fullEnv = { ...process.env, EF_NOW: NOW, ...env };
  for (const k of ['EF_STATE', 'EF_TODAY', 'EF_BRANCH', 'EF_AUTHOR']) delete fullEnv[k];
  if (file) fullEnv.EF_STATE = file;
  Object.assign(fullEnv, env);
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', input, env: fullEnv });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

test('CLI-3: a state.json with conflict markers gets recovery steps, and help still works', () => {
  const f = fixture();
  writeFileSync(f, `{\n<<<<<<< Updated upstream\n  "schema": 1\n=======\n  "schema": 2\n>>>>>>> Stashed changes\n}\n`);
  const today = efr(f, ['today']);
  assert.equal(today.code, 1);
  assert.match(today.stderr, /conflict markers/);
  assert.match(today.stderr, /git rebase --abort/);
  assert.match(today.stderr, /git checkout HEAD -- data\/state\.json/);
  assert.doesNotMatch(today.stderr, /reset --hard/);
  assert.match(efr(f, ['check']).stderr, /conflict markers/);
  const help = efr(f, ['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /ef sync/);
});

test('CLI-8: clock in resolves ids and title words like the other commands', () => {
  const f = fixture();
  efr(f, ['clock', 'in', 't_ocd']);
  assert.equal(read(f).clock.ref, 'task:t_ocd');
  efr(f, ['clock', 'in', 'c_laundry']);
  assert.equal(read(f).clock.ref, 'chore:c_laundry');
  efr(f, ['clock', 'in', 'OCD workshop']); // words in a different order than the title
  assert.equal(read(f).clock.ref, 'task:t_ocd');
  const amb = efr(f, ['clock', 'in', 'rsa']);
  assert.equal(amb.code, 2);
  assert.match(amb.stderr, /t_rsa1/);
  assert.match(amb.stderr, /t_rsa2/);
  assert.equal(read(f).clock.ref, 'task:t_ocd', 'an ambiguous clock-in changes nothing');
  efr(f, ['clock', 'in', 'stretching']);
  assert.equal(read(f).clock.ref, 'free');
  assert.equal(read(f).clock.title, 'stretching');
});

test('CLI-10: --cap rejects unknown weekday keys; --cap-on is one day only and never edits the weekly cap', () => {
  const f = fixture();
  const bad = efr(f, ['settings', '--cap', 'tomorrow=90']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown weekday "tomorrow"/);
  assert.match(bad.stderr, /--cap-on/);
  const capBefore = read(f).settings.cap;
  const r = efr(f, ['settings', '--cap-on', 'tomorrow=90']);
  assert.deepEqual(read(f).settings.cap, capBefore, 'every Tuesday keeps its capacity');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(read(f).settings.capOverrides, { '2026-10-06': 90 });
  assert.match(r.stdout, /Tue 10\/6 only: 1h 30m/);
  assert.equal(capacityFor(read(f).settings, '2026-10-06'), 90, 'tomorrow is capped for planning');
  assert.equal(capacityFor(read(f).settings, '2026-10-13'), capBefore.tue, 'next Tuesday is not');
  const off = efr(f, ['settings', '--cap-on', 'tomorrow=none']);
  assert.equal(off.code, 0, off.out);
  assert.deepEqual(read(f).settings.capOverrides, {});
});

test('CLI-12: ef commit -m uses the given message', () => {
  const S = gitSandbox();
  efr(null, ['add', 'email mike - tomorrow'], { cwd: S.claude, bin: S.ef });
  const r = efr(null, ['commit', '-m', 'evening wrap-up'], { cwd: S.claude, bin: S.ef });
  assert.match(r.stdout, /committed: evening wrap-up/);
  assert.equal(gitIn(S.claude, 'log', '-1', '--format=%s').trim(), 'evening wrap-up');
});

test('CLI-13: edit and log prefer the open task over done ones with the same title', () => {
  const f = fixture();
  const s = read(f);
  for (let i = 0; i < 3; i++) s.tasks[`t_ra${i}`] = normalizeTask({ id: `t_ra${i}`, title: 'RA tutorial', cat: 'undergrad', status: 'done', doneAt: '2026-09-0' + (i + 1) + 'T12:00:00.000Z' }, { now: NOW });
  writeFileSync(f, serializeState(normalizeState(s)));
  const add = efr(f, ['add', 'RA tutorial - thu']);
  const id = add.stdout.match(/added (t_\w+)/)[1];
  assert.equal(efr(f, ['edit', 'RA tutorial', '--est', '1h']).code, 0);
  assert.equal(efr(f, ['log', 'RA tutorial', '30']).code, 0);
  assert.equal(read(f).tasks[id].est, 60);
  assert.equal(read(f).tasks[id].spent, 30);
  // with no open match, done tasks are still reachable
  efr(f, ['done', id]);
  assert.equal(efr(f, ['edit', 't_ra0', '--notes', 'x']).code, 0);
});

test('CLI-14: adding an existing chore again updates it instead of creating a twin', () => {
  const f = fixture();
  const s = read(f);
  s.chores.c_ziggy = normalizeChore({ id: 'c_ziggy', title: 'Walk Ziggy', cat: 'ziggy', every: 1, perDay: 2 }, { now: NOW });
  writeFileSync(f, serializeState(normalizeState(s)));
  const again = efr(f, ['add', 'walk ziggy 2x a day']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already tracking chore c_ziggy/);
  assert.equal(Object.values(read(f).chores).filter((c) => /ziggy/i.test(c.title)).length, 1);
  const more = efr(f, ['add', 'walk ziggy 3x a day']);
  assert.match(more.stdout, /updated chore c_ziggy/);
  assert.equal(read(f).chores.c_ziggy.perDay, 3);
  assert.equal(efr(f, ['chore', 'done', 'ziggy']).code, 0);
  assert.match(efr(f, ['chore', 'add', 'Walk Ziggy', '--every', '1']).stdout, /already tracking chore c_ziggy/);
});

test('CLI-15: commands that change nothing exit 1 instead of printing success', () => {
  const f = fixture();
  const cases = [
    [['cat', 'add', 'RSA'], /already exists/],
    [['sub', 'participant data'], /usage: ef sub/],
    [['project', 'add'], /usage: ef project add/],
    [['edit', 'participant data', '--prio', 'banana'], /bad --prio/],
    [['settings', '--cap', 'tues=abc'], /bad --cap tue/],
    [['move', 'participant data', 'tue'], /already planned for Tue 10\/6/],
  ];
  for (const [args, re] of cases) {
    const r = efr(f, args);
    assert.equal(r.code, 1, `ef ${args.join(' ')} → ${r.out}`);
    assert.match(r.stderr, re);
  }
  assert.equal(efr(f, ['edit', 'participant data', '--prio', 'high']).code, 0);
  assert.equal(read(f).tasks.t_rsa2.prio, 2, '--prio accepts a label');
  const again = efr(f, ['edit', 'participant data', '--prio', 'high']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /nothing changed/);
});

test('CLI-17: natural phrasing (stop words) finds the task; near misses list candidates; list --cat takes a name', () => {
  const f = fixture();
  assert.equal(efr(f, ['move', 'the participant data fixes', 'thu']).code, 0);
  assert.equal(read(f).tasks.t_rsa2.plan, '2026-10-08');
  const near = efr(f, ['done', 'dentist call']);
  assert.equal(near.code, 2);
  assert.match(near.stderr, /Closest/);
  assert.match(near.stderr, /t_dentist/);
  const byName = efr(f, ['list', '--cat', 'RSA']).stdout;
  assert.match(byName, /2 tasks/);
  assert.equal(byName, efr(f, ['list', '--cat', 'rsa']).stdout);
});

test('SEC-1: ef add - reads raw lines from stdin (no shell expansion), one to-do per line', () => {
  const f = fixture();
  const r = efr(f, ['add', '-'], { input: 'pay $40 copay - fri\nask Avi why `whoami` fails - tomorrow\nemail mike\'s advisor - tomorrow\n' });
  assert.equal(r.code, 0, r.out);
  const titles = Object.values(read(f).tasks).map((t) => t.title);
  assert.ok(titles.includes('Pay $40 copay'), titles.join(' | '));
  assert.ok(titles.includes('Ask Avi why `whoami` fails'));
  assert.ok(titles.some((t) => /mike's advisor/i.test(t)));
  // a lone "-" elsewhere means the words on stdin
  assert.equal(efr(f, ['done', '-'], { input: "pay $40 copay\n" }).code, 0);
  assert.equal(Object.values(read(f).tasks).find((t) => t.title === 'Pay $40 copay').status, 'done');
});

test('SEC-1: CLAUDE.md templates single-quote Danny\'s text and say how to handle apostrophes', () => {
  const md = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const dq = md.match(/ef (add|done|move|drop|sub|edit|find|clock in|chore done|scrub|cat add|log) "[^"]*"/g);
  assert.equal(dq, null, `double-quoted templates let bash expand $ and backticks: ${dq}`);
  assert.match(md, /ef add 'email mike - tomorrow'/);
  assert.match(md, /'"'"'/);
  assert.match(md, /<<'EOF'/);
  assert.match(md, /ef scrub/);
  assert.match(md, /before (running )?any ef command/i);
});

test('SEC-1/SEC-3: ef scrub removes a client identifier from everything stored', () => {
  const f = fixture();
  efr(f, ['add', 'Session notes for client J.D - today']);
  const r = efr(f, ['scrub', 'for client J.D']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /history/);
  assert.doesNotMatch(readFileSync(f, 'utf8'), /J\.D/);
  assert.ok(Object.values(read(f).tasks).some((t) => t.title === 'Session notes'));
  assert.match(efr(f, ['scrub', 'nobody here']).stdout, /not found/);
});

test('SEC-4: the preview embed escapes <, >, & and U+2028/2029 so no title can end or merge script tags', () => {
  const state = { tasks: { t1: { title: 'Read <!--<script> chapter' }, t2: { title: '</script><script>alert(1)</script> & \u2028\u2029' } } };
  const tag = previewTag(JSON.stringify(state));
  const inner = tag.slice('<script>'.length, -'</script>'.length);
  assert.doesNotMatch(inner, /[<>&\u2028\u2029]/);
  assert.equal(tag.match(/<\/?script/gi).length, 2, 'exactly one open and one close tag');
  const seen = new Function(`const window = {}; ${inner}; return window.__EF_PREVIEW__;`)();
  assert.deepEqual(seen, state);
  assert.throws(() => previewTag('{ nope'));
});

test('CLI-18: ARCHITECTURE.md describes the same per-turn loop as CLAUDE.md (ef sync / ef push)', () => {
  const arch = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const loop = arch.slice(arch.indexOf('## The loop'), arch.indexOf('## Conventions'));
  assert.match(loop, /ef sync/);
  assert.match(loop, /ef commit && ef push/);
  assert.doesNotMatch(loop, /git push|ef changes/);
});

test('CLI-1: ef archive writes next to the state file and logs an activity entry for the commit message', () => {
  const f = fixture();
  const s = read(f);
  s.tasks.t_old = normalizeTask({ id: 't_old', title: 'Old thing', cat: 'admin', status: 'done', doneAt: '2026-05-01T12:00:00.000Z' }, { now: NOW });
  writeFileSync(f, serializeState(normalizeState(s)));
  const r = efr(f, ['archive']);
  assert.equal(r.code, 0, r.out);
  const arch = JSON.parse(readFileSync(join(dirname(f), 'archive/2026.json'), 'utf8'));
  assert.ok(arch.tasks.t_old);
  const after = read(f);
  assert.equal(after.tasks.t_old, undefined);
  assert.ok(Object.values(after.activity).some((a) => a.type === 'archive' && /Archived 1 old done task/.test(a.title)));
});

// ---------------------------------------------------------------- git sandbox: origin + 'claude' + 'web'

function gitIn(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitConfig(cwd) {
  for (const [k, v] of [['user.name', 'Danny Zweben'], ['user.email', 'danny@example.com'], ['commit.gpgsign', 'false'], ['pull.rebase', 'false']]) gitIn(cwd, 'config', k, v);
}

const SANDBOXES = [];
after(() => {
  for (const d of SANDBOXES) rmSync(d, { recursive: true, force: true });
});

/** Bare origin, a 'claude' clone carrying this repo's code + the fixture state, and a 'web' clone. */
function gitSandbox(state) {
  const dir = mkdtempSync(join(tmpdir(), 'ef-git-'));
  SANDBOXES.push(dir);
  const origin = join(dir, 'origin.git');
  gitIn(dir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare', origin);
  const claude = join(dir, 'claude');
  gitIn(dir, '-c', 'init.defaultBranch=main', 'init', '-q', claude);
  gitConfig(claude);
  for (const p of ['bin', 'src', 'package.json', '.gitattributes', 'README.md']) cpSync(join(ROOT, p), join(claude, p), { recursive: true });
  mkdirSync(join(claude, 'data'));
  writeFileSync(join(claude, 'data/state.json'), state ? serializeState(state) : readFileSync(fixture(), 'utf8'));
  gitIn(claude, 'add', '-A');
  gitIn(claude, 'commit', '-qm', 'seed');
  gitIn(claude, 'remote', 'add', 'origin', origin);
  gitIn(claude, 'push', '-q', '-u', 'origin', 'main');
  const web = join(dir, 'web');
  gitIn(dir, 'clone', '-q', origin, web);
  gitConfig(web);
  return { dir, origin, claude, web, ef: join(claude, 'bin/ef.mjs') };
}

/** The website saving: engine ops with src 'dash', one commit, pushed to main (like the Contents API). */
function webSave(S, ops, now = NOW) {
  gitIn(S.web, 'pull', '-q', '--ff-only', 'origin', 'main');
  const p = join(S.web, 'data/state.json');
  let s = normalizeState(JSON.parse(readFileSync(p, 'utf8')));
  const acts = [];
  for (const [op, args] of ops) {
    const r = OPS[op](s, args, { now, today: now.slice(0, 10), src: 'dash' });
    assert.ok(r.writes.length, `web ${op} changed something`);
    s = r.state;
    acts.push(...r.activity);
  }
  writeFileSync(p, serializeState(s));
  gitIn(S.web, 'commit', '-qam', commitMessage(acts));
  gitIn(S.web, 'push', '-q', 'origin', 'HEAD:main');
}

const efIn = (S, args, opts = {}) => efr(null, args, { cwd: S.claude, bin: S.ef, ...opts });
const originState = (S) => JSON.parse(gitIn(S.claude, '--git-dir', S.origin, 'show', 'main:data/state.json'));
const localText = (S) => readFileSync(join(S.claude, 'data/state.json'), 'utf8');

function assertClean(S) {
  assert.doesNotMatch(localText(S), MARKERS, 'no conflict markers in state.json');
  JSON.parse(localText(S));
  assert.equal(gitIn(S.claude, 'stash', 'list').trim(), '', 'no stash left behind');
  assert.equal(existsSync(join(S.claude, '.git/rebase-merge')) || existsSync(join(S.claude, '.git/rebase-apply')), false, 'no rebase in progress');
}

test('ef registers the efstate merge driver in the clone (CLI-2/CLI-3 plumbing)', () => {
  const S = gitSandbox();
  efIn(S, ['today']);
  assert.equal(gitIn(S.claude, 'config', '--get', 'merge.efstate.driver').trim(), 'node bin/ef-merge.mjs %O %A %B');
  assert.match(readFileSync(join(S.claude, '.git/info/attributes'), 'utf8'), /^data\/state\.json merge=efstate$/m);
  assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^data\/state\.json merge=efstate$/m);
  assert.doesNotMatch(readFileSync(join(ROOT, 'bin/ef.mjs'), 'utf8'), /['"]reset['"]\s*,\s*['"]--hard/, 'ef never runs git reset --hard');
});

test('CLI-2/CLI-11: website saves between sync and push; same task edited on both sides; both survive', () => {
  const s = normalizeState(JSON.parse(readFileSync(fixture(), 'utf8')));
  s.chores.c_ziggy = normalizeChore({ id: 'c_ziggy', title: 'Walk Ziggy', cat: 'ziggy', every: 1, perDay: 2 }, { now: NOW });
  const S = gitSandbox(s);
  assert.equal(efIn(S, ['sync']).code, 0);
  efIn(S, ['sub', 't_ocd', 'outline']);
  efIn(S, ['sub', 't_ocd', 'lit review']);
  efIn(S, ['log', 't_ocd', '30']);
  efIn(S, ['chore', 'done', 'ziggy']);
  efIn(S, ['move', 't_rsa2', 'thu']);
  efIn(S, ['edit', 't_ocd', '--est', '6h']);
  efIn(S, ['settings', '--cap', 'sun=60']);
  efIn(S, ['brief', '--write']);
  efIn(S, ['commit']);
  webSave(S, [
    ['addSub', { id: 't_ocd', t: 'find refs' }],
    ['logTime', { ref: 'task:t_ocd', minutes: 25 }],
    ['choreDone', { id: 'c_ziggy' }],
    ['moveTask', { id: 't_rsa2', to: '2026-10-09' }],
    ['editTask', { id: 't_ocd', patch: { notes: 'from the site' } }],
    ['editSettings', { patch: { offDays: ['2026-10-08', '2026-10-09'] } }],
  ]);
  const push = efIn(S, ['push']);
  assert.equal(push.code, 0, push.out);
  assert.match(push.stdout, /pushed main/);
  assert.match(push.stdout, /WEBSITE CHANGES MERGED DURING PUSH/);
  assert.match(push.stdout, /BOTH SIDES CHANGED[\s\S]*RSA participant data fixes · plan: kept chat's Thu 10\/8, website had Fri 10\/9/);
  const o = originState(S);
  const t = o.tasks.t_ocd;
  assert.deepEqual(t.subs.map((x) => x.t).sort(), ['find refs', 'lit review', 'outline']);
  assert.equal(t.spent, 60 + 30 + 25);
  assert.equal(t.est, 360);
  assert.equal(t.notes, 'from the site');
  assert.equal(o.chores.c_ziggy.log.filter((d) => d === '2026-10-05').length, 2);
  assert.equal(o.settings.cap.sun, 60);
  assert.deepEqual(o.settings.offDays, ['2026-10-08', '2026-10-09']);
  assert.equal(o.tasks.t_rsa2.plan, '2026-10-08');
  assertClean(S);
  // the website's changes were reported at push time, so the next sync doesn't repeat them
  const sync = efIn(S, ['sync'], { env: { EF_NOW: '2026-10-05T15:00:00.000Z' } });
  assert.match(sync.stdout, /nothing new from the website/);
});

test('CLI-1/CLI-16: ef archive + a website commit before ef push keeps the archive file, every task, and every commit', () => {
  const s = normalizeState(JSON.parse(readFileSync(fixture(), 'utf8')));
  for (let i = 0; i < 5; i++) s.tasks[`t_old${i}`] = normalizeTask({ id: `t_old${i}`, title: `Old ${i}`, cat: 'admin', status: 'done', doneAt: '2026-05-01T12:00:00.000Z' }, { now: NOW });
  const S = gitSandbox(s);
  efIn(S, ['sync']);
  efIn(S, ['add', 'print poster - wed']);
  efIn(S, ['commit']); // an earlier unpushed commit
  assert.match(efIn(S, ['archive']).stdout, /archived 5 tasks/);
  assert.match(efIn(S, ['commit']).stdout, /Archived 5 old done tasks/);
  webSave(S, [['completeTask', { id: 't_dentist' }]]);
  const push = efIn(S, ['push']);
  assert.equal(push.code, 0, push.out);
  const o = originState(S);
  const arch = JSON.parse(gitIn(S.claude, '--git-dir', S.origin, 'show', 'main:data/archive/2026.json'));
  assert.equal(Object.keys(arch.tasks).length, 5);
  assert.equal(Object.keys(o.tasks).filter((id) => id.startsWith('t_old')).length, 0);
  assert.equal(o.tasks.t_dentist.status, 'done');
  assert.ok(Object.values(o.tasks).some((t) => t.title === 'Print poster'));
  const log = gitIn(S.claude, '--git-dir', S.origin, 'log', '--format=%s', 'main');
  assert.match(log, /Print poster/, 'the earlier commit is not squashed away');
  assert.match(log, /Archived 5 old done tasks/);
  assertClean(S);
});

test('CLI-3: ef sync with uncommitted edits and a website commit merges cleanly (no markers, no stash, nothing lost)', () => {
  const S = gitSandbox();
  efIn(S, ['sync']);
  efIn(S, ['add', 'call the registrar - tomorrow']);
  efIn(S, ['done', 'dentist']);
  webSave(S, [['moveTask', { id: 't_dentist', to: '2026-10-12' }], ['choreDone', { id: 'c_laundry' }], ['completeTask', { id: 't_rsa1' }]]);
  const sync = efIn(S, ['sync'], { env: { EF_NOW: '2026-10-05T15:00:00.000Z' } });
  assert.equal(sync.code, 0, sync.out);
  assert.match(sync.stdout, /pulled origin\/main/);
  assert.match(sync.stdout, /done +RSA manuscript update 1\/3/);
  assertClean(S);
  const s = JSON.parse(localText(S));
  assert.equal(s.tasks.t_dentist.status, 'done');
  assert.equal(s.tasks.t_dentist.plan, '2026-10-12');
  assert.equal(s.tasks.t_rsa1.status, 'done');
  assert.equal(s.chores.c_laundry.last, '2026-10-05');
  assert.ok(Object.values(s.tasks).some((t) => t.title === 'Call the registrar'));
  efIn(S, ['commit']);
  assert.equal(efIn(S, ['push']).code, 0);
});

test('CLI-5/CLI-9: unpushed code commits, data commits and uncommitted code edits all survive a website race', () => {
  const S = gitSandbox();
  efIn(S, ['sync']);
  appendFileSync(join(S.claude, 'README.md'), '\ndocs tweak 2\n');
  gitIn(S.claude, 'commit', '-qam', 'docs tweak 2');
  efIn(S, ['done', 'dentist']);
  efIn(S, ['commit']);
  appendFileSync(join(S.claude, 'src/engine/views.js'), '\n// WIP line\n');
  webSave(S, [['moveTask', { id: 't_dentist', to: '2026-10-08' }], ['completeTask', { id: 't_rsa2' }]]);
  const push = efIn(S, ['push']);
  assert.equal(push.code, 0, push.out);
  const log = gitIn(S.claude, '--git-dir', S.origin, 'log', '--format=%s', 'main');
  assert.match(log, /docs tweak 2/);
  assert.match(log, /Reschedule dentist/);
  assert.match(readFileSync(join(S.claude, 'src/engine/views.js'), 'utf8'), /\/\/ WIP line/, 'uncommitted edit kept');
  const o = originState(S);
  assert.equal(o.tasks.t_dentist.status, 'done');
  assert.equal(o.tasks.t_rsa2.status, 'done');
  assertClean(S);
});

test('CLI-9: a real code conflict exits 3, aborts the rebase and loses nothing; the message never says reset --hard', () => {
  const S = gitSandbox();
  appendFileSync(join(S.web, 'README.md'), '\nfrom another session\n');
  gitIn(S.web, 'commit', '-qam', 'other readme');
  gitIn(S.web, 'push', '-q', 'origin', 'HEAD:main');
  appendFileSync(join(S.claude, 'README.md'), '\nfrom this session\n');
  gitIn(S.claude, 'commit', '-qam', 'this readme');
  efIn(S, ['done', 'dentist']);
  efIn(S, ['commit']);
  const head = gitIn(S.claude, 'rev-parse', 'HEAD');
  // --allow-code: the incoming README change was reviewed (see SEC-6), so the merge is attempted
  const push = efIn(S, ['push', '--allow-code']);
  assert.equal(push.code, 3, push.out);
  assert.match(push.stderr, /README\.md/);
  assert.match(push.stderr, /nothing was lost/);
  assert.doesNotMatch(push.out, /reset --hard origin/);
  assert.equal(gitIn(S.claude, 'rev-parse', 'HEAD'), head);
  assertClean(S);
});

test('SEC-6: sync and push never pull code changes silently (a leaked website token must not become code Claude runs)', () => {
  const S = gitSandbox();
  // someone with the website's token rewrites the merge driver and the CLI, disguised as a website save
  const evil = join(S.dir, 'pwned');
  appendFileSync(join(S.web, 'bin/ef-merge.mjs'), `\nawait import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(evil)}, 'x'));\n`);
  appendFileSync(join(S.web, 'bin/ef.mjs'), `\nawait import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(evil)}, 'x'));\n`);
  gitIn(S.web, 'commit', '-qam', 'dash: ✓ Email Mike');
  gitIn(S.web, 'push', '-q', 'origin', 'HEAD:main');
  webSave(S, [['completeTask', { id: 't_rsa2' }]]); // and a real website save on top
  const binBefore = readFileSync(join(S.claude, 'bin/ef.mjs'), 'utf8');
  const head = gitIn(S.claude, 'rev-parse', 'HEAD');
  const sync = efIn(S, ['sync']);
  assert.equal(sync.code, 0, sync.out);
  assert.match(sync.stdout, /CODE CHANGED ON GITHUB/);
  assert.match(sync.stdout, /bin\/ef-merge\.mjs/);
  assert.match(sync.stdout, /bin\/ef\.mjs/);
  assert.match(sync.stdout, /token may be leaked/);
  assert.equal(gitIn(S.claude, 'rev-parse', 'HEAD'), head, 'nothing pulled');
  assert.equal(readFileSync(join(S.claude, 'bin/ef.mjs'), 'utf8'), binBefore);
  // push after a chat change: still refuses, exit 3, nothing lost, nothing run
  efIn(S, ['done', 'dentist']);
  efIn(S, ['commit']);
  const push = efIn(S, ['push']);
  assert.equal(push.code, 3, push.out);
  assert.match(push.stderr, /CODE CHANGED ON GITHUB/);
  assert.equal(readFileSync(join(S.claude, 'bin/ef.mjs'), 'utf8'), binBefore);
  assert.equal(existsSync(evil), false, 'the injected code never ran');
  assertClean(S);
  // a reviewed, legitimate code change goes through with --allow-code
  const S2 = gitSandbox();
  appendFileSync(join(S2.web, 'README.md'), '\nnotes from another session\n');
  gitIn(S2.web, 'commit', '-qam', 'docs: notes');
  gitIn(S2.web, 'push', '-q', 'origin', 'HEAD:main');
  const blocked = efIn(S2, ['sync']);
  assert.match(blocked.stdout, /CODE CHANGED ON GITHUB/);
  assert.match(blocked.stdout, /sync --allow-code/);
  const ok = efIn(S2, ['sync', '--allow-code']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.stdout, /pulled origin\/main/);
  assert.match(readFileSync(join(S2.claude, 'README.md'), 'utf8'), /notes from another session/);
  // data-only website saves never need it
  webSave(S2, [['completeTask', { id: 't_rsa2' }]]);
  const data = efIn(S2, ['sync']);
  assert.doesNotMatch(data.stdout, /CODE CHANGED/);
  assert.match(data.stdout, /pulled origin\/main/);
});

test('CLI-7: a push rejected by a server rule exits 1 and never claims a merge', () => {
  const S = gitSandbox();
  const hook = join(S.origin, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "GH013: Repository rule violations found" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  efIn(S, ['add', 'x - tomorrow']);
  efIn(S, ['commit']);
  const push = efIn(S, ['push']);
  assert.equal(push.code, 1);
  assert.match(push.stderr, /rejected by GitHub/);
  assert.doesNotMatch(push.out, /merged our changes/);
  assert.match(gitIn(S.claude, 'status', '-sb'), /ahead 1/);
});

test('CLI-4: sync and push warn loudly when the checked-out branch is not the one the website uses', () => {
  const S = gitSandbox();
  gitIn(S.claude, 'checkout', '-qb', 'claude/new-session-abc');
  const sync = efIn(S, ['sync']);
  assert.match(sync.stdout, /WRONG BRANCH FOR DATA: checked out "claude\/new-session-abc"[\s\S]*"main"/);
  assert.match(sync.stdout, /lastClaudeSync not advanced/);
  efIn(S, ['add', 'new thing - tomorrow']);
  efIn(S, ['commit']);
  const push = efIn(S, ['push']);
  assert.match(push.stdout, /WRONG BRANCH FOR DATA/);
  assert.equal(gitIn(S.claude, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'claude/new-session-abc', 'ef never switches branches');
  gitIn(S.claude, 'checkout', '-q', 'main');
  assert.doesNotMatch(efIn(S, ['sync']).stdout, /WRONG BRANCH/);
});

test('CLI-6/SYNC-5: a diverged sync merges, and a website change stamped before the last sync but pushed after it is reported once', () => {
  const S = gitSandbox();
  efIn(S, ['sync']); // 14:00
  efIn(S, ['add', 'thing one - tomorrow']);
  efIn(S, ['commit']); // never pushed: local is ahead
  webSave(S, [['completeTask', { id: 't_dentist' }]], '2026-10-05T13:55:00.000Z'); // offline click, pushed late
  webSave(S, [['completeTask', { id: 't_rsa2' }]], '2026-10-05T14:20:00.000Z');
  const sync = efIn(S, ['sync'], { env: { EF_NOW: '2026-10-05T14:30:00.000Z' } });
  assert.equal(sync.code, 0, sync.out);
  assert.match(sync.stdout, /done +Reschedule dentist/);
  assert.match(sync.stdout, /done +RSA participant data fixes/);
  assert.match(gitIn(S.claude, 'log', '--format=%s'), /Thing one/);
  assertClean(S);
  const again = efIn(S, ['sync'], { env: { EF_NOW: '2026-10-05T15:00:00.000Z' } });
  assert.match(again.stdout, /nothing new from the website/);
});

test('CLI-6: a failed pull does not advance lastClaudeSync and fails fast (no retry loop on a non-network error)', () => {
  const S = gitSandbox();
  gitIn(S.claude, 'remote', 'set-url', 'origin', join(S.dir, 'missing.git'));
  const before = JSON.parse(localText(S)).sync.lastClaudeSync;
  const t0 = Date.now();
  const sync = efIn(S, ['sync']);
  assert.ok(Date.now() - t0 < 5000, 'no 14s retry loop');
  assert.match(sync.stdout, /pull failed/);
  assert.equal(JSON.parse(localText(S)).sync.lastClaudeSync, before);
});

test('done --on backdates a completion; on a done task it moves the day', () => {
  const f = fixture();
  ef(f, 'done', 'dentist', '--on', '2026-10-03');
  const t = read(f).tasks.t_dentist;
  assert.equal(t.status, 'done');
  assert.equal(t.doneAt.slice(0, 10), '2026-10-03');
  ef(f, 'done', 'dentist', '--on', 'yesterday');
  assert.equal(read(f).tasks.t_dentist.doneAt.slice(0, 10), '2026-10-04');
  assert.throws(() => ef(f, 'done', 'participant data', '--on', 'tomorrow'), (err) => err.status === 1);
});

test('chore done --on logs the real day without moving last backwards', () => {
  const f = fixture();
  ef(f, 'chore', 'done', 'laundry', '--on', '2026-10-03');
  const c = read(f).chores.c_laundry;
  assert.equal(c.last, '2026-10-03');
  assert.deepEqual(c.log.slice(-2), ['2026-09-19', '2026-10-03']);
});

test('edit --clear-blocks removes undone work blocks (keeps finished ones)', () => {
  const f = fixture();
  ef(f, 'plan');
  assert.ok(read(f).tasks.t_ocd.blocks.length > 0);
  ef(f, 'edit', 't_ocd', '--due', 'none', '--clear-blocks');
  const t = read(f).tasks.t_ocd;
  assert.equal(t.due, null);
  assert.deepEqual(t.blocks.filter((b) => !b.done), []);
});
