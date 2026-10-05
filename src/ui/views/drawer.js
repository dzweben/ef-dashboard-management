// Overlays: the task drawer, the move ("push it") sheet and the "just 5 minutes"
// clock sheet. main.js re-renders overlays on every state change, so:
//  - typed-but-uncommitted values live in ctx.ui.drawerDraft (mutated in place on
//    `input`, so typing never triggers a render) and are committed on change/blur;
//  - focus, caret and scroll position are restored by element id after mounting;
//  - the slide-in animation only plays when an overlay first opens.
import { h, catMark, catStyle, isReplacing, isSaneDate } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS, KINDS } from '../../engine/model.js';
import { addDays, diffDays, dow, fmtDay, fmtMinutes, fmtWeekday, isISODate, localDateOf, parseDuration, startOfWeek } from '../../engine/dates.js';
import { allocate, planStart } from '../../engine/schedule.js';
import { reopenUndo } from './taskrow.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const up = (x) => String(x ?? '').toUpperCase();
const PRIOS = [
  { v: 0, label: 'Low' },
  { v: 1, label: 'Normal' },
  { v: 2, label: 'High' },
  { v: 3, label: 'Crit' },
];
const KIND_LABELS = { task: 'To-do', deadline: 'Deadline', meeting: 'Meeting', appt: 'Appointment', email: 'Email', errand: 'Errand', reading: 'Reading', writing: 'Writing', analysis: 'Analysis' };

// ------------------------------------------------------------ shared overlay plumbing

function catOf(ctx, id) {
  return typeof ctx.cat === 'function' ? ctx.cat(id) : ctx.state?.cats?.[id] ?? null;
}

/** Snapshot of the overlay currently in the DOM (before main.js swaps it). */
function capture() {
  if (typeof document === 'undefined') return { key: null };
  const root = document.querySelector('.overlay-root');
  const active = document.activeElement;
  const inside = !!(root && active && root.contains(active) && active !== root);
  let sel = null;
  if (inside && typeof active.selectionStart === 'number' && active.type !== 'date' && active.type !== 'time') {
    try { sel = [active.selectionStart, active.selectionEnd]; } catch { sel = null; }
  }
  const body = root ? root.querySelector('.sheet-body') : null;
  return { key: root?.dataset?.key ?? null, focusId: inside ? active.id || null : null, sel, scroll: body ? body.scrollTop : 0 };
}

