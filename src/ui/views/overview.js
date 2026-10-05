// The default tab: Today + Claude's brief + chores up top, the rolling 14 days,
// deadlines and projects, then the wins wall. Each panel renders in isolation
// so one broken panel never blanks the whole page.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { renderToday } from './today.js';
import { renderBrief } from './brief.js';
import { renderDeadlines } from './deadlines.js';
import { renderCalendar } from './calendar.js';
import { renderChores } from './chores.js';
import { renderProjects } from './projects.js';
import { renderWins } from './wins.js';

const AREAS = [
  { key: 'today', label: 'Today', render: (ctx) => renderToday(ctx), tall: true },
  { key: 'brief', label: 'Claude says', render: (ctx) => renderBrief(ctx) },
  { key: 'chores', label: 'Chores', render: (ctx) => renderChores(ctx, { compact: true }) },
  { key: 'cal', label: '14 days', render: (ctx) => renderCalendar(ctx, { days: 14, compact: true }), tall: true },
  { key: 'dead', label: 'Incoming', render: (ctx) => renderDeadlines(ctx) },
  { key: 'proj', label: 'Projects', render: (ctx) => renderProjects(ctx, { compact: true }) },
  { key: 'wins', label: 'Wins', render: (ctx) => renderWins(ctx, { compact: true }) },
];

function crashed(area, err) {
  if (typeof console !== 'undefined') console.error(`[overview:${area.key}]`, err);
  return h('section.panel.ov-crash', { role: 'alert' },
    h('div.panel-head', h('h2', h('span.slash', '//'), area.label)),
    h('div.panel-body',
      h('p.label', icon('alert'), ' panel crashed'),
      h('p.ov-crash-msg', String(err?.message || err || 'Unknown error')),
    ),
  );
}

function skeleton(area) {
  return h('section.panel.skel', { 'aria-busy': 'true', 'aria-label': `${area.label} loading`, class: area.tall ? 'is-tall' : '' },
    h('div.panel-head', h('h2', h('span.slash', '//'), area.label)),
    h('div.panel-body',
      h('p.skel-label', 'LOADING', h('span.skel-dots', '…')),
      h('div.skel-bar'), h('div.skel-bar.is-short'), h('div.skel-bar'),
    ),
  );
}

export function renderOverview(ctx) {
  const loading = !ctx.loaded;
  const grid = h('div.ov', { class: loading ? 'is-loading' : '' });
  for (const area of AREAS) {
    let node;
    if (loading) node = skeleton(area);
    else {
      try {
        node = area.render(ctx);
      } catch (err) {
        node = crashed(area, err);
      }
    }
    grid.append(h('div.ov-cell', { class: `ov-${area.key}` }, node || null));
  }
  return grid;
}
