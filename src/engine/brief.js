// Claude's check-in (the brief), "what Danny did on the website since", the
// "anything coming up for X?" nudges, and git commit messages for a burst of
// activity. Pure: no DOM, no Node APIs. See docs/ARCHITECTURE.md ("brief.js").

import { addDays, diffDays, fmtDay, fmtMinutes, fmtTime, fmtWeekday, isISODate, localDateOf, todayISO } from './dates.js';
import { DEFAULT_SETTINGS, SESSION_CAP_MIN } from './model.js';
import { backlog, calendarView, choreView, todayView, upcomingDeadlines } from './views.js';
import { remaining, risks } from './schedule.js';
import { streak } from './stats.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const list = (coll) => (Array.isArray(coll) ? coll : isObj(coll) ? Object.values(coll) : []).filter(isObj);
const tzOf = (state) => (typeof state?.settings?.tz === 'string' && state.settings.tz) || DEFAULT_SETTINGS.tz;
const titleOf = (t) => String(t?.title ?? '').trim() || 'Untitled';
const tsMs = (v) => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(n) ? null : n;
};

const MAX_ITEMS_PER_LINE = 4;
const MAX_ASKS = 4;
const STALE_DAYS = 21;

/** "a · b · c · +2 more" */
function joinCapped(items, max = MAX_ITEMS_PER_LINE) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return shown.join(' · ') + (rest > 0 ? ` · +${rest} more` : '');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "(10m)" from the work left on a task, or "" when there is no estimate. */
function leftTag(t) {
  if (!isNum(t?.est)) return '';
  const rem = remaining(t);
  return rem > 0 ? ` (${fmtMinutes(rem)})` : '';
}

// ---------------------------------------------------------------- buildBrief

function todaysPlate(tv) {
  const ids = new Map();
  for (const k of ['overdue', 'dueToday', 'meetings', 'planned', 'carried']) for (const t of tv[k]) ids.set(t.id, t);
  for (const { task } of tv.blocks) ids.set(task.id, task);
  return [...ids.values()];
}

function headlineFor(state, tv, plate, focus, dueChores) {
  const n = plate.length;
  if (n > 0) {
    const late = tv.overdue.length ? ` (${tv.overdue.length} overdue)` : '';
    const head = `${plural(n, 'thing')} today${late}.`;
    const m = tv.meetings[0];
    if (m) return `${head} Next up: ${titleOf(m)}${m.time ? ` at ${fmtTime(m.time)}` : ''}.`;
    return head;
  }
  if (tv.triage.length) return `Clear board, but ${plural(tv.triage.length, 'stale item')} need${tv.triage.length === 1 ? 's' : ''} a verdict.`;
  if (dueChores.length) {
    const c = dueChores[0].chore;
    return `Clear board. ${titleOf(c)} is due.`;
  }
  if (tv.doneToday.length) return `Board cleared. ${plural(tv.doneToday.length, 'thing')} done today. Go touch grass.`;
  if (backlog(state).length) return 'Clear board. Pick something from the backlog?';
  return 'Clear board. Nothing on the list. Dump what is in your head.';
}

function choreNudge(info) {
  const c = info.chore;
  const why = info.daysSince == null ? 'never logged' : info.daysSince === 0 ? 'not enough today' : `${info.daysSince}d since last`;
  return `Most overdue: ${titleOf(c)} (${why}).`;
}

function tomorrowLine(state, today) {
  const tom = addDays(today, 1);
  const day = calendarView(state, tom, 1, today)[0];
  if (!day) return null;
  const label = `TOMORROW // ${fmtDay(tom)}`;
  if (day.isOff && !day.items.length) return `${label}: off day`;
  // Danny's list is a to-do list, not a schedule: no work blocks, no hours vs capacity.
  const seen = new Set();
  const items = [];
  for (const it of day.items) {
    const t = it.task;
    if (it.type === 'block' || !t || seen.has(t.id)) continue;
    seen.add(t.id);
    if (it.type === 'due') items.push(`DUE ${titleOf(t)}`);
    else if (it.type === 'meeting') items.push(`${t.time ? `${fmtTime(t.time)} ` : ''}${titleOf(t)}`);
    else items.push(titleOf(t));
  }
  if (!items.length) return `${label}: nothing on the list yet`;
  return `${label}: ${joinCapped(items)}`;
}

