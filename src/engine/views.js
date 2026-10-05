// Read models for the website, the CLI and Claude's brief: Today, the rolling
// calendar, deadlines, backlog, projects and chores. Pure; never mutates state.
// See docs/ARCHITECTURE.md ("views.js").

import { addDays, diffDays, isISODate, isWeekend, localDateOf, rangeDays, todayISO } from './dates.js';
import { DEFAULT_SETTINGS } from './model.js';
import { allocatedFuture, capacityFor, dayLoads, makeRunway, remaining, shortfall } from './schedule.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (isNum(v) ? v : d);
const dateOr = (v) => (isISODate(v) ? v : null);

// localDateOf goes through Intl and is the hot spot once there are hundreds of
// completed tasks; memoize per (tz, timestamp). Deterministic, so still pure.
const localDayCache = new Map();
function localDay(iso, tz) {
  const key = `${tz}|${iso}`;
  let v = localDayCache.get(key);
  if (v === undefined) {
    v = localDateOf(iso, tz);
    if (localDayCache.size > 20000) localDayCache.clear();
    localDayCache.set(key, v);
  }
  return v;
}

const MEETING_KINDS = new Set(['meeting', 'appt']);

function list(coll) {
  const arr = Array.isArray(coll) ? coll : isObj(coll) ? Object.values(coll) : [];
  return arr.filter(isObj);
}
const taskList = (state) => list(state?.tasks);
const isOpen = (t) => (t.status ?? 'todo') === 'todo';
const isDone = (t) => t.status === 'done';
const tzOf = (state) => (typeof state?.settings?.tz === 'string' && state.settings.tz) || DEFAULT_SETTINGS.tz;
const todayFor = (state, today) => (isISODate(today) ? today : todayISO(tzOf(state)));
const settingsOf = (state) => (isObj(state?.settings) ? state.settings : DEFAULT_SETTINGS);

function blocksOf(task) {
  if (!Array.isArray(task?.blocks)) return [];
  return task.blocks.filter((b) => isObj(b) && isISODate(b.d) && num(b.m) > 0);
}
const undoneBlocks = (task) => blocksOf(task).filter((b) => b.done !== true);

/** Local calendar date a done task belongs to (null if not done / no timestamp). */
function doneDate(t, tz) {
  if (!isDone(t) || typeof t.doneAt !== 'string') return null;
  return localDay(t.doneAt, tz);
}

// ---------------------------------------------------------------- comparators

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const title = (t) => String(t.title ?? '').toLowerCase();
const prio = (t) => num(t.prio, 1);
/** Nulls last for "HH:MM" / ISO-date strings. */
const cmpNullable = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : cmpStr(a, b));

const byPrioTitle = (a, b) => prio(b) - prio(a) || cmpStr(title(a), title(b));
const byTimeTitle = (a, b) => cmpNullable(dateOrTime(a.time), dateOrTime(b.time)) || byPrioTitle(a, b);
const byPrioCreated = (a, b) =>
  prio(b) - prio(a) || cmpStr(String(a.created ?? ''), String(b.created ?? '')) || cmpStr(title(a), title(b));
function dateOrTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null;
}
const byDoneAtDesc = (a, b) => cmpStr(String(b.doneAt ?? ''), String(a.doneAt ?? '')) || cmpStr(title(a), title(b));
const byDoneAtAsc = (a, b) => cmpStr(String(a.doneAt ?? ''), String(b.doneAt ?? '')) || cmpStr(title(a), title(b));

// ---------------------------------------------------------------- chores

function choreInfo(c, today) {
  const every = Math.max(1, Math.round(num(c.every, 7)));
  const perDay = every === 1 ? Math.max(1, Math.round(num(c.perDay, 1))) : 1;
  const log = Array.isArray(c.log) ? c.log.filter(isISODate) : [];
  let last = dateOr(c.last);
  for (const d of log) if (d <= today && (!last || d > last)) last = d;
  const todayCount = log.filter((d) => d === today).length;
  const daysSince = last ? diffDays(last, today) : null;
  let due;
  let urgency;
  let nextDue;
  if (every === 1) {
    due = todayCount < perDay;
    urgency = Math.max(0, (perDay - todayCount) / perDay);
    nextDue = due ? today : addDays(today, 1);
  } else {
    due = last == null || daysSince >= every;
    urgency = last ? Math.max(0, daysSince / every) : 1;
    const raw = last ? addDays(last, every) : today;
    nextDue = raw < today ? today : raw;
  }
  return { chore: c, due, urgency, todayCount, daysSince, nextDue };
}

