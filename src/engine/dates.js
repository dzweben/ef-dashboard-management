// Calendar-date math on "YYYY-MM-DD" strings, timezone-aware "today", and
// natural-language date/time/duration parsing. Pure except todayISO()/nowISO().

const DAY_MS = 86400000;
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------- clock

/** Current local calendar date in `tz` as "YYYY-MM-DD". */
export function todayISO(tz = 'America/New_York') {
  return localDateOf(new Date().toISOString(), tz);
}

export function nowISO() {
  return new Date().toISOString();
}

/** Local calendar date of an ISO timestamp in `tz`. */
export function localDateOf(isoTimestamp, tz = 'America/New_York') {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const parts = partsIn(d, tz);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Local wall-clock time "HH:MM" of an ISO timestamp in `tz`. */
export function localTimeOf(isoTimestamp, tz = 'America/New_York') {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const parts = partsIn(d, tz);
  return `${parts.hour}:${parts.minute}`;
}

const fmtCache = new Map();
function partsIn(date, tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    }
    fmtCache.set(tz, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

// ---------------------------------------------------------------- calendar math

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${d}`;
}

export function makeISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(iso, n) {
  return fromUTC(toUTC(iso) + Math.round(n) * DAY_MS);
}

/** Whole days from a to b (b − a). */
export function diffDays(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dow(iso) {
  return new Date(toUTC(iso)).getUTCDay();
}

export function dowKey(iso) {
  return WEEKDAY_KEYS[dow(iso)];
}

export function isWeekend(iso) {
  const d = dow(iso);
  return d === 0 || d === 6;
}

export function startOfWeek(iso, weekStart = 'mon') {
  const startIdx = weekStart === 'sun' ? 0 : 1;
  const back = (dow(iso) - startIdx + 7) % 7;
  return addDays(iso, -back);
}

export function rangeDays(startIso, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDays(startIso, i));
  return out;
}

export function minDate(...ds) {
  const xs = ds.filter(Boolean);
  return xs.length ? xs.reduce((a, b) => (a < b ? a : b)) : null;
}

export function maxDate(...ds) {
  const xs = ds.filter(Boolean);
  return xs.length ? xs.reduce((a, b) => (a > b ? a : b)) : null;
}

// ---------------------------------------------------------------- formatting

/** "Mon 10/5" */
export function fmtDay(iso) {
  if (!isISODate(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAY_SHORT[dow(iso)]} ${m}/${d}`;
}

/** "Oct 5" */
export function fmtMonthDay(iso) {
  if (!isISODate(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

/** "Mon" */
export function fmtWeekday(iso) {
  return isISODate(iso) ? WEEKDAY_SHORT[dow(iso)] : '';
}

/** "today" | "tomorrow" | "yesterday" | "Fri" (within the next 6 days) | "in 9d" | "3d ago" */
export function fmtRelative(iso, today) {
  if (!isISODate(iso) || !isISODate(today)) return '';
  const n = diffDays(today, iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n <= 6) return WEEKDAY_SHORT[dow(iso)];
  if (n > 6) return `in ${n}d`;
  return `${-n}d ago`;
}

/** "15:30" → "3:30pm", "09:00" → "9am" */
export function fmtTime(hhmm) {
  if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) return '';
  const [H, M] = hhmm.split(':').map(Number);
  const suffix = H >= 12 ? 'pm' : 'am';
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return M === 0 ? `${h12}${suffix}` : `${h12}:${String(M).padStart(2, '0')}${suffix}`;
}

/** 45 → "45m", 60 → "1h", 90 → "1h 30m", 0/null → "0m" */
export function fmtMinutes(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Elapsed ms → "MM:SS" or "H:MM:SS" */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------- parsing: durations + times

/**
 * Minutes from "30m", "30 min", "1.5h", "2 hrs", "90 minutes", "1h30", "1h 30m", "1:30" (h:mm), "2h45".
 * Returns null when nothing parses.
 */
export function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes)?)?$/);
  if (m) return Math.round(parseFloat(m[1]) * 60 + (m[2] ? parseInt(m[2], 10) : 0));
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)$/);
  if (m) return Math.round(parseFloat(m[1]));
  m = t.match(/^(\d+):(\d{2})$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = t.match(/^(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** "3pm" "3:30 pm" "15:00" "noon" "midnight" "9a" → "HH:MM" | null */
export function parseTime(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase().replace(/\./g, '');
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)$/);
  if (m) {
    let H = parseInt(m[1], 10);
    const M = m[2] ? parseInt(m[2], 10) : 0;
    if (H < 1 || H > 12 || M > 59) return null;
    const pm = m[3].startsWith('p');
    if (H === 12) H = pm ? 12 : 0;
    else if (pm) H += 12;
    return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const H = parseInt(m[1], 10);
    const M = parseInt(m[2], 10);
    if (H > 23 || M > 59) return null;
    return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------- parsing: dates

const WD_ALIASES = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WD_RE = Object.keys(WD_ALIASES).sort((a, b) => b.length - a.length).join('|');
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };

/** Next date (strictly after `today` unless allowToday) whose weekday is `wd`. */
function nextWeekday(today, wd, allowToday = false) {
  let delta = (wd - dow(today) + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDays(today, delta);
}

/**
 * Month/day without a year: this year's date, unless it is more than 60 days in
 * the past (then the next occurrence). "10/1" typed on Oct 5 means Oct 1 (overdue),
 * "1/15" typed in October means next January.
 */
function nextMonthDay(today, month, day) {
  const [ty] = today.split('-').map(Number);
  for (const y of [ty - 1, ty, ty + 1, ty + 2]) {
    if (day > daysInMonth(y, month)) continue;
    const iso = makeISO(y, month, day);
    if (diffDays(today, iso) >= -60) return iso;
  }
  return null;
}

function fullYear(y) {
  const n = parseInt(y, 10);
  return y.length <= 2 ? 2000 + n : n;
}

// Each rule: [regex anchored at start (applied to the lowercased text at a word boundary), resolver(match, today) → iso|null]
const DATE_RULES = [
  [/^(?:today|tod|tonight|this evening|this afternoon|this morning|eod|end of (?:the )?day)\b/, (m, t) => t],
  [/^(?:tomorrow|tmrw|tmr|tmw|tom|2morrow)\b/, (m, t) => addDays(t, 1)],
  [/^(?:the )?day after tomorrow\b/, (m, t) => addDays(t, 2)],
  [/^yesterday\b/, (m, t) => addDays(t, -1)],
  [/^(?:eow|end of (?:the )?week)\b/, (m, t) => {
    const d = dow(t);
    return d === 5 || d === 6 || d === 0 ? nextWeekday(t, 5) : nextWeekday(t, 5, true);
  }],
  [/^(?:eom|end of (?:the )?month)\b/, (m, t) => {
    const [y, mo] = t.split('-').map(Number);
    return makeISO(y, mo, daysInMonth(y, mo));
  }],
  [/^(?:this )?weekend\b/, (m, t) => (dow(t) === 6 ? t : dow(t) === 0 ? t : nextWeekday(t, 6))],
  [/^next weekend\b/, (m, t) => addDays(startOfWeek(t, 'mon'), 12)],
  [/^next week\b/, (m, t) => addDays(startOfWeek(t, 'mon'), 7)],
  [/^next month\b/, (m, t) => {
    const [y, mo] = t.split('-').map(Number);
    return mo === 12 ? makeISO(y + 1, 1, 1) : makeISO(y, mo + 1, 1);
  }],
  [new RegExp(`^next (${WD_RE})\\b`), (m, t) => addDays(startOfWeek(t, 'mon'), 7 + ((WD_ALIASES[m[1]] + 6) % 7))],
  [new RegExp(`^this (${WD_RE})\\b`), (m, t) => {
    const iso = addDays(startOfWeek(t, 'mon'), (WD_ALIASES[m[1]] + 6) % 7);
    return iso >= t ? iso : nextWeekday(t, WD_ALIASES[m[1]]);
  }],
  [new RegExp(`^(?:on )?(${WD_RE})\\b`), (m, t) => nextWeekday(t, WD_ALIASES[m[1]])],
  [/^in (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few|couple of|few) (day|days|week|weeks|wk|wks|month|months)\b/, (m, t) => {
    const raw = m[1].replace(/ of$/, '').replace(/^a (couple|few)$/, '$1');
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUM_WORDS[raw] ?? 1;
    if (m[2].startsWith('d')) return addDays(t, n);
    if (m[2].startsWith('w')) return addDays(t, n * 7);
    const [y, mo, d] = t.split('-').map(Number);
    const total = mo - 1 + n;
    const ny = y + Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return makeISO(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }],
  [/^(\d{4})-(\d{2})-(\d{2})\b/, (m) => {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return isISODate(iso) ? iso : null;
  }],
  [/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/, (m) => {
    const y = fullYear(m[3]);
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    const iso = makeISO(y, mo, d);
    return isISODate(iso) ? iso : null;
  }],
  [/^(\d{1,2})\/(\d{1,2})\b(?!\/)/, (m, t) => {
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return nextMonthDay(t, mo, d);
  }],
  [new RegExp(`^(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`), (m, t) => {
    const mo = MONTHS[m[1]];
    const d = parseInt(m[2], 10);
    if (m[3]) {
      const iso = makeISO(parseInt(m[3], 10), mo, d);
      return isISODate(iso) ? iso : null;
    }
    return nextMonthDay(t, mo, d);
  }],
  [new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_RE})\\b`), (m, t) => nextMonthDay(t, MONTHS[m[2]], parseInt(m[1], 10))],
  [/^(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/, (m, t) => {
    const d = parseInt(m[1], 10);
    if (d < 1 || d > 31) return null;
    const [y, mo] = t.split('-').map(Number);
    for (let i = 0; i < 14; i++) {
      const total = mo - 1 + i;
      const ny = y + Math.floor(total / 12);
      const nm = (total % 12) + 1;
      if (d > daysInMonth(ny, nm)) continue;
      const iso = makeISO(ny, nm, d);
      if (iso >= t) return iso;
    }
    return null;
  }],
];

// "eod fri", "end of day on friday": eod is the time of day, the date after it is the day.
const EOD_PREFIX_RE = /^(?:eod|end of (?:the )?day)(?:\s+on)?\s+(?=\S)/;

/**
 * Parse a date phrase at the START of `text` (leading whitespace ignored).
 * Returns { date, consumed } where consumed is the exact matched substring of the
 * original text (after leading whitespace), or null.
 * "eod"/"end of day" alone is today; followed by a date ("eod fri") it is that date.
 */
export function parseDatePhrase(text, today) {
  if (typeof text !== 'string' || !isISODate(today)) return null;
  const lead = text.match(/^\s*/)[0].length;
  const body = text.slice(lead);
  const lower = body.toLowerCase();
  const eod = lower.match(EOD_PREFIX_RE);
  if (eod) {
    const next = parseDatePhrase(body.slice(eod[0].length), today);
    if (next) return { date: next.date, consumed: body.slice(0, eod[0].length + next.consumed.length) };
  }
  for (const [re, resolve] of DATE_RULES) {
    const m = lower.match(re);
    if (!m) continue;
    const date = resolve(m, today);
    if (date && isISODate(date)) return { date, consumed: body.slice(0, m[0].length) };
  }
  return null;
}

/**
 * Find a date phrase anywhere in `text` (first match at a word boundary).
 * Returns { date, consumed, index } or null. `index` is into the original text.
 */
export function findDatePhrase(text, today) {
  if (typeof text !== 'string') return null;
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && /[a-z0-9]/i.test(text[i - 1])) continue;
    if (!/[a-z0-9]/i.test(text[i])) continue;
    const hit = parseDatePhrase(text.slice(i), today);
    if (hit) return { ...hit, index: i };
  }
  return null;
}
