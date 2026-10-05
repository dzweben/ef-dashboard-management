// Chores: the recurring stuff, with a decay fuse, DID IT, and "just 5 minutes".
import { h, catStyle } from '../dom.js';
import { fmtRelative } from '../../engine/dates.js';
import { catOf, draftClear, draftGet, draftSet, goTab, ic, keepFocus } from './setup.js';

const FUSE_SEGS = 8;
const COMPACT_MAX = 8;

/** "DAILY", "DAILY ×2", "WEEKLY", "EVERY 2W", "MONTHLY", "EVERY 3D". */
export function cadenceLabel(chore) {
  const every = Math.max(1, Math.round(Number(chore?.every) || 7));
  const perDay = Math.max(1, Math.round(Number(chore?.perDay) || 1));
  if (every === 1) return perDay > 1 ? `DAILY ×${perDay}` : 'DAILY';
  if (every === 7) return 'WEEKLY';
  if (every === 14) return 'EVERY 2W';
  if (every === 30 || every === 31) return 'MONTHLY';
  if (every % 7 === 0) return `EVERY ${every / 7}W`;
  return `EVERY ${every}D`;
}

/**
 * Visual state of one choreView row:
 * { tone: 'fresh'|'soon'|'due'|'over'|'done', lit (0..FUSE_SEGS), text, last }.
 * acid fresh → hazard due → blood overdue.
 */
export function choreState(row, today) {
  const c = row?.chore ?? {};
  const every = Math.max(1, Math.round(Number(c.every) || 7));
  const perDay = every === 1 ? Math.max(1, Math.round(Number(c.perDay) || 1)) : 1;
  const todayCount = Math.max(0, Number(row?.todayCount) || 0);
  const since = Number.isFinite(row?.daysSince) ? row.daysSince : null;
  const last = since == null ? 'never logged' : since === 0 ? 'last: today' : since === 1 ? 'last: yesterday' : `last: ${since}d ago`;
  if (since == null && row?.due === false && row?.nextDue && today && row.nextDue > today) {
    // a new chore set to start later ("laundry every week - sat")
    return { tone: 'fresh', lit: 0, text: `STARTS ${String(fmtRelative(row.nextDue, today)).toUpperCase()}`, last };
  }
  if (every === 1) {
    const done = Math.min(todayCount, perDay);
    if (done >= perDay) return { tone: 'done', lit: FUSE_SEGS, text: 'DONE TODAY', last, pips: { done, of: perDay } };
    return { tone: 'due', lit: Math.round((done / perDay) * FUSE_SEGS), text: `${done}/${perDay} TODAY`, last, pips: { done, of: perDay } };
  }
  if (since == null) return { tone: 'due', lit: FUSE_SEGS, text: 'DUE', last };
  const u = since / every;
  const lit = Math.max(since > 0 ? 1 : 0, Math.min(FUSE_SEGS, Math.ceil(u * FUSE_SEGS)));
  const over = since - every;
  if (over > 0) return { tone: 'over', lit: FUSE_SEGS, text: `OVERDUE ${over}D`, last };
  if (over === 0) return { tone: 'due', lit: FUSE_SEGS, text: 'DUE TODAY', last };
  const next = row?.nextDue && today ? fmtRelative(row.nextDue, today) : `in ${-over}d`;
  return { tone: u >= 0.7 ? 'soon' : 'fresh', lit, text: `NEXT ${String(next).toUpperCase()}`, last };
}

function fuse(st) {
  if (st.pips) {
    return h('span.chore-pips', { 'aria-hidden': 'true' },
      Array.from({ length: Math.min(st.pips.of, 12) }, (_, i) => h('i', { class: i < st.pips.done ? 'on' : '' })));
  }
  return h('span.chore-fuse', { 'aria-hidden': 'true' },
    Array.from({ length: FUSE_SEGS }, (_, i) => h('i', { class: i < st.lit ? 'on' : '' })));
}

function choreTile(ctx, row, { compact }) {
  const c = row.chore;
  const cat = catOf(ctx, c.cat);
  const st = choreState(row, ctx?.today);
  const ref = `chore:${c.id}`;
  const clock = ctx?.state?.clock;
  const clocked = !!(clock && clock.active && clock.ref === ref);
  const flash = ctx?.ui?.flash;
  const flashing = !!(flash && flash.key === ref && Date.now() - (Number(flash.at) || 0) < 900);
  const goal = Math.max(1, Math.round(Number(c.min) || 5));
  const title = String(c.title || 'Chore');

  const didIt = (ev) => {
    const tile = ev.currentTarget.closest('.chore-tile') ?? ev.currentTarget;
    try { ctx?.fx?.burst?.(tile, 'var(--acid)'); } catch { /* fx is decoration */ }
    try { ctx?.fx?.stamp?.(tile, 'DID IT'); } catch { /* fx is decoration */ }
    const prev = { log: Array.isArray(c.log) ? [...c.log] : [], last: c.last ?? null };
    ctx?.setUI?.({ flash: { key: ref, at: Date.now() } });
    ctx?.act?.('choreDone', { id: c.id }, {
      toast: `${title}: done. ${st.tone === 'over' ? 'Debt cleared.' : 'Nice.'}`,
      undo: () => ctx?.act?.('editChore', { id: c.id, patch: prev }),
    });
  };

  const startBtn = clocked
    ? h('button.btn.btn-sm.chore-stop', {
        type: 'button',
        onclick: () => ctx?.act?.('clockOut', { markDone: true }, { toast: `${title}: logged + done.` }),
      }, ic(ctx, 'stop'), 'Stop')
    : h('button.btn.btn-sm.chore-go', {
        type: 'button',
        'aria-label': `Start ${goal} minutes of ${title}`,
        onclick: () => ctx?.act?.('clockIn', { ref, title, cat: c.cat, goal }, { toast: `${goal} minutes. That's it. Go.`, kind: 'info' }),
      }, ic(ctx, 'play'), `${goal} min`);

  return h('article.chore-tile', {
    class: [`is-${st.tone}`, clocked && 'is-clocked', flashing && 'is-flash', compact && 'is-compact'].filter(Boolean).join(' '),
    style: catStyle(cat),
    dataset: { choreId: c.id },
  },
    h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat.glyph || '··'),
    h('div.chore-main',
      h('div.chore-title-row',
        h('h3.chore-title', title),
        h('span.chore-cad', cadenceLabel(c)),
      ),
      h('div.chore-state',
        fuse(st),
        h('span.chore-state-t', clocked ? 'CLOCKED IN' : st.text),
        h('span.chore-last', st.last),
      ),
    ),
    h('div.chore-acts',
      h('button.btn.btn-sm.chore-did', {
        type: 'button',
        class: st.tone === 'done' ? '' : 'btn-acid',
        'aria-label': `${title}: did it`,
        onclick: didIt,
      }, ic(ctx, 'check'), 'Did it'),
      startBtn,
    ),
  );
}

