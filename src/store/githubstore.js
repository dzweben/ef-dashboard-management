// GitHub-backed store: data/state.json in the repo IS the database.
//
//   load()   GET  /repos/{o}/{r}/contents/{path}?ref={branch}   (base64 JSON + sha + ETag)
//   apply()  optimistic local applyWrites, queue the FINE-GRAINED diff of that
//            change (model.diffWrites: counters as `inc` deltas, id-arrays by
//            element, …) as one batch, debounce a commit
//   flush()  PUT  /repos/{o}/{r}/contents/{path}  { message, content, sha, branch, author, committer }
//            409/422 -> refetch, drop batches GitHub already has, replay the
//            rest on the remote (applyWrites(remote, queued)), retry (max 3)
//   poll     GET with If-None-Match every pollMs while the page is visible
//
// apply() refuses (Error code "not_loaded") until a load from the API has
// succeeded: writes computed against an empty or stale board must never be
// replayed over the real file. If the token is rejected at load, the public
// file is shown read-only (raw.githubusercontent.com) with the error status.
//
// The queue is kept per store instance in localStorage (crash net for a closed
// tab or a store swap in Setup). A new store claims every saved queue for the
// same repo/branch/path; a batch whose activity ids are already in the remote
// file was committed (a PUT whose response was lost) and is dropped, never replayed.
//
// No token -> read-only mode: reads raw.githubusercontent.com, never writes.
// Works in browsers and Node 22 (fetch, atob/btoa, TextEncoder/TextDecoder are global).
// The token is only ever sent to api.github.com in the Authorization header, and
// the store never persists it (where the UI keeps it, e.g. its tokenStorage
// "local" | "session" choice, is the UI's business).
import { normalizeState, emptyState, applyWrites, diffWrites, serializeState, makeId } from '../engine/model.js';
import { commitMessage } from '../engine/brief.js';

export const API_BASE = 'https://api.github.com';
export const RAW_BASE = 'https://raw.githubusercontent.com';
export const READONLY_MESSAGE = 'Read-only. Add a token in Setup to save.';
export const TOKEN_MESSAGE = 'GitHub rejected the token. Check Setup.';
export const LOADING_MESSAGE = 'Still loading your board from GitHub. Try again in a moment.';
export const NOT_LOADED_MESSAGE = "Your board hasn't loaded from GitHub yet.";
export const NOT_LOADED = 'not_loaded'; // err.code from apply() before the first successful load
export const OFFLINE_BACKOFF_MS = Object.freeze([5000, 15000, 60000]);
export const MAX_PUT_ATTEMPTS = 3;

const PENDING_TTL_MS = 48 * 3600 * 1000; // crash-saved batches older than this are dropped
const STALE_SHA_CAP = 64;
const CONFIRM = 'confirm'; // adopt(): "a version we already left came back; re-read before rolling back"

// ------------------------------------------------------------ base64 (UTF-8)

