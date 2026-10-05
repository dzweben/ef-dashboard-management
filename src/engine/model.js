// Core shapes, defaults and converters. Pure: no DOM, no Node APIs.
// See docs/ARCHITECTURE.md for the contract.

export const SCHEMA_VERSION = 1;

export const GROUPS = [
  { id: 'research', label: 'Research' },
  { id: 'clinical', label: 'Clinical' },
  { id: 'coursework', label: 'Coursework' },
  { id: 'teaching', label: 'Teaching' },
  { id: 'service', label: 'Grad roles' },
  { id: 'admin', label: 'Admin' },
  { id: 'life', label: 'Life' },
];

export const KINDS = ['task', 'deadline', 'meeting', 'appt', 'email', 'errand', 'reading', 'writing', 'analysis'];
export const STATUSES = ['todo', 'done', 'dropped'];
export const PRIO_LABELS = ['low', 'normal', 'high', 'critical'];

export const COLLECTIONS = ['tasks', 'projects', 'chores', 'cats', 'sessions', 'activity'];
export const META_DOCS = ['settings', 'clock', 'brief', 'sync'];

export const DEFAULT_SETTINGS = Object.freeze({
  tz: 'America/New_York',
  owner: 'Danny',
  weekStart: 'mon',
  cap: Object.freeze({ mon: 240, tue: 240, wed: 240, thu: 240, fri: 180, sat: 90, sun: 150 }),
  maxBlock: 120,
  minBlock: 30,
  defaultEst: 20,
  horizon: 14,
  offDays: Object.freeze([]),
});

export const INBOX_CATEGORY = Object.freeze({
  id: 'inbox', name: 'Inbox', group: 'admin', color: '#b0b8c1', glyph: '··',
  aliases: [], order: 999, note: 'Uncategorized. Claude files these.', archived: false, created: null,
});

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `prefix` + 8 random base36 chars. Never use the platform-reserved `u_`. */
export function makeId(prefix = 'x_') {
  let out = '';
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint8Array(8);
    cryptoObj.getRandomValues(buf);
    for (const b of buf) out += ID_ALPHABET[b % 36];
  } else {
    for (let i = 0; i < 8; i++) out += ID_ALPHABET[Math.floor(Math.random() * 36)];
  }
  return prefix + out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const timeOrNull = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
