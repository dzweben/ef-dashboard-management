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
  prefBlock: 60,
  overbookAt: 1.35,
  defaultEst: 20,
  horizon: 14,
  offDays: Object.freeze([]),
  capOverrides: Object.freeze({}),
});

/**
 * Longest clock session logged in one go (minutes). A timer left running
 * overnight is capped here (ops.clockOut keeps the wall-clock length as
 * `rawMin` and sets `capped: true`); stats cap sessions that lack `min` too.
 */
export const SESSION_CAP_MIN = 180;

export const INBOX_CATEGORY = Object.freeze({
  id: 'inbox', name: 'Inbox', group: 'admin', color: '#b0b8c1', glyph: '··',
  aliases: [], order: 999, note: 'Uncategorized. Claude files these.', archived: false, created: '2026-10-05T00:00:00.000Z',
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
    prefBlock: clampInt(p.prefBlock, 15, 240, DEFAULT_SETTINGS.prefBlock),
    overbookAt: typeof p.overbookAt === 'number' && Number.isFinite(p.overbookAt) ? Math.min(3, Math.max(1, Math.round(p.overbookAt * 100) / 100)) : DEFAULT_SETTINGS.overbookAt,
    defaultEst: clampInt(p.defaultEst, 5, 240, DEFAULT_SETTINGS.defaultEst),
    horizon: clampInt(p.horizon, 7, 42, DEFAULT_SETTINGS.horizon),
    offDays: Array.isArray(p.offDays) ? p.offDays.filter((d) => dateOrNull(d)) : [],
    capOverrides: normalizeCapOverrides(p.capOverrides),
  };
}

/**
 * One-day capacity overrides { "YYYY-MM-DD": minutes } ("I have less time
 * tomorrow"): valid dates only, whole non-negative minutes, sorted by date.
 * A null / non-numeric value drops that date (how "=none" removes one).
 */