function restore(root, prev) {
  const run = () => {
    if (!root.isConnected) return;
    const same = prev.key === root.dataset.key;
    const body = root.querySelector('.sheet-body');
    if (same && body && prev.scroll) body.scrollTop = prev.scroll;
    if (same && prev.focusId) {
      const el = document.getElementById(prev.focusId);
      if (el && root.contains(el) && document.activeElement !== el) {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        if (prev.sel) {
          try { el.setSelectionRange(prev.sel[0], prev.sel[1]); } catch { /* not a text input */ }
        }
      }
    } else if (!same) {
      const sheet = root.querySelector('.sheet');
      try { sheet?.focus({ preventScroll: true }); } catch { sheet?.focus?.(); }
    }
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else Promise.resolve().then(run);
}

/** The overlay root: backdrop + sheet. `variant`: 'side' (drawer) | 'center' (move/clock). */
function shell(ctx, key, { label, variant = 'side', tone = 'pink', head, body, foot }) {
  const prev = capture();
  const fresh = prev.key !== key;
  const root = h('div.overlay-root', { class: `is-${variant}${fresh ? ' is-enter' : ''}`, dataset: { key } },
    h('button.overlay-backdrop', { type: 'button', 'aria-label': 'Close', tabIndex: -1, onclick: () => ctx.closeOverlay?.() }),
    h('div.sheet', { class: `is-${variant} tone-${tone}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabIndex: -1 },
      h('div.sheet-grip', { 'aria-hidden': 'true' }),
      head,
      h('div.sheet-body', body),
      foot ? h('div.sheet-foot', foot) : null,
    ),
  );
  restore(root, prev);
  return root;
}

function closeBtn(ctx) {
  return h('button.btn.btn-icon.btn-ghost.sheet-close', { type: 'button', id: 'ov-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => ctx.closeOverlay?.() }, icon('x'));
}

function missing(ctx, key, what) {
  return shell(ctx, key, {
    label: `${what} not found`,
    head: h('div.sheet-head', h('div.sheet-head-main', h('span.label.is-bracket', what), h('h2.sheet-title', 'Gone.')), closeBtn(ctx)),
    body: h('div.empty', h('span.scrawl', 'Nothing here.'), h('span', 'It was deleted or moved somewhere else.')),
  });
}

// ------------------------------------------------------------ drafts (ctx.ui.drawerDraft)

function draft(ctx, taskId) {
  const d = ctx.ui?.drawerDraft;
  return isObj(d) && d.taskId === taskId && isObj(d.values) ? d : null;
}
function readDraft(ctx, taskId, id, fallback) {
  const d = draft(ctx, taskId);
  return d && Object.prototype.hasOwnProperty.call(d.values, id) ? d.values[id] : fallback;
}
function writeDraft(ctx, taskId, id, value) {
  const ui = ctx.ui;
  if (!isObj(ui)) return;
  if (!draft(ctx, taskId)) ui.drawerDraft = { taskId, values: {} };
  ui.drawerDraft.values[id] = value;
}
function dropDraft(ctx, taskId, id) {
  const d = draft(ctx, taskId);
  if (d) delete d.values[id];
}

// Keys that edit a date input's segments (typing, not the picker).
const DATE_TYPING_KEYS = new Set(['Backspace', 'Delete', 'ArrowUp', 'ArrowDown']);

/**
 * A text-ish input whose in-progress value survives re-renders. `commit(next, el)`
 * runs on change / Enter / Escape when the value differs from what was last committed.
 * A change fired while a re-render swaps the field for its twin is ignored (dom.isReplacing):
 * the twin shows the draft, so nothing is lost and nothing half-typed is saved.
 *
 * type=date: Chromium fires `change` for every segment that completes a date while
 * typing (10/1 → 10/14 → year 0002 …), so typed dates commit on blur / Enter only, and
 * only when they are real dates (year 1900–2199); anything else reverts. A pick from the
 * native picker (no keys pressed) still commits right away. `required` refuses ''.
 */
function draftInput(ctx, taskId, { id, value, commit, type = 'text', multiline = false, required = false, ...attrs }) {
  const base = value ?? '';
  const isDate = type === 'date' && !multiline;
  const el = multiline
    ? h('textarea.field', { id, rows: 3, ...attrs })
    : h('input.field', { id, type, autocomplete: 'off', ...attrs });
  el.value = readDraft(ctx, taskId, id, base);
  let last = base;
  let typing = false;
  const doCommit = () => {
    if (isReplacing(el)) return;
    const next = el.value;
    typing = false;
    const partial = isDate && el.validity?.badInput === true; // e.g. 10/1_/____
    if (isDate && (partial || !isSaneDate(next, { required }))) {
      el.value = last;
      dropDraft(ctx, taskId, id);
      if (next || partial) ctx.toast?.("That date doesn't look right. Kept the old one.", { kind: 'error' });
      return;
    }
    dropDraft(ctx, taskId, id);
    if (next === last) return;
    last = next;
    commit(next, el);
  };
  el.addEventListener('input', () => writeDraft(ctx, taskId, id, el.value));
  if (isDate) {
    el.addEventListener('keydown', (e) => {
      if (/^\d$/.test(e.key) || DATE_TYPING_KEYS.has(e.key)) typing = true;
    });
    el.addEventListener('change', () => {
      if (!typing) doCommit();
    });
    el.addEventListener('blur', () => {
      // the window lost focus (app switch): the field keeps focus, typing resumes later
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return;
      doCommit();
    });
  } else {
    el.addEventListener('change', doCommit);
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') doCommit();
    else if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      doCommit();
    }
  });
  return el;
}

function fieldRow(id, label, control, extra) {
  return h('div.field-row.dr-field', h('label.label', { for: id }, label), control, extra ?? null);
}

// ------------------------------------------------------------ task drawer

function catSelect(ctx, task) {
  const cats = Object.values(ctx.state?.cats ?? {}).filter((c) => isObj(c) && (!c.archived || c.id === task.cat));
  const sel = h('select.field', { id: 'dr-cat' });
  const groups = [...GROUPS.map((g) => g.id), ...new Set(cats.map((c) => c.group).filter((g) => !GROUPS.some((x) => x.id === g)))];
  for (const gid of groups) {
    const inGroup = cats.filter((c) => (c.group ?? 'admin') === gid).sort((a, b) => (a.order ?? 500) - (b.order ?? 500) || String(a.name).localeCompare(String(b.name)));
    if (!inGroup.length) continue;
    const label = GROUPS.find((g) => g.id === gid)?.label ?? gid;
    sel.append(h('optgroup', { label }, inGroup.map((c) => h('option', { value: c.id, selected: c.id === task.cat }, c.name))));
  }
  if (![...sel.querySelectorAll('option')].some((o) => o.value === task.cat)) {
    sel.prepend(h('option', { value: task.cat ?? 'inbox', selected: true }, task.cat ?? 'inbox'));
  }
  sel.value = task.cat ?? 'inbox';
  sel.addEventListener('change', () => ctx.act('editTask', { id: task.id, patch: { cat: sel.value } }, { toast: `Filed under ${catOf(ctx, sel.value)?.name ?? sel.value}`, kind: 'info' }));
  return sel;
}

function kindSelect(ctx, task) {
  const sel = h('select.field', { id: 'dr-kind' }, KINDS.map((k) => h('option', { value: k, selected: k === task.kind }, KIND_LABELS[k] ?? k)));
  sel.value = KINDS.includes(task.kind) ? task.kind : 'task';
  sel.addEventListener('change', () => ctx.act('editTask', { id: task.id, patch: { kind: sel.value } }));
  return sel;
}

function projectSelect(ctx, task) {
  const projects = Object.values(ctx.state?.projects ?? {}).filter((p) => isObj(p) && (p.status !== 'done' || p.id === task.project));
  if (!projects.length && !task.project) return null;
  const sel = h('select.field', { id: 'dr-project' },
    h('option', { value: '', selected: !task.project }, '— none —'),
    projects.map((p) => h('option', { value: p.id, selected: p.id === task.project }, p.name)),
  );
  sel.value = task.project ?? '';
  sel.addEventListener('change', () => ctx.act('editTask', { id: task.id, patch: { project: sel.value || null } }));
  return fieldRow('dr-project', 'Project', sel);
}

function dateInput(ctx, task, id, field, label) {
  const el = draftInput(ctx, task.id, {
    id, type: 'date', value: isISODate(task[field]) ? task[field] : '',
    commit: (v) => ctx.act('editTask', { id: task.id, patch: { [field]: v || null } }, {
      toast: v ? `${label}: ${fmtDay(v)}` : `${label} cleared`, kind: 'info',
    }),
  });
  return fieldRow(id, label, el);
}

function prioButtons(ctx, task) {
  const p = isNum(task.prio) ? task.prio : 1;
  return h('div.field-row.dr-field',
    h('span.label', { id: 'dr-prio-label' }, 'Priority'),
    h('div.seg', { role: 'group', 'aria-labelledby': 'dr-prio-label' },
      PRIOS.map((x) => h('button.seg-btn', {
        type: 'button',
        id: `dr-prio-${x.v}`,
        class: `p${x.v}`,
        'aria-pressed': String(p === x.v),
        onclick: () => p !== x.v && ctx.act('editTask', { id: task.id, patch: { prio: x.v } }),
      }, x.label)),
    ),
  );
}

function subtasks(ctx, task) {
  const subs = arr(task.subs).filter(isObj);
  const doneN = subs.filter((x) => x.done === true).length;
  const add = (el) => {
    const t = el.value.trim();
    if (!t) return;
    el.value = '';
    dropDraft(ctx, task.id, 'dr-sub-new');
    ctx.act('addSub', { id: task.id, t });
  };
  const newInput = draftInput(ctx, task.id, {
    id: 'dr-sub-new', value: '', placeholder: 'add a step, hit enter',
    commit: (v, el) => add(el),
  });
  return h('section.dr-sec',
    h('div.dr-sec-head', h('span.label', '> Subtasks'), subs.length ? h('span.label', `${doneN}/${subs.length}`) : null),
    subs.length
      ? h('ul.dr-subs', subs.map((sub) => h('li.dr-sub', { class: sub.done ? 'is-done' : '' },
          h('input.check', {
            type: 'checkbox', id: `dr-sub-${sub.id}`, checked: sub.done === true, 'aria-label': `Step done: ${sub.t}`,
            onchange: () => ctx.act('toggleSub', { id: task.id, subId: sub.id }),
          }),
          h('label.dr-sub-t', { for: `dr-sub-${sub.id}` }, sub.t || '(empty)', isNum(sub.est) ? h('span.faint', ` · ${fmtMinutes(sub.est)}`) : null),
          h('button.btn.btn-icon.btn-sm.btn-ghost', { type: 'button', 'aria-label': `Remove step: ${sub.t}`, onclick: () => ctx.act('removeSub', { id: task.id, subId: sub.id }) }, icon('x')),
        )))
      : null,
    h('div.dr-inline', newInput,
      h('button.btn.btn-sm', { type: 'button', id: 'dr-sub-add', onclick: () => add(newInput) }, icon('plus'), 'Add')),
  );
}

function blocksSection(ctx, task) {
  const today = ctx.today;
  const blocks = arr(task.blocks).filter((b) => isObj(b) && isISODate(b.d)).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const est = isNum(task.est) ? task.est : null;
  const spent = isNum(task.spent) ? task.spent : 0;
  const rem = est === null ? null : Math.max(0, est - spent);
  const booked = blocks.filter((b) => b.done !== true && b.d >= today).reduce((n, b) => n + (isNum(b.m) ? b.m : 0), 0);
  const short = rem === null ? null : Math.max(0, rem - booked);
  const canPlan = est !== null && isISODate(task.due) && (task.status ?? 'todo') === 'todo';

  const autoPlan = () => {
    let res;
    try {
      res = allocate(ctx.state, { today, taskIds: [task.id], from: planStart(ctx.now, ctx.tz) });
    } catch (err) {
      ctx.toast?.(`Auto-plan failed: ${err?.message || err}`, { kind: 'error' });
      return;
    }
    const updates = isObj(res?.updates) ? res.updates : {};
    const risk = arr(res?.risks).find((r) => r.taskId === task.id)?.message;
    if (!Object.keys(updates).length) {
      ctx.toast?.(risk || 'Already planned. Nothing to change.', { kind: risk ? 'error' : 'info' });
      return;
    }
    const n = arr(updates[task.id]).filter((b) => b.done !== true && b.d >= today).length;
    ctx.act('applyAllocation', { updates }, { toast: `Booked ${n} block${n === 1 ? '' : 's'}.${risk ? ` ${risk}` : ''}` });
  };

  return h('section.dr-sec',
    h('div.dr-sec-head', h('span.label', '> Work blocks'),
      h('button.btn.btn-sm', {
        type: 'button', id: 'dr-autoplan', disabled: !canPlan, onclick: autoPlan,
        title: canPlan ? 'Spread the remaining work before the due date' : 'Needs an estimate and a due date',
      }, icon('bolt'), 'Auto-plan')),
    rem !== null && isISODate(task.due)
      ? h('div.dr-runway',
          h('span', 'left ', h('b', fmtMinutes(rem))),
          h('span', 'booked ', h('b', fmtMinutes(booked))),
          short > 0 ? h('span.is-hot', 'short ', h('b', fmtMinutes(short))) : h('span.is-good', 'covered'),
        )
      : h('p.dr-hint', 'Add an estimate and a due date, then auto-plan books time before the deadline.'),
    blocks.length
      ? h('ul.dr-blocks', blocks.map((b) => {
          const past = b.d < today && b.done !== true;
          return h('li.dr-block', { class: `${b.done ? 'is-done' : ''}${past ? ' is-past' : ''}` },
            h('input.check', {
              type: 'checkbox', id: `dr-blk-c-${b.id}`, checked: b.done === true, 'aria-label': `Block on ${fmtDay(b.d)} done`,
              onchange: () => ctx.act('toggleBlock', { id: task.id, blockId: b.id }),
            }),
            draftInput(ctx, task.id, {
              id: `dr-blk-d-${b.id}`, type: 'date', value: b.d, 'aria-label': 'Block date', required: true,
              commit: (v) => ctx.act('moveBlock', { id: task.id, blockId: b.id, to: v }, { toast: `Block → ${fmtDay(v)}`, kind: 'info' }),
            }),
            h('span.dr-block-m', fmtMinutes(b.m)),
            h('span.chip', { class: b.auto === false ? 'chip-cyan' : '', title: b.auto === false ? 'Placed by hand: auto-plan keeps it' : 'Placed by auto-plan' }, b.auto === false ? 'PINNED' : 'AUTO'),
            h('button.btn.btn-icon.btn-sm.btn-ghost', {
              type: 'button', 'aria-label': `Remove block on ${fmtDay(b.d)}`,
              onclick: () => ctx.act('editTask', { id: task.id, patch: { blocks: arr(task.blocks).filter((x) => x !== b) } }, { toast: 'Block removed.', kind: 'info' }),
            }, icon('x')),
          );
        }))
      : null,
  );
}

function estField(ctx, task) {
  const est = isNum(task.est) ? task.est : null;
  const spent = isNum(task.spent) ? task.spent : 0;
  const el = draftInput(ctx, task.id, {
    id: 'dr-est', value: est === null ? '' : fmtMinutes(est), placeholder: 'e.g. 45m, 1h30', inputmode: 'text',
    commit: (v, input) => {
      const t = v.trim();
      if (!t) {
        ctx.act('editTask', { id: task.id, patch: { est: null } });
        return;
      }
      const m = parseDuration(t);
      if (m === null) {
        ctx.toast?.(`Didn't get "${t}". Try 45m, 1h30 or 2h.`, { kind: 'error' });
        input.value = est === null ? '' : fmtMinutes(est);
        return;
      }
      ctx.act('editTask', { id: task.id, patch: { est: m } }, { toast: `Estimate: ${fmtMinutes(m)}`, kind: 'info' });
    },
  });
  const readout = spent > 0 || est !== null
    ? h('span.dr-est-read', `spent ${fmtMinutes(spent)}`, est !== null ? ` · left ${fmtMinutes(Math.max(0, est - spent))}` : '')
    : null;
  return fieldRow('dr-est', 'Estimate', el, readout);
}

