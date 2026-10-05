// Setup: connect GitHub (token + repo), categories, capacity, days off, chores, about.
// Also exports the small helpers my other views share (focus keeper, drafts, tab jump),
// because each engineer may only write their own files.
import { h, catStyle, isReplacing } from '../dom.js';
import { icon as iconFallback } from '../icons.js';
import { GROUPS, DEFAULT_SETTINGS } from '../../engine/model.js';
import { addDays, diffDays, dowKey, fmtDay, fmtMinutes, isISODate } from '../../engine/dates.js';
import { choreAddForm, cadenceLabel } from './chores.js';

// ------------------------------------------------------------------ shared view helpers

/** ctx.icon(name) with a fallback to the icon module (never throws). */
export function ic(ctx, name) {
  try {
    const fn = typeof ctx?.icon === 'function' ? ctx.icon : iconFallback;
    return fn(name) ?? null;
  } catch {
    return null;
  }
}

/** Category for an id: ctx.cat → ctx.cats → a neutral inbox stand-in. */
export function catOf(ctx, id) {
  try {
    if (typeof ctx?.cat === 'function') return ctx.cat(id) ?? INBOX_STANDIN;
  } catch {
    /* fall through */
  }
  return ctx?.cats?.[id] ?? ctx?.cats?.inbox ?? INBOX_STANDIN;
}
const INBOX_STANDIN = Object.freeze({ id: 'inbox', name: 'Inbox', color: '#b0b8c1', glyph: '··', group: 'admin' });

/**
 * Keep the caret where it was across a full re-render (main.js replaces the
 * whole view on every state/UI change, and once a minute). Call at the START
 * of a render (before anything is replaced); call the returned function with
 * the new root. After main.js mounts the new tree, focus + selection go back
 * to the element with the same id, if it lives inside that root.
 */
export function keepFocus() {
  if (typeof document === 'undefined') return () => {};
  const a = document.activeElement;
  if (!a || !a.id || a === document.body || !a.closest?.('#ef-main')) return () => {};
  const id = a.id;
  let sel = null;
  try {
    if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd, a.selectionDirection || 'none'];
  } catch {
    sel = null; // number/date/color inputs throw on selectionStart
  }
  return (root) => {
    const run = () => {
      const el = document.getElementById(id);
      if (!el || el === document.activeElement) return;
      if (root && typeof root.contains === 'function' && !root.contains(el)) return;
      try { el.focus({ preventScroll: true }); } catch { /* detached */ }
      if (sel) {
        try { el.setSelectionRange(sel[0], sel[1], sel[2]); } catch { /* not a text field */ }
      }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else Promise.resolve().then(run);
  };
}

/**
 * Unsent form text lives in ctx.ui.drafts (the same object main.js keeps as app.ui,
 * so it survives re-renders without forcing one on every keystroke).
 */
export function draftGet(ctx, key, fallback = '') {
  const d = ctx?.ui?.drafts;
  return d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
}
export function draftSet(ctx, key, value) {
  if (!ctx?.ui || typeof ctx.ui !== 'object') return;
  if (!ctx.ui.drafts || typeof ctx.ui.drafts !== 'object') ctx.ui.drafts = {};
  ctx.ui.drafts[key] = value;
}
export function draftClear(ctx, ...keys) {
  const d = ctx?.ui?.drafts;
  if (!d || typeof d !== 'object') return;
  for (const k of keys) delete d[k];
}

/**
 * Props for a text field that edits a stored value and saves when you leave it.
 * Typing lives in ctx.ui.drafts[key], so a re-render mid-word (the minute tick, a sync
 * status change) rebuilds the field with what you typed and keepFocus puts the caret
 * back. The change Chromium fires while a re-render swaps the field out is ignored
 * (dom.isReplacing); the real change on leaving the field commits once, then the draft goes.
 */
export function editField(ctx, key, stored, commit) {
  return {
    value: draftGet(ctx, key, stored ?? ''),
    oninput: (e) => draftSet(ctx, key, e.currentTarget.value),
    onchange: (e) => {
      const el = e.currentTarget;
      if (isReplacing(el)) return;
      draftClear(ctx, key);
      commit(el.value, el);
    },
    onblur: (e) => {
      // typed and then put back: no change event, so drop the draft here (a real edit
      // already committed on change; one interrupted by a window switch keeps its draft)
      if (!isReplacing(e.currentTarget) && e.currentTarget.value === String(stored ?? '')) draftClear(ctx, key);
    },
  };
}