const clampInt = (v, lo, hi, d) => {
  const n = num(v, null);
  if (n === null) return d;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

export function normalizeSettings(partial = {}) {
  const p = isObj(partial) ? partial : {};
  const cap = { ...DEFAULT_SETTINGS.cap };
  if (isObj(p.cap)) {
    for (const k of Object.keys(cap)) {
      const v = num(p.cap[k], null);
      if (v !== null) cap[k] = Math.max(0, Math.round(v));
    }
  }
  return {
    tz: str(p.tz, DEFAULT_SETTINGS.tz) || DEFAULT_SETTINGS.tz,
    owner: str(p.owner, DEFAULT_SETTINGS.owner) || DEFAULT_SETTINGS.owner,
    weekStart: p.weekStart === 'sun' ? 'sun' : 'mon',
    cap,
    maxBlock: clampInt(p.maxBlock, 15, 480, DEFAULT_SETTINGS.maxBlock),
    minBlock: clampInt(p.minBlock, 5, 240, DEFAULT_SETTINGS.minBlock),
    defaultEst: clampInt(p.defaultEst, 5, 240, DEFAULT_SETTINGS.defaultEst),
    horizon: clampInt(p.horizon, 7, 42, DEFAULT_SETTINGS.horizon),
    offDays: Array.isArray(p.offDays) ? p.offDays.filter((d) => dateOrNull(d)) : [],
  };
}

export function normalizeBlock(b, i = 0) {
  const p = isObj(b) ? b : {};
  return {
    id: str(p.id) || `b_${i}${makeId('').slice(0, 5)}`,
    d: dateOrNull(p.d),
    m: Math.max(0, Math.round(num(p.m, 0))),
    done: p.done === true,
    auto: p.auto !== false,
  };
}

export function normalizeSub(s, i = 0) {
  const p = isObj(s) ? s : { t: String(s ?? '') };
  const out = { id: str(p.id) || `s${i + 1}`, t: str(p.t), done: p.done === true };
  const est = num(p.est, null);
  if (est !== null) out.est = Math.max(0, Math.round(est));
  return out;
}

export function normalizeTask(partial = {}, ctx = {}) {
  const p = isObj(partial) ? partial : {};
  const now = ctx.now ?? new Date().toISOString();
  const status = STATUSES.includes(p.status) ? p.status : 'todo';
  return {
    id: str(p.id) || makeId('t_'),
    title: str(p.title).trim() || 'Untitled',
    cat: str(p.cat) || 'inbox',
    status,
    due: dateOrNull(p.due),
    time: timeOrNull(p.time),
    plan: dateOrNull(p.plan),
    est: num(p.est, null) === null ? null : Math.max(0, Math.round(p.est)),
    spent: Math.max(0, Math.round(num(p.spent, 0))),
    blocks: Array.isArray(p.blocks) ? p.blocks.map(normalizeBlock).filter((b) => b.d && b.m > 0) : [],
    project: str(p.project) || null,
    prio: clampInt(p.prio, 0, 3, 1),
    kind: KINDS.includes(p.kind) ? p.kind : 'task',
    notes: str(p.notes),
    subs: Array.isArray(p.subs) ? p.subs.map(normalizeSub) : [],
    triage: p.triage === true,
    moved: Math.max(0, Math.round(num(p.moved, 0))),
    win: p.win === true,
    created: str(p.created) || now,
    updated: str(p.updated) || now,
    doneAt: status === 'done' ? str(p.doneAt) || now : null,
    src: ['chat', 'dash', 'import'].includes(p.src) ? p.src : (ctx.src ?? 'chat'),
  };
}

export function normalizeProject(partial = {}, ctx = {}) {
  const p = isObj(partial) ? partial : {};
  const now = ctx.now ?? new Date().toISOString();
  return {
    id: str(p.id) || makeId('p_'),
    name: str(p.name).trim() || 'Untitled project',
    cat: str(p.cat) || 'inbox',
    kind: ['project', 'role', 'course'].includes(p.kind) ? p.kind : 'project',
    status: ['active', 'paused', 'done'].includes(p.status) ? p.status : 'active',
    due: dateOrNull(p.due),
    goal: str(p.goal),
    milestones: Array.isArray(p.milestones)
      ? p.milestones.map((m, i) => {
          const q = isObj(m) ? m : { t: String(m ?? '') };
          return {
            id: str(q.id) || `m${i + 1}`,
            t: str(q.t),
            due: dateOrNull(q.due),
            done: q.done === true,
            doneAt: q.done === true ? str(q.doneAt) || null : null,
          };
        })
      : [],
    weeklyHours: num(p.weeklyHours, null),
    notes: str(p.notes),
    order: num(p.order, 0),
    created: str(p.created) || now,
    updated: str(p.updated) || now,
  };
}

export function normalizeChore(partial = {}, ctx = {}) {
  const p = isObj(partial) ? partial : {};
  const now = ctx.now ?? new Date().toISOString();
  const every = clampInt(p.every, 1, 365, 7);
  const log = Array.isArray(p.log) ? p.log.filter((d) => dateOrNull(d)).slice(-90) : [];
  return {
    id: str(p.id) || makeId('c_'),
    title: str(p.title).trim() || 'Chore',
    cat: str(p.cat) || 'home',
    every,
    perDay: every === 1 ? clampInt(p.perDay, 1, 12, 1) : 1,
    last: dateOrNull(p.last) ?? (log.length ? log[log.length - 1] : null),
    log,
    min: clampInt(p.min, 1, 240, 5),
    active: p.active !== false,
    notes: str(p.notes),
    created: str(p.created) || now,
    updated: str(p.updated) || now,
  };
}

const SLUG_RE = /[^a-z0-9]+/g;
export function slugify(name) {
  return String(name ?? '').toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'cat';
}

export function normalizeCategory(partial = {}, ctx = {}) {
  const p = isObj(partial) ? partial : {};
  const now = ctx.now ?? new Date().toISOString();
  const name = str(p.name).trim() || 'Category';
  const color = typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color.toLowerCase() : '#b0b8c1';
  const glyphSrc = str(p.glyph) || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··';
  return {
    id: str(p.id) || slugify(name),
    name,
    group: GROUPS.some((g) => g.id === p.group) ? p.group : 'admin',
    color,
    glyph: glyphSrc.slice(0, 3),
    aliases: Array.isArray(p.aliases) ? [...new Set(p.aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean))] : [],
    order: num(p.order, 500),
    note: str(p.note),
    archived: p.archived === true,
    created: str(p.created) || now,
  };
}

