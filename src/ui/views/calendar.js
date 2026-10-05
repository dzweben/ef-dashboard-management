// The rolling 14-day calendar: taped day headers, LED load meters, deadline pins,
// meetings, plan + block chips, chores, drag-and-drop between days (desktop),
// tap-to-open (phone), and the UNSCHEDULED backlog strip (full mode).
import { h, catStyle, setDragData, getDragData, DRAG_MIME } from '../dom.js';
import { calendarView } from '../../engine/views.js';
import { fmtDay, fmtMonthDay, fmtTime, fmtWeekday, fmtMinutes, isISODate } from '../../engine/dates.js';
import { catOf, goTab, ic, isTouch, shortMin } from './setup.js';

export const LED_SEGS = 10;
const COMPACT_MAX = 4;
const BACKLOG_MAX = 30;
const CHORES_MAX = 3;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TILTS = ['-1.6deg', '1.1deg', '-0.7deg', '1.8deg', '-1.9deg', '0.6deg', '-1.2deg'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Load meter state for a calendar day.
 * → { tone: 'idle'|'ok'|'warn'|'hot'|'crit'|'off', lit, label, title, ratio }
 * hot > 100% of capacity, crit > 130%; off days are hatched (crit if booked anyway).
 */
export function loadLevel(load, isOff = false) {
  const total = Math.max(0, Math.round(num(load?.total)));
  const cap = Math.max(0, Math.round(num(load?.cap)));
  if (isOff || cap === 0) {
    return total > 0
      ? { tone: 'crit', lit: LED_SEGS, label: `OFF +${shortMin(total)}`, title: `Day off, but ${fmtMinutes(total)} is booked`, ratio: Infinity }
      : { tone: 'off', lit: 0, label: 'OFF', title: 'Day off', ratio: 0 };
  }
  const ratio = total / cap;
  const lit = total > 0 ? Math.min(LED_SEGS, Math.max(1, Math.ceil(ratio * LED_SEGS - 1e-9))) : 0;
  const tone = ratio > 1.3 ? 'crit' : ratio > 1 ? 'hot' : ratio >= 0.75 ? 'warn' : total > 0 ? 'ok' : 'idle';
  return {
    tone,
    lit,
    label: total > 0 ? `${shortMin(total)}/${shortMin(cap)}` : `0/${shortMin(cap)}`,
    title: `${fmtMinutes(total)} booked of ${fmtMinutes(cap)} focus time (${Math.round(ratio * 100)}%)`,
    ratio,
  };
}

/** Days of the calendar to draw: ctx.vm.cal when it covers the request, else computed. */
export function calendarDays(ctx, days = 14) {
  const n = Math.max(1, Math.min(42, Math.round(Number(days) || 14)));
  const vm = Array.isArray(ctx?.vm?.cal) ? ctx.vm.cal : null;
  if (vm && vm.length >= n) return vm.slice(0, n);
  if (ctx?.state && isISODate(ctx?.today)) {
    try {
      return calendarView(ctx.state, ctx.today, n, ctx.today);
    } catch {
      return vm ?? [];
    }
  }
  return vm ?? [];
}

/** Daily chores (every === 1) show once in the header instead of in all 14 cells. */
export function dailyChores(state) {
  return Object.values(state?.chores ?? {}).filter(
    (c) => c && typeof c === 'object' && c.active !== false && Math.round(Number(c.every)) === 1,
  );
}

/** Totals for the panel head readouts. */
export function calSummary(days) {
  let load = 0;
  let cap = 0;
  let dues = 0;
  let over = 0;
  for (const d of days) {
    load += num(d?.load?.total);
    cap += num(d?.load?.cap);
    dues += (d?.items ?? []).filter((it) => it?.type === 'due').length;
    if (num(d?.load?.cap) > 0 ? num(d?.load?.total) > num(d?.load?.cap) : num(d?.load?.total) > 0) over += 1;
  }
  return { load, cap, dues, over };
}

function setDragging(on) {
  try {
    document.documentElement.classList.toggle('ef-dragging', !!on);
  } catch {
    /* no document */
  }
}

function hasPayload(ev) {
  const types = ev?.dataTransfer?.types;
  if (!types) return false;
  const list = Array.from(types);
  return list.includes(DRAG_MIME) || list.includes('text/plain');
}

/** Drop a dragged task/block on a day (or null = back to the backlog). Returns the act promise or null. */
export function dropOn(ctx, payload, d) {
  const t = payload && ctx?.state?.tasks?.[payload.taskId];
  if (!t) return null;
  if (payload.blockId) {
    if (!isISODate(d)) {
      ctx?.toast?.('Work blocks need a day. Drop it on the calendar.', { kind: 'info' });
      return null;
    }
    const b = (Array.isArray(t.blocks) ? t.blocks : []).find((x) => x && x.id === payload.blockId);
    if (!b || b.d === d) return null;
    const from = b.d;
    return ctx.act('moveBlock', { id: t.id, blockId: b.id, to: d }, {
      toast: `Block → ${fmtDay(d)}`,
      undo: from ? () => ctx.act('moveBlock', { id: t.id, blockId: b.id, to: from }) : undefined,
    });
  }
  const to = isISODate(d) ? d : null;
  const from = isISODate(t.plan) ? t.plan : null;
  if (to === from) return null;
  let msg;
  if (!to) msg = `${t.title}: back to unscheduled`;
  else if (isISODate(t.due) && t.due < to) msg = `Planned ${fmtDay(to)}. Heads up: it's due ${fmtDay(t.due)}.`;
  else msg = `${t.title} → ${fmtDay(to)}`;
  return ctx.act('moveTask', { id: t.id, to }, {
    toast: msg,
    kind: isISODate(t.due) && to && t.due < to ? 'info' : 'good',
    undo: () => ctx.act('moveTask', { id: t.id, to: from }),
  });
}

/** Wire an element as a drop target. `d` = day ISO, or null for the backlog. */
function dropTarget(ctx, el, d) {
  el.addEventListener('dragover', (ev) => {
    if (!hasPayload(ev)) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch { /* read-only in some browsers */ }
    el.classList.add('is-over');
  });
  el.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget && el.contains(ev.relatedTarget)) return;
    el.classList.remove('is-over');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('is-over');
    setDragging(false);
    const p = getDragData(ev);
    if (p) dropOn(ctx, p, d);
  });
  return el;
}

