#!/usr/bin/env node
// ef: the command line Claude uses every chat turn to read and edit data/state.json.
// Run `node bin/ef.mjs help` for commands. All edits go through engine/ops.js so the
// website and the CLI change state the same way.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeState, serializeState, emptyState, diffWrites, applyWrites } from '../src/engine/model.js';
import {
  todayISO, nowISO, addDays, fmtDay, fmtTime, fmtMinutes, fmtRelative, diffDays,
  parseDatePhrase, parseDuration, isISODate, localDateOf, rangeDays,
} from '../src/engine/dates.js';
import { parseQuickAdd } from '../src/engine/parse.js';
import { resolveCategory } from '../src/engine/categories.js';
import { OPS } from '../src/engine/ops.js';
import { allocate, risks, dayLoad, planStart } from '../src/engine/schedule.js';
import { todayView, calendarView, upcomingDeadlines, backlog, projectView, choreView } from '../src/engine/views.js';
import { streak, weekStats } from '../src/engine/stats.js';
import { buildBrief, changesSince } from '../src/engine/brief.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = process.env.EF_STATE || join(ROOT, 'data/state.json');
const AUTHOR = process.env.EF_AUTHOR || 'Danny Zweben <176344411+dzweben@users.noreply.github.com>';
const TRAILERS = [
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  'Claude-Session: https://claude.ai/code/session_01NL5Kbvz5wMnVQyTdknJ3xc',
];

// ------------------------------------------------------------------ io

