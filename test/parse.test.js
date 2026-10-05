import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd, inferCategory, inferKind } from '../src/engine/parse.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { INBOX_CATEGORY, normalizeCategory, emptyState } from '../src/engine/model.js';
import { addTask } from '../src/engine/ops.js';

const TODAY = '2026-10-05'; // Monday
const cats = [...DEFAULT_CATEGORIES, INBOX_CATEGORY];
const P = (text, extra = {}) => parseQuickAdd(text, { today: TODAY, cats, ...extra });

/** Assert only the listed fields. */
function check(text, expected) {
  const r = P(text);
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(r[k], v, `${JSON.stringify(text)} → ${k}: got ${JSON.stringify(r[k])}, want ${JSON.stringify(v)}\nfull: ${JSON.stringify(r)}`);
  }
  return r;
}

describe('parseQuickAdd: required table', () => {
  test('email mike - tomorrow', () => {
    check('email mike - tomorrow', { title: 'Email Mike', plan: '2026-10-06', due: null, cat: 'admin', kind: 'email' });
  });
  test('RSA intro draft by fri ~2h !', () => {
    check('RSA intro draft by fri ~2h !', { title: 'RSA intro draft', due: '2026-10-09', plan: null, est: 120, prio: 2, cat: 'rsa', kind: 'writing' });
  });
  test('meet with teij thu at 3pm', () => {
    check('meet with teij thu at 3pm', { title: 'Meet with Teij', plan: '2026-10-08', time: '15:00', kind: 'meeting', cat: 'meetings' });
  });
  test('walk ziggy 2x a day', () => {
    const r = check('walk ziggy 2x a day', { recurring: { every: 1, perDay: 2 }, cat: 'ziggy' });
    assert.ok(['Walk ziggy', 'Walk Ziggy'].includes(r.title), r.title);
  });
  test('laundry every week', () => {
    check('laundry every week', { recurring: { every: 7, perDay: 1 }, cat: 'home', title: 'Laundry' });
  });
  test('multivar assignment 5 due 10/16', () => {
    check('multivar assignment 5 due 10/16', { due: '2026-10-16', cat: 'multivar', title: 'Multivar assignment 5' });
  });
  test('client notes - tonight', () => {
    check('client notes - tonight', { cat: 'psc', plan: '2026-10-05', title: 'Client notes' });
  });
  test('schedule dentist: alias beats keyword, no date', () => {
    check('schedule dentist', { cat: 'health', plan: null, due: null, catConfidence: 0.9 });
  });
  test('#predis pick committee - next week', () => {
    check('#predis pick committee - next week', { cat: 'predis', plan: '2026-10-12', title: 'Pick committee', catConfidence: 1, newCatName: null });
  });
  test('#zine collective flyers', () => {
    check('#zine collective flyers', { newCatName: 'zine', cat: 'inbox' });
  });
  test('call mom @sat', () => {
    check('call mom @sat', { title: 'Call Mom', plan: '2026-10-10' });
  });
  test('read chapter 4 for cbt (45m) - wed', () => {
    check('read chapter 4 for cbt (45m) - wed', { est: 45, cat: 'cbt', kind: 'reading', plan: '2026-10-07', title: 'Read chapter 4 for cbt' });
  });
  test('submit flux abstract - oct 20 → due, not plan', () => {
    check('submit flux abstract - oct 20', { due: '2026-10-20', plan: null, title: 'Submit flux abstract' });
  });
  test('fix DTI icons asap', () => {
    check('fix DTI icons asap', { prio: 3, cat: 'dti', title: 'Fix DTI icons' });
  });
  test('pre-proc DTI data - tomorrow (hyphenated word untouched)', () => {
    check('pre-proc DTI data - tomorrow', { title: 'Pre-proc DTI data', plan: '2026-10-06' });
  });
  test('follow up with jason re ABCD - mon', () => {
    check('follow up with jason re ABCD - mon', { plan: '2026-10-12', cat: 'manuscripts', title: 'Follow up with Jason re ABCD' });
  });
  test('"car" alias matches whole words only', () => {
    check('buy a car charger', { cat: 'home' });
    const r = P('print card for lily');
    assert.notEqual(r.cat, 'home');
    assert.equal(r.cat, 'undergrad');
  });
  test('empty and blank input', () => {
    for (const t of ['', '   ', '\n\t ']) {
      const r = P(t);
      assert.equal(r.title, '');
      assert.equal(r.plan, null);
      assert.equal(r.due, null);
      assert.equal(r.cat, 'inbox');
      assert.deepEqual(r.tokens, []);
    }
  });
});

