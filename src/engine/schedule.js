// Capacity, day load, risk detection and auto-planning of multi-day work blocks.
// Pure: no DOM, no Node APIs, never mutates its inputs. See docs/ARCHITECTURE.md.

import { addDays, diffDays, dowKey, fmtDay, fmtMinutes, isISODate, rangeDays, todayISO, localDateOf, localTimeOf } from './dates.js';
import { DEFAULT_SETTINGS, makeId, normalizeCapOverrides } from './model.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (isNum(v) ? v : d);

const ESTIMATE_KINDS = new Set(['writing', 'analysis', 'deadline']);
const ESTIMATE_TITLE_RE = /\b(presentations?|manuscripts?|papers?|posters?|exams?|talks?|workshops?|thesis|theses)\b/i;

// Capacity is a soft guide: only flag a day that is clearly over (Danny asked for
// light-touch planning). settings.overbookAt overrides this.
const OVERBOOK_FACTOR = 1.35;
const OVERBOOK_DAYS = 14;
const ESTIMATE_WINDOW_DAYS = 21;

// ---------------------------------------------------------------- small shared helpers

/** Settings with every field present and sane (defaults fill gaps; minBlock ≤ maxBlock). */
function settingsFrom(raw) {
  const p = isObj(raw) ? raw : {};
  const cap = { ...DEFAULT_SETTINGS.cap };
  if (isObj(p.cap)) {
    for (const k of Object.keys(cap)) if (isNum(p.cap[k])) cap[k] = Math.max(0, Math.round(p.cap[k]));
  }
  const maxBlock = isNum(p.maxBlock) && p.maxBlock > 0 ? Math.round(p.maxBlock) : DEFAULT_SETTINGS.maxBlock;
  const minBlockRaw = isNum(p.minBlock) && p.minBlock > 0 ? Math.round(p.minBlock) : DEFAULT_SETTINGS.minBlock;
  return {
    tz: typeof p.tz === 'string' && p.tz ? p.tz : DEFAULT_SETTINGS.tz,
    weekStart: p.weekStart === 'sun' ? 'sun' : 'mon',
    cap,
    maxBlock,
    minBlock: Math.min(minBlockRaw, maxBlock),
    prefBlock: Math.min(maxBlock, Math.max(Math.min(minBlockRaw, maxBlock), isNum(p.prefBlock) && p.prefBlock > 0 ? Math.round(p.prefBlock) : DEFAULT_SETTINGS.prefBlock)),
    defaultEst: isNum(p.defaultEst) && p.defaultEst >= 0 ? Math.round(p.defaultEst) : DEFAULT_SETTINGS.defaultEst,
    horizon: isNum(p.horizon) && p.horizon > 0 ? Math.round(p.horizon) : DEFAULT_SETTINGS.horizon,
    offDays: Array.isArray(p.offDays) ? p.offDays.filter(isISODate) : [],
    capOverrides: normalizeCapOverrides(p.capOverrides),
  };
}

function taskList(state) {
  const coll = state?.tasks;
  const list = Array.isArray(coll) ? coll : isObj(coll) ? Object.values(coll) : [];
  return list.filter(isObj);
}

const isOpen = (t) => (t.status ?? 'todo') === 'todo';
const hasEst = (t) => isNum(t.est);
const dateOr = (v) => (isISODate(v) ? v : null);

/** Valid blocks of a task (d is a real date, m > 0). Returned objects are the originals. */
function blocksOf(task) {
  if (!isObj(task) || !Array.isArray(task.blocks)) return [];
  return task.blocks.filter((b) => isObj(b) && isISODate(b.d) && num(b.m) > 0);
}

const MEETING_KINDS = new Set(['meeting', 'appt']);

/**
 * An open meeting/appointment whose day (plan, else due) is before `today` and
 * that has no deadline still ahead: it either happened or it didn't, so it is a
 * "did it happen?" (triage) item, never carried-over or overdue work.
 */
export function isPastEvent(task, today) {
  if (!isObj(task) || !MEETING_KINDS.has(task.kind) || !isOpen(task) || !isISODate(today)) return false;
  const due = dateOr(task.due);
  const day = dateOr(task.plan) ?? due;
  return !!day && day < today && !(due && due >= today);
}

const isUndone = (b) => b.done !== true;
const isAuto = (b) => b.auto !== false;
const blockMin = (b) => Math.max(0, Math.round(num(b.m)));

