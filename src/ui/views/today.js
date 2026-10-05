// The Today panel: the running list for today, in the order Danny should face it.
import { h, getDragData, DRAG_MIME } from '../dom.js';
import { icon } from '../icons.js';
import { taskRow } from './taskrow.js';
import { fmtDay, fmtMinutes } from '../../engine/dates.js';

const EMPTY_VM = { overdue: [], dueToday: [], meetings: [], planned: [], carried: [], blocks: [], triage: [], chores: [], doneToday: [], counts: { open: 0, done: 0, total: 0 } };
const arr = (v) => (Array.isArray(v) ? v : []);
const pad2 = (n) => String(Math.max(0, n | 0)).padStart(2, '0');

const SECTIONS = [
  { key: 'triage', label: 'Did these happen?', tone: 'hazard', icon: 'alert', opts: { triage: true }, hint: 'yes / today / drop' },
  { key: 'overdue', label: 'Overdue', tone: 'crit', icon: 'skull', opts: { overdue: true }, hazard: true },
  { key: 'dueToday', label: 'Due today', tone: 'hot', icon: 'diamond' },
  { key: 'meetings', label: 'Meetings', tone: 'cyan', icon: 'clock' },
  { key: 'planned', label: 'Planned', tone: 'ink', icon: 'target' },
  { key: 'blocks', label: 'Work blocks', tone: 'cyan', icon: 'hourglass' },
  { key: 'carried', label: 'Rolled over', tone: 'faint', icon: 'undo', opts: { carried: true } },
];

function hasEfDrag(ev) {
  try {
    const types = Array.from(ev.dataTransfer?.types ?? []);
    return types.includes(DRAG_MIME) || types.includes('text/plain');
  } catch {
    return false;
  }
}

/** Make `el` accept dropped tasks/blocks and move them to today. */
export function todayDropTarget(el, ctx) {
  el.addEventListener('dragover', (ev) => {
    if (!hasEfDrag(ev)) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    el.classList.add('is-drop');
  });
  el.addEventListener('dragleave', (ev) => {
    if (!ev.relatedTarget || !el.contains(ev.relatedTarget)) el.classList.remove('is-drop');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('is-drop');
    const p = getDragData(ev);
    if (!p || !p.taskId) return;
    const title = ctx.state?.tasks?.[p.taskId]?.title ?? 'Task';
    if (p.blockId) ctx.act('moveBlock', { id: p.taskId, blockId: p.blockId, to: ctx.today }, { toast: `Block → today: ${title}` });
    else ctx.act('moveTask', { id: p.taskId, to: ctx.today }, { toast: `${title} → today` });
  });
  return el;
}

function section(def, rows, extra) {
  return h('section.tsec', { class: `tone-${def.tone}`, 'aria-label': def.label },
    def.hazard ? h('div.hazard.tsec-hazard', { 'aria-hidden': 'true' }) : null,
    h('div.tsec-head',
      icon(def.icon),
      h('h3.tsec-label', def.label),
      def.hint ? h('span.tsec-hint', def.hint) : null,
      h('span.tsec-rule', { 'aria-hidden': 'true' }),
      h('span.tsec-count', { 'aria-label': `${rows.length} items` }, pad2(rows.length)),
    ),
    h('div.tsec-list', { role: 'list' }, rows),
    extra ?? null,
  );
}

/** LED meter: done / total. */
export function ledMeter(value, max, { tone = '', label = '' } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  return h('div.meter', {
    class: tone ? `is-${tone}` : '',
    role: 'meter',
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.max(0, Math.round(max))),
    'aria-valuenow': String(Math.max(0, Math.round(value))),
    'aria-label': label || null,
  }, h('i', { style: { width: `${pct.toFixed(1)}%` } }));
}

export function renderToday(ctx) {
  const vm = { ...EMPTY_VM, ...(ctx.vm?.today ?? {}) };
  const counts = vm.counts ?? EMPTY_VM.counts;
  const open = Math.max(0, counts.open ?? 0);
  const doneN = arr(vm.doneToday).length;
  const total = Math.max(open + doneN, counts.total ?? 0);
  const load = arr(ctx.vm?.cal)[0]?.load ?? null;

  // ---- head (drop target: drop → today)
  const head = h('div.panel-head.today-head',
    h('div.today-title',
      h('h2', h('span.slash', '//'), 'Today'),
      h('span.tape.today-tape', fmtDay(ctx.today) || 'TODAY'),
    ),
    h('div.today-score', { title: `${doneN} done of ${total} today` },
      h('span.today-num.shout', h('b', String(doneN)), h('span.today-of', '/'), String(total)),
      h('span.label', 'done'),
      ledMeter(doneN, total, { tone: total && doneN >= total ? '' : 'cyan', label: 'Done today' }),
    ),
    h('span.today-drop-hint', { 'aria-hidden': 'true' }, icon('arrow-down'), 'drop → today'),
  );
  todayDropTarget(head, ctx);

  const body = h('div.panel-body.today-body');

  // ---- sections
  let shown = 0;
  for (const def of SECTIONS) {
    const items = arr(vm[def.key]);
    if (!items.length) continue;
    shown += items.length;
    const rows = def.key === 'blocks'
      ? items.filter((x) => x && x.task).map(({ task, block }) => taskRow(task, ctx, { context: 'today', block }))
      : items.filter(Boolean).map((t) => taskRow(t, ctx, { context: 'today', ...(def.opts ?? {}) }));
    body.append(section(def, rows));
  }

  // ---- empty state
  if (!shown) {
    body.append(h('div.today-empty',
      h('div.sticker.today-sticker',
        h('p.scrawl', 'Clear board.'),
        h('p.today-empty-sub', doneN ? `${doneN} done today. That counts.` : 'Nothing on deck for today.'),
        h('p.today-empty-hint', 'Type a to-do up top: ', h('code', 'email mike - tomorrow')),
      ),
    ));
  }

  // ---- done today (collapsed by default)
  if (doneN) {
    const openDone = !!ctx.ui?.todayDoneOpen;
    const toggle = h('button.tsec-toggle', {
      type: 'button',
      'aria-expanded': String(openDone),
      onclick: () => ctx.setUI?.({ todayDoneOpen: !openDone }),
    },
      icon('check'),
      h('span.tsec-label', 'Done today'),
      h('span.tsec-rule', { 'aria-hidden': 'true' }),
      h('span.tsec-count', pad2(doneN)),
      icon(openDone ? 'chevron-up' : 'chevron-down'),
    );
    body.append(h('section.tsec.tone-acid.tsec-done', { 'aria-label': 'Done today' },
      toggle,
      openDone ? h('div.tsec-list', { role: 'list' }, arr(vm.doneToday).map((t) => taskRow(t, ctx, { context: 'today' }))) : null,
    ));
  }

  // ---- footer readout
  const foot = h('div.today-foot',
    h('span', h('b', String(open)), ' open'),
    h('span.sep', '//'),
    h('span', h('b', String(doneN)), ' done'),
    load && Number.isFinite(load.cap)
      ? [h('span.sep', '//'), h('span', { class: load.cap > 0 && load.total > load.cap ? 'is-hot' : '' }, 'load ', h('b', fmtMinutes(load.total)), ` / ${fmtMinutes(load.cap)}`)]
      : null,
  );

  return h('section.panel.is-pink.today', { 'aria-label': 'Today' }, head, body, foot);
}
