// Quick-add parsing ("email mike - tomorrow") and category inference.
// Pure: no DOM, no Node APIs. See docs/ARCHITECTURE.md ("parse.js").
//
// How parseQuickAdd works: the input is whitespace-collapsed, then structured
// pieces are found and blanked out (replaced by spaces, so indices stay put)
// in a fixed order: #tags, recurrence, estimate, time, priority, due phrases
// ("by fri", "due 10/16"), "@date", a trailing " - <date>" segment, a bare
// trailing date ("call mom sat"), a leading date ("tomorrow: email mike") and a
// trailing "low". Whatever is left, tidied, is the title.

import { parseDatePhrase, parseDuration, parseTime, isISODate, todayISO } from './dates.js';
import { DEFAULT_CATEGORIES, KEYWORD_RULES, resolveCategory, catList } from './categories.js';
import { INBOX_CATEGORY } from './model.js';

// ---------------------------------------------------------------- small helpers

const B = '(^|[^a-z0-9])'; // word-ish left boundary (captured; no lookbehind for old Safari)
const E = '(?![a-z0-9])'; // word-ish right boundary
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const NUM_WORDS = {
  a: 1, an: 1, one: 1, once: 1, two: 2, twice: 2, three: 3, thrice: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const toNum = (s) => {
  const t = String(s ?? '').toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NUM_WORDS[t] ?? null;
};

/** Mutable scratch for one parse: `w` is the working copy with consumed spans blanked. */
function makeWork(text) {
  return { orig: text, w: text, tokens: [] };
}

function mask(st, start, end) {
  if (end <= start) return;
  st.w = st.w.slice(0, start) + ' '.repeat(end - start) + st.w.slice(end);
}

function addToken(st, type, start, end, value, text) {
  const t = (text ?? st.orig.slice(start, end)).replace(/\s+/g, ' ').trim();
  st.tokens.push({ type, text: t, value, _at: start });
}

/** Run a global regex over the current working text; fn(m, start, end) returns true to blank the span. */
function scan(st, re, fn) {
  const snapshot = st.w;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(snapshot))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const lead = typeof m[1] === 'string' && re.source.startsWith('(^|') ? m[1].length : 0;
    const start = m.index + lead;
    const end = m.index + m[0].length;
    // Skip spans that an earlier pass already consumed.
    if (st.w.slice(start, end) !== snapshot.slice(start, end)) continue;
    if (fn(m, start, end)) mask(st, start, end);
  }
}

// ---------------------------------------------------------------- dates

// Short date words that are also common words or names; they need more context.
const WEAK_DATE_WORDS = new Set(['tom', 'tod', 'mon', 'sun', 'sat', 'wed']);
const NAME_LIKE_DATE_WORDS = new Set(['tom', 'tod']);
// Words after which a weak date word is probably a name/object, not a date.
const WEAK_BLOCKERS = new Set([
  'email', 'e-mail', 'call', 'text', 'ping', 'ask', 'tell', 'remind', 'message', 'msg', 'thank', 'dm',
  'with', 'w/', 'to', 'for', 'from', 'and', '&', 'or', 'cc', 'visit', 'see', 'meet', 'up', 'help', 'invite',
]);
// Words after which a trailing date-looking word is a noun ("the friday", "some sun").
const DETERMINERS = new Set([
  'the', 'a', 'an', 'some', 'my', 'your', 'his', 'her', 'our', 'their', 'its', 'of', 'this', 'that',
  'these', 'those', 'every', 'each', 'per', 'no',
]);
const LEADING_DATE_RE = new RegExp(
  '^(?:today|tonight|tomorrow|tmrw|tmr|tmw|2morrow|this (?:morning|afternoon|evening|weekend)|next week(?:end)?|' +
    'next month|eow|eom|end of (?:the )?(?:week|month)|in \\S+ (?:days?|weeks?|months?)|\\d{1,4}[/-]\\d|' +
    '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.? \\d)',
  'i',
);
const QUALIFIER_RE = /\s+(?:in the\s+)?(morning|afternoon|evening|night|am|pm|eod|first thing)$/i;

const coreDateWord = (consumed) => consumed.toLowerCase().replace(/^on\s+/, '').trim();
const isWeak = (consumed) => WEAK_DATE_WORDS.has(coreDateWord(consumed));

/** The whole (trimmed, collapsed) string is a date phrase, optionally + a time-of-day qualifier. */
function wholeDate(s, today) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const tryOne = (x) => {
    const hit = parseDatePhrase(x, today);
    return hit && hit.consumed.length === x.length ? hit : null;
  };
  let hit = tryOne(t);
  if (hit) return { date: hit.date, text: t, core: hit.consumed };
  const q = t.match(QUALIFIER_RE);
  if (q) {
    hit = tryOne(t.slice(0, q.index));
    if (hit) return { date: hit.date, text: t, core: hit.consumed };
  }
  return null;
}

