// The accomplishments wall: streak, this week, a 12-week acid heatmap, per-category bars, wins list.
import { h, catStyle } from '../dom.js';
import { fmtDay, fmtMinutes, isISODate, localDateOf, diffDays } from '../../engine/dates.js';
import { catOf, goTab, ic } from './setup.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WD_MON = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WD_SUN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const LIST_STEP = 60;

/** Heat level 0–4 for a count, scaled to the busiest day (min step 1). */
export function heatLevel(count, max) {
  const c = Math.max(0, Number(count) || 0);
  if (c === 0) return 0;
  const step = Math.max(1, Math.ceil(Math.max(4, Number(max) || 0) / 4));
  return Math.min(4, Math.max(1, Math.ceil(c / step)));
}

/** Split the heatmap (oldest first; first cell starts a week) into week columns of 7. */
export function heatWeeks(cells) {
  const list = Array.isArray(cells) ? cells.filter((c) => c && isISODate(c.d)) : [];
  const weeks = [];
  for (let i = 0; i < list.length; i += 7) weeks.push(list.slice(i, i + 7));
  return weeks;
}

/** Group wins (newest first) by local day: [{ d, items }]. */
export function winsByDay(list, tz) {
  const out = [];
  let cur = null;
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || typeof w.at !== 'string') continue;
    let d;
    try { d = localDateOf(w.at, tz || 'America/New_York'); } catch { d = w.at.slice(0, 10); }
    if (!isISODate(d)) d = w.at.slice(0, 10);
    if (!cur || cur.d !== d) {
      cur = { d, items: [] };
      out.push(cur);
    }
    cur.items.push(w);
  }
  return out;
}

function dayLabel(d, today) {
  if (!isISODate(d) || !isISODate(today)) return d || '';
  const n = diffDays(d, today);
  if (n === 0) return 'TODAY';
  if (n === 1) return 'YESTERDAY';
  return fmtDay(d).toUpperCase();
}

function heatmapGrid(ctx, { compact }) {
  const cells = Array.isArray(ctx?.vm?.heatmap) ? ctx.vm.heatmap : [];
  const weeks = heatWeeks(cells);
  const today = ctx?.today;
  const max = cells.reduce((m, c) => Math.max(m, Number(c?.count) || 0), 0);
  const sunStart = ctx?.state?.settings?.weekStart === 'sun';
  const wd = sunStart ? WD_SUN : WD_MON;
  let prevMonth = -1;
  const monthRow = weeks.map((w, i) => {
    const m = Number(w[0].d.slice(5, 7)) - 1;
    const show = m !== prevMonth && (i > 0 || Number(w[0].d.slice(8, 10)) <= 7 || weeks.length < 3);
    const label = m !== prevMonth ? MONTHS[m] : '';
    prevMonth = m;
    return h('span.wins-hm-m', show ? label : '');
  });

  const cols = weeks.map((w) =>
    h('div.wins-hm-col', Array.from({ length: 7 }, (_, r) => {
      const c = w[r];
      if (!c) return h('i.wins-hm-cell.is-void', { 'aria-hidden': 'true' });
      const lvl = heatLevel(c.count, max);
      const isToday = c.d === today;
      const parts = [`${fmtDay(c.d)}: ${c.count} done`];
      if (c.minutes) parts.push(`${fmtMinutes(c.minutes)} logged`);
      return h('i.wins-hm-cell', {
        class: `l${lvl}${isToday ? ' is-today' : ''}`,
        title: parts.join(' · '),
        'aria-label': parts.join(', '),
        role: 'img',
      });
    })),
  );

  const total = cells.reduce((s, c) => s + (Number(c?.count) || 0), 0);
  const activeDays = cells.filter((c) => (Number(c?.count) || 0) > 0 || (Number(c?.minutes) || 0) > 0).length;

  return h('div.wins-hm', { class: compact ? 'is-compact' : '' },
    h('div.wins-hm-head',
      h('span.label', `${weeks.length} weeks`),
      h('span.wins-hm-sum', h('b', String(total)), ' done · ', h('b', String(activeDays)), ' active days'),
    ),
    h('div.wins-hm-body', { style: { '--weeks': String(Math.max(1, weeks.length)) } },
      h('span.wins-hm-corner', { 'aria-hidden': 'true' }),
      h('div.wins-hm-months', { 'aria-hidden': 'true' }, monthRow),
      h('div.wins-hm-wd', { 'aria-hidden': 'true' }, wd.map((x, i) => h('span', i % 2 === 0 ? x : ''))),
      h('div.wins-hm-grid', { role: 'group', 'aria-label': `Completions per day, last ${weeks.length} weeks` }, cols),
    ),
    h('div.wins-hm-key', { 'aria-hidden': 'true' },
      h('span.label', 'less'),
      [0, 1, 2, 3, 4].map((l) => h('i.wins-hm-cell', { class: `l${l}` })),
      h('span.label', 'more'),
    ),
  );
}