function dragProps(payload, enabled) {
  if (!enabled) return {};
  return {
    draggable: 'true',
    ondragstart: (ev) => {
      setDragData(ev, payload);
      ev.currentTarget.classList.add('is-dragging');
      setDragging(true);
    },
    ondragend: (ev) => {
      ev.currentTarget.classList.remove('is-dragging');
      setDragging(false);
    },
  };
}

function prioMark(t) {
  const p = num(t?.prio);
  return p >= 3 ? h('b.cal-prio.is-crit', { title: 'Critical' }, '!!') : p === 2 ? h('b.cal-prio', { title: 'High priority' }, '!') : null;
}

function itemChip(ctx, it, { canDrag, d }) {
  const t = it.task;
  const cat = catOf(ctx, t.cat);
  const type = it.type;
  const blockId = type === 'block' ? it.block?.id ?? null : null;
  const est = Number.isFinite(t.est) ? Math.max(0, t.est - num(t.spent)) : null;
  let lead;
  let meta = null;
  let label;
  if (type === 'due') {
    lead = h('span.cal-pin', { 'aria-hidden': 'true' }, '◆');
    meta = h('b.cal-tag', 'DUE');
    label = `Due ${fmtDay(d)}: ${t.title}`;
  } else if (type === 'meeting') {
    const time = fmtTime(t.time);
    lead = h('span.cal-time', time ? time.toUpperCase() : 'MTG');
    label = `${time || 'Meeting'}: ${t.title}`;
  } else if (type === 'block') {
    lead = h('span.cal-blk', { 'aria-hidden': 'true' });
    meta = h('span.cal-min', shortMin(it.block?.m).toUpperCase());
    label = `Work block ${fmtMinutes(it.block?.m)}: ${t.title}`;
  } else {
    lead = h('span.catdot', { style: catStyle(cat), 'aria-hidden': 'true' });
    meta = est ? h('span.cal-min', shortMin(est).toUpperCase()) : null;
    label = `${t.title}${est ? ` (${fmtMinutes(est)})` : ''}`;
  }
  return h('button.cal-chip', {
    type: 'button',
    class: `is-${type}`,
    style: catStyle(cat),
    title: `${label}${cat?.name ? ` · ${cat.name}` : ''}`,
    'aria-label': label,
    dataset: { taskId: t.id, blockId },
    onclick: () => ctx?.openTask?.(t.id),
    ...dragProps({ taskId: t.id, blockId }, canDrag),
  },
    lead,
    h('span.cal-chip-t', t.title || 'Untitled'),
    prioMark(t),
    meta,
  );
}