describe('parseQuickAdd: dates', () => {
  test('"tom" is a name right after a name verb, a date after a separator', () => {
    check('email tom', { title: 'Email Tom', plan: null });
    check('email tom - tom', { title: 'Email Tom', plan: '2026-10-06' });
    check('gift for tom', { plan: null, due: null });
  });
  test('capitalized Tom is a person', () => {
    check('book by Tom', { due: null, plan: null });
    check('Email Tom tomorrow', { title: 'Email Tom', plan: '2026-10-06' });
  });
  test('bare trailing "tom" after a non-name word means tomorrow', () => {
    check('laundry tom', { title: 'Laundry', plan: '2026-10-06' });
  });
  test('a date word in the middle of a title is not consumed', () => {
    check('read the friday paper notes', { title: 'Read the friday paper notes', plan: null, due: null });
  });
  test('bare trailing weekday', () => {
    check('email mike friday', { title: 'Email Mike', plan: '2026-10-09' });
    check('call mom, sat', { title: 'Call Mom', plan: '2026-10-10' });
    check('call mom on sat', { title: 'Call Mom', plan: '2026-10-10' });
  });
  test('"sun" as a noun is not Sunday', () => {
    check('get some sun', { plan: null, title: 'Get some sun' });
    check('laundry sun', { plan: '2026-10-11', title: 'Laundry' });
  });
  test('"by mon" mid-title is not a date ("stop by mon ami")', () => {
    check('stop by mon ami bakery', { due: null, plan: null, title: 'Stop by mon ami bakery' });
  });
  test('"by <strong date>" mid-title is a due date', () => {
    check('draft by fri for jason', { due: '2026-10-09', title: 'Draft for jason' });
  });
  test('due + plan together', () => {
    check('send forms by fri tomorrow', { due: '2026-10-09', plan: '2026-10-06', title: 'Send forms' });
    check('submit abstract by oct 20 - wed', { due: '2026-10-20', plan: '2026-10-07' });
  });
  test('ordinal and relative phrases', () => {
    check('pay rent by the 15th', { due: '2026-10-15', title: 'Pay rent', cat: 'admin' });
    check('thesis lit review by eow', { due: '2026-10-09', cat: 'predis' });
    check('pick up meds - in 3 days', { plan: '2026-10-08', cat: 'health', kind: 'errand' });
    check('grocery run this weekend', { plan: '2026-10-10', cat: 'home', title: 'Grocery run' });
    check('rsa analyses glm - next tue', { plan: '2026-10-13', kind: 'analysis' });
    check('follow-up with ingrid - next fri', { plan: '2026-10-16', title: 'Follow-up with Ingrid', cat: 'dti' });
  });
  test('deadline-ish titles turn a separator date into due; prep titles do not', () => {
    check('multivar exam - oct 20', { due: '2026-10-20', plan: null, kind: 'deadline' });
    check('study for multivar exam - tomorrow', { plan: '2026-10-06', due: null });
    check('turn in practicum report friday', { due: '2026-10-09', plan: null, cat: 'practicum' });
    check('submit irb form 10/1', { due: '2026-10-01' }); // 4 days ago: overdue, not next year
  });
  test('dash variants and qualifiers', () => {
    check('email mike — tomorrow', { plan: '2026-10-06', title: 'Email Mike' });
    check('email mike–tmrw', { plan: '2026-10-06', title: 'Email Mike' });
    check('email mike -- tomorrow', { plan: '2026-10-06', title: 'Email Mike' });
    check('email mike - tomorrow morning', { plan: '2026-10-06', title: 'Email Mike' });
  });
  test('a separator segment that is not a date stays in the title', () => {
    check('rsa - intro section', { plan: null, due: null, title: 'Rsa - intro section' });
  });
  test('leading date with punctuation or an unambiguous phrase', () => {
    check('tomorrow: email mike', { plan: '2026-10-06', title: 'Email Mike' });
    check('fri, laundry', { plan: '2026-10-09', title: 'Laundry' });
    check('10/16 - submit irb form', { due: '2026-10-16', plan: null });
    check("today's meeting notes", { plan: null, title: "Today's meeting notes" });
    check("tom's birthday gift", { plan: null, cat: 'personal' });
    check('friday paper notes', { plan: null });
  });
  test('"hw due - fri" drops the dangling "due"', () => {
    check('hw due - fri', { title: 'Hw', due: '2026-10-09', catReason: 'which course?' });
  });
  test('date-only input gives an empty title', () => {
    check('tomorrow', { title: '', plan: '2026-10-06' });
    check('- tomorrow', { title: '', plan: '2026-10-06' });
  });
});

