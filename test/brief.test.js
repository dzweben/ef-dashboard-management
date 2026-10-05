import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, normalizeCategory, normalizeChore, normalizeTask } from '../src/engine/model.js';
import { DEFAULT_CATEGORIES } from '../src/engine/defaults.js';
import { OPS } from '../src/engine/ops.js';
import { buildBrief, changesSince, commitMessage, missingCategoryCheck } from '../src/engine/brief.js';
import { fixture, makeState, deepFreeze, TODAY, NOW } from './fixtures/engine-fixture.js';

const at = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();

function withCats(s) {
  for (const c of DEFAULT_CATEGORIES) s.cats[c.id] = normalizeCategory({ ...c, created: '2026-09-01T12:00:00.000Z' });
  return s;
}
const base = () => deepFreeze(withCats(fixture()));

// ---------------------------------------------------------------- buildBrief

test('buildBrief: punchy headline + focus on the fixture', () => {
  const b = buildBrief(base(), { today: TODAY, now: NOW });
  assert.equal(b.headline, '6 things today (1 overdue). Start with: Submit IRB amendment (1h).');
  assert.deepEqual(b.focus, ['t_irb', 't_hw', 't_email']);
  assert.deepEqual(Object.keys(b), ['headline', 'lines', 'asks', 'focus', 'text']);
});

test('buildBrief: lines cover due today, overdue, meetings, deadlines, chores, tomorrow', () => {
  const b = buildBrief(base(), { today: TODAY, now: NOW });
  const line = (prefix) => b.lines.find((l) => l.startsWith(prefix));
  assert.equal(line('DUE TODAY'), 'DUE TODAY // Multivariate HW 3 (1h left)');
  assert.equal(line('OVERDUE'), 'OVERDUE // Submit IRB amendment (3d late)');
  assert.equal(line('MEETINGS'), 'MEETINGS // 2pm Lab meeting');
  const incoming = line('INCOMING');
  assert.match(incoming, /Predis lit review Mon 10\/12 \(7d\): 4h left, 2h 30m booked, TIGHT/);
  assert.match(incoming, /CBT quiz Thu 10\/8 \(3d\): 30m left, 0m booked, UNPLANNED/);
  assert.ok(!incoming.includes('RSA manuscript draft'), 'due in 16d is outside the 7-day window');
  const chores = line('CHORES');
  assert.match(chores, /Take out trash/);
  assert.match(chores, /Walk Ziggy 1\/2/);
  assert.match(chores, /Just 5 minutes on Take out trash \(15d since last\)\./);
  assert.ok(!chores.includes('Retired chore'));
  assert.match(line('TOMORROW'), /^TOMORROW \/\/ Tue 10\/6 \[2h 30m\/4h\]: .*Predis lit review 1h 30m/);
  assert.match(line('DONE'), /^DONE \/\/ 1 today/);
});

test('buildBrief: asks lead with triage, then estimates and warnings; max 4', () => {
  const b = buildBrief(base(), { today: TODAY, now: NOW });
  assert.ok(b.asks.length <= 4);
  assert.equal(b.asks[0], "Did 'ABCD review meeting' happen?");
  assert.ok(b.asks.includes("How long will 'SDN poster' take?"));
  assert.ok(b.asks.some((q) => /Auto-plan it\?|Cut scope|Push something\?|late\./.test(q)));
});

test('buildBrief: text is the plain version of everything', () => {
  const b = buildBrief(base(), { today: TODAY, now: NOW });
  assert.ok(b.text.startsWith('EF//BRIEF Mon 10/5\n> '));
  assert.ok(b.text.includes(b.headline));
  for (const l of b.lines) assert.ok(b.text.includes(l));
  for (const q of b.asks) assert.ok(b.text.includes(`?? ${q}`));
  assert.match(b.text, /FOCUS \/\/ 1\. Submit IRB amendment \(1h\) {2}2\. Multivariate HW 3 \(1h\) {2}3\. Email Mike \(10m\)/);
});