const activeChores = (state) => list(state?.chores).filter((c) => c.active !== false);

function byUrgency(a, b) {
  if (a.due !== b.due) return a.due ? -1 : 1;
  return b.urgency - a.urgency || cmpStr(String(a.chore.title ?? '').toLowerCase(), String(b.chore.title ?? '').toLowerCase());
}

/** Active chores with due flag, urgency, today's count, days since last, next due date. Most urgent first. */
export function choreView(state, today) {
  const t0 = todayFor(state, today);
  return activeChores(state).map((c) => choreInfo(c, t0)).sort(byUrgency);
}

// ---------------------------------------------------------------- today

/**
 * The Today list. A task lands in the first matching bucket of:
 * triage, overdue, dueToday, meetings, planned, carried. `blocks` is separate.
 * `chores` are the active chores due now (Chore objects, most urgent first).
 */
export function todayView(state, today) {
  const t0 = todayFor(state, today);
  const tz = tzOf(state);
  const out = { overdue: [], dueToday: [], meetings: [], planned: [], carried: [], triage: [] };
  const blocks = [];
  const doneToday = [];

  for (const t of taskList(state)) {
    if (isDone(t)) {
      if (doneDate(t, tz) === t0) doneToday.push(t);
      continue;
    }
    if (!isOpen(t)) continue;
    const due = dateOr(t.due);
    const plan = dateOr(t.plan);
    if (t.triage === true) out.triage.push(t);
    else if (due && due < t0) out.overdue.push(t);
    else if (due === t0) out.dueToday.push(t);
    else if (MEETING_KINDS.has(t.kind) && (plan === t0 || due === t0)) out.meetings.push(t);
    else if (plan === t0) out.planned.push(t);
    else if (plan && plan < t0 && (!due || due > t0)) out.carried.push(t);

    for (const b of undoneBlocks(t)) if (b.d === t0) blocks.push({ task: t, block: b });
  }

  out.triage.sort((a, b) => cmpNullable(dateOr(a.plan) ?? dateOr(a.due), dateOr(b.plan) ?? dateOr(b.due)) || byPrioTitle(a, b));
  out.overdue.sort((a, b) => cmpStr(a.due, b.due) || byPrioTitle(a, b));
  out.dueToday.sort((a, b) => cmpNullable(dateOrTime(a.time), dateOrTime(b.time)) || byPrioTitle(a, b));
  out.meetings.sort(byTimeTitle);
  out.planned.sort((a, b) => byPrioCreated(a, b));
  out.carried.sort((a, b) => prio(b) - prio(a) || cmpStr(a.plan, b.plan) || cmpStr(title(a), title(b)));
  blocks.sort((a, b) => byPrioTitle(a.task, b.task) || cmpStr(String(a.block.id), String(b.block.id)));
  doneToday.sort(byDoneAtDesc);

  const chores = activeChores(state)
    .map((c) => choreInfo(c, t0))
    .filter((x) => x.due)
    .sort(byUrgency)
    .map((x) => x.chore);

  const openIds = new Set();
  for (const k of ['triage', 'overdue', 'dueToday', 'meetings', 'planned', 'carried']) for (const t of out[k]) openIds.add(t.id);
  for (const { task } of blocks) openIds.add(task.id);

  return {
    overdue: out.overdue,
    dueToday: out.dueToday,
    meetings: out.meetings,
    planned: out.planned,
    carried: out.carried,
    blocks,
    triage: out.triage,
    chores,
    doneToday,
    counts: { open: openIds.size, done: doneToday.length, total: openIds.size + doneToday.length },
  };
}