/** Jump to another tab (adds a history entry, so Back returns). */
export function goTab(ctx, tab) {
  if (typeof ctx?.setTab === 'function') {
    ctx.setTab(tab);
    return;
  }
  try {
    if (typeof location !== 'undefined') {
      if (location.hash === `#${tab}`) ctx?.setUI?.({ tab });
      else location.hash = `#${tab}`; // main.js listens for hashchange → setTab
      return;
    }
  } catch {
    /* sandboxed frame without location access */
  }
  ctx?.setUI?.({ tab });
}

/** Coarse pointer (phone/tablet): no HTML5 drag and drop, actions always visible. */
export function isTouch() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** "1h40", "45m", "4h" — tight minute readouts for meters. */
export function shortMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n < 60) return `${n}m`;
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  return mm ? `${hh}h${String(mm).padStart(2, '0')}` : `${hh}h`;
}

/** "12s ago", "4m ago", "2h ago", "3d ago" from two ISO timestamps. */
export function agoLabel(atIso, nowIso) {
  const a = Date.parse(atIso);
  const b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ------------------------------------------------------------------ setup view

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const WEEKDAYS = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
];

const STATUS_TONE = {
  synced: 'good', saving: 'busy', loading: 'busy', pending: 'warn',
  offline: 'bad', error: 'bad', conflict: 'bad', readonly: 'idle',
};
const STATUS_WORD = {
  synced: 'SYNCED', saving: 'SAVING…', loading: 'LOADING…', pending: 'PENDING',
  offline: 'OFFLINE', error: 'ERROR', conflict: 'CONFLICT', readonly: 'READ-ONLY',
};

/** Prefilled fine-grained token form (GitHub ignores params it doesn't know). */
export function tokenUrl(config = {}) {
  const q = new URLSearchParams({
    name: 'EF Console',
    description: `EF Console website: read + write ${config.path || 'data/state.json'} in ${config.repo || 'ef-dashboard-management'}`,
    expires_in: '365',
    contents: 'write',
  });
  if (config.owner) q.set('target_name', config.owner);
  return `${TOKEN_URL}?${q.toString()}`;
}

/** Light sanity check on a pasted token. Returns null when it looks fine, else a warning. */
export function tokenWarning(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 'Paste a token first.';
  if (/\s/.test(t)) return 'That has spaces in it. Copy the token again.';
  if (t.startsWith('github_pat_')) return null;
  if (/^gh[pousr]_/.test(t)) return 'That looks like a classic token. It works, but a fine-grained one limited to this repo is safer.';
  return "That doesn't look like a GitHub token (they start with github_pat_). Saving anyway.";
}

function section(id, title, sub, body, { tone = '', right = null } = {}) {
  return h('section.panel.setup-sec', { id, class: tone ? `is-${tone}` : '', 'aria-labelledby': `${id}-h` },
    h('header.panel-head',
      h('div.setup-sec-title',
        h('h2', { id: `${id}-h` }, h('span.slash', '//'), title),
        sub ? h('p.setup-sub', sub) : null,
      ),
      right,
    ),
    h('div.panel-body', body),
  );
}

export function renderSetup(ctx) {
  const restore = keepFocus();
  const canWrite = !!ctx?.store?.canWrite;
  const root = h('div.setup',
    h('div.setup-hero',
      h('p.label.is-bracket', 'system config'),
      h('h1.setup-title.glitch', { 'data-text': 'SETUP' }, 'SETUP'),
      h('p.setup-lede', 'Wire the console to GitHub, tune your categories and how much focus time a day really has.'),
    ),
    h('div.setup-grid',
      githubSection(ctx),
      h('div.setup-col',
        capacitySection(ctx, canWrite),
        aboutSection(ctx),
      ),
      categoriesSection(ctx, canWrite),
      choresSection(ctx, canWrite),
    ),
  );
  restore(root);
  return root;
}

// ------------------------------------------------------------------ 1. GitHub

