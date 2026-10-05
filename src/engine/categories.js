// Category registry helpers: OKLCH color math, color picking for new
// categories, token -> category resolution, and the keyword rules that
// parse.inferCategory falls back on. Pure: no DOM, no Node APIs.
// See docs/ARCHITECTURE.md ("categories.js").

import { DEFAULT_CATEGORIES } from './defaults.js';
import { GROUPS, normalizeCategory, slugify } from './model.js';
import { nowISO } from './dates.js';

export { DEFAULT_CATEGORIES };

// ---------------------------------------------------------------- OKLCH <-> sRGB

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const normHue = (h) => ((h % 360) + 360) % 360;

const toLinear = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const toGamma = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// Björn Ottosson's OKLab matrices.
function oklabToLinearRGB(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearRGBToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklchToLinear(l, c, h) {
  const hr = (h * Math.PI) / 180;
  return oklabToLinearRGB(l, c * Math.cos(hr), c * Math.sin(hr));
}

const GAMUT_EPS = 1e-6;
const inGamut = (rgb) => rgb.every((v) => v >= -GAMUT_EPS && v <= 1 + GAMUT_EPS);

const hex2 = (v) => Math.round(clamp01(toGamma(clamp01(v))) * 255).toString(16).padStart(2, '0');

/**
 * OKLCH (l 0..1, c >= 0, h degrees) → "#rrggbb". Out-of-gamut colors keep their
 * lightness and hue and lose chroma until they fit in sRGB. Never throws.
 */
export function oklchToHex(l, c, h) {
  const L = finite(l) ? clamp01(l) : 0.78;
  const C = finite(c) ? Math.max(0, c) : 0;
  const H = finite(h) ? normHue(h) : 0;
  let rgb = oklchToLinear(L, C, H);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, H))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear(L, lo, H);
  }
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** "#rrggbb" / "#rgb" (with or without "#") → { l, c, h } (h in [0, 360)), or null if unparseable. */
export function hexToOklch(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const r = toLinear(parseInt(s.slice(0, 2), 16) / 255);
  const g = toLinear(parseInt(s.slice(2, 4), 16) / 255);
  const b = toLinear(parseInt(s.slice(4, 6), 16) / 255);
  const [L, A, B] = linearRGBToOklab(r, g, b);
  const c = Math.sqrt(A * A + B * B);
  const h = c < 1e-6 ? 0 : normHue((Math.atan2(B, A) * 180) / Math.PI);
  return { l: L, c, h };
}

// ---------------------------------------------------------------- color picking

/** OKLCH hue band per group, in degrees. A band may wrap past 360 (clinical: 345 → 20). */
export const GROUP_HUES = Object.freeze({
  research: Object.freeze([170, 340]),
  clinical: Object.freeze([345, 20]),
  coursework: Object.freeze([70, 130]),
  teaching: Object.freeze([120, 160]),
  service: Object.freeze([320, 360]),
  admin: Object.freeze([200, 260]),
  life: Object.freeze([20, 180]),
});

const PICK_L = 0.78;
const PICK_C = 0.12;
const GREY_CHROMA = 0.03;

const hueDist = (a, b) => {
  const d = Math.abs(normHue(a) - normHue(b));
  return d > 180 ? 360 - d : d;
};

/**
 * A new category color: OKLCH L 0.78, C 0.12, at the hue (2° steps) inside the
 * group's band that is farthest from every existing (non-grey) hue. Ties go to
 * the hue nearest the band's middle. Unknown group → the full hue circle.
 */
export function pickColor(existingHexes, group) {
  const band = GROUP_HUES[group] ?? [0, 358];
  const start = band[0];
  const end = band[1] < band[0] ? band[1] + 360 : band[1];
  const mid = (start + end) / 2;
  const hues = [];
  for (const hex of Array.isArray(existingHexes) ? existingHexes : []) {
    const o = hexToOklch(hex);
    if (o && o.c >= GREY_CHROMA) hues.push(o.h);
  }
  const candidates = [];
  for (let x = start; x <= end + 1e-9; x += 2) candidates.push(x);
  if (candidates[candidates.length - 1] < end) candidates.push(end);

  let best = null;
  for (const x of candidates) {
    const score = hues.length ? Math.min(...hues.map((hh) => hueDist(x, hh))) : Infinity;
    const centerDist = Math.abs(x - mid);
    const tie = best && (score === best.score || Math.abs(score - best.score) <= 1e-9);
    if (!best || (!tie && score > best.score) || (tie && centerDist < best.centerDist)) {
      best = { x, score, centerDist };
    }
  }
  return oklchToHex(PICK_L, PICK_C, normHue(best.x));
}

// ---------------------------------------------------------------- lookup

