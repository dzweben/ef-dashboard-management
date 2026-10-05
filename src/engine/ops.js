// Every mutation of the to-do database. Pure: no DOM, no Node APIs, never mutates
// its inputs, never throws on a missing id. See docs/ARCHITECTURE.md ("ops.js").
//
// Each op is (state, args, ctx) → { state, writes, activity }:
//   - it first builds the list of doc-level writes,
//   - then derives the new state with model.applyWrites(state, writes),
// so the returned state and the writes can never disagree (the website replays
// `writes` onto a newer remote state after a conflict).
// ctx = { now: ISO, today: "YYYY-MM-DD", src: "dash"|"chat"|"import" }.

import {
  DEFAULT_SETTINGS, GROUPS, KINDS, PRIO_LABELS, STATUSES,
  applyWrites, makeId,
  normalizeBrief, normalizeCategory, normalizeChore, normalizeClock, normalizeProject,
  normalizeSettings, normalizeTask,
} from './model.js';
import { isISODate, localDateOf, nowISO, parseDatePhrase, parseDuration, parseTime, todayISO } from './dates.js';
import { makeCategory, resolveCategory } from './categories.js';

// ---------------------------------------------------------------- helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const obj = (v) => (isObj(v) ? v : {});
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SRCS = ['chat', 'dash', 'import'];

/** Fill in ctx: now (ISO), today (local date in the settings tz), src (default "dash"). */
function ctxOf(state, ctx) {
  const x = obj(ctx);
  const tz = (typeof state?.settings?.tz === 'string' && state.settings.tz) || DEFAULT_SETTINGS.tz;
  const now = typeof x.now === 'string' && !Number.isNaN(Date.parse(x.now)) ? x.now : nowISO();
  const today = isISODate(x.today) ? x.today : localDateOf(now, tz) ?? todayISO(tz);
  const src = SRCS.includes(x.src) ? x.src : 'dash';
  return { now, today, src, tz };
}

const noop = (state) => ({ state, writes: [], activity: [] });

function entry(state, col, id) {
  if (typeof id !== 'string' || !id) return null;
  const coll = state?.[col];
  const doc = isObj(coll) ? coll[id] : null;
  return isObj(doc) ? doc : null;
}

/**
 * Write collector. `push` records writes and keeps a running state so composed
 * ops (clockIn → clockOut → completeTask) see each other's effects; `result`
 * recomputes the final state from the original state + the full write list.
 */
class Tx {
  constructor(state, c) {
    this.base = state;
    this.cur = state;
    this.c = c;
    this.writes = [];
    this.activity = [];
  }

  push(...ws) {
    const list = ws.filter(Boolean);
    if (!list.length) return;
    this.writes.push(...list);
    this.cur = applyWrites(this.cur, list);
  }

  set(col, id, data) {
    this.push({ op: 'set', col, id, data });
  }

  update(col, id, data) {
    this.push({ op: 'update', col, id, data });
  }

  meta(id, data) {
    this.push({ op: 'set', col: 'meta', id, data });
  }

  log(type, ref, title, from = null, to = null) {
    const a = {
      id: makeId('a_'),
      at: this.c.now,
      src: this.c.src,
      type,
      ref: ref ?? null,
      title: String(title ?? ''),
      from: from ?? null,
      to: to ?? null,
    };
    this.push({ op: 'set', col: 'activity', id: a.id, data: a });
    this.activity.push(a);
    return a;
  }

  /** Run another op against the running state and fold its writes in. */
  run(fn, args) {
    const r = fn(this.cur, args, this.c);
    if (r && r.writes && r.writes.length) {
      this.writes.push(...r.writes);
      this.activity.push(...r.activity);
      this.cur = r.state;
    }
    return r;
  }

  result() {
    if (!this.writes.length) return noop(this.base);
    return { state: applyWrites(this.base, this.writes), writes: this.writes, activity: this.activity };
  }
}

/** Fields of `next` (among `keys`) that differ from `prev`. */
function changedFields(prev, next, keys) {
  const out = {};
  for (const k of new Set(keys)) {
    if (!sameJSON(prev?.[k] ?? null, next?.[k] ?? null)) out[k] = next[k] === undefined ? null : next[k];
  }
  return out;
}

/** A fresh id for a collection: `wanted` if given and unused, else makeId(prefix). */
function freshId(coll, wanted, prefix) {
  const c = isObj(coll) ? coll : {};
  if (typeof wanted === 'string' && wanted.trim() && !c[wanted.trim()]) return wanted.trim();
  let id = makeId(prefix);
  while (c[id]) id = makeId(prefix);
  return id;
}