/** Date phrase at the start of `rest` plus an optional qualifier; returns { date, len, core } in `rest` coordinates. */
function leadingDate(rest, today) {
  const lead = rest.match(/^\s*/)[0].length;
  const hit = parseDatePhrase(rest, today);
  if (!hit) return null;
  let len = lead + hit.consumed.length;
  const q = rest.slice(len).match(/^\s+(?:in the\s+)?(?:morning|afternoon|evening|night|eod)(?![a-z0-9])/i);
  if (q) len += q[0].length;
  return { date: hit.date, len, core: hit.consumed };
}

// Name-like weak word ("Tom") typed with a capital letter is a person, not "tomorrow".
function capitalizedName(st, start, core) {
  if (!NAME_LIKE_DATE_WORDS.has(coreDateWord(core))) return false;
  const src = st.orig.slice(start, start + core.length).replace(/^on\s+/i, '');
  return /^[A-Z][a-z]/.test(src);
}

// ---------------------------------------------------------------- pieces

const TAG_RE = /(^|\s)#([a-z][\w\-+&./:]*)/gi;

const RECUR_RULES = [
  // "2x a day", "3 times per day", "2x/day", "2x daily", "2x a week"
  [new RegExp(`${B}(\\d+|one|two|three|four|five|six)\\s*(?:x|times)\\s*(?:a|per|each|every|/)?\\s*(day|daily|week|weekly|wk)${E}`, 'gi'),
    (m) => perPeriod(toNum(m[2]), m[3])],
  // "twice a day", "once a week", "twice daily"
  [new RegExp(`${B}(once|twice|thrice)\\s*(?:a|per|each|every|/)?\\s*(day|daily|week|weekly|wk)${E}`, 'gi'),
    (m) => perPeriod(toNum(m[2]), m[3])],
  // "every morning and night", "am & pm"
  [new RegExp(`${B}(?:(?:every|each)\\s+)?(?:morning|am)\\s*(?:and|&|\\+|/)\\s*(?:night|evening|pm)${E}`, 'gi'),
    () => ({ every: 1, perDay: 2 })],
  [new RegExp(`${B}every\\s+other\\s+(day|week|month)${E}`, 'gi'),
    (m) => ({ every: m[2].toLowerCase() === 'day' ? 2 : m[2].toLowerCase() === 'week' ? 14 : 60, perDay: 1 })],
  [new RegExp(`${B}(?:every|each)\\s+(\\d+|two|three|four|five|six|seven|eight|nine|ten)\\s+(days?|weeks?|wks?|months?)${E}`, 'gi'),
    (m) => {
      const n = Math.max(1, toNum(m[2]) ?? 1);
      const u = m[3].toLowerCase();
      return { every: Math.min(365, u.startsWith('d') ? n : u.startsWith('w') ? n * 7 : n * 30), perDay: 1 };
    }],
  [new RegExp(`${B}(?:(?:every|each)\\s+(?:day|morning|night|evening|weekday)|everyday|daily|nightly)${E}`, 'gi'),
    () => ({ every: 1, perDay: 1 })],
  [new RegExp(`${B}(?:biweekly|fortnightly)${E}`, 'gi'), () => ({ every: 14, perDay: 1 })],
  [new RegExp(`${B}(?:(?:every|each)\\s+(?:week|wk)|weekly)${E}`, 'gi'), () => ({ every: 7, perDay: 1 })],
  [new RegExp(`${B}(?:(?:every|each)\\s+month|monthly)${E}`, 'gi'), () => ({ every: 30, perDay: 1 })],
  [new RegExp(`${B}(?:every|each)\\s+(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day)?s?${E}`, 'gi'),
    () => ({ every: 7, perDay: 1 })],
  [new RegExp(`${B}(?:on\\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)${E}`, 'gi'),
    () => ({ every: 7, perDay: 1 })],
];

function perPeriod(n, unit) {
  const count = Math.max(1, Math.min(12, n ?? 1));
  if (/^d/i.test(unit)) return { every: 1, perDay: count };
  return { every: Math.max(1, Math.floor(7 / count)), perDay: 1 };
}

// Durations: "1h 30m", "1h30", "2 hrs", "1.5h", "45 min", "30m", "30-min"
const DUR =
  '\\d+(?:\\.\\d+)?\\s?(?:hours?|hrs?|h)\\s?\\d{1,2}\\s?(?:minutes?|mins?|m)' +
  '|\\d+(?:\\.\\d+)?h\\d{1,2}' +
  '|\\d+(?:\\.\\d+)?\\s?(?:hours?|hrs?)' +
  '|\\d+(?:\\.\\d+)?h' +
  '|\\d+\\s?(?:minutes?|mins?)' +
  '|\\d+m' +
  '|\\d+-min(?:ute)?s?' +
  '|\\d+-h(?:ou)?r';

