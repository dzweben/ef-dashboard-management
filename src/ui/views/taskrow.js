// One to-do row, shared by Today, Calendar, All, Projects and Deadlines.
// Grid: [check] [catmark] [title / meta chips] [actions].
import { h, catMark, catStyle, setDragData } from '../dom.js';
import { icon } from '../icons.js';
import { addDays, diffDays, fmtDay, fmtMinutes, fmtTime, fmtWeekday, isISODate, localDateOf, localTimeOf } from '../../engine/dates.js';

/** How long the row shows its X + stamp before the completion is committed. */
export const COMPLETE_DELAY_MS = 680;

const DONE_LINES = ['Done. Nice.', 'Off the list.', 'Crushed it.', 'Gone. Next.', 'Done. Keep rolling.'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const up = (s) => String(s ?? '').toUpperCase();

function hashPick(id, list) {
  let n = 0;
  for (const ch of String(id ?? '')) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return list[n % list.length];
}

function catOf(ctx, id) {
  if (ctx && typeof ctx.cat === 'function') return ctx.cat(id);
  return ctx?.state?.cats?.[id] ?? ctx?.state?.cats?.inbox ?? null;
}

function fineHover() {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

function chip(text, tone, iconName, title) {
  return h('span.chip', { class: tone ? `chip-${tone}` : '', title: title || null }, iconName ? icon(iconName) : null, text);
}

/** "DUE FRI", "DUE TODAY", "OVERDUE 3D", "DUE 10/16". */
export function dueChip(due, today) {
  if (!isISODate(due) || !isISODate(today)) return null;
  const n = diffDays(today, due);
  if (n < 0) return chip(`OVERDUE ${-n}D`, 'crit', null, `Was due ${fmtDay(due)}`);
  if (n === 0) return chip('DUE TODAY', 'hot', 'diamond');
  if (n === 1) return chip('DUE TMRW', 'warn', 'diamond', `Due ${fmtDay(due)}`);
  if (n <= 6) return chip(`DUE ${up(fmtWeekday(due))}`, n <= 2 ? 'warn' : '', 'diamond', `Due ${fmtDay(due)}`);
  return chip(`DUE ${up(fmtDay(due))}`, '', 'diamond');
}

/** Short day label relative to today: "TODAY", "TMRW", "FRI", "10/16". */
export function dayTag(iso, today) {
  if (!isISODate(iso)) return '';
  if (!isISODate(today)) return up(fmtDay(iso));
  const n = diffDays(today, iso);
  if (n === 0) return 'TODAY';
  if (n === 1) return 'TMRW';
  if (n === -1) return 'YDAY';
  if (n > 1 && n <= 6) return up(fmtWeekday(iso));
  return up(fmtDay(iso));
}

function metaChips(task, ctx, opts, flags) {
  const today = ctx.today;
  const tz = ctx.tz || ctx.state?.settings?.tz || 'America/New_York';
  const out = [];
  const { block, compact } = opts;
  const focus = Array.isArray(ctx.state?.brief?.focus) && ctx.state.brief.focus.includes(task.id);

  if (focus && !flags.done) out.push(chip('FOCUS', 'hot', 'target', 'Claude says start here'));
  if (block) {
    const bm = Math.max(0, Math.round(Number(block.m) || 0));
    out.push(chip(`BLOCK ${up(fmtMinutes(bm))}`, 'cyan', 'hourglass'));
    if (block.auto === false && !compact) out.push(chip('PINNED', '', null, 'Placed by hand; auto-plan leaves it alone'));
  }
  if (task.time && (task.kind === 'meeting' || task.kind === 'appt' || !block)) {
    const t = fmtTime(task.time);
    if (t) out.push(chip(up(t), 'cyan', 'clock'));
  }
  if (flags.done) {
    if (typeof task.doneAt === 'string') {
      const d = localDateOf(task.doneAt, tz);
      const tm = fmtTime(localTimeOf(task.doneAt, tz) ?? '');
      const when = d && d === today ? up(tm) : `${dayTag(d, today)}${tm && !compact ? ' ' + up(tm) : ''}`;
      if (when.trim()) out.push(chip(`DONE ${when}`.trim(), 'acid', 'check'));
    }
  } else if (!flags.dropped) {
    if (task.due && opts.context !== 'deadline') {
      const c = dueChip(task.due, today);
      if (c) out.push(c);
    }
    if (opts.carried && isISODate(task.plan)) {
      const n = isISODate(today) ? diffDays(task.plan, today) : 0;
      out.push(chip(`FROM ${n > 6 ? up(fmtDay(task.plan)) : up(fmtWeekday(task.plan))}`, '', 'undo', `Planned for ${fmtDay(task.plan)}`));
    } else if (opts.showDate && isISODate(task.plan) && !block) {
      out.push(chip(`DO ${dayTag(task.plan, today)}`, isISODate(today) && task.plan < today ? 'warn' : '', null, `Planned for ${fmtDay(task.plan)}`));
    }
  } else {
    out.push(chip('DROPPED', '', 'x'));
  }
  if (!block && isNum(task.est) && task.est > 0 && !flags.done) {
    const spent = isNum(task.spent) ? task.spent : 0;
    const rem = Math.max(0, task.est - spent);
    out.push(chip(spent > 0 ? `${up(fmtMinutes(rem))} LEFT` : up(fmtMinutes(task.est)), '', null, spent > 0 ? `${fmtMinutes(spent)} of ${fmtMinutes(task.est)} logged` : 'Estimate'));
  }
  const subs = Array.isArray(task.subs) ? task.subs.filter((x) => x && typeof x === 'object') : [];
  if (subs.length && !compact) {
    const n = subs.filter((x) => x.done === true).length;
    out.push(chip(`${n}/${subs.length}`, n === subs.length ? 'acid' : '', 'list', 'Subtasks done'));
  }
  const moved = isNum(task.moved) ? task.moved : 0;
  if (moved >= 1 && !flags.done && !compact) out.push(chip(`PUSHED ×${moved}`, moved >= 2 ? 'warn' : '', null, `Pushed to a later day ${moved} time${moved === 1 ? '' : 's'}`));
  if (task.project && opts.context !== 'project' && !compact) {
    const p = ctx.state?.projects?.[task.project];
    if (p && p.name) out.push(h('span.chip.chip-proj', { title: `Project: ${p.name}` }, icon('folder'), h('span.chip-trunc', p.name)));
  }
  if (task.win === true && !compact) out.push(chip('WIN', 'acid', 'star', 'Headline accomplishment'));
  return out;
}

function prioMark(task) {
  const p = isNum(task.prio) ? task.prio : 1;
  if (p >= 3) return h('span.trow-prio.is-crit', { title: 'Critical', 'aria-label': 'Critical priority' }, '!!!');
  if (p === 2) return h('span.trow-prio', { title: 'High priority', 'aria-label': 'High priority' }, '!!');
  return null;
}

function actBtn(label, iconName, onclick, extra = {}) {
  const { text, ...props } = extra;
  return h('button.btn.btn-sm.trow-btn', { type: 'button', title: label, 'aria-label': label, onclick, ...props },
    icon(iconName), text ? h('span.trow-btn-text', text) : null);
}

/**
 * taskRow(task, ctx, opts) → Element
 * opts: { block, context: today|calendar|all|project|deadline, showDate, compact, carried, overdue,
 *         triage (Yes / Today / Drop buttons instead of the usual actions), draggable (default true) }
 */
export function taskRow(task, ctx, opts = {}) {
  const t = task && typeof task === 'object' ? task : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const id = typeof t.id === 'string' ? t.id : '';
  const title = String(t.title ?? '').trim() || 'Untitled';
  const block = o.block && typeof o.block === 'object' ? o.block : null;
  const status = t.status ?? 'todo';
  const done = block ? block.done === true : status === 'done';
  const dropped = !block && status === 'dropped';
  const today = ctx?.today;
  const overdue = o.overdue ?? (!done && !dropped && isISODate(t.due) && isISODate(today) && t.due < today);
  const cat = catOf(ctx, t.cat);
  const canDrag = o.draggable !== false && !done && !dropped && !!id && fineHover();
  const prio = isNum(t.prio) ? t.prio : 1;

  const classes = [
    done && 'is-done',
    dropped && 'is-dropped',
    overdue && 'is-overdue',
    o.carried && 'is-carried',
    block && 'is-block',
    o.compact && 'is-compact',
    o.triage && 'is-triage',
    prio === 0 && 'is-low',
    o.context ? `in-${o.context}` : null,
  ].filter(Boolean).join(' ');

  const row = h('div.trow', {
    class: classes,
    role: 'listitem',
    style: catStyle(cat),
    dataset: { taskId: id || null, blockId: block?.id ?? null },
    draggable: canDrag ? 'true' : null,
  });

  const act = (name, args, actOpts) => (ctx && typeof ctx.act === 'function' ? ctx.act(name, args, actOpts) : Promise.resolve(null));

  // ---- check
  const label = block
    ? `Mark ${fmtMinutes(block.m)} block of "${title}" ${done ? 'not done' : 'done'}`
    : `Mark "${title}" ${done ? 'not done' : 'done'}`;
  const check = h('input.check', { type: 'checkbox', checked: done, disabled: dropped || !id, 'aria-label': label });
  let timer = null;
  check.addEventListener('change', () => {
    const checked = check.checked;
    const readOnly = ctx?.store && ctx.store.canWrite === false;
    const revert = (res) => {
      if (!res) {
        check.checked = !checked;
        row.classList.remove('is-completing');
      }
    };
    if (!checked && timer) {
      // un-ticked during the stamp: cancel the pending completion
      clearTimeout(timer);
      timer = null;
      row.classList.remove('is-completing');
      return;
    }
    if (readOnly) {
      act(block ? 'toggleBlock' : checked ? 'completeTask' : 'reopenTask', block ? { id, blockId: block.id } : { id }).then(revert);
      return;
    }
    if (checked) {
      row.classList.add('is-completing');
      ctx?.fx?.burst?.(row, 'var(--acid)');
      ctx?.fx?.stamp?.(row, block ? `+${up(fmtMinutes(block.m))}` : 'DONE');
      timer = setTimeout(() => {
        timer = null;
        const p = block
          ? act('toggleBlock', { id, blockId: block.id }, { toast: `Logged ${fmtMinutes(block.m)} on ${title}.`, undo: () => act('toggleBlock', { id, blockId: block.id }) })
          : act('completeTask', { id }, { toast: hashPick(id, DONE_LINES), undo: () => act('reopenTask', { id }) });
        Promise.resolve(p).then(revert, () => revert(null));
      }, COMPLETE_DELAY_MS);
    } else {
      const p = block
        ? act('toggleBlock', { id, blockId: block.id }, { toast: 'Block reopened.', kind: 'info' })
        : act('reopenTask', { id }, { toast: `Back on the list: ${title}`, kind: 'info' });
      Promise.resolve(p).then(revert, () => revert(null));
    }
  });
  const checkWrap = h('label.trow-check', check);

  // ---- title + meta
  const titleBtn = h('button.trow-title', {
    type: 'button',
    onclick: () => id && ctx?.openTask?.(id),
  }, prioMark(t), h('span.trow-text', title));

  const meta = metaChips(t, ctx ?? {}, o, { done, dropped });
  const metaEl = meta.length ? h('div.trow-meta', meta) : null;

  // ---- actions
  let acts = null;
  if (o.triage && !done && !dropped) {
    acts = h('div.trow-acts.is-pinned',
      actBtn('Yes, it happened', 'check', () => {
        ctx?.fx?.burst?.(row, 'var(--acid)');
        act('completeTask', { id }, { toast: `Logged: ${title}`, undo: () => act('reopenTask', { id }) });
      }, { text: 'Yes', class: 'is-yes' }),
      actBtn('Move to today', 'undo', () => act('moveTask', { id, to: today }, { toast: `${title} → today` }), { text: 'Today' }),
      actBtn('Drop it', 'x', () => act('dropTask', { id }, { toast: `Dropped: ${title}`, kind: 'info', undo: () => act('reopenTask', { id }) }), { text: 'Drop', class: 'is-drop' }),
    );
  } else if (!done && !dropped && id) {
    const buttons = [];
    if (o.carried && isISODate(today)) {
      const tmrw = addDays(today, 1);
      buttons.push(actBtn('Push to tomorrow', 'push', () => act('moveTask', { id, to: tmrw }, { toast: `${title} → tomorrow`, kind: 'info' }), { text: 'Tmrw', class: 'is-tmrw' }));
    }
    buttons.push(
      actBtn('Start 5 min', 'play', () => act('clockIn', { ref: `task:${id}`, title, cat: t.cat, goal: 5 }, { toast: `Clock's running: ${title}. Just 5 minutes.` }), { text: '5', class: 'is-clock' }),
      actBtn(block ? 'Move this block' : 'Push to another day', 'arrow-right', () => ctx?.openMove?.(id, block?.id ?? null), { class: 'is-move' }),
      actBtn('Edit', 'edit', () => ctx?.openTask?.(id), { class: 'is-edit' }),
    );
    acts = h('div.trow-acts', { class: o.carried ? 'has-tmrw' : '' }, buttons);
  }

  if (canDrag) {
    row.addEventListener('dragstart', (ev) => {
      try {
        setDragData(ev, { taskId: id, blockId: block?.id ?? null });
      } catch { /* no dataTransfer */ }
      row.classList.add('is-dragging');
      document.documentElement.classList.add('is-dragging-task');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-dragging-task');
    });
  }

  row.append(checkWrap, catMark(cat), titleBtn);
  if (metaEl) row.append(metaEl);
  if (acts) row.append(acts);
  if (!metaEl) row.classList.add('no-meta');
  return row;
}