/** Next unused "<prefix><n>" id inside an array of { id } items (subs: s1, s2…; milestones: m1…). */
function nextLocalId(items, prefix) {
  const ids = new Set((Array.isArray(items) ? items : []).map((x) => (isObj(x) ? String(x.id) : '')));
  let n = 0;
  for (const id of ids) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]));
  }
  let id = `${prefix}${n + 1}`;
  while (ids.has(id)) id = `${prefix}${++n + 1}`;
  return id;
}

/** Category id from an id / name / alias, or null if nothing matches. */
function resolveCatId(state, v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const cats = obj(state?.cats);
  if (isObj(cats[v])) return v;
  const hit = resolveCategory(v, cats);
  return hit ? hit.id : null;
}

/** Project id from an id or exact name (case-insensitive), or null. */
function resolveProjectId(state, v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const projects = obj(state?.projects);
  if (isObj(projects[v])) return v;
  const q = v.trim().toLowerCase();
  const hit = Object.values(projects).find((p) => isObj(p) && (String(p.name ?? '').trim().toLowerCase() === q || String(p.id).toLowerCase() === q));
  return hit ? hit.id : null;
}

/** "YYYY-MM-DD" from an ISO date or a whole date phrase ("tomorrow", "fri", "10/12"); null on failure. */
function toDate(v, today) {
  if (isISODate(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const hit = parseDatePhrase(v.trim(), today);
  return hit && hit.consumed.trim().length === v.trim().length ? hit.date : null;
}

const UNSET = Symbol('unset');

/** Clear-able date field: null/'' → null, valid date or phrase → date, junk → UNSET (ignore). */
function dateField(v, today) {
  if (v === null || v === '') return null;
  const d = toDate(v, today);
  return d ?? UNSET;
}

function minutesField(v) {
  if (v === null || v === '') return null;
  if (isNum(v)) return v >= 0 ? Math.round(v) : UNSET;
  if (typeof v === 'string') {
    const m = parseDuration(v);
    return m === null ? UNSET : m;
  }
  return UNSET;
}

function boolField(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === 0 || v === '0' || v === 'no' || v === null) return false;
  return UNSET;
}

// ---------------------------------------------------------------- tasks

const TASK_EDITABLE = ['title', 'cat', 'due', 'time', 'plan', 'est', 'prio', 'kind', 'notes', 'project', 'win', 'subs', 'blocks', 'triage', 'status'];

/** Coerce raw task fields (from the UI, the CLI or quick-add) into valid values; invalid ones are dropped. */
function coerceTaskFields(state, raw, today) {
  const out = {};
  for (const k of TASK_EDITABLE) {
    if (!(k in raw) || raw[k] === undefined) continue;
    const v = raw[k];
    let val = UNSET;
    switch (k) {
      case 'title':
        if (typeof v === 'string' && v.trim()) val = v.trim();
        break;
      case 'cat':
        val = resolveCatId(state, v) ?? UNSET;
        break;
      case 'due':
      case 'plan':
        val = dateField(v, today);
        break;
      case 'time':
        if (v === null || v === '') val = null;
        else if (typeof v === 'string') val = (/^\d{2}:\d{2}$/.test(v) ? v : parseTime(v)) ?? UNSET;
        break;
      case 'est':
        val = minutesField(v);
        break;
      case 'prio': {
        if (isNum(v)) val = v;
        else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) val = Number(v);
        else if (typeof v === 'string' && PRIO_LABELS.includes(v.toLowerCase())) val = PRIO_LABELS.indexOf(v.toLowerCase());
        break;
      }
      case 'kind':
        if (KINDS.includes(v)) val = v;
        break;
      case 'notes':
        val = v === null ? '' : typeof v === 'string' ? v : UNSET;
        break;
      case 'project':
        val = v === null || v === '' ? null : resolveProjectId(state, v) ?? UNSET;
        break;
      case 'win':
      case 'triage':
        val = boolField(v);
        break;
      case 'subs':
      case 'blocks':
        if (Array.isArray(v)) val = v;
        break;
      case 'status':
        if (STATUSES.includes(v)) val = v;
        break;
      default:
        break;
    }
    if (val !== UNSET) out[k] = val;
  }
  return out;
}

/** Was this a push to a later day? (previous plan, else previous due, is earlier than `to`) */
function isLaterMove(task, to) {
  if (!isISODate(to)) return false;
  if (isISODate(task.plan)) return to > task.plan;
  if (isISODate(task.due)) return to > task.due;
  return false;
}

const num0 = (v) => (isNum(v) ? v : 0);

/**
 * Add a task. `partial` may be a parse.parseQuickAdd() result: `newCatName`
 * (when no category matched) creates that category first; `recurring` makes a
 * chore instead. Parse-only fields never reach the stored task.
 */