// ---------------------------------------------------------------- calendar

/**
 * Rolling calendar of `days` days from `start`. Per day: deadline pins, meetings
 * (by time), plan chips, then undone block chips; chores scheduled that day
 * (daily chores every day; others on their next due date and every `every`
 * days after; overdue ones on today); and tasks completed that day.
 * `today` (optional, defaults to the clock in the settings tz) drives isToday/isPast.
 */
export function calendarView(state, start, days = 14, today) {
  const t0 = todayFor(state, today);
  const first = isISODate(start) ? start : t0;
  const n = isNum(days) && days > 0 ? Math.min(Math.round(days), 366) : 14;
  const dayList = rangeDays(first, n);
  const last = dayList[dayList.length - 1];
  const tz = tzOf(state);
  const settings = settingsOf(state);

  const cells = new Map();
  for (const d of dayList) cells.set(d, { due: [], meeting: [], plan: [], block: [], chores: [], done: [] });

  for (const t of taskList(state)) {
    if (isDone(t)) {
      const dd = doneDate(t, tz);
      if (dd && dd <= t0 && cells.has(dd)) cells.get(dd).done.push(t);
      continue;
    }
    if (!isOpen(t)) continue;
    const due = dateOr(t.due);
    const plan = dateOr(t.plan);
    if (MEETING_KINDS.has(t.kind)) {
      const meetDay = plan ?? due;
      if (meetDay && cells.has(meetDay)) cells.get(meetDay).meeting.push({ type: 'meeting', task: t });
      if (due && due !== meetDay && cells.has(due)) cells.get(due).due.push({ type: 'due', task: t });
    } else {
      if (due && cells.has(due)) cells.get(due).due.push({ type: 'due', task: t });
      if (plan && plan !== due && cells.has(plan)) cells.get(plan).plan.push({ type: 'plan', task: t });
    }
    for (const b of undoneBlocks(t)) if (cells.has(b.d)) cells.get(b.d).block.push({ type: 'block', task: t, block: b });
  }

  for (const c of activeChores(state)) {
    const info = choreInfo(c, t0);
    const every = Math.max(1, Math.round(num(c.every, 7)));
    if (every === 1) {
      for (const d of dayList) if (d >= t0) cells.get(d).chores.push(c);
      continue;
    }
    for (let d = info.nextDue; d <= last; d = addDays(d, every)) if (d >= first && cells.has(d)) cells.get(d).chores.push(c);
  }

  const loads = dayLoads(state, dayList);
  const byItem = (cmp) => (a, b) => cmp(a.task, b.task);
  return dayList.map((d, i) => {
    const c = cells.get(d);
    c.due.sort(byItem(byPrioTitle));
    c.meeting.sort(byItem(byTimeTitle));
    c.plan.sort(byItem(byPrioTitle));
    c.block.sort((a, b) => byPrioTitle(a.task, b.task) || cmpStr(String(a.block.id), String(b.block.id)));
    c.chores.sort((a, b) => num(a.every, 7) - num(b.every, 7) || cmpStr(String(a.title ?? '').toLowerCase(), String(b.title ?? '').toLowerCase()));
    c.done.sort(byDoneAtAsc);
    return {
      d,
      isToday: d === t0,
      isPast: d < t0,
      isWeekend: isWeekend(d),
      isOff: capacityFor(settings, d) === 0,
      load: loads[i],
      items: [...c.due, ...c.meeting, ...c.plan, ...c.block],
      chores: c.chores,
      done: c.done,
    };
  });
}

// ---------------------------------------------------------------- deadlines

/**
 * Open tasks due between today and today + days, soonest first, with runway status:
 * no-estimate | ok | at-risk (free time before due can't cover it) | unplanned
 * (nothing blocked and no plan date) | tight (not fully blocked, but there is room).
 * A small task with a plan date on/before its due and no blocks is "ok" when it fits
 * in one sitting (remaining ≤ maxBlock): its plan chip is its allocation.
 */