function load() {
  if (!existsSync(STATE_PATH)) return emptyState();
  return normalizeState(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
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

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ------------------------------------------------------------------ arg parsing

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function dateArg(text, today, label = 'date') {
  if (!text || text === true) die(`missing ${label}`);
  if (isISODate(text)) return text;
  const hit = parseDatePhrase(String(text), today);
  if (!hit || hit.consumed.trim().length < String(text).trim().length) die(`can't read ${label} "${text}"`);
  return hit.date;
}

// ------------------------------------------------------------------ finding things

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find one task by id or fuzzy title. `pool`: 'todo' | 'done' | 'any'. Exits with candidates on ambiguity. */
function findTask(state, query, pool = 'todo') {
  const q = String(query ?? '').trim();
  if (!q) die('missing task (id or part of the title)');
  if (state.tasks[q]) return state.tasks[q];
  const all = Object.values(state.tasks);
  const inPool = all.filter((t) => (pool === 'any' ? true : pool === 'done' ? t.status !== 'todo' : t.status === 'todo'));
  const nq = norm(q);
  const words = nq.split(' ').filter(Boolean);
  const exact = inPool.filter((t) => norm(t.title) === nq);
  if (exact.length === 1) return exact[0];
  const hits = inPool.filter((t) => {
    const nt = norm(t.title);
    return words.every((w) => nt.includes(w));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    if (pool !== 'any') {
      const other = all.filter((t) => words.every((w) => norm(t.title).includes(w)));
      if (other.length) die(`no ${pool} task matches "${q}". Other matches:\n${other.map(fmtTaskLine).join('\n')}`, 2);
    }
    die(`no task matches "${q}"`, 2);
  }
  // prefer the most recently touched when one is clearly a prefix match
  const prefix = hits.filter((t) => norm(t.title).startsWith(nq));
  if (prefix.length === 1) return prefix[0];
  die(`"${q}" matches ${hits.length} tasks; use an id:\n${hits.map(fmtTaskLine).join('\n')}`, 2);
}

function findIn(map, query, label) {
  const q = String(query ?? '').trim();
  if (!q) die(`missing ${label}`);
  if (map[q]) return map[q];
  const nq = norm(q);
  const items = Object.values(map);
  const hits = items.filter((x) => norm(x.title ?? x.name).includes(nq));
  if (hits.length === 1) return hits[0];
  if (!hits.length) die(`no ${label} matches "${q}"`, 2);
  const exact = hits.filter((x) => norm(x.title ?? x.name) === nq);
  if (exact.length === 1) return exact[0];
  die(`"${q}" matches several ${label}s:\n${hits.map((x) => `  ${x.id}  ${x.title ?? x.name}`).join('\n')}`, 2);
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

// ------------------------------------------------------------------ git

function gitPull() {
  for (let i = 0; i < 4; i++) {
    try {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      git(['fetch', 'origin', branch]);
      const status = git(['status', '--porcelain']).trim();
      if (status) {
        git(['stash', 'push', '--include-untracked', '-m', 'ef-sync-autostash']);
        try {
          git(['merge', '--ff-only', `origin/${branch}`]);
        } finally {
          try { git(['stash', 'pop']); } catch (err) { console.error('stash pop conflict; resolve data/state.json by re-running ops'); throw err; }
        }
      } else {
        git(['merge', '--ff-only', `origin/${branch}`]);
      }
      return branch;
    } catch (err) {
      if (i === 3) throw err;
      sleepMs(2000 * 2 ** i);
    }
  }
  return null;
}

function headState() {
  try {
    return normalizeState(JSON.parse(git(['show', 'HEAD:data/state.json'])));
  } catch {
    return emptyState();
  }
}

function summarize(entries) {
  const sym = { done: '✓', add: '+', move: '→', drop: '✕', delete: '✕', undone: '↺', chore: '♺', clock: '⏱', edit: '✎', sub: '☐', block: '▦', milestone: '◆', cat: '#', settings: '⚙' };
  const parts = entries.map((a) => `${sym[a.type] ?? '·'} ${a.title}${a.type === 'move' && a.to ? ` (${fmtDay(a.to)})` : ''}`);
  return parts;
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
  git(['commit', '-q', `--author=${AUTHOR}`, '-m', msg], { env: { ...process.env, GIT_COMMITTER_NAME: 'Danny Zweben', GIT_COMMITTER_EMAIL: AUTHOR.match(/<(.*)>/)[1] } });
  console.log(`committed: ${subject}`);
  return true;
}

function stateAt(ref) {
  try {
    return normalizeState(JSON.parse(git(['show', `${ref}:data/state.json`])));
  } catch {
    return emptyState();
  }
}

/**
 * The website committed while we worked. Replay our unpushed data changes onto the
 * remote state (3-way, entity/field level), recommit, and let push() retry.
 * Only safe when our unpushed commits touch nothing but data/.
 */
function rebaseDataOnto(branch) {
  git(['fetch', 'origin', branch]);
  const remoteRef = `origin/${branch}`;
  const mergeBase = git(['merge-base', 'HEAD', remoteRef]).trim();
  const touched = git(['diff', '--name-only', mergeBase, 'HEAD']).trim().split('\n').filter(Boolean);
  if (touched.some((f) => !f.startsWith('data/'))) {
    // code changes too: fall back to a normal rebase (data conflicts are resolved by replay below)
    try {
      git(['rebase', remoteRef]);
      return true;
    } catch {
      try { git(['checkout', '--theirs', 'data/state.json']); } catch { /* ignore */ }
      try { git(['rebase', '--abort']); } catch { /* ignore */ }
      return false;
    }
  }
  const subject = git(['log', '-1', '--format=%B']).trim();
  const base = stateAt(mergeBase);
  const ours = stateAt('HEAD');
  const remote = stateAt(remoteRef);
  const merged = applyWrites(remote, diffWrites(base, ours));
  git(['reset', '--hard', remoteRef]);
  save(normalizeState(merged));
  git(['add', 'data/']);
  git(['commit', '-q', `--author=${AUTHOR}`, '-m', subject], { env: { ...process.env, GIT_COMMITTER_NAME: 'Danny Zweben', GIT_COMMITTER_EMAIL: AUTHOR.match(/<(.*)>/)[1] } });
  console.log('merged our changes on top of new website commits');
  return true;
}

function push() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  for (let i = 0; i < 5; i++) {
    try {
      git(['push', '-u', 'origin', branch]);
      console.log(`pushed ${branch}`);
      return true;
    } catch (err) {
      const msg = String(err.stderr || err.message);
      if (/rejected|non-fast-forward|fetch first/.test(msg)) {
        if (!rebaseDataOnto(branch)) die(`push rejected and could not merge automatically. Run: git fetch && git reset --hard origin/${branch}, redo this turn's ef commands, then ef commit && ef push.`, 3);
        continue;
      }
      if (i === 4) die(`push failed: ${msg}`);
      sleepMs(2000 * 2 ** i);
    }
  }
  return false;
}

// ------------------------------------------------------------------ commands

const HELP = `ef — EF Console command line (edits data/state.json)

Every chat turn:
  ef sync                       pull website changes, show what Danny did since last turn
  ef today                      today's board
  ef brief [--write]            the check-in (--write puts it on the website)
  ef commit [-m msg] && ef push commit as Danny + push (retries)

Capture + edit:
  ef add "email mike - tomorrow" [--plan D] [--due D] [--cat id] [--est 30m] [--time 3pm] [--prio 0-3] [--project id] [--notes txt]
  ef done <task>                ef undo <task>          ef drop <task>          ef delete <task>
  ef move <task> <date>         (dates: tomorrow, fri, next mon, 10/12, in 3 days...)
  ef edit <task> [--title t] [--cat id] [--due D|none] [--plan D|none] [--time 3pm|none] [--est 1h|none] [--prio n] [--notes t] [--project id|none] [--triage yes|no] [--win yes|no]
  ef sub <task> "subtask" [--est 30m]    ef subdone <task> <n|text>
  ef log <task> <minutes>        ef plan [<task>] [--keep]   (auto-book work blocks before deadlines)

Look:
  ef cal [--days 14]   ef deadlines   ef risks   ef list [--all|--done|--backlog|--triage|--cat id]   ef find <text>
  ef projects   ef chores   ef cats   ef stats   ef changes [--since ISO]

Chores, clock, categories, projects, settings:
  ef chore add "title" --every 7 [--per-day 2] [--cat id] [--min 5]   ef chore done <chore>   ef chore edit <chore> --every N
  ef clock in <task|chore|"free text"> [--goal 5]   ef clock out [--done]   ef clock
  ef cat add "Name" [--group research|clinical|coursework|teaching|service|admin|life] [--alias a,b] [--color #hex]
  ef cat edit <id> [--name n] [--color #hex] [--group g] [--alias a,b] [--archive yes|no]
  ef project add "Name" [--cat id] [--due D] [--goal txt]   ef ms <project> "milestone" [--due D]   ef msdone <project> <milestone>
  ef settings [--cap mon=240,tue=240,...] [--off 2026-11-26]
  ef archive [--days 90]        move old done tasks to data/archive/<year>.json
  ef check                      validate data/state.json
`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
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
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    case 'sync': {
      if (!flags['no-pull']) {
        try {
          const branch = gitPull();
          console.log(`pulled origin/${branch}`);
        } catch (err) {
          console.log(`(pull failed: ${String(err.stderr || err.message).split('\n')[0]}) — continuing with local data`);
        }
      }
      state = load();
      STATE_FOR_FMT = state;
      const since = state.sync?.lastClaudeSync;
      const ch = changesSince(state, since);
      console.log(`\nSINCE CLAUDE'S LAST TURN (${since ? fmtRelative(localDateOf(since, state.settings.tz), today) + ' ' + since.slice(11, 16) + 'Z' : 'ever'}):`);
      if (!ch.entries.length) console.log('  nothing changed on the website');
      for (const a of ch.entries) console.log(`  ${a.at.slice(5, 16).replace('T', ' ')}  ${a.type.padEnd(8)} ${a.title}${a.to ? ' → ' + (isISODate(a.to) ? fmtDay(a.to) : a.to) : ''}`);
      try {
        const log = git(['log', '--since', since || '1970-01-01', '--format=%h %an: %s', '--', 'data/state.json']).trim();
        if (log) console.log(`\nCOMMITS TOUCHING DATA SINCE THEN:\n${log.split('\n').slice(0, 15).map((l) => '  ' + l).join('\n')}`);
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
      state = { ...state, sync: { ...(state.sync ?? {}), lastClaudeSync: ctx.now, lastActivitySeen: ctx.now } };
      save(state);
      console.log('');
      printToday(state, today);
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
      const text = pos.join(' ');
      if (!text.trim()) die('usage: ef add "email mike - tomorrow"');
      const parsed = parseQuickAdd(text, { today, cats: state.cats, settings: state.settings });
      if (!parsed.title) die('empty title');
      const fields = { ...parsed };
      if (flags.plan) fields.plan = flags.plan === 'none' ? null : dateArg(flags.plan, today, 'plan');
      if (flags.due) fields.due = flags.due === 'none' ? null : dateArg(flags.due, today, 'due');
      if (flags.cat) {
        const c = resolveCategory(flags.cat, state.cats);
        if (c) fields.cat = c.id;
        else fields.newCatName = flags.cat;
      }
      if (flags.est) fields.est = parseDuration(String(flags.est)) ?? die(`bad --est ${flags.est}`);
      if (flags.time) fields.time = (await import('../src/engine/dates.js')).parseTime(String(flags.time)) ?? die(`bad --time ${flags.time}`);
      if (flags.prio !== undefined) fields.prio = Number(flags.prio);
      if (flags.project) fields.project = flags.project;
      if (flags.notes) fields.notes = String(flags.notes);
      if (flags.kind) fields.kind = String(flags.kind);
      if (flags.win) fields.win = true;
      const res = apply('addTask', fields);
      const created = res.writes.find((w) => w.op === 'set' && (w.col === 'tasks' || w.col === 'chores'));
      if (created?.col === 'chores') {
        const c = state.chores[created.id];
        console.log(`added chore ${c.id}: ${c.title} · every ${c.every}d${c.perDay > 1 ? ` x${c.perDay}/day` : ''} [${catName(c.cat)}]`);
      } else if (created) {
        const t = state.tasks[created.id];
        console.log(`added ${fmtTaskLine(t).trim()}`);
        if (parsed.catConfidence !== undefined && parsed.catConfidence < 0.5 && !flags.cat) console.log(`  (category guess: ${catName(t.cat)} — ${parsed.catReason || 'low confidence'}; ask Danny or ef edit ${t.id} --cat <id>)`);
      }
      const newCat = res.writes.find((w) => w.col === 'cats' && w.op === 'set');
      if (newCat) console.log(`  new category created: ${newCat.data.name} (${newCat.id}) color ${newCat.data.color}`);
      break;
    }

    case 'done':
    case 'undo':
    case 'drop':
    case 'delete': {
      const t = findTask(state, pos.join(' '), cmd === 'undo' ? 'done' : cmd === 'delete' ? 'any' : 'todo');
      const op = { done: 'completeTask', undo: 'reopenTask', drop: 'dropTask', delete: 'deleteTask' }[cmd];
      apply(op, { id: t.id });
      console.log(`${cmd}: ${t.title}`);
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
      apply('moveTask', { id: t.id, to: found.date });
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
      if (flags.time) patch.time = opt(flags.time) && ((await import('../src/engine/dates.js')).parseTime(String(flags.time)) ?? die('bad --time'));
      if (flags.est) patch.est = opt(flags.est) && (parseDuration(String(flags.est)) ?? die('bad --est'));
      if (flags.prio !== undefined) patch.prio = Number(flags.prio);
      if (flags.notes !== undefined) patch.notes = String(flags.notes === true ? '' : flags.notes);
      if (flags.project) patch.project = opt(flags.project);
      if (flags.kind) patch.kind = String(flags.kind);
      if (flags.triage) patch.triage = /^(y|yes|true|1)$/i.test(String(flags.triage));
      if (flags.win) patch.win = /^(y|yes|true|1)$/i.test(String(flags.win));
      if (!Object.keys(patch).length) die('nothing to edit');
      apply('editTask', { id: t.id, patch });
      console.log(`edited ${fmtTaskLine(state.tasks[t.id]).trim()}`);
      break;
    }

    case 'sub': {
      const [q, ...txt] = pos;
      const t = findTask(state, q, 'todo');
      const est = flags.est ? parseDuration(String(flags.est)) : undefined;
      apply('addSub', { id: t.id, t: txt.join(' '), est });
      console.log(`subtask added to ${t.title}: ${txt.join(' ')}`);
      break;
    }

    case 'subdone': {
      const [q, ...which] = pos;
      const t = findTask(state, q, 'todo');
      const w = which.join(' ');
      const idx = /^\d+$/.test(w) ? Number(w) - 1 : t.subs.findIndex((s) => norm(s.t).includes(norm(w)));
      const sub = t.subs[idx];
      if (!sub) die(`no subtask "${w}" on ${t.title}`);
      apply('toggleSub', { id: t.id, subId: sub.id });
      console.log(`${state.tasks[t.id].subs[idx].done ? '✓' : '☐'} ${sub.t}`);
      break;
    }

    case 'log': {
      const [q, mins] = pos.length >= 2 ? [pos.slice(0, -1).join(' '), pos[pos.length - 1]] : [pos[0], null];
      const minutes = parseDuration(String(mins ?? ''));
      if (!minutes) die('usage: ef log <task> <minutes>');
      const t = findTask(state, q, 'any');
      apply('logTime', { ref: `task:${t.id}`, minutes });
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
      if (flags.cat) list = list.filter((t) => t.cat === flags.cat);
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
        console.log(`${ch.id.padEnd(14)} ${ch.title.padEnd(22)} every ${ch.every}d${ch.perDay > 1 ? ` x${ch.perDay}` : ''} · ${c.due ? 'DUE' : 'ok'} · last ${ch.last ? fmtRelative(ch.last, today) : 'never'}${ch.every === 1 ? ` · today ${c.todayCount}/${ch.perDay}` : ''}`);
      }
      return;

    case 'chore': {
      const [sub, ...r] = pos;
      if (sub === 'add') {
        const title = r.join(' ');
        if (!title) die('usage: ef chore add "title" --every 7');
        const cat = flags.cat ? (resolveCategory(flags.cat, state.cats) ?? die('no such category')).id : parseQuickAdd(title, { today, cats: state.cats, settings: state.settings }).cat;
        apply('addChore', { title, cat: cat === 'inbox' ? 'home' : cat, every: Number(flags.every) || 7, perDay: Number(flags['per-day']) || 1, min: Number(flags.min) || 5 });
        console.log(`chore added: ${title}`);
      } else if (sub === 'done') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        apply('choreDone', { id: c.id });
        console.log(`♺ ${c.title} done`);
      } else if (sub === 'edit') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        const patch = {};
        if (flags.every) patch.every = Number(flags.every);
        if (flags['per-day']) patch.perDay = Number(flags['per-day']);
        if (flags.min) patch.min = Number(flags.min);
        if (flags.title) patch.title = String(flags.title);
        if (flags.active) patch.active = /^(y|yes|true|1)$/i.test(String(flags.active));
        apply('editChore', { id: c.id, patch });
        console.log(`chore edited: ${state.chores[c.id].title}`);
      } else if (sub === 'delete') {
        const c = findIn(state.chores, r.join(' '), 'chore');
        apply('deleteChore', { id: c.id });
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
        const q = r.join(' ');
        let ref = 'free';
        let title = q || 'Focus';
        let cat = 'inbox';
        const chore = Object.values(state.chores).find((c) => norm(c.title).includes(norm(q)) && q);
        const task = !chore && q ? Object.values(state.tasks).find((t) => t.status === 'todo' && norm(t.title).includes(norm(q))) : null;
        if (chore) ({ ref, title, cat } = { ref: `chore:${chore.id}`, title: chore.title, cat: chore.cat });
        else if (task) ({ ref, title, cat } = { ref: `task:${task.id}`, title: task.title, cat: task.cat });
        apply('clockIn', { ref, title, cat, goal: Number(flags.goal) || 5 });
        console.log(`⏱ clocked in: ${title} (goal ${Number(flags.goal) || 5} min)`);
      } else if (sub === 'out') {
        const was = state.clock;
        apply('clockOut', { markDone: !!flags.done });
        if (was?.active) console.log(`⏱ clocked out: ${was.title}`);
        else console.log('no clock was running');
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
        const name = r.join(' ');
        if (!name) die('usage: ef cat add "Name" --group research');
        apply('addCategory', { name, group: flags.group || 'admin', color: flags.color, aliases: flags.alias ? String(flags.alias).split(',').map((s) => s.trim()) : undefined });
        const c = Object.values(state.cats).find((x) => x.name === name);
        console.log(`category added: ${c?.name} (${c?.id}) ${c?.color} [${c?.group}]`);
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
        apply('editCategory', { id: c.id, patch });
        console.log(`category edited: ${state.cats[c.id].name}`);
      } else die('usage: ef cat add|edit');
      break;
    }

    case 'project': {
      const [sub, ...r] = pos;
      if (sub !== 'add') die('usage: ef project add "Name" --cat id');
      const name = r.join(' ');
      apply('addProject', { name, cat: flags.cat ? (resolveCategory(flags.cat, state.cats) ?? die('no such category')).id : 'inbox', due: flags.due ? dateArg(flags.due, today) : null, goal: flags.goal ? String(flags.goal) : '' });
      console.log(`project added: ${name}`);
      break;
    }

    case 'ms': {
      const [pq, ...txt] = pos;
      const p = findIn(Object.fromEntries(Object.values(state.projects).map((x) => [x.id, { ...x, title: x.name }])), pq, 'project');
      apply('addMilestone', { id: p.id, t: txt.join(' '), due: flags.due ? dateArg(flags.due, today) : null });
      console.log(`milestone added to ${p.name}: ${txt.join(' ')}`);
      break;
    }

    case 'msdone': {
      const [pq, ...txt] = pos;
      const p = findIn(Object.fromEntries(Object.values(state.projects).map((x) => [x.id, { ...x, title: x.name }])), pq, 'project');
      const m = state.projects[p.id].milestones.find((x) => x.id === txt.join(' ') || norm(x.t).includes(norm(txt.join(' '))));
      if (!m) die('no such milestone');
      apply('toggleMilestone', { id: p.id, msId: m.id });
      console.log(`${state.projects[p.id].milestones.find((x) => x.id === m.id).done ? '◆ done' : '◇ reopened'}: ${m.t}`);
      break;
    }

    case 'settings': {
      const patch = {};
      if (flags.cap) {
        const cap = { ...state.settings.cap };
        for (const kv of String(flags.cap).split(',')) {
          const [k, v] = kv.split('=');
          if (k in cap) cap[k.trim()] = parseDuration(v.trim()) ?? Number(v);
        }
        patch.cap = cap;
      }
      if (flags.off) patch.offDays = [...new Set([...(state.settings.offDays ?? []), ...String(flags.off).split(',').map((d) => dateArg(d.trim(), today))])];
      if (flags.tz) patch.tz = String(flags.tz);
      if (Object.keys(patch).length) apply('editSettings', { patch });
      console.log(JSON.stringify(state.settings, null, 2));
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
      for (const [y, list] of Object.entries(byYear)) {
        const p = join(ROOT, `data/archive/${y}.json`);
        mkdirSync(dirname(p), { recursive: true });
        const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { tasks: {} };
        for (const t of list) cur.tasks[t.id] = t;
        writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
      }
      const tasks = { ...state.tasks };
      for (const t of old) delete tasks[t.id];
      state = { ...state, tasks };
      changed = true;
      console.log(`archived ${old.length} tasks`);
      break;
    }

    case 'check': {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      const normalized = normalizeState(raw);
      const problems = [];
      for (const t of Object.values(normalized.tasks)) {
        if (!normalized.cats[t.cat]) problems.push(`task ${t.id} has unknown category ${t.cat}`);
        if (t.project && !normalized.projects[t.project]) problems.push(`task ${t.id} has unknown project ${t.project}`);
      }
      for (const c of Object.values(normalized.chores)) if (!normalized.cats[c.cat]) problems.push(`chore ${c.id} has unknown category ${c.cat}`);
      if (serializeState(normalized) !== readFileSync(STATE_PATH, 'utf8')) problems.push('state.json is not in canonical form (run any ef edit command, or ef check --fix)');
      if (flags.fix) save(normalized);
      if (problems.length) {
        console.log(problems.join('\n'));
        if (!flags.fix) process.exit(1);
      } else console.log(`ok · ${Object.keys(normalized.tasks).length} tasks · ${Buffer.byteLength(readFileSync(STATE_PATH))} bytes`);
      return;
    }

    case 'commit': {
      commit(state, typeof flags.m === 'string' ? flags.m : null);
      return;
    }

    case 'push':
      push();
      return;

    default:
      die(`unknown command "${cmd}". Try: ef help`);
  }

  if (changed) save(state);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