export function addTask(state, partial = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const p = obj(partial);
  const title = str(p.title).trim();
  if (!title) return noop(state);
  const tx = new Tx(state, c);
  const fields = coerceTaskFields(state, p, c.today);

  let catId = fields.cat && fields.cat !== 'inbox' ? fields.cat : null;
  const newName = str(p.newCatName).replace(/^\s*#+/, '').trim();
  if (!catId && newName) {
    const existing = resolveCatId(tx.cur, newName);
    if (existing) catId = existing;
    else {
      const r = tx.run(addCategory, { name: newName, group: p.newCatGroup || 'admin' });
      const w = r.writes.find((x) => x.col === 'cats' && x.op === 'set');
      if (w) catId = w.id;
    }
  }
  if (!catId) catId = fields.cat ?? null;

  if (isObj(p.recurring)) {
    const est = minutesField(p.est);
    tx.run(addChore, {
      title,
      cat: catId && catId !== 'inbox' ? catId : undefined,
      every: p.recurring.every,
      perDay: p.recurring.perDay,
      min: isNum(p.min) ? p.min : isNum(est) && est > 0 ? est : undefined,
      notes: typeof p.notes === 'string' ? p.notes : '',
    });
    return tx.result();
  }

  const id = freshId(tx.cur.tasks, p.id, 't_');
  const status = fields.status ?? 'todo';
  const task = normalizeTask(
    {
      ...fields,
      id,
      title,
      cat: catId ?? 'inbox',
      spent: isNum(p.spent) ? p.spent : 0,
      moved: 0,
      created: c.now,
      updated: c.now,
      doneAt: status === 'done' ? (typeof p.doneAt === 'string' && !Number.isNaN(Date.parse(p.doneAt)) ? p.doneAt : c.now) : null,
      src: c.src,
    },
    c,
  );
  tx.set('tasks', id, task);
  tx.log('add', id, task.title, null, task.plan ?? task.due ?? null);
  return tx.result();
}

/** status → done, doneAt → now, triage cleared. Already done → no-op. */
export function completeTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const t = entry(state, 'tasks', obj(args).id);
  if (!t || t.status === 'done') return noop(state);
  const tx = new Tx(state, c);
  const data = { status: 'done', doneAt: c.now, updated: c.now };
  if (t.triage) data.triage = false;
  tx.update('tasks', t.id, data);
  tx.log('done', t.id, t.title);
  return tx.result();
}

/** Back to todo (from done or dropped). */
export function reopenTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const t = entry(state, 'tasks', obj(args).id);
  if (!t || (t.status ?? 'todo') === 'todo') return noop(state);
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { status: 'todo', doneAt: null, updated: c.now });
  tx.log('undone', t.id, t.title);
  return tx.result();
}

/** status → dropped (kept for the record), triage cleared. */
export function dropTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const t = entry(state, 'tasks', obj(args).id);
  if (!t || t.status === 'dropped') return noop(state);
  const tx = new Tx(state, c);
  const data = { status: 'dropped', updated: c.now };
  if (t.triage) data.triage = false;
  if (t.doneAt != null) data.doneAt = null;
  tx.update('tasks', t.id, data);
  tx.log('drop', t.id, t.title);
  return tx.result();
}

export function deleteTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const t = entry(state, 'tasks', obj(args).id);
  if (!t) return noop(state);
  const tx = new Tx(state, c);
  tx.push({ op: 'delete', col: 'tasks', id: t.id });
  tx.log('delete', t.id, t.title);
  return tx.result();
}

/**
 * Set the do-date. `to` is "YYYY-MM-DD" (or a date phrase), or null for the
 * backlog. A push to a later day bumps `moved`. Always clears triage.
 */
export function moveTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  if (!t || !('to' in a)) return noop(state);
  const to = a.to === null || a.to === '' ? null : toDate(a.to, c.today);
  if (to === null && a.to !== null && a.to !== '') return noop(state);
  const prev = isISODate(t.plan) ? t.plan : null;
  const data = {};
  if (to !== prev) data.plan = to;
  if (t.triage) data.triage = false;
  if (isLaterMove(t, to)) data.moved = num0(t.moved) + 1;
  if (!Object.keys(data).length) return noop(state);
  data.updated = c.now;
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, data);
  tx.log('move', t.id, t.title, prev, to);
  return tx.result();
}

function findBlock(task, blockId) {
  if (!Array.isArray(task?.blocks)) return null;
  return task.blocks.find((b) => isObj(b) && b.id === blockId) ?? null;
}

