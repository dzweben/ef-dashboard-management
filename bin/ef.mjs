#!/usr/bin/env node
// ef: the command line Claude uses every chat turn to read and edit data/state.json.
// Run `node bin/ef.mjs help` for commands. All edits go through engine/ops.js so the
// website and the CLI change state the same way.
//
// Git: ef sync / ef push only ever run `git pull --rebase --autostash` and plain
// `git push` (never reset --hard). data/state.json merges through the efstate merge
// driver (bin/ef-merge.mjs, a field-level 3-way JSON merge), which ef registers in
// the local git config on every run, so website and chat edits both survive and no
// conflict markers ever land in the file.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeState, serializeState, emptyState, makeId, PRIO_LABELS } from '../src/engine/model.js';
import {
  todayISO, nowISO, addDays, fmtDay, fmtTime, fmtMinutes, fmtRelative, diffDays,
  parseDatePhrase, parseDuration, parseTime, isISODate, localDateOf, dowKey,
} from '../src/engine/dates.js';
import { parseQuickAdd } from '../src/engine/parse.js';
import { resolveCategory } from '../src/engine/categories.js';
import { OPS } from '../src/engine/ops.js';
import { allocate, risks, dayLoad, planStart } from '../src/engine/schedule.js';
import { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } from '../src/engine/views.js';
import { streak, weekStats } from '../src/engine/stats.js';
import { buildBrief, changesSince, changesBetween } from '../src/engine/brief.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = process.env.EF_STATE ? resolve(process.env.EF_STATE) : join(ROOT, 'data/state.json');
const AUTHOR = process.env.EF_AUTHOR || 'Danny Zweben <176344411+dzweben@users.noreply.github.com>';
const AUTHOR_NAME = AUTHOR.replace(/\s*<.*$/, '').trim() || 'Danny Zweben';
const AUTHOR_EMAIL = (AUTHOR.match(/<(.*)>/) || [])[1] || '';
const TRAILERS = [
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  'Claude-Session: https://claude.ai/code/session_01NL5Kbvz5wMnVQyTdknJ3xc',
];
/** git config for data/state.json merges (see bin/ef-merge.mjs). */
const MERGE_DRIVER = 'node bin/ef-merge.mjs %O %A %B';
const MERGE_ATTR = 'data/state.json merge=efstate';

// ------------------------------------------------------------------ io

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** Why state.json can't be read, with recovery steps that never touch code or unpushed commits. */
function brokenStateHelp(err, text) {
  const markers = CONFLICT_MARKER.test(text);
  return [
    `data/state.json is not valid JSON${markers ? ' (it contains git conflict markers)' : ''}: ${err.message}`,
    'Recover (these steps keep code edits and unpushed commits):',
    '  1. git status: if a rebase or merge is in progress, git rebase --abort (or git merge --abort)',
    '  2. git checkout HEAD -- data/state.json   (restores the last committed data; this turn\'s',
    '     uncommitted ef edits are dropped, so redo them)',
    '  3. node bin/ef.mjs sync, then redo this turn\'s ef commands',
    'git stash list may hold an "autostash" entry with uncommitted edits: git stash show -p shows it.',
  ].join('\n');
}

function readState(path = STATE_PATH) {
  if (!existsSync(path)) return emptyState();
  const text = readFileSync(path, 'utf8');
  try {
    return normalizeState(JSON.parse(text));
  } catch (err) {
    return die(brokenStateHelp(err, text), 1);
  }
}

function load() {
  return readState(STATE_PATH);
}

function save(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, serializeState(state));
}

function ctxFor(state, overrides = {}) {
  const tz = state.settings?.tz || 'America/New_York';
  const now = process.env.EF_NOW || nowISO();
  const today = process.env.EF_TODAY || localDateOf(now, tz) || todayISO(tz);
  return { now, today, src: 'chat', ...overrides };
}

