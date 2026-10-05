// Device-only store: localStorage (when it works), else memory.
// Used for the offline preview build (window.__EF_PREVIEW__) and tests.
// Same interface as the GitHub store, minus the network.
import { normalizeState, emptyState, applyWrites, serializeState } from '../engine/model.js';

export const LOCAL_MESSAGE = 'Saved on this device only (preview).';
const UNSAVED_MESSAGE = 'Preview only: this browser blocks storage, so changes last until you reload.';

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null; // sandboxed iframe / blocked site data
  }
}

const isWrite = (w) => !!w && typeof w === 'object' && typeof w.op === 'string' && typeof w.col === 'string';
const safe = (fn, arg) => { try { fn(arg); } catch (err) { if (typeof console !== 'undefined') console.error(err); } };

export function createLocalStore(seedState, opts = {}) {
  const {
    key = 'ef.state.v1',
    now = () => new Date().toISOString(),
    win = globalThis.window,
  } = opts || {};
  const storage = opts && 'storage' in opts ? opts.storage : defaultStorage();

  let state = null;
  let status = null;
  let disposed = false;
  let listening = false;
  const subs = new Set();
  const statusSubs = new Set();

  function seed() {
    try {
      return normalizeState(seedState ?? {});
    } catch {
      return emptyState();
    }
  }

  /** Stored state, or null when there is none / it's unreadable. */
  function readStored() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function save() {
    if (!storage) return false;
    try {
      storage.setItem(key, serializeState(state));
      return true;
    } catch {
      return false; // quota / blocked
    }
  }

  function notify() {
    if (disposed || !state) return;
    for (const fn of [...subs]) safe(fn, state);
  }

  function setStatus(ok = true) {
    if (disposed) return;
    let at;
    try { at = now(); } catch { at = new Date().toISOString(); }
    status = { kind: 'synced', at, message: ok ? LOCAL_MESSAGE : UNSAVED_MESSAGE };
    for (const fn of [...statusSubs]) safe(fn, status);
  }

  // Another tab of the preview changed the same key: follow it.
  const onStorage = (e) => {
    if (!disposed && e && e.key === key) refresh();
  };

  function listen() {
    if (listening || disposed) return;
    listening = true;
    try {
      if (win && typeof win.addEventListener === 'function') win.addEventListener('storage', onStorage);
    } catch { /* no DOM */ }
  }

  function load() {
    if (disposed) return Promise.reject(new Error('Store disposed.'));
    listen();
    state = readStored() ?? seed();
    notify();
    setStatus(!!storage);
    return Promise.resolve(state);
  }

  function apply(writes = [], activity = []) { // activity entries already ride along in `writes`
    if (disposed) return Promise.reject(new Error('Store disposed.'));
    const ws = Array.isArray(writes) ? writes.filter(isWrite) : [];
    if (!ws.length) return Promise.resolve(state);
    state = applyWrites(state ?? readStored() ?? seed(), ws);
    const ok = save();
    notify();
    setStatus(ok);
    return Promise.resolve(state);
  }

  /** Re-read storage (keeps the in-memory state when storage is empty or blocked). */
  function refresh() {
    if (disposed) return Promise.resolve(state);
    const stored = readStored();
    if (stored) {
      state = stored;
      notify();
    } else if (!state) {
      state = seed();
      notify();
    }
    setStatus(!!storage);
    return Promise.resolve(state);
  }

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

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (listening && win && typeof win.removeEventListener === 'function') win.removeEventListener('storage', onStorage);
    } catch { /* ignore */ }
    subs.clear();
    statusSubs.clear();
  }

  return {
    mode: 'local',
    load,
    subscribe,
    onStatus,
    apply,
    refresh,
    getState: () => state,
    isLoaded: () => state !== null, // same contract as the GitHub store: true once load() ran
    hasPending: () => false,
    flush: () => Promise.resolve(state),
    dispose,
  };
}