/** Move one work block to another day; it becomes manual (auto:false) so re-planning leaves it alone. */
export function moveBlock(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  const b = findBlock(t, a.blockId);
  const to = toDate(a.to, c.today);
  if (!t || !b || !to) return noop(state);
  if (b.d === to && b.auto === false) return noop(state);
  const blocks = t.blocks.map((x) => (isObj(x) && x.id === b.id ? { ...x, d: to, auto: false } : x));
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { blocks, updated: c.now });
  tx.log('block', t.id, t.title, b.d ?? null, to);
  return tx.result();
}

/** Check / un-check a work block; its minutes are added to / taken off `spent` (never below 0). */
export function toggleBlock(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  const b = findBlock(t, a.blockId);
  if (!t || !b) return noop(state);
  const done = b.done !== true;
  const m = Math.max(0, Math.round(num0(b.m)));
  const spent = done ? num0(t.spent) + m : Math.max(0, num0(t.spent) - m);
  const blocks = t.blocks.map((x) => (isObj(x) && x.id === b.id ? { ...x, done } : x));
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { blocks, spent, updated: c.now });
  tx.log('block', t.id, t.title, b.d ?? null, done ? 'done' : 'todo');
  return tx.result();
}

/**
 * Edit any of: title, cat, due, time, plan, est, prio, kind, notes, project, win,
 * subs, blocks, triage, status. Values are normalized (bad ones ignored) and only
 * fields that actually change are written. status → done sets doneAt; a later
 * plan date counts as a push (moved += 1) and clears triage, like moveTask.
 */
export function editTask(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  if (!t || !isObj(a.patch)) return noop(state);
  const p = coerceTaskFields(state, a.patch, c.today);
  if (!Object.keys(p).length) return noop(state);

  const merged = { ...t, ...p };
  const derived = [];
  const prevStatus = t.status ?? 'todo';
  if ('status' in p && p.status !== prevStatus) {
    merged.doneAt = p.status === 'done' ? c.now : null;
    derived.push('doneAt');
    if (p.status !== 'todo' && !('triage' in p) && t.triage) {
      merged.triage = false;
      derived.push('triage');
    }
  }
  const prevPlan = isISODate(t.plan) ? t.plan : null;
  if ('plan' in p && p.plan !== prevPlan) {
    if (!('triage' in p) && t.triage) {
      merged.triage = false;
      derived.push('triage');
    }
    if (isLaterMove(t, p.plan)) {
      merged.moved = num0(t.moved) + 1;
      derived.push('moved');
    }
  }

  const n = normalizeTask(merged, c);
  const changed = changedFields(t, n, [...Object.keys(p), ...derived]);
  if (!Object.keys(changed).length) return noop(state);
  changed.updated = c.now;

  const tx = new Tx(state, c);
  tx.update('tasks', t.id, changed);
  const keys = Object.keys(changed).filter((k) => !['updated', 'doneAt', 'moved'].includes(k));
  if ('status' in changed) {
    tx.log({ done: 'done', todo: 'undone', dropped: 'drop' }[changed.status] ?? 'edit', t.id, n.title);
  } else if ('plan' in changed && keys.every((k) => k === 'plan' || k === 'triage')) {
    tx.log('move', t.id, n.title, prevPlan, n.plan);
  } else {
    tx.log('edit', t.id, n.title, null, keys.join(','));
  }
  return tx.result();
}

// ---------------------------------------------------------------- subtasks

export function toggleSub(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  const subs = Array.isArray(t?.subs) ? t.subs : [];
  const s = subs.find((x) => isObj(x) && x.id === a.subId);
  if (!t || !s) return noop(state);
  const done = s.done !== true;
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { subs: subs.map((x) => (x === s ? { ...x, done } : x)), updated: c.now });
  tx.log('sub', t.id, `${t.title} / ${s.t}`, null, done ? 'done' : 'todo');
  return tx.result();
}

export function addSub(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  const text = str(a.t).trim();
  if (!t || !text) return noop(state);
  const subs = Array.isArray(t.subs) ? t.subs : [];
  const sub = { id: nextLocalId(subs, 's'), t: text, done: false };
  const est = minutesField(a.est);
  if (isNum(est)) sub.est = est;
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { subs: [...subs, sub], updated: c.now });
  tx.log('sub', t.id, `${t.title} / ${text}`, null, 'added');
  return tx.result();
}

export function removeSub(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const t = entry(state, 'tasks', a.id);
  const subs = Array.isArray(t?.subs) ? t.subs : [];
  const s = subs.find((x) => isObj(x) && x.id === a.subId);
  if (!t || !s) return noop(state);
  const tx = new Tx(state, c);
  tx.update('tasks', t.id, { subs: subs.filter((x) => x !== s), updated: c.now });
  tx.log('sub', t.id, `${t.title} / ${s.t}`, null, 'removed');
  return tx.result();
}

