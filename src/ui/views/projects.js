// Long-term projects, kept light: progress, milestones, next step, countdown.
import { h, catStyle } from '../dom.js';
import { GROUPS } from '../../engine/model.js';
import { diffDays, fmtDay, fmtMinutes, isISODate } from '../../engine/dates.js';
import { taskRow } from './taskrow.js';
import { catOf, draftClear, draftGet, draftSet, goTab, ic, keepFocus } from './setup.js';

const COMPACT_MAX = 4;
const BAR_SEGS = 20;
const TASKS_MAX = 6;
const KIND_LABEL = { project: 'PROJECT', role: 'ROLE', course: 'COURSE' };

/** Countdown to a date: { n, label, tone: 'late'|'hot'|'warn'|'calm' } or null. */
export function countdown(due, today) {
  if (!isISODate(due) || !isISODate(today)) return null;
  const n = diffDays(today, due);
  if (n < 0) return { n, label: `${-n}D LATE`, tone: 'late' };
  if (n === 0) return { n, label: 'TODAY', tone: 'hot' };
  if (n <= 7) return { n, label: `${n}D`, tone: 'hot' };
  if (n <= 14) return { n, label: `${n}D`, tone: 'warn' };
  return { n, label: `${n}D`, tone: 'calm' };
}

/** Projects with status "done" straight from state (projectView only lists active + paused). */
export function doneProjects(state) {
  return Object.values(state?.projects ?? {})
    .filter((p) => p && typeof p === 'object' && p.status === 'done')
    .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
}

function segBar(pct, cls = '') {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const lit = Math.round((p / 100) * BAR_SEGS);
  return h('div.proj-bar', { class: cls, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p), 'aria-label': `${p}% done` },
    Array.from({ length: BAR_SEGS }, (_, i) => h('i', { class: i < lit ? 'on' : '' })));
}

function dueBlock(p, today) {
  const cd = countdown(p.due, today);
  if (!cd) return null;
  return h('div.proj-due', { class: `is-${cd.tone}`, title: `Due ${fmtDay(p.due)}` },
    h('b.shout', cd.label),
    h('span.label', cd.tone === 'late' ? `was due ${fmtDay(p.due)}` : `due ${fmtDay(p.due)}`),
  );
}

function nextLine(row, today) {
  const m = row.nextMilestone;
  if (!m) {
    return row.msTotal
      ? h('p.proj-next.is-clear', h('span.proj-next-k', 'ALL MILESTONES DONE'))
      : h('p.proj-next.is-none', h('span.proj-next-k', 'NEXT'), h('span.faint', 'no milestones yet'));
  }
  const cd = countdown(m.due, today);
  return h('p.proj-next',
    h('span.proj-next-k', 'NEXT ▸'),
    h('span.proj-next-t', m.t || 'Milestone'),
    m.due ? h('span.chip', { class: cd?.tone === 'late' ? 'chip-crit' : cd?.tone === 'hot' ? 'chip-hot' : cd?.tone === 'warn' ? 'chip-warn' : '' }, `${fmtDay(m.due)}${cd ? ` · ${cd.label}` : ''}`) : null,
  );
}

