// Quick-add parsing ("email mike - tomorrow") and category inference.
// Pure: no DOM, no Node APIs. See docs/ARCHITECTURE.md ("parse.js").
//
// How parseQuickAdd works: the input is whitespace-collapsed, then structured
// pieces are found and blanked out (replaced by spaces, so indices stay put)
// in a fixed order: #tags, recurrence, estimate, time (with a connector right
// before it: "by 5pm", "around 3pm"), priority (incl. a trailing "low"), due
// phrases ("by fri", "due 10/16"), "@date", a trailing " - <date>" segment, a
// bare trailing date ("call mom sat"), a leading date ("tomorrow: email mike")
// and a trailing "low" again. Then: a weak cadence word ("weekly") next to a
// one-off date goes back into the title; the leftover date becomes plan or due;
// a bare evening clock gets pm; a time with no day lands on today. Whatever is
// left, tidied, is the title.

import { addDays, localDateOf, localTimeOf, parseDatePhrase, parseDuration, parseTime, isISODate, todayISO } from './dates.js';
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
const QUALIFIER_RE = /\s+(?:in the\s+)?(morning|afternoon|evening|night|am|pm|eod|end of (?:the )?day|first thing)$/i;

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
  const q = rest.slice(len).match(/^\s+(?:in the\s+)?(?:morning|afternoon|evening|night|eod|end of (?:the )?day)(?![a-z0-9])/i);
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

// Recurrence phrases. Strong forms ("every week", "2x a day") always make a
// chore. Weak forms are bare adjectives ("weekly", "daily", "mondays") that
// also read as part of a one-off title ("submit weekly report by fri"): they
// make a chore only when no one-off date was given (see parseQuickAdd step 10a).
// Strong rules run first so a weak word never blocks a strong phrase.
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
  [new RegExp(`${B}(?:every|each)\\s+(?:day|morning|night|evening|weekday)${E}`, 'gi'), () => ({ every: 1, perDay: 1 })],
  [new RegExp(`${B}(?:every|each)\\s+(?:week|wk)${E}`, 'gi'), () => ({ every: 7, perDay: 1 })],
  [new RegExp(`${B}(?:every|each)\\s+month${E}`, 'gi'), () => ({ every: 30, perDay: 1 })],
  [new RegExp(`${B}(?:every|each)\\s+(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day)?s?${E}`, 'gi'),
    () => ({ every: 7, perDay: 1 })],
  // weak: bare adjectives
  [new RegExp(`${B}(?:everyday|daily|nightly)${E}`, 'gi'), () => ({ every: 1, perDay: 1 }), 'weak'],
  [new RegExp(`${B}(?:biweekly|fortnightly)${E}`, 'gi'), () => ({ every: 14, perDay: 1 }), 'weak'],
  [new RegExp(`${B}weekly${E}`, 'gi'), () => ({ every: 7, perDay: 1 }), 'weak'],
  [new RegExp(`${B}monthly${E}`, 'gi'), () => ({ every: 30, perDay: 1 }), 'weak'],
  [new RegExp(`${B}(?:on\\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)${E}`, 'gi'),
    () => ({ every: 7, perDay: 1 }), 'weak'],
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
  // "11:59" is the end-of-day deadline time; nobody means one minute before noon.
  if (h === 11 && mm === 59) return '23:59';
  return guessTime(h, mm);
}

// "tonight at 9:30", "evening call at 8": a bare morning-range hour means pm.
const EVENING_RE = /(?:^|[^a-z0-9])(?:tonight|evening|night)(?![a-z0-9])/i;