test('buildBrief: empty state → clear board, no throw', () => {
  const b = buildBrief(deepFreeze(emptyState()), { today: TODAY, now: NOW });
  assert.match(b.headline, /^Clear board\./);
  assert.deepEqual(b.focus, []);
  assert.deepEqual(b.asks, []);
  assert.equal(typeof b.text, 'string');
});

test('buildBrief: clear board with a backlog asks to pick from it', () => {
  const s = deepFreeze(makeState({ tasks: [{ id: 't_a', title: 'Clean closet', cat: 'home', est: 30 }] }));
  const b = buildBrief(s, { today: TODAY, now: NOW });
  assert.equal(b.headline, 'Clear board. Pick something from the backlog?');
  assert.ok(b.lines.includes('BACKLOG // Clean closet (30m)'));
});

test('buildBrief: clear board but stale items → asks for a verdict', () => {
  const s = deepFreeze(makeState({ tasks: [{ id: 't_a', title: 'Old meeting', due: '2026-09-28', triage: true }] }));
  const b = buildBrief(s, { today: TODAY, now: NOW });
  assert.equal(b.headline, 'Clear board, but 1 stale item needs a verdict.');
  assert.deepEqual(b.asks, ["Did 'Old meeting' happen?"]);
});

test('buildBrief: only meetings today → "Next up"', () => {
  const s = deepFreeze(makeState({ tasks: [{ id: 't_m', title: 'Lab meeting', kind: 'meeting', plan: TODAY, time: '14:00' }] }));
  assert.equal(buildBrief(s, { today: TODAY }).headline, '1 thing today. Next up: Lab meeting at 2pm.');
});

test('buildBrief: many stale items still leaves room for other asks; never more than 4', () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `t_${i}`, title: `Stale ${i}`, due: '2026-09-20', triage: true }));
  tasks.push({ id: 't_p', title: 'Conference poster', due: '2026-10-12' });
  const b = buildBrief(deepFreeze(makeState({ tasks })), { today: TODAY });
  assert.equal(b.asks.length, 4);
  assert.ok(b.asks.includes("How long will 'Conference poster' take?"));
  assert.equal(b.asks.filter((q) => q.startsWith('Did ')).length, 3);
});

test('buildBrief: tolerates odd tasks and chores', () => {
  const s = emptyState();
  s.tasks = { t_x: { id: 't_x' }, t_y: { id: 't_y', title: 'Half', status: 'todo', plan: TODAY, est: 'lots', blocks: 'no' }, junk: null };
  s.chores = { c_x: { id: 'c_x', title: 'Odd chore', every: 'sometimes' } };
  s.activity = { a1: { id: 'a1' } };
  assert.doesNotThrow(() => buildBrief(s, { today: TODAY, now: NOW }));
  assert.doesNotThrow(() => buildBrief(s, {}));
  assert.doesNotThrow(() => buildBrief({}, undefined));
});

test('buildBrief output can be stored with setBrief', () => {
  const s = base();
  const b = buildBrief(s, { today: TODAY, now: NOW });
  const res = OPS.setBrief(s, b, { now: NOW, today: TODAY, src: 'chat' });
  assert.deepEqual(res.state.brief, { at: NOW, headline: b.headline, lines: b.lines, asks: b.asks, focus: b.focus });
});

// ---------------------------------------------------------------- changesSince

function history() {
  let s = base();
  const step = (op, args, min, src = 'dash') => {
    s = OPS[op](s, args, { now: at(min), today: TODAY, src }).state;
  };
  step('completeTask', { id: 't_email' }, 1);
  step('completeTask', { id: 't_hw' }, 2);
  step('reopenTask', { id: 't_hw' }, 3); // oops, un-checked
  step('moveTask', { id: 't_reimb', to: '2026-10-06' }, 4);
  step('moveTask', { id: 't_reimb', to: '2026-10-08' }, 5); // collapses with the first move
  step('addTask', { title: 'Buy stamps', cat: 'admin' }, 6);
  step('dropTask', { id: 't_donate' }, 7);
  step('choreDone', { id: 'c_laundry' }, 8);
  step('clockIn', { ref: 'chore:c_trash' }, 9);
  step('clockOut', {}, 15); // clock + chore
  step('completeTask', { id: 't_quiz' }, 16, 'chat'); // Claude's own edit: not a website change
  step('editTask', { id: 't_big', patch: { est: 960 } }, 17);
  return s;
}