function streakBlock(ctx, { compact }) {
  const st = ctx?.vm?.streak ?? { current: 0, best: 0 };
  const cur = Math.max(0, Number(st.current) || 0);
  const best = Math.max(cur, Number(st.best) || 0);
  const isRecord = cur > 0 && cur >= best;
  return h('div.wins-streak', { class: [cur ? 'is-live' : 'is-zero', compact && 'is-compact'].filter(Boolean).join(' ') },
    h('span.label.is-bracket', 'streak'),
    h('div.wins-streak-n',
      h('b.shout', String(cur)),
      h('span.wins-streak-u', cur === 1 ? 'DAY' : 'DAYS'),
    ),
    h('div.wins-streak-side',
      h('p.wins-streak-best',
        isRecord && cur > 1 ? h('span.wins-record', 'PERSONAL BEST') : h('span', `best ${best} days`),
      ),
      cur === 0 ? h('p.scrawl.wins-quip', 'one tiny win starts it.') : cur < best ? h('p.wins-streak-to', `${best - cur + 1} more to beat it`) : null,
    ),
  );
}

/** Tasks done in the week before this one, from the heatmap's previous column (null if unknown). */
export function lastWeekDone(cells) {
  const weeks = heatWeeks(cells);
  if (weeks.length < 2) return null;
  return weeks[weeks.length - 2].reduce((s, c) => s + (Number.isFinite(c?.tasks) ? c.tasks : Number(c?.count) || 0), 0);
}

function weekBlock(ctx) {
  const wk = ctx?.vm?.week ?? {};
  const prev = lastWeekDone(ctx?.vm?.heatmap);
  const stat = (n, label, cls = '', foot = null) => h('div.wins-stat', { class: cls }, h('b.shout', n), h('span.label', label), foot ? h('span.wins-stat-foot', foot) : null);
  return h('div.wins-week',
    h('span.label.is-bracket', 'this week'),
    h('div.wins-stats',
      stat(String(Number(wk.done) || 0), 'done', 'is-acid', prev != null ? `last wk ${prev}` : null),
      stat(fmtMinutes(Number(wk.minutes) || 0).replace(' ', ''), 'clocked'),
      stat(String(Number(wk.chores) || 0), 'chores'),
      stat(String(Array.isArray(wk.wins) ? wk.wins.length : 0), 'big wins', 'is-pink'),
    ),
  );
}

/** Tasks done per category over the last `days` local days (today included), from the wins list. */
export function recentByCat(winsList, today, tz, days = 7) {
  const out = {};
  if (!isISODate(today)) return out;
  for (const w of Array.isArray(winsList) ? winsList : []) {
    if (!w || w.kind !== 'task' || typeof w.at !== 'string') continue;
    let d;
    try { d = localDateOf(w.at, tz || 'America/New_York'); } catch { continue; }
    if (!isISODate(d)) continue;
    const n = diffDays(d, today);
    if (n < 0 || n > days - 1) continue;
    const c = w.cat || 'inbox';
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

function catBars(ctx) {
  let by = ctx?.vm?.week?.byCat && typeof ctx.vm.week.byCat === 'object' ? ctx.vm.week.byCat : {};
  let span = 'this week';
  const tz = ctx?.tz || ctx?.state?.settings?.tz;
  for (const days of [7, 30]) {
    if (Object.values(by).some((n) => Number(n) > 0)) break;
    by = recentByCat(ctx?.vm?.wins, ctx?.today, tz, days);
    span = `last ${days} days`;
  }
  const rows = Object.entries(by).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]);
  const max = rows.reduce((m, [, n]) => Math.max(m, n), 0);
  return h('div.wins-cats',
    h('h3.wins-sub-h', h('span.slash', '//'), 'Where it went', h('span.label', span)),
    rows.length
      ? h('ul.wins-cat-list', rows.map(([id, n]) => {
          const cat = catOf(ctx, id);
          const pct = max ? Math.max(4, Math.round((n / max) * 100)) : 0;
          return h('li.wins-cat', { style: catStyle(cat) },
            h('span.wins-cat-name', h('span.catdot', { style: catStyle(cat) }), cat.name || id),
            h('span.wins-cat-bar', { 'aria-hidden': 'true' }, h('i', { style: { width: `${pct}%` } })),
            h('b.wins-cat-n', String(n)),
          );
        }))
      : h('p.faint.wins-none', 'Nothing checked off in the last 30 days. Tiny wins count.'),
  );
}