function deadlineItem(d) {
  const t = d.task;
  return `${titleOf(t)} ${fmtDay(t.due)} (${d.daysLeft}d)`;
}

/** Fill up to `max` slots: a first pass takes `first[i]` from each group in order, then the leftovers in order. */
function fairPick(groups, max) {
  const out = [];
  const seen = new Set();
  const add = (q) => {
    if (out.length < max && q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  };
  for (const g of groups) g.items.slice(0, g.first).forEach(add);
  for (const g of groups) g.items.forEach(add);
  return out;
}

/** A clock left running past the session cap: ask before it logs a bogus session (ENG-3). */
function clockAsks(state, now) {
  const c = state?.clock;
  const start = tsMs(c?.start);
  const at = tsMs(now);
  if (!isObj(c) || c.active !== true || start == null || at == null) return [];
  const min = Math.round((at - start) / 60000);
  if (min <= SESSION_CAP_MIN) return [];
  const what = String(c.title ?? '').trim() || 'Focus';
  return [`The clock on '${what}' has been running ${fmtMinutes(min)}. Still at it, or stop it? (A session logs at most ${fmtMinutes(SESSION_CAP_MIN)}.)`];
}

function asksFor(state, today, tv, now) {
  const tasks = state?.tasks ?? {};
  const rs = risks(state, today);
  const title = (id) => titleOf(tasks[id]);

  const triage = tv.triage.map((t) => `Did '${titleOf(t)}' happen?`);
  // Only list questions (late / stale / pushed): never estimates, booked time or day load.
  const warnings = [];
  for (const r of rs) {
    if (r.type === 'crunch' && r.overdue && tasks[r.taskId]) {
      warnings.push(`'${title(r.taskId)}' is ${diffDays(r.d, today)}d late. Still on? New date or drop it?`);
    }
  }
  const pushed = list(tasks)
    .filter((t) => (t.status ?? 'todo') === 'todo' && t.triage !== true && isNum(t.moved) && t.moved >= 3)
    .sort((a, b) => b.moved - a.moved || titleOf(a).localeCompare(titleOf(b)))
    .map((t) => `'${titleOf(t)}' got pushed ${t.moved}x. Shrink it, pin it to a day, or drop it?`);
  const missing = missingCategoryCheck(state, today);

  return fairPick(
    [
      { items: clockAsks(state, now), first: 1 },
      { items: triage, first: 2 },
      { items: warnings, first: 1 },
      { items: pushed, first: 1 },
      { items: missing, first: 1 },
    ],
    MAX_ASKS,
  );
}

/**
 * The check-in Claude writes to the website: a punchy headline, terse status
 * lines, up to 4 questions, up to 3 focus task ids, and a plain-text version.
 */
export function buildBrief(state, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const now = typeof o.now === 'string' && tsMs(o.now) != null ? o.now : null;
  const today = isISODate(o.today) ? o.today : (now && localDateOf(now, tzOf(state))) || todayISO(tzOf(state));

  const tv = todayView(state, today);
  const plate = todaysPlate(tv);
  const focus = []; // no suggested order: Danny decides what comes first
  const chores = choreView(state, today).filter((x) => x.due);
  const headline = headlineFor(state, tv, plate, focus, chores);

  const lines = [];
  if (tv.dueToday.length) {
    lines.push(`DUE TODAY // ${joinCapped(tv.dueToday.map((t) => `${titleOf(t)}${t.time ? ` @ ${fmtTime(t.time)}` : ''}`))}`);
  }
  if (tv.overdue.length) {
    lines.push(`OVERDUE // ${joinCapped(tv.overdue.map((t) => `${titleOf(t)} (${diffDays(t.due, today)}d late)`))}`);
  }
  if (tv.meetings.length) {
    lines.push(`MEETINGS // ${joinCapped(tv.meetings.map((t) => `${t.time ? `${fmtTime(t.time)} ` : ''}${titleOf(t)}`))}`);
  }
  const incoming = upcomingDeadlines(state, today, 7).filter((d) => d.daysLeft >= 1);
  if (incoming.length) lines.push(`INCOMING // ${joinCapped(incoming.map(deadlineItem), 3)}`);
  if (chores.length) {
    lines.push(`CHORES // ${joinCapped(chores.map((x) => {
      const c = x.chore;
      return c.every === 1 && (c.perDay ?? 1) > 1 ? `${titleOf(c)} ${x.todayCount}/${c.perDay}` : titleOf(c);
    }))}. ${choreNudge(chores[0])}`);
  }
  if (!plate.length) {
    const bl = backlog(state);
    if (bl.length) lines.push(`BACKLOG // ${joinCapped(bl.map((t) => `${titleOf(t)}${leftTag(t)}`), 3)}`);
  }
  const tom = tomorrowLine(state, today);
  if (tom) lines.push(tom);
  if (tv.doneToday.length) {
    const s = streak(state, today);
    lines.push(`DONE // ${tv.doneToday.length} today${s.current > 1 ? ` · streak ${s.current}d` : ''}`);
  }

  const asks = asksFor(state, today, tv, now);
  const focusIds = focus.map((t) => t.id);

  const text = [
    `EF//BRIEF ${fmtDay(today)}`,
    `> ${headline}`,
    ...(lines.length ? ['', ...lines] : []),
    ...(asks.length ? ['', ...asks.map((q) => `?? ${q}`)] : []),
  ].join('\n');

  return { headline, lines, asks, focus: focusIds, text };
}

// ---------------------------------------------------------------- changesSince

function fmtTo(to) {
  if (to == null || to === '') return '';
  return isISODate(to) ? fmtDay(to) : String(to);
}

/** Valid activity entries (src filter: 'dash' by default, 'any' for all), oldest first. */
function activityEntries(coll, src) {
  return list(coll)
    .filter((a) => (src === 'any' || a.src === src) && typeof a.at === 'string' && tsMs(a.at) != null)
    .map((a, i) => [a, i])
    .sort(([a, ia], [b, ib]) => tsMs(a.at) - tsMs(b.at) || ia - ib)
    .map(([a]) => a);
}

/**
 * Net groups for a run of activity entries (oldest first): a done that was
 * undone again disappears, so does a drop that was reopened (or later marked
 * done, and vice versa); repeated moves collapse to first-from → last-to; an add
 * that was deleted again vanishes.
 */
function summarize(entries) {
  const done = new Map();
  const added = new Map();
  const moved = new Map();
  const dropped = new Map();
  const chores = [];
  const clock = [];
  const other = [];
  const key = (a) => a.ref ?? `title:${a.title}`;

  for (const a of entries) {
    const title = String(a.title ?? '');
    const k = key(a);
    switch (a.type) {
      case 'done':
        dropped.delete(k);
        done.set(k, title);
        break;
      case 'undone': {
        const wasDone = done.delete(k);
        const wasDropped = dropped.delete(k);
        if (!wasDone && !wasDropped) other.push(`undone: ${title}`);
        break;
      }
      case 'add':
        added.set(k, title);
        break;
      case 'delete':
        if (added.has(k)) added.delete(k);
        else other.push(`delete: ${title}`);
        moved.delete(k);
        done.delete(k);
        dropped.delete(k);
        break;
      case 'move': {
        const prev = moved.get(k);
        moved.set(k, { title, from: prev ? prev.from : a.from ?? null, to: a.to ?? null });
        break;
      }
      case 'drop':
        done.delete(k);
        dropped.set(k, title);
        break;
      case 'chore':
        chores.push(title);
        break;
      case 'clock':
        if (!clock.includes(title)) clock.push(title);
        break;
      default:
        other.push(`${a.type}: ${title}${a.to ? ` (${fmtTo(a.to)})` : ''}`);
    }
  }

  return {
    entries,
    done: [...done.values()],
    added: [...added.values()],
    moved: [...moved.values()].filter((m) => m.from !== m.to),
    dropped: [...dropped.values()],
    chores,
    clock,
    other,
  };
}

/**
 * What Danny did on the website (activity src "dash") after `sinceIso`, oldest
 * first, plus net groups (see summarize). Filters on the device timestamp `at`,
 * so an entry stamped before `sinceIso` that only reached GitHub after it is
 * missed: `ef sync` uses changesBetween instead.
 */
export function changesSince(state, sinceIso) {
  const sinceMs = tsMs(sinceIso);
  const entries = activityEntries(state?.activity, 'dash').filter((a) => (sinceMs == null ? true : tsMs(a.at) > sinceMs));
  return summarize(entries);
}

/**
 * Same shape as changesSince, from the activity entries whose ids are in
 * `after.activity` but not in `before.activity` (whatever their timestamps), so
 * a check-off made offline and pushed late is still reported once. Website
 * entries only (src "dash"); `{ src: 'any' }` includes Claude's own.
 */
export function changesBetween(before, after, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const src = o.src === 'any' ? 'any' : typeof o.src === 'string' && o.src ? o.src : 'dash';
  const seen = new Set(list(before?.activity).map((a) => a.id));
  if (isObj(before?.activity)) for (const id of Object.keys(before.activity)) seen.add(id);
  const fresh = list(after?.activity).filter((a) => typeof a.id === 'string' && !seen.has(a.id));
  return summarize(activityEntries(fresh, src));
}

// ---------------------------------------------------------------- missingCategoryCheck

/** Areas Danny said always have something going on. */
const ALWAYS_AREAS = [
  { ids: ['manuscripts'] },
  { ids: ['undergrad'] },
  { ids: ['gradroles'] },
  { ids: ['psc'] },
  { ids: ['ef'] },
  { ids: ['meetings'] },
  { ids: ['ziggy'] },
  { ids: ['cbt', 'multivar', 'practicum'], name: 'coursework' },
  { ids: ['home'] },
];

/**
 * Nudges for categories that look forgotten: an always-present area with no
 * open tasks and no chore ("Anything coming up for Undergrad?"), or any other
 * category with nothing open and no activity in 3 weeks ("still active?").
 * Rotates by date so consecutive days ask different things. At most 2.
 */
export function missingCategoryCheck(state, today) {
  const t0 = isISODate(today) ? today : todayISO(tzOf(state));
  const tz = tzOf(state);
  const cats = isObj(state?.cats) ? state.cats : {};
  const live = (id) => isObj(cats[id]) && cats[id].archived !== true;
  const tasks = list(state?.tasks);
  const chores = list(state?.chores).filter((c) => c.active !== false);
  const openIn = new Set(tasks.filter((t) => (t.status ?? 'todo') === 'todo').map((t) => t.cat));
  const choreIn = new Set(chores.map((c) => c.cat));
  const busy = (id) => openIn.has(id) || choreIn.has(id);

  const qs = [];
  const covered = new Set();
  for (const area of ALWAYS_AREAS) {
    const ids = area.ids.filter(live);
    ids.forEach((id) => covered.add(id));
    if (!ids.length || ids.some(busy)) continue;
    const name = area.name ?? cats[ids[0]].name ?? ids[0];
    qs.push(`Anything coming up for ${name}?`);
  }

  // Last time anything happened in each category (local dates).
  const last = new Map();
  const touch = (cat, d) => {
    if (!cat || !isISODate(d)) return;
    if (!last.has(cat) || last.get(cat) < d) last.set(cat, d);
  };
  const dayOf = (iso) => (typeof iso === 'string' && tsMs(iso) != null ? localDateOf(iso, tz) : null);
  const catOfRef = new Map();
  for (const t of tasks) {
    catOfRef.set(t.id, t.cat);
    touch(t.cat, dayOf(t.updated));
    touch(t.cat, dayOf(t.doneAt));
    touch(t.cat, dayOf(t.created));
  }
  for (const c of list(state?.chores)) {
    catOfRef.set(c.id, c.cat);
    touch(c.cat, c.last);
    touch(c.cat, dayOf(c.updated));
  }
  for (const p of list(state?.projects)) {
    catOfRef.set(p.id, p.cat);
    touch(p.cat, dayOf(p.updated));
  }
  for (const s of list(state?.sessions)) touch(s.cat, isISODate(s.d) ? s.d : dayOf(s.start));
  for (const a of list(state?.activity)) if (a.ref && catOfRef.has(a.ref)) touch(catOfRef.get(a.ref), dayOf(a.at));
  for (const c of Object.values(cats)) if (isObj(c)) touch(c.id, dayOf(c.created));

  const cutoff = addDays(t0, -STALE_DAYS);
  const stale = Object.values(cats)
    .filter((c) => isObj(c) && c.id !== 'inbox' && c.archived !== true && !covered.has(c.id) && !busy(c.id))
    .filter((c) => !last.has(c.id) || last.get(c.id) < cutoff)
    .sort((a, b) => (isNum(a.order) ? a.order : 500) - (isNum(b.order) ? b.order : 500) || String(a.id).localeCompare(String(b.id)));
  for (const c of stale) qs.push(`${c.name ?? c.id}: nothing open and quiet for 3+ weeks. Still active, or archive it?`);

  if (qs.length <= 2) return qs;
  const offset = (Math.abs(diffDays('1970-01-01', t0)) * 2) % qs.length;
  return [...qs.slice(offset), ...qs.slice(0, offset)].slice(0, 2);
}

// ---------------------------------------------------------------- commitMessage

const SYM = { done: '✓', add: '+', move: '→', drop: '✕', delete: '✕', undone: '↺', chore: '♺', clock: '⏱', edit: '✎', sub: '☐', block: '▦', milestone: '◆', cat: '#', settings: '⚙', archive: '▣' };
const VERB = { done: 'done', add: 'added', move: 'moved', drop: 'dropped', delete: 'deleted', undone: 'reopened', chore: 'chore', clock: 'clock', edit: 'edited', sub: 'subtask', block: 'block', milestone: 'milestone', cat: 'category', settings: 'settings', archive: 'archived' };
const SUBJECT_MAX = 72;

const chars = (s) => Array.from(s).length;
function clip(s, max) {
  const a = Array.from(s);
  return a.length <= max ? s : `${a.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function subjectPart(a) {
  const sym = SYM[a.type] ?? '·';
  const title = String(a.title ?? '').trim() || '?';
  if (a.type === 'move') return `${sym} ${title} (${isISODate(a.to) ? fmtWeekday(a.to) : 'backlog'})`;
  return `${sym} ${title}`;
}

function bodyLine(a) {
  const verb = VERB[a.type] ?? String(a.type ?? 'change');
  const title = String(a.title ?? '').trim() || '?';
  if (a.type === 'move') return `- ${verb}: ${title} → ${isISODate(a.to) ? fmtDay(a.to) : 'backlog'}`;
  if (a.type === 'block' && isISODate(a.to)) return `- ${verb}: ${title} → ${fmtDay(a.to)}`;
  return `- ${verb}: ${title}${a.to ? ` (${fmtTo(a.to)})` : ''}`;
}

/**
 * Git commit message for a burst of activity: a ≤72-char subject like
 * "dash: ✓ Email Mike · → RSA intro (Thu) · +2 more", a blank line, then one
 * bullet per entry. Empty → "dash: update".
 */
export function commitMessage(activity = []) {
  const acts = (Array.isArray(activity) ? activity : [])
    .filter(isObj)
    .map((a, i) => [a, i])
    .sort(([a, ia], [b, ib]) => (tsMs(a.at) ?? 0) - (tsMs(b.at) ?? 0) || ia - ib)
    .map(([a]) => a);
  if (!acts.length) return 'dash: update';
  const prefix = `${acts.every((a) => a.src === 'chat') ? 'chat' : 'dash'}: `;
  const parts = acts.map(subjectPart);

  let subject = null;
  for (let k = parts.length; k >= 1; k--) {
    const more = k < parts.length ? ` · +${parts.length - k} more` : '';
    const s = prefix + parts.slice(0, k).join(' · ') + more;
    if (chars(s) <= SUBJECT_MAX) {
      subject = s;
      break;
    }
  }
  if (!subject) {
    const more = parts.length > 1 ? ` · +${parts.length - 1} more` : '';
    subject = prefix + clip(parts[0], SUBJECT_MAX - chars(prefix) - chars(more)) + more;
  }
  return `${subject}\n\n${acts.map(bodyLine).join('\n')}`;
}