function actions(ctx, task) {
  const status = task.status ?? 'todo';
  const title = task.title || 'Task';
  const out = [];
  // Edits save as you go; this just closes the sheet. (A plain "Done" here read as
  // "done editing" and checked tasks off by accident.)
  out.push(h('button.btn.btn-hot.dr-act-close', { type: 'button', id: 'dr-close', onclick: () => ctx.closeOverlay?.() }, 'Save + close'));
  if (status === 'todo') {
    out.push(h('button.btn.btn-acid.dr-act-done', {
      type: 'button', id: 'dr-done',
      onclick: (e) => {
        ctx.fx?.burst?.(e.currentTarget, 'var(--acid)');
        ctx.fx?.stamp?.(e.currentTarget, 'DONE');
        ctx.closeOverlay?.();
        ctx.act('completeTask', { id: task.id }, { toast: 'Done. Nice.', undo: reopenUndo(ctx.act, task) });
      },
    }, icon('check'), 'Mark complete'));
    out.push(h('button.btn', { type: 'button', id: 'dr-clock', onclick: () => { ctx.closeOverlay?.(); ctx.act('clockIn', { ref: `task:${task.id}`, title, cat: task.cat, goal: 5 }, { toast: `Clock's running: ${title}. Just 5 minutes.` }); } }, icon('play'), '5 min'));
    out.push(h('button.btn', { type: 'button', id: 'dr-move', onclick: () => ctx.openMove?.(task.id) }, icon('arrow-right'), 'Push'));
    out.push(h('button.btn.btn-ghost', { type: 'button', id: 'dr-drop', onclick: () => { ctx.closeOverlay?.(); ctx.act('dropTask', { id: task.id }, { toast: `Dropped: ${title}`, kind: 'info', undo: reopenUndo(ctx.act, task) }); } }, icon('x'), 'Drop'));
  } else {
    out.push(h('button.btn', { type: 'button', id: 'dr-reopen', onclick: () => ctx.act('reopenTask', { id: task.id }, { toast: `Back on the list: ${title}`, kind: 'info' }) }, icon('undo'), status === 'done' ? 'Reopen' : 'Restore'));
  }
  return out;
}