test('changesSince: website activity after `since`, oldest first, grouped', () => {
  const s = history();
  const ch = changesSince(s, NOW);
  assert.ok(ch.entries.every((a) => a.src === 'dash'));
  assert.ok(ch.entries.every((a, i, xs) => i === 0 || xs[i - 1].at <= a.at));
  assert.equal(ch.entries[0].type, 'done');
  assert.deepEqual(ch.done, ['Email Mike']); // HW 3 was un-checked again
  assert.deepEqual(ch.added, ['Buy stamps']);
  assert.deepEqual(ch.moved, [{ title: 'Reimbursement form', from: '2026-10-02', to: '2026-10-08' }]);
  assert.deepEqual(ch.dropped, ['Donate old books']);
  assert.deepEqual(ch.chores, ['Laundry', 'Take out trash']);
  assert.deepEqual(ch.clock, ['Take out trash']);
  assert.deepEqual(ch.other, ['edit: RSA manuscript draft (est)']);
  assert.ok(!ch.done.includes('CBT quiz'));
});

test('changesSince: the since cutoff is exclusive; null means everything', () => {
  const s = history();
  const late = changesSince(s, at(8));
  assert.deepEqual(late.chores, ['Take out trash']);
  assert.deepEqual(late.done, []);
  assert.equal(changesSince(s, null).entries.length, changesSince(s, '2000-01-01T00:00:00.000Z').entries.length);
  assert.deepEqual(changesSince(emptyState(), NOW).entries, []);
  assert.doesNotThrow(() => changesSince({ activity: { x: null, y: { id: 'y', at: 'bad', src: 'dash' } } }, 'garbage'));
});

// ---------------------------------------------------------------- missingCategoryCheck

test('missingCategoryCheck: asks about empty always-present areas, max 2', () => {
  const s = withCats(makeState({
    tasks: [
      { id: 't1', title: 'Manuscript revisions', cat: 'manuscripts' },
      { id: 't2', title: 'Mentee check-in', cat: 'undergrad' },
      { id: 't3', title: 'Committee email', cat: 'gradroles' },
    ],
    chores: [{ id: 'c_z', title: 'Walk Ziggy', cat: 'ziggy', every: 1, perDay: 2 }],
  }));
  const qs = missingCategoryCheck(deepFreeze(s), TODAY);
  assert.ok(qs.length <= 2 && qs.length > 0);
  for (const q of qs) {
    assert.ok(!/Manuscripts|Undergrad|Grad roles|Ziggy/.test(q), q);
  }
});

test('missingCategoryCheck: rotates by date and is deterministic per day', () => {
  const s = deepFreeze(withCats(makeState({})));
  const day1 = missingCategoryCheck(s, TODAY);
  assert.deepEqual(missingCategoryCheck(s, TODAY), day1);
  const day2 = missingCategoryCheck(s, '2026-10-06');
  assert.equal(day1.length, 2);
  assert.notDeepEqual(day2, day1);
  assert.ok(day2.every((q) => !day1.includes(q)), 'consecutive days ask different questions');
  const all = new Set();
  for (let i = 0; i < 14; i++) for (const q of missingCategoryCheck(s, `2026-10-${String(5 + i).padStart(2, '0')}`)) all.add(q);
  assert.ok(all.has('Anything coming up for coursework?'));
  assert.ok(all.has('Anything coming up for Home?'));
});

test('missingCategoryCheck: coursework counts as one area; any course with work covers it', () => {
  const s = deepFreeze(withCats(makeState({ tasks: [{ id: 't1', title: 'HW', cat: 'multivar' }] })));
  for (let i = 0; i < 14; i++) {
    for (const q of missingCategoryCheck(s, `2026-10-${String(5 + i).padStart(2, '0')}`)) assert.ok(!q.includes('coursework'), q);
  }
});