function winRow(ctx, w, { showDay = false, today } = {}) {
  const cat = catOf(ctx, w.cat);
  const tz = ctx?.tz || ctx?.state?.settings?.tz || 'America/New_York';
  let d = '';
  try { d = localDateOf(w.at, tz); } catch { d = ''; }
  const milestone = w.kind === 'milestone';
  return h('li.wins-row', { class: [milestone && 'is-milestone', w.win && 'is-win'].filter(Boolean).join(' '), style: catStyle(cat) },
    h('span.wins-tick', { 'aria-hidden': 'true' }, milestone ? '⚑' : w.win ? '★' : '✓'),
    h('span.wins-row-t',
      h('span.wins-row-title', w.title || 'Done'),
      milestone && w.project ? h('span.wins-row-proj', w.project) : null,
    ),
    milestone ? h('span.wins-stamp', 'MILESTONE') : w.win ? h('span.wins-stamp.is-win', 'WIN') : null,
    h('span.wins-row-cat', { title: cat.name }, h('span.catdot', { style: catStyle(cat) })),
    showDay && d ? h('span.wins-row-d', dayLabel(d, today)) : null,
  );
}

function winsList(ctx) {
  const all = Array.isArray(ctx?.vm?.wins) ? ctx.vm.wins : [];
  const limit = Math.max(LIST_STEP, Number(ctx?.ui?.winsLimit) || LIST_STEP);
  const shown = all.slice(0, limit);
  const tz = ctx?.tz || ctx?.state?.settings?.tz || 'America/New_York';
  const groups = winsByDay(shown, tz);
  return h('section.panel.wins-log', { 'aria-labelledby': 'wins-log-h' },
    h('header.panel-head',
      h('h2#wins-log-h', h('span.slash', '//'), 'The record'),
      h('span.label.is-bracket', `${all.length} all time`),
    ),
    h('div.panel-body',
      groups.length
        ? h('div.wins-days', groups.map((g) =>
            h('section.wins-day',
              h('h3.wins-day-h', h('span.tape', dayLabel(g.d, ctx?.today)), h('span.label', `${g.items.length} done`)),
              h('ul.wins-rows', g.items.map((w) => winRow(ctx, w))),
            )))
        : h('div.empty', h('p.scrawl', 'The wall is blank.'), h('p', 'Check something off. It lands here.')),
      all.length > shown.length
        ? h('button.btn.wins-more', { type: 'button', onclick: () => ctx?.setUI?.({ winsLimit: limit + LIST_STEP }) }, `Show ${Math.min(LIST_STEP, all.length - shown.length)} more`)
        : null,
    ),
  );
}

/** renderWins(ctx, { compact = false }) → Element */
export function renderWins(ctx, opts = {}) {
  const compact = !!(opts && opts.compact);
  const loaded = ctx?.loaded !== false;

  if (compact) {
    const recent = (Array.isArray(ctx?.vm?.wins) ? ctx.vm.wins : []).slice(0, 5);
    return h('section.panel.wins.is-compact', { 'aria-labelledby': 'wins-h' },
      h('header.panel-head',
        h('h2#wins-h', h('span.slash', '//'), 'Wins'),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => goTab(ctx, 'wins') }, 'The wall', ic(ctx, 'arrow-right')),
      ),
      h('div.panel-body',
        !loaded
          ? h('p.label', 'LOADING…')
          : h('div.wins-compact',
              streakBlock(ctx, { compact: true }),
              heatmapGrid(ctx, { compact: true }),
              h('div.wins-recent',
                h('span.label.is-bracket', 'latest'),
                recent.length
                  ? h('ul.wins-rows', recent.map((w) => winRow(ctx, w, { showDay: true, today: ctx?.today })))
                  : h('p.faint.wins-none', 'Nothing yet. First check-off lands here.'),
              ),
            ),
      ),
    );
  }

  return h('div.wins-view',
    h('section.panel.is-acid.wins-hero', { 'aria-labelledby': 'wins-h' },
      h('header.panel-head',
        h('h2#wins-h', h('span.slash', '//'), 'Wins'),
        h('span.label.is-bracket', 'proof you did stuff'),
      ),
      h('div.panel-body',
        !loaded
          ? h('p.label', 'LOADING…')
          : h('div.wins-hero-grid',
              streakBlock(ctx, { compact: false }),
              weekBlock(ctx),
              heatmapGrid(ctx, { compact: false }),
              catBars(ctx),
            ),
      ),
    ),
    loaded ? winsList(ctx) : null,
  );
}