function deleteButton(ctx, task) {
  const confirming = ctx.ui?.drawerConfirm === task.id;
  const title = task.title || 'Task';
  return h('button.btn.btn-sm.dr-delete', {
    type: 'button', id: 'dr-delete', class: confirming ? 'is-confirm' : '',
    onclick: () => {
      if (!confirming) {
        ctx.setUI?.({ drawerConfirm: task.id });
        return;
      }
      ctx.setUI?.({ drawerConfirm: null, drawer: null, drawerDraft: null });
      ctx.act('deleteTask', { id: task.id }, { toast: `Deleted: ${title}`, kind: 'info' });
    },
  }, icon('trash'), confirming ? 'Really delete?' : 'Delete');
}

export function renderDrawer(ctx) {
  const taskId = ctx.ui?.drawer?.taskId;
  const key = `drawer:${taskId}`;
  const task = taskId ? ctx.state?.tasks?.[taskId] : null;
  if (!isObj(task)) return missing(ctx, key, 'Task');
  const cat = catOf(ctx, task.cat);
  const status = task.status ?? 'todo';
  const tz = ctx.tz || ctx.state?.settings?.tz || 'America/New_York';

  const titleEl = draftInput(ctx, task.id, {
    id: 'dr-title', value: task.title ?? '', class: 'dr-title-input', 'aria-label': 'Title',
    commit: (v, el) => {
      const t = v.trim();
      if (!t) {
        ctx.toast?.("A to-do needs a title.", { kind: 'error' });
        el.value = task.title ?? '';
        return;
      }
      ctx.act('editTask', { id: task.id, patch: { title: t } });
    },
  });
  const timeEl = draftInput(ctx, task.id, {
    id: 'dr-time', type: 'time', value: task.time ?? '',
    commit: (v) => ctx.act('editTask', { id: task.id, patch: { time: v || null } }),
  });
  const notesEl = draftInput(ctx, task.id, {
    id: 'dr-notes', multiline: true, value: task.notes ?? '', placeholder: 'notes, links, the first tiny step…',
    commit: (v) => ctx.act('editTask', { id: task.id, patch: { notes: v } }),
  });

  const head = h('div.sheet-head', { style: catStyle(cat) },
    catMark(cat),
    h('div.sheet-head-main',
      h('span.label', `task // ${task.id}`),
      h('div.sheet-head-chips',
        h('span.chip', { class: status === 'done' ? 'chip-acid' : status === 'dropped' ? '' : 'chip-hot' }, up(status === 'todo' ? 'open' : status)),
        task.triage ? h('span.chip.chip-warn', 'TRIAGE') : null,
        isNum(task.moved) && task.moved > 0 ? h('span.chip', { class: task.moved >= 2 ? 'chip-warn' : '' }, `PUSHED ×${task.moved}`) : null,
        h('span.chip.dr-cat-chip', h('i.catdot', { style: catStyle(cat) }), up(cat?.name ?? task.cat)),
      ),
    ),
    closeBtn(ctx),
  );

  const created = typeof task.created === 'string' ? localDateOf(task.created, tz) : null;
  const doneDay = typeof task.doneAt === 'string' ? localDateOf(task.doneAt, tz) : null;
  const body = [
    h('div.dr-title-wrap', h('span.dr-title-prompt', { 'aria-hidden': 'true' }, '>'), titleEl),
    h('div.dr-grid.cols-2',
      fieldRow('dr-cat', 'Category', catSelect(ctx, task)),
      fieldRow('dr-kind', 'Kind', kindSelect(ctx, task)),
    ),
    h('div.dr-grid.cols-3',
      dateInput(ctx, task, 'dr-plan', 'plan', 'Do on'),
      dateInput(ctx, task, 'dr-due', 'due', 'Due'),
      fieldRow('dr-time', 'Time', timeEl),
    ),
    h('div.dr-grid.cols-2.is-stack',
      estField(ctx, task),
      prioButtons(ctx, task),
    ),
    projectSelect(ctx, task),
    fieldRow('dr-notes', 'Notes', notesEl),
    subtasks(ctx, task),
    blocksSection(ctx, task),
    h('div.dr-end',
      h('p.dr-meta',
        created ? `added ${fmtDay(created)}` : null,
        task.src ? ` · via ${task.src}` : null,
        doneDay ? ` · done ${fmtDay(doneDay)}` : null,
      ),
      deleteButton(ctx, task),
    ),
  ];

  return shell(ctx, key, {
    label: `Task: ${task.title}`,
    variant: 'side',
    tone: status === 'done' ? 'acid' : 'pink',
    head,
    body,
    foot: actions(ctx, task),
  });
}