const durMinutes = (s) => {
  const t = String(s).toLowerCase().replace(/-min/, ' min').replace(/-h(?:ou)?r/, ' hr').trim();
  const n = parseDuration(t);
  return n && n > 0 ? n : null;
};

const EST_RULES = [
  // "(2h)", "(~45m)", "(1:30)"
  [new RegExp(`\\(\\s*~?\\s*(${DUR}|\\d{1,2}:\\d{2})\\s*\\)`, 'gi'), (m) => durMinutes(m[1])],
  // "~30m", "~ 2 hrs", "~30"
  [new RegExp(`~\\s*(${DUR}|\\d+)${E}`, 'gi'), (m) => durMinutes(/^\d+$/.test(m[1]) ? `${m[1]}m` : m[1])],
  // "for half an hour", "for an hour"
  [new RegExp(`${B}for\\s+(half an hour|half hour|a half hour|an hour|one hour)${E}`, 'gi'),
    (m) => (/half/i.test(m[2]) ? 30 : 60)],
  // "for 45 min", "est 2h", "45min", "1.5h"
  [new RegExp(`${B}(?:(?:for|est:?|about|around|approx\\.?|takes)\\s*)?(${DUR})${E}`, 'gi'), (m) => durMinutes(m[2])],
];

// Times
// Full am/pm form; the one-letter "3p"/"9a" form is only accepted after "at"/"@" ("section 4a" is not a time).
const T_AMPM_FULL = '\\d{1,2}(?::\\d{2})?\\s?(?:a\\.m\\.|p\\.m\\.|am|pm)';
const T_AMPM = `${T_AMPM_FULL}|\\d{1,2}(?::\\d{2})?[ap]`;
const AMPM_END = '(?![a-z0-9])';