// ---------------------------------------------------------------- clock + time

/**
 * Resolve a clock ref: "task:t_…" / "chore:c_…" (or a bare t_/c_ id) → the entity;
 * "free"/empty → free. `missing` is true when a task/chore ref names nothing.
 */
function resolveRef(state, ref) {
  const r = typeof ref === 'string' ? ref.trim() : '';
  let kind = null;
  let id = null;
  const m = r.match(/^(task|chore):(.+)$/);
  if (m) [, kind, id] = m;
  else if (/^t_/.test(r)) [kind, id] = ['task', r];
  else if (/^c_/.test(r)) [kind, id] = ['chore', r];
  if (!kind) return { ref: 'free', kind: 'free', id: null, entity: null, missing: false };
  const entity = entry(state, kind === 'task' ? 'tasks' : 'chores', id);
  if (!entity) return { ref: 'free', kind: 'free', id: null, entity: null, missing: true };
  return { ref: `${kind}:${id}`, kind, id, entity, missing: false };
}

/**
 * Start the timer. A running clock on something else is stopped first (logged,
 * not marked done). Same ref already running → no-op (or just a new goal).
 */
export function clockIn(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const target = resolveRef(state, a.ref);
  if (target.missing) return noop(state);
  const goalArg = minutesField(a.goal);
  const goal = isNum(goalArg) && goalArg > 0 ? goalArg : target.kind === 'chore' && isNum(target.entity.min) ? target.entity.min : 5;
  const title = str(a.title).trim() || str(target.entity?.title).trim() || 'Focus';
  const tx = new Tx(state, c);
  const running = isObj(state?.clock) && state.clock.active === true ? state.clock : null;

  if (running && running.ref === target.ref && (target.kind !== 'free' || running.title === title)) {
    if (!isNum(goalArg) || goalArg <= 0 || goalArg === running.goal) return noop(state);
    tx.meta('clock', normalizeClock({ ...running, goal }));
    tx.log('clock', target.id, running.title, null, `goal ${goal}m`);
    return tx.result();
  }
  if (running) tx.run(clockOut, { markDone: false });

  const cat = resolveCatId(state, a.cat) ?? (target.entity ? target.entity.cat : null) ?? 'inbox';
  tx.meta('clock', normalizeClock({ active: true, ref: target.ref, title, cat, start: c.now, goal }));
  tx.log('clock', target.id, title, null, 'start');
  return tx.result();
}

/**
 * Stop the timer: record a session (≥ 1 minute), add the minutes to the task's
 * `spent` (and complete it when markDone), or mark the chore done today (any
 * clock-in on a chore counts, even 5 minutes). No clock running → no-op.
 */
export function clockOut(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const clock = isObj(state?.clock) && state.clock.active === true ? state.clock : null;
  if (!clock) return noop(state);
  const startMs = Date.parse(clock.start);
  const nowMs = Date.parse(c.now);
  const start = Number.isNaN(startMs) ? c.now : clock.start;
  const min = Number.isNaN(startMs) ? 1 : Math.max(1, Math.round((nowMs - startMs) / 60000));
  const target = resolveRef(state, clock.ref);
  const title = str(clock.title) || str(target.entity?.title) || 'Focus';

  const tx = new Tx(state, c);
  const session = {
    id: freshId(state?.sessions, null, 's_'),
    ref: typeof clock.ref === 'string' && clock.ref ? clock.ref : 'free',
    title,
    cat: str(clock.cat) || (target.entity ? target.entity.cat : '') || 'inbox',
    start,
    end: c.now,
    min,
    d: localDateOf(start, c.tz) ?? c.today,
  };
  tx.set('sessions', session.id, session);
  if (target.kind === 'task') tx.update('tasks', target.id, { spent: num0(target.entity.spent) + min, updated: c.now });
  tx.meta('clock', { active: false });
  tx.log('clock', target.id, title, null, `${min}m`);
  if (target.kind === 'task' && a.markDone === true) tx.run(completeTask, { id: target.id });
  if (target.kind === 'chore') tx.run(choreDone, { id: target.id });
  return tx.result();
}

