import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CATEGORIES, GROUP_HUES, KEYWORD_RULES, oklchToHex, hexToOklch, pickColor, resolveCategory, makeCategory, catList,
} from '../src/engine/categories.js';
import { DEFAULT_CATEGORIES as FROM_DEFAULTS } from '../src/engine/defaults.js';
import { INBOX_CATEGORY, GROUPS } from '../src/engine/model.js';

const cats = [...DEFAULT_CATEGORIES, INBOX_CATEGORY];
const NOW = '2026-10-05T13:00:00.000Z';

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const inBand = (h, [lo, hi]) => (hi >= lo ? h >= lo - 0.75 && h <= hi + 0.75 : h >= lo - 0.75 || h <= hi + 0.75);

// Deterministic PRNG for property-style tests.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('re-exports', () => {
  test('DEFAULT_CATEGORIES is the defaults.js array', () => {
    assert.equal(DEFAULT_CATEGORIES, FROM_DEFAULTS);
  });
  test('GROUP_HUES matches the contract', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(GROUP_HUES)), {
      research: [170, 340], clinical: [345, 20], coursework: [70, 130], teaching: [120, 160],
      service: [320, 360], admin: [200, 260], life: [20, 180],
    });
    for (const g of GROUPS) assert.ok(GROUP_HUES[g.id], g.id);
  });
});

describe('OKLCH <-> hex', () => {
  test('known anchors', () => {
    assert.equal(oklchToHex(1, 0, 0), '#ffffff');
    assert.equal(oklchToHex(0, 0, 0), '#000000');
    const red = hexToOklch('#ff0000');
    assert.ok(Math.abs(red.l - 0.628) < 0.001, String(red.l));
    assert.ok(Math.abs(red.c - 0.2577) < 0.001, String(red.c));
    assert.ok(Math.abs(red.h - 29.23) < 0.05, String(red.h));
    const grey = hexToOklch('#808080');
    assert.ok(grey.c < 1e-4);
    assert.equal(grey.h, 0);
  });
  test('round-trips every default color exactly', () => {
    for (const c of DEFAULT_CATEGORIES) {
      const o = hexToOklch(c.color);
      assert.equal(oklchToHex(o.l, o.c, o.h), c.color, c.id);
    }
  });
  test('round-trips random sRGB colors within 1/255 per channel', () => {
    const r = rng(42);
    for (let i = 0; i < 3000; i++) {
      const hex = '#' + Math.floor(r() * 0x1000000).toString(16).padStart(6, '0');
      const o = hexToOklch(hex);
      const back = oklchToHex(o.l, o.c, o.h);
      const a = channels(hex);
      const b = channels(back);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) <= 1, `${hex} → ${back}`);
    }
  });
  test('accepts #rgb, no "#", and uppercase', () => {
    assert.deepEqual(hexToOklch('#fff'), hexToOklch('#ffffff'));
    assert.deepEqual(hexToOklch('89B7FF'), hexToOklch('#89b7ff'));
  });
  test('bad hex → null', () => {
    for (const bad of [null, undefined, '', '#12', '#zzzzzz', 'red', 42, {}]) assert.equal(hexToOklch(bad), null);
  });
  test('out-of-gamut colors reduce chroma, keep lightness and hue', () => {
    const hex = oklchToHex(0.78, 0.4, 145);
    assert.match(hex, /^#[0-9a-f]{6}$/);
    const o = hexToOklch(hex);
    assert.ok(o.c < 0.4 && o.c > 0.15, String(o.c));
    assert.ok(Math.abs(o.l - 0.78) < 0.01, String(o.l));
    assert.ok(hueDist(o.h, 145) < 1.5, String(o.h));
  });
  test('weird numbers never throw and give a valid hex', () => {
    for (const args of [[NaN, NaN, NaN], [2, 5, -720], [-1, -1, 1e9], [0.5, Infinity, 10], []]) {
      assert.match(oklchToHex(...args), /^#[0-9a-f]{6}$/);
    }
  });
});

