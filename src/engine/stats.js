// Accomplishments: what got done per day, the heatmap, streaks, this week, wins.
// Pure; days are local calendar dates in the settings timezone. See docs/ARCHITECTURE.md.

import { addDays, diffDays, isISODate, localDateOf, rangeDays, startOfWeek, todayISO } from './dates.js';
import { DEFAULT_SETTINGS, SESSION_CAP_MIN } from './model.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

function list(coll) {
  const arr = Array.isArray(coll) ? coll : isObj(coll) ? Object.values(coll) : [];
  return arr.filter(isObj);
}
const tzOf = (state) => (typeof state?.settings?.tz === 'string' && state.settings.tz) || DEFAULT_SETTINGS.tz;
const weekStartOf = (state) => (state?.settings?.weekStart === 'sun' ? 'sun' : 'mon');
const todayFor = (state, today) => (isISODate(today) ? today : todayISO(tzOf(state)));
const tsMs = (iso) => {
  const n = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? null : n;
};

/** Local date a done task belongs to, or null. */
function doneDate(t, tz) {
  if (t.status !== 'done' || typeof t.doneAt !== 'string') return null;
  return localDay(t.doneAt, tz);
}

/** Minutes of a clock-in session (its `min`, else end − start capped at SESSION_CAP_MIN, like clockOut). */
function sessionMinutes(s) {
  if (isNum(s.min)) return Math.max(0, Math.round(s.min));
  const a = tsMs(s.start);
  const b = tsMs(s.end);
  return a != null && b != null && b > a ? Math.min(SESSION_CAP_MIN, Math.round((b - a) / 60000)) : 0;
}

/** Local date of a session (its `d`, else the local date of `start`). */
function sessionDate(s, tz) {
  if (isISODate(s.d)) return s.d;
  return typeof s.start === 'string' ? localDay(s.start, tz) : null;
}

/**
 * Per-day activity: Map<d, { tasks, chores, sessions, minutes }>.
 * tasks = tasks completed that local day; chores = chore log entries;
 * sessions/minutes = clock-in sessions and their minutes.
 */
function activityByDay(state) {
  const tz = tzOf(state);
  const days = new Map();
  const at = (d) => {
    let e = days.get(d);
    if (!e) days.set(d, (e = { tasks: 0, chores: 0, sessions: 0, minutes: 0 }));
    return e;
  };
  for (const t of list(state?.tasks)) {
    const d = doneDate(t, tz);
    if (d) at(d).tasks += 1;
  }
  for (const c of list(state?.chores)) {
    if (!Array.isArray(c.log)) continue;
    for (const d of c.log) if (isISODate(d)) at(d).chores += 1;
  }
  for (const s of list(state?.sessions)) {
    const d = sessionDate(s, tz);
    if (!d) continue;
    const e = at(d);
    e.sessions += 1;
    e.minutes += sessionMinutes(s);
  }
  return days;
}

/** Tasks completed on local day `d` (settings tz), in completion order. */
export function doneOn(state, d) {
  if (!isISODate(d)) return [];
  const tz = tzOf(state);
  return list(state?.tasks)
    .filter((t) => doneDate(t, tz) === d)
    .sort((a, b) => cmpStr(String(a.doneAt), String(b.doneAt)));
}

/**
 * Daily cells for the last `weeks` weeks, oldest first, ending today. The first
 * cell is the start of a week (settings.weekStart), so cell i sits in row i % 7.
 * count = tasks done + chore check-offs; minutes = clock-in minutes.
 */
export function heatmap(state, today, weeks = 12) {
  const t0 = todayFor(state, today);
  const w = isNum(weeks) && weeks >= 1 ? Math.min(Math.round(weeks), 104) : 12;
  const start = addDays(startOfWeek(t0, weekStartOf(state)), -7 * (w - 1));
  const act = activityByDay(state);
  return rangeDays(start, diffDays(start, t0) + 1).map((d) => {
    const e = act.get(d);
    return {
      d,
      count: (e?.tasks ?? 0) + (e?.chores ?? 0),
      minutes: e?.minutes ?? 0,
      tasks: e?.tasks ?? 0,
      chores: e?.chores ?? 0,
    };
  });
}