/** Log time after the fact: a session of `minutes` ending now, with the same effects as clockOut. */
export function logTime(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const minutes = minutesField(a.minutes);
  if (!isNum(minutes) || minutes <= 0) return noop(state);
  const target = resolveRef(state, a.ref);
  if (target.missing) return noop(state);
  const title = str(a.title).trim() || str(target.entity?.title).trim() || 'Focus';
  const nowMs = Date.parse(c.now);
  const tx = new Tx(state, c);
  const session = {
    id: freshId(state?.sessions, null, 's_'),
    ref: target.ref,
    title,
    cat: resolveCatId(state, a.cat) ?? (target.entity ? target.entity.cat : null) ?? 'inbox',
    start: new Date(nowMs - minutes * 60000).toISOString(),
    end: c.now,
    min: minutes,
    d: c.today,
  };
  tx.set('sessions', session.id, session);
  if (target.kind === 'task') tx.update('tasks', target.id, { spent: num0(target.entity.spent) + minutes, updated: c.now });
  tx.log('clock', target.id, title, null, `${minutes}m`);
  if (target.kind === 'chore') tx.run(choreDone, { id: target.id });
  return tx.result();
}

// ---------------------------------------------------------------- chores

/** Check off a chore for today (log keeps the last 90 check-offs; a date may repeat). */
export function choreDone(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const ch = entry(state, 'chores', obj(args).id);
  if (!ch) return noop(state);
  const log = [...(Array.isArray(ch.log) ? ch.log.filter(isISODate) : []), c.today].slice(-90);
  const tx = new Tx(state, c);
  tx.update('chores', ch.id, { last: c.today, log, updated: c.now });
  tx.log('chore', ch.id, ch.title);
  return tx.result();
}

const CHORE_EDITABLE = ['title', 'cat', 'every', 'perDay', 'min', 'active', 'notes', 'last', 'log'];

function defaultChoreCat(state) {
  return isObj(state?.cats?.home) ? 'home' : 'inbox';
}

export function addChore(state, partial = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const p = obj(partial);
  const title = str(p.title).trim();
  if (!title) return noop(state);
  const id = freshId(state?.chores, p.id, 'c_');
  const fields = {};
  for (const k of CHORE_EDITABLE) if (k in p && p[k] !== undefined) fields[k] = p[k];
  const ch = normalizeChore(
    { ...fields, id, title, cat: resolveCatId(state, p.cat) ?? defaultChoreCat(state), created: c.now, updated: c.now },
    c,
  );
  const tx = new Tx(state, c);
  tx.set('chores', id, ch);
  tx.log('add', id, ch.title, null, ch.every === 1 ? `daily x${ch.perDay}` : `every ${ch.every}d`);
  return tx.result();
}

export function editChore(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const ch = entry(state, 'chores', a.id);
  if (!ch || !isObj(a.patch)) return noop(state);
  const p = {};
  for (const k of CHORE_EDITABLE) {
    if (!(k in a.patch) || a.patch[k] === undefined) continue;
    const v = a.patch[k];
    if (k === 'title' && !(typeof v === 'string' && v.trim())) continue;
    if (k === 'cat') {
      const id = resolveCatId(state, v);
      if (id) p.cat = id;
      continue;
    }
    if (k === 'active') {
      const b = boolField(v);
      if (b !== UNSET) p.active = b;
      continue;
    }
    if (k === 'last') {
      const d = dateField(v, c.today);
      if (d !== UNSET) p.last = d;
      continue;
    }
    if (k === 'log' && !Array.isArray(v)) continue;
    if (k === 'notes' && typeof v !== 'string') continue;
    if ((k === 'every' || k === 'perDay' || k === 'min') && !isNum(v) && !(typeof v === 'string' && /^\s*\d+\s*$/.test(v))) continue;
    p[k] = k === 'every' || k === 'perDay' || k === 'min' ? Number(v) : k === 'title' ? v.trim() : v;
  }
  if (!Object.keys(p).length) return noop(state);
  const merged = { ...ch, ...p };
  // An explicitly cleared `last` falls back to the log's latest date (normalizeChore's rule).
  const n = normalizeChore(merged, c);
  const changed = changedFields(ch, n, [...Object.keys(p), 'perDay', 'last']);
  if (!Object.keys(changed).length) return noop(state);
  changed.updated = c.now;
  const tx = new Tx(state, c);
  tx.update('chores', ch.id, changed);
  tx.log('edit', ch.id, n.title, null, Object.keys(changed).filter((k) => k !== 'updated').join(','));
  return tx.result();
}

export function deleteChore(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const ch = entry(state, 'chores', obj(args).id);
  if (!ch) return noop(state);
  const tx = new Tx(state, c);
  tx.push({ op: 'delete', col: 'chores', id: ch.id });
  tx.log('delete', ch.id, ch.title);
  return tx.result();
}

// ---------------------------------------------------------------- categories