function milestoneList(ctx, p, row) {
  const ms = Array.isArray(p.milestones) ? p.milestones.filter((m) => m && typeof m === 'object') : [];
  const nextId = row?.nextMilestone?.id ?? null;
  const today = ctx?.today;
  const items = ms.map((m) => {
    const cd = countdown(m.due, today);
    const id = `ms-${p.id}-${m.id}`;
    return h('li.proj-ms', { class: [m.done && 'is-done', m.id === nextId && 'is-next'].filter(Boolean).join(' ') },
      h(`input.check#${id}`, {
        type: 'checkbox',
        checked: m.done === true,
        'aria-label': `${m.t}: ${m.done ? 'done' : 'not done'}`,
        onchange: (e) => {
          const nowDone = e.currentTarget.checked;
          if (nowDone) {
            const li = e.currentTarget.closest('.proj-ms') ?? e.currentTarget;
            try { ctx?.fx?.burst?.(li, 'var(--acid)'); } catch { /* decoration */ }
            try { ctx?.fx?.stamp?.(li, 'MILESTONE'); } catch { /* decoration */ }
          }
          ctx?.act?.('toggleMilestone', { id: p.id, msId: m.id }, {
            toast: nowDone ? `Milestone: ${m.t}` : `${m.t}: reopened`,
            undo: () => ctx?.act?.('toggleMilestone', { id: p.id, msId: m.id }),
          });
        },
      }),
      h('label.proj-ms-t', { for: id }, m.t || 'Milestone'),
      m.id === nextId ? h('span.proj-ms-next', 'NEXT') : null,
      m.due && !m.done
        ? h('span.proj-ms-due', { class: cd ? `is-${cd.tone}` : '' }, `${fmtDay(m.due)}${cd ? ` · ${cd.label}` : ''}`)
        : null,
    );
  });

  const key = `ms.add.${p.id}`;
  const addForm = h('form.proj-ms-add', {
    onsubmit: async (e) => {
      e.preventDefault();
      const t = String(draftGet(ctx, key, '')).trim();
      if (!t) return;
      const res = await ctx?.act?.('addMilestone', { id: p.id, t }, { toast: `Milestone added: ${t}` });
      if (res && res.writes && res.writes.length) {
        draftClear(ctx, key);
        ctx?.rerender?.();
      }
    },
  },
    h('span.proj-ms-plus', { 'aria-hidden': 'true' }, '+'),
    h(`input.field#ms-add-${p.id}`, {
      value: draftGet(ctx, key, ''),
      placeholder: 'add a milestone',
      'aria-label': `Add a milestone to ${p.name}`,
      autocomplete: 'off',
      oninput: (e) => draftSet(ctx, key, e.currentTarget.value),
    }),
    h('button.btn.btn-sm', { type: 'submit' }, 'Add'),
  );

  return h('div.proj-ms-wrap',
    items.length ? h('ol.proj-ms-list', items) : h('p.faint.proj-ms-none', 'No milestones yet. Add the first one.'),
    addForm,
  );
}

function linkedTasks(ctx, p) {
  const open = Object.values(ctx?.state?.tasks ?? {})
    .filter((t) => t && t.project === p.id && (t.status ?? 'todo') === 'todo')
    .sort((a, b) =>
      String(a.due ?? a.plan ?? '9999').localeCompare(String(b.due ?? b.plan ?? '9999')) ||
      (Number(b.prio) || 0) - (Number(a.prio) || 0));
  if (!open.length) return null;
  const shown = open.slice(0, TASKS_MAX);
  return h('div.proj-tasks',
    h('h4.proj-sub-h', h('span.label', `open to-dos · ${open.length}`)),
    h('div.proj-task-list', shown.map((t) => taskRow(t, ctx, { context: 'project', showDate: true, compact: true }))),
    open.length > shown.length
      ? h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => goTab(ctx, 'all') }, `+${open.length - shown.length} more in All`)
      : null,
  );
}

function statusButtons(ctx, p) {
  const set = (status, msg) => ctx?.act?.('editProject', { id: p.id, patch: { status } }, {
    toast: msg,
    undo: () => ctx?.act?.('editProject', { id: p.id, patch: { status: p.status } }),
  });
  if (p.status === 'paused') {
    return [
      h('button.btn.btn-sm', { type: 'button', onclick: () => set('active', `${p.name} is back on.`) }, ic(ctx, 'play'), 'Resume'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => set('done', `${p.name}: shipped.`) }, ic(ctx, 'check'), 'Done'),
    ];
  }
  if (p.status === 'done') {
    return [h('button.btn.btn-sm', { type: 'button', onclick: () => set('active', `${p.name} reopened.`) }, ic(ctx, 'undo'), 'Reopen')];
  }
  return [
    h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => set('paused', `${p.name} paused. It'll keep.`) }, ic(ctx, 'pause'), 'Pause'),
    h('button.btn.btn-sm.btn-ghost', {
      type: 'button',
      onclick: (e) => {
        const card = e.currentTarget.closest('.proj-card') ?? e.currentTarget;
        try { ctx?.fx?.stamp?.(card, 'SHIPPED'); } catch { /* decoration */ }
        set('done', `${p.name}: shipped.`);
      },
    }, ic(ctx, 'flag'), 'Mark done'),
  ];
}