// ------------------------------------------------------------ move sheet

function quickPicks(today) {
  const nextMon = addDays(startOfWeek(today, 'mon'), 7);
  const d = dow(today);
  const sat = d === 6 ? today : d === 0 ? today : addDays(today, 6 - d);
  return [
    { label: 'Today', d: today },
    { label: 'Tomorrow', d: addDays(today, 1) },
    { label: '+2 days', d: addDays(today, 2) },
    { label: 'Next Mon', d: nextMon },
    { label: 'This weekend', d: sat },
  ];
}

export function renderMoveSheet(ctx) {
  const mv = ctx.ui?.move ?? {};
  const key = `move:${mv.taskId}:${mv.blockId ?? ''}`;
  const task = mv.taskId ? ctx.state?.tasks?.[mv.taskId] : null;
  if (!isObj(task)) return missing(ctx, key, 'Task');
  const block = mv.blockId ? arr(task.blocks).find((b) => isObj(b) && b.id === mv.blockId) : null;
  if (mv.blockId && !block) return missing(ctx, key, 'Block');
  const today = ctx.today;
  const current = block ? block.d : isISODate(task.plan) ? task.plan : null;
  const title = task.title || 'Task';
  const cat = catOf(ctx, task.cat);

  const pick = (d) => {
    if (!isISODate(d) && d !== null) return;
    ctx.closeOverlay?.();
    const label = d === null ? 'backlog' : d === today ? 'today' : fmtDay(d);
    const verb = d && current && d > current ? 'Pushed to' : 'Moved to';
    if (block) ctx.act('moveBlock', { id: task.id, blockId: block.id, to: d }, { toast: `Block ${verb.toLowerCase()} ${label}`, kind: 'info' });
    else ctx.act('moveTask', { id: task.id, to: d }, { toast: `${verb} ${label}: ${title}`, kind: 'info' });
  };

  const picks = quickPicks(today).map((q) => h('button.mv-quick', {
    type: 'button', id: `mv-q-${q.label.replace(/\W+/g, '').toLowerCase()}`, onclick: () => pick(q.d),
    'aria-current': q.d === current ? 'date' : null,
  }, h('span.mv-quick-label', q.label), h('span.mv-quick-date', fmtDay(q.d))));

  const days = arr(ctx.vm?.cal).map((c) => {
    const load = c.load ?? {};
    const cap = isNum(load.cap) ? load.cap : 0;
    const total = isNum(load.total) ? load.total : 0;
    const ratio = cap > 0 ? total / cap : total > 0 ? 2 : 0;
    const tone = ratio > 1.3 ? 'is-crit' : ratio > 1 ? 'is-hot' : ratio > 0.75 ? 'is-warn' : '';
    return h('button.mv-day', {
      type: 'button', id: `mv-d-${c.d}`,
      class: [c.isToday && 'is-today', c.isWeekend && 'is-weekend', c.isOff && 'is-off', c.d === current && 'is-current'].filter(Boolean).join(' '),
      'aria-current': c.d === current ? 'date' : null,
      'aria-label': `${fmtDay(c.d)}, ${fmtMinutes(total)} of ${fmtMinutes(cap)} booked`,
      onclick: () => pick(c.d),
    },
      h('span.mv-day-wd', c.isToday ? 'TDY' : up(fmtWeekday(c.d))),
      h('span.mv-day-n', c.d.slice(8).replace(/^0/, '')),
      h('div.meter', { class: tone }, h('i', { style: { width: `${Math.min(100, Math.round(ratio * 100))}%` } })),
    );
  });

  // The picked date lives on the ctx.ui.move object itself (mutated in place, so
  // picking never triggers a render) and survives re-renders until Move is tapped.
  const picked = typeof ctx.ui?.move?.date === 'string' ? ctx.ui.move.date : null;
  const dateEl = h('input.field', { id: 'mv-date', type: 'date', min: today, value: picked ?? current ?? '' });
  const remember = () => {
    if (isObj(ctx.ui?.move)) ctx.ui.move.date = dateEl.value;
  };
  dateEl.addEventListener('input', remember);
  dateEl.addEventListener('change', remember);
  const go = () => {
    const v = dateEl.value;
    if (!v) return;
    if (dateEl.validity?.badInput || !isSaneDate(v, { required: true })) {
      ctx.toast?.("That date doesn't look right.", { kind: 'error' });
      return;
    }
    pick(v);
  };
  dateEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });

  const head = h('div.sheet-head', { style: catStyle(cat) },
    catMark(cat),
    h('div.sheet-head-main',
      h('span.label', block ? `move block // ${fmtMinutes(block.m)}` : 'push it'),
      h('h2.sheet-title', title),
      h('span.mv-now', current ? `now: ${fmtDay(current)}${diffDays(today, current) < 0 ? ` (${-diffDays(today, current)}d ago)` : ''}` : 'now: no date (backlog)'),
    ),
    closeBtn(ctx),
  );

  const body = [
    h('div.mv-quicks', picks),
    h('div.mv-cal-head', h('span.label', '> next 14 days'), h('span.label', 'bar = booked vs capacity')),
    h('div.mv-days', days),
    h('div.mv-custom',
      h('label.label', { for: 'mv-date' }, 'Pick a date'),
      h('div.dr-inline', dateEl, h('button.btn.btn-hot', { type: 'button', id: 'mv-go', onclick: go }, icon('arrow-right'), 'Move')),
    ),
    !block && current
      ? h('button.btn.btn-ghost.mv-backlog', { type: 'button', id: 'mv-backlog', onclick: () => pick(null) }, icon('inbox'), 'No date (backlog)')
      : null,
  ];

  return shell(ctx, key, { label: `Move ${title}`, variant: 'center', tone: 'cyan', head, body });
}

