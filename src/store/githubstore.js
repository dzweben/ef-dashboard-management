// GitHub-backed store: data/state.json in the repo IS the database.
//
//   load()   GET  /repos/{o}/{r}/contents/{path}?ref={branch}   (base64 JSON + sha + ETag)
//   apply()  optimistic local applyWrites, queue the writes, debounce a commit
//   flush()  PUT  /repos/{o}/{r}/contents/{path}  { message, content, sha, branch }
//            409/422 -> refetch, applyWrites(remote, pending), retry (max 3)
//   poll     GET with If-None-Match every pollMs while the page is visible
//
// No token -> read-only mode: reads raw.githubusercontent.com, never writes.
// Works in browsers and Node 22 (fetch, atob/btoa, TextEncoder/TextDecoder are global).
// The token is only ever sent to api.github.com in the Authorization header.
import { normalizeState, emptyState, applyWrites, serializeState } from '../engine/model.js';
import { commitMessage } from '../engine/brief.js';

export const API_BASE = 'https://api.github.com';
export const RAW_BASE = 'https://raw.githubusercontent.com';
export const READONLY_MESSAGE = 'Read-only. Add a token in Setup to save.';
export const TOKEN_MESSAGE = 'GitHub rejected the token. Check Setup.';
export const OFFLINE_BACKOFF_MS = Object.freeze([5000, 15000, 60000]);
export const MAX_PUT_ATTEMPTS = 3;