/** A bare-clock time (no am/pm) moved to the evening: 8–11 → 20–23. Other hours were already guessed pm or given as 24h. */
function eveningTime(hhmm) {
  const [h, mm] = hhmm.split(':').map(Number);
  if (h < 8 || h > 11) return hhmm;
  return `${h + 12}:${String(mm).padStart(2, '0')}`;
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
      // "dr smith" → "Dr Smith", but "prof about exam" / "dr re: labs" keep the stop word lowercase.
      const next = t + 1 < out.length ? out[t + 1] : '';
      const nextBare = next.toLowerCase().replace(/[:,;.!?]+$/, '').replace(/['’]s$/, '');
      if (/^[a-z]/.test(next) && !NAME_STOP.has(nextBare)) out[t + 1] = capWord(next);
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

const KIND_DEADLINE_RE = /(?:^|[^a-z0-9])(?:exam|quiz|midterm|final exam|deadline|submit|submission)(?![a-z0-9])/i;
// Titles that only talk about, grade or set up an exam/quiz/deadline ("email prof about exam",
// "grade quizzes", "schedule exam"): the date is when Danny does that, not a deadline.
const ABOUT_START_RE =
  /^\s*(?:e-?mail|ask|tell|call|text|ping|message|msg|dm|remind|reply|respond|thank|follow[- ]?up|talk|discuss|meet|grade|proctor|schedule|reschedule|book)(?![a-z0-9])/i;
// "… about the exam", "… re: quiz 3", "… regarding the deadline": everything from the preposition on is the topic.
const ABOUT_CLAUSE_RE = /(?:^|[^a-z0-9])(?:about|regarding|re)(?=:|\s).*$/i;

/** The title names a deliverable (matches `re`) as its own subject, not as the topic of a message/grading/scheduling task. */
function namesDeliverable(title, re) {
  const t = String(title ?? '');
  if (ABOUT_START_RE.test(t)) return false;
  return re.test(t.replace(ABOUT_CLAUSE_RE, ''));
}

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
  if (due && namesDeliverable(t, KIND_DEADLINE_RE)) return 'deadline';
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

// Alias-hit specificity (see inferCategory).
const isAcronymCase = (s) => (s.match(/[A-Za-z]/g) ?? []).length >= 2 && !/[a-z]/.test(s);

/** End index of a short "Label:" prefix ("OCD pres: write main script"), or -1. */
function labelEnd(text) {
  const m = text.match(/^\s*([^:]{1,40}?):\s+\S/);
  if (!m || m[1].trim().split(/\s+/).length > 4) return -1;
  return m[0].indexOf(':');
}

/** An action verb opening a clause ("email jason", "text ronan and email chloe", "remind me to email …"): it says what to do, not what it is about. */
function isLeadVerb(text, at, typed) {
  if (!/^\s+\S/.test(text.slice(at + typed.length))) return false;
  const before = text.slice(0, at).trimEnd();
  const prev = before.split(/\s+/).pop().toLowerCase();
  return before === '' || LEAD_JOINERS.has(prev) || prev === 'to' || /[,;:]$/.test(prev);
}

/**
 * Guess a category for a task title.
 * Alias hits (word boundary) are ranked by specificity first: +1 when typed as
 * an acronym ("OCD", "DTI"), +1 when inside a short "Label:" prefix ("OCD pres:
 * …"), −1 when the alias is just a clause's action verb ("email jason"); then
 * by alias length; then lower `order`. The winner gets 0.9 when it is the only
 * category hit or more specific than the runner-up; a close call between two
 * categories ("fix app form") gets 0.45 and a reason naming both, so the CLI
 * asks Danny. KEYWORD_RULES → 0.6; else { id: "inbox", confidence: 0 }.
 * Archived categories are never inferred.
 */
export function inferCategory(title, cats) {
  const text = typeof title === 'string' ? title : title == null ? '' : String(title);
  const list = resolveCats(cats).filter((c) => c.id !== 'inbox' && !c.archived);
  if (!text.trim()) return { id: 'inbox', confidence: 0, reason: 'empty title' };

  const label = labelEnd(text);
  const perCat = new Map(); // cat id → its most specific hit
  for (const c of list) {
    for (const term of termsOf(c)) {
      const m = phraseRe(term).exec(text);
      if (!m) continue;
      const typed = m[1];
      const at = m.index + m[0].length - typed.length;
      const verb = VERB_LEADS.has(typed.toLowerCase());
      const spec = verb && isLeadVerb(text, at, typed) ? -1 : (isAcronymCase(typed) ? 1 : 0) + (!verb && label >= 0 && at < label ? 1 : 0);
      const hit = { cat: c, term, spec, len: term.length };
      const prev = perCat.get(c.id);
      if (!prev || spec > prev.spec || (spec === prev.spec && hit.len > prev.len)) perCat.set(c.id, hit);
    }
  }
  if (perCat.size) {
    const ranked = [...perCat.values()].sort((a, b) => b.spec - a.spec || b.len - a.len || orderOf(a.cat) - orderOf(b.cat));
    const [best, runner] = ranked;
    const reason = `alias "${best.term}"`;
    if (!runner || best.spec > runner.spec) return { id: best.cat.id, confidence: 0.9, reason };
    return { id: best.cat.id, confidence: 0.45, reason: `${reason}; also matches ${runner.cat.name ?? runner.cat.id} ("${runner.term}")` };
  }

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
// Connector word(s) directly before a time ("by 5pm", "due by noon", "around 3pm"); group 2 is the connector.
const TIME_CONNECTOR_RE =
  /(^|\s)((?:due\s+)?(?:by|before|until|till|til)|no later than|due(?:\s+at)?|after|around|approx\.?|~)\s*$/i;
// "stop by", "swing by": the "by" belongs to the verb, not to the time after it.
const PHRASAL_BY_RE = /(?:^|\s)(?:stop|stopping|drop|dropping|swing|swinging|come|coming|pop|popping|pass|go|going)\s*$/i;
// "eod" / "end of day" with nothing else: a time of day, which a separate date ("fri by eod") overrides.
const EOD_ONLY_RE = /^(?:eod|end of (?:the )?day)$/i;
const TRAILING_LOW_RE = /(^|\s)(low)\s*$/i;

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
/** Local "HH:MM" of `now` when it falls on `today` (in tz), else "" (sorts before every time). */
function nowTimeOn(now, today, tz) {
  if (typeof now !== 'string' || !now) return '';
  try {
    if (localDateOf(now, tz || undefined) !== today) return '';
    return localTimeOf(now, tz || undefined) ?? '';
  } catch {
    return '';
  }
}

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

  // 2. recurrence. Weak spans ("weekly" in "submit weekly report by fri") are
  // remembered so step 10a can put them back when a one-off date shows up.
  let recurStrong = false;
  const weakSpans = [];
  for (const [re, fn, strength] of RECUR_RULES) {
    const weak = strength === 'weak';
    scan(st, re, (m, start, end) => {
      const r = fn(m);
      if (!r) return false;
      if (recurring && r.every !== recurring.every) return false;
      if (!recurring) {
        recurring = r;
        addToken(st, 'recurring', start, end, { ...r });
      } else {
        recurring = { every: r.every, perDay: Math.max(r.perDay, recurring.perDay) };
        const tok = st.tokens.find((t) => t.type === 'recurring');
        if (tok) tok.value = { ...recurring };
      }
      if (weak) weakSpans.push([start, end]);
      else recurStrong = true;
      return true;
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
  let timeBare = null; // the typed clock when it had no am/pm ("9:30", "at 8"), for the evening fix-up
  const setTime = (val, start, end, extra, bare = null) => {
    if (time !== null || !val) return false;
    time = val;
    timeBare = bare;
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
    }, m[2]);
  });
  // "at 3pm", "@ 15:00", "at noon"
  scan(st, new RegExp(`${B}(?:at\\s+|@\\s*)(${T_AMPM}|\\d{1,2}:\\d{2}|noon|midnight)${AMPM_END}`, 'gi'), (m, start, end) => {
    const bare = /^\d{1,2}:\d{2}$/.test(m[2]);
    return setTime(bare ? parseBareClock(m[2]) : parseTime(m[2]), start, end, null, bare ? m[2] : null);
  });
  // bare "3pm", "3:30 pm"
  scan(st, new RegExp(`(^|[^a-z0-9:/.])(${T_AMPM_FULL})${AMPM_END}`, 'gi'), (m, start, end) => setTime(parseTime(m[2]), start, end));
  // bare "15:00", "1:30"
  scan(st, /(^|[^a-z0-9:/.])(\d{1,2}:\d{2})(?![0-9:/a-z])/gi, (m, start, end) => setTime(parseBareClock(m[2]), start, end, null, m[2]));
  // "noon", "midnight"
  scan(st, new RegExp(`${B}(noon|midnight)${E}`, 'gi'), (m, start, end) => setTime(parseTime(m[2]), start, end));
  // "at 3" (bare hour) only when nothing word-like follows except a date phrase / separator
  scan(st, new RegExp(`${B}(?:at|@)\\s*(\\d{1,2})(?![0-9:/a-z])`, 'gi'), (m, start, end) => {
    if (time !== null) return false;
    const rest = st.w.slice(end);
    const ok = /^\s*$/.test(rest) || /^\s*[,;.!)\-–—]/.test(rest) || leadingDate(rest, today) !== null;
    if (!ok) return false;
    return setTime(parseBareClock(m[2]), start, end, null, m[2]);
  });

  // 4b. a connector right before the time belongs to it: "tomorrow by 5pm",
  // "fri around 3pm". Left behind, it would hide the date in front of it from
  // the date passes below. "by"/"before"/"due" make that date a deadline.
  let byTime = false;
  {
    const tok = st.tokens.find((t) => t.type === 'time');
    const cm = tok ? st.w.slice(0, tok._at).match(TIME_CONNECTOR_RE) : null;
    // "hw due at 5pm" yes; "stop by at 3pm", "swing by 5pm" no: there the word belongs to the verb.
    const viaAt = cm && /^(?:at|@)/i.test(tok.text);
    const phrasal = cm && /^by$/i.test(cm[2]) && PHRASAL_BY_RE.test(st.w.slice(0, cm.index + cm[1].length));
    if (cm && !phrasal && (!viaAt || /^due$/i.test(cm[2]))) {
      const start = cm.index + cm[1].length;
      byTime = /^(?:due|by|before|no later than)(?![a-z])/i.test(cm[2]);
      mask(st, start, start + cm[2].length);
    }
  }

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
  // A trailing standalone "low" means low priority. Taken before the date passes
  // so "laundry - sat low" still finds "sat", and again after them for "laundry low - sat".
  let lowTaken = false;
  const takeTrailingLow = () => {
    const lm = lowTaken ? null : st.w.match(TRAILING_LOW_RE);
    if (!lm) return;
    const start = lm.index + lm[1].length;
    lowTaken = true;
    if (prio === null) prio = 0;
    addToken(st, 'prio', start, start + 3, 0);
    mask(st, start, start + 3);
  };
  takeTrailingLow();

  // 6. explicit due: "by fri", "due 10/16", "deadline: oct 20", "due by the 15th"
  let eodTok = null; // "by eod" alone: today, unless another date says which day ("fri by eod")
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
    if (EOD_ONLY_RE.test(hit.core.trim())) eodTok = st.tokens[st.tokens.length - 1];
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
      // "prep for thursday", "plan for next week": the date is the object; taking
      // it would leave a one-word title ("Prep") and a wrong do-day.
      if (prev === 'for' && before.slice(0, before.length - pm[1].length).split(/\s+/).filter(Boolean).length === 1) break;
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

  // 9b. "low" left at the end once the date is gone ("laundry low - sat")
  takeTrailingLow();

  // 10a. a weak cadence word next to a one-off date is part of the title
  // ("submit weekly report by fri", "daily standup notes - tomorrow"): put it
  // back and make a dated task, not a chore that would drop the date.
  if (recurring && !recurStrong && (due !== null || plan !== null || soft !== null)) {
    for (const [s, e] of weakSpans) st.w = st.w.slice(0, s) + st.orig.slice(s, e) + st.w.slice(e);
    recurring = null;
    st.tokens = st.tokens.filter((t) => t.type !== 'recurring');
  }

  // 10. soft date → plan, or due when the title reads like a deadline, the time
  // came with "by" ("tomorrow by 5pm"), or "by eod" only gave the time of day ("fri by eod")
  const remaining = st.w.replace(/\s+/g, ' ').trim();
  if (soft) {
    if (eodTok) due = null;
    const deadlineish = eodTok !== null || byTime || (namesDeliverable(remaining, DUE_WORD_RE) && !PREP_START_RE.test(remaining));
    let target = null;
    if (deadlineish && due === null) target = 'due';
    else if (plan === null) target = 'plan';
    if (target === 'due') due = soft.date;
    else if (target === 'plan') plan = soft.date;
    const tok = [...st.tokens].reverse().find((t) => t.type === 'plan' && t.value === soft.date);
    if (tok && target === 'due') tok.type = 'due';
    if (!target && tok) st.tokens.splice(st.tokens.indexOf(tok), 1);
    if (eodTok) eodTok.value = due;
  }

  // 10b. a bare clock with "tonight"/"evening"/"night" is pm ("due tonight at 9:30")
  if (time !== null && timeBare !== null && !/^0/.test(timeBare) && EVENING_RE.test(st.orig)) {
    const t2 = eveningTime(time);
    if (t2 !== time) {
      time = t2;
      const tt = st.tokens.find((t) => t.type === 'time');
      if (tt) tt.value = t2;
    }
  }

  // 10c. a time with no day is today ("lab meeting 2pm"), not the backlog; "by 5pm" → due today.
  // With `now` given, a time already past today means tomorrow (typed at 9pm: "lab meeting 2pm").
  if (time !== null && due === null && plan === null && !recurring) {
    const at = st.tokens.find((t) => t.type === 'time')?._at ?? 0;
    const day = time < nowTimeOn(o.now, today, o.settings?.tz) ? addDays(today, 1) : today;
    if (byTime) due = day;
    else plan = day;
    st.tokens.push({ type: byTime ? 'due' : 'plan', text: '', value: day, _at: at });
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
    // addTask files an unfiled chore under Home (ops.defaultChoreCat); say so up front so the preview matches.
    if (recurring && cat === 'inbox' && cats.some((c) => c.id === 'home')) {
      cat = 'home';
      catConfidence = 0.3;
      catReason = 'chores default to Home';
    }
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