export function normalizeClock(partial) {
  const p = isObj(partial) ? partial : {};
  if (p.active !== true || !str(p.start)) return { active: false };
  return {
    active: true,
    ref: str(p.ref) || 'free',
    title: str(p.title) || 'Focus',
    cat: str(p.cat) || 'inbox',
    start: p.start,
    goal: clampInt(p.goal, 1, 480, 5),
  };
}

export function normalizeBrief(partial) {
  if (!isObj(partial) || !str(partial.at)) return null;
  return {
    at: partial.at,
    headline: str(partial.headline),
    lines: Array.isArray(partial.lines) ? partial.lines.map(String) : [],
    asks: Array.isArray(partial.asks) ? partial.asks.map(String) : [],
    focus: Array.isArray(partial.focus) ? partial.focus.map(String) : [],
  };
}

export function normalizeSync(partial) {
  const p = isObj(partial) ? partial : {};
  return {
    lastClaudeSync: str(p.lastClaudeSync) || null,
    lastActivitySeen: str(p.lastActivitySeen) || null,
  };
}

export function emptyState() {
  return {
    schema: SCHEMA_VERSION,
    settings: normalizeSettings({}),
    cats: { inbox: { ...INBOX_CATEGORY, aliases: [] } },
    tasks: {},
    projects: {},
    chores: {},
    sessions: {},
    activity: {},
    clock: { active: false },
    brief: null,
    sync: normalizeSync({}),
  };
}