function choreChip(ctx, c, isToday) {
  const label = `${c.title}${isToday ? ': start 5 min' : ''}`;
  if (!isToday) return h('span.cal-chore', { title: `Chore: ${c.title}` }, h('span.cal-chore-i', { 'aria-hidden': 'true' }, '↻'), h('span.cal-chip-t', c.title));
  return h('button.cal-chore', {
    type: 'button',
    title: label,
    'aria-label': label,
    onclick: () => ctx?.openClock?.(`chore:${c.id}`),
  }, h('span.cal-chore-i', { 'aria-hidden': 'true' }, '↻'), h('span.cal-chip-t', c.title));
}

function loadMeter(day) {
  const L = loadLevel(day.load, day.isOff);
  return h('div.cal-load', { class: `is-${L.tone}`, title: L.title },
    h('span.cal-led', { 'aria-hidden': 'true' },
      Array.from({ length: LED_SEGS }, (_, k) => h('i', { class: k < L.lit ? 'on' : '' }))),
    h('span.cal-load-n', L.label.toUpperCase()),
    h('span.sr-only', L.title),
  );
}

function dayCell(ctx, day, i, { compact, canDrag, dailyIds }) {
  const d = day.d;
  const items = Array.isArray(day.items) ? day.items.filter((it) => it && it.task) : [];
  const chores = (Array.isArray(day.chores) ? day.chores : []).filter((c) => c && !dailyIds.has(c.id));
  const done = Array.isArray(day.done) ? day.done : [];
  const [, mm, dd] = isISODate(d) ? d.split('-').map(Number) : [0, 0, 0];
  const showMonth = i === 0 || dd === 1;
  const wd = fmtWeekday(d).toUpperCase();
  const L = loadLevel(day.load, day.isOff);

  const shownItems = compact ? items.slice(0, COMPACT_MAX) : items;
  const hiddenItems = items.length - shownItems.length;
  const chips = shownItems.map((it) => itemChip(ctx, it, { canDrag, d }));

  let choreEl = null;
  if (chores.length) {
    if (compact) {
      choreEl = h('div.cal-chores.is-compact', { title: chores.map((c) => c.title).join(', ') },
        h('span.cal-chore-i', { 'aria-hidden': 'true' }, '↻'),
        chores.length === 1 ? chores[0].title : `${chores.length} chores`);
    } else {
      const shownChores = chores.length > CHORES_MAX ? chores.slice(0, CHORES_MAX - 1) : chores;
      const rest = chores.slice(shownChores.length);
      choreEl = h('div.cal-chores',
        shownChores.map((c) => choreChip(ctx, c, day.isToday)),
        rest.length
          ? h(day.isToday ? 'button.cal-chore.is-rest' : 'span.cal-chore.is-rest', {
              type: day.isToday ? 'button' : null,
              title: rest.map((c) => c.title).join(', '),
              onclick: day.isToday ? () => ctx?.openClock?.() : null,
            }, h('span.cal-chore-i', { 'aria-hidden': 'true' }, '↻'), `+${rest.length} more chores`)
          : null,
      );
    }
  }

  const empty = !items.length && !chores.length;
  const free = Math.max(0, num(day.load?.cap) - num(day.load?.total));

  const cell = h('section.cal-day', {
    class: [
      day.isToday && 'is-today',
      day.isPast && 'is-past',
      day.isWeekend && 'is-weekend',
      day.isOff && 'is-off',
      empty && 'is-empty',
      `load-${L.tone}`,
    ].filter(Boolean).join(' '),
    style: { '--tilt': TILTS[i % TILTS.length] },
    'aria-label': `${day.isToday ? 'Today, ' : ''}${fmtDay(d)}: ${items.length} item${items.length === 1 ? '' : 's'}${day.isOff ? ', day off' : ''}`,
    dataset: { date: d },
  },
    h('header.cal-day-head',
      h('span.tape.cal-tape', day.isToday ? 'TODAY' : wd),
      h('span.cal-date',
        h('span.cal-num', String(dd || '')),
        h('span.cal-mon', { class: showMonth ? '' : 'is-quiet' }, day.isToday ? wd : MONTHS[(mm || 1) - 1]),
      ),
      day.isOff ? h('span.cal-off-stamp', { 'aria-hidden': 'true' }, 'OFF') : null,
    ),
    h('div.cal-day-body',
      loadMeter(day),
      chips.length ? h('div.cal-items', chips) : null,
      hiddenItems > 0
        ? h('button.cal-more', {
            type: 'button',
            onclick: () => goTab(ctx, 'calendar'),
            'aria-label': `${hiddenItems} more on ${fmtDay(d)}: open the 14-day view`,
          }, `+${hiddenItems} more`)
        : null,
      choreEl,
      done.length
        ? h('div.cal-done', { title: done.map((t) => t.title).join(' · ') }, h('span', { 'aria-hidden': 'true' }, '✓'), `${done.length} done`)
        : null,
      empty && !done.length
        ? h('div.cal-clear', day.isOff ? 'day off' : free > 0 ? `clear · ${shortMin(free)} free` : 'clear')
        : null,
    ),
  );
  return dropTarget(ctx, cell, d);
}