function statusCard(ctx) {
  const st = ctx?.store?.status ?? {};
  const kind = typeof st.kind === 'string' ? st.kind : 'loading';
  const tone = STATUS_TONE[kind] ?? 'idle';
  const mode = ctx?.store?.mode ?? 'readonly';
  const modeLine = mode === 'github'
    ? 'GITHUB · READ + WRITE'
    : mode === 'local'
      ? 'LOCAL PREVIEW · THIS BROWSER ONLY'
      : 'READ-ONLY · NO TOKEN';
  const at = st.at && ctx?.now ? agoLabel(st.at, ctx.now) : '';
  return h('div.setup-status', { class: `is-${tone}`, role: 'status' },
    h('span.setup-led', { 'aria-hidden': 'true' }),
    h('div.setup-status-main',
      h('div.setup-status-kind', STATUS_WORD[kind] ?? kind.toUpperCase(), h('span.setup-status-mode', modeLine)),
      h('p.setup-status-msg', st.message || (mode === 'readonly' ? 'Viewing only. Add a token below to save changes.' : '')),
      at ? h('p.setup-status-at', `last update ${at}`) : null,
    ),
    h('button.btn.btn-sm', {
      type: 'button',
      onclick: () => {
        try { ctx?.store?.refresh?.(); } catch { /* store handles its own errors */ }
        ctx?.toast?.('Pulling the latest…', { kind: 'info', ms: 1800 });
      },
    }, ic(ctx, 'refresh'), 'Refresh'),
  );
}