/** Exact (not prefix, not alias) match on id or name. */
function exactCategory(state, name) {
  const q = String(name ?? '').replace(/^\s*#+/, '').trim().toLowerCase();
  if (!q) return null;
  return (
    Object.values(obj(state?.cats)).find(
      (x) => isObj(x) && (String(x.id).toLowerCase() === q || String(x.name ?? '').trim().toLowerCase() === q),
    ) ?? null
  );
}

/** New category with a unique slug id and a color far from the others. A category with that exact id/name → no-op. */
export function addCategory(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const name = str(a.name).replace(/^\s*#+/, '').trim();
  if (!name || exactCategory(state, name)) return noop(state);
  const opts = { group: a.group, cats: state?.cats, now: c.now };
  if (typeof a.color === 'string') opts.color = a.color;
  if (Array.isArray(a.aliases)) opts.aliases = a.aliases;
  else if (typeof a.aliases === 'string' && a.aliases.trim()) opts.aliases = a.aliases.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof a.glyph === 'string' && a.glyph.trim()) opts.glyph = a.glyph;
  if (typeof a.note === 'string') opts.note = a.note;
  const cat = makeCategory(name, opts);
  const tx = new Tx(state, c);
  tx.set('cats', cat.id, cat);
  tx.log('cat', cat.id, cat.name, null, 'new');
  return tx.result();
}

const CAT_EDITABLE = ['name', 'color', 'group', 'glyph', 'aliases', 'archived', 'note'];

/** Edit name/color/group/glyph/aliases/archived/note. Never the id. The inbox can't be archived. */
export function editCategory(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const cat = entry(state, 'cats', a.id);
  if (!cat || !isObj(a.patch)) return noop(state);
  const p = {};
  for (const k of CAT_EDITABLE) {
    if (!(k in a.patch) || a.patch[k] === undefined) continue;
    const v = a.patch[k];
    if (k === 'name' && typeof v === 'string' && v.trim()) p.name = v.trim();
    else if (k === 'color' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) p.color = v.trim().toLowerCase();
    else if (k === 'group' && GROUPS.some((g) => g.id === v)) p.group = v;
    else if (k === 'glyph' && typeof v === 'string' && v.trim()) p.glyph = v.trim();
    else if (k === 'aliases' && Array.isArray(v)) p.aliases = v;
    else if (k === 'aliases' && typeof v === 'string') p.aliases = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'archived') {
      const b = boolField(v);
      if (b !== UNSET && !(b && cat.id === 'inbox')) p.archived = b;
    } else if (k === 'note' && (typeof v === 'string' || v === null)) p.note = v ?? '';
  }
  if (!Object.keys(p).length) return noop(state);
  const n = normalizeCategory({ ...cat, ...p, id: cat.id }, c);
  const changed = changedFields(cat, n, Object.keys(p));
  if (!Object.keys(changed).length) return noop(state);
  const tx = new Tx(state, c);
  tx.update('cats', cat.id, changed);
  tx.log('cat', cat.id, n.name, null, Object.keys(changed).join(','));
  return tx.result();
}

// ---------------------------------------------------------------- projects

const PROJECT_EDITABLE = ['name', 'cat', 'kind', 'status', 'due', 'goal', 'milestones', 'weeklyHours', 'notes', 'order'];

function coerceProjectFields(state, raw, today) {
  const out = {};
  for (const k of PROJECT_EDITABLE) {
    if (!(k in raw) || raw[k] === undefined) continue;
    const v = raw[k];
    if (k === 'name') {
      if (typeof v === 'string' && v.trim()) out.name = v.trim();
    } else if (k === 'cat') {
      const id = resolveCatId(state, v);
      if (id) out.cat = id;
    } else if (k === 'due') {
      const d = dateField(v, today);
      if (d !== UNSET) out.due = d;
    } else if (k === 'milestones') {
      if (Array.isArray(v)) out.milestones = v;
    } else if (k === 'weeklyHours') {
      if (v === null || isNum(v)) out.weeklyHours = v;
    } else if (k === 'order') {
      if (isNum(v)) out.order = v;
    } else if (k === 'goal' || k === 'notes') {
      if (typeof v === 'string' || v === null) out[k] = v ?? '';
    } else {
      out[k] = v; // kind, status: normalizeProject validates
    }
  }
  return out;
}

export function addProject(state, partial = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const p = obj(partial);
  const name = str(p.name).trim();
  if (!name) return noop(state);
  const id = freshId(state?.projects, p.id, 'p_');
  const fields = coerceProjectFields(state, p, c.today);
  const proj = normalizeProject({ ...fields, id, name, cat: fields.cat ?? 'inbox', created: c.now, updated: c.now }, c);
  const tx = new Tx(state, c);
  tx.set('projects', id, proj);
  tx.log('add', id, proj.name);
  return tx.result();
}

