#!/usr/bin/env node
// git merge driver for data/state.json: a 3-way JSON merge instead of a text merge,
// so concurrent edits from the website and from chat both survive and git never
// writes conflict markers into the database.
//
// bin/ef.mjs registers it on every run (local git config + attributes):
//   git config merge.efstate.driver 'node bin/ef-merge.mjs %O %A %B'
//   .gitattributes (and .git/info/attributes): data/state.json merge=efstate
// git runs it from the top of the work tree with three temp files:
//   %O  the common ancestor, %A  the current version (the result is written here),
//   %B  the other side.
//
// Result = applyWrites(A, diffWrites(O, B)): B's changes replayed onto A, field by
// field (model.diffWrites): counters (spent, moved) add up, subs / blocks /
// milestones merge by element id, chore logs merge as multisets, settings merge per
// key, new activity from both sides is kept. Only when both sides changed the same
// field does B's value win.
//
// ef only ever runs `git pull --rebase --autostash`. During the rebase, A is the
// upstream (the website's commits plus our already-replayed ones) and B is our
// commit being replayed; when the autostash is re-applied, A is the new HEAD and B
// our uncommitted edits. Either way B is chat's side, so "B wins" = "chat's value is
// kept", and every such field is reported: one line on stderr, plus a JSON line
// appended to $EF_MERGE_NOTES (ef sets it and prints "BOTH SIDES CHANGED ...").
//
// Exit 0 with the merged, canonical state.json in %A. Exit 1 (git then reports a
// conflict and leaves %A as it was, which is valid JSON) only when a side is not
// valid JSON; ef then aborts the rebase.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeState, serializeState, emptyState, applyWrites, diffWrites } from '../src/engine/model.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Collections / meta docs where "both changed" is bookkeeping, not a disagreement. */
const QUIET_COLS = new Set(['activity', 'sessions']);
const QUIET_META = new Set(['sync', 'brief']);
const QUIET_FIELDS = new Set(['updated', 'created']);

function parseSide(text, label, { emptyOk = false } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) {
    if (emptyOk) return emptyState();
    throw new Error(`${label} is empty`);
  }
  try {
    return normalizeState(JSON.parse(t));
  } catch (err) {
    throw new Error(`${label} is not valid JSON (${err.message})`);
  }
}

function labelOf(col, id, doc) {
  if (col === 'meta') return id;
  return String(doc?.title ?? doc?.name ?? id);
}

const elLabel = (e) => String(e?.t ?? e?.d ?? e?.id ?? '?');

/**
 * Fields both sides changed (vs base) to different values, where the merged
 * result keeps `other`'s value. Each: { col, id, title, field, kept, dropped }.
 */