describe('pickColor', () => {
  test('returns an L 0.78 / C ~0.12 color inside the group band', () => {
    const existing = DEFAULT_CATEGORIES.map((c) => c.color);
    for (const g of Object.keys(GROUP_HUES)) {
      const hex = pickColor(existing, g);
      const o = hexToOklch(hex);
      assert.ok(Math.abs(o.l - 0.78) < 0.01, `${g} l=${o.l}`);
      assert.ok(o.c > 0.1 && o.c < 0.13, `${g} c=${o.c}`);
      assert.ok(inBand(o.h, GROUP_HUES[g]), `${g} h=${o.h}`);
    }
  });
  test('maximizes the minimum distance to existing hues', () => {
    const existing = [oklchToHex(0.78, 0.12, 70), oklchToHex(0.78, 0.12, 130)];
    const o = hexToOklch(pickColor(existing, 'coursework'));
    assert.ok(Math.abs(o.h - 100) < 1.5, String(o.h));
  });
  test('picks the band end when existing hues crowd the other end', () => {
    const existing = [oklchToHex(0.78, 0.12, 200), oklchToHex(0.78, 0.12, 215)];
    const o = hexToOklch(pickColor(existing, 'admin'));
    assert.ok(Math.abs(o.h - 260) < 1.5, String(o.h));
  });
  test('clinical band wraps past 360', () => {
    const existing = [oklchToHex(0.78, 0.12, 350), oklchToHex(0.78, 0.12, 10)];
    const o = hexToOklch(pickColor(existing, 'clinical'));
    assert.ok(inBand(o.h, [345, 20]), String(o.h));
    // farthest point of 345..20 from {350, 10} is 20 (dist 10) vs 345 (dist 5)
    assert.ok(hueDist(o.h, 20) < 1.5, String(o.h));
  });
  test('no existing colors → middle of the band', () => {
    const o = hexToOklch(pickColor([], 'coursework'));
    assert.ok(Math.abs(o.h - 100) < 1.5, String(o.h));
    const w = hexToOklch(pickColor(undefined, 'clinical'));
    assert.ok(hueDist(w.h, 2.5) < 2, String(w.h)); // middle of 345..380 = 362.5
  });
  test('ignores near-grey existing colors', () => {
    const greys = ['#808080', '#b0b8c1', '#9a9a9f'];
    for (const g of greys) assert.ok(hexToOklch(g).c < 0.03, g);
    assert.equal(pickColor(greys, 'coursework'), pickColor([], 'coursework'));
  });
  test('ignores junk in existingHexes and unknown groups', () => {
    assert.match(pickColor([null, 'nope', 5, '#89b7ff'], 'teaching'), /^#[0-9a-f]{6}$/);
    assert.match(pickColor(['#89b7ff'], 'no-such-group'), /^#[0-9a-f]{6}$/);
  });
  test('is far from every existing hue in its band for the seed set', () => {
    const existing = DEFAULT_CATEGORIES.map((c) => c.color);
    const hues = existing.map(hexToOklch).filter((o) => o.c >= 0.03).map((o) => o.h);
    const o = hexToOklch(pickColor(existing, 'research'));
    const minD = Math.min(...hues.map((h) => hueDist(h, o.h)));
    // brute force over the band: nothing is more than 2° better
    let best = 0;
    for (let x = 170; x <= 340; x += 0.5) best = Math.max(best, Math.min(...hues.map((h) => hueDist(h, x))));
    assert.ok(minD >= best - 2.5, `${minD} vs ${best}`);
  });
});

describe('resolveCategory', () => {
  test('id, name, alias (case-insensitive), leading #', () => {
    assert.equal(resolveCategory('rsa', cats).id, 'rsa');
    assert.equal(resolveCategory('RSA', cats).id, 'rsa');
    assert.equal(resolveCategory('#Multivariate', cats).id, 'multivar');
    assert.equal(resolveCategory('nyx', cats).id, 'rsa');
    assert.equal(resolveCategory('Walk Ziggy', cats).id, 'ziggy');
    assert.equal(resolveCategory('Clinical (PSC)', cats).id, 'psc');
  });
  test('punctuation-insensitive exact match', () => {
    assert.equal(resolveCategory('grad-roles', cats).id, 'gradroles');
    assert.equal(resolveCategory('predissertation', cats).id, 'predis');
    assert.equal(resolveCategory('pre-dissertation', cats).id, 'predis');
    assert.equal(resolveCategory('ai+research', cats).id, 'gradroles');
  });
  test('unique prefix ≥ 3 of id or name', () => {
    assert.equal(resolveCategory('tub', cats).id, 'tubric');
    assert.equal(resolveCategory('multi', cats).id, 'multivar'); // id and name, same category
    assert.equal(resolveCategory('prac', cats).id, 'practicum');
    assert.equal(resolveCategory('assess', cats).id, 'practicum'); // name "Assessment practicum"
  });
  test('ambiguous or short prefixes → null', () => {
    assert.equal(resolveCategory('pe', cats), null);
    // "ma" too short; "man" is unique (manuscripts)
    assert.equal(resolveCategory('ma', cats), null);
    assert.equal(resolveCategory('man', cats).id, 'manuscripts');
    const two = [
      { id: 'stats', name: 'Stats', aliases: [] },
      { id: 'stamps', name: 'Stamps', aliases: [] },
    ];
    assert.equal(resolveCategory('sta', two), null);
  });
  test('archived categories still resolve; ambiguous prefix prefers the active one', () => {
    const arch = [{ id: 'oldclass', name: 'Old class', aliases: [], archived: true }];
    assert.equal(resolveCategory('oldclass', arch).id, 'oldclass');
    assert.equal(resolveCategory('old', arch).id, 'oldclass');
    const mixed = [
      { id: 'stats1', name: 'Stats I', aliases: [], archived: true },
      { id: 'stats2', name: 'Stats II', aliases: [] },
    ];
    assert.equal(resolveCategory('stats', mixed).id, 'stats2');
  });
  test('accepts the state.cats map', () => {
    const map = Object.fromEntries(cats.map((c) => [c.id, c]));
    assert.equal(resolveCategory('dti', map).id, 'dti');
  });
  test('junk → null', () => {
    for (const t of [null, undefined, '', '#', '   ', {}, []]) assert.equal(resolveCategory(t, cats), null);
    assert.equal(resolveCategory('rsa', null), null);
    assert.equal(resolveCategory('zine', cats), null);
  });
});

describe('makeCategory', () => {
  test('builds a normalized category with defaults', () => {
    const c = makeCategory('Zine', { group: 'life', cats, now: NOW });
    assert.equal(c.id, 'zine');
    assert.equal(c.name, 'Zine');
    assert.equal(c.group, 'life');
    assert.deepEqual(c.aliases, ['zine']);
    assert.equal(c.glyph, 'ZI');
    assert.equal(c.archived, false);
    assert.equal(c.created, NOW);
    assert.match(c.color, /^#[0-9a-f]{6}$/);
    assert.equal(c.color, pickColor(cats.map((x) => x.color), 'life'));
    assert.equal(c.order, 74); // after Personal (73)
  });
  test('unique id with -2, -3 suffixes', () => {
    const a = makeCategory('RSA', { cats, now: NOW });
    assert.equal(a.id, 'rsa-2');
    const b = makeCategory('RSA', { cats: [...cats, a], now: NOW });
    assert.equal(b.id, 'rsa-3');
    assert.equal(makeCategory('inbox', { cats: [], now: NOW }).id, 'inbox-2');
  });
  test('given color, aliases and glyph win', () => {
    const c = makeCategory('Grant writing', { group: 'research', cats, color: '#ABCDEF', aliases: ['NIH', 'f31'], glyph: 'GW', now: NOW });
    assert.equal(c.id, 'grant-writing');
    assert.equal(c.color, '#abcdef');
    assert.deepEqual(c.aliases, ['nih', 'f31']);
    assert.equal(c.glyph, 'GW');
  });
  test('glyph default skips punctuation', () => {
    assert.equal(makeCategory('#1 fan club', { cats, now: NOW }).glyph, '1F');
    assert.equal(makeCategory('  ai / ml  ', { cats, now: NOW }).glyph, 'AI');
  });
  test('bad group falls back to admin; bad color is replaced', () => {
    const c = makeCategory('Thing', { group: 'nope', color: 'red', cats, now: NOW });
    assert.equal(c.group, 'admin');
    assert.match(c.color, /^#[0-9a-f]{6}$/);
    assert.notEqual(c.color, '#b0b8c1');
  });
  test('empty name and missing opts do not throw', () => {
    const c = makeCategory('', undefined);
    assert.equal(c.name, 'Category');
    assert.equal(typeof c.id, 'string');
    assert.ok(c.created);
  });
  test('does not mutate cats', () => {
    const copy = JSON.parse(JSON.stringify(cats));
    makeCategory('New one', { cats, group: 'teaching', now: NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(cats)), copy);
  });
  test('leading # is stripped from the name', () => {
    const c = makeCategory('#zine', { cats, now: NOW });
    assert.equal(c.name, 'zine');
    assert.equal(c.id, 'zine');
  });
});

describe('KEYWORD_RULES', () => {
  test('shape', () => {
    assert.ok(Array.isArray(KEYWORD_RULES) && KEYWORD_RULES.length >= 10);
    for (const r of KEYWORD_RULES) {
      assert.ok(r.re instanceof RegExp);
      assert.ok(typeof r.reason === 'string');
      assert.ok(r.cat === null ? r.group === 'coursework' : typeof r.cat === 'string');
    }
  });
  const first = (t) => KEYWORD_RULES.find((r) => r.re.test(t));
  test('contract keywords route to the right category', () => {
    const table = {
      'pay rent': 'admin', 'renew license': 'admin', 'book flight': 'admin', 'reimbursement receipts': 'admin',
      'zoom w/ x': 'meetings', '1:1 prep': 'meetings', 'meeting notes': 'meetings',
      'take out trash': 'home', 'vacuum': 'home', 'walk': 'ziggy', 'vet bill': 'ziggy',
      'psychiatrist refill': 'health', 'pharmacy': 'health', 'intake report': 'psc', 'session notes': 'psc',
      'mentee check-in': 'undergrad', 'RA schedule': 'admin', 'train new RAs': 'undergrad',
      'committee vote': 'gradroles', 'student rep email': 'admin', 'paper figures': 'manuscripts', 'reviewer 2': 'manuscripts',
    };
    for (const [t, cat] of Object.entries(table)) assert.equal(first(t)?.cat, cat, t);
    assert.equal(first('quiz 3').group, 'coursework');
    assert.equal(first('hw 2').group, 'coursework');
  });
  test('keywords respect word boundaries and case where needed', () => {
    assert.equal(first('read a book'), undefined); // "book" only as the first word
    assert.equal(first('graph theory'), undefined); // no "ra" inside words
    assert.equal(first('extra credit'), undefined);
    assert.equal(first('the walkthrough'), undefined);
    assert.equal(first('format table'), undefined); // not "form"
  });
});

describe('catList', () => {
  test('array, map, junk', () => {
    assert.equal(catList(cats).length, cats.length);
    assert.equal(catList({ a: { id: 'a' }, b: null, c: 3 }).length, 1);
    assert.deepEqual(catList(null), []);
    assert.deepEqual(catList('x'), []);
  });
});