function run(state, opName, args) {
  const fn = OPS[opName];
  if (!fn) die(`unknown op ${opName}`);
  const res = fn(state, args, ctxFor(state));
  return res && res.state ? res : { state, writes: [], activity: [] };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ------------------------------------------------------------------ git plumbing

const GIT_ENV = { ...process.env, GIT_COMMITTER_NAME: AUTHOR_NAME, GIT_COMMITTER_EMAIL: AUTHOR_EMAIL, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Run git without throwing: { ok, status, out (stdout + stderr) }. */
function gitRun(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, status: r.status, out: r.error ? `${out}${r.error.message}` : out };
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^hint:/.test(l)) ?? '';
const indent = (s) => String(s ?? '').trim().split('\n').map((l) => `    ${l}`).join('\n');

/** Network trouble worth retrying (not a 4xx, not a rejection, not a conflict). */
function isTransient(msg) {
  const s = String(msg ?? '');
  if (/error: 4\d\d|\b40[134]\b|Authentication failed|Permission denied|not found|couldn't find remote ref|rejected/i.test(s)) return false;
  return /Could not resolve host|Connection (reset|refused|timed out)|Operation timed out|timed out|early EOF|RPC failed|remote end hung up|returned error: 5\d\d|HTTP 5\d\d|Temporary failure|unable to access|Failed to connect|TLS|SSL_|gnutls/i.test(s);
}

/** Push rejected by a server-side rule (branch protection, rulesets, push protection, hooks): retrying can't help. */
function isHardReject(msg) {
  return /\[remote rejected\]|GH0\d\d|protected branch|pre-receive hook declined|push declined|secret|push protection|refusing to allow|denied to/i.test(String(msg ?? ''));
}

/** Push rejected because origin has commits we don't (the website saved meanwhile). */
function isRace(msg) {
  return /! \[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because the (remote|tip)/i.test(String(msg ?? ''));
}

function gitPath(p) {
  const out = git(['rev-parse', '--git-path', p]).trim();
  return isAbsolute(out) ? out : join(ROOT, out);
}

let mergeDriverReady = null;
/**
 * Register the efstate merge driver for data/state.json in this clone (git config is
 * not cloned, so every run checks). Also lists the attribute in .git/info/attributes,
 * which git honors even when the checked-out tree has no .gitattributes yet.
 */
function ensureMergeDriver() {
  if (mergeDriverReady !== null) return mergeDriverReady;
  mergeDriverReady = false;
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(top) !== realpathSync(ROOT)) return false; // ef copied outside its repo
    const driver = () => gitRun(['config', '--local', '--get', 'merge.efstate.driver']).out.trim();
    if (driver() !== MERGE_DRIVER) {
      // A concurrent ef run may hold .git/config.lock; whoever wins writes the same value.
      gitRun(['config', '--local', 'merge.efstate.name', 'EF Console data/state.json 3-way JSON merge (bin/ef-merge.mjs)']);
      gitRun(['config', '--local', 'merge.efstate.driver', MERGE_DRIVER]);
      if (driver() !== MERGE_DRIVER) return false;
    }
    const attrs = gitPath('info/attributes');
    const text = existsSync(attrs) ? readFileSync(attrs, 'utf8') : '';
    if (!text.split('\n').some((l) => l.trim() === MERGE_ATTR)) {
      mkdirSync(dirname(attrs), { recursive: true });
      writeFileSync(attrs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${MERGE_ATTR}\n`);
    }
    mergeDriverReady = true;
  } catch { /* not a git checkout: data-only use (EF_STATE, tests) */ }
  return mergeDriverReady;
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/** The branch the website reads and writes: origin's default branch (EF_BRANCH overrides). */
function defaultBranch() {
  if (process.env.EF_BRANCH) return process.env.EF_BRANCH;
  const r = gitRun(['ls-remote', '--symref', 'origin', 'HEAD'], { env: GIT_ENV, timeout: 30000 });
  const m = r.ok ? r.out.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD/m) : null;
  if (m) return m[1];
  const s = gitRun(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return s.ok ? s.out.trim().replace(/^origin\//, '') : null;
}

/** A loud banner when the checked-out branch is not the one the website uses (we never switch branches). */
function branchWarning(branch) {
  const def = defaultBranch();
  if (!def || !branch || def === branch) return null;
  const bar = '!'.repeat(78);
  return [
    bar,
    `!!! WRONG BRANCH FOR DATA: checked out "${branch}", but the website reads and writes`,
    `!!! "${def}" (origin's default branch). Data committed here never reaches the website,`,
    `!!! and the website's check-offs never show up here.`,
    `!!! Fix: commit or stash code work, then: git checkout ${def} && node bin/ef.mjs sync`,
    bar,
  ].join('\n');
}

function opInProgress() {
  for (const p of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) {
    try {
      if (existsSync(gitPath(p))) return p;
    } catch { /* not a repo */ }
  }
  return null;
}

class GitConflict extends Error {
  constructor(files, out) {
    super(`conflict in ${files.join(', ') || '(unknown files)'}`);
    this.files = files;
    this.out = out;
  }
}

/**
 * Origin changed code (anything outside data/) since our merge base. The website's
 * token can write the whole repo and ef runs the pulled code on its next run (git even
 * runs bin/ef-merge.mjs from the work tree during the pull), so code is never pulled
 * silently: a leaked token must not become code Claude runs (SEC-6). The website itself
 * only ever writes data/state.json.
 */
class CodeIncoming extends Error {
  constructor(branch, files, commits) {
    super(`origin/${branch} changed code: ${files.join(', ')}`);
    this.branch = branch;
    this.files = files;
    this.commits = commits;
  }
}

function incomingCode(branch) {
  let f = null;
  for (let i = 0; i < 4; i++) {
    f = gitRun(['fetch', 'origin', branch], { env: GIT_ENV });
    if (f.ok || !isTransient(f.out) || i === 3) break;
    sleepMs(2000 * 2 ** i);
  }
  if (!f.ok) throw new Error(firstLine(f.out) || 'git fetch failed');
  const remote = `origin/${branch}`;
  const base = gitRun(['merge-base', 'HEAD', remote]);
  const from = base.ok ? base.out.trim() : null;
  // no common history: everything origin has is incoming
  const d = from ? gitRun(['diff', '--name-only', from, remote]) : gitRun(['ls-tree', '-r', '--name-only', remote]);
  if (!d.ok) throw new Error(firstLine(d.out) || `could not compare with ${remote}`);
  const files = d.out.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('data/'));
  if (!files.length) return null;
  const range = from ? `${from}..${remote}` : remote;
  const log = gitRun(['log', '--format=%h %an <%ae>: %s', range, '--', ...files]);
  return new CodeIncoming(branch, files, log.ok ? log.out.trim().split('\n').filter(Boolean) : []);
}

function codeIncomingHelp(err, cmd) {
  const web = err.commits.filter((c) => /: dash: /.test(c));
  return [
    `!!! CODE CHANGED ON GITHUB: origin/${err.branch} has new commits that change code, not just data:`,
    ...err.files.slice(0, 12).map((f) => `!!!   ${f}`),
    ...(err.files.length > 12 ? [`!!!   … and ${err.files.length - 12} more`] : []),
    '!!! in:',
    ...err.commits.slice(0, 10).map((c) => `!!!   ${c}`),
    `!!! ef runs this code every turn, so it did not pull it. Nothing was lost: your commits and edits are as they were.`,
    `!!! Review it: git log -p HEAD..origin/${err.branch} -- . ':(exclude)data'`,
    web.length
      ? `!!! A website ("dash:") commit changed code. The website only ever writes data/state.json, so Danny's website token may be leaked: do NOT pull; tell Danny to revoke the token on GitHub (Settings → Developer settings) and check those commits.`
      : `!!! If it is Danny's or another Claude session's code work and the diff looks right: node bin/ef.mjs ${cmd} --allow-code`,
  ].join('\n');
}

function readNotes(path) {
  if (!existsSync(path)) return [];
  const notes = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      notes.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  try {
    rmSync(path, { force: true });
  } catch { /* ignore */ }
  return notes;
}

/**
 * `git pull --rebase --autostash origin <branch>`: our unpushed commits (code and
 * data) are replayed on top of origin, uncommitted edits are stashed and re-applied,
 * and data/state.json merges field by field through bin/ef-merge.mjs. Retries only
 * network errors. A conflict in another file aborts the rebase (everything is put
 * back as it was) and throws GitConflict.
 * Unless `allowCode`, it first fetches and throws CodeIncoming (pulling nothing)
 * when origin changed anything outside data/ (SEC-6).
 * Returns { changed, notes (both-sides-changed fields), stashConflicts, out }.
 */
function pullRebase(branch, { allowCode = false } = {}) {
  const busy = opInProgress();
  if (busy) throw new Error(`a git ${busy.includes('rebase') ? 'rebase' : 'merge'} is already in progress; finish it (git status) or abort it (git rebase --abort) first`);
  ensureMergeDriver();
  if (!allowCode) {
    const code = incomingCode(branch);
    if (code) throw code;
  }
  const notesPath = gitPath('ef-merge-notes.jsonl');
  rmSync(notesPath, { force: true });
  const headBefore = git(['rev-parse', 'HEAD']).trim();
  let r = null;
  for (let i = 0; i < 4; i++) {
    r = gitRun(['pull', '--rebase', '--autostash', '--no-edit', 'origin', branch], { env: { ...GIT_ENV, EF_MERGE_NOTES: notesPath } });
    if (r.ok) break;
    if (opInProgress()) {
      const u = gitRun(['diff', '--name-only', '--diff-filter=U']);
      const files = u.out.split('\n').map((s) => s.trim()).filter(Boolean);
      gitRun(['rebase', '--abort'], { env: GIT_ENV });
      readNotes(notesPath);
      throw new GitConflict(files, r.out);
    }
    if (!isTransient(r.out) || i === 3) {
      readNotes(notesPath);
      throw new Error(firstLine(r.out) || `git pull exited ${r.status}`);
    }
    sleepMs(2000 * 2 ** i);
  }
  const notes = readNotes(notesPath);
  let stashConflicts = [];
  if (/autostash resulted in conflicts|changes are safe in the stash/i.test(r.out)) {
    const u = gitRun(['diff', '--name-only', '--diff-filter=U']);
    stashConflicts = u.out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!stashConflicts.length) stashConflicts = ['(see git status)'];
  }
  const headAfter = git(['rev-parse', 'HEAD']).trim();
  return { changed: headAfter !== headBefore, notes, stashConflicts, out: r.out };
}

function conflictHelp(branch, err) {
  const files = err.files ?? [];
  const dataFailed = files.includes('data/state.json');
  const driverLines = String(err.out ?? '').split('\n').filter((l) => /ef-merge/.test(l)).join('\n');
  return [
    `git pull --rebase stopped on a conflict in: ${files.join(', ') || '(unknown)'}.`,
    dataFailed
      ? `data/state.json should merge automatically through bin/ef-merge.mjs, but the driver failed${driverLines ? `:\n${indent(driverLines)}` : ' (is node on PATH?)'}.`
      : 'These are code files (data/state.json merges automatically).',
    'ef aborted the rebase, so nothing was lost: your commits and uncommitted edits are as they were.',
    `To finish by hand: git pull --rebase origin ${branch}, fix those files, git add them,`,
    `git rebase --continue, then node bin/ef.mjs push. Never git reset --hard (it drops unpushed commits).`,
  ].join('\n');
}

function fmtVal(v) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return isISODate(v) ? fmtDay(v) : `"${v.length > 50 ? v.slice(0, 47) + '...' : v}"`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = JSON.stringify(v);
  return s.length > 50 ? s.slice(0, 47) + '...' : s;
}

function printBothChanged(notes) {
  if (!notes?.length) return;
  const seen = new Set();
  const rows = [];
  for (const n of notes) {
    const k = `${n.col}|${n.id}|${n.field}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // In git pull --rebase (all ef ever runs), the driver's "other" side is chat's commit / uncommitted edits.
    if (n.kind === 'deleted') rows.push(n.by === 'other' ? `  ${n.title}: chat deleted (or archived) it while the website edited it; it stays deleted` : `  ${n.title}: the website deleted it while chat edited it; chat's edit was dropped`);
    else rows.push(`  ${n.title} · ${n.field}: kept chat's ${fmtVal(n.kept)}, website had ${fmtVal(n.dropped)}`);
  }
  console.log(`\nBOTH SIDES CHANGED THE SAME FIELD (chat's version kept; tell Danny in one line, offer to switch):\n${rows.join('\n')}`);
}

function fmtActivity(a) {
  return `  ${String(a.at ?? '').slice(5, 16).replace('T', ' ')}  ${String(a.type).padEnd(8)} ${a.title}${a.to ? ' → ' + (isISODate(a.to) ? fmtDay(a.to) : a.to) : ''}`;
}

function headState() {
  return stateAt('HEAD');
}

function stateAt(ref) {
  try {
    return normalizeState(JSON.parse(git(['show', `${ref}:data/state.json`])));
  } catch {
    return emptyState();
  }
}

function summarize(entries) {
  const sym = { done: '✓', add: '+', move: '→', drop: '✕', delete: '✕', undone: '↺', chore: '♺', clock: '⏱', edit: '✎', sub: '☐', block: '▦', milestone: '◆', cat: '#', settings: '⚙', archive: '⇩' };
  return entries.map((a) => `${sym[a.type] ?? '·'} ${a.title}${a.type === 'move' && a.to ? ` (${fmtDay(a.to)})` : ''}`);
}

function commit(state, message) {
  const prev = headState();
  const fresh = Object.values(state.activity ?? {})
    .filter((a) => !prev.activity?.[a.id])
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const parts = summarize(fresh);
  let subject = message || (parts.length ? `chat: ${parts.slice(0, 3).join(' · ')}${parts.length > 3 ? ` · +${parts.length - 3} more` : ''}` : `chat: check-in ${fmtDay(ctxFor(state).today)}`);
  if (subject.length > 72) subject = subject.slice(0, 69) + '...';
  const body = fresh.map((a) => `- ${a.type}: ${a.title}${a.to ? ` → ${isISODate(a.to) ? fmtDay(a.to) : a.to}` : ''}`).join('\n');
  git(['add', 'data/']);
  const staged = git(['diff', '--cached', '--name-only']).trim();
  if (!staged) {
    console.log('nothing to commit');
    return false;
  }
  const msg = `${subject}\n\n${body ? body + '\n\n' : ''}${TRAILERS.join('\n')}`;
  git(['commit', '-q', `--author=${AUTHOR}`, '-m', msg], { env: GIT_ENV });
  console.log(`committed: ${subject}`);
  return true;
}

/**
 * Push the current branch. When the website saved meanwhile (rejected: fetch first /
 * non-fast-forward): git pull --rebase --autostash (data merges field by field, code
 * commits are replayed untouched, uncommitted edits are kept) and push again. A
 * rejection by a server rule, or a rejection although origin has nothing new, is a
 * hard error (exit 1). A code conflict aborts the rebase and exits 3.
 */
function push({ allowCode = false } = {}) {
  if (!ensureMergeDriver()) die('ef push needs the git checkout ef lives in', 1);
  const branch = currentBranch();
  if (branch === 'HEAD') die('detached HEAD: check out a branch, then ef push', 1);
  const warn = branchWarning(branch);
  if (warn) console.log(warn);
  let seen = load(); // website activity already in our state was reported by ef sync
  let last = '';
  for (let i = 0; i < 5; i++) {
    const r = gitRun(['push', '-u', 'origin', branch], { env: GIT_ENV });
    if (r.ok) {
      console.log(`pushed ${branch}`);
      if (warn) console.log(`\n!!! pushed to "${branch}", which the website does NOT read (see the warning above)`);
      return true;
    }
    last = r.out;
    if (isHardReject(r.out)) {
      die(`push rejected by GitHub (a rule or permission, not a race with the website), so ef did not retry:\n${indent(r.out)}\nYour commits are safe locally. Tell Danny; once the rule or token is fixed, run node bin/ef.mjs push again.`, 1);
    }
    if (isRace(r.out)) {
      const f = gitRun(['fetch', 'origin', branch], { env: GIT_ENV });
      if (f.ok && gitRun(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD']).ok) {
        die(`push rejected, but origin/${branch} has nothing we don't have, so it is not a race with the website. Not retrying:\n${indent(r.out)}`, 1);
      }
      let res;
      try {
        res = pullRebase(branch, { allowCode });
      } catch (err) {
        if (err instanceof CodeIncoming) die(`push rejected (origin has new commits) and they change code, so ef did not merge them.\n${codeIncomingHelp(err, 'push')}`, 3);
        if (err instanceof GitConflict) die(`push rejected (origin has new commits) and merging them hit a conflict.\n${conflictHelp(branch, err)}`, 3);
        die(`push rejected (origin has new commits) and pulling them failed: ${err.message}\nYour commits are safe locally; run node bin/ef.mjs push again.`, 1);
      }
      console.log('merged our changes on top of new website commits (pull --rebase; data/state.json merged field by field)');
      // Report what came in right away, so it is shown even if a later push attempt fails.
      const now = load();
      const ch = changesBetween(seen, now);
      seen = now;
      if (ch.entries.length) {
        console.log('\nWEBSITE CHANGES MERGED DURING PUSH (Danny did these while you worked; mention them):');
        for (const a of ch.entries) console.log(fmtActivity(a));
      }
      printBothChanged(res.notes);
      if (res.stashConflicts.length) console.log(stashConflictHelp(res.stashConflicts));
      continue;
    }
    if (isTransient(r.out) && i < 4) {
      sleepMs(2000 * 2 ** i);
      continue;
    }
    die(`push failed (your commits are safe locally):\n${indent(r.out)}`, 1);
  }
  return die(`push failed after 5 attempts (your commits are safe locally):\n${indent(last)}`, 1);
}

function stashConflictHelp(files) {
  return [
    `!!! Your uncommitted edits conflicted with incoming commits in: ${files.join(', ')}`,
    '!!! They are kept in git stash ("autostash"). Fix the conflict markers in those files',
    '!!! (git diff), then git stash drop. data/state.json is never among them (it merges automatically).',
  ].join('\n');
}

// ------------------------------------------------------------------ arg parsing

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === '-m') {
      // the one short flag: ef commit -m "message"
      if (i + 1 < argv.length) flags.m = argv[++i];
      else flags.m = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

let STDIN = null;
/** Text piped on stdin (for `ef add -` with a quoted heredoc: nothing in it is shell-expanded). */
function stdinText() {
  if (STDIN === null) {
    try {
      STDIN = readFileSync(0, 'utf8');
    } catch {
      STDIN = '';
    }
  }
  return STDIN;
}

/** Positional "-" → the words read from stdin; a flag value "-" → the stdin text. */
function expandStdin(pos, flags) {
  const outPos = [];
  for (const p of pos) {
    if (p === '-') outPos.push(...stdinText().trim().split(/\s+/).filter(Boolean));
    else outPos.push(p);
  }
  for (const k of Object.keys(flags)) if (flags[k] === '-') flags[k] = stdinText().trim();
  return outPos;
}

function dateArg(text, today, label = 'date') {
  if (!text || text === true) die(`missing ${label}`);
  if (isISODate(text)) return text;
  const hit = parseDatePhrase(String(text), today);
  if (!hit || hit.consumed.trim().length < String(text).trim().length) die(`can't read ${label} "${text}"`);
  return hit.date;
}

const PRIO_WORDS = { low: 0, someday: 0, normal: 1, medium: 1, med: 1, high: 2, critical: 3, urgent: 3 };
function prioArg(v) {
  const s = String(v).trim().toLowerCase();
  if (/^[0-3]$/.test(s)) return Number(s);
  const i = PRIO_LABELS.indexOf(s);
  if (i >= 0) return i;
  if (s in PRIO_WORDS) return PRIO_WORDS[s];
  return die(`bad --prio ${v} (use 0-3 or ${PRIO_LABELS.join('|')})`, 1);
}

const WEEKDAY_KEYS = { mon: 'mon', monday: 'mon', tue: 'tue', tues: 'tue', tuesday: 'tue', wed: 'wed', weds: 'wed', wednesday: 'wed', thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu', fri: 'fri', friday: 'fri', sat: 'sat', saturday: 'sat', sun: 'sun', sunday: 'sun' };

function minutesArg(v, label) {
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = parseDuration(s);
  if (m === null || m === undefined || !Number.isFinite(m) || m < 0) die(`bad ${label} "${v}" (minutes like 90, or 1h30)`, 1);
  return m;
}

/** Exit 1 unless the op changed something: Claude must never report a capture that didn't happen. */
function mustChange(res, why) {
  if (!res?.writes?.length) die(`nothing changed: ${why}`, 1);
  return res;
}

// ------------------------------------------------------------------ finding things

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Filler words in Danny's phrasing ("the RSA intro", "done with my laundry"). */
const STOP_WORDS = new Set(['the', 'a', 'an', 'my', 'to', 'with', 'on', 'for', 'of', 'about', 'this', 'that']);

function queryWords(q) {
  const words = norm(q).split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  return kept.length ? kept : words;
}

/** { hit } for one clear match, else { hits } (empty = nothing contains every word). */
function matchTitle(items, query) {
  const nq = norm(query);
  const words = queryWords(query);
  const titleOf = (x) => norm(x.title ?? x.name);
  const exact = items.filter((x) => titleOf(x) === nq || titleOf(x) === words.join(' '));
  if (exact.length === 1) return { hit: exact[0] };
  const hits = items.filter((x) => {
    const nt = titleOf(x);
    return words.every((w) => nt.includes(w));
  });
  if (hits.length === 1) return { hit: hits[0] };
  if (hits.length > 1) {
    const prefix = hits.filter((x) => titleOf(x).startsWith(nq) || titleOf(x).startsWith(words.join(' ')));
    if (prefix.length === 1) return { hit: prefix[0] };
  }
  return { hits };
}

/** Items matching some (not all) query words, best first. */
function nearMatches(items, query, n = 5) {
  const words = queryWords(query);
  return items
    .map((x) => [x, words.filter((w) => norm(x.title ?? x.name).includes(w)).length])
    .filter(([, k]) => k > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([x]) => x);
}

/**
 * Resolve a task by id or title words without exiting. `pool`: 'todo' | 'done' | 'any'.
 * 'any' tries open tasks first and falls back to all tasks only when no open one matches.
 * → { hit } | { hits } (ambiguous) | { hits: [], other, near }
 */
function resolveTask(state, query, pool = 'todo') {
  const q = String(query ?? '').trim();
  if (!q) return { error: 'missing task (id or part of the title)' };
  if (state.tasks[q]) return { hit: state.tasks[q] };
  const all = Object.values(state.tasks);
  const todo = all.filter((t) => t.status === 'todo');
  const pools = pool === 'any' ? [todo, all] : [pool === 'done' ? all.filter((t) => t.status !== 'todo') : todo];
  for (const items of pools) {
    const m = matchTitle(items, q);
    if (m.hit || m.hits.length) return m;
  }
  const other = pool === 'any' ? [] : matchTitle(all, q);
  const otherList = other.hit ? [other.hit] : other.hits ?? [];
  return { hits: [], other: otherList, near: nearMatches(pools[pools.length - 1], q) };
}

/** Find one task by id or fuzzy title. Exits 2 with candidates on ambiguity. */
function findTask(state, query, pool = 'todo') {
  const q = String(query ?? '').trim();
  const r = resolveTask(state, q, pool);
  if (r.error) die(r.error);
  if (r.hit) return r.hit;
  if (r.hits.length) die(`"${q}" matches ${r.hits.length} tasks; use an id:\n${r.hits.map(fmtTaskLine).join('\n')}`, 2);
  if (r.other?.length) die(`no ${pool} task matches "${q}". Other matches:\n${r.other.map(fmtTaskLine).join('\n')}`, 2);
  if (r.near?.length) die(`no task matches every word of "${q}". Closest (use an id):\n${r.near.map(fmtTaskLine).join('\n')}`, 2);
  return die(`no task matches "${q}"`, 2);
}

function findIn(map, query, label) {
  const q = String(query ?? '').trim();
  if (!q) die(`missing ${label}`);
  if (map[q]) return map[q];
  const m = matchTitle(Object.values(map), q);
  if (m.hit) return m.hit;
  if (!m.hits.length) die(`no ${label} matches "${q}"`, 2);
  return die(`"${q}" matches several ${label}s:\n${m.hits.map((x) => `  ${x.id}  ${x.title ?? x.name}`).join('\n')}`, 2);
}

/**
 * What `ef clock in <q>` means: an id (t_/c_) first, then chores and open tasks by the
 * same word matching as the other commands. null → a free-text clock. Exits 2 on ambiguity.
 */
function resolveClockTarget(state, q) {
  if (state.tasks[q]) return { kind: 'task', x: state.tasks[q] };
  if (state.chores[q]) return { kind: 'chore', x: state.chores[q] };
  const chores = Object.values(state.chores).filter((c) => c.active !== false);
  const cm = matchTitle(chores, q);
  const tm = resolveTask(state, q, 'todo');
  const cands = [
    ...(cm.hit ? [cm.hit] : cm.hits).map((x) => ({ kind: 'chore', x })),
    ...(tm.hit ? [tm.hit] : tm.hits ?? []).map((x) => ({ kind: 'task', x })),
  ];
  if (cands.length === 1) return cands[0];
  if (!cands.length) return null;
  const exact = cands.filter((c) => norm(c.x.title) === norm(q) || norm(c.x.title) === queryWords(q).join(' '));
  if (exact.length >= 1) return exact.find((c) => c.kind === 'chore') ?? exact[0];
  return die(`"${q}" matches several things; use an id (or --free for a free-text clock):\n${cands.map((c) => (c.kind === 'chore' ? `  ${c.x.id.padEnd(14)} chore: ${c.x.title}` : fmtTaskLine(c.x))).join('\n')}`, 2);
}

// ------------------------------------------------------------------ formatting

let STATE_FOR_FMT = null;
function catName(id) {
  return STATE_FOR_FMT?.cats?.[id]?.name ?? id;
}

function fmtTaskLine(t) {
  const bits = [];
  if (t.status !== 'todo') bits.push(t.status.toUpperCase());
  if (t.triage) bits.push('TRIAGE');
  if (t.due) bits.push(`due ${fmtDay(t.due)}`);
  if (t.plan) bits.push(`plan ${fmtDay(t.plan)}`);
  if (t.time) bits.push(fmtTime(t.time));
  if (t.est) bits.push(t.spent ? `${fmtMinutes(t.spent)}/${fmtMinutes(t.est)}` : fmtMinutes(t.est));
  if (t.blocks?.length) bits.push(`${t.blocks.filter((b) => !b.done).length} blocks`);
  if (t.moved >= 2) bits.push(`pushed x${t.moved}`);
  if (t.subs?.length) bits.push(`${t.subs.filter((s) => s.done).length}/${t.subs.length} subs`);
  return `  ${t.id.padEnd(14)} [${catName(t.cat)}] ${t.title}${bits.length ? '  · ' + bits.join(' · ') : ''}`;
}

function printSection(title, rows) {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const r of rows) console.log(r);
}

function printToday(state, today) {
  const v = todayView(state, today);
  console.log(`TODAY ${fmtDay(today)} — ${v.counts.done}/${v.counts.total} done`);
  printSection('DID THESE HAPPEN? (triage)', v.triage.map(fmtTaskLine));
  printSection('OVERDUE', v.overdue.map((t) => fmtTaskLine(t) + `  · ${diffDays(t.due, today)}d late`));
  printSection('DUE TODAY', v.dueToday.map(fmtTaskLine));
  printSection('MEETINGS', v.meetings.map(fmtTaskLine));
  printSection('PLANNED', v.planned.map(fmtTaskLine));
  printSection('WORK BLOCKS', v.blocks.map(({ task, block }) => `  ${task.id.padEnd(14)} [${catName(task.cat)}] ${task.title} · block ${fmtMinutes(block.m)}${block.done ? ' ✓' : ''}`));
  printSection('ROLLED OVER', v.carried.map((t) => fmtTaskLine(t) + `  · from ${fmtDay(t.plan)}`));
  printSection('CHORES DUE', v.chores.map((c) => {
    const ch = c.chore ?? c;
    return `  ${ch.id.padEnd(14)} ${ch.title}${ch.last ? ` · last ${fmtRelative(ch.last, today)}` : ' · never logged'}`;
  }));
  printSection('DONE TODAY', v.doneToday.map((t) => `  ✓ ${t.title}`));
  const load = dayLoad(state, today);
  console.log(`\nLOAD ${fmtMinutes(load.total)} planned / ${fmtMinutes(load.cap)} capacity`);
}

function printCalendar(state, today, days = 14) {
  const cal = calendarView(state, today, days);
  for (const day of cal) {
    const load = day.load;
    const pct = load.cap ? Math.round((load.total / load.cap) * 100) : 0;
    const bar = '█'.repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, '░');
    console.log(`\n${fmtDay(day.d).padEnd(10)} ${bar} ${fmtMinutes(load.total)}/${fmtMinutes(load.cap)}${day.isOff ? ' OFF' : ''}${day.isToday ? '  ← today' : ''}`);
    for (const it of day.items) {
      const t = it.task;
      const tag = it.type === 'due' ? 'DUE  ' : it.type === 'meeting' ? (t.time ? fmtTime(t.time).padEnd(5) : 'MEET ') : it.type === 'block' ? 'BLOCK' : 'PLAN ';
      const extra = it.type === 'block' ? ` (${fmtMinutes(it.block.m)})` : t.est ? ` (${fmtMinutes(t.est)})` : '';
      console.log(`   ${tag} [${catName(t.cat)}] ${t.title}${extra}`);
    }
    for (const c of day.chores ?? []) console.log(`   chore ${c.title ?? c.chore?.title}`);
  }
}

function printDeadlines(state, today, days = 21) {
  const list = upcomingDeadlines(state, today, days);
  if (!list.length) return console.log('No deadlines in the next 3 weeks.');
  console.log(`DEADLINES (next ${days}d)`);
  for (const d of list) {
    const t = d.task;
    console.log(`  ${fmtDay(t.due).padEnd(10)} ${String(d.daysLeft).padStart(2)}d  [${catName(t.cat)}] ${t.title} · ${d.status}` +
      (t.est != null ? ` · ${fmtMinutes(d.remaining)} left, ${fmtMinutes(d.allocated)} booked` : ''));
  }
}

function printRisks(state, today) {
  const rs = risks(state, today);
  if (!rs.length) return console.log('No risks.');
  console.log('RISKS');
  for (const r of rs) console.log(`  [${r.type}] ${r.message}`);
}

// ------------------------------------------------------------------ commands

const HELP = `ef — EF Console command line (edits data/state.json)

Quote Danny's text with SINGLE quotes ('pay $40 copay - fri'); for text with an
apostrophe or anything odd, pipe it in with a quoted heredoc: ef add - <<'EOF'

Every chat turn:
  ef sync                       pull website changes (git pull --rebase), show what Danny did since last sync
  ef today                      today's board
  ef brief [--write]            the check-in (--write puts it on the website)
  ef commit [-m msg] && ef push commit as Danny + push (merges website commits, retries)
  (sync / push never pull CODE changes silently: "CODE CHANGED ON GITHUB" → review, then --allow-code)

Capture + edit:
  ef add 'email mike - tomorrow' [--plan D] [--due D] [--cat id] [--est 30m] [--time 3pm] [--prio 0-3|low|normal|high|critical] [--project id] [--notes txt]
  ef add - <<'EOF'              one to-do per line from stdin (nothing in it is shell-expanded)
  ef done <task> [--on D]       ef undo <task>          ef drop <task>          ef delete <task>
  ef move <task> <date>         (dates: tomorrow, fri, next mon, 10/12, in 3 days...)
  ef edit <task> [--title t] [--cat id] [--due D|none] [--plan D|none] [--time 3pm|none] [--est 1h|none] [--prio n] [--notes t] [--project id|none] [--triage yes|no] [--win yes|no] [--clear-blocks]
  ef sub <task> 'subtask' [--est 30m]    ef subdone <task> <n|text>
  ef log <task> <minutes>        ef plan [<task>] [--keep]   (auto-book work blocks before deadlines)
  <task> is an id (t_...) or words from the title; a lone "-" reads the words from stdin.

Look:
  ef cal [--days 14]   ef deadlines   ef risks   ef list [--all|--done|--backlog|--triage|--cat id|name]   ef find <text>
  ef projects   ef chores   ef cats   ef stats   ef changes [--since ISO]

Chores, clock, categories, projects, settings:
  ef chore add 'title' --every 7 [--per-day 2] [--cat id] [--min 5]   ef chore done <chore> [--on D]   ef chore edit <chore> --every N
  ef clock in <task id|chore id|words> [--goal 5] [--free]   ef clock out [--done]   ef clock
  ef cat add 'Name' [--group research|clinical|coursework|teaching|service|admin|life] [--alias a,b] [--color #hex]
  ef cat edit <id> [--name n] [--color #hex] [--group g] [--alias a,b] [--archive yes|no]
  ef project add 'Name' [--cat id] [--due D] [--goal txt]   ef project edit <project> [--due D] [--name n] [--status active|paused|done]
  ef project shift <project> <+days|new due date>   (moves the deadline, open milestones, linked to-dos; re-books work)   ef ms <project> 'milestone' [--due D]   ef msdone <project> <milestone>
  ef settings [--cap mon=240,tue=240,...]   every week (per weekday)
  ef settings --cap-on tomorrow=90[,fri=120]   one day only (D=none removes it)   [--off 2026-11-26]
  ef scrub '<client identifier>' [--with 'client']   remove text from everything stored (privacy)
  ef archive [--days 90]        move old done tasks to data/archive/<year>.json
  ef check                      validate data/state.json
`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  ensureMergeDriver();
  const parsedArgs = parseArgs(rest);
  const flags = parsedArgs.flags;
  // `ef add -` reads whole lines itself; elsewhere a lone "-" means "the words on stdin".
  const pos = cmd === 'add' ? parsedArgs.pos : expandStdin(parsedArgs.pos, flags);
  if (cmd === 'add') for (const k of Object.keys(flags)) if (flags[k] === '-') flags[k] = stdinText().trim();
  let state = load();
  STATE_FOR_FMT = state;
  const ctx = ctxFor(state);
  const today = ctx.today;
  let changed = false;
  const apply = (op, args) => {
    const res = run(state, op, args);
    state = res.state;
    STATE_FOR_FMT = state;
    if (res.writes.length) changed = true;
    return res;
  };

  switch (cmd) {
    case 'sync': {
      const prePull = state;
      let pulled = false;
      let warn = null;
      if (!flags['no-pull']) {
        try {
          const branch = currentBranch();
          if (branch === 'HEAD') throw new Error('detached HEAD');
          warn = branchWarning(branch);
          if (warn) console.log(`${warn}\n`);
          const res = pullRebase(branch, { allowCode: !!flags['allow-code'] });
          pulled = true;
          console.log(res.changed ? `pulled origin/${branch}` : `origin/${branch}: up to date`);
          printBothChanged(res.notes);
          if (res.stashConflicts.length) console.log(stashConflictHelp(res.stashConflicts));
        } catch (err) {
          if (err instanceof CodeIncoming) console.log(`${codeIncomingHelp(err, 'sync')}\n— continuing with local data`);
          else if (err instanceof GitConflict) console.log(`!!! PULL DID NOT HAPPEN.\n${conflictHelp(currentBranch(), err)}\n— continuing with local data`);
          else console.log(`(pull failed: ${err.message}) — continuing with local data; ef push will merge later`);
        }
      }
      state = load();
      STATE_FOR_FMT = state;
      const since = state.sync?.lastClaudeSync;
      // Website changes = activity that arrived with this pull (by id, whatever its
      // timestamp: a check-off made offline and pushed late is still reported once).
      const ch = flags['no-pull'] ? changesSince(state, since) : changesBetween(prePull, state);
      console.log(`\nWHAT DANNY DID ON THE WEBSITE (${flags['no-pull'] ? `since ${since ?? 'ever'}, no pull` : 'new in this pull'}):`);
      if (!ch.entries.length) console.log('  nothing new from the website');
      for (const a of ch.entries) console.log(fmtActivity(a));
      try {
        const log = git(['log', '--since', since || '1970-01-01', '--format=%h %an: %s', '--', 'data/state.json']).trim();
        if (log) console.log(`\nCOMMITS TOUCHING DATA SINCE YOUR LAST SYNC:\n${log.split('\n').slice(0, 15).map((l) => '  ' + l).join('\n')}`);
      } catch { /* not a repo */ }
      // prune activity older than 45 days
      const cutoff = addDays(today, -45);
      const keep = {};
      let pruned = 0;
      for (const [id, a] of Object.entries(state.activity ?? {})) {
        if (localDateOf(a.at, state.settings.tz) >= cutoff) keep[id] = a;
        else pruned++;
      }
      if (pruned) {
        state = { ...state, activity: keep };
        console.log(`(pruned ${pruned} old activity entries)`);
      }
      // Only a successful pull (or an explicit --no-pull) moves the sync mark.
      if (pulled || flags['no-pull']) state = { ...state, sync: { ...(state.sync ?? {}), lastClaudeSync: ctx.now, lastActivitySeen: ctx.now } };
      else console.log('(lastClaudeSync not advanced: the pull failed)');
      if (pruned || pulled || flags['no-pull']) save(state);
      console.log('');
      printToday(state, today);
      if (warn) console.log(`\n!!! reminder: wrong branch for data (see the warning at the top)`);
      return;
    }

    case 'changes': {
      const since = flags.since || state.sync?.lastClaudeSync;
      const ch = changesSince(state, since);
      console.log(JSON.stringify(ch, null, 2));
      return;
    }

    case 'today':
      printToday(state, flags.date ? dateArg(flags.date, today) : today);
      return;

    case 'brief': {
      const b = buildBrief(state, { today, now: ctx.now });
      console.log(b.text);
      if (flags.write) {
        apply('setBrief', { headline: b.headline, lines: b.lines, asks: b.asks, focus: b.focus });
        console.log('\n(brief written to the website)');
      }
      break;
    }

    case 'add': {
      const lines = pos.length === 1 && pos[0] === '-'
        ? stdinText().split('\n').map((l) => l.trim()).filter(Boolean)
        : [pos.join(' ')];
      if (!lines.length || !lines.some((l) => l.trim())) die("usage: ef add 'email mike - tomorrow'   (or: ef add - <<'EOF' ... EOF)");
      let added = 0;
      for (const text of lines) added += addOne(text) ? 1 : 0;
      if (!added) die('nothing added', 1);
      break;
    }

    case 'done':
    case 'undo':
    case 'drop':
    case 'delete': {
      const on = cmd === 'done' && flags.on ? dateArg(flags.on, today, 'date') : null;
      if (on && on > today) die(`--on ${fmtDay(on)} is in the future`);
      const t = findTask(state, pos.join(' '), cmd === 'undo' ? 'done' : cmd === 'delete' || on ? 'any' : 'todo');
      const op = { done: 'completeTask', undo: 'reopenTask', drop: 'dropTask', delete: 'deleteTask' }[cmd];
      mustChange(apply(op, on ? { id: t.id, on } : { id: t.id }), on ? `${t.title} is already done on ${fmtDay(on)}` : `${t.title} is already ${t.status}`);
      console.log(`${cmd}: ${t.title}${on && on !== today ? ` (on ${fmtDay(on)})` : ''}`);
      break;
    }

    case 'move': {
      if (pos.length < 2) die('usage: ef move <task> <date>');
      // try the longest trailing date phrase
      let found = null;
      for (let i = 1; i < pos.length; i++) {
        const phrase = pos.slice(i).join(' ');
        const hit = isISODate(phrase) ? { date: phrase, consumed: phrase } : parseDatePhrase(phrase, today);
        if (hit && hit.consumed.trim().length === phrase.trim().length) {
          found = { query: pos.slice(0, i).join(' '), date: hit.date };
          break;
        }
      }
      if (!found) die(`can't find a date at the end of "${pos.join(' ')}"`);
      const t = findTask(state, found.query, 'todo');
      mustChange(apply('moveTask', { id: t.id, to: found.date }), `${t.title} is already planned for ${fmtDay(found.date)}`);
      console.log(`moved: ${t.title} → ${fmtDay(found.date)}${state.tasks[t.id].moved >= 2 ? ` (pushed x${state.tasks[t.id].moved})` : ''}`);
      break;
    }

    case 'edit': {
      const t = findTask(state, pos.join(' '), 'any');
      const patch = {};
      const opt = (v) => (v === 'none' || v === 'null' ? null : v);
      if (flags.title) patch.title = String(flags.title);
      if (flags.cat) patch.cat = (resolveCategory(flags.cat, state.cats) ?? die(`no category ${flags.cat}`)).id;
      if (flags.due) patch.due = opt(flags.due) && dateArg(flags.due, today, 'due');
      if (flags.plan) patch.plan = opt(flags.plan) && dateArg(flags.plan, today, 'plan');
      if (flags.time) patch.time = opt(flags.time) && (parseTime(String(flags.time)) ?? die('bad --time'));
      if (flags.est) patch.est = opt(flags.est) && (parseDuration(String(flags.est)) ?? die('bad --est'));
      if (flags.prio !== undefined) patch.prio = prioArg(flags.prio);
      if (flags.notes !== undefined) patch.notes = String(flags.notes === true ? '' : flags.notes);
      if (flags.project) patch.project = opt(flags.project);
      if (flags.kind) patch.kind = String(flags.kind);
      if (flags.triage) patch.triage = /^(y|yes|true|1)$/i.test(String(flags.triage));
      if (flags.win) patch.win = /^(y|yes|true|1)$/i.test(String(flags.win));
      if (flags['clear-blocks']) patch.blocks = (t.blocks ?? []).filter((b) => b.done);
      if (!Object.keys(patch).length) die('nothing to edit');
      mustChange(apply('editTask', { id: t.id, patch }), `${t.title} already has those values (or they were invalid)`);
      console.log(`edited ${fmtTaskLine(state.tasks[t.id]).trim()}`);
      break;
    }

    case 'sub': {
      const [q, ...txt] = pos;
      const text = txt.join(' ').trim();
      if (!text) die("usage: ef sub <task> 'subtask text' [--est 30m]");
      const t = findTask(state, q, 'todo');
      const est = flags.est ? parseDuration(String(flags.est)) ?? die(`bad --est ${flags.est}`) : undefined;
      mustChange(apply('addSub', { id: t.id, t: text, est }), `could not add a subtask to ${t.title}`);
      console.log(`subtask added to ${t.title}: ${text}`);
      break;
    }

    case 'subdone': {
      const [q, ...which] = pos;
      const t = findTask(state, q, 'todo');
      const w = which.join(' ');
      const idx = /^\d+$/.test(w) ? Number(w) - 1 : t.subs.findIndex((s) => norm(s.t).includes(norm(w)));
      const sub = t.subs[idx];
      if (!sub) die(`no subtask "${w}" on ${t.title}`);
      mustChange(apply('toggleSub', { id: t.id, subId: sub.id }), `could not toggle ${sub.t}`);
      const now = state.tasks[t.id].subs.find((s) => s.id === sub.id);
      console.log(`${now?.done ? '✓' : '☐'} ${sub.t}`);
      break;
    }

    case 'log': {
      const [q, mins] = pos.length >= 2 ? [pos.slice(0, -1).join(' '), pos[pos.length - 1]] : [pos[0], null];
      const minutes = parseDuration(String(mins ?? ''));
      if (!minutes) die('usage: ef log <task> <minutes>');
      const t = findTask(state, q, 'any');
      mustChange(apply('logTime', { ref: `task:${t.id}`, minutes }), `could not log time on ${t.title}`);
      console.log(`logged ${fmtMinutes(minutes)} on ${t.title} (${fmtMinutes(state.tasks[t.id].spent)} total)`);
      break;
    }

    case 'plan': {
      const ids = pos.length ? [findTask(state, pos.join(' '), 'todo').id] : undefined;
      const { updates, risks: rs } = allocate(state, { today, taskIds: ids, replan: !flags.keep, from: flags.from ? dateArg(flags.from, today) : planStart(ctx.now, state.settings.tz) });
      const n = Object.keys(updates).length;
      if (n) apply('applyAllocation', { updates });
      for (const [id, blocks] of Object.entries(updates)) {
        const t = state.tasks[id];
        const fut = blocks.filter((b) => !b.done && b.d >= today);
        console.log(`  ${t.title}: ${fut.map((b) => `${fmtDay(b.d)} ${fmtMinutes(b.m)}`).join(', ') || '(no blocks)'}`);
      }
      if (!n) console.log('nothing to plan (needs tasks with an estimate and a due date)');
      for (const r of rs ?? []) console.log(`  ! [${r.type}] ${r.message}`);
      break;
    }

    case 'cal':
      printCalendar(state, today, Number(flags.days) || 14);
      return;

    case 'deadlines':
      printDeadlines(state, today, Number(flags.days) || 21);
      return;

    case 'risks':
      printRisks(state, today);
      return;

    case 'list': {
      let list = Object.values(state.tasks);
      if (flags.done) list = list.filter((t) => t.status === 'done');
      else if (!flags.all) list = list.filter((t) => t.status === 'todo');
      if (flags.backlog) list = backlog(state);
      if (flags.triage) list = list.filter((t) => t.triage);
      if (flags.cat) {
        const cid = resolveCategory(String(flags.cat), state.cats)?.id ?? die(`no category "${flags.cat}" (ef cats lists them)`, 1);
        list = list.filter((t) => t.cat === cid);
      }
      list.sort((a, b) => (a.due || a.plan || '9999').localeCompare(b.due || b.plan || '9999') || a.title.localeCompare(b.title));
      for (const t of list) console.log(fmtTaskLine(t));
      console.log(`${list.length} tasks`);
      return;
    }

    case 'find': {
      const words = norm(pos.join(' ')).split(' ').filter(Boolean);
      const list = Object.values(state.tasks).filter((t) => words.every((w) => norm(`${t.title} ${t.notes}`).includes(w)));
      for (const t of list) console.log(fmtTaskLine(t));
      if (!list.length) console.log('no matches');
      return;
    }

    case 'projects': {
      for (const p of projectView(state, today)) {
        const pr = p.project;
        console.log(`${pr.id.padEnd(12)} ${pr.name} [${catName(pr.cat)}] ${p.pct}% · ${p.msDone}/${p.msTotal} milestones · ${p.tasksOpen} open tasks${pr.due ? ` · due ${fmtDay(pr.due)}` : ''}${p.nextMilestone ? ` · next: ${p.nextMilestone.t}` : ''}`);
      }
      return;
    }

    case 'chores':
      for (const c of choreView(state, today)) {
        const ch = c.chore;
        console.log(`${ch.id.padEnd(14)} ${ch.title.padEnd(22)} every ${ch.every}d${ch.perDay > 1 ? ` x${ch.perDay}` : ''} · ${c.due ? 'DUE' : !ch.last && c.nextDue > today ? `starts ${fmtDay(c.nextDue)}` : 'ok'} · last ${ch.last ? fmtRelative(ch.last, today) : 'never'}${ch.every === 1 ? ` · today ${c.todayCount}/${ch.perDay}` : ''}`);
      }
      return;

    case 'chore': {
      const [sub, ...r] = pos;
      if (sub === 'add') {
        const title = r.join(' ');
        if (!title) die("usage: ef chore add 'title' --every 7");
        const cat = flags.cat ? (resolveCategory(flags.cat, state.cats) ?? die('no such category')).id : parseQuickAdd(title, { today, cats: state.cats, settings: state.settings }).cat;
        const res = apply('addChore', { title, cat: cat === 'inbox' ? 'home' : cat, every: Number(flags.every) || 7, perDay: Number(flags['per-day']) || 1, min: Number(flags.min) || 5 });
        if (res.duplicateOf) {
          // Already tracking it: apply an explicitly given cadence instead of adding a twin.
          const d = state.chores[res.duplicateOf];
          const patch = {};
          if (flags.every && Number(flags.every) !== d.every) patch.every = Number(flags.every);
          if (flags['per-day'] && Number(flags['per-day']) !== d.perDay) patch.perDay = Number(flags['per-day']);
          const upd = Object.keys(patch).length ? apply('editChore', { id: d.id, patch }) : null;
          const c = state.chores[d.id];
          console.log(`${upd?.writes.length ? 'updated' : 'already tracking'} chore ${c.id}: ${c.title} · every ${c.every}d${c.perDay > 1 ? ` x${c.perDay}/day` : ''} (no duplicate added)`);
          break;
        }
        mustChange(res, `could not add chore ${title}`);
        console.log(`chore added: ${title}`);
      } else if (sub === 'done') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        const on = flags.on ? dateArg(flags.on, today, 'date') : null;
        if (on && on > today) die(`--on ${fmtDay(on)} is in the future`);
        mustChange(apply('choreDone', on ? { id: c.id, date: on } : { id: c.id }), `could not mark ${c.title} done`);
        console.log(`♺ ${c.title} done${on && on !== today ? ` (on ${fmtDay(on)})` : ''}`);
      } else if (sub === 'edit') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        const patch = {};
        if (flags.every) patch.every = Number(flags.every);
        if (flags['per-day']) patch.perDay = Number(flags['per-day']);
        if (flags.min) patch.min = Number(flags.min);
        if (flags.title) patch.title = String(flags.title);
        if (flags.active) patch.active = /^(y|yes|true|1)$/i.test(String(flags.active));
        if (!Object.keys(patch).length) die('nothing to edit (--every N, --per-day N, --min N, --title t, --active yes|no)');
        mustChange(apply('editChore', { id: c.id, patch }), `${c.title} already has those values (or they were invalid)`);
        console.log(`chore edited: ${state.chores[c.id].title}`);
      } else if (sub === 'delete') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        mustChange(apply('deleteChore', { id: c.id }), `could not delete ${c.title}`);
        console.log(`chore deleted: ${c.title}`);
      } else die('usage: ef chore add|done|edit|delete');
      break;
    }

    case 'clock': {
      const [sub, ...r] = pos;
      if (!sub) {
        const c = state.clock;
        if (!c?.active) console.log('no clock running');
        else console.log(`clocked in: ${c.title} · ${Math.round((Date.parse(ctx.now) - Date.parse(c.start)) / 60000)} min (goal ${c.goal})`);
        return;
      }
      if (sub === 'in') {
        const q = r.join(' ').trim();
        const goal = Number(flags.goal) || 5;
        let target = { ref: 'free', title: q || 'Focus', cat: 'inbox' };
        const hit = q && !flags.free ? resolveClockTarget(state, q) : null;
        if (hit?.kind === 'chore') target = { ref: `chore:${hit.x.id}`, title: hit.x.title, cat: hit.x.cat };
        else if (hit?.kind === 'task') target = { ref: `task:${hit.x.id}`, title: hit.x.title, cat: hit.x.cat };
        mustChange(apply('clockIn', { ...target, goal }), `could not clock in on ${target.title}`);
        console.log(`⏱ clocked in: ${target.title}${target.ref === 'free' ? ' (free clock: no task or chore matched; time is not credited to a task)' : ` [${target.ref}]`} (goal ${goal} min)`);
      } else if (sub === 'out') {
        const was = state.clock;
        const res = apply('clockOut', { markDone: !!flags.done });
        const ses = res.writes.find((w) => w.col === 'sessions' && w.op === 'set')?.data;
        if (was?.active) {
          console.log(`⏱ clocked out: ${was.title}${ses ? ` · ${fmtMinutes(ses.min)}` : ''}`);
          // A forgotten timer counts at most SESSION_CAP_MIN (ENG-3); say so, so Danny can log the rest.
          if (ses?.capped) {
            const taskId = String(was.ref ?? '').startsWith('task:') ? String(was.ref).slice(5) : null;
            console.log(`  capped at ${fmtMinutes(ses.min)} (the clock ran ${fmtMinutes(ses.rawMin)}, probably forgotten)${taskId ? `; if he really worked longer: ef log ${taskId} <minutes>` : ''}`);
          }
        } else die('no clock was running', 1);
      } else die('usage: ef clock [in <thing>|out [--done]]');
      break;
    }

    case 'cats': {
      const groups = {};
      for (const c of Object.values(state.cats)) (groups[c.group] ??= []).push(c);
      for (const [g, cs] of Object.entries(groups)) {
        console.log(`${g}:`);
        for (const c of cs.sort((a, b) => a.order - b.order)) {
          const open = Object.values(state.tasks).filter((t) => t.status === 'todo' && t.cat === c.id).length;
          console.log(`  ${c.id.padEnd(12)} ${c.name.padEnd(22)} ${c.color} ${open} open${c.archived ? ' (archived)' : ''}${c.aliases.length ? ' · ' + c.aliases.slice(0, 6).join(', ') : ''}`);
        }
      }
      return;
    }

    case 'cat': {
      const [sub, ...r] = pos;
      if (sub === 'add') {
        const name = r.join(' ').trim();
        if (!name) die("usage: ef cat add 'Name' --group research");
        const res = apply('addCategory', { name, group: flags.group || 'admin', color: flags.color, aliases: flags.alias ? String(flags.alias).split(',').map((s) => s.trim()) : undefined });
        const w = res.writes.find((x) => x.col === 'cats' && x.op === 'set');
        if (!w) {
          const ex = resolveCategory(name, state.cats);
          die(`category not added: ${ex ? `"${name}" already exists as ${ex.name} (${ex.id})` : `"${name}" is not a usable name`}`, 1);
        }
        const c = state.cats[w.id];
        console.log(`category added: ${c.name} (${c.id}) ${c.color} [${c.group}]`);
      } else if (sub === 'edit') {
        const c = resolveCategory(r.join(' '), state.cats) ?? die('no such category');
        const patch = {};
        if (flags.name) patch.name = String(flags.name);
        if (flags.color) patch.color = String(flags.color);
        if (flags.group) patch.group = String(flags.group);
        if (flags.glyph) patch.glyph = String(flags.glyph);
        if (flags.alias) patch.aliases = [...new Set([...(c.aliases ?? []), ...String(flags.alias).split(',').map((s) => s.trim().toLowerCase())])];
        if (flags.archive) patch.archived = /^(y|yes|true|1)$/i.test(String(flags.archive));
        if (flags.note) patch.note = String(flags.note);
        if (!Object.keys(patch).length) die('nothing to edit');
        mustChange(apply('editCategory', { id: c.id, patch }), `${c.name} already has those values (or they were invalid)`);
        console.log(`category edited: ${state.cats[c.id].name}`);
      } else die('usage: ef cat add|edit');
      break;
    }

    case 'project': {
      const [sub, ...r] = pos;
      if (sub === 'edit' || sub === 'shift') {
        const plist = Object.fromEntries(Object.values(state.projects).map((x) => [x.id, { ...x, title: x.name }]));
        if (sub === 'edit') {
          const p = findIn(plist, r.join(' '), 'project');
          const patch = {};
          if (flags.name) patch.name = String(flags.name);
          if (flags.goal) patch.goal = String(flags.goal);
          if (flags.status) patch.status = String(flags.status);
          if (flags.due) patch.due = flags.due === 'none' ? null : dateArg(flags.due, today, 'due');
          if (flags.cat) patch.cat = (resolveCategory(flags.cat, state.cats) ?? die('no such category')).id;
          if (!Object.keys(patch).length) die('nothing to edit');
          mustChange(apply('editProject', { id: p.id, patch }), `nothing changed on ${p.name}`);
          console.log(`project edited: ${state.projects[p.id].name}${state.projects[p.id].due ? ` · due ${fmtDay(state.projects[p.id].due)}` : ''}`);
          break;
        }
        // shift: ef project shift <project> <+N days | new due date>
        const last = r[r.length - 1];
        const p = findIn(plist, r.slice(0, -1).join(' '), 'project');
        let days;
        if (/^[+-]?\d+d?$/.test(String(last))) days = parseInt(last, 10);
        else {
          if (!p.due) die(`${p.name} has no due date; give a number of days (e.g. +7)`);
          days = diffDays(p.due, dateArg(last, today, 'new due date'));
        }
        if (!days) die('shift by 0 days changes nothing');
        const sh = (d) => (d ? addDays(d, days) : d);
        apply('editProject', { id: p.id, patch: { due: sh(p.due), milestones: p.milestones.map((m) => (m.done ? m : { ...m, due: sh(m.due) })) } });
        const moved = [];
        for (const t of Object.values(state.tasks)) {
          if (t.project !== p.id || t.status !== 'todo') continue;
          const patch = {};
          if (t.due) patch.due = sh(t.due);
          if (t.plan) patch.plan = sh(t.plan);
          // auto blocks are re-booked below; Danny's manual blocks shift with the project
          patch.blocks = (t.blocks ?? []).filter((b) => b.done || b.auto === false).map((b) => (b.done ? b : { ...b, d: sh(b.d) }));
          apply('editTask', { id: t.id, patch });
          moved.push(t.id);
        }
        const { updates } = allocate(state, { today, taskIds: moved, from: planStart(ctx.now, state.settings.tz) });
        if (Object.keys(updates).length) apply('applyAllocation', { updates });
        console.log(`shifted ${p.name} by ${days > 0 ? '+' : ''}${days}d → due ${fmtDay(state.projects[p.id].due)}`);
        for (const id of moved) console.log(fmtTaskLine(state.tasks[id]));
        break;
      }
      if (sub !== 'add') die("usage: ef project add 'Name' --cat id | ef project edit <project> --due D | ef project shift <project> <+days|new due>");
      const name = r.join(' ').trim();
      if (!name) die("usage: ef project add 'Name' --cat id");
      mustChange(apply('addProject', { name, cat: flags.cat ? (resolveCategory(flags.cat, state.cats) ?? die('no such category')).id : 'inbox', due: flags.due ? dateArg(flags.due, today) : null, goal: flags.goal ? String(flags.goal) : '' }), `could not add project ${name}`);
      console.log(`project added: ${name}`);
      break;
    }

    case 'ms': {
      const [pq, ...txt] = pos;
      const text = txt.join(' ').trim();
      if (!text) die("usage: ef ms <project> 'milestone' [--due D]");
      const p = findIn(Object.fromEntries(Object.values(state.projects).map((x) => [x.id, { ...x, title: x.name }])), pq, 'project');
      mustChange(apply('addMilestone', { id: p.id, t: text, due: flags.due ? dateArg(flags.due, today) : null }), `could not add a milestone to ${p.name}`);
      console.log(`milestone added to ${p.name}: ${text}`);
      break;
    }

    case 'msdone': {
      const [pq, ...txt] = pos;
      const p = findIn(Object.fromEntries(Object.values(state.projects).map((x) => [x.id, { ...x, title: x.name }])), pq, 'project');
      const m = state.projects[p.id].milestones.find((x) => x.id === txt.join(' ') || norm(x.t).includes(norm(txt.join(' '))));
      if (!m) die('no such milestone');
      mustChange(apply('toggleMilestone', { id: p.id, msId: m.id }), `could not toggle ${m.t}`);
      console.log(`${state.projects[p.id].milestones.find((x) => x.id === m.id).done ? '◆ done' : '◇ reopened'}: ${m.t}`);
      break;
    }

    case 'settings': {
      const patch = {};
      if (flags.cap) {
        const cap = {};
        for (const kv of String(flags.cap).split(',')) {
          const [k, v] = kv.split('=');
          const key = WEEKDAY_KEYS[String(k ?? '').trim().toLowerCase()];
          if (!key) die(`unknown weekday "${String(k ?? '').trim()}" in --cap (use mon,tue,wed,thu,fri,sat,sun). For one day only, use --cap-on <date>=<minutes>.`, 1);
          cap[key] = minutesArg(v, `--cap ${key}`);
        }
        patch.cap = { ...state.settings.cap, ...cap };
      }
      // One day only ("I have less time tomorrow"): settings.capOverrides { "YYYY-MM-DD": minutes }.
      const capOn = {};
      if (flags['cap-on']) {
        for (const kv of String(flags['cap-on']).split(',')) {
          const [d, v] = kv.split('=');
          if (v === undefined) die(`--cap-on needs <date>=<minutes>, e.g. tomorrow=90 (got "${kv}")`, 1);
          const date = dateArg(String(d).trim(), today, '--cap-on date');
          capOn[date] = /^(none|null|off|clear)$/i.test(String(v).trim()) ? null : minutesArg(v, `--cap-on ${date}`);
        }
        const cur = { ...(state.settings.capOverrides ?? {}) };
        for (const [d, m] of Object.entries(capOn)) {
          if (m === null) delete cur[d];
          else cur[d] = m;
        }
        for (const d of Object.keys(cur)) if (d < addDays(today, -7)) delete cur[d]; // old overrides are noise
        patch.capOverrides = cur;
      }
      if (flags.off) patch.offDays = [...new Set([...(state.settings.offDays ?? []), ...String(flags.off).split(',').map((d) => dateArg(d.trim(), today))])];
      if (flags.tz) patch.tz = String(flags.tz);
      if (Object.keys(patch).length) {
        const before = state;
        const res = apply('editSettings', { patch });
        const got = state.settings.capOverrides;
        const lost = Object.entries(capOn).some(([d, m]) => (m === null ? got?.[d] !== undefined : got?.[d] !== m));
        if (lost) {
          state = before; // nothing is saved
          die('settings.capOverrides was not stored (the engine dropped it; model.normalizeSettings must keep it). Nothing changed; move tasks off that day instead (ef move).', 1);
        }
        mustChange(res, 'settings already have those values (or they were invalid)');
      }
      for (const [d, m] of Object.entries(capOn)) {
        const every = state.settings.cap[dowKey(d)];
        console.log(m === null ? `capacity override removed for ${fmtDay(d)}` : `capacity for ${fmtDay(d)} only: ${fmtMinutes(m)} (other ${fmtDay(d).slice(0, 3)}s keep ${fmtMinutes(every)})`);
      }
      console.log(JSON.stringify(state.settings, null, 2));
      break;
    }

    case 'scrub': {
      const find = pos.join(' ').trim();
      if (!find) die("usage: ef scrub '<client identifier>' [--with 'client']");
      const res = apply('scrubText', { find, replace: typeof flags.with === 'string' ? flags.with : '' });
      if (!res.writes.length) {
        console.log('not found in data/state.json (nothing to scrub)');
        return;
      }
      const fields = res.writes.filter((w) => w.col !== 'activity' || w.op !== 'set').length;
      console.log(`scrubbed it from ${fields} stored entr${fields === 1 ? 'y' : 'ies'} in data/state.json (commit + push to publish).`);
      console.log('Git history and past commit messages still contain it; only Danny can remove those (rewrite history, or make the repo private).');
      break;
    }

    case 'stats': {
      const s = streak(state, today);
      const w = weekStats(state, today);
      console.log(`streak ${s.current} days (best ${s.best}) · this week ${w.done} done · ${fmtMinutes(w.minutes)} clocked`);
      for (const [c, n] of Object.entries(w.byCat ?? {})) console.log(`  ${catName(c).padEnd(22)} ${n}`);
      return;
    }

    case 'archive': {
      const days = Number(flags.days) || 90;
      const cutoff = addDays(today, -days);
      const old = Object.values(state.tasks).filter((t) => t.status !== 'todo' && (t.doneAt ? localDateOf(t.doneAt, state.settings.tz) : t.updated.slice(0, 10)) < cutoff);
      if (!old.length) return console.log('nothing to archive');
      const byYear = {};
      for (const t of old) (byYear[(t.doneAt || t.updated).slice(0, 4)] ??= []).push(t);
      const files = [];
      for (const [y, list] of Object.entries(byYear)) {
        const p = join(dirname(STATE_PATH), 'archive', `${y}.json`);
        mkdirSync(dirname(p), { recursive: true });
        const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { tasks: {} };
        for (const t of list) cur.tasks[t.id] = t;
        const sorted = {};
        for (const id of Object.keys(cur.tasks).sort()) sorted[id] = cur.tasks[id];
        writeFileSync(p, JSON.stringify({ ...cur, tasks: sorted }, null, 2) + '\n');
        files.push(`data/archive/${y}.json`);
      }
      const tasks = { ...state.tasks };
      for (const t of old) delete tasks[t.id];
      // An activity entry, so the commit message says what happened to those tasks.
      const a = { id: makeId('a_'), at: ctx.now, src: 'chat', type: 'archive', ref: null, title: `Archived ${old.length} old done task${old.length === 1 ? '' : 's'}`, from: null, to: files.join(', ') };
      state = { ...state, tasks, activity: { ...state.activity, [a.id]: a } };
      changed = true;
      console.log(`archived ${old.length} tasks → ${files.join(', ')} (ef commit includes them)`);
      break;
    }

    case 'check': {
      const text = readFileSync(STATE_PATH, 'utf8');
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        die(brokenStateHelp(err, text), 1);
      }
      const normalized = normalizeState(raw);
      const problems = [];
      for (const t of Object.values(normalized.tasks)) {
        if (!normalized.cats[t.cat]) problems.push(`task ${t.id} has unknown category ${t.cat}`);
        if (t.project && !normalized.projects[t.project]) problems.push(`task ${t.id} has unknown project ${t.project}`);
      }
      for (const c of Object.values(normalized.chores)) if (!normalized.cats[c.cat]) problems.push(`chore ${c.id} has unknown category ${c.cat}`);
      if (serializeState(normalized) !== text) problems.push('state.json is not in canonical form (run any ef edit command, or ef check --fix)');
      if (flags.fix) save(normalized);
      if (problems.length) {
        console.log(problems.join('\n'));
        if (!flags.fix) process.exit(1);
      } else console.log(`ok · ${Object.keys(normalized.tasks).length} tasks · ${Buffer.byteLength(text)} bytes`);
      return;
    }

    case 'commit': {
      commit(state, typeof flags.m === 'string' ? flags.m : null);
      return;
    }

    case 'push':
      push({ allowCode: !!flags['allow-code'] });
      return;

    default:
      die(`unknown command "${cmd}". Try: ef help`);
  }

  if (changed) save(state);

  /** One quick-add line → a task (or a chore). Returns true when something changed. */
  function addOne(text) {
    if (!text.trim()) return false;
    const parsed = parseQuickAdd(text, { today, now: ctx.now, cats: state.cats, settings: state.settings });
    if (!parsed.title) die(`empty title in "${text}"`);
    const fields = { ...parsed };
    if (flags.plan || flags.due) {
      // "lab meeting 2pm --due fri": the day the parser assumed for a bare time
      // (an implicit token with no text) gives way to the flag's date.
      for (const t of parsed.tokens ?? []) if ((t.type === 'plan' || t.type === 'due') && t.text === '') fields[t.type] = null;
    }
    if (flags.plan) fields.plan = flags.plan === 'none' ? null : dateArg(flags.plan, today, 'plan');
    if (flags.due) fields.due = flags.due === 'none' ? null : dateArg(flags.due, today, 'due');
    if (flags.cat) {
      const c = resolveCategory(flags.cat, state.cats);
      if (c) fields.cat = c.id;
      else fields.newCatName = flags.cat;
    }
    if (flags.est) fields.est = parseDuration(String(flags.est)) ?? die(`bad --est ${flags.est}`);
    if (flags.time) fields.time = parseTime(String(flags.time)) ?? die(`bad --time ${flags.time}`);
    if (flags.prio !== undefined) fields.prio = prioArg(flags.prio);
    if (flags.project) fields.project = flags.project;
    if (flags.notes) fields.notes = String(flags.notes);
    if (flags.kind) fields.kind = String(flags.kind);
    if (flags.win) fields.win = true;
    const res = apply('addTask', fields);
    if (res.duplicateOf && parsed.recurring) {
      // Already tracking this chore: update its cadence instead of adding a twin.
      const d = state.chores[res.duplicateOf];
      const patch = {};
      if (parsed.recurring.every && parsed.recurring.every !== d.every) patch.every = parsed.recurring.every;
      if (parsed.recurring.perDay && parsed.recurring.perDay !== d.perDay) patch.perDay = parsed.recurring.perDay;
      if (Object.keys(patch).length && apply('editChore', { id: d.id, patch }).writes.length) {
        const c = state.chores[d.id];
        console.log(`updated chore ${c.id}: ${c.title} · every ${c.every}d${c.perDay > 1 ? ` x${c.perDay}/day` : ''} (already tracked; no duplicate added)`);
        return true;
      }
      console.log(`already tracking chore ${d.id}: ${d.title} · every ${d.every}d${d.perDay > 1 ? ` x${d.perDay}/day` : ''} (nothing added)`);
      return true;
    }
    const created = res.writes.find((w) => w.op === 'set' && (w.col === 'tasks' || w.col === 'chores'));
    if (created?.col === 'chores') {
      const c = state.chores[created.id];
      console.log(`added chore ${c.id}: ${c.title} · every ${c.every}d${c.perDay > 1 ? ` x${c.perDay}/day` : ''} [${catName(c.cat)}]`);
    } else if (created) {
      const t = state.tasks[created.id];
      console.log(`added ${fmtTaskLine(t).trim()}`);
      if (parsed.catConfidence !== undefined && parsed.catConfidence < 0.5 && !flags.cat) console.log(`  (category guess: ${catName(t.cat)} — ${parsed.catReason || 'low confidence'}; ask Danny or ef edit ${t.id} --cat <id>)`);
    } else {
      console.error(`not added: "${text}"`);
      return false;
    }
    const newCat = res.writes.find((w) => w.col === 'cats' && w.op === 'set');
    if (newCat) console.log(`  new category created: ${newCat.data.name} (${newCat.id}) color ${newCat.data.color}`);
    return true;
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