function card(ctx, row, { compact }) {
  const p = row.project;
  const cat = catOf(ctx, p.cat);
  const today = ctx?.today;
  const pct = Math.max(0, Math.min(100, Math.round(Number(row.pct) || 0)));
  const paused = p.status === 'paused';
  const counts = [
    row.msTotal ? `${row.msDone}/${row.msTotal} milestones` : null,
    row.tasksOpen ? `${row.tasksOpen} open` : null,
    row.tasksDone ? `${row.tasksDone} done` : null,
    row.remainingMin ? `${fmtMinutes(row.remainingMin)} left` : null,
    row.allocatedMin ? `${fmtMinutes(row.allocatedMin)} blocked` : null,
  ].filter(Boolean);

  return h('article.proj-card', {
    class: [compact && 'is-compact', paused && 'is-paused', pct >= 100 && 'is-full'].filter(Boolean).join(' '),
    style: catStyle(cat),
    'aria-label': `${p.name}: ${pct}% done`,
  },
    h('header.proj-card-head',
      h('div.proj-id',
        h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat.glyph || '··'),
        h('div.proj-id-t',
          h('span.proj-kind', `${KIND_LABEL[p.kind] ?? 'PROJECT'}${paused ? ' · PAUSED' : ''} · ${(cat.name || '').toUpperCase()}`),
          h('h3.proj-name', p.name || 'Untitled project'),
        ),
      ),
      dueBlock(p, today),
    ),
    p.goal && !compact ? h('p.proj-goal', p.goal) : null,
    h('div.proj-progress',
      h('b.proj-pct.shout', String(pct), h('small', '%')),
      h('div.proj-progress-r',
        segBar(pct),
        counts.length ? h('p.proj-counts', counts.join(' · ')) : null,
      ),
    ),
    compact ? nextLine(row, today) : milestoneList(ctx, p, row),
    compact ? null : linkedTasks(ctx, p),
    compact ? null : h('footer.proj-card-foot', statusButtons(ctx, p)),
  );
}

function addProjectForm(ctx) {
  const cats = Object.values(ctx?.state?.cats ?? {}).filter((c) => c && c.id && !c.archived);
  const byGroup = GROUPS.map((g) => ({ g, cats: cats.filter((c) => c.group === g.id).sort((a, b) => String(a.name).localeCompare(String(b.name))) })).filter((x) => x.cats.length);
  const name = draftGet(ctx, 'proj.add.name', '');
  const catId = draftGet(ctx, 'proj.add.cat', 'inbox');
  return h('form.proj-add', {
    onsubmit: async (e) => {
      e.preventDefault();
      const n = String(draftGet(ctx, 'proj.add.name', '')).trim();
      if (!n) {
        ctx?.toast?.('Name the project first.', { kind: 'error' });
        return;
      }
      const res = await ctx?.act?.('addProject', { name: n, cat: draftGet(ctx, 'proj.add.cat', 'inbox') }, { toast: `New project: ${n}` });
      if (res && res.writes && res.writes.length) {
        draftClear(ctx, 'proj.add.name');
        ctx?.rerender?.();
      }
    },
  },
    h('span.proj-add-k', { 'aria-hidden': 'true' }, '+ NEW'),
    h('input.field#proj-add-name', {
      value: name,
      placeholder: 'project name: e.g. Predissertation proposal',
      'aria-label': 'New project name',
      autocomplete: 'off',
      oninput: (e) => draftSet(ctx, 'proj.add.name', e.currentTarget.value),
    }),
    h('select.field#proj-add-cat', {
      'aria-label': 'Category',
      onchange: (e) => draftSet(ctx, 'proj.add.cat', e.currentTarget.value),
    },
      h('option', { value: 'inbox', selected: catId === 'inbox' }, 'Inbox'),
      byGroup.map(({ g, cats: list }) => h('optgroup', { label: g.label }, list.filter((c) => c.id !== 'inbox').map((c) => h('option', { value: c.id, selected: c.id === catId }, c.name)))),
    ),
    h('button.btn.btn-hot', { type: 'submit' }, ic(ctx, 'plus'), 'Add project'),
  );
}