function githubSection(ctx) {
  const cfg = { owner: '', repo: '', branch: '', path: '', ...(ctx?.config ?? {}) };
  const repoName = cfg.repo || 'ef-dashboard-management';
  const hasToken = !!ctx?.hasToken;

  const steps = [
    ['Open GitHub’s token page', h('span', ' ', h('a', { href: tokenUrl(cfg), target: '_blank', rel: 'noopener noreferrer' }, 'github.com/settings/personal-access-tokens/new', ic(ctx, 'external')), ' (Fine-grained tokens → Generate new token).')],
    ['Name + expiry', h('span', ' Name it ', h('code', 'EF Console'), '. Expiration: ', h('b', 'Custom → up to 1 year'), ' out (GitHub’s max). Put a reminder in your calendar.')],
    ['Repository access', h('span', ' ', h('b', 'Only select repositories'), ' → pick ', h('code', repoName), '. Nothing else.')],
    ['Permissions', h('span', ' Repository permissions → ', h('b', 'Contents: Read and write'), '. Leave everything else alone (Metadata: Read-only is automatic).')],
    ['Generate + paste', h('span', ' Hit ', h('b', 'Generate token'), ', copy the ', h('code', 'github_pat_…'), ' string, paste it below, Save. Do the same once on your phone.')],
  ];

  const tokenId = 'setup-token';
  const tokenForm = h('form.setup-token', {
    autocomplete: 'off',
    onsubmit: (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector(`#${tokenId}`);
      const val = String(input?.value ?? '').trim();
      const warn = tokenWarning(val);
      if (!val) {
        ctx?.toast?.(warn, { kind: 'error' });
        input?.focus();
        return;
      }
      if (input) input.value = '';
      draftClear(ctx, 'token');
      ctx?.setToken?.(val);
      ctx?.toast?.(warn ? `Token saved. ${warn}` : 'Token saved in this browser. Connecting…', { kind: warn ? 'info' : 'good', ms: warn ? 7000 : 3500 });
    },
  },
    h('label.field-row', { for: tokenId },
      h('span.label', hasToken ? 'Replace token' : 'Fine-grained token'),
    ),
    h('div.setup-inline',
      h('span.setup-prompt', { 'aria-hidden': 'true' }, '>'),
      h(`input.field.setup-token-input#${tokenId}`, {
        type: 'password',
        name: 'ef-token',
        placeholder: hasToken ? '•••••••• saved · paste a new one to replace' : 'github_pat_…',
        value: draftGet(ctx, 'token', ''),
        oninput: (e) => draftSet(ctx, 'token', e.currentTarget.value),
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        'aria-describedby': 'setup-token-note',
      }),
      h('button.btn', {
        type: 'button',
        'aria-label': 'Show or hide the token',
        onclick: (e) => {
          const input = e.currentTarget.parentElement?.querySelector('input');
          if (input) input.type = input.type === 'password' ? 'text' : 'password';
        },
      }, ic(ctx, 'eye')),
      h('button.btn.btn-hot', { type: 'submit' }, ic(ctx, 'key'), 'Save token'),
    ),
    h('p.setup-note#setup-token-note',
      hasToken
        ? h('span', h('b.setup-ok', 'TOKEN SAVED IN THIS BROWSER. '), 'Kept in localStorage only: never committed, never sent anywhere but api.github.com. Your other github.io sites share this storage, so only give it this one repo.')
        : 'Kept in this browser’s localStorage only: never committed, never sent anywhere but api.github.com. Your other github.io sites share this storage, so only give it this one repo.',
      hasToken
        ? h('button.btn.btn-sm.setup-forget', {
            type: 'button',
            onclick: () => {
              ctx?.clearToken?.();
              ctx?.toast?.('Token forgotten. Read-only now.', { kind: 'info' });
            },
          }, ic(ctx, 'x'), 'Forget token')
        : null,
    ),
  );

  const fields = [
    ['owner', 'Owner', 'dzweben'],
    ['repo', 'Repo', 'ef-dashboard-management'],
    ['branch', 'Branch', 'default branch'],
    ['path', 'Path', 'data/state.json'],
  ];
  const cfgForm = h('form.setup-config', {
    onsubmit: (e) => {
      e.preventDefault();
      const next = {};
      for (const [k] of fields) next[k] = String(draftGet(ctx, `cfg.${k}`, cfg[k] ?? '')).trim();
      if (!next.owner || !next.repo || !next.path) {
        ctx?.toast?.('Owner, repo and path are required.', { kind: 'error' });
        return;
      }
      next.path = next.path.replace(/^\/+/, '');
      draftClear(ctx, ...fields.map(([k]) => `cfg.${k}`));
      ctx?.saveConfig?.(next);
      ctx?.toast?.(`Pointing at ${next.owner}/${next.repo}${next.branch ? `@${next.branch}` : ''}:${next.path}`, { kind: 'good' });
    },
  },
    h('div.setup-cfg-grid',
      fields.map(([k, label, ph]) =>
        h('label.field-row', { for: `setup-cfg-${k}` },
          h('span.label', label),
          h(`input.field#setup-cfg-${k}`, {
            value: draftGet(ctx, `cfg.${k}`, cfg[k] ?? ''),
            placeholder: ph,
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            oninput: (e) => draftSet(ctx, `cfg.${k}`, e.currentTarget.value),
          }),
        ),
      ),
    ),
    h('div.setup-actions',
      h('button.btn', { type: 'submit' }, 'Save repo settings'),
      h('a.setup-link', { href: `https://github.com/${encodeURIComponent(cfg.owner || 'dzweben')}/${encodeURIComponent(repoName)}`, target: '_blank', rel: 'noopener noreferrer' }, ic(ctx, 'github'), `${cfg.owner || 'dzweben'}/${repoName}`),
    ),
  );

  return section('setup-github', 'Connect GitHub',
    'The site saves to data/state.json in your repo. Every burst of taps becomes one commit under your name; Claude reads the same file.',
    [
      statusCard(ctx),
      h('ol.setup-steps', steps.map(([t, body], i) =>
        h('li.setup-step',
          h('span.setup-step-n', { 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
          h('p', h('b.setup-step-t', t + '.'), body),
        ))),
      tokenForm,
      h('details.setup-adv', {
        open: draftGet(ctx, 'cfg.open', false) === true,
        ontoggle: (e) => draftSet(ctx, 'cfg.open', e.currentTarget.open === true),
      },
        h('summary',
          h('span.label', 'saving to'),
          h('code.setup-target', `${cfg.owner || 'dzweben'}/${repoName} @ ${cfg.branch || 'default branch'} : ${cfg.path || 'data/state.json'}`),
          h('span.setup-edit', 'edit'),
        ),
        cfgForm,
      ),
    ],
    { tone: 'pink', right: h('span.setup-badge', { class: hasToken ? 'is-on' : '' }, ic(ctx, hasToken ? 'unlock' : 'lock'), hasToken ? 'TOKEN SET' : 'NO TOKEN') },
  );
}

// ------------------------------------------------------------------ 2. Categories

function readOnlyNote(ctx, canWrite) {
  return canWrite ? null : h('p.setup-ro', ic(ctx, 'lock'), 'Read-only: connect GitHub above to edit.');
}

function categoriesSection(ctx, canWrite) {
  const cats = Object.values(ctx?.state?.cats ?? {}).filter((c) => c && typeof c === 'object' && c.id);
  const byGroup = GROUPS.map((g) => ({
    g,
    cats: cats
      .filter((c) => (GROUPS.some((x) => x.id === c.group) ? c.group : 'admin') === g.id)
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || (a.order ?? 500) - (b.order ?? 500) || String(a.name).localeCompare(String(b.name))),
  })).filter((x) => x.cats.length);

  const edit = (cat, patch, msg) => ctx?.act?.('editCategory', { id: cat.id, patch }, msg ? { toast: msg } : {});

  const row = (cat) => {
    const id = `cat-${cat.id}`;
    const archived = cat.archived === true;
    return h('div.setup-cat', { class: archived ? 'is-archived' : '', style: catStyle(cat) },
      h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat.glyph || '··'),
      h('label.setup-cat-color', { title: 'Color' },
        h('span.sr-only', `${cat.name} color`),
        h(`input#${id}-color`, {
          type: 'color',
          value: /^#[0-9a-f]{6}$/i.test(cat.color ?? '') ? cat.color : '#b0b8c1',
          disabled: !canWrite,
          onchange: (e) => edit(cat, { color: e.currentTarget.value }),
        }),
      ),
      h(`input.field.setup-cat-name#${id}-name`, {
        'aria-label': `${cat.name} name`,
        disabled: !canWrite,
        ...editField(ctx, `${id}.name`, cat.name, (raw, el) => {
          const v = raw.trim();
          if (v && v !== cat.name) edit(cat, { name: v });
          else el.value = cat.name ?? '';
        }),
      }),
      h(`select.field.setup-cat-group#${id}-group`, {
        'aria-label': `${cat.name} group`,
        disabled: !canWrite,
        onchange: (e) => edit(cat, { group: e.currentTarget.value }, `${cat.name} → ${GROUPS.find((g) => g.id === e.currentTarget.value)?.label ?? ''}`),
      }, GROUPS.map((g) => h('option', { value: g.id, selected: g.id === cat.group }, g.label))),
      h(`input.field.setup-cat-glyph#${id}-glyph`, {
        maxlength: '3',
        'aria-label': `${cat.name} glyph (up to 3 characters)`,
        title: 'Glyph (≤3 chars)',
        disabled: !canWrite,
        ...editField(ctx, `${id}.glyph`, cat.glyph, (raw, el) => {
          const v = raw.trim().slice(0, 3);
          if (v && v !== cat.glyph) edit(cat, { glyph: v });
          else el.value = cat.glyph ?? '';
        }),
      }),
      h(`input.field.setup-cat-alias#${id}-aliases`, {
        placeholder: 'aliases, comma, separated',
        'aria-label': `${cat.name} aliases`,
        disabled: !canWrite,
        ...editField(ctx, `${id}.aliases`, Array.isArray(cat.aliases) ? cat.aliases.join(', ') : '', (raw) => edit(cat, { aliases: raw })),
      }),
      h('button.btn.btn-sm.setup-cat-arch', {
        type: 'button',
        'aria-pressed': String(archived),
        disabled: !canWrite || cat.id === 'inbox',
        title: cat.id === 'inbox' ? 'The inbox always stays' : archived ? 'Bring it back' : 'Hide from pickers (tasks keep it)',
        onclick: () => edit(cat, { archived: !archived }, archived ? `${cat.name} is back.` : `${cat.name} archived.`),
      }, archived ? 'Unarchive' : 'Archive'),
    );
  };

  const addName = draftGet(ctx, 'cat.add.name', '');
  const addGroup = draftGet(ctx, 'cat.add.group', 'research');
  const addForm = h('form.setup-addrow', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = String(draftGet(ctx, 'cat.add.name', '')).trim();
      if (!name) return;
      const group = draftGet(ctx, 'cat.add.group', 'research');
      const res = await ctx?.act?.('addCategory', { name, group }, { toast: `New category: ${name}` });
      if (res && res.writes && res.writes.length) {
        draftClear(ctx, 'cat.add.name');
        ctx?.rerender?.();
      } else if (res) {
        ctx?.toast?.(`“${name}” already exists.`, { kind: 'error' });
      }
    },
  },
    h('span.label', 'New category'),
    h('input.field#setup-cat-add-name', {
      value: addName,
      placeholder: 'e.g. Stats TA',
      'aria-label': 'New category name',
      disabled: !canWrite,
      oninput: (e) => draftSet(ctx, 'cat.add.name', e.currentTarget.value),
    }),
    h('select.field#setup-cat-add-group', {
      'aria-label': 'New category group',
      disabled: !canWrite,
      onchange: (e) => draftSet(ctx, 'cat.add.group', e.currentTarget.value),
    }, GROUPS.map((g) => h('option', { value: g.id, selected: g.id === addGroup }, g.label))),
    h('button.btn.btn-hot', { type: 'submit', disabled: !canWrite }, ic(ctx, 'plus'), 'Add'),
  );

  return section('setup-cats', 'Categories',
    'Color, glyph and aliases drive the auto-filing. Aliases are the words that file a to-do here (“nyx” → RSA).',
    [
      readOnlyNote(ctx, canWrite),
      h('div.setup-cat-head', { 'aria-hidden': 'true' },
        h('span'), h('span.label', 'clr'), h('span.label', 'name'), h('span.label', 'group'), h('span.label', 'glyph'), h('span.label', 'aliases'), h('span'),
      ),
      byGroup.length
        ? byGroup.map(({ g, cats: list }) =>
            h('div.setup-catgrp',
              h('h3.setup-group-h', h('span.tape', g.label), h('span.label', `${list.length}`)),
              list.map(row),
            ))
        : h('div.empty', h('p.scrawl', 'No categories yet.'), h('p', 'Add one below or let Claude create them as you go.')),
      addForm,
    ],
    { right: h('span.label.is-bracket', `${cats.length} cats`) },
  );
}

