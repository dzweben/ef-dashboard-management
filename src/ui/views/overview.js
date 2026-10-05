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

/** The first load failed (rejected token, offline, GitHub down): say so instead of LOADING… forever. */
function loadProblem(ctx) {
  const st = ctx?.store?.status;
  return st && (st.kind === 'error' || st.kind === 'offline') && st.message ? st : null;
}

function skeleton(area, ctx, problem) {
  const stuck = problem && area.key === 'today'
    ? h('div.skel-stuck', { role: 'alert' },
        h('p.skel-msg', problem.message),
        h('p.skel-actions',
          h('button.btn.btn-sm', { type: 'button', onclick: () => ctx.setTab?.('setup') }, icon('settings'), 'Setup'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => ctx.store?.refresh?.() }, icon('refresh'), 'Retry'),
        ))
    : null;
  return h('section.panel.skel', {
    'aria-busy': problem ? 'false' : 'true',
    'aria-label': `${area.label} ${problem ? 'not loaded' : 'loading'}`,
    class: [area.tall && 'is-tall', problem && 'is-stuck'].filter(Boolean).join(' '),
  },
    h('div.panel-head', h('h2', h('span.slash', '//'), area.label)),
    h('div.panel-body',
      problem
        ? h('p.skel-label', "CAN'T LOAD YET")
        : h('p.skel-label', 'LOADING', h('span.skel-dots', '…')),
      stuck,
      h('div.skel-bar'), h('div.skel-bar.is-short'), h('div.skel-bar'),
    ),
  );
}

export function renderOverview(ctx) {
  const loading = !ctx.loaded;
  const problem = loading ? loadProblem(ctx) : null;
  const grid = h('div.ov', { class: loading ? 'is-loading' : '' });
  for (const area of AREAS) {
    let node;
    if (loading) node = skeleton(area, ctx, problem);
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