/** A day with nothing on it (and not today / off): candidates for collapsing on narrow screens. */
function isBlank(day, dailyIds) {
  if (!day || day.isToday || day.isOff) return false;
  const items = Array.isArray(day.items) ? day.items.length : 0;
  const chores = (Array.isArray(day.chores) ? day.chores : []).filter((c) => c && !dailyIds.has(c.id)).length;
  const done = Array.isArray(day.done) ? day.done.length : 0;
  return items + chores + done === 0;
}

/** Runs of ≥2 consecutive blank days: [{ from, days: [indexes] }]. */
export function emptyRuns(days, dailyIds = new Set()) {
  const out = [];
  let cur = null;
  days.forEach((day, i) => {
    if (isBlank(day, dailyIds)) {
      if (!cur) cur = { from: i, days: [] };
      cur.days.push(i);
    } else {
      if (cur && cur.days.length >= 2) out.push(cur);
      cur = null;
    }
  });
  if (cur && cur.days.length >= 2) out.push(cur);
  return out;
}

/** Narrow-layout stand-in for a run of blank days (hidden in the 7-column grid). */
function runRow(days, run) {
  const first = days[run.days[0]];
  const last = days[run.days[run.days.length - 1]];
  const free = run.days.reduce((sum, i) => sum + Math.max(0, num(days[i].load?.cap) - num(days[i].load?.total)), 0);
  return h('div.cal-run', { role: 'listitem', 'aria-label': `${fmtDay(first.d)} to ${fmtDay(last.d)}: nothing planned` },
    h('span.tape.cal-tape', `${fmtWeekday(first.d).toUpperCase()} ${Number(first.d.slice(8))} → ${fmtWeekday(last.d).toUpperCase()} ${Number(last.d.slice(8))}`),
    h('span.cal-run-t', `${run.days.length} open days`),
    h('span.cal-run-free', free > 0 ? `${shortMin(free)} free` : ''),
  );
}

function backlogStrip(ctx, { canDrag }) {
  const list = Array.isArray(ctx?.vm?.backlog) ? ctx.vm.backlog.filter((t) => t && t.id) : [];
  const shown = list.slice(0, BACKLOG_MAX);
  const strip = h('section.cal-backlog', { 'aria-labelledby': 'cal-backlog-h' },
    h('header.cal-backlog-head',
      h('h3#cal-backlog-h', h('span.cal-backlog-x', { 'aria-hidden': 'true' }, '▚'), 'Unscheduled', h('span.cal-backlog-n', String(list.length))),
      h('p.label', canDrag ? 'drag onto a day · drop a chip here to unschedule' : 'tap one to give it a day'),
    ),
    list.length
      ? h('div.cal-backlog-list',
          shown.map((t) => {
            const cat = catOf(ctx, t.cat);
            const est = Number.isFinite(t.est) ? Math.max(0, t.est - num(t.spent)) : null;
            return h('button.cal-chip.is-backlog', {
              type: 'button',
              style: catStyle(cat),
              title: `${t.title} · ${cat?.name ?? ''} · tap to schedule`,
              'aria-label': `Schedule ${t.title}`,
              dataset: { taskId: t.id },
              onclick: () => ctx?.openMove?.(t.id, null),
              ...dragProps({ taskId: t.id, blockId: null }, canDrag),
            },
              h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat?.glyph || '··'),
              h('span.cal-chip-t', t.title || 'Untitled'),
              prioMark(t),
              est ? h('span.cal-min', shortMin(est).toUpperCase()) : null,
            );
          }),
          list.length > shown.length
            ? h('button.cal-more', { type: 'button', onclick: () => goTab(ctx, 'all') }, `+${list.length - shown.length} more in All`)
            : null,
        )
      : h('p.cal-backlog-empty', h('span.scrawl', 'Backlog zero.'), ' Everything has a day.'),
  );
  return dropTarget(ctx, strip, null);
}