export function editProject(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const proj = entry(state, 'projects', a.id);
  if (!proj || !isObj(a.patch)) return noop(state);
  const p = coerceProjectFields(state, a.patch, c.today);
  if (!Object.keys(p).length) return noop(state);
  const n = normalizeProject({ ...proj, ...p, id: proj.id }, c);
  const changed = changedFields(proj, n, Object.keys(p));
  if (!Object.keys(changed).length) return noop(state);
  changed.updated = c.now;
  const tx = new Tx(state, c);
  tx.update('projects', proj.id, changed);
  tx.log('edit', proj.id, n.name, null, Object.keys(changed).filter((k) => k !== 'updated').join(','));
  return tx.result();
}

export function toggleMilestone(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const proj = entry(state, 'projects', a.id);
  const ms = Array.isArray(proj?.milestones) ? proj.milestones : [];
  const m = ms.find((x) => isObj(x) && x.id === a.msId);
  if (!proj || !m) return noop(state);
  const done = m.done !== true;
  const milestones = ms.map((x) => (x === m ? { ...x, done, doneAt: done ? c.now : null } : x));
  const tx = new Tx(state, c);
  tx.update('projects', proj.id, { milestones, updated: c.now });
  tx.log('milestone', proj.id, `${proj.name} / ${m.t}`, null, done ? 'done' : 'todo');
  return tx.result();
}

export function addMilestone(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const a = obj(args);
  const proj = entry(state, 'projects', a.id);
  const text = str(a.t).trim();
  if (!proj || !text) return noop(state);
  const ms = Array.isArray(proj.milestones) ? proj.milestones : [];
  const due = dateField(a.due ?? null, c.today);
  const m = { id: nextLocalId(ms, 'm'), t: text, due: due === UNSET ? null : due, done: false, doneAt: null };
  const tx = new Tx(state, c);
  tx.update('projects', proj.id, { milestones: [...ms, m], updated: c.now });
  tx.log('milestone', proj.id, `${proj.name} / ${text}`, null, 'added');
  return tx.result();
}

// ---------------------------------------------------------------- planning, brief, settings

/** Apply schedule.allocate() output: `updates[taskId]` is the task's full new blocks array. */
export function applyAllocation(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const updates = obj(obj(args).updates);
  const tx = new Tx(state, c);
  const touched = [];
  for (const [id, blocks] of Object.entries(updates)) {
    const t = entry(state, 'tasks', id);
    if (!t || !Array.isArray(blocks)) continue;
    const next = normalizeTask({ ...t, blocks }, c).blocks;
    if (sameJSON(next, t.blocks ?? [])) continue;
    tx.update('tasks', id, { blocks: next, updated: c.now });
    touched.push(t);
  }
  if (!touched.length) return noop(state);
  if (touched.length === 1) tx.log('block', touched[0].id, touched[0].title, null, 'planned');
  else tx.log('block', null, `Auto-plan: ${touched.length} tasks`, null, 'planned');
  return tx.result();
}

/** Store Claude's check-in for the website (stamped with ctx.now). Not an activity: it's not something Danny did. */
export function setBrief(state, brief = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const data = normalizeBrief({ ...obj(brief), at: c.now });
  const tx = new Tx(state, c);
  tx.meta('brief', data);
  return tx.result();
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merge a settings patch (cap merges per weekday) through normalizeSettings. */
export function editSettings(state, args = {}, ctx = {}) {
  const c = ctxOf(state, ctx);
  const patch = { ...obj(obj(args).patch) };
  if ('tz' in patch && !validTz(patch.tz)) delete patch.tz;
  if (!Object.keys(patch).length) return noop(state);
  const cur = obj(state?.settings);
  const merged = { ...cur, ...patch, cap: { ...obj(cur.cap), ...obj(patch.cap) } };
  const n = normalizeSettings(merged);
  const keys = Object.keys(n).filter((k) => !sameJSON(n[k], cur[k]));
  if (!keys.length) return noop(state);
  const tx = new Tx(state, c);
  tx.meta('settings', n);
  tx.log('settings', null, 'Settings', null, keys.join(','));
  return tx.result();
}

// ---------------------------------------------------------------- registry

export const OPS = {
  addTask,
  completeTask,
  reopenTask,
  dropTask,
  deleteTask,
  moveTask,
  moveBlock,
  toggleBlock,
  editTask,
  toggleSub,
  addSub,
  removeSub,
  clockIn,
  clockOut,
  logTime,
  choreDone,
  addChore,
  editChore,
  deleteChore,
  addCategory,
  editCategory,
  addProject,
  editProject,
  toggleMilestone,
  addMilestone,
  applyAllocation,
  setBrief,
  editSettings,
};
