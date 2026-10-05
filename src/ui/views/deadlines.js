// // INCOMING: the next 30 days of hard deadlines with runway meters and auto-plan.
import { h, catMark, catStyle } from '../dom.js';
import { icon } from '../icons.js';
import { fmtDay, fmtMinutes, fmtTime } from '../../engine/dates.js';
import { allocate, planStart } from '../../engine/schedule.js';

const COMPACT_LIMIT = 7;
const arr = (v) => (Array.isArray(v) ? v : []);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const up = (s) => String(s ?? '').toUpperCase();

const STATUS = {
  ok: { label: 'OK', tone: 'acid' },
  tight: { label: 'TIGHT', tone: 'warn' },
  'at-risk': { label: 'AT RISK', tone: 'crit' },
  unplanned: { label: 'UNPLANNED', tone: 'hot' },
  'no-estimate': { label: 'NO ESTIMATE', tone: 'warn' },
};
const NEEDS_PLAN = new Set(['at-risk', 'unplanned', 'tight']);

function catOf(ctx, id) {
  return typeof ctx.cat === 'function' ? ctx.cat(id) : ctx.state?.cats?.[id] ?? null;
}

/** Run schedule.allocate for some tasks (or all) and apply it. */
export function autoPlan(ctx, taskIds) {
  let res;
  try {
    res = allocate(ctx.state, { today: ctx.today, taskIds: taskIds ?? undefined, from: planStart(ctx.now, ctx.tz) });
  } catch (err) {
    ctx.toast?.(`Auto-plan failed: ${err?.message || err}`, { kind: 'error' });
    return Promise.resolve(null);
  }
  const updates = res && res.updates && typeof res.updates === 'object' ? res.updates : {};
  const ids = Object.keys(updates);
  const riskMsg = arr(res?.risks).find((r) => !taskIds || taskIds.includes(r.taskId))?.message;
  if (!ids.length) {
    ctx.toast?.(riskMsg || 'Nothing to plan: it needs an estimate, a due date, and free time before it.', { kind: riskMsg ? 'error' : 'info' });
    return Promise.resolve(null);
  }
  const blocks = ids.reduce((n, id) => n + arr(updates[id]).filter((b) => b && b.done !== true && b.d >= ctx.today).length, 0);
  const one = ids.length === 1 ? ctx.state?.tasks?.[ids[0]]?.title : null;
  const msg = one ? `Booked ${blocks} block${blocks === 1 ? '' : 's'} for ${one}.` : `Booked ${blocks} blocks across ${ids.length} tasks.`;
  return ctx.act('applyAllocation', { updates }, { toast: riskMsg ? `${msg} Heads up: ${riskMsg}` : msg });
}

function countdown(daysLeft) {
  const n = isNum(daysLeft) ? daysLeft : 0;
  const tone = n <= 2 ? 'is-hot' : n <= 7 ? 'is-warn' : '';
  if (n <= 0) return h('div.dl-count', { class: 'is-hot is-now', 'aria-label': 'Due today' }, h('span.shout', 'TDY'));
  return h('div.dl-count', { class: tone, 'aria-label': `${n} days left` }, h('span.shout', String(n)), h('span.dl-unit', 'D'));
}

function runway(item) {
  const rem = Math.max(0, isNum(item.remaining) ? item.remaining : 0);
  const alloc = Math.max(0, isNum(item.allocated) ? item.allocated : 0);
  const hasEst = isNum(item.task?.est);
  if (!hasEst) {
    return h('div.dl-runway.is-unknown',
      h('div.meter.is-warn.dl-meter', h('i', { style: { width: '0%' } })),
      h('span.dl-runway-label', 'est ?'),
    );
  }
  if (rem <= 0) {
    return h('div.dl-runway', h('div.meter.dl-meter', h('i', { style: { width: '100%' } })), h('span.dl-runway-label.is-good', 'work done'));
  }
  const pct = Math.max(0, Math.min(100, (100 * alloc) / rem));
  const tone = item.status === 'ok' ? '' : item.status === 'at-risk' ? 'is-crit' : item.status === 'unplanned' ? 'is-hot' : 'is-warn';
  return h('div.dl-runway', { title: `${fmtMinutes(alloc)} booked of ${fmtMinutes(rem)} left` },
    h('div.meter.dl-meter', { class: tone, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(rem), 'aria-valuenow': String(Math.min(alloc, rem)), 'aria-label': 'Time booked' },
      h('i', { style: { width: `${pct.toFixed(1)}%` } })),
    h('span.dl-runway-label', h('b', up(fmtMinutes(alloc))), ` / ${up(fmtMinutes(rem))} booked`),
  );
}