/** Bare hour/H:MM with no am/pm: 8–11 → morning, 12–7 → afternoon/evening, 13–23 as given. */
function guessTime(h, mm = 0) {
  if (!Number.isInteger(h) || h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  let H = h;
  if (h >= 1 && h <= 7) H = h + 12;
  return `${String(H).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseBareClock(s) {
  const m = String(s).match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || mm > 59) return null;
  if (h === 0 || h >= 13) return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return guessTime(h, mm);
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// ---------------------------------------------------------------- title cleanup

const VERB_LEADS = new Set(['email', 'e-mail', 'call', 'text', 'ping', 'ask', 'tell', 'remind', 'message', 'msg', 'thank', 'dm']);
const PHRASE_LEADS = [
  'meet with', 'meeting with', 'follow up with', 'follow-up with', 'followup with', 'reply to', 'respond to',
  'schedule with', '1:1 with', 'lunch with', 'coffee with', 'dinner with', 'drinks with', 'call with',
  'zoom with', 'chat with', 'sync with', 'check in with', 'check-in with', 'catch up with', 'talk to', 'talk with',
  'meet w/', '1:1 w/', 'call w/', 'zoom w/', 'lunch w/', 'coffee w/',
].map((p) => p.split(' '));
const LEAD_JOINERS = new Set(['and', 'then', '&', 'or', '+', 'also']);
const HONORIFICS = new Set(['dr', 'dr.', 'prof', 'prof.', 'professor', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'mx', 'mx.']);
const NAME_STOP = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'its', 'this', 'that', 'these', 'those',
  'me', 'us', 'them', 'him', 'it', 'you', 'everyone', 'everybody', 'someone', 'somebody', 'anyone', 'all', 'folks', 'people',
  'about', 'back', 're', 'regarding', 'to', 'for', 'on', 'in', 'at', 'with', 'up', 'out', 'and', 'or', 'if', 'again', 'w/',
  'comments', 'comment', 'reviewers', 'reviewer', 'reviews', 'review', 'email', 'emails', 'message', 'messages', 'texts',
  'thread', 'feedback', 'invite', 'invitation', 'request', 'requests', 'question', 'questions', 'survey', 'poll',
  'students', 'student', 'committee', 'lab', 'team', 'group', 'class', 'cohort', 'advisor', 'adviser', 'mentor',
  'mentee', 'mentees', 'undergrads', 'undergrad', 'ras', 'ra', 'landlord', 'doctor', 'dentist', 'insurance', 'bank',
  'pharmacy', 'vet', 'irb', 'department', 'dept', 'office', 'registrar', 'hr', 'admin', 'chair', 'editor',
  'journal', 'client', 'clients', 'supervisor', 'supervisors', 'parents', 'family', 'friends', 'coordinator',
  'recruiter', 'support', 'help', 'it', 'list', 'listserv', 'slack', 'zoom', 'later', 'now', 'soon', 'ahead',
  'you', 'thanks', 'after', 'before', 'when', 'how', 'what', 'why', 'whether', 'who', 'cvs', 'uber', 'about',
]);

function capWord(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Capitalize a lowercase name right after email/call/meet with/… ("email mike" → "email Mike"). */
function capitalizeNames(title) {
  const words = title.split(' ');
  const lower = words.map((w) => w.toLowerCase());
  const targets = new Set();
  for (let k = 0; k < words.length; k++) {
    const prev = k > 0 ? lower[k - 1] : null;
    const atClauseStart = k === 0 || LEAD_JOINERS.has(prev) || /[,;:]$/.test(prev ?? '');
    if (VERB_LEADS.has(lower[k]) && atClauseStart && k + 1 < words.length) targets.add(k + 1);
    for (const p of PHRASE_LEADS) {
      if (k + p.length >= words.length) continue;
      let ok = true;
      for (let j = 0; j < p.length; j++) if (lower[k + j] !== p[j]) { ok = false; break; }
      if (ok) targets.add(k + p.length);
    }
  }
  const out = words.slice();
  for (const t of [...targets].sort((a, b) => a - b)) {
    const m = out[t].match(/^([a-z][a-z'’-]*)(.*)$/);
    if (!m) continue;
    const bare = m[1].replace(/['’]s$/, '');
    if (HONORIFICS.has(m[1] + (m[2].startsWith('.') ? '.' : '')) || HONORIFICS.has(m[1])) {
      out[t] = capWord(m[1]) + m[2];
      if (t + 1 < out.length && /^[a-z]/.test(out[t + 1])) out[t + 1] = capWord(out[t + 1]);
      continue;
    }
    if (NAME_STOP.has(bare) || NAME_STOP.has(m[1])) continue;
    out[t] = capWord(m[1]) + m[2];
  }
  return out.join(' ');
}

const DANGLING_RE = /\s+(?:due\s+(?:by|on)|due|deadline|by|on|at|for|before|until|til|@)$/i;

function cleanTitle(s, { hadParts }) {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let guard = 0; guard < 10; guard++) {
    const before = t;
    t = t.replace(/[\s\-–—:;,.@~|/]+$/, '').replace(/^[\s\-–—:;,.@~|/!]+/, '');
    if (hadParts) t = t.replace(DANGLING_RE, '');
    if (hadParts && /^(?:due|by|on|at|for|@)$/i.test(t)) t = '';
    if (t === before) break;
  }
  if (!t) return '';
  const first = t.split(' ')[0];
  if (first === first.toLowerCase()) t = t.charAt(0).toUpperCase() + t.slice(1);
  return capitalizeNames(t);
}

// ---------------------------------------------------------------- kind

/** Task kind from its title (+ due/time). Exported for editTask-style re-inference. */
export function inferKind(title, { due = null, time = null } = {}) {
  const t = String(title ?? '').toLowerCase().trim();
  if (!t) return time ? 'meeting' : 'task';
  if (/^(?:re)?schedule\b|^book\b|^cancel\b|^confirm\b/.test(t)) return 'task';
  if (/^(?:meet|meeting|call|zoom|appointment|1:1|facetime)(?![a-z0-9])/.test(t)) return 'meeting';
  if (/^(?:e-?mail|reply|respond)\b/.test(t)) return 'email';
  if (/^(?:read|reread|re-read|skim)\b/.test(t)) return 'reading';
  if (/^(?:write|draft|edit|revise|rewrite|re-write|outline)\b/.test(t)) return 'writing';
  if (/^(?:run|rerun|re-run|analy[sz]e|analyses|analysis|glm)\b/.test(t)) return 'analysis';
  if (due && /^(?:submit|turn in|hand in|apply)\b/.test(t)) return 'deadline';
  if (/(?:^|[^a-z0-9])(?:dentist|doctor|appt|dr\.? appt)(?![a-z0-9])/.test(t)) return 'appt';
  if (/(?:^|[^a-z0-9])(?:meeting|1:1)(?![a-z0-9])/.test(t)) return 'meeting';
  if (/(?:^|[^a-z0-9])(?:draft|drafts|write-?up|writing)(?![a-z0-9])/.test(t)) return 'writing';
  if (/(?:^|[^a-z0-9])(?:glm|analysis|analyses|pre-?proc\w*|preprocess\w*|regressions?|t-tests?)(?![a-z0-9])/.test(t)) return 'analysis';
  if (due && /(?:^|[^a-z0-9])(?:exam|quiz|midterm|final exam|deadline|submit|submission)(?![a-z0-9])/.test(t)) return 'deadline';
  if (/^(?:buy|pick up|drop off|return|mail|ship|grab)\b/.test(t)) return 'errand';
  if (time && /(?:^|[^a-z0-9])(?:class|seminar|lecture|colloquium|talk|defen[cs]e|webinar|office hours|session|standup|stand-up|interview|workshop|training|orientation|rehearsal|game|concert|party|dinner|lunch)(?![a-z0-9])/.test(t)) return 'meeting';
  return 'task';
}

// ---------------------------------------------------------------- category inference

const aliasReCache = new Map();
function phraseRe(phrase) {
  let re = aliasReCache.get(phrase);
  if (!re) {
    const parts = phrase.trim().toLowerCase().split(/\s+/).map(escapeRe);
    const plural = phrase.length >= 3 && /[a-z]$/.test(phrase) ? 's?' : '';
    re = new RegExp(`(?:^|[^a-z0-9])(${parts.join('\\s+')}${plural})(?![a-z0-9])`, 'i');
    aliasReCache.set(phrase, re);
  }
  return re;
}

/** Terms that name a category in free text: aliases, id, and a plain-word name. */
function termsOf(c) {
  const out = new Set();
  if (Array.isArray(c.aliases)) for (const a of c.aliases) {
    const s = String(a ?? '').trim().toLowerCase();
    if (s.length >= 2) out.add(s);
  }
  if (c.id && c.id !== 'inbox' && c.id.length >= 2) out.add(c.id.toLowerCase());
  const name = typeof c.name === 'string' ? c.name.trim().toLowerCase() : '';
  if (name.length >= 3 && /^[a-z0-9 ]+$/.test(name)) out.add(name);
  return [...out];
}

const orderOf = (c) => (typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : 500);

function resolveCats(cats) {
  if (cats == null) return [...DEFAULT_CATEGORIES, INBOX_CATEGORY];
  return catList(cats);
}

/**
 * Guess a category for a task title.
 * Alias hit (word boundary, longest alias wins; ties → lower `order`) → 0.9;
 * KEYWORD_RULES → 0.6; else { id: "inbox", confidence: 0 }.
 * Archived categories are never inferred.
 */
export function inferCategory(title, cats) {
  const text = typeof title === 'string' ? title : title == null ? '' : String(title);
  const list = resolveCats(cats).filter((c) => c.id !== 'inbox' && !c.archived);
  if (!text.trim()) return { id: 'inbox', confidence: 0, reason: 'empty title' };

  let best = null;
  for (const c of list) {
    for (const term of termsOf(c)) {
      const m = phraseRe(term).exec(text);
      if (!m) continue;
      const len = term.length;
      if (!best || len > best.len || (len === best.len && orderOf(c) < orderOf(best.cat))) {
        best = { cat: c, len, term };
      }
    }
  }
  if (best) return { id: best.cat.id, confidence: 0.9, reason: `alias "${best.term}"` };

  const byId = new Map(list.map((c) => [c.id, c]));
  for (const rule of KEYWORD_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const word = (m[1] ?? m[2] ?? m[0]).trim().toLowerCase();
    if (rule.cat === null && rule.group) {
      // Coursework: a course named in the title (by full name), else ask which course.
      const course = list.find((c) => c.group === rule.group && typeof c.name === 'string' && c.name.trim().length >= 3 &&
        phraseRe(c.name.trim().toLowerCase()).test(text));
      if (course) return { id: course.id, confidence: 0.6, reason: `keyword "${word}" + course "${course.name}"` };
      return { id: 'inbox', confidence: 0, reason: 'which course?' };
    }
    if (byId.has(rule.cat)) return { id: rule.cat, confidence: 0.6, reason: `keyword "${word}" (${rule.reason})` };
  }
  return { id: 'inbox', confidence: 0, reason: 'no match' };
}

// ---------------------------------------------------------------- parseQuickAdd

const DUE_WORD_RE = /(?:^|[^a-z0-9])(?:due|deadline|exams?|quiz(?:zes)?|midterm|submit|submission|turn in|hand in)(?![a-z0-9])/i;
const PREP_START_RE = /^\s*(?:study|prep|prepare|review|practice|start|work on|outline|read)(?![a-z0-9])/i;

function emptyResult() {
  return {
    title: '', due: null, plan: null, time: null, est: null, prio: 1,
    cat: 'inbox', catConfidence: 0, catReason: 'empty', newCatName: null,
    kind: 'task', recurring: null, tokens: [],
  };
}

/**
 * Parse a quick-add line. `opts = { today, cats, settings }`; cats may be the
 * state.cats map or an array (defaults to DEFAULT_CATEGORIES + inbox when absent).
 * Never throws; empty input → title "".
 */
export function parseQuickAdd(text, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cats = resolveCats(o.cats);
  const today = isISODate(o.today) ? o.today : todayISO(o.settings?.tz);
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const input = raw.replace(/\s+/g, ' ').trim();
  if (!input) return emptyResult();

  const st = makeWork(input);
  let catId = null;
  let newCatName = null;
  let recurring = null;
  let est = null;
  let time = null;
  let prio = null;
  let due = null;
  let plan = null;
  let soft = null; // date from a separator / trailing phrase: plan, or due for deadline-y titles

  // 1. #tags
  scan(st, TAG_RE, (m, start) => {
    const tag = m[2].replace(/[.\-:/&+]+$/, '');
    const end = start + 1 + tag.length;
    const cat = resolveCategory(tag, cats);
    if (cat) {
      if (!catId) {
        catId = cat.id;
        addToken(st, 'cat', start, end, cat.id);
      }
    } else if (!newCatName) {
      newCatName = tag;
      addToken(st, 'newcat', start, end, tag);
    }
    mask(st, start, end);
    return false;
  });
  if (catId) {
    newCatName = null;
    st.tokens = st.tokens.filter((t) => t.type !== 'newcat');
  }

  // 2. recurrence
  for (const [re, fn] of RECUR_RULES) {
    scan(st, re, (m, start, end) => {
      const r = fn(m);
      if (!r) return false;
      if (!recurring) {
        recurring = r;
        addToken(st, 'recurring', start, end, { ...r });
        return true;
      }
      if (r.every === recurring.every) {
        recurring = { every: r.every, perDay: Math.max(r.perDay, recurring.perDay) };
        const tok = st.tokens.find((t) => t.type === 'recurring');
        if (tok) tok.value = { ...recurring };
        return true;
      }
      return false;
    });
  }

  // 3. estimate
  for (const [re, fn] of EST_RULES) {
    if (est !== null) break;
    scan(st, re, (m, start, end) => {
      if (est !== null) return false;
      const n = fn(m);
      if (!n) return false;
      est = n;
      addToken(st, 'est', start, end, n);
      return true;
    });
  }

  // 4. time
  const setTime = (val, start, end, extra) => {
    if (time !== null || !val) return false;
    time = val;
    addToken(st, 'time', start, end, val);
    if (extra) extra();
    return true;
  };
  // ranges: "3-4pm", "10am to 12pm", "15:00-16:30"
  scan(st, new RegExp(`${B}(?:(?:from|at)\\s+|@\\s*)?(\\d{1,2}(?::\\d{2})?)\\s?(am|pm)?\\s?(?:-|–|—|to|until|til)\\s?(\\d{1,2}(?::\\d{2})?)\\s?(am|pm)${AMPM_END}`, 'gi'), (m, start, end) => {
    const endT = parseTime(`${m[4]}${m[5]}`);
    let startT = parseTime(`${m[2]}${m[3] ?? m[5]}`);
    if (!endT || !startT) return false;
    if (!m[3] && toMin(startT) > toMin(endT)) startT = parseTime(`${m[2]}${m[5].toLowerCase() === 'pm' ? 'am' : 'pm'}`) ?? startT;
    return setTime(startT, start, end, () => {
      const d = toMin(endT) - toMin(startT);
      if (est === null && d > 0) {
        est = d;
        addToken(st, 'est', start, end, d);
      }
    });
  });
  scan(st, new RegExp(`${B}(?:from\\s+|at\\s+|@\\s*)?(\\d{1,2}:\\d{2})\\s?(?:-|–|—|to|until|til)\\s?(\\d{1,2}:\\d{2})(?![0-9:/a-z])`, 'gi'), (m, start, end) => {
    const s = parseBareClock(m[2]);
    const e = parseBareClock(m[3]);
    if (!s || !e) return false;
    return setTime(s, start, end, () => {
      const d = toMin(e) - toMin(s);
      if (est === null && d > 0) {
        est = d;
        addToken(st, 'est', start, end, d);
      }
    });
  });
  // "at 3pm", "@ 15:00", "at noon"
  scan(st, new RegExp(`${B}(?:at\\s+|@\\s*)(${T_AMPM}|\\d{1,2}:\\d{2}|noon|midnight)${AMPM_END}`, 'gi'), (m, start, end) => {
    const v = /^\d{1,2}:\d{2}$/.test(m[2]) ? parseBareClock(m[2]) : parseTime(m[2]);
    return setTime(v, start, end);
  });
  // bare "3pm", "3:30 pm"
  scan(st, new RegExp(`(^|[^a-z0-9:/.])(${T_AMPM_FULL})${AMPM_END}`, 'gi'), (m, start, end) => setTime(parseTime(m[2]), start, end));
  // bare "15:00", "1:30"
  scan(st, /(^|[^a-z0-9:/.])(\d{1,2}:\d{2})(?![0-9:/a-z])/gi, (m, start, end) => setTime(parseBareClock(m[2]), start, end));
  // "noon", "midnight"
  scan(st, new RegExp(`${B}(noon|midnight)${E}`, 'gi'), (m, start, end) => setTime(parseTime(m[2]), start, end));
  // "at 3" (bare hour) only when nothing word-like follows except a date phrase / separator
  scan(st, new RegExp(`${B}(?:at|@)\\s*(\\d{1,2})(?![0-9:/a-z])`, 'gi'), (m, start, end) => {
    if (time !== null) return false;
    const rest = st.w.slice(end);
    const ok = /^\s*$/.test(rest) || /^\s*[,;.!)\-–—]/.test(rest) || leadingDate(rest, today) !== null;
    if (!ok) return false;
    return setTime(parseBareClock(m[2]), start, end);
  });

  // 5. priority
  const bumpPrio = (p) => {
    prio = prio === null ? p : Math.max(prio, p);
  };
  scan(st, /(^|\s)(!{1,3})(?=\s|$)/g, (m, start, end) => {
    const p = m[2].length >= 2 ? 3 : 2;
    bumpPrio(p);
    addToken(st, 'prio', start, end, p);
    return true;
  });
  scan(st, /(^|\s)(!{1,3})(?=[a-z0-9])/gi, (m, start) => {
    const end = start + m[2].length;
    const p = m[2].length >= 2 ? 3 : 2;
    bumpPrio(p);
    addToken(st, 'prio', start, end, p);
    mask(st, start, end);
    return false;
  });
  scan(st, /([a-z0-9)\]])(!{1,3})(?=\s|$)/gi, (m) => {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    if (st.w.slice(start, end) !== m[2]) return false;
    const p = m[2].length >= 2 ? 3 : 2;
    bumpPrio(p);
    addToken(st, 'prio', start, end, p);
    mask(st, start, end);
    return false;
  });
  scan(st, new RegExp(`${B}(urgent|urgently|asap|a\\.s\\.a\\.p\\.?)${E}`, 'gi'), (m, start, end) => {
    bumpPrio(3);
    addToken(st, 'prio', start, end, 3);
    return true;
  });
  scan(st, new RegExp(`${B}(high\\s+prio(?:rity)?|hi\\s+prio|prio(?:rity)?\\s+high)${E}`, 'gi'), (m, start, end) => {
    bumpPrio(2);
    addToken(st, 'prio', start, end, 2);
    return true;
  });
  scan(st, new RegExp(`${B}(low\\s+prio(?:rity)?|prio(?:rity)?\\s+low|\\(low\\)|someday|some\\s+day|eventually)${E}`, 'gi'), (m, start, end) => {
    if (prio === null) prio = 0;
    addToken(st, 'prio', start, end, 0);
    return true;
  });

  // 6. explicit due: "by fri", "due 10/16", "deadline: oct 20", "due by the 15th"
  scan(st, new RegExp(`${B}(due\\s+(?:by|on)|due:?|deadline:?|by)\\s+`, 'gi'), (m, start, end) => {
    if (due !== null) return false;
    const rest = st.w.slice(end);
    const hit = leadingDate(rest, today);
    if (!hit) return false;
    const after = rest.slice(hit.len);
    const atEnd = /^\s*(?:$|[,;.!)\-–—|])/.test(after);
    if (isWeak(hit.core) && !atEnd) return false;
    if (capitalizedName(st, end + rest.match(/^\s*/)[0].length, hit.core)) return false;
    due = hit.date;
    addToken(st, 'due', start, end + hit.len, hit.date);
    mask(st, start, end + hit.len);
    return false;
  });

  // 7. "@sat", "@ tomorrow" → plan
  scan(st, /(^|\s)@\s*/g, (m, start, end) => {
    if (plan !== null) return false;
    const rest = st.w.slice(end);
    const hit = leadingDate(rest, today);
    if (!hit) return false;
    plan = hit.date;
    addToken(st, 'plan', start, end + hit.len, hit.date);
    mask(st, start, end + hit.len);
    return false;
  });

  // 8. trailing " - <date>" (also — and –): only the segment after the LAST separator
  {
    const SEP = /(^|\s+)(?:--?|–|—)(?=\s|$)\s*|\s*[–—]\s*/g;
    let last = null;
    let m;
    while ((m = SEP.exec(st.w))) {
      if (m[0].length === 0) {
        SEP.lastIndex++;
        continue;
      }
      last = { start: m.index, end: m.index + m[0].length };
    }
    if (last) {
      let seg = st.w.slice(last.end);
      let segStart = last.end;
      const pre = seg.match(/^\s*(?:on|for|@)\s+/i);
      if (pre) {
        seg = seg.slice(pre[0].length);
        segStart += pre[0].length;
      }
      const cleaned = seg.replace(/[\s,;.!]+$/, '');
      const hit = wholeDate(cleaned, today);
      if (hit && !capitalizedName(st, segStart + seg.match(/^\s*/)[0].length, hit.core)) {
        soft = { date: hit.date, how: 'sep' };
        addToken(st, 'plan', segStart, segStart + cleaned.length, hit.date, hit.text);
        mask(st, last.start, st.w.length);
      }
    }
  }

  // 9. bare trailing date: "call mom sat", "email mike friday", "laundry this weekend"
  if (soft === null && plan === null) {
    const w = st.w;
    let end = w.length;
    while (end > 0 && /[\s,;.!]/.test(w[end - 1])) end--;
    // Date phrases are short ("the day after tomorrow morning" is the longest), so only the tail is scanned.
    for (let i = Math.max(0, end - 48); i < end; i++) {
      if (!/[a-z0-9]/i.test(w[i])) continue;
      if (i > 0 && !/\s/.test(w[i - 1])) continue;
      const hit = wholeDate(w.slice(i, end), today);
      if (!hit) continue;
      const before = w.slice(0, i).replace(/\s+$/, '');
      const pm = before.match(/(\S+)$/);
      const prev = pm ? pm[1].toLowerCase().replace(/[,;:]+$/, '') : '';
      if (DETERMINERS.has(prev)) break;
      if (isWeak(hit.core) && WEAK_BLOCKERS.has(prev)) break;
      if (capitalizedName(st, i, hit.core)) break;
      let start = i;
      if (prev === 'on' || prev === 'for') start = before.length - pm[1].length;
      soft = { date: hit.date, how: 'trailing' };
      addToken(st, 'plan', start, end, hit.date, w.slice(start, end));
      mask(st, start, w.length);
      break;
    }
  }

  // 9a. leading date: "tomorrow: email mike", "10/16 - submit form", "fri, laundry".
  // Needs ":" / "," / a dash after it, or an unambiguous phrase (today, tomorrow, 10/16, oct 20).
  if (soft === null && plan === null) {
    const w = st.w;
    const startIdx = w.search(/\S/);
    const rest = startIdx >= 0 ? w.slice(startIdx) : '';
    const hit = rest ? leadingDate(rest, today) : null;
    if (hit) {
      const after = rest.slice(hit.len);
      const sepM = after.match(/^\s*(?::|,|--?(?=\s)|[–—])\s*/);
      const unambiguous = LEADING_DATE_RE.test(hit.core) && /^\s/.test(after);
      const hasTitle = /[a-z0-9]/i.test(after);
      if (hasTitle && (sepM || unambiguous) && !capitalizedName(st, startIdx, hit.core)) {
        const end = startIdx + hit.len + (sepM ? sepM[0].length : 0);
        soft = { date: hit.date, how: 'leading' };
        addToken(st, 'plan', startIdx, startIdx + hit.len, hit.date);
        mask(st, startIdx, end);
      }
    }
  }

  // 9b. a trailing standalone "low" means low priority
  {
    const lm = st.w.match(/(^|\s)(low)\s*$/i);
    if (lm) {
      const start = lm.index + lm[1].length;
      if (prio === null) prio = 0;
      addToken(st, 'prio', start, start + 3, 0);
      mask(st, start, start + 3);
    }
  }

  // 10. soft date → plan, or due when the title reads like a deadline
  const remaining = st.w.replace(/\s+/g, ' ').trim();
  if (soft) {
    const deadlineish = DUE_WORD_RE.test(remaining) && !PREP_START_RE.test(remaining);
    let target = null;
    if (deadlineish && due === null) target = 'due';
    else if (plan === null) target = 'plan';
    if (target === 'due') due = soft.date;
    else if (target === 'plan') plan = soft.date;
    const tok = [...st.tokens].reverse().find((t) => t.type === 'plan' && t.value === soft.date);
    if (tok && target === 'due') tok.type = 'due';
    if (!target && tok) st.tokens.splice(st.tokens.indexOf(tok), 1);
  }

  const hadParts = st.tokens.some((t) => ['due', 'plan', 'time', 'est', 'recurring'].includes(t.type));
  const title = cleanTitle(st.w, { hadParts });

  let cat = 'inbox';
  let catConfidence = 0;
  let catReason = 'no match';
  if (catId) {
    cat = catId;
    catConfidence = 1;
    catReason = 'tagged';
  } else if (newCatName) {
    catReason = `new category "${newCatName}"`;
  } else {
    const inf = inferCategory(title, cats);
    cat = inf.id;
    catConfidence = inf.confidence;
    catReason = inf.reason;
  }

  const tokens = st.tokens
    .sort((a, b) => a._at - b._at)
    .map(({ type, text: t, value }) => ({ type, text: t, value }));

  return {
    title,
    due,
    plan,
    time,
    est,
    prio: prio === null ? 1 : prio,
    cat,
    catConfidence,
    catReason,
    newCatName,
    kind: inferKind(title, { due, time }),
    recurring,
    tokens,
  };
}