// ------------------------------------------------------------------ 3. Capacity + days off

/** Weekday capacity with defaults for missing/junk values, plus the week total and the max day. */
export function capTotals(cap = {}) {
  const src = cap && typeof cap === 'object' ? cap : {};
  const c = {};
  let week = 0;
  let max = 0;
  for (const [k] of WEEKDAYS) {
    const raw = src[k];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : DEFAULT_SETTINGS.cap[k];
    c[k] = v;
    week += v;
    if (v > max) max = v;
  }
  return { cap: c, week, max };
}

function capacitySection(ctx, canWrite) {
  const settings = ctx?.state?.settings ?? DEFAULT_SETTINGS;
  const { cap, week, max } = capTotals(settings.cap);
  const scale = Math.max(480, max);
  const SEGS = 12;
  const today = ctx?.today;

  const col = ([k, label]) => {
    const v = Math.max(0, Math.round(Number(cap[k]) || 0));
    const lit = v > 0 ? Math.max(1, Math.round((v / scale) * SEGS)) : 0;
    const isToday = isISODate(today) && dowKey(today) === k;
    return h('div.setup-eq-col', { class: isToday ? 'is-today' : '' },
      h('div.setup-eq-bar', { 'aria-hidden': 'true' },
        Array.from({ length: SEGS }, (_, i) => h('i', { class: SEGS - i <= lit ? 'on' : '' })),
      ),
      h('span.setup-eq-h', v ? shortMin(v) : 'OFF'),
      h('label', { for: `cap-${k}` }, h('span.setup-eq-d', label)),
      h(`input.field.setup-eq-in#cap-${k}`, {
        type: 'number',
        inputmode: 'numeric',
        min: '0',
        max: '1440',
        step: '15',
        'aria-label': `${label} focus minutes`,
        disabled: !canWrite,
        ...editField(ctx, `cap-${k}`, String(v), (raw, el) => {
          const n = Math.max(0, Math.min(1440, Math.round(Number(raw) || 0)));
          if (n !== v) ctx?.act?.('editSettings', { patch: { cap: { [k]: n } } }, { toast: `${label}: ${n ? fmtMinutes(n) : 'off'} of focus` });
          else el.value = String(v);
        }),
      }),
    );
  };

  const offDays = Array.isArray(settings.offDays) ? settings.offDays.filter(isISODate) : [];
  const upcoming = offDays.filter((d) => !isISODate(today) || d >= today).sort();
  const pick = draftGet(ctx, 'off.add', '');
  const offForm = h('form.setup-off-add', {
    onsubmit: (e) => {
      e.preventDefault();
      const d = String(draftGet(ctx, 'off.add', '')).trim();
      if (!isISODate(d)) {
        ctx?.toast?.('Pick a date first.', { kind: 'error' });
        return;
      }
      if (offDays.includes(d)) return;
      draftClear(ctx, 'off.add');
      ctx?.act?.('editSettings', { patch: { offDays: [...offDays, d].sort() } }, { toast: `${fmtDay(d)} is a day off.` });
    },
  },
    h('input.field#setup-off-date', {
      type: 'date',
      value: pick,
      min: isISODate(today) ? today : null,
      max: isISODate(today) ? addDays(today, 365) : null,
      'aria-label': 'Day off date',
      disabled: !canWrite,
      onchange: (e) => draftSet(ctx, 'off.add', e.currentTarget.value),
      oninput: (e) => draftSet(ctx, 'off.add', e.currentTarget.value),
    }),
    h('button.btn', { type: 'submit', disabled: !canWrite }, ic(ctx, 'plus'), 'Day off'),
  );

  return section('setup-cap', 'Capacity',
    'Focus minutes per weekday for to-dos (not meetings, not life). The calendar meters and auto-plan use these.',
    [
      readOnlyNote(ctx, canWrite),
      h('div.setup-eq', WEEKDAYS.map(col)),
      h('p.setup-eq-total', h('span.label', 'week'), h('b.shout', shortMin(week)), h('span.faint', `${(week / 60).toFixed(1)} focus hours / week`)),
      h('div.setup-off',
        h('h3.setup-mini-h', 'Days off'),
        h('p.setup-sub', 'Weddings, conferences, sick days: capacity 0, hatched on the calendar.'),
        upcoming.length
          ? h('div.setup-off-list', upcoming.map((d) =>
              h('span.chip.chip-warn',
                `${fmtDay(d)}${isISODate(today) ? ` · ${diffDays(today, d) === 0 ? 'today' : `in ${diffDays(today, d)}d`}` : ''}`,
                h('button.setup-x', {
                  type: 'button',
                  'aria-label': `Remove day off ${fmtDay(d)}`,
                  disabled: !canWrite,
                  onclick: () => ctx?.act?.('editSettings', { patch: { offDays: offDays.filter((x) => x !== d) } }, { toast: `${fmtDay(d)} is back on.` }),
                }, '✕'),
              )))
          : h('p.faint.setup-none', 'none scheduled'),
        offForm,
      ),
    ],
  );
}