/** EDF order: due asc, prio desc, created asc, id asc. */
function byDeadline(a, b) {
  const da = dateOr(a.due) ?? '9999-12-31';
  const db = dateOr(b.due) ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  const pa = num(a.prio, 1);
  const pb = num(b.prio, 1);
  if (pa !== pb) return pb - pa;
  const ca = String(a.created ?? '');
  const cb = String(b.created ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = String(a.id ?? '');
  const ib = String(b.id ?? '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// ---------------------------------------------------------------- capacity + remaining work

/** Focus minutes available for to-dos on `iso`: 0 on offDays or invalid dates, else settings.capOverrides[iso], else the weekday cap. */
export function capacityFor(settings, iso) {
  if (!isISODate(iso)) return 0;
  const s = isObj(settings) ? settings : {};
  if (Array.isArray(s.offDays) && s.offDays.includes(iso)) return 0;
  // One-day override ("less time tomorrow": ef settings --cap-on tomorrow=90).
  const o = isObj(s.capOverrides) ? s.capOverrides[iso] : undefined;
  if (isNum(o)) return Math.max(0, Math.round(o));
  const key = dowKey(iso);
  const v = isObj(s.cap) && isNum(s.cap[key]) ? s.cap[key] : DEFAULT_SETTINGS.cap[key];
  return Math.max(0, Math.round(v));
}

/** max(0, (est ?? 0) − spent) in minutes. */
export function remaining(task) {
  if (!isObj(task)) return 0;
  return Math.max(0, Math.round(num(task.est, 0) - num(task.spent, 0)));
}

/** Σ m over undone blocks with d >= today. */
export function allocatedFuture(task, today) {
  let sum = 0;
  for (const b of blocksOf(task)) if (isUndone(b) && b.d >= today) sum += blockMin(b);
  return sum;
}

/** remaining − allocatedFuture; null when the task has no estimate. Negative = more time blocked than needed. */
export function shortfall(task, today) {
  if (!isObj(task) || !hasEst(task)) return null;
  return remaining(task) - allocatedFuture(task, today);
}

// ---------------------------------------------------------------- load

/**
 * Where one open task puts load: its undone blocks by day, or (when it has no
 * undone blocks) its remaining estimate on its plan day. Map<d, minutes>.
 */
function ownLoad(task, s) {
  const out = new Map();
  if (!isOpen(task)) return out;
  const undone = blocksOf(task).filter(isUndone);
  if (undone.length) {
    for (const b of undone) out.set(b.d, (out.get(b.d) ?? 0) + blockMin(b));
  } else if (dateOr(task.plan)) {
    const est = hasEst(task) ? task.est : s.defaultEst;
    const m = Math.max(0, Math.round(est - num(task.spent, 0)));
    if (m > 0) out.set(task.plan, m);
  }
  return out;
}

/** Map<d, { planned, blocks }> over all open tasks. */
function buildLoadIndex(state, s) {
  const idx = new Map();
  for (const t of taskList(state)) {
    if (!isOpen(t)) continue;
    const undone = blocksOf(t).some(isUndone);
    for (const [d, m] of ownLoad(t, s)) {
      const e = idx.get(d) ?? { planned: 0, blocks: 0 };
      if (undone) e.blocks += m;
      else e.planned += m;
      idx.set(d, e);
    }
  }
  return idx;
}

function loadFromIndex(idx, s, iso) {
  const e = idx.get(iso);
  const planned = e?.planned ?? 0;
  const blocks = e?.blocks ?? 0;
  const total = planned + blocks;
  const cap = capacityFor(s, iso);
  return {
    d: iso,
    planned,
    blocks,
    total,
    cap,
    free: Math.max(0, cap - total),
    ratio: cap > 0 ? total / cap : total > 0 ? Infinity : 0,
  };
}

/**
 * Load on one day: `planned` = remaining est (est ?? defaultEst, minus spent) of open
 * tasks planned that day that have no undone blocks; `blocks` = undone block minutes.
 * `ratio` is total / cap (Infinity when cap is 0 and something is scheduled).
 */
export function dayLoad(state, iso) {
  const s = settingsFrom(state?.settings);
  return loadFromIndex(buildLoadIndex(state, s), s, iso);
}

/** dayLoad for many days at once (one pass over tasks). */
export function dayLoads(state, isoList = []) {
  const s = settingsFrom(state?.settings);
  const idx = buildLoadIndex(state, s);
  return (Array.isArray(isoList) ? isoList : []).map((d) => loadFromIndex(idx, s, d));
}

/** Days a task could still be worked on before its deadline: today … due−1, or [today] when due is today. */
function daysBeforeDue(due, today) {
  return due > today ? rangeDays(today, diffDays(today, due)) : [today];
}

function runwayFromIndex(idx, s, task, today) {
  const due = dateOr(task?.due);
  const rem = remaining(task);
  if (!due || due < today) return { available: 0, deficit: rem };
  const own = ownLoad(task, s);
  let available = 0;
  for (const d of daysBeforeDue(due, today)) {
    const e = idx.get(d);
    const others = (e?.planned ?? 0) + (e?.blocks ?? 0) - (own.get(d) ?? 0);
    available += Math.max(0, capacityFor(s, d) - others);
  }
  // Blocks already sitting on the due day itself still cover work.
  let onDueDay = 0;
  if (due > today) for (const b of blocksOf(task)) if (isUndone(b) && b.d === due) onDueDay += blockMin(b);
  return { available, deficit: Math.max(0, rem - onDueDay - available) };
}

/**
 * Runway of one task before its deadline:
 * `available` = free focus minutes between today and due (today inclusive, due
 * exclusive unless due is today), not counting the task's own blocks/plan load;
 * `deficit` = remaining minutes that cannot fit there (0 = feasible). Overdue or
 * undated tasks: available 0, deficit = remaining.
 */
export function runway(state, task, today) {
  return makeRunway(state, today)(task);
}

/** runway() for many tasks against one snapshot of the load: returns (task) => { available, deficit }. */
export function makeRunway(state, today) {
  const s = settingsFrom(state?.settings);
  const t0 = isISODate(today) ? today : todayISO(s.tz);
  const idx = buildLoadIndex(state, s);
  return (task) => runwayFromIndex(idx, s, task, t0);
}

// ---------------------------------------------------------------- risk messages

function overdueRisk(t, today) {
  const late = diffDays(t.due, today);
  const rem = hasEst(t) ? remaining(t) : null;
  const left = rem ? `, ${fmtMinutes(rem)} of work left` : '';
  return {
    type: 'crunch',
    taskId: t.id,
    d: t.due,
    minutes: rem,
    overdue: true,
    message: `${t.title} is overdue (was due ${fmtDay(t.due)}, ${late}d ago)${left}`,
  };
}

const byWhen = (due, today) => (due === today ? 'today' : `before ${fmtDay(due)}`);

function crunchRisk(t, rem, avail, deficit, today) {
  return {
    type: 'crunch',
    taskId: t.id,
    d: t.due,
    minutes: deficit,
    message: `${t.title} needs ${fmtMinutes(rem)} but only ${fmtMinutes(avail)} is free ${byWhen(t.due, today)}`,
  };
}

function underRisk(t, minutes, today, why) {
  const tail = why === 'full' ? `won't fit ${byWhen(t.due, today)}` : `not blocked out ${byWhen(t.due, today)}`;
  return {
    type: 'under-allocated',
    taskId: t.id,
    d: t.due,
    minutes,
    message: `${t.title}: ${fmtMinutes(minutes)} ${tail}`,
  };
}

function needsEstimate(t) {
  return ESTIMATE_KINDS.has(t.kind) || !!t.project || ESTIMATE_TITLE_RE.test(String(t.title ?? ''));
}

// ---------------------------------------------------------------- risks

const RISK_ORDER = { crunch: 0, 'under-allocated': 1, overbooked: 2, 'needs-estimate': 3 };

/**
 * Everything that is going to bite: overdue + infeasible work (crunch), work not
 * blocked out (under-allocated), overbooked days in the next 14 days, and
 * deadline-ish tasks with no estimate. Triage tasks and past meetings /
 * appointments (isPastEvent: "did it happen?", not late work) are skipped.
 */
export function risks(state, today) {
  const s = settingsFrom(state?.settings);
  const t0 = isISODate(today) ? today : todayISO(s.tz);
  const idx = buildLoadIndex(state, s);
  const out = [];

  for (const t of taskList(state)) {
    if (!isOpen(t) || t.triage === true || isPastEvent(t, t0)) continue;
    const due = dateOr(t.due);
    if (!due) continue;
    if (due < t0) {
      out.push(overdueRisk(t, t0));
      continue;
    }
    if (hasEst(t)) {
      const rem = remaining(t);
      if (rem <= 0) continue;
      const { available, deficit } = runwayFromIndex(idx, s, t, t0);
      if (deficit > 0) {
        out.push(crunchRisk(t, rem, available, deficit, t0));
        continue;
      }
      // Single-sitting tasks are covered by their plan chip; block-managed work
      // (has blocks, or is bigger than one block) must be blocked out in full.
      const gap = rem - allocatedFuture(t, t0);
      const blockManaged = blocksOf(t).some((b) => isUndone(b) && b.d >= t0) || rem > s.maxBlock;
      if (gap > 0 && blockManaged) out.push(underRisk(t, gap, t0, 'gap'));
    } else if (diffDays(t0, due) <= ESTIMATE_WINDOW_DAYS && needsEstimate(t)) {
      out.push({
        type: 'needs-estimate',
        taskId: t.id,
        d: due,
        message: `${t.title} (due ${fmtDay(due)}) needs a time estimate`,
      });
    }
  }

  for (const d of rangeDays(t0, OVERBOOK_DAYS)) {
    const l = loadFromIndex(idx, s, d);
    const factor = isNum(state?.settings?.overbookAt) && state.settings.overbookAt >= 1 ? state.settings.overbookAt : OVERBOOK_FACTOR;
    if (l.cap > 0 && l.total > l.cap * factor) {
      out.push({
        type: 'overbooked',
        d,
        minutes: l.total - l.cap,
        message: `${fmtDay(d)} looks packed: ${fmtMinutes(l.total)} planned vs ~${fmtMinutes(l.cap)}`,
      });
    }
  }

  return out
    .map((r, i) => [r, i])
    .sort(([a, ia], [b, ib]) => {
      const ta = RISK_ORDER[a.type] - RISK_ORDER[b.type];
      if (ta) return ta;
      if (a.type === 'crunch' && !!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      const da = a.d ?? '';
      const db = b.d ?? '';
      if (da !== db) return da < db ? -1 : 1;
      return ia - ib;
    })
    .map(([r]) => r);
}

// ---------------------------------------------------------------- allocate

/**
 * First day auto-planning should use: today, or tomorrow once it's 5pm or later
 * in the settings timezone (the rest of today is not real focus time).
 */
export function planStart(nowIso, tz = DEFAULT_SETTINGS.tz) {
  const today = localDateOf(nowIso, tz);
  if (!today) return todayISO(tz);
  const hhmm = localTimeOf(nowIso, tz) ?? '00:00';
  return hhmm >= '17:00' ? addDays(today, 1) : today;
}

/** Window of days to place blocks in: max(today, from, plan) … due−1, or the due day alone if that is empty. */
function windowFor(t, today, from) {
  const plan = dateOr(t.plan);
  let start = plan && plan > today ? plan : today;
  if (from && from > start) start = from;
  const end = addDays(t.due, -1);
  if (start > end) return [t.due];
  return rangeDays(start, diffDays(start, end) + 1);
}

const blockKey = (b) => `${b.id}|${b.d}|${blockMin(b)}|${b.done === true}|${b.auto !== false}`;

function sameBlocks(original, next) {
  const a = (Array.isArray(original) ? original : []).filter(isObj).map(blockKey).sort();
  const b = next.map(blockKey).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Auto-plan work blocks for open tasks that have an estimate and a deadline.
 *
 * opts: { today, taskIds?, replan = true, from? }
 *  - from: earliest day to place new blocks (e.g. planStart(now) = tomorrow after 5pm).
 *  - taskIds limits the run to those tasks (others' blocks count as load).
 *  - replan: undone auto blocks of the tasks in this run are removed and placed
 *    again (their ids are reused on the same day so unchanged plans produce no
 *    update). replan:false keeps every block and only adds the shortfall.
 *  - Done blocks and auto:false (manual) blocks are never touched; manual undone
 *    blocks on/after today count toward what is already allocated.
 *  - Overdue tasks get no blocks; they come back as `crunch` risks.
 *
 * Returns { updates: { [taskId]: Block[] (the full new array) }, risks: Risk[] }.
 * Only tasks whose blocks actually change appear in `updates`.
 */
export function allocate(state, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const s = settingsFrom(state?.settings);
  const today = isISODate(o.today) ? o.today : todayISO(s.tz);
  const replan = o.replan !== false;
  const from = isISODate(o.from) && o.from > today ? o.from : null;
  const ids = typeof o.taskIds === 'string' ? [o.taskIds] : o.taskIds;
  const only = Array.isArray(ids) ? new Set(ids) : null;

  const open = taskList(state).filter(isOpen);
  const scoped = open.filter(
    (t) => (!only || only.has(t.id)) && hasEst(t) && dateOr(t.due) && remaining(t) > 0 && !isPastEvent(t, today),
  );
  const outRisks = scoped
    .filter((t) => t.due < today)
    .sort(byDeadline)
    .map((t) => overdueRisk(t, today));
  const cands = scoped.filter((t) => t.due >= today).sort(byDeadline);
  const candIds = new Set(cands.map((t) => t.id));

  // Blocks each candidate keeps going into the run.
  const work = new Map();
  for (const t of cands) {
    const blocks = blocksOf(t);
    const protectedBlock = (b) => !isUndone(b) || !isAuto(b);
    work.set(t.id, {
      kept: replan ? blocks.filter(protectedBlock).map((b) => ({ ...b })) : blocks.map((b) => ({ ...b })),
      removed: replan ? blocks.filter((b) => !protectedBlock(b)) : [],
    });
  }

  // Load before placing anything: everyone else as-is, candidates only via kept undone blocks.
  const load = new Map();
  const addLoad = (d, m) => load.set(d, (load.get(d) ?? 0) + m);
  for (const t of open) {
    if (candIds.has(t.id)) {
      for (const b of work.get(t.id).kept) if (isUndone(b)) addLoad(b.d, blockMin(b));
    } else {
      for (const [d, m] of ownLoad(t, s)) addLoad(d, m);
    }
  }

  const updates = {};
  for (const t of cands) {
    const { kept, removed } = work.get(t.id);
    const keptOnDay = new Map();
    for (const b of kept) keptOnDay.set(b.d, (keptOnDay.get(b.d) ?? 0) + blockMin(b));
    const placed = new Map();

    let allocated = 0;
    for (const b of kept) if (isUndone(b) && b.d >= today) allocated += blockMin(b);
    let need = remaining(t) - allocated;

    if (need > 0) {
      const days = windowFor(t, today, from);
      const free = (d) => Math.max(0, capacityFor(s, d) - (load.get(d) ?? 0));
      const room = (d) => Math.max(0, s.maxBlock - (keptOnDay.get(d) ?? 0) - (placed.get(d) ?? 0));
      const fit = (d) => Math.min(free(d), room(d));
      const place = (d, m) => {
        placed.set(d, (placed.get(d) ?? 0) + m);
        addLoad(d, m);
        need -= m;
      };
      const hasAutoBlockOn = (d) => !replan && kept.some((b) => b.d === d && isUndone(b) && isAuto(b));

      // Pass 1: real sessions (>= prefBlock when the work allows), spaced evenly
      // across the window instead of a crumb on every day.
      const floor = Math.min(s.minBlock, need);
      const usableDays = days.filter((d) => fit(d) >= floor);
      const usable = usableDays.length;
      const target = Math.min(s.maxBlock, Math.max(s.minBlock, Math.min(s.prefBlock, need), Math.ceil(need / Math.max(1, usable))));
      const sessions = Math.max(1, Math.ceil(need / target));
      const spaced = sessions >= usable
        ? usableDays
        : Array.from({ length: sessions }, (_, i) => usableDays[Math.floor((i * usable) / sessions)]);
      for (const d of spaced) {
        if (need <= 0) break;
        const f = fit(d);
        let amt = Math.min(target, f, need);
        // Swallow a tail smaller than minBlock rather than leave a crumb block for later.
        if (need - amt > 0 && need - amt < s.minBlock && f >= need) amt = need;
        if (amt > 0 && (amt >= s.minBlock || amt === need)) place(d, amt);
      }
      // Pass 2: top up any day's free room (≤ maxBlock per task per day), earliest first.
      for (const d of days) {
        if (need <= 0) break;
        const amt = Math.min(fit(d), need);
        if (amt <= 0) continue;
        if (placed.has(d) || hasAutoBlockOn(d) || amt >= s.minBlock || amt === need) place(d, amt);
      }
      if (need > 0) outRisks.push(underRisk(t, need, today, 'full'));
    }

    // Assemble the new blocks array.
    const next = kept;
    const usedIds = new Set(next.map((b) => b.id));
    for (const [d, m] of [...placed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!replan) {
        const existing = next.find((b) => b.d === d && isUndone(b) && isAuto(b));
        if (existing) {
          existing.m = blockMin(existing) + m;
          continue;
        }
      }
      const reuse = removed.find((b) => b.d === d && !usedIds.has(b.id));
      let id = reuse ? reuse.id : makeId('b_');
      while (usedIds.has(id)) id = makeId('b_');
      usedIds.add(id);
      next.push({ id, d, m, done: false, auto: true });
    }
    next.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (!sameBlocks(t.blocks, next)) updates[t.id] = next;
  }

  return { updates, risks: outRisks };
}