export function normalizeCapOverrides(raw) {
  if (!isObj(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([d, m]) => dateOrNull(d) && num(m, null) !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([d, m]) => [d, Math.max(0, Math.round(m))]),
  );
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
    start: dateOrNull(p.start), // first due date ("laundry every week - sat"); only matters while never logged
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

// ---------------------------------------------------------------- writes

/**
 * Fields that writes can change at element / delta level instead of wholesale
 * (see applyWrites' `inc` and `arr`, and diffWrites). Keyed by collection name
 * or meta doc id.
 *  - INC: numeric counters; a write carries a delta, so concurrent writers add up.
 *  - ID_ARRAYS: arrays of { id } elements; upsert / insert / patch / remove by id.
 *  - MULTISETS: value arrays where a value may repeat (chores.log: two walks a
 *    day). Kept sorted (oldest first) and capped (MULTISET_CAP).
 *  - SETS: value arrays without duplicates.
 */
export const INC_FIELDS = Object.freeze({ tasks: Object.freeze(['spent', 'moved']) });
export const ID_ARRAY_FIELDS = Object.freeze({ tasks: Object.freeze(['subs', 'blocks']), projects: Object.freeze(['milestones']) });
export const MULTISET_FIELDS = Object.freeze({ chores: Object.freeze(['log']) });
export const SET_FIELDS = Object.freeze({ cats: Object.freeze(['aliases']), settings: Object.freeze(['offDays']) });
const MULTISET_CAP = Object.freeze({ chores: Object.freeze({ log: 90 }) });

const fieldIn = (table, kind, field) => Array.isArray(table[kind]) && table[kind].includes(field);

/** How an `arr` spec for `kind.field` is applied: 'id' | 'multiset' | 'set'. */
function arrayKind(kind, field, spec, cur) {
  if (fieldIn(ID_ARRAY_FIELDS, kind, field)) return 'id';
  if (fieldIn(MULTISET_FIELDS, kind, field)) return 'multiset';
  if (fieldIn(SET_FIELDS, kind, field)) return 'set';
  if (['upsert', 'insert', 'order'].some((k) => Array.isArray(spec[k])) || isObj(spec.patch)) return 'id';
  if (Array.isArray(spec.add)) return 'set';
  return Array.isArray(cur) && cur.length && cur.every((x) => isObj(x) && x.id != null) ? 'id' : 'set';
}

const jsonKey = (v) => JSON.stringify(v ?? null);

/** JSON with object keys sorted, so equal elements compare equal whatever their key order. */
function stableKey(v) {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** An id not used in `arr`: "s3" → the next free "sN"; anything else → "<id>-2", "<id>-3"… */
function freeElementId(arr, id) {
  const used = new Set(arr.filter(isObj).map((x) => jsonKey(x.id)));
  const m = typeof id === 'string' ? id.match(/^(.*?)(\d+)$/) : null;
  if (m) {
    let n = 0;
    for (const x of arr) {
      const mm = isObj(x) && typeof x.id === 'string' ? x.id.match(/^(.*?)(\d+)$/) : null;
      if (mm && mm[1] === m[1]) n = Math.max(n, Number(mm[2]));
    }
    let cand = `${m[1]}${n + 1}`;
    while (used.has(jsonKey(cand))) cand = `${m[1]}${++n + 1}`;
    return cand;
  }
  let i = 2;
  while (used.has(jsonKey(`${id}-${i}`))) i++;
  return `${id}-${i}`;
}

/**
 * Apply one `arr` spec to an array (pure).
 *  id: elements are { id, … }. In this order:
 *    remove: [id]          delete by id. With `was: { [id]: element }` (the element
 *                          as the writer last saw it), an element someone else has
 *                          changed since is kept: a concurrent edit wins over a delete.
 *    upsert: [element]     replace the element with that id in place, or append it.
 *    insert: [element]     append a NEW element; if another, different element
 *                          already has its id (both sides added "s3"), ours gets the
 *                          next free id instead of overwriting theirs, and later
 *                          writes in the same applyWrites call that name the old id
 *                          (a queued toggle of that new sub) follow it.
 *    patch: { [id]: {…} }  shallow-merge those fields into the element with that id
 *                          (ignored if it is gone), so other fields edited
 *                          concurrently (a block checked done) survive.
 *    order: [id]           those ids first, in that order; others keep their order after.
 *  multiset: { add: [v], remove: [v] }: append each added value, remove the first
 *            occurrence of each removed one, then sort and keep the newest `cap`.
 *  set:      { add: [v], remove: [v] }: add if absent, remove every occurrence.
 */
function applyArraySpec(cur, spec, mode, cap, ren = new Map()) {
  let arr = Array.isArray(cur) ? cur.slice() : [];
  if (!isObj(spec)) return arr;
  if (mode === 'id') {
    // `ren`: element ids this writer's earlier inserts had to change (see insert);
    // later references to the old id (in the same applyWrites call) mean the moved element.
    const tr = (id) => (ren.has(jsonKey(id)) ? ren.get(jsonKey(id)) : id);
    const at = (id) => arr.findIndex((x) => isObj(x) && jsonKey(x.id) === jsonKey(id));
    if (Array.isArray(spec.remove)) {
      const was = isObj(spec.was) ? spec.was : {};
      for (const id of spec.remove) {
        const i = at(tr(id));
        if (i < 0) continue;
        const k = typeof id === 'string' || typeof id === 'number' ? String(id) : null;
        if (k !== null && Object.prototype.hasOwnProperty.call(was, k) && stableKey({ ...was[k], id: arr[i].id }) !== stableKey(arr[i])) continue;
        arr.splice(i, 1);
      }
    }
    if (Array.isArray(spec.upsert)) {
      for (const el of spec.upsert) {
        if (!isObj(el) || el.id == null) continue;
        const id = tr(el.id);
        const i = at(id);
        if (i >= 0) arr[i] = { ...clone(el), id };
        else arr.push({ ...clone(el), id });
      }
    }
    if (Array.isArray(spec.insert)) {
      for (const el of spec.insert) {
        if (!isObj(el) || el.id == null) continue;
        const i = at(el.id);
        if (i < 0) {
          arr.push(clone(el));
          ren.delete(jsonKey(el.id));
        } else if (stableKey(arr[i]) !== stableKey(el)) {
          const id = freeElementId(arr, el.id);
          arr.push({ ...clone(el), id });
          ren.set(jsonKey(el.id), id);
        }
      }
    }
    if (isObj(spec.patch)) {
      for (const [id, fields] of Object.entries(spec.patch)) {
        if (!isObj(fields)) continue;
        const target = ren.has(jsonKey(id)) ? ren.get(jsonKey(id)) : id;
        const i = arr.findIndex((x) => isObj(x) && String(x.id) === String(target));
        if (i >= 0) arr[i] = { ...arr[i], ...clone(fields), id: arr[i].id };
      }
    }
    if (Array.isArray(spec.order) && spec.order.length) {
      const rank = new Map(spec.order.map((id, i) => [jsonKey(tr(id)), i]));
      arr = arr
        .map((x, i) => [x, i])
        .sort(([a, ia], [b, ib]) => {
          const ra = isObj(a) && rank.has(jsonKey(a.id)) ? rank.get(jsonKey(a.id)) : Infinity;
          const rb = isObj(b) && rank.has(jsonKey(b.id)) ? rank.get(jsonKey(b.id)) : Infinity;
          return ra === rb ? ia - ib : ra < rb ? -1 : 1;
        })
        .map(([x]) => x);
    }
    return arr;
  }
  const multi = mode === 'multiset';
  if (Array.isArray(spec.add)) {
    for (const v of spec.add) {
      if (multi || !arr.some((x) => jsonKey(x) === jsonKey(v))) arr.push(clone(v));
    }
  }
  if (Array.isArray(spec.remove)) {
    for (const v of spec.remove) {
      if (multi) {
        const i = arr.findIndex((x) => jsonKey(x) === jsonKey(v));
        if (i >= 0) arr.splice(i, 1);
      } else {
        arr = arr.filter((x) => jsonKey(x) !== jsonKey(v));
      }
    }
  }
  if (multi) {
    arr = arr
      .map((x, i) => [x, i])
      .sort(([a, ia], [b, ib]) => {
        const ka = typeof a === 'string' ? a : jsonKey(a);
        const kb = typeof b === 'string' ? b : jsonKey(b);
        return ka === kb ? ia - ib : ka < kb ? -1 : 1;
      })
      .map(([x]) => x);
    if (Number.isInteger(cap) && cap > 0 && arr.length > cap) arr = arr.slice(-cap);
  }
  return arr;
}

/**
 * The `update` write on one doc: shallow-merge `data` (for meta settings, a
 * plain-object field like `cap` merges one level deep), then add `inc` deltas
 * (missing → 0, floored at 0), then apply `arr` specs.
 */
function updateDoc(doc, w, kind, nested, renames) {
  const out = { ...doc };
  if (isObj(w.data)) {
    for (const [k, v] of Object.entries(clone(w.data))) {
      out[k] = nested && isObj(v) && isObj(doc[k]) ? { ...doc[k], ...v } : v;
    }
  }
  if (isObj(w.inc)) {
    for (const [k, d] of Object.entries(w.inc)) {
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      out[k] = Math.max(0, num(out[k], 0) + d);
    }
  }
  if (isObj(w.arr)) {
    for (const [k, spec] of Object.entries(w.arr)) {
      if (!isObj(spec)) continue;
      const mode = arrayKind(kind, k, spec, out[k]);
      let ren;
      if (renames && mode === 'id') {
        const rk = `${kind}|${out.id ?? ''}|${k}`;
        if (!renames.has(rk)) renames.set(rk, new Map());
        ren = renames.get(rk);
      }
      out[k] = applyArraySpec(out[k], spec, mode, MULTISET_CAP[kind]?.[k], ren);
    }
  }
  return out;
}

const resetMeta = (id) => (id === 'brief' ? null : id === 'clock' ? { active: false } : id === 'sync' ? normalizeSync({}) : normalizeSettings({}));

/**
 * Apply doc-level writes to a state (pure; returns a new state).
 * Write = { op: 'set'|'update'|'delete', col, id, data?, inc?, arr?, ifAbsent? }
 * col is a collection name or 'meta' (id: settings|clock|brief|sync).
 * A collection `set` with `ifAbsent: true` only creates: it is skipped when an
 * entry with that id already exists.
 * `update` shallow-merges `data` into an existing entry (an update to a missing
 * entry is ignored), then applies the optional fine-grained parts:
 *   inc: { field: delta }   numeric delta added to the current value (missing → 0), floored at 0
 *   arr: { field: spec }    element-level array edits (see applyArraySpec)
 * For meta settings, a plain-object field in `data` (cap) merges one level deep.
 */
export function applyWrites(state, writes = []) {
  const next = { ...state };
  const touched = new Set();
  const renames = new Map(); // `${col}|${docId}|${field}` → Map(old element id → new), see applyArraySpec insert
  for (const w of Array.isArray(writes) ? writes : []) {
    if (!w || !w.op || !w.col) continue;
    if (w.col === 'meta') {
      if (!META_DOCS.includes(w.id)) continue;
      const cur = next[w.id];
      if (w.op === 'delete') {
        next[w.id] = resetMeta(w.id);
      } else if (w.op === 'set') {
        next[w.id] = clone(w.data);
      } else if (w.op === 'update' && isObj(cur)) {
        next[w.id] = updateDoc(cur, w, w.id, w.id === 'settings', renames);
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
      // `ifAbsent`: create only. A replay onto a newer state never replaces a doc of
      // that id someone else created meanwhile (a category Claude made with the same slug).
      if (w.ifAbsent && isObj(coll[w.id])) continue;
      coll[w.id] = { ...clone(w.data), id: w.id };
    } else if (w.op === 'update') {
      if (coll[w.id]) coll[w.id] = { ...updateDoc({ ...coll[w.id], id: w.id }, w, w.col, false, renames), id: w.id };
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
 * The id-array spec turning `a` into `b`: new elements → insert, changed ones →
 * patch (only the changed fields; a full upsert if a field was dropped), removed
 * ones → remove with `was`, and `order` when the result's order would differ.
 * null when ids are missing or repeated (the caller then sends `b` wholesale).
 */
function diffIdArray(a, b) {
  const ids = (arr) => {
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      if (!isObj(x) || (typeof x.id !== 'string' && typeof x.id !== 'number')) return null;
      const k = jsonKey(x.id);
      if (seen.has(k)) return null;
      seen.add(k);
      out.push(x.id);
    }
    return out;
  };
  const ia = ids(a);
  const ib = ids(b);
  if (!ia || !ib) return null;
  const before = new Map(a.map((x) => [jsonKey(x.id), x]));
  const inB = new Set(ib.map(jsonKey));
  const insert = [];
  const upsert = [];
  const patch = {};
  for (const x of b) {
    const prev = before.get(jsonKey(x.id));
    if (!prev) {
      insert.push(clone(x));
      continue;
    }
    if (stableKey(prev) === stableKey(x)) continue;
    if (Object.keys(prev).some((k) => !(k in x))) {
      upsert.push(clone(x));
      continue;
    }
    const changed = {};
    for (const [k, v] of Object.entries(x)) if (k !== 'id' && stableKey(prev[k]) !== stableKey(v)) changed[k] = clone(v);
    patch[String(x.id)] = changed;
  }
  const removed = a.filter((x) => !inB.has(jsonKey(x.id)));
  const spec = {};
  if (removed.length) {
    spec.remove = removed.map((x) => x.id);
    spec.was = Object.fromEntries(removed.map((x) => [String(x.id), clone(x)]));
  }
  if (upsert.length) spec.upsert = upsert;
  if (insert.length) spec.insert = insert;
  if (Object.keys(patch).length) spec.patch = patch;
  const got = applyArraySpec(a, spec, 'id').map((x) => jsonKey(x.id));
  if (!sameJSON(got, ib.map(jsonKey))) spec.order = ib.slice();
  return spec;
}

/** { add, remove } turning value-array `a` into `b` (multiset or set difference). */
function diffValueArray(a, b, multi) {
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(jsonKey(x), (m.get(jsonKey(x)) ?? 0) + 1);
    return m;
  };
  const spec = {};
  if (multi) {
    const left = count(a);
    const add = [];
    for (const x of b) {
      const k = jsonKey(x);
      if ((left.get(k) ?? 0) > 0) left.set(k, left.get(k) - 1);
      else add.push(clone(x));
    }
    const right = count(b);
    const remove = [];
    for (const x of a) {
      const k = jsonKey(x);
      if ((right.get(k) ?? 0) > 0) right.set(k, right.get(k) - 1);
      else remove.push(clone(x));
    }
    if (add.length) spec.add = add;
    if (remove.length) spec.remove = remove;
    return spec;
  }
  const inA = new Set(a.map(jsonKey));
  const inB = new Set(b.map(jsonKey));
  const add = [];
  const seen = new Set();
  for (const x of b) {
    const k = jsonKey(x);
    if (!inA.has(k) && !seen.has(k)) {
      seen.add(k);
      add.push(clone(x));
    }
  }
  const remove = [];
  for (const x of a) {
    const k = jsonKey(x);
    if (!inB.has(k) && !seen.has(`-${k}`)) {
      seen.add(`-${k}`);
      remove.push(clone(x));
    }
  }
  if (add.length) spec.add = add;
  if (remove.length) spec.remove = remove;
  return spec;
}

/**
 * The fine-grained `update` that turns doc `prev` into `doc` ({ data, inc?, arr? }),
 * or null when nothing changed. `kind` is the collection name or meta doc id.
 * Every fine-grained part is checked to reproduce `doc` exactly on `prev`;
 * anything it can't express goes wholesale in `data`. With `nested` (meta
 * settings) a changed plain-object field sends only its changed keys; returns
 * 'set' when such a field lost a key (one-level merge can't delete it).
 */
function diffDoc(kind, prev, doc, nested = false) {
  const data = {};
  const inc = {};
  const arr = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(doc)])) {
    if (k.startsWith('_')) continue;
    const a = prev[k];
    const b = doc[k];
    if (sameJSON(a, b)) continue;
    if (b === undefined) {
      data[k] = null;
      continue;
    }
    if (fieldIn(INC_FIELDS, kind, k) && typeof b === 'number' && Number.isFinite(b) && b >= 0 && (a == null || (typeof a === 'number' && Number.isFinite(a)))) {
      inc[k] = b - (a ?? 0);
      continue;
    }
    if (Array.isArray(b) && (a == null || Array.isArray(a))) {
      const from = Array.isArray(a) ? a : [];
      let spec = null;
      let mode = null;
      if (fieldIn(ID_ARRAY_FIELDS, kind, k)) {
        spec = diffIdArray(from, b);
        mode = 'id';
      } else if (fieldIn(MULTISET_FIELDS, kind, k)) {
        spec = diffValueArray(from, b, true);
        mode = 'multiset';
      } else if (fieldIn(SET_FIELDS, kind, k)) {
        spec = diffValueArray(from, b, false);
        mode = 'set';
      }
      if (spec && Object.keys(spec).length && sameJSON(applyArraySpec(from, spec, mode, MULTISET_CAP[kind]?.[k]), b)) {
        arr[k] = spec;
        continue;
      }
    }
    if (nested && isObj(a) && isObj(b)) {
      if (Object.keys(a).some((x) => !(x in b))) return 'set';
      const sub = {};
      for (const [x, v] of Object.entries(b)) if (!sameJSON(a[x], v)) sub[x] = clone(v);
      data[k] = sub;
      continue;
    }
    data[k] = clone(b);
  }
  if (!Object.keys(data).length && !Object.keys(inc).length && !Object.keys(arr).length) return null;
  const out = { data };
  if (Object.keys(inc).length) out.inc = inc;
  if (Object.keys(arr).length) out.arr = arr;
  return out;
}

/**
 * Doc-level writes that turn `base` into `next`: `set` for new entries, `delete`
 * for removed ones, and for changed entries a field-level `update` whose known
 * fields are fine-grained so a replay onto a newer state keeps the other side's
 * concurrent edits:
 *   - tasks.spent / tasks.moved → `inc` deltas (both sides' minutes add up)
 *   - tasks.subs / tasks.blocks / projects.milestones → `arr` by element id: new
 *     elements `insert`, changed ones `patch` (changed fields only), removed ones
 *     `remove` (+ `was`), and `order` when the order changed
 *   - chores.log → `arr` multiset add/remove; cats.aliases → `arr` set add/remove
 *   - other fields → `data` (scalars, and any other array wholesale)
 * Meta: settings gets a field-level `update` (cap only with the weekdays that
 * changed; offDays as set add/remove); clock / brief / sync are `set` whole.
 * Used to replay one side's changes onto a newer remote state (3-way merge):
 *   applyWrites(remote, diffWrites(base, ours))
 * and applyWrites(base, diffWrites(base, next)) reproduces `next`.
 */
export function diffWrites(base, next) {
  const writes = [];
  for (const col of COLLECTIONS) {
    const a = isObj(base?.[col]) ? base[col] : {};
    const b = isObj(next?.[col]) ? next[col] : {};
    if (a === b) continue; // applyWrites copies only touched collections and docs: cheap per-tap diffs
    for (const [id, doc] of Object.entries(b)) {
      const prev = a[id];
      if (prev === doc) continue;
      if (!isObj(prev) || !isObj(doc)) {
        if (!sameJSON(prev, doc) && isObj(doc)) writes.push({ op: 'set', col, id, data: clone(stripMeta(doc)) });
        continue;
      }
      const w = diffDoc(col, prev, doc);
      if (w) writes.push({ op: 'update', col, id, ...w });
    }
    for (const id of Object.keys(a)) if (!(id in b)) writes.push({ op: 'delete', col, id });
  }
  for (const id of META_DOCS) {
    const a = base?.[id] ?? null;
    const b = next?.[id] ?? null;
    if (sameJSON(a, b)) continue;
    if (b == null) {
      writes.push({ op: 'delete', col: 'meta', id });
      continue;
    }
    if (id === 'settings' && isObj(a) && isObj(b)) {
      const w = diffDoc(id, a, b, true);
      if (w === null) continue; // only key order or `_` bookkeeping differs
      if (w !== 'set') {
        writes.push({ op: 'update', col: 'meta', id, ...w });
        continue;
      }
    }
    writes.push({ op: 'set', col: 'meta', id, data: clone(b) });
  }
  return writes;
}