describe('parseQuickAdd: time, estimate, priority', () => {
  test('time forms', () => {
    check('1:1 with teij at 3', { time: '15:00', title: '1:1 with Teij', kind: 'meeting', cat: 'meetings' });
    check('call dr. kim tomorrow at 10:30am', { time: '10:30', plan: '2026-10-06', title: 'Call Dr. Kim' });
    check('fix bug in app @ 15:00', { time: '15:00', kind: 'task', title: 'Fix bug in app' });
    check('1:1 w/ teij thu 2:30', { time: '14:30', plan: '2026-10-08', title: '1:1 w/ Teij' });
    check('zoom w/ ronan 11am fri', { time: '11:00', plan: '2026-10-09', cat: 'sdn', kind: 'meeting', title: 'Zoom w/ Ronan' });
    check('vet appt for ziggy oct 12 at 9:15am', { time: '09:15', plan: '2026-10-12', kind: 'appt', cat: 'ziggy' });
  });
  test('time ranges set time and estimate', () => {
    check('lab meeting 3-4pm tomorrow', { time: '15:00', est: 60, plan: '2026-10-06', cat: 'meetings', kind: 'meeting', title: 'Lab meeting' });
    check('11-1pm workshop', { time: '11:00', est: 120, kind: 'meeting' });
  });
  test('numbers that are not times', () => {
    check('read section 4a', { time: null, title: 'Read section 4a' });
    check('look at 5 papers', { time: null, title: 'Look at 5 papers' });
    check('email mike re 3/4 split', { time: null, plan: null, due: null });
  });
  test('estimate forms', () => {
    check('write discussion section for 2 hours on thursday', { est: 120, plan: '2026-10-08', title: 'Write discussion section', kind: 'writing' });
    check('kiosk (1:30)', { est: 90, time: null, title: 'Kiosk' });
    check('read 30 pages ~45', { est: 45, title: 'Read 30 pages' });
    check('rsa figures 1h30', { est: 90 });
    check('rsa figures 1.5h', { est: 90 });
    check('inbox zero 30min', { est: 30 });
    check('quick 15-minute check', { est: 15 });
  });
  test('priority markers', () => {
    check('taxes !!', { prio: 3, title: 'Taxes' });
    check('fix it!', { prio: 2, title: 'Fix it' });
    check('!fix it', { prio: 2, title: 'Fix it' });
    check('Call Mom!!', { prio: 3, title: 'Call Mom' });
    check('someday learn rust', { prio: 0, title: 'Learn rust' });
    check('fix sink low', { prio: 0, title: 'Fix sink' });
    check('urgent: renew vpn', { prio: 3, cat: 'admin' });
    check('plain task', { prio: 1 });
  });
});

describe('parseQuickAdd: recurrence', () => {
  test('recurring phrases', () => {
    check('vacuum every other day', { recurring: { every: 2, perDay: 1 }, title: 'Vacuum' });
    check('meds twice a day', { recurring: { every: 1, perDay: 2 }, cat: 'health' });
    check('water plants every 3 days', { recurring: { every: 3, perDay: 1 }, title: 'Water plants' });
    check('dishes daily', { recurring: { every: 1, perDay: 1 }, title: 'Dishes' });
    check('clean every 2 weeks', { recurring: { every: 14, perDay: 1 } });
    check('laundry mondays', { recurring: { every: 7, perDay: 1 }, plan: null, title: 'Laundry' });
    check('walk ziggy every morning and night', { recurring: { every: 1, perDay: 2 }, title: 'Walk ziggy' });
    check('every monday standup at 10am', { recurring: { every: 7, perDay: 1 }, time: '10:00', plan: null, title: 'Standup' });
  });
  test('non-recurring tasks have recurring null', () => {
    check('email mike', { recurring: null });
  });
});