function legend() {
  return h('div.cal-legend', { 'aria-hidden': 'true' },
    h('span.cal-lg.is-due', h('span.cal-pin', '◆'), 'deadline'),
    h('span.cal-lg.is-meeting', h('span.cal-time', '3PM'), 'meeting'),
    h('span.cal-lg.is-plan', h('span.catdot'), 'planned'),
    h('span.cal-lg.is-block', h('span.cal-blk'), 'work block'),
    h('span.cal-lg.is-chore', '↻ chore'),
    h('span.cal-lg.is-off', h('i'), 'day off'),
  );
}

function skeleton(compact, n) {
  return h('section.panel.cal', { class: compact ? 'is-compact' : 'is-full', 'aria-busy': 'true' },
    h('header.panel-head', h('h2', h('span.slash', '//'), 'Next 14 days'), h('span.label', 'LOADING…')),
    h('div.panel-body', h('div.cal-grid', Array.from({ length: n }, () => h('div.cal-day.is-skel', h('span.label', 'LOADING…'))))),
  );
}

/**
 * renderCalendar(ctx, { days = 14, compact = false }) → Element
 * compact (overview): max 4 chips per day + "+N more" that opens the tab.
 * full (tab): legend, daily-chore strip, and the UNSCHEDULED backlog.
 */
export function renderCalendar(ctx, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const compact = !!o.compact;
  const n = Math.max(1, Math.min(42, Math.round(Number(o.days) || 14)));
  if (ctx && ctx.loaded === false) return skeleton(compact, n);

  const days = calendarDays(ctx, n).filter((d) => d && isISODate(d.d));
  const canDrag = !isTouch() && ctx?.store?.canWrite !== false;
  const daily = dailyChores(ctx?.state);
  const dailyIds = new Set(daily.map((c) => c.id));
  const sum = calSummary(days);
  const first = days[0]?.d;
  const last = days[days.length - 1]?.d;
  const sumTone = sum.cap > 0 && sum.load / sum.cap > 1 ? 'is-hot' : '';

  const head = h('header.panel-head.cal-head',
    h('div.cal-title',
      h('h2#cal-h', h('span.slash', '//'), compact ? 'Next 14 days' : 'The next two weeks'),
      first ? h('span.label.is-bracket', `${fmtMonthDay(first)} → ${fmtMonthDay(last)}`) : null,
    ),
    h('div.cal-readouts',
      h('span.cal-ro', { class: sum.dues ? 'is-hot' : '' }, h('b', String(sum.dues)), h('span', sum.dues === 1 ? 'deadline' : 'deadlines')),
      h('span.cal-ro', { class: sumTone, title: `${fmtMinutes(sum.load)} booked of ${fmtMinutes(sum.cap)} focus time` },
        h('b', shortMin(sum.load).toUpperCase()), h('span', `/ ${shortMin(sum.cap).toUpperCase()} load`)),
      sum.over ? h('span.cal-ro.is-crit', h('b', String(sum.over)), h('span', sum.over === 1 ? 'day over' : 'days over')) : null,
      compact
        ? h('button.btn.btn-sm.cal-open', { type: 'button', onclick: () => goTab(ctx, 'calendar') }, ic(ctx, 'calendar'), 'Open')
        : null,
    ),
  );

  const dailyStrip = !compact && daily.length
    ? h('div.cal-daily',
        h('span.label', 'every day'),
        daily.map((c) => h('span.cal-chore.is-daily', h('span.cal-chore-i', { 'aria-hidden': 'true' }, '↻'), c.title, Number(c.perDay) > 1 ? h('b', ` ×${c.perDay}`) : null)),
      )
    : null;

  const runs = compact ? emptyRuns(days, dailyIds) : [];
  const runAt = new Map(runs.map((r) => [r.from, r]));
  const inRun = new Set(runs.flatMap((r) => r.days));
  const cells = [];
  days.forEach((day, i) => {
    const run = runAt.get(i);
    if (run) cells.push(runRow(days, run));
    const cell = dayCell(ctx, day, i, { compact, canDrag, dailyIds });
    cell.setAttribute('role', 'listitem');
    if (inRun.has(i)) cell.classList.add('in-run');
    cells.push(cell);
  });
  const grid = days.length
    ? h('div.cal-grid', { role: 'list' }, cells)
    : h('div.empty', h('p.scrawl', 'No days to show.'), h('p', 'The calendar needs a date. Try a refresh.'));

  return h('section.panel.cal', {
    class: [compact ? 'is-compact' : 'is-full', canDrag ? 'can-drag' : 'is-touch'].join(' '),
    'aria-labelledby': 'cal-h',
  },
    head,
    h('div.panel-body',
      compact ? null : h('div.cal-toolbar', legend(), dailyStrip),
      grid,
      compact ? null : backlogStrip(ctx, { canDrag }),
    ),
  );
}