/**
 * Consecutive active days (≥1 task done, chore logged, or clock-in session).
 * current counts back from today, or from yesterday while today is still empty.
 * best is the longest run anywhere in the history (never less than current).
 */
export function streak(state, today) {
  const t0 = todayFor(state, today);
  const act = activityByDay(state);
  const active = new Set();
  for (const [d, e] of act) if (d <= t0 && (e.tasks || e.chores || e.sessions)) active.add(d);

  let current = 0;
  for (let d = active.has(t0) ? t0 : addDays(t0, -1); active.has(d); d = addDays(d, -1)) current += 1;

  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...active].sort()) {
    run = prev && diffDays(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best: Math.max(best, current) };
}

/** A completed task worth a headline: flagged `win`, or critical priority. */
const isHeadline = (t) => t.win === true || (isNum(t.prio) && t.prio >= 3);

/**
 * This week so far (week start per settings → today): tasks done, done by
 * category, clock-in minutes, headline wins (newest first), chore check-offs.
 */
export function weekStats(state, today) {
  const t0 = todayFor(state, today);
  const tz = tzOf(state);
  const start = startOfWeek(t0, weekStartOf(state));
  const inWeek = (d) => d && d >= start && d <= t0;

  const done = list(state?.tasks).filter((t) => inWeek(doneDate(t, tz)));
  const byCat = {};
  for (const t of done) {
    const c = typeof t.cat === 'string' && t.cat ? t.cat : 'inbox';
    byCat[c] = (byCat[c] ?? 0) + 1;
  }
  let minutes = 0;
  for (const s of list(state?.sessions)) if (inWeek(sessionDate(s, tz))) minutes += sessionMinutes(s);
  let chores = 0;
  for (const c of list(state?.chores)) if (Array.isArray(c.log)) for (const d of c.log) if (isISODate(d) && inWeek(d)) chores += 1;

  const wins = done.filter(isHeadline).sort((a, b) => cmpStr(String(b.doneAt), String(a.doneAt)));
  return { done: done.length, byCat, minutes, wins, chores, start, end: t0 };
}

/**
 * Completed tasks and milestones, newest first:
 * [{ at, title, cat, kind: "task"|"milestone", ref, win, project? }].
 * opts.since: "YYYY-MM-DD" (local date, inclusive) or an ISO timestamp (inclusive).
 * opts.limit: max entries. Milestones without a doneAt are skipped.
 */
export function wins(state, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const tz = tzOf(state);
  const items = [];
  for (const t of list(state?.tasks)) {
    if (t.status !== 'done' || tsMs(t.doneAt) == null) continue;
    items.push({ at: t.doneAt, title: String(t.title ?? ''), cat: t.cat || 'inbox', kind: 'task', ref: t.id, win: isHeadline(t) });
  }
  for (const p of list(state?.projects)) {
    if (!Array.isArray(p.milestones)) continue;
    for (const m of p.milestones) {
      if (!isObj(m) || m.done !== true || tsMs(m.doneAt) == null) continue;
      items.push({ at: m.doneAt, title: String(m.t ?? ''), cat: p.cat || 'inbox', kind: 'milestone', ref: p.id, win: true, project: p.name ?? '' });
    }
  }

  let keep = items.map((x) => [tsMs(x.at), x]);
  if (isISODate(o.since)) keep = keep.filter(([, x]) => (localDay(x.at, tz) ?? '') >= o.since);
  else if (tsMs(o.since) != null) {
    const sinceMs = tsMs(o.since);
    keep = keep.filter(([ms]) => ms >= sinceMs);
  }
  keep.sort(([ma, a], [mb, b]) => mb - ma || cmpStr(a.title, b.title));
  const out = keep.map(([, x]) => x);
  return isNum(o.limit) && o.limit >= 0 ? out.slice(0, Math.round(o.limit)) : out;
}
