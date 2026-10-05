// Shared, realistic fixture for test/schedule|views|stats.test.js.
// "Today" is Mon 2026-10-05 in America/New_York (EDT, UTC-4).
import { emptyState, normalizeTask, normalizeProject, normalizeChore, normalizeSettings } from '../../src/engine/model.js';

export const TODAY = '2026-10-05';
export const NOW = '2026-10-05T14:00:00.000Z'; // Mon 10:00 ET
const CREATED = '2026-09-20T12:00:00.000Z';

/** Build a normalized state from bare task/chore/project partials. */
export function makeState({ tasks = [], chores = [], projects = [], sessions = [], settings = {} } = {}) {
  const s = emptyState();
  s.settings = normalizeSettings({ prefBlock: 30, ...settings });
  const ctx = { now: NOW };
  for (const t of tasks) {
    const n = normalizeTask({ created: CREATED, ...t }, ctx);
    s.tasks[n.id] = n;
  }
  for (const c of chores) {
    const n = normalizeChore(c, ctx);
    s.chores[n.id] = n;
  }
  for (const p of projects) {
    const n = normalizeProject(p, ctx);
    s.projects[n.id] = n;
  }
  for (const x of sessions) s.sessions[x.id] = { ...x };
  return s;
}

export function fixture() {
  return makeState({
    settings: { offDays: ['2026-10-10'] }, // Sat: a wedding
    tasks: [
      // Multi-day big task, not yet blocked out.
      { id: 't_big', title: 'RSA manuscript draft', cat: 'rsa', kind: 'writing', est: 900, due: '2026-10-21', prio: 2, project: 'p_rsa' },
      // Overdue deadline with an estimate.
      { id: 't_irb', title: 'Submit IRB amendment', cat: 'admin', kind: 'deadline', est: 60, due: '2026-10-02', prio: 2 },
      // Stale item Danny must triage.
      { id: 't_triage', title: 'ABCD review meeting', cat: 'manuscripts', due: '2026-09-28', triage: true },
      // Meeting today with a time.
      { id: 't_lab', title: 'Lab meeting', cat: 'meetings', kind: 'meeting', plan: '2026-10-05', time: '14:00', est: 60 },
      // Appointment Wednesday.
      { id: 't_dentist', title: 'Dentist', cat: 'health', kind: 'appt', plan: '2026-10-07', time: '09:30', est: 90 },
      // Small planned to-do today.
      { id: 't_email', title: 'Email Mike', cat: 'admin', kind: 'email', plan: '2026-10-05', est: 10 },
      // Due today, partly done.
      { id: 't_hw', title: 'Multivariate HW 3', cat: 'multivar', due: '2026-10-05', est: 90, spent: 30 },
      // Planned last Friday, rolled over.
      { id: 't_reimb', title: 'Reimbursement form', cat: 'admin', plan: '2026-10-02', est: 15 },
      // Backlog.
      { id: 't_closet', title: 'Clean closet', cat: 'home', created: '2026-09-25T12:00:00.000Z' },
      { id: 't_donate', title: 'Donate old books', cat: 'home', prio: 0, created: '2026-09-26T12:00:00.000Z' },
      // Deadline with no estimate (title says poster).
      { id: 't_poster', title: 'SDN poster', cat: 'sdn', due: '2026-10-15' },
      // Completed: across the tz boundary (02:00Z on 10/6 is 22:00 ET on 10/5).
      { id: 't_notes', title: 'Session notes', cat: 'psc', status: 'done', doneAt: '2026-10-06T02:00:00.000Z' },
      // 03:30Z on 10/5 is 23:30 ET on 10/4.
      { id: 't_read', title: 'Read chapter 4', cat: 'cbt', kind: 'reading', status: 'done', doneAt: '2026-10-05T03:30:00.000Z' },
      { id: 't_abstract', title: 'Submit SfN abstract', cat: 'sdn', status: 'done', doneAt: '2026-10-03T15:00:00.000Z', win: true },
      { id: 't_figs', title: 'RSA figures', cat: 'rsa', status: 'done', doneAt: '2026-09-29T18:00:00.000Z', project: 'p_rsa' },
      // Dropped (inactive everywhere).
      { id: 't_dropped', title: 'Old idea', cat: 'inbox', status: 'dropped', plan: '2026-10-05', est: 30 },
      // Work with done, manual and auto blocks.
      {
        id: 't_predis', title: 'Predis lit review', cat: 'predis', kind: 'reading', est: 300, spent: 60, due: '2026-10-12', project: 'p_predis',
        blocks: [
          { id: 'b_p_done', d: '2026-10-02', m: 60, done: true, auto: true },
          { id: 'b_p_man', d: '2026-10-06', m: 90, done: false, auto: false },
          { id: 'b_p_auto', d: '2026-10-07', m: 60, done: false, auto: true },
        ],
      },
      // Fully blocked analysis with a block today.
      {
        id: 't_glm', title: 'Run GLM analyses', cat: 'sdn', kind: 'analysis', est: 120, due: '2026-10-09',
        blocks: [
          { id: 'b_glm1', d: '2026-10-05', m: 60, done: false, auto: true },
          { id: 'b_glm2', d: '2026-10-06', m: 60, done: false, auto: true },
        ],
      },
      // Thursday: a due pin, a meeting with a time and two plan chips.
      { id: 't_quiz', title: 'CBT quiz', cat: 'cbt', due: '2026-10-08', est: 30 },
      { id: 't_mentee', title: 'Mentee check-in', cat: 'undergrad', kind: 'meeting', plan: '2026-10-08', time: '11:00' },
      { id: 't_tutorial', title: 'RA tutorial prep', cat: 'undergrad', plan: '2026-10-08', est: 120, prio: 3 },
      { id: 't_grocery', title: 'Groceries', cat: 'home', kind: 'errand', plan: '2026-10-08', est: 45 },
    ],
    chores: [
      { id: 'c_ziggy', title: 'Walk Ziggy', cat: 'ziggy', every: 1, perDay: 2,
        log: ['2026-10-03', '2026-10-03', '2026-10-04', '2026-10-04', '2026-10-05'], last: '2026-10-05' },
      { id: 'c_laundry', title: 'Laundry', cat: 'home', every: 7, log: ['2026-09-30'], last: '2026-09-30' },
      { id: 'c_trash', title: 'Take out trash', cat: 'home', every: 7, log: ['2026-09-20'], last: '2026-09-20' },
      { id: 'c_plants', title: 'Water plants', cat: 'home', every: 3, log: [] },
      { id: 'c_off', title: 'Retired chore', cat: 'home', every: 1, active: false, log: [] },
    ],
    projects: [
      { id: 'p_rsa', name: 'RSA manuscript', cat: 'rsa', status: 'active', due: '2026-12-01', order: 0,
        milestones: [
          { id: 'm1', t: 'Methods', done: true, doneAt: '2026-09-20T15:00:00.000Z' },
          { id: 'm2', t: 'Results', due: '2026-10-21' },
          { id: 'm3', t: 'Discussion' },
        ] },
      { id: 'p_predis', name: 'Predissertation', cat: 'predis', status: 'active', order: 1,
        milestones: [
          { id: 'm1', t: 'Proposal draft', due: '2026-11-15' },
          { id: 'm2', t: 'Lit review', due: '2026-10-12' },
        ] },
      { id: 'p_dti', name: 'DTI pipeline', cat: 'dti', status: 'paused', milestones: [] },
      { id: 'p_old', name: 'Old course', cat: 'cbt', status: 'done', milestones: [{ id: 'm1', t: 'Final', done: true, doneAt: '2026-05-01T12:00:00.000Z' }] },
    ],
    sessions: [
      { id: 's_today', ref: 'chore:c_ziggy', title: 'Walk Ziggy', cat: 'ziggy', start: '2026-10-05T12:00:00.000Z', end: '2026-10-05T12:15:00.000Z', min: 15, d: '2026-10-05' },
      { id: 's_1', ref: 'free', title: 'Inbox zero', cat: 'admin', start: '2026-10-04T15:00:00.000Z', end: '2026-10-04T15:25:00.000Z', min: 25, d: '2026-10-04' },
      { id: 's_2', ref: 'free', title: 'Desk reset', cat: 'home', start: '2026-10-01T15:00:00.000Z', end: '2026-10-01T15:12:00.000Z', min: 12, d: '2026-10-01' },
      // An older 5-day run, 9/14–9/18 (no `d` on one, no `min` on another: derived).
      { id: 's_o1', ref: 'free', title: 'x', cat: 'admin', start: '2026-09-14T15:00:00.000Z', end: '2026-09-14T15:10:00.000Z', min: 10, d: '2026-09-14' },
      { id: 's_o2', ref: 'free', title: 'x', cat: 'admin', start: '2026-09-15T15:00:00.000Z', end: '2026-09-15T15:10:00.000Z', min: 10, d: '2026-09-15' },
      { id: 's_o3', ref: 'free', title: 'x', cat: 'admin', start: '2026-09-16T15:00:00.000Z', end: '2026-09-16T15:10:00.000Z', min: 10 },
      { id: 's_o4', ref: 'free', title: 'x', cat: 'admin', start: '2026-09-17T15:00:00.000Z', end: '2026-09-17T15:20:00.000Z', d: '2026-09-17' },
      { id: 's_o5', ref: 'free', title: 'x', cat: 'admin', start: '2026-09-18T15:00:00.000Z', end: '2026-09-18T15:10:00.000Z', min: 10, d: '2026-09-18' },
    ],
  });
}

/** Recursively freeze, to prove functions never mutate their inputs. */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Apply allocate() updates to a state (test helper; mirrors ops.applyAllocation). */
export function withBlocks(state, updates) {
  const tasks = { ...state.tasks };
  for (const [id, blocks] of Object.entries(updates)) tasks[id] = { ...tasks[id], blocks };
  return { ...state, tasks };
}