describe('parseQuickAdd: tags and categories', () => {
  test('#tag by prefix, id, and punctuation-insensitive alias', () => {
    check('#tub fix kiosk', { cat: 'tubric', title: 'Fix kiosk' });
    check('#multi hw 3', { cat: 'multivar', title: 'Hw 3' });
    check('#ai+research post', { cat: 'gradroles' });
    check('#RSA figs', { cat: 'rsa' });
  });
  test('"#5" is not a tag', () => {
    check('multivar assignment #5', { cat: 'multivar', title: 'Multivar assignment #5', newCatName: null });
  });
  test('a resolved tag wins over an unknown one', () => {
    check('#zine #rsa flyer', { cat: 'rsa', newCatName: null });
  });
  test('"ras" alias does not match inside "erase"', () => {
    check('erase whiteboard', { cat: 'inbox' });
  });
  test('coursework keyword without a course asks which course', () => {
    check('do the reading', { cat: 'inbox', catReason: 'which course?' });
  });
  test('accepts the state.cats map form', () => {
    const map = Object.fromEntries(cats.map((c) => [c.id, c]));
    const r = parseQuickAdd('email mike - tomorrow', { today: TODAY, cats: map });
    assert.equal(r.cat, 'admin');
  });
  test('falls back to default categories when cats is missing', () => {
    const r = parseQuickAdd('laundry', { today: TODAY });
    assert.equal(r.cat, 'home');
  });
});

describe('parseQuickAdd: title cleanup', () => {
  test('names after lead verbs are capitalized; other words keep their case', () => {
    check('reply to jason re revision', { title: 'Reply to Jason re revision', kind: 'email', cat: 'manuscripts' });
    check('email advisor re funding', { title: 'Email advisor re funding' });
    check('text ronan and email chloe', { title: 'Text Ronan and email Chloe' });
    check('ask lily about ra tutorial', { title: 'Ask Lily about ra tutorial', cat: 'undergrad' });
    check('dinner with tod', { title: 'Dinner with Tod', plan: null });
    check('remind me to email the committee', { title: 'Remind me to email the committee' });
  });
  test('whitespace is collapsed and trailing punctuation dropped', () => {
    check('  email    mike   ;  ', { title: 'Email Mike' });
  });
  test('mixed-case first word is left alone', () => {
    check('iPhone backup', { title: 'iPhone backup' });
  });
});

describe('parseQuickAdd: robustness', () => {
  test('odd input never throws', () => {
    const odd = [null, undefined, 42, {}, [], '#', '!!!', '~2h', '@', ' - ', '—', '(', ')', '##rsa', '@@sat', 'by', 'due',
      'every', 'at', '99:99', '13/45', '0/0', '2026-02-30', '#'.repeat(50), 'a'.repeat(5000), '🔥 ship it 🔥 - tomorrow'];
    for (const t of odd) {
      const r = parseQuickAdd(t, { today: TODAY, cats });
      assert.equal(typeof r.title, 'string');
      assert.ok(Array.isArray(r.tokens));
      assert.ok([0, 1, 2, 3].includes(r.prio));
    }
  });
  test('weird opts never throw', () => {
    for (const opts of [undefined, null, {}, { today: 'nope' }, { cats: 'x' }, { cats: [null, 1, {}] }]) {
      const r = parseQuickAdd('email mike - tomorrow', opts);
      assert.equal(r.title, 'Email Mike');
    }
  });
  test('result shape', () => {
    const r = P('email mike - tomorrow');
    assert.deepEqual(Object.keys(r).sort(), ['cat', 'catConfidence', 'catReason', 'due', 'est', 'kind', 'newCatName', 'plan', 'prio', 'recurring', 'time', 'title', 'tokens'].sort());
    assert.deepEqual(r.tokens, [{ type: 'plan', text: 'tomorrow', value: '2026-10-06' }]);
  });
  test('tokens are in input order', () => {
    const r = P('RSA intro draft by fri ~2h !');
    assert.deepEqual(r.tokens.map((t) => t.type), ['due', 'est', 'prio']);
  });
  test('does not mutate the cats input', () => {
    const copy = JSON.parse(JSON.stringify(cats));
    P('#zine flyers - tomorrow');
    P('walk ziggy 2x a day');
    assert.deepEqual(JSON.parse(JSON.stringify(cats)), copy);
  });
});