// ------------------------------------------------------------ clock sheet ("just 5 minutes")

function suggestionList(ctx) {
  const out = [];
  const seen = new Set();
  for (const info of arr(ctx.vm?.chores)) {
    if (!info || !info.due || !isObj(info.chore)) continue;
    const c = info.chore;
    const every = isNum(c.every) ? c.every : 7;
    let why;
    if (every === 1) why = `daily ${info.todayCount ?? 0}/${c.perDay ?? 1}`;
    else if (info.daysSince == null) why = 'never logged';
    else why = info.daysSince > every ? `${info.daysSince - every}d late` : 'due';
    out.push({ ref: `chore:${c.id}`, title: c.title, cat: c.cat, why: `chore · ${why}`, kind: 'chore', min: isNum(c.min) ? c.min : 5 });
  }
  const vt = ctx.vm?.today ?? {};
  const add = (t, why) => {
    if (!isObj(t) || seen.has(t.id) || (t.status ?? 'todo') !== 'todo') return;
    seen.add(t.id);
    out.push({ ref: `task:${t.id}`, title: t.title, cat: t.cat, why, kind: 'task' });
  };
  for (const t of arr(vt.overdue)) add(t, 'overdue');
  for (const t of arr(vt.dueToday)) add(t, 'due today');
  for (const x of arr(vt.blocks)) add(x?.task, 'work block today');
  for (const t of arr(vt.planned)) add(t, 'planned today');
  for (const t of arr(vt.carried)) add(t, 'rolled over');
  return out.slice(0, 7);
}

