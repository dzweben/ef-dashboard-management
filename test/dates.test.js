import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDatePhrase, findDatePhrase, parseTime, parseDuration, addDays, diffDays, dowKey, fmtDay, fmtTime, fmtRelative,
} from '../src/engine/dates.js';

const TODAY = '2026-10-05'; // Monday
const D = (text) => parseDatePhrase(text, TODAY);

describe('parseDatePhrase: contract phrases', () => {
  test('relative words and weekdays', () => {
    assert.deepEqual(D('today'), { date: '2026-10-05', consumed: 'today' });
    assert.equal(D('tonight').date, '2026-10-05');
    assert.equal(D('tomorrow').date, '2026-10-06');
    assert.equal(D('tom').date, '2026-10-06');
    assert.equal(D('fri').date, '2026-10-09');
    assert.equal(D('mon').date, '2026-10-12'); // bare weekday is strictly after today
    assert.equal(D('this fri').date, '2026-10-09');
    assert.equal(D('next fri').date, '2026-10-16');
    assert.equal(D('next week').date, '2026-10-12');
    assert.equal(D('this weekend').date, '2026-10-10');
    assert.equal(D('eow').date, '2026-10-09');
    assert.equal(D('end of month').date, '2026-10-31');
    assert.equal(D('in 3 days').date, '2026-10-08');
  });
  test('numeric and month-name dates', () => {
    assert.equal(D('10/12').date, '2026-10-12');
    assert.equal(D('10/1').date, '2026-10-01'); // 4 days ago: overdue, not next year
    assert.equal(D('1/15').date, '2027-01-15');
    assert.equal(D('oct 20').date, '2026-10-20');
    assert.equal(D('october 12th').date, '2026-10-12');
    assert.equal(D('the 15th').date, '2026-10-15');
    assert.equal(D('2026-11-02').date, '2026-11-02');
    assert.equal(D('2026-02-30'), null);
  });
  test('only a phrase at the start counts; junk is null', () => {
    assert.equal(D('email mike friday'), null);
    assert.equal(D(''), null);
    assert.equal(parseDatePhrase(null, TODAY), null);
    assert.equal(parseDatePhrase('fri', 'not-a-date'), null);
  });
});

describe('parseDatePhrase: eod / end of day (ENG-5)', () => {
  test('ENG-5 eod alone is today', () => {
    assert.deepEqual(D('eod'), { date: '2026-10-05', consumed: 'eod' });
    assert.deepEqual(D('end of day'), { date: '2026-10-05', consumed: 'end of day' });
    assert.deepEqual(D('end of the day'), { date: '2026-10-05', consumed: 'end of the day' });
  });
  test('ENG-5 eod followed by a date resolves to that date and consumes both', () => {
    assert.deepEqual(D('eod fri'), { date: '2026-10-09', consumed: 'eod fri' });
    assert.deepEqual(D('EOD Friday'), { date: '2026-10-09', consumed: 'EOD Friday' });
    assert.deepEqual(D('eod tomorrow'), { date: '2026-10-06', consumed: 'eod tomorrow' });
    assert.deepEqual(D('end of day fri'), { date: '2026-10-09', consumed: 'end of day fri' });
    assert.deepEqual(D('end of the day on friday'), { date: '2026-10-09', consumed: 'end of the day on friday' });
    assert.deepEqual(D('  eod 10/12 and more'), { date: '2026-10-12', consumed: 'eod 10/12' });
  });
  test('ENG-5 eod followed by a non-date stays today', () => {
    assert.deepEqual(D('eod and email tom'), { date: '2026-10-05', consumed: 'eod' });
    assert.deepEqual(D('end of day please'), { date: '2026-10-05', consumed: 'end of day' });
  });
  test('ENG-5 whole-phrase callers (ef move, toDate) accept "eod fri"', () => {
    const phrase = 'eod fri';
    const hit = D(phrase);
    assert.equal(hit.consumed.length, phrase.length);
    assert.deepEqual(findDatePhrase('send budget eod fri', TODAY), { date: '2026-10-09', consumed: 'eod fri', index: 12 });
  });
  test('ENG-5 "end of week/month" are not swallowed by the end-of-day rule', () => {
    assert.equal(D('end of week').date, '2026-10-09');
    assert.equal(D('end of the month').date, '2026-10-31');
  });
});

describe('times, durations, formatting', () => {
  test('parseTime', () => {
    assert.equal(parseTime('3pm'), '15:00');
    assert.equal(parseTime('3:30 pm'), '15:30');
    assert.equal(parseTime('12am'), '00:00');
    assert.equal(parseTime('noon'), '12:00');
    assert.equal(parseTime('15:00'), '15:00');
    assert.equal(parseTime('25:00'), null);
  });
  test('parseDuration', () => {
    assert.equal(parseDuration('1h30'), 90);
    assert.equal(parseDuration('1.5h'), 90);
    assert.equal(parseDuration('45 min'), 45);
    assert.equal(parseDuration('nope'), null);
  });
  test('calendar math and formatting', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(diffDays('2026-10-05', '2026-10-09'), 4);
    assert.equal(dowKey(TODAY), 'mon');
    assert.equal(fmtDay('2026-10-09'), 'Fri 10/9');
    assert.equal(fmtTime('23:59'), '11:59pm');
    assert.equal(fmtRelative('2026-10-06', TODAY), 'tomorrow');
  });
});