describe('inferCategory', () => {
  test('alias hits are 0.9, longest alias wins', () => {
    assert.deepEqual(inferCategory('walk ziggy', cats).id, 'ziggy');
    const r = inferCategory('email jason about the manuscript', cats);
    assert.equal(r.id, 'manuscripts');
    assert.equal(r.confidence, 0.9);
  });
  test('keyword rules are 0.6', () => {
    const r = inferCategory('meet with teij', cats);
    assert.equal(r.id, 'meetings');
    assert.equal(r.confidence, 0.6);
  });
  test('no match → inbox 0', () => {
    assert.deepEqual(inferCategory('ponder the void', cats), { id: 'inbox', confidence: 0, reason: 'no match' });
    assert.equal(inferCategory('', cats).id, 'inbox');
    assert.equal(inferCategory(null, cats).id, 'inbox');
  });
  test('multi-word aliases need word boundaries', () => {
    assert.equal(inferCategory('session notes for tuesday', cats).id, 'psc');
    assert.equal(inferCategory('discard cards', cats).id, 'inbox');
  });
  test('archived categories are never inferred', () => {
    const arch = cats.map((c) => (c.id === 'home' ? { ...c, archived: true } : c));
    assert.notEqual(inferCategory('laundry', arch).id, 'home');
  });
  test('keyword rule pointing at a missing category is skipped', () => {
    const noZiggy = cats.filter((c) => c.id !== 'ziggy');
    assert.equal(inferCategory('walk around the block', noZiggy).id, 'inbox');
    assert.equal(inferCategory('walk around the block', cats).id, 'ziggy');
  });
  test('coursework keyword uses a course named in the title', () => {
    const extra = normalizeCategory({ id: 'stats2', name: 'Bayesian stats', group: 'coursework', aliases: [] }, { now: 'x' });
    const r = inferCategory('Bayesian stats homework 3', [...cats, extra]);
    assert.equal(r.id, 'stats2');
    assert.equal(inferCategory('homework 3', cats).reason, 'which course?');
  });
  test('new categories from makeCategory are matched by name', () => {
    const zine = normalizeCategory({ id: 'zine', name: 'Zine', group: 'life', aliases: ['zine'] }, { now: 'x' });
    assert.equal(inferCategory('zine collective flyers', [...cats, zine]).id, 'zine');
  });
});

describe('inferKind', () => {
  test('kinds', () => {
    assert.equal(inferKind('Email Mike'), 'email');
    assert.equal(inferKind('Respond to IRB'), 'email');
    assert.equal(inferKind('Read ch 4'), 'reading');
    assert.equal(inferKind('Draft intro'), 'writing');
    assert.equal(inferKind('Run GLM'), 'analysis');
    assert.equal(inferKind('Meet with Teij'), 'meeting');
    assert.equal(inferKind('Dentist appt'), 'appt');
    assert.equal(inferKind('Submit abstract', { due: '2026-10-20' }), 'deadline');
    assert.equal(inferKind('Submit abstract'), 'task');
    assert.equal(inferKind('Buy stamps'), 'errand');
    assert.equal(inferKind('Schedule dentist'), 'task');
    assert.equal(inferKind(''), 'task');
    assert.equal(inferKind(null), 'task');
  });
});


// ---------------------------------------------------------------- adversarial review regressions

/** What addTask actually stores for a quick-add line (the CLI and the site both go parse → addTask). */
function saved(text) {
  const state = emptyState();
  for (const c of DEFAULT_CATEGORIES) state.cats[c.id] = normalizeCategory({ ...c }, { now: '2026-09-01T12:00:00.000Z' });
  const parsed = parseQuickAdd(text, { today: TODAY, cats: state.cats });
  const res = addTask(state, parsed, { now: '2026-10-05T13:00:00.000Z', today: TODAY, src: 'chat' });
  const w = res.writes.find((x) => x.op === 'set' && (x.col === 'tasks' || x.col === 'chores'));
  return { parsed, col: w?.col ?? null, item: w ? res.state[w.col][w.id] : null };
}

describe('ENG-1: bare cadence adjectives next to a one-off date', () => {
  test('ENG-1 weekly/daily/monthly/biweekly/<day>s in a dated title stay in the title, no chore', () => {
    check('submit weekly report by fri', { title: 'Submit weekly report', due: '2026-10-09', recurring: null, kind: 'deadline' });
    check('send weekly lab update - fri', { title: 'Send weekly lab update', plan: '2026-10-09', recurring: null });
    check('daily standup notes - tomorrow', { title: 'Daily standup notes', plan: '2026-10-06', recurring: null });
    check('monthly budget review by 10/31', { title: 'Monthly budget review', due: '2026-10-31', recurring: null });
    check('biweekly timesheet due fri', { title: 'Biweekly timesheet', due: '2026-10-09', recurring: null });
    check('grade weekly quizzes - thu', { title: 'Grade weekly quizzes', plan: '2026-10-08', recurring: null });
    check('email tom about the daily diary study - wed', { title: 'Email Tom about the daily diary study', plan: '2026-10-07', recurring: null });
    const r = check('email mondays group - fri', { plan: '2026-10-09', recurring: null });
    assert.match(r.title, /^Email mondays group$/i);
    assert.ok(!r.tokens.some((t) => t.type === 'recurring'));
  });
  test('ENG-1 a cadence with no date is still a chore; strong forms stay chores even with a date', () => {
    check('laundry weekly', { recurring: { every: 7, perDay: 1 }, title: 'Laundry' });
    check('walk ziggy daily', { recurring: { every: 1, perDay: 1 } });
    check('laundry mondays', { recurring: { every: 7, perDay: 1 }, title: 'Laundry' });
    check('laundry every week - sat', { recurring: { every: 7, perDay: 1 }, title: 'Laundry' });
    // a strong phrase is not blocked by an earlier weak word with another cadence
    check('daily standup notes every week', { recurring: { every: 7, perDay: 1 }, title: 'Daily standup notes' });
  });
  test('ENG-1 end to end: addTask stores a dated task, not a chore that drops the date', () => {
    const a = saved('submit weekly report by fri');
    assert.equal(a.col, 'tasks');
    assert.equal(a.item.title, 'Submit weekly report');
    assert.equal(a.item.due, '2026-10-09');
    const b = saved('send weekly lab update - fri');
    assert.equal(b.col, 'tasks');
    assert.equal(b.item.plan, '2026-10-09');
  });
});