/** Accepts state.cats (an { id: Category } map) or an array; returns an array of category objects. */
export function catList(cats) {
  if (Array.isArray(cats)) return cats.filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  if (cats && typeof cats === 'object') {
    return Object.values(cats).filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  }
  return [];
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a typed token ("#rsa", "Multivariate", "pre-dissertation", "tub") to a
 * category: exact id, name or alias (case-insensitive, punctuation-insensitive),
 * else a unique prefix (≥ 3 chars) of an id or name. Archived categories still
 * resolve. Returns the category object or null.
 */
export function resolveCategory(token, cats) {
  if (typeof token !== 'string' && typeof token !== 'number') return null;
  const t = String(token).trim().replace(/^#+/, '').trim().toLowerCase();
  if (!t) return null;
  const list = catList(cats);
  if (!list.length) return null;
  const tq = squash(t);

  const byId = list.find((c) => c.id.toLowerCase() === t);
  if (byId) return byId;
  const byName = list.find((c) => typeof c.name === 'string' && c.name.trim().toLowerCase() === t);
  if (byName) return byName;
  const aliasesOf = (c) => (Array.isArray(c.aliases) ? c.aliases.map((a) => String(a).trim().toLowerCase()) : []);
  const byAlias = list.find((c) => aliasesOf(c).includes(t));
  if (byAlias) return byAlias;
  if (tq) {
    const loose = list.find(
      (c) => squash(c.id) === tq || squash(c.name) === tq || aliasesOf(c).some((a) => squash(a) === tq),
    );
    if (loose) return loose;
  }

  if (t.length < 3) return null;
  const hits = list.filter((c) => {
    const id = c.id.toLowerCase();
    const name = typeof c.name === 'string' ? c.name.trim().toLowerCase() : '';
    return id.startsWith(t) || name.startsWith(t) || (tq.length >= 3 && (squash(id).startsWith(tq) || squash(name).startsWith(tq)));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const active = hits.filter((c) => !c.archived);
    if (active.length === 1) return active[0];
  }
  return null;
}

// ---------------------------------------------------------------- creation

/**
 * Build a new Category (not yet in state). The id is slugify(name), suffixed
 * -2, -3, … if taken. Color comes from pickColor() unless a valid hex is given.
 * Aliases default to [lowercased name]; glyph defaults to the first two
 * alphanumerics, uppercased. opts: { group, cats, color, aliases, glyph, note, order, now }.
 */
export function makeCategory(name, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cleanName = String(name ?? '').replace(/^\s*#+/, '').replace(/\s+/g, ' ').trim() || 'Category';
  const list = catList(o.cats);
  const group = GROUPS.some((g) => g.id === o.group) ? o.group : 'admin';

  const taken = new Set(list.map((c) => c.id.toLowerCase()));
  taken.add('inbox');
  const base = slugify(cleanName);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const color =
    typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color.trim())
      ? o.color.trim().toLowerCase()
      : pickColor(list.map((c) => c.color), group);

  const aliases = Array.isArray(o.aliases) ? o.aliases : [cleanName.toLowerCase()];

  let order = o.order;
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    const inGroup = list.filter((c) => c.group === group && c.id !== 'inbox' && Number.isFinite(c.order));
    const gi = GROUPS.findIndex((g) => g.id === group);
    order = inGroup.length ? Math.max(...inGroup.map((c) => c.order)) + 1 : (gi + 1) * 10;
  }

  const glyph =
    typeof o.glyph === 'string' && o.glyph.trim()
      ? o.glyph.trim()
      : cleanName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || undefined;

  return normalizeCategory(
    { id, name: cleanName, group, color, glyph, aliases, order, note: typeof o.note === 'string' ? o.note : '', archived: false },
    { now: typeof o.now === 'string' && o.now ? o.now : nowISO() },
  );
}

// ---------------------------------------------------------------- keyword rules

// Word-ish boundary: not inside a longer run of letters/digits ("car" ≠ "card").
const kw = (alts) => new RegExp(`(?:^|[^a-z0-9])(${alts})(?![a-z0-9])`, 'i');

/**
 * Fallback rules for parse.inferCategory (used only when no alias matches).
 * First matching rule whose category exists wins. A rule with `cat: null` and
 * `group: "coursework"` means "some course": inferCategory files it under a
 * course category named in the title, else inbox with reason "which course?".
 */
export const KEYWORD_RULES = Object.freeze([
  {
    re: new RegExp(
      `(?:^|[^a-z0-9])(e-?mails?|reply|respond|(?:re)?schedule|pay|payment|register|registration|forms?|reimburse(?:ment)?|renew(?:al)?)(?![a-z0-9])|^\\s*(book)(?![a-z0-9])`,
      'i',
    ),
    cat: 'admin',
    reason: 'admin',
  },
  { re: kw('meet|meeting|meetings|1:1|zoom'), cat: 'meetings', reason: 'meeting' },
  { re: kw('clean|cleaning|laundry|vacuum|dishes|groceries|grocery|trash'), cat: 'home', reason: 'home chore' },
  { re: kw('walk|vet'), cat: 'ziggy', reason: 'Ziggy' },
  { re: kw('dentist|doctor|psychiatr[a-z]*|pharmacy'), cat: 'health', reason: 'health' },
  { re: kw('clients?|session notes|supervision|assessments?|intakes?'), cat: 'psc', reason: 'clinical' },
  { re: kw('homework|hw|assignments?|quiz(?:zes)?|exams?|reading'), cat: null, group: 'coursework', reason: 'which course?' },
  { re: /(?:^|[^A-Za-z0-9])((?:[Uu]ndergrad|UNDERGRAD|[Mm]entee|MENTEE)[sS]?|RAs?)(?![A-Za-z0-9])/, cat: 'undergrad', reason: 'undergrads' },
  { re: kw('committee|student rep'), cat: 'gradroles', reason: 'grad role' },
  { re: kw('manuscripts?|papers?|revisions?|reviewers?'), cat: 'manuscripts', reason: 'manuscript' },
]);