function refInfo(ctx, ref) {
  const m = String(ref ?? '').match(/^(task|chore):(.+)$/);
  if (!m) return null;
  const doc = m[1] === 'task' ? ctx.state?.tasks?.[m[2]] : ctx.state?.chores?.[m[2]];
  if (!isObj(doc)) return null;
  return { ref, title: doc.title, cat: doc.cat, kind: m[1], min: m[1] === 'chore' && isNum(doc.min) ? doc.min : 5 };
}

export function renderClockSheet(ctx) {
  const ref = ctx.ui?.clockSheet?.ref ?? null;
  const key = `clock:${ref ?? ''}`;
  const chosen = isNum(ctx.ui?.clockGoal) ? ctx.ui.clockGoal : null;
  const goal = chosen ?? 5;
  const running = ctx.state?.clock?.active ? ctx.state.clock : null;
  const goalFor = (s) => chosen ?? (s.kind === 'chore' ? s.min : 5);

  const start = (s) => {
    const title = String(s.title || '').trim() || 'Focus';
    const g = goalFor(s);
    ctx.closeOverlay?.();
    ctx.act('clockIn', { ref: s.ref, title, cat: s.cat, goal: g }, { toast: `Clock's running: ${title}. ${g} minutes.` });
  };

  const primary = ref ? refInfo(ctx, ref) : null;
  const sugg = suggestionList(ctx).filter((s) => !primary || s.ref !== primary.ref);

  const freeEl = h('input.field', { id: 'ck-free', type: 'text', placeholder: 'something else… (desk reset, inbox)', autocomplete: 'off' });
  const freeKey = 'ck-free';
  freeEl.value = readDraft(ctx, '__clock', freeKey, '');
  freeEl.addEventListener('input', () => writeDraft(ctx, '__clock', freeKey, freeEl.value));
  const startFree = () => {
    const t = freeEl.value.trim();
    if (!t) {
      freeEl.focus();
      return;
    }
    dropDraft(ctx, '__clock', freeKey);
    start({ ref: 'free', title: t, cat: 'inbox', kind: 'free' });
  };
  freeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startFree(); } });

  const head = h('div.sheet-head',
    h('span.ck-head-icon', icon('timer')),
    h('div.sheet-head-main',
      h('span.label', 'clock in'),
      h('h2.sheet-title.ck-title', h('span.shout', `${goal} minutes.`), ' ', h('span.scrawl', "That's it.")),
    ),
    closeBtn(ctx),
  );

  const body = [
    h('p.ck-sub', 'Starting is the whole trick. Pick one, the clock does the rest. Stop any time.'),
    h('div.ck-goal',
      h('span.label', { id: 'ck-goal-label' }, 'Goal'),
      h('div.seg', { role: 'group', 'aria-labelledby': 'ck-goal-label' },
        [5, 10, 15, 25].map((g) => h('button.seg-btn', {
          type: 'button', id: `ck-goal-${g}`, 'aria-pressed': String(goal === g),
          onclick: () => ctx.setUI?.({ clockGoal: g }),
        }, `${g}m`)),
      ),
    ),
    running ? h('p.ck-running', icon('alert'), ` Running now: ${running.title}. Starting another stops it and logs the time.`) : null,
    primary
      ? h('button.ck-primary', { type: 'button', id: 'ck-primary', style: catStyle(catOf(ctx, primary.cat)), onclick: () => start(primary) },
          icon('play'), h('span.ck-primary-text', h('span.label', 'start'), h('span.ck-primary-title', primary.title)))
      : null,
    sugg.length
      ? h('div.ck-list', { role: 'list' },
          sugg.map((s, i) => {
            const cat = catOf(ctx, s.cat);
            return h('button.ck-item', { type: 'button', role: 'listitem', id: `ck-s-${i}`, style: catStyle(cat), onclick: () => start(s) },
              catMark(cat),
              h('span.ck-item-main', h('span.ck-item-title', s.title), h('span.ck-item-why', { class: s.kind === 'chore' ? 'is-chore' : '' }, s.why)),
              h('span.ck-item-go', icon('play'), `${goalFor(s)}m`),
            );
          }))
      : h('div.empty', h('span.scrawl', 'Nothing due.'), h('span', 'Type anything below and start.')),
    h('div.ck-free',
      h('label.label', { for: 'ck-free' }, '> something else'),
      h('div.dr-inline', freeEl, h('button.btn.btn-hot', { type: 'button', id: 'ck-free-go', onclick: startFree }, icon('play'), 'Start')),
    ),
  ];

  return shell(ctx, key, { label: 'Clock in for 5 minutes', variant: 'center', tone: 'pink', head, body });
}