/** renderProjects(ctx, { compact = false }) → Element */
export function renderProjects(ctx, opts = {}) {
  const compact = !!(opts && opts.compact);
  const restore = keepFocus();
  const rows = Array.isArray(ctx?.vm?.projects) ? ctx.vm.projects.filter((r) => r && r.project) : [];
  const active = rows.filter((r) => r.project.status === 'active');
  const paused = rows.filter((r) => r.project.status === 'paused');
  const loaded = ctx?.loaded !== false;

  if (compact) {
    const shown = active.slice(0, COMPACT_MAX);
    const root = h('section.panel.proj.is-compact', { 'aria-labelledby': 'proj-h' },
      h('header.panel-head',
        h('h2#proj-h', h('span.slash', '//'), 'Projects'),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => goTab(ctx, 'projects') }, `All ${active.length + paused.length}`, ic(ctx, 'arrow-right')),
      ),
      h('div.panel-body',
        !loaded
          ? h('p.label', 'LOADING…')
          : shown.length
            ? h('div.proj-grid.is-compact', shown.map((r) => card(ctx, r, { compact: true })))
            : h('div.empty', h('p.scrawl', 'No long-game projects.'), h('p', 'Ask Claude to set one up, or add one on the Projects tab.')),
      ),
    );
    return root;
  }

  const done = doneProjects(ctx?.state);
  const root = h('div.proj-view',
    h('section.panel.proj.is-full', { 'aria-labelledby': 'proj-h' },
      h('header.panel-head',
        h('div.proj-head-t',
          h('h2#proj-h', h('span.slash', '//'), 'Projects'),
          h('p.proj-sub', 'The long game. Light touch: progress, next step, countdown.'),
        ),
        h('div.proj-head-n',
          h('b.shout', String(active.length)), h('span.label', 'active'),
          paused.length ? [h('b.shout.is-dim', String(paused.length)), h('span.label', 'paused')] : null,
        ),
      ),
      h('div.panel-body',
        !loaded
          ? h('p.label', 'LOADING…')
          : active.length
            ? h('div.proj-grid', active.map((r) => card(ctx, r, { compact: false })))
            : h('div.empty', h('p.scrawl', 'Nothing in the long game.'), h('p', 'Add a project below. Milestones keep it honest.')),
        addProjectForm(ctx),
      ),
    ),
    paused.length
      ? h('section.panel.proj.is-paused-sec', { 'aria-labelledby': 'proj-paused-h' },
          h('header.panel-head', h('h2#proj-paused-h', h('span.slash', '//'), 'On ice'), h('span.label.is-bracket', `${paused.length} paused`)),
          h('div.panel-body', h('div.proj-grid', paused.map((r) => card(ctx, r, { compact: false })))),
        )
      : null,
    done.length
      ? h('section.panel.proj.is-done-sec', { 'aria-labelledby': 'proj-done-h' },
          h('header.panel-head', h('h2#proj-done-h', h('span.slash', '//'), 'Shipped'), h('span.label.is-bracket', `${done.length} done`)),
          h('div.panel-body',
            h('ul.proj-done-list', done.map((p) => {
              const cat = catOf(ctx, p.cat);
              return h('li.proj-done', { style: catStyle(cat) },
                h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat.glyph || '··'),
                h('span.proj-done-name', p.name),
                h('span.proj-done-stamp', 'SHIPPED'),
                statusButtons(ctx, p),
              );
            })),
          ),
        )
      : null,
  );
  restore(root);
  return root;
}