// ------------------------------------------------------------------ 4. Chores

function choresSection(ctx, canWrite) {
  const chores = Object.values(ctx?.state?.chores ?? {})
    .filter((c) => c && typeof c === 'object' && c.id)
    .sort((a, b) => Number(a.active === false) - Number(b.active === false) || (a.every ?? 7) - (b.every ?? 7) || String(a.title).localeCompare(String(b.title)));

  const edit = (c, patch, msg) => ctx?.act?.('editChore', { id: c.id, patch }, msg ? { toast: msg } : {});
  const numIn = (c, key, label, { min = 1, max = 365, step = 1 } = {}) =>
    h('label.setup-chore-num',
      h('span.label', label),
      h(`input.field#chore-${c.id}-${key}`, {
        type: 'number',
        inputmode: 'numeric',
        min: String(min),
        max: String(max),
        step: String(step),
        disabled: !canWrite,
        ...editField(ctx, `chore-${c.id}.${key}`, String(c[key] ?? ''), (raw, el) => {
          const n = Math.round(Number(raw));
          if (raw.trim() && Number.isFinite(n) && n >= min && n <= max && n !== c[key]) edit(c, { [key]: n });
          else el.value = String(c[key] ?? '');
        }),
      }),
    );

  const confirmKey = draftGet(ctx, 'chore.confirmDelete', null);

  const row = (c) => {
    const active = c.active !== false;
    const cat = catOf(ctx, c.cat);
    const confirming = confirmKey === c.id;
    return h('div.setup-chore', { class: active ? '' : 'is-off', style: catStyle(cat) },
      h('span.catmark', { style: catStyle(cat), 'aria-hidden': 'true' }, cat.glyph || '··'),
      h(`input.field.setup-chore-title#chore-${c.id}-title`, {
        'aria-label': 'Chore title',
        disabled: !canWrite,
        ...editField(ctx, `chore-${c.id}.title`, c.title, (raw, el) => {
          const v = raw.trim();
          if (v && v !== c.title) edit(c, { title: v });
          else el.value = c.title ?? '';
        }),
      }),
      h('span.chip.setup-chore-cad', cadenceLabel(c)),
      numIn(c, 'every', 'every (d)'),
      Number(c.every) === 1 ? numIn(c, 'perDay', 'per day', { max: 12 }) : h('span.setup-chore-gap'),
      numIn(c, 'min', 'min', { max: 240 }),
      h('div.setup-chore-acts',
        h('button.btn.btn-sm', {
          type: 'button',
          'aria-pressed': String(!active),
          disabled: !canWrite,
          onclick: () => edit(c, { active: !active }, active ? `${c.title} paused.` : `${c.title} is back on.`),
        }, active ? 'Pause' : 'Resume'),
        h('button.btn.btn-sm.setup-del', {
          type: 'button',
          class: confirming ? 'is-armed' : '',
          disabled: !canWrite,
          onclick: () => {
            if (!confirming) {
              draftSet(ctx, 'chore.confirmDelete', c.id);
              ctx?.rerender?.();
              return;
            }
            draftClear(ctx, 'chore.confirmDelete');
            ctx?.act?.('deleteChore', { id: c.id }, { toast: `${c.title} deleted.` });
          },
          onblur: () => {
            if (draftGet(ctx, 'chore.confirmDelete', null) === c.id) {
              draftClear(ctx, 'chore.confirmDelete');
              ctx?.rerender?.();
            }
          },
        }, confirming ? 'Really delete?' : ic(ctx, 'trash')),
      ),
    );
  };

  return section('setup-chores', 'Chores',
    'Cadence, how many times a day, and the “just N minutes” default. Paused chores stay out of the way.',
    [
      readOnlyNote(ctx, canWrite),
      chores.length
        ? h('div.setup-chores', chores.map(row))
        : h('div.empty', h('p.scrawl', 'No chores yet.'), h('p', 'Add the stuff that repeats: Ziggy walks, laundry, plants.')),
      choreAddForm(ctx, { idPrefix: 'setup-chore-add', disabled: !canWrite }),
    ],
    { right: h('span.label.is-bracket', `${chores.filter((c) => c.active !== false).length} active`) },
  );
}

