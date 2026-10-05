// Claude's latest check-in, as a paper sticker taped to the console.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { fmtRelative, fmtTime, localDateOf, localTimeOf } from '../../engine/dates.js';

const STALE_HOURS = 18;

/** "just now" | "12m ago" | "2h ago" | "yesterday 9pm" | "Fri 8:30am" | "3d ago 9am" */
export function updatedAgo(at, ctx) {
  const atMs = Date.parse(at);
  const nowMs = Date.parse(ctx?.now ?? '') || Date.now();
  if (!Number.isFinite(atMs)) return '';
  const mins = Math.round((nowMs - atMs) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 12) return `${hrs}h ago`;
  const tz = ctx?.tz || 'America/New_York';
  const d = localDateOf(at, tz);
  const rel = d && ctx?.today ? fmtRelative(d, ctx.today) : '';
  const tm = fmtTime(localTimeOf(at, tz) ?? '');
  return [rel, tm].filter(Boolean).join(' ') || `${hrs}h ago`;
}

export function renderBrief(ctx) {
  const b = ctx.state?.brief;
  const wrap = h('section.brief', { 'aria-label': 'Claude says' });

  if (!b || typeof b !== 'object' || (!b.headline && !(Array.isArray(b.lines) && b.lines.length))) {
    wrap.append(h('div.sticker.brief-card.is-empty',
      h('div.brief-top', h('span.brief-label', icon('chat'), 'Claude says'), h('span.brief-when', 'no signal')),
      h('p.brief-headline.scrawl', 'No check-in yet.'),
      h('p.brief-empty', 'Message Claude: ', h('b', '“what’s due today?”')),
    ));
    return wrap;
  }

  const atMs = Date.parse(b.at);
  const nowMs = Date.parse(ctx.now ?? '') || Date.now();
  const stale = Number.isFinite(atMs) && nowMs - atMs > STALE_HOURS * 3600 * 1000;
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const asks = (Array.isArray(b.asks) ? b.asks : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const focus = (Array.isArray(b.focus) ? b.focus : [])
    .map((id) => ctx.state?.tasks?.[id])
    .filter((t) => t && t.status === 'todo')
    .slice(0, 3);

  const card = h('div.sticker.brief-card', { class: stale ? 'is-stale' : '' },
    h('div.brief-top',
      h('span.brief-label', icon('chat'), 'Claude says'),
      h('span.brief-when', { title: b.at || '' }, stale ? 'stale · ' : '', 'updated ', updatedAgo(b.at, ctx)),
    ),
    b.headline ? h('p.brief-headline.scrawl', b.headline) : null,
    lines.length ? h('ul.brief-lines', lines.map((l) => h('li', l))) : null,
    focus.length
      ? h('div.brief-focus',
          h('span.brief-focus-label', 'Start with'),
          focus.map((t) => h('button.brief-focus-btn', { type: 'button', onclick: () => ctx.openTask?.(t.id), title: 'Open task' },
            icon('arrow-right'), h('span', t.title))),
        )
      : null,
    asks.length ? h('ul.brief-asks', asks.map((a) => h('li', h('span.brief-q', { 'aria-hidden': 'true' }, '?'), h('span', a)))) : null,
    stale ? h('p.brief-stale', 'Old news. Ask Claude for a fresh check-in.') : null,
  );
  wrap.append(card);
  return wrap;
}