/** Copy without `_v` and any other `_`-prefixed bookkeeping keys. */
export function stripMeta(doc) {
  if (!isObj(doc)) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

const NORMALIZERS = {
  tasks: normalizeTask,
  projects: normalizeProject,
  chores: normalizeChore,
  cats: normalizeCategory,
  sessions: (d) => (isObj(d) ? { ...d } : d),
  activity: (d) => (isObj(d) ? { ...d } : d),
};

/** Normalize a raw parsed state.json (or seed) into a full State. Unknown keys are dropped. */
export function normalizeState(raw = {}) {
  const r = isObj(raw) ? raw : {};
  const state = emptyState();
  for (const col of COLLECTIONS) {
    const src = r[col];
    const entries = Array.isArray(src) ? src.map((d) => [d?.id, d]) : isObj(src) ? Object.entries(src) : [];
    for (const [key, doc] of entries) {
      if (!isObj(doc)) continue;
      const withId = doc.id ? doc : { ...doc, id: key };
      if (!withId.id) continue;
      const norm = NORMALIZERS[col](withId, { now: withId.created });
      state[col][norm.id] = norm;
    }
  }
  if (!state.cats.inbox) state.cats.inbox = { ...INBOX_CATEGORY, aliases: [] };
  state.settings = normalizeSettings(r.settings);
  state.clock = normalizeClock(r.clock);
  state.brief = normalizeBrief(r.brief);
  state.sync = normalizeSync(r.sync);
  return state;
}

const TOP_ORDER = ['schema', 'settings', 'brief', 'clock', 'sync', 'cats', 'projects', 'tasks', 'chores', 'sessions', 'activity'];

/** Stable, diff-friendly JSON for data/state.json (entries sorted by id, 2-space indent, trailing newline). */
export function serializeState(state) {
  const out = {};
  for (const k of TOP_ORDER) {
    const v = state[k];
    if (COLLECTIONS.includes(k)) {
      const sorted = {};
      for (const id of Object.keys(v ?? {}).sort()) sorted[id] = v[id];
      out[k] = sorted;
    } else if (k === 'schema') {
      out[k] = SCHEMA_VERSION;
    } else {
      out[k] = v ?? null;
    }
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Apply doc-level writes to a state (pure; returns a new state).
 * Write = { op: 'set'|'update'|'delete', col, id, data }
 * col is a collection name or 'meta' (id: settings|clock|brief|sync).
 * `update` shallow-merges into an existing entry; an update to a missing entry is ignored.
 */
export function applyWrites(state, writes = []) {
  const next = { ...state };
  const touched = new Set();
  for (const w of writes) {
    if (!w || !w.op || !w.col) continue;
    if (w.col === 'meta') {
      if (!META_DOCS.includes(w.id)) continue;
      const cur = next[w.id];
      if (w.op === 'delete') {
        next[w.id] = w.id === 'brief' ? null : w.id === 'clock' ? { active: false } : w.id === 'sync' ? normalizeSync({}) : normalizeSettings({});
      } else if (w.op === 'set') {
        next[w.id] = clone(w.data);
      } else if (w.op === 'update' && cur) {
        next[w.id] = { ...cur, ...clone(w.data) };
      }
      continue;
    }
    if (!COLLECTIONS.includes(w.col) || !w.id) continue;
    if (!touched.has(w.col)) {
      next[w.col] = { ...(next[w.col] ?? {}) };
      touched.add(w.col);
    }
    const coll = next[w.col];
    if (w.op === 'delete') {
      delete coll[w.id];
    } else if (w.op === 'set') {
      coll[w.id] = { ...clone(w.data), id: w.id };
    } else if (w.op === 'update') {
      if (coll[w.id]) coll[w.id] = { ...coll[w.id], ...clone(w.data), id: w.id };
    }
  }
  return next;
}

/** Deep-ish clone for state objects (plain JSON data only). */
export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Doc-level writes that turn `base` into `next` (field-level `update`s for changed
 * entries, `set` for new ones, `delete` for removed ones, `set` for changed meta docs).
 * Used to replay one side's changes onto a newer remote state (3-way merge):
 *   applyWrites(remote, diffWrites(base, ours))
 */
export function diffWrites(base, next) {
  const writes = [];
  for (const col of COLLECTIONS) {
    const a = base?.[col] ?? {};
    const b = next?.[col] ?? {};
    for (const [id, doc] of Object.entries(b)) {
      const prev = a[id];
      if (!prev) {
        writes.push({ op: 'set', col, id, data: stripMeta(doc) });
        continue;
      }
      const changed = {};
      for (const k of new Set([...Object.keys(prev), ...Object.keys(doc)])) {
        if (k.startsWith('_')) continue;
        if (!sameJSON(prev[k], doc[k])) changed[k] = doc[k] === undefined ? null : doc[k];
      }
      if (Object.keys(changed).length) writes.push({ op: 'update', col, id, data: changed });
    }
    for (const id of Object.keys(a)) if (!(id in b)) writes.push({ op: 'delete', col, id });
  }
  for (const id of META_DOCS) {
    if (!sameJSON(base?.[id] ?? null, next?.[id] ?? null)) {
      if (next?.[id] == null) writes.push({ op: 'delete', col: 'meta', id });
      else writes.push({ op: 'set', col: 'meta', id, data: clone(next[id]) });
    }
  }
  return writes;
}