/** Inline "add chore" form (title + every N days). Shared with Setup. */
export function choreAddForm(ctx, { idPrefix = 'chore-add', disabled = false } = {}) {
  const kTitle = `${idPrefix}.title`;
  const kEvery = `${idPrefix}.every`;
  const title = draftGet(ctx, kTitle, '');
  const every = draftGet(ctx, kEvery, '7');
  return h('form.chore-add', {
    onsubmit: async (e) => {
      e.preventDefault();
      const t = String(draftGet(ctx, kTitle, '')).trim();
      const n = Math.round(Number(draftGet(ctx, kEvery, '7')));
      if (!t) {
        ctx?.toast?.('Name the chore first.', { kind: 'error' });
        return;
      }
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        ctx?.toast?.('Every 1 to 365 days.', { kind: 'error' });
        return;
      }
      const res = await ctx?.act?.('addChore', { title: t, every: n }, { toast: `New chore: ${t} (${cadenceLabel({ every: n })})` });
      if (res && res.writes && res.writes.length) {
        draftClear(ctx, kTitle, kEvery);
        ctx?.rerender?.();
      }
    },
  },
    h('span.chore-add-prompt', { 'aria-hidden': 'true' }, '+'),
    h(`input.field#${idPrefix}-title`, {
      value: title,
      placeholder: 'new chore: water plants',
      'aria-label': 'New chore title',
      autocomplete: 'off',
      disabled,
      oninput: (e) => draftSet(ctx, kTitle, e.currentTarget.value),
    }),
    h('label.chore-add-every', { for: `${idPrefix}-every` },
      h('span.label', 'every'),
      h(`input.field#${idPrefix}-every`, {
        type: 'number',
        inputmode: 'numeric',
        min: '1',
        max: '365',
        value: String(every),
        disabled,
        oninput: (e) => draftSet(ctx, kEvery, e.currentTarget.value),
      }),
      h('span.label', 'days'),
    ),
    h('button.btn', { type: 'submit', disabled }, ic(ctx, 'plus'), 'Add'),
  );
}

export function renderChores(ctx, opts = {}) {
  const compact = !!(opts && opts.compact);
  const restore = keepFocus();
  const rows = Array.isArray(ctx?.vm?.chores) ? ctx.vm.chores.filter((r) => r && r.chore) : [];
  const dueCount = rows.filter((r) => r.due).length;
  const shown = compact ? rows.slice(0, COMPACT_MAX) : rows;
  const hidden = rows.length - shown.length;
  const loaded = ctx?.loaded !== false;

  const body = !loaded
    ? h('div.chore-skel', [0, 1, 2].map(() => h('div.chore-skel-row', h('span.label', 'LOADING…'))))
    : rows.length
      ? h('div.chore-grid', { class: compact ? 'is-compact' : '' }, shown.map((r) => choreTile(ctx, r, { compact })))
      : h('div.empty',
          h('p.scrawl', 'No chores on the board.'),
          h('p', 'Add the stuff that repeats. Ziggy walks, laundry, plants.'),
        );

  const root = h('section.panel.chores', { class: compact ? 'is-compact' : 'is-full', 'aria-labelledby': 'chores-h' },
    h('header.panel-head',
      h('div.chores-title',
        h('h2#chores-h', h('span.slash', '//'), 'Chores'),
        h('p.chores-sub', '5 minutes counts.'),
      ),
      h('span.chores-due', { class: dueCount ? 'is-hot' : '' },
        h('b.shout', String(dueCount)), h('span.label', 'due'),
      ),
    ),
    h('div.panel-body',
      body,
      hidden > 0
        ? h('button.btn.btn-ghost.btn-sm.chores-more', { type: 'button', onclick: () => goTab(ctx, 'setup') }, `+${hidden} more in Setup`)
        : null,
      h('div.chores-foot',
        h('button.btn.btn-hot.chores-five', {
          type: 'button',
          onclick: () => ctx?.openClock?.(),
        }, ic(ctx, 'timer'), 'Just 5 min: pick anything'),
        compact ? null : h('span.label', 'or one tap on a tile'),
      ),
      compact ? null : choreAddForm(ctx, { idPrefix: 'chore-add', disabled: ctx?.store?.canWrite === false }),
    ),
  );
  restore(root);
  return root;
}