const PENDING_TTL_MS = 48 * 3600 * 1000; // crash-saved writes older than this are dropped
const STALE_SHA_CAP = 64;

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
const isWrite = (w) => !!w && typeof w === 'object' && typeof w.op === 'string' && typeof w.col === 'string';
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
  // Crash net for queued writes (survives a closed tab / a store swap in Setup).
  // Pass `pendingStorage: null` to disable; defaults to the window's localStorage.
  const pendingStorage = 'pendingStorage' in opts ? opts.pendingStorage : safeLocalStorage(win);

  const tok = typeof token === 'string' ? token.trim() : '';
  const mode = tok ? 'github' : 'readonly';
  const filePath = String(path || 'data/state.json').replace(/^\/+/, '');
  const pendingKey = `ef.pending.v1:${owner}/${repo}:${branch || '~'}:${filePath}`;

  let state = null; // State | null until the first successful load
  let sha = null; // blob sha of the remote file we last saw (null = no file)
  let etag = null; // ETag of the last contents GET
  let rawText = null; // read-only mode: last raw body
  let remoteKnown = false; // we have seen the remote file (or its absence) at least once
  let resolvedBranch = String(branch || '').trim() || null;
  let branchPromise = null;
  const pending = []; // Write[] applied locally, not yet committed
  const pendingActivity = []; // Activity[] for the commit message
  const staleShas = new Set(); // shas we've moved past; ignore lagging replicas that serve them
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

  // ---------------------------------------------------------- persistence of the queue

  function savePending() {
    if (!pendingStorage || mode !== 'github') return;
    try {
      if (pending.length) {
        pendingStorage.setItem(pendingKey, JSON.stringify({ v: 1, at: now(), writes: pending, activity: pendingActivity }));
      } else {
        pendingStorage.removeItem(pendingKey);
      }
    } catch { /* storage full or blocked: in-memory queue still works */ }
  }

  function restorePending() {
    if (!pendingStorage || mode !== 'github') return;
    try {
      const raw = pendingStorage.getItem(pendingKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const age = Date.parse(now()) - Date.parse(saved?.at);
      if (!(age >= 0 && age < PENDING_TTL_MS)) { // too old (or clock weirdness): don't replay
        pendingStorage.removeItem(pendingKey);
        return;
      }
      const ws = Array.isArray(saved.writes) ? saved.writes.filter(isWrite) : [];
      if (!ws.length) return;
      pending.push(...ws);
      if (Array.isArray(saved.activity)) pendingActivity.push(...saved.activity.filter((a) => a && typeof a === 'object'));
    } catch { /* corrupt entry: ignore */ }
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

  function markStale(oldSha) {
    if (!oldSha) return;
    staleShas.add(oldSha);
    while (staleShas.size > STALE_SHA_CAP) staleShas.delete(staleShas.values().next().value);
  }

  /** Take a fetched remote as the new base. Returns true when `state` changed. */
  function adopt(remote) {
    if (remote.notModified) return false;
    if (remote.missing) {
      etag = null;
      if (remoteKnown && !sha && state) return false; // still no file; nothing new
      if (remoteKnown && sha && state) { // file vanished: keep our copy; the next save recreates it
        markStale(sha);
        sha = null;
        return false;
      }
      remoteKnown = true;
      sha = null;
      state = applyWrites(emptyState(), pending);
      return true;
    }
    if (remote.etag) etag = remote.etag;
    if (state && remote.sha && remote.sha === sha) { remoteKnown = true; return false; }
    if (state && remote.sha && staleShas.has(remote.sha)) return false; // a lagging replica served an old version
    if (sha && sha !== remote.sha) markStale(sha);
    sha = remote.sha ?? null;
    staleShas.delete(sha);
    remoteKnown = true;
    state = pending.length ? applyWrites(remote.state, pending) : remote.state;
    return true;
  }

  /** Conflict path: always take what GitHub has now and replay our queue on top. */
  async function rebaseOnRemote() {
    const remote = await fetchRemote({ conditional: false });
    if (remote.missing) {
      markStale(sha);
      sha = null;
      etag = null;
      if (!state) state = applyWrites(emptyState(), pending);
      remoteKnown = true;
      return;
    }
    if (sha && sha !== remote.sha) markStale(sha);
    const before = sha;
    sha = remote.sha ?? null;
    staleShas.delete(sha);
    if (remote.etag) etag = remote.etag;
    remoteKnown = true;
    state = applyWrites(remote.state, pending);
    notify();
    return before === sha; // true = GitHub served the same version that was just rejected
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
    if (mode === 'github' && pending.length) flush();
    else if (!state) load().catch(() => {});
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
      report(err);
      throw err;
    }
    const changed = adopt(remote);
    if (changed || remote.missing) notify();
    backoffIdx = 0;
    if (pending.length) {
      setStatus('pending', `${plural(pending.length, 'change')} waiting to save.`);
      if (!inFlight) scheduleFlush();
    } else if (!inFlight) {
      setStatus('synced', remote.missing
        ? `No ${filePath} on GitHub yet. Your first change creates it.`
        : `Synced with GitHub${sha ? ` (${String(sha).slice(0, 7)})` : ''}.`);
    }
    return state;
  }

  /** Read-only mode: raw.githubusercontent.com, no auth header, cache-busted. */
  async function readRaw({ initial = false } = {}) {
    let ref;
    let res;
    try {
      checkConfig();
      ref = await getBranch();
      bust += 1;
      const url = `${RAW_BASE}/${seg(owner)}/${seg(repo)}/${encodePath(ref)}/${encodePath(filePath)}?ef=${Date.now().toString(36)}${bust}`;
      res = await request('GET', url);
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
    setStatusOnce('readonly', READONLY_MESSAGE);
    return state;
  }

  /** Conditional GET (ETag); replace or rebase when GitHub has something new. */
  function pull() {
    if (disposed) return Promise.resolve(state);
    if (!state) return load();
    if (!pulling) pulling = doPull().finally(() => { pulling = null; });
    return pulling;
  }

  async function doPull() {
    if (mode === 'readonly') {
      try { await readRaw(); } catch { /* status already set */ }
      return state;
    }
    let remote;
    try {
      remote = await fetchRemote({ conditional: true });
    } catch (err) {
      // Don't clobber a queued-save status with a poll hiccup unless it's news.
      report(err);
      return state;
    }
    if (disposed) return state;
    const changed = adopt(remote);
    if (changed) notify();
    backoffIdx = 0;
    if (pending.length) {
      if (changed && !inFlight && !debounceTimer) scheduleFlush();
    } else if (!inFlight && (!status || status.kind !== 'synced' || changed)) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      setStatus('synced', changed ? 'Pulled the latest from GitHub.' : `Synced with GitHub${sha ? ` (${String(sha).slice(0, 7)})` : ''}.`);
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

  async function apply(writes = [], activity = []) {
    if (mode === 'readonly') throw new Error('read-only');
    if (disposed) throw new Error('Store disposed.');
    const ws = Array.isArray(writes) ? writes.filter(isWrite) : [];
    const acts = Array.isArray(activity) ? activity.filter((a) => a && typeof a === 'object') : [];
    if (!ws.length) return state;
    if (loadPromise) {
      try { await loadPromise; } catch { /* apply on top of whatever we have; flush reconciles */ }
    }
    state = applyWrites(state ?? emptyState(), ws);
    pending.push(...ws);
    pendingActivity.push(...acts);
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
      if (!pending.length) return 'ok';
      try {
        if (!remoteKnown || !state) await rebaseOnRemote(); // never PUT blind over a file we haven't read
        const ref = await getBranch();
        const n = pending.length;
        const nAct = pendingActivity.length;
        const body = serializeState(state);
        let message = '';
        try { message = commitMessage(pendingActivity.slice(0, nAct)); } catch { message = ''; }
        if (typeof message !== 'string' || !message.trim()) message = `dash: ${plural(n, 'change')} from EF Console`;
        setStatus('saving', `Pushing ${plural(n, 'change')} to GitHub…`);
        const payload = { message, content: encodeBase64Utf8(body), branch: ref };
        if (sha) payload.sha = sha;
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
          staleShas.delete(sha);
          pending.splice(0, n);
          pendingActivity.splice(0, nAct);
          savePending();
          backoffIdx = 0;
          if (pending.length) setStatus('pending', `${plural(pending.length, 'change')} queued.`);
          else setStatus('synced', `Saved to GitHub${sha ? ` (${sha.slice(0, 7)})` : ''}.`);
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
    hasPending: () => pending.length > 0 || !!inFlight,
    flush,
    dispose,
  };
}