export function bothChanged(base, current, other, merged) {
  const notes = [];
  const theirs = new Map(diffWrites(base, current).map((w) => [`${w.col}|${w.id}`, w]));
  for (const w of diffWrites(base, other)) {
    if (QUIET_COLS.has(w.col) || (w.col === 'meta' && QUIET_META.has(w.id))) continue;
    const t = theirs.get(`${w.col}|${w.id}`);
    if (!t) continue;
    const docOf = (s) => (w.col === 'meta' ? s?.[w.id] : s?.[w.col]?.[w.id]);
    const title = labelOf(w.col, w.id, docOf(other) ?? docOf(current) ?? docOf(base));
    const a = docOf(current);
    const m = docOf(merged);
    const note = (field, kept, dropped) => notes.push({ col: w.col, id: w.id, title, field, kept: kept ?? null, dropped: dropped ?? null });
    if (w.op === 'delete' || t.op === 'delete') {
      // One side deleted the entry, the other edited it: the delete wins either way
      // (an update to a missing entry is ignored). `by`: which side deleted it.
      if (w.op !== t.op) notes.push({ col: w.col, id: w.id, title, field: '(deleted)', kind: 'deleted', by: w.op === 'delete' ? 'other' : 'current', kept: null, dropped: null });
      continue;
    }
    if (w.op === 'set' || t.op === 'set') {
      if (!sameJSON(m, a)) note(w.col === 'meta' ? w.id : '(whole entry)', m, a);
      continue;
    }
    for (const k of Object.keys(w.data ?? {})) {
      if (QUIET_FIELDS.has(k) || !isObj(t.data) || !(k in t.data)) continue;
      if (w.col === 'meta' && isObj(w.data[k]) && isObj(t.data[k])) {
        for (const sub of Object.keys(w.data[k])) {
          if (sub in t.data[k] && !sameJSON(m?.[k]?.[sub], a?.[k]?.[sub])) note(`${k}.${sub}`, m?.[k]?.[sub], a?.[k]?.[sub]);
        }
        continue;
      }
      if (!sameJSON(m?.[k], a?.[k])) note(k, m?.[k], a?.[k]);
    }
    for (const [k, spec] of Object.entries(w.arr ?? {})) {
      const ts = t.arr?.[k];
      if (!isObj(spec) || !isObj(ts)) continue;
      const fieldsOf = (s) => {
        const out = new Map();
        for (const [id, f] of Object.entries(isObj(s.patch) ? s.patch : {})) out.set(String(id), new Set(Object.keys(isObj(f) ? f : {})));
        for (const e of Array.isArray(s.upsert) ? s.upsert : []) if (isObj(e)) out.set(String(e.id), null); // null = every field
        return out;
      };
      const mine = fieldsOf(spec);
      const yours = fieldsOf(ts);
      for (const [id, fs] of mine) {
        if (!yours.has(id)) continue;
        const ea = (Array.isArray(a?.[k]) ? a[k] : []).find((e) => isObj(e) && String(e.id) === id);
        const em = (Array.isArray(m?.[k]) ? m[k] : []).find((e) => isObj(e) && String(e.id) === id);
        const ys = yours.get(id);
        const keys = new Set([...(fs ?? Object.keys(em ?? {})), ...(ys ?? Object.keys(ea ?? {}))]);
        for (const f of keys) {
          if (f === 'id' || (fs && !fs.has(f)) || (ys && !ys.has(f))) continue;
          if (!sameJSON(em?.[f], ea?.[f])) note(`${k} "${elLabel(em ?? ea)}" ${f}`, em?.[f], ea?.[f]);
        }
      }
    }
  }
  return notes;
}

/** 3-way merge of parsed states: B's (`other`) changes since `base` replayed onto A (`current`). */
export function mergeStates(base, current, other) {
  const merged = normalizeState(applyWrites(current, diffWrites(base, other)));
  return { state: merged, notes: bothChanged(base, current, other, merged) };
}

/** The driver on file contents: { text (canonical state.json), notes }. Throws on unparseable A/B. */
export function mergeTexts(baseText, currentText, otherText) {
  const base = parseSide(baseText, 'the common ancestor (%O)', { emptyOk: true });
  const current = parseSide(currentText, 'the current version (%A)');
  const other = parseSide(otherText, 'the other version (%B)');
  const { state, notes } = mergeStates(base, current, other);
  return { text: serializeState(state), notes };
}

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
};

/** Run as a git merge driver: argv = [%O, %A, %B]. Returns the exit code. */
export function runDriver(argv, env = process.env) {
  const [o, a, b] = argv;
  if (!a || !b) {
    console.error('usage: node bin/ef-merge.mjs %O %A %B');
    return 2;
  }
  try {
    const baseText = o && existsSync(o) ? readFileSync(o, 'utf8') : '';
    const { text, notes } = mergeTexts(baseText, readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
    writeFileSync(a, text);
    for (const n of notes) {
      console.error(n.kind === 'deleted'
        ? `ef-merge: ${n.title} was deleted on one side and edited on the other; it stays deleted`
        : `ef-merge: both sides changed ${n.title} · ${n.field}: kept ${short(n.kept)} over ${short(n.dropped)}`);
    }
    if (notes.length && env.EF_MERGE_NOTES) {
      try {
        appendFileSync(env.EF_MERGE_NOTES, notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
      } catch { /* notes are a courtesy; the merge itself succeeded */ }
    }
    return 0;
  } catch (err) {
    console.error(`ef-merge: could not merge data/state.json: ${err.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = runDriver(process.argv.slice(2));