function row(item, ctx) {
  const t = item.task ?? {};
  const st = STATUS[item.status] ?? { label: up(item.status || '?'), tone: '' };
  const cat = catOf(ctx, t.cat);
  const title = String(t.title ?? '').trim() || 'Untitled';
  let action = null;
  if (NEEDS_PLAN.has(item.status)) {
    action = h('button.btn.btn-sm.dl-plan', { type: 'button', class: item.status === 'at-risk' ? 'btn-hot' : '', onclick: () => autoPlan(ctx, [t.id]) }, icon('bolt'), 'Auto-plan');
  } else if (item.status === 'no-estimate') {
    action = h('button.btn.btn-sm.btn-ghost.dl-plan', { type: 'button', onclick: () => ctx.openTask?.(t.id), title: 'Add an estimate so it can be planned' }, icon('edit'), 'Estimate');
  }
  return h('div.dl-row', { role: 'listitem', class: `st-${item.status || 'x'}`, style: catStyle(cat), dataset: { taskId: t.id } },
    countdown(item.daysLeft),
    h('div.dl-main',
      h('div.dl-title', catMark(cat), h('button.dl-name', { type: 'button', onclick: () => ctx.openTask?.(t.id) }, title)),
      h('div.dl-meta',
        h('span.chip', { class: item.daysLeft <= 0 ? 'chip-hot' : '' }, icon('diamond'), `DUE ${up(fmtDay(t.due))}`),
        t.time && fmtTime(t.time) ? h('span.chip.chip-cyan', icon('clock'), up(fmtTime(t.time))) : null,
        h('span.chip', { class: st.tone ? `chip-${st.tone}` : '' }, st.label),
      ),
    ),
    runway(item),
    h('div.dl-act', action),
  );
}

export function renderDeadlines(ctx) {
  const items = arr(ctx.vm?.deadlines).filter((x) => x && x.task);
  const over = arr(ctx.vm?.risks).filter((r) => r && r.type === 'overbooked');
  const showAll = !!ctx.ui?.deadlinesAll;
  const visible = showAll ? items : items.slice(0, COMPACT_LIMIT);
  const planable = items.filter((x) => NEEDS_PLAN.has(x.status)).map((x) => x.task.id);
  const hot = items.filter((x) => x.daysLeft <= 7).length;

  const head = h('div.panel-head',
    h('h2', h('span.slash', '//'), 'Incoming'),
    h('div.dl-head-right',
      h('span.label.is-bracket', `${items.length} in 30d${hot ? ` · ${hot} this week` : ''}`),
      planable.length > 1
        ? h('button.btn.btn-sm', { type: 'button', onclick: () => autoPlan(ctx, planable), title: 'Book work blocks for everything that needs them' }, icon('bolt'), 'Plan all')
        : null,
    ),
  );

  const body = h('div.panel-body.dl-body');
  for (const r of over.slice(0, 3)) {
    body.append(h('div.dl-risk', { role: 'note' }, h('span.dl-risk-stripe', { 'aria-hidden': 'true' }), icon('alert'), h('span', r.message || 'Overbooked day ahead.')));
  }
  if (!items.length) {
    body.append(h('div.empty.dl-empty', h('span.scrawl', 'Wide open.'), h('span', 'No deadlines in the next 30 days. Add one: ', h('code', 'poster due 10/20 ~3h'))));
  } else {
    body.append(h('div.dl-list', { role: 'list' }, visible.map((x) => row(x, ctx))));
    if (items.length > COMPACT_LIMIT) {
      body.append(h('button.btn.btn-ghost.btn-sm.dl-more', { type: 'button', onclick: () => ctx.setUI?.({ deadlinesAll: !showAll }) },
        icon(showAll ? 'chevron-up' : 'chevron-down'), showAll ? 'Show fewer' : `+${items.length - COMPACT_LIMIT} more`));
    }
  }
  return h('section.panel.deadlines', { 'aria-label': 'Incoming deadlines' }, head, body);
}