describe('ENG-2: a date followed by a connector + time', () => {
  test('ENG-2 "tomorrow by 5pm" keeps the date and drops the connector', () => {
    check('email mike tomorrow by 5pm', { title: 'Email Mike', due: '2026-10-06', plan: null, time: '17:00' });
    check('submit form friday by noon', { title: 'Submit form', due: '2026-10-09', time: '12:00' });
    check('finish draft tomorrow by 3pm', { title: 'Finish draft', due: '2026-10-06', time: '15:00' });
    check('email mike tomorrow before 10am', { title: 'Email Mike', due: '2026-10-06', time: '10:00' });
    check('email mike - tomorrow by 5pm', { title: 'Email Mike', due: '2026-10-06', time: '17:00' });
    check('hw due at 5pm tomorrow', { title: 'Hw', due: '2026-10-06', time: '17:00' });
  });
  test('ENG-2 around/after/~ keep the date as a do-day', () => {
    check('call mike tomorrow around 3pm', { title: 'Call Mike', plan: '2026-10-06', due: null, time: '15:00' });
    check('pick up meds tomorrow after 5pm', { title: 'Pick up meds', plan: '2026-10-06', due: null, time: '17:00' });
    check('call mom tomorrow ~3pm', { title: 'Call Mom', plan: '2026-10-06', time: '15:00' });
  });
  test('ENG-2 unchanged neighbours: "by 5pm tomorrow", "at 3pm", phrasal "stop by"', () => {
    check('email mike by 5pm tomorrow', { title: 'Email Mike', due: '2026-10-06', time: '17:00' });
    check('call mike friday at 3pm', { title: 'Call Mike', plan: '2026-10-09', due: null, time: '15:00' });
    check('stop by at 3pm', { due: null, time: '15:00' });
  });
});

describe('ENG-5: "eod" before a date', () => {
  test('ENG-5 "by eod fri" is due Friday with no stray plan', () => {
    check('send budget to tom by eod fri', { title: 'Send budget to tom', due: '2026-10-09', plan: null });
    check('send budget by eod friday', { due: '2026-10-09', plan: null });
    check('send budget by end of day fri', { title: 'Send budget', due: '2026-10-09', plan: null });
    check('send budget by end of the day on friday', { title: 'Send budget', due: '2026-10-09', plan: null });
  });
  test('ENG-5 "fri by eod" / "by fri eod" are due Friday too; "by eod" alone is today', () => {
    check('send budget fri by eod', { title: 'Send budget', due: '2026-10-09', plan: null });
    check('send budget by fri eod', { title: 'Send budget', due: '2026-10-09', plan: null });
    check('send budget by fri end of day', { title: 'Send budget', due: '2026-10-09', plan: null });
    check('send budget by eod', { title: 'Send budget', due: '2026-10-05', plan: null });
    check('send budget by eod and email tom', { due: '2026-10-05', title: 'Send budget and email Tom' });
  });
});