// ------------------------------------------------------------------ 5. About

function aboutSection(ctx) {
  const cfg = ctx?.config ?? {};
  const owner = cfg.owner || 'dzweben';
  const repo = cfg.repo || 'ef-dashboard-management';
  const branch = cfg.branch || 'HEAD';
  const path = cfg.path || 'data/state.json';
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const st = ctx?.state ?? {};
  const count = (k) => Object.keys(st[k] ?? {}).length;
  const open = Object.values(st.tasks ?? {}).filter((t) => t && (t.status ?? 'todo') === 'todo').length;
  const lastClaude = st.sync?.lastClaudeSync;
  const stat = (n, label) => h('div.setup-stat', h('b.shout', String(n)), h('span.label', label));
  return section('setup-about', 'About', null, [
    h('div.setup-stats',
      stat(open, 'open'),
      stat(count('tasks'), 'tasks'),
      stat(count('projects'), 'projects'),
      stat(count('cats'), 'cats'),
    ),
    h('ul.setup-about-list',
      h('li', h('span.label', 'claude synced'), h('span', lastClaude && ctx?.now ? agoLabel(lastClaude, ctx.now) : 'not yet')),
      h('li', h('span.label', 'timezone'), h('span', ctx?.tz || st.settings?.tz || 'America/New_York')),
      h('li', h('span.label', 'schema'), h('span', `v${st.schema ?? 1} · EF Console`)),
    ),
    h('div.setup-actions',
      h('a.btn', { href: base, target: '_blank', rel: 'noopener noreferrer' }, ic(ctx, 'github'), 'Repo'),
      h('a.btn', { href: `${base}/commits/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener noreferrer' }, ic(ctx, 'clock'), 'History'),
      h('button.btn.btn-acid', {
        type: 'button',
        onclick: () => {
          try { ctx?.store?.refresh?.(); } catch { /* store reports */ }
          ctx?.toast?.('Refreshing from GitHub…', { kind: 'info', ms: 1800 });
        },
      }, ic(ctx, 'refresh'), 'Refresh now'),
    ),
  ]);
}