/** UTF-8 string -> base64 (handles emoji, accents, any code point). */
export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 (GitHub wraps it at 60 cols with "\n") -> UTF-8 string. */
export function decodeBase64Utf8(b64) {
  const clean = String(b64 ?? '').replace(/[\s\r\n]+/g, '');
  if (!clean) return '';
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// ------------------------------------------------------------ helpers

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const secs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);
const seg = (s) => encodeURIComponent(String(s ?? '').trim());
const encodePath = (p) => String(p ?? '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWrite = (w) => !!w && typeof w === 'object' && typeof w.op === 'string' && typeof w.col === 'string';
const hasOwn = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const safe = (fn, ...args) => { try { fn(...args); } catch (err) { if (typeof console !== 'undefined') console.error(err); } };

function safeLocalStorage(win) {
  try {
    const s = win && win.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null; // sandboxed iframe / blocked site data
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function header(res, name) {
  try {
    return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  } catch {
    return null;
  }
}

function networkError(cause) {
  const err = new Error("Offline. Can't reach GitHub.");
  err.network = true;
  err.cause = cause;
  return err;
}

function httpError(res, json, { owner, repo } = {}) {
  const status = res?.status ?? 0;
  const ghMessage = (json && typeof json.message === 'string' && json.message) || '';
  const rateLimited = status === 429 ||
    (status === 403 && (header(res, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(ghMessage)));
  let message;
  if (rateLimited) message = 'GitHub rate limit hit. Retrying in a minute.';
  else if (status === 401 || status === 403) message = TOKEN_MESSAGE;
  else if (status === 404) message = `Can't reach ${owner}/${repo} on GitHub (404). Check the repo name and the token's access in Setup.`;
  else message = `GitHub said ${status}${ghMessage ? `: ${ghMessage}` : ''}.`;
  const err = new Error(message);
  err.status = status;
  err.ghMessage = ghMessage;
  err.rateLimited = rateLimited;
  return err;
}

/** `{ name, email }` with both non-empty, or null. */
function gitIdentity(v) {
  if (!isObj(v)) return null;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const email = typeof v.email === 'string' ? v.email.trim() : '';
  return name && email ? { name, email } : null;
}

/** The activity ids a list of writes creates (how a batch is recognized once it is on GitHub). */
const activityIdsOf = (writes) => writes.filter((w) => w.col === 'activity' && w.op === 'set' && typeof w.id === 'string').map((w) => w.id);

/**
 * In the queue, a collection `set` always means "create": diffWrites only emits
 * it for a doc the base didn't have. Mark it so a replay never replaces a doc of
 * that id that exists by then (a category Claude created from chat with the same
 * slug, or our own earlier commit).
 */
const markCreates = (writes) => writes.map((w) => (w.op === 'set' && w.col !== 'meta' ? { ...w, ifAbsent: true } : w));

// ------------------------------------------------------------ the store

export function createGitHubStore(opts = {}) {
  const {
    owner = '',
    repo = '',
    branch = '',
    path = 'data/state.json',
    token = null,
    fetchImpl = globalThis.fetch,
    debounceMs = 2500,
    pollMs = 45000,
    now = () => new Date().toISOString(),
    win = globalThis.window,
    timeoutMs = 20000, // abort a hung request after this long (treated as offline)
  } = opts;
  // Commit identity for website saves (author AND committer), e.g. Danny's
  // GitHub noreply address, so no account email lands in a public history.
  const identity = gitIdentity(opts.author);
  // Crash net for queued writes (survives a closed tab / a store swap in Setup).
  // Pass `pendingStorage: null` to disable; defaults to the window's localStorage.
  const pendingStorage = 'pendingStorage' in opts ? opts.pendingStorage : safeLocalStorage(win);

  const tok = typeof token === 'string' ? token.trim() : '';
  const mode = tok ? 'github' : 'readonly';
  const filePath = String(path || 'data/state.json').replace(/^\/+/, '');
  const queueBase = `${owner}/${repo}:${branch || '~'}:${filePath}`;
  const legacyKey = `ef.pending.v1:${queueBase}`; // one shared queue (before per-instance keys)
  const keyPrefix = `ef.pending.v2:${queueBase}#`;
  const ownKey = `${keyPrefix}${makeId('')}`; // this instance's queue; others are claimed on start

  let state = null; // State | null until the first load (or the read-only fallback)
  let loaded = false; // a load through the API succeeded: `state` is a real base we may write on
  let lastLoadError = null;
  let sha = null; // blob sha of the remote file we last saw (null = no file)
  let etag = null; // ETag of the last contents GET we adopted
  let rawText = null; // read-only mode: last raw body
  let remoteKnown = false; // we have seen the remote file (or its absence) at least once
  let resolvedBranch = String(branch || '').trim() || null;
  let branchPromise = null;
  let publicRef = null; // branch for the read-only fallback, looked up once without the token
  // Batch = { id, at, writes: Write[] (fine-grained), activity: Activity[], acts: activityId[] }
  const pending = [];
  const staleShas = new Set(); // known older than a version we committed or were rejected against
  const leftShas = new Set(); // versions a poll moved us away from (probably older; confirmed before rolling back)
  let status = null;
  let inFlight = null; // Promise while a PUT cycle runs
  let dirty = false; // flush() was requested while a PUT was in flight
  let debounceTimer = null;
  let maxWaitTimer = null;
  let retryTimer = null;
  let pollTimer = null;
  let backoffIdx = 0;
  let loadPromise = null;
  let pulling = null;
  let started = false;
  let disposed = false;
  let bust = 0;
  const subs = new Set();
  const statusSubs = new Set();

  restorePending();

  // ---------------------------------------------------------- notify

  function notify() {
    if (disposed || !state) return;
    for (const fn of [...subs]) safe(fn, state);
  }

  function setStatus(kind, message) {
    if (disposed) return;
    let at;
    try { at = now(); } catch { at = new Date().toISOString(); }
    status = { kind, at, message, pending: pending.length };
    for (const fn of [...statusSubs]) safe(fn, status);
  }

  /** Same as setStatus, but quiet when nothing changed (keeps polls from re-rendering). */
  function setStatusOnce(kind, message) {
    if (status && status.kind === kind && status.message === message) return;
    setStatus(kind, message);
  }

  const syncedMessage = (verb = 'Synced with') => `${verb} GitHub${sha ? ` (${String(sha).slice(0, 7)})` : ''}.`;

  // ---------------------------------------------------------- the queue

  /** Our queued batches replayed on top of `base` (a remote state). */
  function replay(base) {
    if (!pending.length) return base;
    const exists = new Map();
    const out = [];
    for (const b of pending) {
      for (const w of b.writes) {
        if (w.col !== 'meta' && typeof w.id === 'string') {
          const k = `${w.col}\u0000${w.id}`;
          if (!exists.has(k)) exists.set(k, hasOwn(base?.[w.col], w.id));
          if (w.op === 'set') {
            if (w.ifAbsent && exists.get(k)) continue; // someone created it first: keep theirs, our later updates patch it
            exists.set(k, true);
          } else if (w.op === 'delete') {
            exists.set(k, false);
          }
        }
        out.push(w);
      }
    }
    return applyWrites(base, out);
  }

  /** Drop batches GitHub already has (their activity is in `remoteState`). Returns how many. */
  function dropCommitted(remoteState) {
    const acts = remoteState?.activity;
    if (!isObj(acts) || !pending.length) return 0;
    let dropped = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].acts.some((id) => hasOwn(acts, id))) {
        pending.splice(i, 1);
        dropped += 1;
      }
    }
    if (dropped) savePending();
    return dropped;
  }

  function removeBatches(ids) {
    for (let i = pending.length - 1; i >= 0; i--) if (ids.has(pending[i].id)) pending.splice(i, 1);
  }

  // ---------------------------------------------------------- persistence of the queue

  function savePending() {
    if (!pendingStorage || mode !== 'github' || disposed) return false;
    try {
      if (pending.length) pendingStorage.setItem(ownKey, JSON.stringify({ v: 2, at: now(), batches: pending }));
      else pendingStorage.removeItem(ownKey);
      return true;
    } catch {
      return false; // storage full or blocked: the in-memory queue still works
    }
  }

  /** A saved batch, validated, or null when it is junk or older than the TTL. */
  function toBatch(raw, fallbackId) {
    if (!isObj(raw)) return null;
    const age = Date.parse(now()) - Date.parse(raw.at);
    if (!(age >= 0 && age < PENDING_TTL_MS)) return null; // too old (or clock weirdness): don't replay
    const writes = Array.isArray(raw.writes) ? raw.writes.filter(isWrite) : [];
    if (!writes.length) return null;
    const activity = Array.isArray(raw.activity) ? raw.activity.filter(isObj) : [];
    const acts = [...new Set([
      ...(Array.isArray(raw.acts) ? raw.acts.filter((x) => typeof x === 'string') : []),
      ...activityIdsOf(writes),
      ...activity.map((a) => a.id).filter((x) => typeof x === 'string'),
    ])];
    return { id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId, at: raw.at, writes, activity, acts };
  }

  /** Batches stored under one key (v2 per-instance queue, or the v1 shared queue as one batch). */
  function readEntry(text) {
    try {
      const saved = JSON.parse(text);
      if (saved?.v === 2 && Array.isArray(saved.batches)) {
        return saved.batches.map((b, i) => toBatch(b, `q_${saved.at}_${i}`)).filter(Boolean);
      }
      if (Array.isArray(saved?.writes)) { // v1: whole-doc op writes, replayed as they are (creates guarded)
        const b = toBatch({ ...saved, writes: markCreates(saved.writes.filter(isWrite)) }, `legacy_${saved.at}`);
        return b ? [b] : [];
      }
    } catch { /* corrupt entry */ }
    return [];
  }

  /** On start: claim every saved queue for this repo/branch/path (other tabs, earlier stores, v1). */
  function restorePending() {
    if (!pendingStorage || mode !== 'github') return;
    const keys = [legacyKey];
    try {
      const n = Number(pendingStorage.length) || 0;
      if (typeof pendingStorage.key === 'function') {
        for (let i = 0; i < n; i++) {
          const k = pendingStorage.key(i);
          if (typeof k === 'string' && k.startsWith(keyPrefix) && k !== ownKey) keys.push(k);
        }
      }
    } catch { /* no key enumeration: only the v1 queue is found */ }
    const claimed = [];
    const seen = new Set();
    for (const k of keys) {
      let text = null;
      try { text = pendingStorage.getItem(k); } catch { /* blocked */ }
      if (text == null) continue;
      claimed.push(k);
      for (const b of readEntry(text)) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        pending.push(b);
      }
    }
    pending.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    // Keep them under our own key before releasing the others, so a crash in between loses nothing.
    if (pending.length && !savePending()) return;
    for (const k of claimed) {
      try { pendingStorage.removeItem(k); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------- HTTP

  function apiHeaders(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (tok) h.Authorization = `Bearer ${tok}`;
    return h;
  }

  async function request(method, url, { headers, body } = {}) {
    if (typeof fetchImpl !== 'function') throw networkError(new Error('fetch is not available'));
    const init = { method, cache: 'no-store' };
    if (headers) init.headers = headers;
    if (body !== undefined) init.body = JSON.stringify(body);
    let timer = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
      const ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), timeoutMs);
    }
    try {
      const res = await fetchImpl(url, init);
      if (!res || typeof res.status !== 'number') throw new Error('bad response');
      return res;
    } catch (err) {
      throw networkError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const repoUrl = () => `${API_BASE}/repos/${seg(owner)}/${seg(repo)}`;
  const contentsUrl = (ref) => `${repoUrl()}/contents/${encodePath(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const rawUrl = (ref) => {
    bust += 1;
    return `${RAW_BASE}/${seg(owner)}/${seg(repo)}/${encodePath(ref)}/${encodePath(filePath)}?ef=${Date.now().toString(36)}${bust}`;
  };

  function checkConfig() {
    if (!String(owner).trim() || !String(repo).trim()) {
      const err = new Error('Set the GitHub owner and repo in Setup.');
      err.config = true;
      throw err;
    }
  }

  /** Branch '' -> the repo's default branch (asked once, then cached). */
  async function getBranch() {
    if (resolvedBranch) return resolvedBranch;
    if (!branchPromise) {
      branchPromise = (async () => {
        const res = await request('GET', repoUrl(), { headers: apiHeaders() });
        const json = await readJson(res);
        if (res.ok) return (json && typeof json.default_branch === 'string' && json.default_branch) || 'main';
        // Read-only mode on a private/unknown repo or a rate limit: just try "main".
        if (mode === 'readonly') return 'main';
        throw httpError(res, json, { owner, repo });
      })().then(
        (b) => { resolvedBranch = b; return b; },
        (err) => { branchPromise = null; throw err; },
      );
    }
    return branchPromise;
  }

  function parseState(text) {
    const t = String(text ?? '').trim();
    if (!t) return emptyState();
    let raw;
    try {
      raw = JSON.parse(t);
    } catch (e) {
      const err = new Error(`${filePath} on GitHub isn't valid JSON (${e.message}). Nothing was overwritten; fix the file in the repo.`);
      err.parse = true;
      throw err;
    }
    return normalizeState(raw);
  }

  /**
   * GET the file through the Contents API.
   * -> { notModified: true } | { missing: true } | { state, sha, etag, text }
   */
  async function fetchRemote({ conditional = false } = {}) {
    checkConfig();
    const ref = await getBranch();
    const extra = conditional && etag ? { 'If-None-Match': etag } : {};
    const res = await request('GET', contentsUrl(ref), { headers: apiHeaders(extra) });
    if (res.status === 304) return { notModified: true };
    const json = await readJson(res);
    if (res.status === 404) {
      if (json && /no commit found for the ref/i.test(String(json.message || ''))) {
        const err = new Error(`Branch "${ref}" doesn't exist in ${owner}/${repo}. Check Setup.`);
        err.config = true;
        throw err;
      }
      return { missing: true };
    }
    if (!res.ok) throw httpError(res, json, { owner, repo });
    if (!json || Array.isArray(json) || (json.type && json.type !== 'file')) {
      throw new Error(`${filePath} on GitHub is not a file.`);
    }
    let b64 = typeof json.content === 'string' ? json.content : '';
    if (json.encoding === 'none' || (!b64 && Number(json.size) > 0)) {
      // Files over 1 MB come back without content: read the blob by sha instead.
      const blobRes = await request('GET', `${repoUrl()}/git/blobs/${seg(json.sha)}`, { headers: apiHeaders() });
      const blob = await readJson(blobRes);
      if (!blobRes.ok) throw httpError(blobRes, blob, { owner, repo });
      b64 = (blob && typeof blob.content === 'string' && blob.content) || '';
    }
    let text;
    try {
      text = decodeBase64Utf8(b64);
    } catch (e) {
      const err = new Error(`${filePath} on GitHub couldn't be decoded (${e.message}).`);
      err.parse = true;
      throw err;
    }
    return { state: parseState(text), sha: json.sha ?? null, etag: header(res, 'etag'), text };
  }

  function capped(set, value) {
    if (!value) return;
    set.add(value);
    while (set.size > STALE_SHA_CAP) set.delete(set.values().next().value);
  }
  const markStale = (oldSha) => capped(staleShas, oldSha);

  /** Make a fetched file our base: drop what it already contains from the queue, replay the rest. */
  function takeRemote(remote) {
    etag = remote.etag || null;
    sha = remote.sha ?? null;
    if (sha) { staleShas.delete(sha); leftShas.delete(sha); }
    remoteKnown = true;
    dropCommitted(remote.state);
    state = replay(remote.state);
  }

  /**
   * Take a fetched remote (load / poll) as the new base. Returns true when
   * `state` changed, or CONFIRM when it is a version a poll already moved us
   * away from (a lagging replica, usually): the caller re-reads before rolling
   * back. `trusted` (a first load, a confirmed read) skips the ordering checks.
   */
  function adopt(remote, { trusted = false } = {}) {
    if (remote.notModified) return false;
    if (remote.missing) {
      etag = null;
      remoteKnown = true;
      if (loaded && state) { // file vanished: keep our copy; the next save recreates it
        if (sha) markStale(sha);
        sha = null;
        return false;
      }
      sha = null;
      state = replay(emptyState());
      return true;
    }
    const incoming = remote.sha ?? null;
    if (loaded && state && incoming && incoming === sha) {
      if (remote.etag) etag = remote.etag;
      remoteKnown = true;
      return false;
    }
    if (loaded && state && incoming && !trusted) {
      if (staleShas.has(incoming)) return false; // older than what we committed: a lagging replica (etag untouched)
      if (leftShas.has(incoming)) return CONFIRM;
    }
    // A sha we haven't seen is taken as newer, but the one we leave is only
    // "probably older": if it comes back, re-read first instead of ignoring it forever.
    if (sha && sha !== incoming) capped(leftShas, sha);
    takeRemote(remote);
    return true;
  }

  /** Conflict path: always take what GitHub has now and replay our queue on top. */
  async function rebaseOnRemote() {
    const remote = await fetchRemote({ conditional: false });
    if (disposed) return false;
    const before = sha;
    if (remote.missing) {
      if (sha) markStale(sha);
      sha = null;
      etag = null;
      remoteKnown = true;
      if (!loaded || !state) state = replay(emptyState());
    } else {
      if (sha && sha !== remote.sha) markStale(sha); // GitHub rejected it: it is behind for good
      takeRemote(remote);
    }
    loaded = true;
    lastLoadError = null;
    notify();
    return !remote.missing && before === sha; // true = GitHub served the same version that was just rejected
  }

  // ---------------------------------------------------------- errors / retry

  function scheduleRetry(delay) {
    if (disposed) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(recover, delay);
  }

  function nextBackoff() {
    const delay = OFFLINE_BACKOFF_MS[Math.min(backoffIdx, OFFLINE_BACKOFF_MS.length - 1)];
    backoffIdx += 1;
    return delay;
  }

  /** Turn an error into a status (and a retry where retrying can help). */
  function report(err) {
    if (disposed) return;
    const kept = pending.length ? ` ${plural(pending.length, 'change')} kept on this device.` : '';
    if (err && err.network) {
      const delay = nextBackoff();
      scheduleRetry(delay);
      setStatus('offline', `Offline. Can't reach GitHub.${kept} Retrying in ${secs(delay)}.`);
      return;
    }
    if (err && err.rateLimited) {
      scheduleRetry(60000);
      setStatus('error', `GitHub rate limit hit.${kept} Retrying in 1m.`);
      return;
    }
    if (err && (err.status === 401 || err.status === 403) && mode === 'github') {
      setStatus('error', TOKEN_MESSAGE);
      return;
    }
    if (err && err.status >= 500) {
      const delay = nextBackoff();
      scheduleRetry(delay);
      setStatus('error', `GitHub hiccup (${err.status}).${kept} Retrying in ${secs(delay)}.`);
      return;
    }
    setStatus('error', (err && err.message) || String(err));
  }

  /** Timer / 'online' path: do whatever is outstanding. */
  function recover() {
    retryTimer = null;
    if (disposed) return;
    if (!loaded) load().catch(() => {});
    else if (mode === 'github' && pending.length) flush();
    else pull().catch(() => {});
  }

  // ---------------------------------------------------------- load / pull

  function load() {
    if (disposed) return Promise.reject(new Error('Store disposed.'));
    start();
    if (!loadPromise) {
      loadPromise = (mode === 'readonly' ? readRaw({ initial: true }) : loadFromApi()).finally(() => {
        loadPromise = null;
      });
    }
    return loadPromise;
  }

  async function loadFromApi() {
    let remote;
    try {
      remote = await fetchRemote({ conditional: false });
    } catch (err) {
      if (!loaded) lastLoadError = err;
      report(err);
      // The API refused us (bad/expired token, no access, rate limit, 5xx): show the
      // public file read-only so the board isn't stuck on "loading". Writes stay refused.
      if (!loaded && err && err.status && !err.config && !err.parse) await showPublicCopy();
      throw err;
    }
    if (disposed) return state;
    const changed = adopt(remote, { trusted: !loaded }) === true; // a re-load never rolls back to a version we left
    loaded = true;
    lastLoadError = null;
    if (changed) notify();
    backoffIdx = 0;
    if (pending.length) {
      setStatus('pending', `${plural(pending.length, 'change')} waiting to save.`);
      if (!inFlight) scheduleFlush();
    } else if (!inFlight) {
      setStatus('synced', remote.missing
        ? `No ${filePath} on GitHub yet. Your first change creates it.`
        : syncedMessage());
    }
    return state;
  }

  /**
   * Best effort, github mode only: the file from raw.githubusercontent.com (no
   * token) for display while the API load fails. Never sets the status, never
   * makes the store writable.
   */
  async function showPublicCopy() {
    try {
      if (!publicRef) publicRef = resolvedBranch;
      if (!publicRef) {
        const res = await request('GET', repoUrl(), { headers: { Accept: 'application/vnd.github+json' } });
        const json = await readJson(res);
        publicRef = (res.ok && json && typeof json.default_branch === 'string' && json.default_branch) || 'main';
      }
      const res = await request('GET', rawUrl(publicRef));
      if (!res.ok) return;
      const next = parseState(await res.text());
      if (disposed || loaded) return;
      dropCommitted(next);
      state = replay(next);
      notify();
    } catch { /* nothing to show: the status already explains */ }
  }

  /** Read-only mode: raw.githubusercontent.com, no auth header, cache-busted. */
  async function readRaw({ initial = false } = {}) {
    let res;
    try {
      checkConfig();
      const ref = await getBranch();
      res = await request('GET', rawUrl(ref));
    } catch (err) {
      report(err);
      throw err;
    }
    if (res.status === 404) {
      if (state === null || rawText !== null) {
        rawText = null;
        state = emptyState();
        notify();
      }
      loaded = true;
      setStatusOnce('readonly', `Read-only. Couldn't read ${filePath} from ${owner}/${repo} (private repo?). Add a token in Setup.`);
      return state;
    }
    if (!res.ok) {
      const err = httpError(res, null, { owner, repo });
      if (err.status === 401 || err.status === 403) err.message = `GitHub refused the read (${err.status}). ${READONLY_MESSAGE}`;
      report(err);
      throw err;
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      const err = networkError(e);
      report(err);
      throw err;
    }
    if (initial || text !== rawText || state === null) {
      try {
        const next = parseState(text);
        rawText = text;
        state = next;
        notify();
      } catch (err) {
        report(err);
        throw err;
      }
    }
    loaded = true;
    setStatusOnce('readonly', READONLY_MESSAGE);
    return state;
  }

  /** Conditional GET (ETag); replace or rebase when GitHub has something new. */
  function pull() {
    if (disposed) return Promise.resolve(state);
    if (!loaded) return load();
    if (!pulling) {
      pulling = (async () => {
        if (inFlight) await inFlight; // never swap the base under a PUT
        return doPull();
      })().finally(() => { pulling = null; });
    }
    return pulling;
  }

  async function doPull() {
    if (disposed) return state;
    if (mode === 'readonly') {
      try { await readRaw(); } catch { /* status already set */ }
      return state;
    }
    let changed;
    try {
      const remote = await fetchRemote({ conditional: true });
      if (disposed) return state;
      changed = adopt(remote);
      if (changed === CONFIRM) {
        // A version we already moved past is back. Usually a lagging replica; but
        // if GitHub serves it again it is the real head (we had taken an older,
        // unseen version for newer), so take it rather than stick on ours.
        const again = await fetchRemote({ conditional: false });
        if (disposed) return state;
        changed = adopt(again, { trusted: !again.missing && again.sha === remote.sha });
        if (changed === CONFIRM) changed = false;
      }
    } catch (err) {
      // Don't clobber a queued-save status with a poll hiccup unless it's news.
      report(err);
      return state;
    }
    if (changed) notify();
    backoffIdx = 0;
    if (pending.length) {
      if (changed && !inFlight && !debounceTimer) scheduleFlush();
    } else if (!inFlight && (!status || status.kind !== 'synced' || changed)) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      setStatus('synced', changed ? 'Pulled the latest from GitHub.' : syncedMessage());
    }
    return state;
  }

  /** Pull now; if writes are stuck (offline/conflict/error), push them too. Never rejects. */
  async function refresh() {
    if (disposed) return state;
    try { await pull(); } catch { /* status already set */ }
    if (mode === 'github' && pending.length && !inFlight && !debounceTimer) {
      backoffIdx = 0;
      await flush();
    }
    return state;
  }

  // ---------------------------------------------------------- apply / flush

  function notLoadedError() {
    const err = new Error(loadPromise ? LOADING_MESSAGE : (lastLoadError && lastLoadError.message) || NOT_LOADED_MESSAGE);
    err.code = NOT_LOADED;
    if (lastLoadError) err.cause = lastLoadError;
    return err;
  }

  /**
   * Optimistically apply an op's writes and queue them as one batch: the
   * fine-grained diff of the change (diffWrites), so a replay onto a newer
   * remote keeps the other side's concurrent edits. Rejects (code "not_loaded")
   * until a load has succeeded: those writes were computed against a board we
   * don't have.
   */
  async function apply(writes = [], activity = []) {
    if (mode === 'readonly') throw new Error('read-only');
    if (disposed) throw new Error('Store disposed.');
    const ws = Array.isArray(writes) ? writes.filter(isWrite) : [];
    if (!ws.length) return state;
    if (!loaded || !state) throw notLoadedError();
    const before = state;
    const after = applyWrites(before, ws);
    const queued = markCreates(diffWrites(before, after));
    if (!queued.length) return state; // nothing actually changed (e.g. an update to a doc that is gone)
    const given = Array.isArray(activity) ? activity.filter(isObj) : [];
    const created = queued.filter((w) => w.col === 'activity' && w.op === 'set' && isObj(w.data)).map((w) => w.data);
    const acts = activityIdsOf(queued);
    let at;
    try { at = now(); } catch { at = new Date().toISOString(); }
    pending.push({ id: makeId('q_'), at, writes: queued, activity: given.length ? given : created, acts });
    state = after;
    savePending();
    notify();
    if (retryTimer) {
      // Offline/backing off: queue it; the retry (or 'online') pushes everything.
      setStatus(status?.kind === 'offline' ? 'offline' : 'pending',
        `${status?.kind === 'offline' ? 'Offline. ' : ''}${plural(pending.length, 'change')} kept on this device.`);
    } else {
      setStatus('pending', `${plural(pending.length, 'change')} queued.`);
      scheduleFlush();
    }
    return state;
  }

  function clearFlushTimers() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
  }

  function fireFlush() {
    clearFlushTimers();
    flush();
  }

  /** Debounce: each apply resets the timer, capped at 4x debounceMs from the first queued write. */
  function scheduleFlush() {
    if (disposed || mode !== 'github') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fireFlush, Math.max(0, debounceMs));
    if (!maxWaitTimer) maxWaitTimer = setTimeout(fireFlush, Math.max(0, debounceMs * 4));
  }

  /** Push everything queued now. Never rejects; failures become a status. Resolves to the state. */
  function flush() {
    if (mode !== 'github' || disposed) return Promise.resolve(state);
    clearFlushTimers();
    if (inFlight) {
      dirty = true;
      return inFlight;
    }
    if (!pending.length) return Promise.resolve(state);
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    inFlight = (async () => {
      try {
        let outcome;
        do {
          dirty = false;
          outcome = await pushOnce();
        } while (outcome === 'ok' && dirty && pending.length && !disposed);
      } catch (err) {
        report(err);
      } finally {
        inFlight = null;
      }
      return state;
    })();
    return inFlight;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** One commit, with up to MAX_PUT_ATTEMPTS tries through sha conflicts. -> 'ok' | 'fail' */
  async function pushOnce() {
    let lastConflict = '';
    for (let attempt = 1; attempt <= MAX_PUT_ATTEMPTS; attempt++) {
      if (disposed) return 'fail'; // a replaced store never writes again; its queue is claimed by the next one
      if (!pending.length) { // e.g. the rebase found every batch already on GitHub
        setStatus('synced', syncedMessage());
        return 'ok';
      }
      try {
        if (!loaded || !remoteKnown || !state) { // never PUT blind over a file we haven't read
          await rebaseOnRemote();
          if (disposed) return 'fail';
          if (!pending.length) continue;
        }
        const ref = await getBranch();
        const sent = pending.slice();
        const ids = new Set(sent.map((b) => b.id));
        const body = serializeState(state);
        let message = '';
        try { message = commitMessage(sent.flatMap((b) => b.activity)); } catch { message = ''; }
        if (typeof message !== 'string' || !message.trim()) message = `dash: ${plural(sent.length, 'change')} from EF Console`;
        setStatus('saving', `Pushing ${plural(sent.length, 'change')} to GitHub…`);
        const payload = { message, content: encodeBase64Utf8(body), branch: ref };
        if (sha) payload.sha = sha;
        if (identity) {
          payload.author = { ...identity };
          payload.committer = { ...identity };
        }
        const res = await request('PUT', contentsUrl(null), {
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: payload,
        });
        const json = await readJson(res);
        if (res.ok) {
          const newSha = json && json.content && typeof json.content.sha === 'string' ? json.content.sha : null;
          if (sha && newSha !== sha) markStale(sha);
          sha = newSha;
          if (!newSha) remoteKnown = false; // odd response: re-read before the next save
          else { staleShas.delete(sha); leftShas.delete(sha); }
          removeBatches(ids); // by id: batches queued (or dropped) meanwhile are untouched
          savePending();
          backoffIdx = 0;
          if (pending.length) setStatus('pending', `${plural(pending.length, 'change')} queued.`);
          else setStatus('synced', syncedMessage('Saved to'));
          return 'ok';
        }
        if (res.status === 409 || res.status === 422) {
          lastConflict = (json && json.message) || `HTTP ${res.status}`;
          const sameAsRejected = await rebaseOnRemote();
          if (sameAsRejected && attempt < MAX_PUT_ATTEMPTS) await sleep(700 * attempt); // replica lag: give it a beat
          continue;
        }
        throw httpError(res, json, { owner, repo });
      } catch (err) {
        report(err);
        return 'fail';
      }
    }
    if (!pending.length) {
      setStatus('synced', syncedMessage());
      return 'ok';
    }
    setStatus('conflict', `Couldn't merge with GitHub after ${MAX_PUT_ATTEMPTS} tries (${lastConflict}). ` +
      `${plural(pending.length, 'change')} kept on this device. Tap sync to retry.`);
    return 'fail';
  }

  // ---------------------------------------------------------- polling + window events

  const doc = () => (win && win.document) || null;
  const isVisible = () => {
    const d = doc();
    return !d || d.visibilityState !== 'hidden';
  };

  function schedulePoll() {
    if (disposed || !(pollMs > 0)) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!disposed && isVisible() && !inFlight) {
        try { await pull(); } catch { /* status already set */ }
      }
      schedulePoll();
    }, pollMs);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref(); // don't hold a Node process open
  }

  const onVisibility = () => {
    if (disposed) return;
    if (isVisible()) refresh().catch(() => {});
    else if (pending.length) flush(); // tab hidden / phone locked: save now
  };
  const onOnline = () => {
    if (disposed) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    backoffIdx = 0;
    recover();
  };
  const onBeforeUnload = (e) => {
    if (disposed || !(pending.length || inFlight)) return;
    flush();
    try { e.preventDefault(); } catch { /* ignore */ }
    try { e.returnValue = ''; } catch { /* ignore */ }
  };

  function start() {
    if (started || disposed) return;
    started = true;
    schedulePoll();
    try {
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('online', onOnline);
        if (mode === 'github') win.addEventListener('beforeunload', onBeforeUnload);
      }
      const d = doc();
      if (d && typeof d.addEventListener === 'function') d.addEventListener('visibilitychange', onVisibility);
    } catch { /* no DOM events */ }
  }

  /**
   * Stop: no timers, events, notifications, storage writes or further PUTs. A
   * PUT already on the wire may still land; the batches stay in this store's
   * saved queue, and the next store claims them and drops what GitHub has.
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearFlushTimers();
    for (const t of [retryTimer, pollTimer]) if (t) clearTimeout(t);
    retryTimer = null;
    pollTimer = null;
    try {
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('online', onOnline);
        win.removeEventListener('beforeunload', onBeforeUnload);
      }
      const d = doc();
      if (d && typeof d.removeEventListener === 'function') d.removeEventListener('visibilitychange', onVisibility);
    } catch { /* ignore */ }
    subs.clear();
    statusSubs.clear();
  }

  // ---------------------------------------------------------- public API

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subs.add(fn);
    if (state && !disposed) safe(fn, state);
    return () => subs.delete(fn);
  }

  function onStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    statusSubs.add(fn);
    if (status && !disposed) safe(fn, status);
    return () => statusSubs.delete(fn);
  }

  return {
    mode,
    load,
    subscribe,
    onStatus,
    apply,
    refresh,
    getState: () => state,
    /** true once a load succeeded (github: through the API, so apply() works; readonly: the raw read). */
    isLoaded: () => loaded,
    hasPending: () => pending.length > 0 || !!inFlight,
    flush,
    dispose,
  };
}