describe('ENG-6: titles about an exam/quiz are not deadlines', () => {
  test('ENG-6 emailing/asking/grading about an exam sets a do-day, not a due date', () => {
    check('email prof about exam - tomorrow', { plan: '2026-10-06', due: null, kind: 'email' });
    check('ask tom about the quiz - fri', { plan: '2026-10-09', due: null, kind: 'task' });
    check('grade quizzes - tom', { plan: '2026-10-06', due: null });
    check('proctor exam wed', { plan: '2026-10-07', due: null });
    check('reply to jason about submission - fri', { plan: '2026-10-09', due: null });
  });
  test('ENG-6 the deliverable itself is still a deadline', () => {
    check('multivar exam - oct 20', { due: '2026-10-20', plan: null, kind: 'deadline' });
    check('quiz 3 - wed', { due: '2026-10-07', plan: null });
    check('submit abstract about memory - fri', { due: '2026-10-09', plan: null });
    check('study for multivar exam - tomorrow', { plan: '2026-10-06', due: null });
  });
  test('ENG-6 inferKind: an explicit due date on a question about a quiz is not kind deadline', () => {
    assert.equal(inferKind('Ask Tom about the quiz', { due: '2026-10-09' }), 'task');
    assert.equal(inferKind('Grade quizzes', { due: '2026-10-09' }), 'task');
    assert.equal(inferKind('Multivar exam', { due: '2026-10-20' }), 'deadline');
    assert.equal(inferKind('Quiz 3', { due: '2026-10-07' }), 'deadline');
  });
});

describe('ENG-7: trailing "low" after a date', () => {
  test('ENG-7 "sat low" / "tomorrow low" keep the date and set low priority', () => {
    check('laundry - sat low', { title: 'Laundry', plan: '2026-10-10', prio: 0 });
    check('email mike tomorrow low', { title: 'Email Mike', plan: '2026-10-06', prio: 0 });
    check('laundry sat low', { title: 'Laundry', plan: '2026-10-10', prio: 0 });
    check('laundry by sat low', { title: 'Laundry', due: '2026-10-10', prio: 0 });
    check('laundry low - sat', { title: 'Laundry', plan: '2026-10-10', prio: 0 });
  });
});

describe('ENG-8: "<verb> for <date>"', () => {
  test('ENG-8 a one-word title keeps "for <date>" as its object', () => {
    check('prep for thursday', { title: 'Prep for thursday', plan: null, due: null });
    check('plan for next week', { title: 'Plan for next week', plan: null, due: null });
  });
  test('ENG-8 longer titles and "on <date>" still take the date', () => {
    check('buy cake for friday', { title: 'Buy cake', plan: '2026-10-09' });
    check('laundry sat', { title: 'Laundry', plan: '2026-10-10' });
    check('call mom on sat', { title: 'Call Mom', plan: '2026-10-10' });
    check('for thursday', { title: '', plan: '2026-10-08' });
  });
});

describe('ENG-9: honorific + stop word', () => {
  test('ENG-9 the word after Dr/Prof is capitalized only when it is a name', () => {
    check('email prof about exam', { title: 'Email Prof about exam' });
    check('email dr re: labs', { title: 'Email Dr re: labs' });
    check('email dr smith', { title: 'Email Dr Smith' });
    check('call dr. kim tomorrow at 10:30am', { title: 'Call Dr. Kim' });
  });
});

describe('ENG-10: competing aliases', () => {
  test('ENG-10 an acronym or "Label:" prefix beats a longer generic alias', () => {
    check('OCD pres: write main script - thu', { cat: 'cbt', catConfidence: 0.9, plan: '2026-10-08' });
    check('ocd pres: write main script', { cat: 'cbt' });
    assert.equal(inferCategory('ABCD review meeting', cats).id, 'manuscripts');
    assert.equal(inferCategory('Prepare for DTI meeting', cats).id, 'dti');
    assert.equal(inferCategory('Send out DTI email', cats).id, 'dti');
    assert.equal(inferCategory('RSA manuscript update', cats).id, 'rsa');
  });
  test('ENG-10 a leading action verb does not compete with the topic', () => {
    assert.deepEqual(inferCategory('email lily', cats), { id: 'undergrad', confidence: 0.9, reason: 'alias "lily"' });
    assert.equal(inferCategory('text ronan and email chloe', cats).confidence, 0.9);
    assert.equal(inferCategory('remind me to email the committee', cats).id, 'gradroles');
    assert.equal(inferCategory('email jason about the manuscript', cats).confidence, 0.9);
  });
  test('ENG-10 a close call between two categories is low confidence and names both', () => {
    const r = inferCategory('fix app form', cats);
    assert.equal(r.confidence, 0.45);
    assert.match(r.reason, /alias "form".*Dev projects \("app"\)/);
    const p = P('script for ocd slides');
    assert.ok(p.catConfidence < 0.5, JSON.stringify(p));
    assert.match(p.catReason, /also matches/);
  });
});