test('missingCategoryCheck: stale non-area categories get a "still active?" question', () => {
  const s = makeState({});
  const old = '2026-08-01T12:00:00.000Z';
  s.cats.dti = normalizeCategory({ id: 'dti', name: 'DTI', group: 'research', created: old });
  s.cats.fresh = normalizeCategory({ id: 'fresh', name: 'Fresh', group: 'research', created: '2026-10-01T12:00:00.000Z' });
  s.cats.busy = normalizeCategory({ id: 'busy', name: 'Busy', group: 'research', created: old });
  s.cats.gone = normalizeCategory({ id: 'gone', name: 'Gone', group: 'research', created: old, archived: true });
  s.tasks.t1 = normalizeTask({ id: 't1', title: 'x', cat: 'busy', status: 'done', doneAt: '2026-10-01T12:00:00.000Z', created: old }, { now: old });
  s.chores.c1 = normalizeChore({ id: 'c1', title: 'y', cat: 'dti', active: false, created: old, updated: old }, { now: old });
  assert.deepEqual(missingCategoryCheck(deepFreeze(s), TODAY), ['DTI: nothing open and quiet for 3+ weeks. Still active, or archive it?']);
});

test('missingCategoryCheck: empty or odd state → []', () => {
  assert.deepEqual(missingCategoryCheck(emptyState(), TODAY), []);
  assert.deepEqual(missingCategoryCheck({}, TODAY), []);
  assert.doesNotThrow(() => missingCategoryCheck(null, 'nope'));
});

// ---------------------------------------------------------------- commitMessage

const A = (type, title, extra = {}) => ({ id: `a_${title}`, at: NOW, src: 'dash', type, ref: null, title, from: null, to: null, ...extra });

test('commitMessage: subject + one bullet per entry', () => {
  const msg = commitMessage([A('done', 'Email Mike'), A('move', 'RSA intro', { from: '2026-10-05', to: '2026-10-08' })]);
  assert.equal(msg, 'dash: ✓ Email Mike · → RSA intro (Thu)\n\n- done: Email Mike\n- moved: RSA intro → Thu 10/8');
});

test('commitMessage: long bursts summarize as "+N more" within 72 chars', () => {
  const acts = [
    A('done', 'Email Mike'),
    A('move', 'RSA intro', { to: '2026-10-08' }),
    A('chore', 'Laundry'),
    A('clock', 'Take out trash', { to: '5m' }),
    A('add', 'Buy stamps', { to: '2026-10-06' }),
  ];
  const [subject, blank, ...body] = commitMessage(acts).split('\n');
  assert.ok(Array.from(subject).length <= 72, subject);
  assert.match(subject, /^dash: ✓ Email Mike · → RSA intro \(Thu\) · .* · \+\d more$/);
  assert.equal(blank, '');
  assert.deepEqual(body, [
    '- done: Email Mike',
    '- moved: RSA intro → Thu 10/8',
    '- chore: Laundry',
    '- clock: Take out trash (5m)',
    '- added: Buy stamps (Tue 10/6)',
  ]);
});

test('commitMessage: a very long title is clipped; empty → "dash: update"; chat-only → "chat:"', () => {
  const long = commitMessage([A('done', 'x'.repeat(200)), A('done', 'y')]).split('\n')[0];
  assert.ok(Array.from(long).length <= 72, long);
  assert.match(long, /…· \+1 more$|… · \+1 more$/);
  assert.equal(commitMessage([]), 'dash: update');
  assert.equal(commitMessage(undefined), 'dash: update');
  assert.match(commitMessage([A('done', 'Email Mike', { src: 'chat' })]), /^chat: ✓ Email Mike\n/);
});

test('commitMessage works on real op activity', () => {
  const s = base();
  const r1 = OPS.completeTask(s, { id: 't_email' }, { now: NOW, today: TODAY, src: 'dash' });
  const r2 = OPS.moveTask(r1.state, { id: 't_reimb', to: '2026-10-08' }, { now: at(1), today: TODAY, src: 'dash' });
  const msg = commitMessage([...r1.activity, ...r2.activity]);
  assert.equal(msg, 'dash: ✓ Email Mike · → Reimbursement form (Thu)\n\n- done: Email Mike\n- moved: Reimbursement form → Thu 10/8');
});