export function upcomingDeadlines(state, today, days = 30) {
  const t0 = todayFor(state, today);
  const horizon = addDays(t0, isNum(days) && days >= 0 ? Math.round(days) : 30);
  const maxBlock = num(settingsOf(state).maxBlock, DEFAULT_SETTINGS.maxBlock);
  const runwayOf = makeRunway(state, t0);
  const out = [];
  for (const t of taskList(state)) {
    if (!isOpen(t)) continue;
    const due = dateOr(t.due);
    if (!due || due < t0 || due > horizon) continue;
    const rem = remaining(t);
    const allocated = allocatedFuture(t, t0);
    const gap = shortfall(t, t0);
    let status;
    if (!isNum(t.est)) status = 'no-estimate';
    else if (gap <= 0) status = 'ok';
    else {
      const hasBlocks = undoneBlocks(t).length > 0;
      const plan = dateOr(t.plan);
      if (!hasBlocks && plan && plan <= due && rem <= maxBlock) status = 'ok';
      else if (runwayOf(t).deficit > 0) status = 'at-risk';
      else if (!hasBlocks && !plan) status = 'unplanned';
      else status = 'tight';
    }
    out.push({ task: t, daysLeft: diffDays(t0, due), remaining: rem, allocated, shortfall: gap, status });
  }
  return out.sort((a, b) => cmpStr(a.task.due, b.task.due) || byPrioTitle(a.task, b.task));
}

// ---------------------------------------------------------------- backlog

/** Open tasks with no plan, no due, no undone blocks, not triage. Highest prio, then newest first. */
export function backlog(state) {
  return taskList(state)
    .filter((t) => isOpen(t) && t.triage !== true && !dateOr(t.plan) && !dateOr(t.due) && undoneBlocks(t).length === 0)
    .sort((a, b) => prio(b) - prio(a) || cmpStr(String(b.created ?? ''), String(a.created ?? '')) || cmpStr(title(a), title(b)));
}

// ---------------------------------------------------------------- projects

/**
 * Active then paused projects with progress. pct counts milestones and linked
 * tasks (done / total, dropped tasks ignored). Within a status: nearest of
 * project due / next milestone due first, then `order`, then name.
 */
export function projectView(state, today) {
  const t0 = todayFor(state, today);
  const tasks = taskList(state);
  const rows = [];
  for (const p of list(state?.projects)) {
    if (p.status !== 'active' && p.status !== 'paused') continue;
    const ms = Array.isArray(p.milestones) ? p.milestones.filter(isObj) : [];
    const msDone = ms.filter((m) => m.done === true).length;
    const linked = tasks.filter((t) => t.project === p.id);
    const open = linked.filter(isOpen);
    const tasksDone = linked.filter(isDone).length;
    const denom = ms.length + open.length + tasksDone;
    const nextMilestone =
      ms
        .map((m, i) => [m, i])
        .filter(([m]) => m.done !== true)
        .sort(([a, ia], [b, ib]) => cmpStr(dateOr(a.due) ?? '9999', dateOr(b.due) ?? '9999') || ia - ib)
        .map(([m]) => m)[0] ?? null;
    rows.push({
      project: p,
      pct: denom ? Math.round((100 * (msDone + tasksDone)) / denom) : 0,
      msDone,
      msTotal: ms.length,
      tasksOpen: open.length,
      tasksDone,
      nextMilestone,
      remainingMin: open.reduce((s, t) => s + remaining(t), 0),
      allocatedMin: open.reduce((s, t) => s + allocatedFuture(t, t0), 0),
    });
  }
  const soonest = (r) => {
    const ds = [dateOr(r.project.due), dateOr(r.nextMilestone?.due)].filter(Boolean).sort();
    return ds[0] ?? '9999-12-31';
  };
  return rows.sort(
    (a, b) =>
      (a.project.status === 'active' ? 0 : 1) - (b.project.status === 'active' ? 0 : 1) ||
      cmpStr(soonest(a), soonest(b)) ||
      num(a.project.order) - num(b.project.order) ||
      cmpStr(String(a.project.name ?? '').toLowerCase(), String(b.project.name ?? '').toLowerCase()),
  );
}