describe('ENG-11: evening deadlines', () => {
  test('ENG-11 "11:59" and a bare hour with tonight/evening/night are pm', () => {
    check('hw due tonight at 11:59', { due: '2026-10-05', time: '23:59' });
    check('multivar hw due tonight at 11:59', { due: '2026-10-05', time: '23:59' });
    check('turn in hw by 11:59 tonight', { due: '2026-10-05', time: '23:59' });
    check('hw due fri 11:59', { due: '2026-10-09', time: '23:59' });
    check('call mike tonight at 9:30', { plan: '2026-10-05', time: '21:30' });
    check('night walk at 9', { time: '21:00' });
  });
  test('ENG-11 explicit am, 24h clocks and mornings are untouched', () => {
    check('hw due tonight at 11:59am', { time: '11:59' });
    check('call dr. kim tomorrow at 10:30am', { time: '10:30' });
    check('standup tomorrow at 9:30', { time: '09:30' });
    check('flight tonight at 08:15', { time: '08:15' });
  });
});

test('ENG-10 follow-up: a personal "visit" is not filed as clinical work (the psc alias is "home visit")', () => {
  assert.notEqual(P('visit grandma sunday').cat, 'psc');
  assert.equal(P('visit grandma sunday').plan, '2026-10-11');
  assert.equal(P('clinical visit confirmations').cat, 'psc');
  assert.ok(!DEFAULT_CATEGORIES.find((c) => c.id === 'psc').aliases.includes('visit'));
});

describe('ENG-13: a time with no date', () => {
  test('ENG-13 lands on today instead of the backlog', () => {
    const r = check('lab meeting 2pm', { plan: '2026-10-05', due: null, time: '14:00', kind: 'meeting' });
    assert.ok(r.tokens.some((t) => t.type === 'plan' && t.value === '2026-10-05'));
    check('text ronan 2pm', { plan: '2026-10-05', time: '14:00' });
    check('1:1 with teij at 3', { plan: '2026-10-05', time: '15:00' });
  });
  test('ENG-13 "by 5pm" with no date is due today; recurring chores get no date', () => {
    check('submit form by 5pm', { due: '2026-10-05', plan: null, time: '17:00' });
    check('every monday standup at 10am', { plan: null, due: null, recurring: { every: 7, perDay: 1 } });
    check('email mike', { plan: null, due: null, time: null });
  });
  test('ENG-13 with `now` known, a bare time already past today rolls to tomorrow', () => {
    const at9pm = '2026-10-06T01:00:00.000Z'; // Mon 10/5 9:00pm in New York
    assert.equal(P('lab meeting 2pm', { now: at9pm }).plan, '2026-10-06');
    assert.equal(P('submit form by 5pm', { now: at9pm }).due, '2026-10-06');
    assert.equal(P('call mom at 10pm', { now: at9pm }).plan, '2026-10-05', 'still ahead today');
    const at8am = '2026-10-05T12:00:00.000Z'; // 8:00am
    assert.equal(P('lab meeting 2pm', { now: at8am }).plan, '2026-10-05');
    // an explicit day is never moved; a `now` on another day (or none) changes nothing
    assert.equal(P('lab meeting 2pm today', { now: at9pm }).plan, '2026-10-05');
    assert.equal(P('lab meeting 2pm', { now: '2026-10-08T23:00:00.000Z' }).plan, '2026-10-05');
    assert.equal(P('lab meeting 2pm', { now: 'garbage' }).plan, '2026-10-05');
  });
});

describe('UI-11: chore category in the preview', () => {
  test('UI-11 an uncategorized recurring line previews as Home, the way it is saved', () => {
    for (const text of ['water the cactus every 3 days', 'stretch every day']) {
      const { parsed, col, item } = saved(text);
      assert.equal(parsed.cat, 'home', text);
      assert.equal(parsed.catReason, 'chores default to Home');
      assert.ok(parsed.catConfidence > 0 && parsed.catConfidence < 0.5);
      assert.equal(col, 'chores');
      assert.equal(item.cat, parsed.cat, `${text}: preview ${parsed.cat}, saved ${item.cat}`);
    }
  });
  test('UI-11 tags, aliases and non-recurring tasks are unaffected; no Home category → inbox', () => {
    check('#rsa backup every week', { cat: 'rsa', catReason: 'tagged' });
    check('walk ziggy 2x a day', { cat: 'ziggy' });
    check('water the cactus', { cat: 'inbox', recurring: null });
    const noHome = cats.filter((c) => c.id !== 'home');
    const r = parseQuickAdd('water the cactus every 3 days', { today: TODAY, cats: noHome });
    assert.equal(r.cat, 'inbox');
  });
});
