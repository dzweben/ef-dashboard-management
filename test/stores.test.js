import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createGitHubStore, encodeBase64Utf8, decodeBase64Utf8, READONLY_MESSAGE, TOKEN_MESSAGE, LOADING_MESSAGE, NOT_LOADED,
} from '../src/store/githubstore.js';
import { createLocalStore, LOCAL_MESSAGE } from '../src/store/localstore.js';
import { emptyState, normalizeState, serializeState, applyWrites } from '../src/engine/model.js';
import { commitMessage } from '../src/engine/brief.js';
import { OPS } from '../src/engine/ops.js';
import { parseQuickAdd } from '../src/engine/parse.js';

const NOW = '2026-10-05T14:00:00.000Z';
const OWNER = 'dzweben';
const REPO = 'ef-dashboard-management';
const PATH = 'data/state.json';
const TOKEN = 'github_pat_good';

// ------------------------------------------------------------ fixtures

function seedState() {
  const s = emptyState();
  s.tasks.t_mike = {
    id: 't_mike', title: 'Email Mike', cat: 'admin', status: 'todo', due: null, time: null, plan: '2026-10-05',
    est: 10, spent: 0, blocks: [], project: null, prio: 1, kind: 'email', notes: '', subs: [], triage: false,
    moved: 0, win: false, created: NOW, updated: NOW, doneAt: null, src: 'chat',
  };
  s.tasks.t_hw = { ...s.tasks.t_mike, id: 't_hw', title: 'Multivariate HW 3', cat: 'inbox', kind: 'task', due: '2026-10-05', plan: null, est: 90 };
  return normalizeState(s);
}

const act = (type, ref, title, at = NOW) => ({ id: `a_${type}${ref}`, at, src: 'dash', type, ref, title, from: null, to: null });

/** completeTask-shaped writes + activity. */
function doneWrites(id, title, at = NOW) {
  const a = act('done', id, title, at);
  return {
    writes: [
      { op: 'update', col: 'tasks', id, data: { status: 'done', doneAt: at, updated: at } },
      { op: 'set', col: 'activity', id: a.id, data: a },
    ],
    activity: [a],
  };
}

function addWrites(task) {
  const a = act('add', task.id, task.title);
  return {
    writes: [
      { op: 'set', col: 'tasks', id: task.id, data: { ...seedState().tasks.t_mike, ...task } },
      { op: 'set', col: 'activity', id: a.id, data: a },
    ],
    activity: [a],
  };
}

/** Like GitHub: base64 wrapped at 60 columns with "\n". Uses Buffer as an independent encoder. */
const ghBase64 = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
const fromBase64 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

/**
 * In-memory GitHub: one repo, one file, versioned by sha, ETag/304, conflicts,
 * auth failures, network failures.
 */
function fakeGitHub({ initial = seedState(), defaultBranch = 'main', publicRepo = true } = {}) {
  let n = 0;
  const gh = {
    branch: defaultBranch,
    file: null, // { text, sha }
    commits: [],
    calls: [],
    offline: false,
    validToken: TOKEN,
    readOnlyToken: false, // GET ok, PUT 403
    beforePut: null, // async (gh, body) => void  — simulate a concurrent commit landing first
    staleNext: null, // { text, sha } served once by the next contents GET (lagging replica)
    write(text) {
      n += 1;
      gh.file = { text, sha: `sha${String(n).padStart(3, '0')}${'0'.repeat(30)}` };
      return gh.file;
    },
    state() { return gh.file ? normalizeState(JSON.parse(gh.file.text)) : null; },
    /** Claude pushes a change through git (outside the store). */
    remoteEdit(fn) {
      const next = fn(gh.state());
      gh.write(serializeState(next));
    },
    count(method, re) { return gh.calls.filter((c) => c.method === method && (!re || re.test(c.url))).length; },
  };
  if (initial) gh.write(typeof initial === 'string' ? initial : serializeState(initial));

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const etagOf = (sha) => `W/"etag-${sha}"`;

  gh.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const call = { method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    gh.calls.push(call);
    await Promise.resolve();
    if (gh.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);

    if (u.host === 'raw.githubusercontent.com') {
      const want = `/${OWNER}/${REPO}/${gh.branch}/${PATH}`;
      if (u.pathname !== want || !gh.file || !publicRepo) return new Response('404: Not Found', { status: 404 });
      return new Response(gh.file.text, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    assert.equal(u.host, 'api.github.com');
    if (headers.Authorization && headers.Authorization !== `Bearer ${gh.validToken}`) {
      return json(401, { message: 'Bad credentials' });
    }
    if (!headers.Authorization && (method !== 'GET' || !publicRepo)) return json(404, { message: 'Not Found' });

    if (u.pathname === `/repos/${OWNER}/${REPO}` && method === 'GET') {
      return json(200, { full_name: `${OWNER}/${REPO}`, default_branch: gh.branch });
    }
    const contents = `/repos/${OWNER}/${REPO}/contents/${PATH}`;
    if (u.pathname !== contents) return json(404, { message: 'Not Found' });

    if (method === 'GET') {
      if (u.searchParams.get('ref') !== gh.branch) return json(404, { message: 'No commit found for the ref' });
      let file = gh.file;
      if (gh.staleNext) { file = gh.staleNext; gh.staleNext = null; }
      if (!file) return json(404, { message: 'Not Found' });
      const tag = etagOf(file.sha);
      if (headers['If-None-Match'] === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      return json(200, {
        type: 'file', encoding: 'base64', path: PATH, sha: file.sha,
        size: Buffer.byteLength(file.text), content: ghBase64(file.text),
      }, { etag: tag });
    }

    if (method === 'PUT') {
      if (gh.readOnlyToken) return json(403, { message: 'Resource not accessible by personal access token' });
      const body = call.body;
      if (gh.beforePut) await gh.beforePut(gh, body);
      if (body.branch !== gh.branch) return json(404, { message: 'Branch not found' });
      if (gh.file && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (gh.file && body.sha !== gh.file.sha) return json(409, { message: `${PATH} does not match ${body.sha}` });
      if (!gh.file && body.sha) return json(409, { message: 'sha does not match' });
      const created = !gh.file;
      const f = gh.write(fromBase64(body.content));
      gh.commits.push({ message: body.message, text: f.text, sha: f.sha });
      return json(created ? 201 : 200, { content: { path: PATH, sha: f.sha }, commit: { sha: `c${f.sha}` } });
    }
    return json(405, { message: 'nope' });
  };
  return gh;
}

function makeStore(gh, extra = {}) {
  return createGitHubStore({
    owner: OWNER, repo: REPO, branch: '', path: PATH, token: TOKEN,
    fetchImpl: gh.fetch, debounceMs: 10, pollMs: 0, now: () => NOW, win: undefined, pendingStorage: null,
    ...extra,
  });
}

function track(store) {
  const states = [];
  const statuses = [];
  store.subscribe((s) => states.push(s));
  store.onStatus((s) => statuses.push(s));
  return { states, statuses, last: () => statuses[statuses.length - 1] };
}

/** Web Storage lookalike (getItem/setItem/removeItem + key(i)/length, like localStorage). */
function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function fakeWin(visibility = 'visible') {
  const w = new EventTarget();
  w.document = new EventTarget();
  w.document.visibilityState = visibility;
  return w;
}

/** Let every queued promise callback run (setImmediate is not mocked). */
const drain = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------ base64

test('base64 helpers round-trip UTF-8 (emoji, accents, CJK) and match Buffer', () => {
  const samples = ['', 'plain ascii', 'Café ☕ — Zoë Ångström', 'punk 🎸🤘💀 and 𝔣𝔞𝔫𝔠𝔶', '日本語のテキスト', '"quotes" \\ back\nnewline'];
  for (const s of samples) {
    const b64 = encodeBase64Utf8(s);
    assert.equal(b64, Buffer.from(s, 'utf8').toString('base64'));
    assert.equal(decodeBase64Utf8(b64), s);
    assert.equal(decodeBase64Utf8(ghBase64(s)), s, 'tolerates GitHub line wrapping');
  }
  const big = '✓'.repeat(100000); // larger than one fromCharCode chunk
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(big)), big);
  assert.equal(decodeBase64Utf8(null), '');
});

// ------------------------------------------------------------ load

test('load: resolves the default branch, decodes the file, keeps sha + ETag, reports synced', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  assert.equal(store.mode, 'github');
  assert.equal(store.getState(), null);
  const t = track(store);
  const state = await store.load();

  assert.equal(state.tasks.t_mike.title, 'Email Mike');
  assert.deepEqual(state, seedState());
  assert.equal(store.getState(), state);
  assert.equal(t.states.length, 1);
  assert.equal(t.last().kind, 'synced');
  assert.equal(t.last().at, NOW);
  assert.equal(typeof t.last().message, 'string');

  const [repoCall, getCall] = gh.calls;
  assert.equal(repoCall.url, `https://api.github.com/repos/${OWNER}/${REPO}`);
  assert.equal(getCall.url, `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/state.json?ref=main`);
  assert.equal(getCall.headers.Accept, 'application/vnd.github+json');
  assert.equal(getCall.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(getCall.headers.Authorization, `Bearer ${TOKEN}`);

  // late subscribers get the current state and status immediately
  let got = null;
  let gotStatus = null;
  store.subscribe((s) => { got = s; });
  store.onStatus((s) => { gotStatus = s; });
  assert.equal(got, state);
  assert.equal(gotStatus.kind, 'synced');

  // the default branch is cached
  await store.refresh();
  assert.equal(gh.count('GET', /\/repos\/[^/]+\/[^/]+$/), 1);
  store.dispose();
});

test('load: explicit branch skips the repo lookup', async () => {
  const gh = fakeGitHub({ defaultBranch: 'trunk' });
  const store = makeStore(gh, { branch: 'trunk' });
  await store.load();
  assert.equal(gh.count('GET', /\/repos\/[^/]+\/[^/]+$/), 0);
  assert.match(gh.calls[0].url, /\?ref=trunk$/);
  store.dispose();
});

test('load: a branch that does not exist is a clear error, not an empty dashboard', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { branch: 'nope' });
  const t = track(store);
  await assert.rejects(store.load(), /Branch "nope"/);
  assert.equal(t.last().kind, 'error');
  assert.equal(store.getState(), null);
  store.dispose();
});

test('load: 404 means no file yet -> empty state; the first save creates it without a sha', async () => {
  const gh = fakeGitHub({ initial: null });
  const store = makeStore(gh);
  const t = track(store);
  const state = await store.load();
  assert.deepEqual(state, emptyState());
  assert.equal(t.last().kind, 'synced');

  const { writes, activity } = addWrites({ id: 't_new', title: 'First thing' });
  await store.apply(writes, activity);
  await store.flush();
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.equal('sha' in put.body, false);
  assert.equal(gh.state().tasks.t_new.title, 'First thing');
  assert.equal(t.last().kind, 'synced');
  store.dispose();
});

// UI-2: this used to assert getState() === null, i.e. the board stuck on LOADING forever.
test('load: a bad token -> error status with the Setup message and load rejects; the public file shows read-only; taps are refused (UI-2)', async () => {
  const gh = fakeGitHub();
  gh.validToken = 'something-else';
  const store = makeStore(gh);
  const t = track(store);
  await assert.rejects(store.load(), (err) => err.message === TOKEN_MESSAGE);
  assert.equal(t.last().kind, 'error');
  assert.equal(t.last().message, TOKEN_MESSAGE);
  // not stuck on LOADING: the board renders from raw.githubusercontent.com (no token sent there)
  assert.deepEqual(store.getState(), seedState());
  assert.equal(t.states.length, 1);
  assert.equal(store.isLoaded(), false, 'a display copy is not a base to write on');
  const raw = gh.calls.find((c) => c.url.startsWith('https://raw.githubusercontent.com/'));
  assert.ok(raw, 'read the public file');
  assert.ok(gh.calls.filter((c) => !c.url.startsWith('https://api.github.com/')).every((c) => !c.headers || !('Authorization' in c.headers)));
  // the first tap is refused (act() toasts it) instead of "Added" onto a board that can never save
  await assert.rejects(store.apply(doneWrites('t_mike', 'Email Mike').writes, []),
    (err) => err.code === NOT_LOADED && err.message === TOKEN_MESSAGE);
  assert.equal(store.getState().tasks.t_mike.status, 'todo');
  assert.equal(store.hasPending(), false);
  assert.equal(t.last().message, TOKEN_MESSAGE, 'the status still explains the token');
  await store.flush();
  await store.refresh(); // tapping sync retries the authenticated load (still rejected)
  assert.equal(t.last().message, TOKEN_MESSAGE);
  assert.equal(gh.count('PUT'), 0);
  assert.equal(gh.state().tasks.t_mike.status, 'todo');
  store.dispose();
});

test('load: a bad token on a private repo -> error status, nothing to show, taps refused (UI-2)', async () => {
  const gh = fakeGitHub({ publicRepo: false });
  gh.validToken = 'something-else';
  const store = makeStore(gh);
  const t = track(store);
  await assert.rejects(store.load(), (err) => err.message === TOKEN_MESSAGE);
  assert.equal(t.last().kind, 'error');
  assert.equal(t.last().message, TOKEN_MESSAGE);
  assert.equal(store.getState(), null);
  await assert.rejects(store.apply(doneWrites('t_mike', 'Email Mike').writes, []), { code: NOT_LOADED });
  assert.equal(store.getState(), null, 'never an emptyState() board with one task on it');
  assert.equal(gh.count('PUT'), 0);
  store.dispose();
});

test('load: invalid JSON on GitHub is an error and nothing is overwritten', async () => {
  const gh = fakeGitHub({ initial: '{ "tasks": { oops' });
  const store = makeStore(gh);
  const t = track(store);
  await assert.rejects(store.load());
  assert.equal(t.last().kind, 'error');
  assert.match(t.last().message, /valid JSON/);
  // a tap anyway: refused (there is no base to apply it to), nothing queued, nothing PUT.
  // (This used to expect hasPending() === true: writes queued against nothing.)
  const { writes, activity } = addWrites({ id: 't_x', title: 'X' });
  await assert.rejects(store.apply(writes, activity), (err) => err.code === NOT_LOADED && /valid JSON/.test(err.message));
  await store.flush();
  assert.equal(gh.count('PUT'), 0);
  assert.equal(gh.file.text, '{ "tasks": { oops');
  assert.equal(store.hasPending(), false);
  assert.equal(store.getState(), null);
  store.dispose();
});

// ------------------------------------------------------------ apply + flush

test('apply is optimistic; flush PUTs the serialized state with sha, branch and a brief commit message', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  const t = track(store);
  await store.load();
  const loadedSha = gh.file.sha;

  const { writes, activity } = doneWrites('t_mike', 'Email Mike');
  await store.apply(writes, activity);
  // visible immediately, nothing sent yet
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  assert.equal(t.states.at(-1).tasks.t_mike.status, 'done');
  assert.equal(t.last().kind, 'pending');
  assert.equal(store.hasPending(), true);
  assert.equal(gh.count('PUT'), 0);

  await store.flush();
  assert.equal(gh.count('PUT'), 1);
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/state.json`);
  assert.equal(put.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(put.body.sha, loadedSha);
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, commitMessage(activity));
  assert.equal(fromBase64(put.body.content), serializeState(store.getState()));

  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.ok(gh.state().activity[activity[0].id]);
  assert.equal(store.hasPending(), false);
  assert.equal(t.last().kind, 'synced');
  assert.ok(t.statuses.some((s) => s.kind === 'saving'));

  // the next save uses the sha GitHub returned
  const second = doneWrites('t_hw', 'Multivariate HW 3');
  await store.apply(second.writes, second.activity);
  await store.flush();
  const puts = gh.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts[1].body.sha, gh.commits[0].sha);
  assert.equal(gh.commits.length, 2);
  store.dispose();
});

test('apply ignores junk and an empty write list', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  await store.load();
  const before = store.getState();
  await store.apply([], []);
  await store.apply([null, { nope: 1 }], null);
  await store.apply(undefined, undefined);
  assert.equal(store.getState(), before);
  assert.equal(store.hasPending(), false);
  await store.flush();
  assert.equal(gh.count('PUT'), 0);
  store.dispose();
});

test('debounce: two quick applies become one PUT; the timer resets but never waits past 4x debounceMs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 1000 });
  await store.load();

  const a = doneWrites('t_mike', 'Email Mike');
  const b = doneWrites('t_hw', 'Multivariate HW 3');
  await store.apply(a.writes, a.activity);
  t.mock.timers.tick(900);
  await drain();
  await store.apply(b.writes, b.activity);
  t.mock.timers.tick(900);
  await drain();
  assert.equal(gh.count('PUT'), 0, 'second apply reset the timer');
  t.mock.timers.tick(100);
  await drain();
  assert.equal(gh.count('PUT'), 1);
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_hw.status, 'done');
  assert.equal(gh.commits[0].message, commitMessage([...a.activity, ...b.activity]));
  assert.equal(store.hasPending(), false);

  // a steady stream of taps still commits by 4x debounceMs
  for (let i = 0; i < 5; i++) {
    const w = addWrites({ id: `t_s${i}`, title: `Stream ${i}` });
    await store.apply(w.writes, w.activity);
    t.mock.timers.tick(900);
    await drain();
  }
  // 4500ms since the first queued write in this burst, each gap < debounceMs
  assert.equal(gh.count('PUT'), 2, 'max-wait forced a commit');
  store.dispose();
});

test('writes made while a PUT is in flight go out in a follow-up PUT', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  gh.beforePut = async () => { gh.beforePut = null; await gate; };

  const a = doneWrites('t_mike', 'Email Mike');
  await store.apply(a.writes, a.activity);
  const first = store.flush();
  await drain();
  const b = addWrites({ id: 't_late', title: 'Late tap' });
  await store.apply(b.writes, b.activity);
  const second = store.flush(); // in flight -> marked dirty, same promise
  release();
  await first;
  await second;
  assert.equal(gh.count('PUT'), 2);
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_late.title, 'Late tap');
  assert.equal(gh.calls.filter((c) => c.method === 'PUT')[1].body.sha, gh.commits[0].sha);
  assert.equal(store.hasPending(), false);
  store.dispose();
});

// ------------------------------------------------------------ conflicts

test('conflict: a concurrent remote commit is merged; both sides survive', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  const t = track(store);
  await store.load();

  // Claude edits t_hw and adds a task via git right before our PUT lands.
  gh.beforePut = async () => {
    gh.beforePut = null;
    gh.remoteEdit((s) => applyWrites(s, [
      { op: 'update', col: 'tasks', id: 't_hw', data: { title: 'Multivariate HW 3 (Q1-4)', est: 120 } },
      { op: 'set', col: 'tasks', id: 't_claude', data: { ...s.tasks.t_mike, id: 't_claude', title: 'Book dentist' } },
    ]));
  };
  const mine = doneWrites('t_mike', 'Email Mike');
  const mine2 = { op: 'update', col: 'tasks', id: 't_hw', data: { plan: '2026-10-06' } };
  await store.apply([...mine.writes, mine2], mine.activity);
  await store.flush();

  assert.equal(gh.count('PUT'), 2, 'first PUT conflicted, second succeeded');
  const remote = gh.state();
  assert.equal(remote.tasks.t_mike.status, 'done', 'ours');
  assert.equal(remote.tasks.t_hw.plan, '2026-10-06', 'ours, same entry');
  assert.equal(remote.tasks.t_hw.title, 'Multivariate HW 3 (Q1-4)', 'theirs, same entry');
  assert.equal(remote.tasks.t_hw.est, 120, 'theirs');
  assert.equal(remote.tasks.t_claude.title, 'Book dentist', 'theirs');
  assert.deepEqual(store.getState(), remote, 'local view matches what was committed');
  assert.equal(t.last().kind, 'synced');
  assert.equal(store.hasPending(), false);
  store.dispose();
});

test('conflict: three straight conflicts -> conflict status, writes kept, a later flush succeeds', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  const t = track(store);
  await store.load();
  let edits = 0;
  gh.beforePut = async () => {
    edits += 1;
    gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_hw', data: { notes: `edit ${edits}` } }]));
  };
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  assert.equal(gh.count('PUT'), 3);
  assert.equal(t.last().kind, 'conflict');
  assert.match(t.last().message, /3 tries/);
  assert.equal(store.hasPending(), true);
  assert.equal(store.getState().tasks.t_mike.status, 'done', 'still shown locally');
  assert.equal(store.getState().tasks.t_hw.notes, 'edit 3', 'rebased on the latest remote');

  gh.beforePut = null;
  await store.refresh(); // tapping the sync light retries
  assert.equal(t.last().kind, 'synced');
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_hw.notes, 'edit 3');
  store.dispose();
});

// ------------------------------------------------------------ auth + network

test('PUT rejected (403, read-only token) -> error status with the Setup message; writes kept', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  const t = track(store);
  await store.load();
  gh.readOnlyToken = true;
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  assert.equal(t.last().kind, 'error');
  assert.equal(t.last().message, TOKEN_MESSAGE);
  assert.equal(store.hasPending(), true);
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_mike.status, 'todo');
  store.dispose();
});

test('PUT with a revoked token (401) -> error status', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  const t = track(store);
  await store.load();
  gh.validToken = 'rotated';
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  assert.equal(t.last().kind, 'error');
  assert.equal(t.last().message, TOKEN_MESSAGE);
  assert.equal(store.hasPending(), true);
  store.dispose();
});

test('offline: writes stay queued, retries back off 5s -> 15s -> 60s, then land', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 1000 });
  const tr = track(store);
  await store.load();

  gh.offline = true;
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  assert.equal(tr.last().kind, 'offline');
  assert.match(tr.last().message, /5s/);
  assert.equal(store.hasPending(), true);
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  assert.equal(gh.commits.length, 0, 'the PUT never reached GitHub');

  // more taps while offline just queue
  const more = addWrites({ id: 't_off', title: 'Offline tap' });
  await store.apply(more.writes, more.activity);
  assert.equal(tr.last().kind, 'offline');

  t.mock.timers.tick(4999);
  await drain();
  const attemptsBefore = gh.calls.length;
  t.mock.timers.tick(1);
  await drain();
  assert.ok(gh.calls.length > attemptsBefore, 'retried at 5s');
  assert.match(tr.last().message, /15s/);

  t.mock.timers.tick(15000);
  await drain();
  assert.match(tr.last().message, /1m/);

  gh.offline = false;
  t.mock.timers.tick(60000);
  await drain(5);
  assert.equal(tr.last().kind, 'synced');
  assert.equal(store.hasPending(), false);
  assert.equal(gh.commits.length, 1, 'both queued taps in one commit');
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_off.title, 'Offline tap');
  store.dispose();
});

test("offline: the window 'online' event retries immediately", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const win = fakeWin();
  const store = makeStore(gh, { debounceMs: 1000, win });
  const tr = track(store);
  await store.load();
  gh.offline = true;
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  assert.equal(tr.last().kind, 'offline');

  gh.offline = false;
  win.dispatchEvent(new Event('online'));
  await drain(5);
  assert.equal(tr.last().kind, 'synced');
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  store.dispose();
});

test('offline at load: load rejects with an offline status, then recovers by itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  gh.offline = true;
  const store = makeStore(gh);
  const tr = track(store);
  await assert.rejects(store.load());
  assert.equal(tr.last().kind, 'offline');
  assert.equal(store.getState(), null);
  gh.offline = false;
  t.mock.timers.tick(5000);
  await drain(5);
  assert.equal(tr.last().kind, 'synced');
  assert.equal(store.getState().tasks.t_mike.title, 'Email Mike');
  assert.equal(tr.states.length, 1);
  store.dispose();
});

// ------------------------------------------------------------ read-only

test('read-only (no token): raw.githubusercontent.com, cache-busted, no auth; apply rejects', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { token: '' });
  assert.equal(store.mode, 'readonly');
  const t = track(store);
  const state = await store.load();
  assert.equal(state.tasks.t_mike.title, 'Email Mike');
  assert.equal(t.last().kind, 'readonly');
  assert.equal(t.last().message, READONLY_MESSAGE);

  const raw = gh.calls.find((c) => c.url.startsWith('https://raw.githubusercontent.com/'));
  const u = new URL(raw.url);
  assert.equal(u.pathname, `/${OWNER}/${REPO}/main/${PATH}`);
  assert.ok([...u.searchParams.keys()].length >= 1, 'cache-busting query param');
  assert.equal(raw.headers, undefined, 'no headers at all (no auth, no CORS preflight)');
  assert.ok(gh.calls.every((c) => !c.headers || !('Authorization' in c.headers)));

  await assert.rejects(store.apply(doneWrites('t_mike', 'x').writes, []), { message: 'read-only' });
  await store.flush();
  assert.equal(gh.count('PUT'), 0);

  // refresh re-reads raw and picks up remote changes
  gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_mike', data: { title: 'Email Mike back' } }]));
  await store.refresh();
  assert.equal(store.getState().tasks.t_mike.title, 'Email Mike back');
  const urls = gh.calls.filter((c) => c.url.startsWith('https://raw.')).map((c) => c.url);
  assert.notEqual(urls[0], urls[1], 'each read busts the cache');
  store.dispose();
});

test('read-only on a private repo: empty state with an explanation, no throw', async () => {
  const gh = fakeGitHub({ publicRepo: false });
  const store = makeStore(gh, { token: null });
  const t = track(store);
  const state = await store.load();
  assert.deepEqual(state, emptyState());
  assert.equal(t.last().kind, 'readonly');
  assert.match(t.last().message, /token/i);
  store.dispose();
});

// ------------------------------------------------------------ polling

test('poll: conditional GET with If-None-Match; 304 changes nothing; a new sha replaces state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const store = makeStore(gh, { pollMs: 1000, win: fakeWin() });
  const tr = track(store);
  await store.load();
  const loaded = store.getState();

  t.mock.timers.tick(1000);
  await drain();
  const poll1 = gh.calls.at(-1);
  assert.equal(poll1.method, 'GET');
  assert.equal(poll1.headers['If-None-Match'], `W/"etag-${gh.file.sha}"`);
  assert.equal(store.getState(), loaded, '304: same object, no re-render');
  assert.equal(tr.states.length, 1);

  gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_mike', data: { title: 'Email Mike re: RSA' } }]));
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(store.getState().tasks.t_mike.title, 'Email Mike re: RSA');
  assert.equal(tr.states.length, 2);
  assert.equal(tr.last().kind, 'synced');

  // and the next poll is a 304 again with the new ETag
  const before = store.getState();
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(gh.calls.at(-1).headers['If-None-Match'], `W/"etag-${gh.file.sha}"`);
  assert.equal(store.getState(), before);
  store.dispose();
});

test('poll: a remote change while writes are queued is rebased, not dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const store = makeStore(gh, { pollMs: 1000, debounceMs: 5000, win: fakeWin() });
  await store.load();
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_hw', data: { est: 45 } }]));
  const claudeSha = gh.file.sha;
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(store.getState().tasks.t_mike.status, 'done', 'ours kept');
  assert.equal(store.getState().tasks.t_hw.est, 45, 'theirs pulled in');
  assert.equal(gh.count('PUT'), 0);
  t.mock.timers.tick(5000);
  await drain(5);
  assert.equal(gh.count('PUT'), 1);
  assert.equal(gh.calls.find((c) => c.method === 'PUT').body.sha, claudeSha, 'PUT on top of the polled version: no conflict round-trip');
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.state().tasks.t_hw.est, 45);
  store.dispose();
});

test('poll: skipped while the tab is hidden; visibilitychange to visible refreshes; hidden flushes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gh = fakeGitHub();
  const win = fakeWin('hidden');
  const store = makeStore(gh, { pollMs: 1000, debounceMs: 60000, win });
  await store.load();
  const n = gh.calls.length;
  t.mock.timers.tick(3000);
  await drain();
  assert.equal(gh.calls.length, n, 'no polling while hidden');

  gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_mike', data: { notes: 'from claude' } }]));
  win.document.visibilityState = 'visible';
  win.document.dispatchEvent(new Event('visibilitychange'));
  await drain();
  assert.equal(store.getState().tasks.t_mike.notes, 'from claude');

  // queued writes are pushed right away when the tab goes hidden (phone locked)
  const mine = doneWrites('t_hw', 'Multivariate HW 3');
  await store.apply(mine.writes, mine.activity);
  win.document.visibilityState = 'hidden';
  win.document.dispatchEvent(new Event('visibilitychange'));
  await drain(5);
  assert.equal(gh.count('PUT'), 1);
  assert.equal(gh.state().tasks.t_hw.status, 'done');
  store.dispose();
});

test('poll: a lagging replica serving the pre-save version is ignored', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  await store.load();
  const old = { ...gh.file };
  const mine = doneWrites('t_mike', 'Email Mike');
  await store.apply(mine.writes, mine.activity);
  await store.flush();
  gh.staleNext = old;
  await store.refresh();
  assert.equal(store.getState().tasks.t_mike.status, 'done', 'did not roll back to the stale copy');
  store.dispose();
});

// ------------------------------------------------------------ UTF-8 through the store

test('UTF-8 survives load -> apply -> PUT -> reload', async () => {
  const s = seedState();
  s.tasks.t_mike.title = 'Email Zoë re: café ☕';
  const gh = fakeGitHub({ initial: s });
  const store = makeStore(gh);
  const state = await store.load();
  assert.equal(state.tasks.t_mike.title, 'Email Zoë re: café ☕');

  const w = addWrites({ id: 't_punk', title: 'Mosh 🤘 — Ångström gig 🎸' });
  await store.apply(w.writes, w.activity);
  await store.flush();
  assert.equal(gh.state().tasks.t_punk.title, 'Mosh 🤘 — Ångström gig 🎸');
  assert.equal(gh.state().tasks.t_mike.title, 'Email Zoë re: café ☕');
  assert.match(gh.commits[0].message, /Mosh 🤘/u);

  const again = makeStore(gh);
  const reloaded = await again.load();
  assert.equal(reloaded.tasks.t_punk.title, 'Mosh 🤘 — Ångström gig 🎸');
  store.dispose();
  again.dispose();
});

// ------------------------------------------------------------ queue survives a closed tab

test('queued writes survive a disposed store (closed tab / token change) and are pushed by the next one', async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  const first = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await first.load();
  const mine = doneWrites('t_mike', 'Email Mike');
  await first.apply(mine.writes, mine.activity);
  assert.equal(storage.m.size, 1);
  first.dispose(); // tab closed before the debounce fired

  const second = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  const t = track(second);
  const state = await second.load();
  assert.equal(state.tasks.t_mike.status, 'done', 'replayed on top of the remote');
  assert.equal(t.last().kind, 'pending');
  await second.flush();
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.commits[0].message, commitMessage(mine.activity));
  assert.equal(storage.m.size, 0, 'cleared once committed');
  second.dispose();
});

test('a different repo never replays another repo\'s queue; stale queues expire', async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  const first = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await first.load();
  await first.apply(doneWrites('t_mike', 'Email Mike').writes, []);
  first.dispose();
  const other = createGitHubStore({ owner: OWNER, repo: 'other', token: TOKEN, fetchImpl: gh.fetch, pollMs: 0, pendingStorage: storage });
  assert.equal(other.hasPending(), false);
  other.dispose();
  const later = makeStore(gh, { pendingStorage: storage, now: () => '2026-10-09T14:00:00.000Z' });
  assert.equal(later.hasPending(), false, 'older than 48h: dropped');
  later.dispose();
});

// ------------------------------------------------------------ misc robustness

test('missing owner/repo: error status, no fetch, no throw from refresh', async () => {
  const gh = fakeGitHub();
  const store = createGitHubStore({ owner: '', repo: '', token: TOKEN, fetchImpl: gh.fetch, pollMs: 0, pendingStorage: null });
  const t = track(store);
  await assert.rejects(store.load());
  assert.equal(t.last().kind, 'error');
  assert.match(t.last().message, /Setup/);
  await store.refresh();
  assert.equal(gh.calls.length, 0);
  store.dispose();
});

test('a throwing subscriber does not break the store; unsubscribe works; dispose stops updates', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  const orig = console.error;
  console.error = () => {};
  try {
    store.subscribe(() => { throw new Error('boom'); });
    const seen = [];
    const off = store.subscribe((s) => seen.push(s));
    await store.load();
    assert.equal(seen.length, 1);
    off();
    await store.apply(doneWrites('t_mike', 'Email Mike').writes, []);
    assert.equal(seen.length, 1);
    await store.flush();
    store.dispose();
    await assert.rejects(store.apply(doneWrites('t_hw', 'x').writes, []));
  } finally {
    console.error = orig;
  }
});

test('files over 1 MB (no inline content) are read through the blob API', async () => {
  const gh = fakeGitHub();
  const realFetch = gh.fetch;
  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.includes('/git/blobs/')) {
      gh.calls.push({ method: 'GET', url, headers: init.headers });
      return new Response(JSON.stringify({ sha: gh.file.sha, encoding: 'base64', content: ghBase64(gh.file.text) }), { status: 200 });
    }
    const res = await realFetch(url, init);
    if (res.status !== 200 || !u.pathname.includes('/contents/') || (init.method ?? 'GET') !== 'GET') return res;
    const j = await res.json();
    return new Response(JSON.stringify({ ...j, content: '', encoding: 'none' }), { status: 200, headers: { etag: res.headers.get('etag') } });
  };
  const store = makeStore(gh);
  const state = await store.load();
  assert.equal(state.tasks.t_mike.title, 'Email Mike');
  assert.equal(gh.count('GET', /\/git\/blobs\//), 1);
  store.dispose();
});

// ------------------------------------------------------------ review regressions (real ops through the store)

const ctxAt = (now, src = 'dash') => ({ now, today: '2026-10-05', src });
const quickAddFields = (p) => ({
  title: p.title, due: p.due, plan: p.plan, time: p.time, est: p.est, prio: p.prio,
  cat: p.cat, kind: p.kind, newCatName: p.newCatName, recurring: p.recurring,
});
const realStateText = () => readFileSync(new URL('../data/state.json', import.meta.url), 'utf8');
/** The saved queues in a memStorage, flattened to batches. */
const savedBatches = (storage) => [...storage.m.values()].flatMap((v) => JSON.parse(v).batches ?? []);

/** A fetch that holds contents GETs until release() (a slow first load). */
function gatedGets(gh) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const realFetch = gh.fetch;
  gh.fetch = async (url, init = {}) => {
    if (/\/contents\//.test(url) && (init.method ?? 'GET') === 'GET') await gate;
    return realFetch(url, init);
  };
  return release;
}

/** A fetch whose next PUT reaches GitHub (and commits) but whose response is lost. */
function loseNextPutResponse(gh) {
  const realFetch = gh.fetch;
  let armed = true;
  gh.fetch = async (url, init = {}) => {
    const res = await realFetch(url, init);
    if (armed && (init.method ?? 'GET') === 'PUT' && res.ok) {
      armed = false;
      throw new TypeError('Failed to fetch');
    }
    return res;
  };
}

test('UI-1/SYNC-1: a "#manuscripts" quick-add while the first load is still running is refused, never replayed over the real category', async () => {
  const gh = fakeGitHub({ initial: realStateText() });
  const real = gh.state().cats.manuscripts;
  assert.equal(real.group, 'research');
  const release = gatedGets(gh);
  const store = makeStore(gh, { fetchImpl: gh.fetch, debounceMs: 60000 });
  const loading = store.load();
  await drain();
  // main.js: app.state is still emptyState(), so "#manuscripts" parses as a NEW category
  const appState = emptyState();
  const p = parseQuickAdd('revise discussion section #manuscripts', { today: '2026-10-05', cats: appState.cats, settings: appState.settings });
  assert.equal(p.newCatName, 'manuscripts');
  const r = OPS.addTask(appState, quickAddFields(p), ctxAt(NOW));
  assert.ok(r.writes.some((w) => w.op === 'set' && w.col === 'cats' && w.id === 'manuscripts'));
  await assert.rejects(store.apply(r.writes, r.activity), (err) => err.code === NOT_LOADED && err.message === LOADING_MESSAGE);
  release();
  await loading;
  assert.equal(store.isLoaded(), true);
  await store.flush();
  assert.equal(gh.count('PUT'), 0);
  assert.equal(store.hasPending(), false);
  assert.deepEqual(gh.state().cats.manuscripts, real, 'real category untouched on GitHub');
  assert.deepEqual(store.getState().cats.manuscripts, real);
  store.dispose();
});

test('SYNC-1: a quick-add while the first load failed (offline) is refused; after recovery the real category is intact', async () => {
  const gh = fakeGitHub({ initial: realStateText() });
  const real = gh.state().cats.manuscripts;
  gh.offline = true;
  const store = makeStore(gh, { debounceMs: 60000 });
  await assert.rejects(store.load());
  const appState = emptyState();
  const p = parseQuickAdd('revise discussion section #manuscripts', { today: '2026-10-05', cats: appState.cats, settings: appState.settings });
  const r = OPS.addTask(appState, quickAddFields(p), ctxAt(NOW));
  await assert.rejects(store.apply(r.writes, r.activity), (err) => err.code === NOT_LOADED && /Offline/.test(err.message));
  assert.equal(store.getState(), null);
  gh.offline = false;
  await store.refresh(); // back online (the retry timer or the sync light)
  assert.equal(store.isLoaded(), true);
  await store.flush();
  assert.equal(gh.count('PUT'), 0);
  assert.deepEqual(gh.state().cats.manuscripts, real);
  // now that the board is loaded, the same quick-add files into the existing category
  const st = store.getState();
  const p2 = parseQuickAdd('revise discussion section #manuscripts', { today: '2026-10-05', cats: st.cats, settings: st.settings });
  assert.equal(p2.cat, 'manuscripts');
  assert.equal(p2.newCatName, null);
  store.dispose();
});

test('SYNC-1: "#neuro" on a tab that has not polled yet files under the category Claude just created, never replaces it', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  // Claude creates the category from chat (git push); the tab hasn't polled
  gh.remoteEdit((s) => OPS.addCategory(s, { name: 'Neuro', group: 'coursework', aliases: ['neuro', 'seminar'] }, ctxAt(NOW, 'chat')).state);
  const claudeCat = gh.state().cats.neuro;
  const st = store.getState();
  const p = parseQuickAdd('read chapter 3 #neuro', { today: '2026-10-05', cats: st.cats, settings: st.settings });
  assert.equal(p.newCatName, 'neuro');
  const r = OPS.addTask(st, quickAddFields(p), ctxAt('2026-10-05T14:00:05.000Z'));
  await store.apply(r.writes, r.activity);
  assert.equal(store.getState().cats.neuro.group, 'admin', 'optimistic local default');
  await store.flush();
  assert.equal(gh.count('PUT'), 2, 'conflict, then rebased');
  const remote = gh.state();
  assert.deepEqual(remote.cats.neuro, claudeCat, "Claude's category kept: name, group, color, aliases");
  const task = Object.values(remote.tasks).find((t) => t.title === 'Read chapter 3');
  assert.equal(task.cat, 'neuro');
  assert.deepEqual(store.getState(), remote);
  store.dispose();
});

test('SYNC-2: the queue holds fine-grained writes (diffWrites of each change), not whole arrays and totals', async () => {
  const s = seedState();
  s.clock = { active: true, ref: 'task:t_hw', title: 'Multivariate HW 3', cat: 'inbox', start: '2026-10-05T13:35:00.000Z', goal: 5 };
  s.tasks.t_hw.subs = [{ id: 's1', t: 'Q1', done: false }, { id: 's2', t: 'Q2', done: false }];
  const gh = fakeGitHub({ initial: s });
  const storage = memStorage();
  const store = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await store.load();
  const out = OPS.clockOut(store.getState(), { markDone: false }, ctxAt(NOW));
  await store.apply(out.writes, out.activity);
  const sub = OPS.toggleSub(store.getState(), { id: 't_hw', subId: 's2' }, ctxAt(NOW));
  await store.apply(sub.writes, sub.activity);
  const [b1, b2] = savedBatches(storage);
  const w1 = b1.writes.find((w) => w.col === 'tasks' && w.id === 't_hw');
  assert.deepEqual(w1.inc, { spent: 25 }, 'a delta, not spent = old + 25');
  assert.equal('spent' in (w1.data ?? {}), false);
  const w2 = b2.writes.find((w) => w.col === 'tasks' && w.id === 't_hw');
  assert.deepEqual(w2.arr.subs.patch, { s2: { done: true } }, 'one element, one field');
  assert.equal('subs' in (w2.data ?? {}), false);
  assert.ok(b1.acts.length && b2.acts.length, 'each batch knows its activity ids');
  assert.equal(store.getState().tasks.t_hw.spent, 25);
  assert.equal(store.getState().tasks.t_hw.subs[1].done, true);
  store.dispose();
});

test("SYNC-2: Claude adds a substep while the site checks another -> both survive the rebase", async () => {
  const s = seedState();
  s.tasks.t_hw.subs = [{ id: 's1', t: 'Q1', done: false }, { id: 's2', t: 'Q2', done: false }];
  const gh = fakeGitHub({ initial: s });
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  gh.beforePut = async () => {
    gh.beforePut = null;
    gh.remoteEdit((st) => OPS.addSub(st, { id: 't_hw', t: 'Q3 (from chat)' }, ctxAt('2026-10-05T14:00:01.000Z', 'chat')).state);
  };
  const r = OPS.toggleSub(store.getState(), { id: 't_hw', subId: 's1' }, ctxAt('2026-10-05T14:00:02.000Z'));
  await store.apply(r.writes, r.activity);
  await store.flush();
  const subs = gh.state().tasks.t_hw.subs;
  assert.equal(subs.find((x) => x.id === 's1').done, true, 'site toggle kept');
  assert.ok(subs.some((x) => x.t === 'Q3 (from chat)'), `Claude's substep kept: ${JSON.stringify(subs)}`);
  assert.equal(subs.length, 3);
  store.dispose();
});

test('SYNC-2: Claude logs 30m while the site clocks out 25m on the same task -> spent = 55 = the sessions', async () => {
  const s = seedState();
  s.clock = { active: true, ref: 'task:t_hw', title: 'Multivariate HW 3', cat: 'inbox', start: '2026-10-05T13:35:00.000Z', goal: 5 };
  const gh = fakeGitHub({ initial: s });
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  gh.beforePut = async () => {
    gh.beforePut = null;
    gh.remoteEdit((st) => OPS.logTime(st, { ref: 'task:t_hw', minutes: 30 }, ctxAt('2026-10-05T13:59:00.000Z', 'chat')).state);
  };
  const r = OPS.clockOut(store.getState(), { markDone: false }, ctxAt(NOW));
  await store.apply(r.writes, r.activity);
  await store.flush();
  const st = gh.state();
  const sessMin = Object.values(st.sessions).reduce((a, x) => a + x.min, 0);
  assert.equal(sessMin, 55, 'both sessions recorded');
  assert.equal(st.tasks.t_hw.spent, 55);
  assert.equal(st.clock.active, false);
  store.dispose();
});

test("SYNC-2: Claude re-plans blocks while the site checks one -> the check, Claude's moves and new blocks all survive", async () => {
  const s = seedState();
  s.tasks.t_hw.due = '2026-10-09';
  s.tasks.t_hw.blocks = [
    { id: 'b_1', d: '2026-10-05', m: 60, done: false, auto: true },
    { id: 'b_2', d: '2026-10-06', m: 60, done: false, auto: true },
  ];
  const gh = fakeGitHub({ initial: s });
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  gh.beforePut = async () => {
    gh.beforePut = null;
    gh.remoteEdit((st) => OPS.applyAllocation(st, { updates: { t_hw: [
      { id: 'b_1', d: '2026-10-05', m: 60, done: false, auto: true },
      { id: 'b_2', d: '2026-10-07', m: 60, done: false, auto: true },
      { id: 'b_3', d: '2026-10-08', m: 60, done: false, auto: true },
    ] } }, ctxAt('2026-10-05T14:00:01.000Z', 'chat')).state);
  };
  const r = OPS.toggleBlock(store.getState(), { id: 't_hw', blockId: 'b_1' }, ctxAt('2026-10-05T14:00:02.000Z'));
  await store.apply(r.writes, r.activity);
  await store.flush();
  const t = gh.state().tasks.t_hw;
  const byId = Object.fromEntries(t.blocks.map((b) => [b.id, b]));
  assert.equal(byId.b_1.done, true, 'site check kept');
  assert.equal(byId.b_2.d, '2026-10-07', "Claude's move kept");
  assert.ok(byId.b_3, "Claude's new block kept");
  assert.equal(t.spent, 60);
  store.dispose();
});

test('SYNC-2: Ziggy walked on the site while Claude logs a walk from chat -> both walks in the log', async () => {
  const s = seedState();
  s.chores.c_ziggy = {
    id: 'c_ziggy', title: 'Walk Ziggy', cat: 'inbox', every: 1, perDay: 2, last: '2026-10-04', log: ['2026-10-04'],
    min: 5, active: true, notes: '', created: NOW, updated: NOW,
  };
  const gh = fakeGitHub({ initial: normalizeState(s) });
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  gh.beforePut = async () => {
    gh.beforePut = null;
    gh.remoteEdit((st) => OPS.choreDone(st, { id: 'c_ziggy' }, ctxAt('2026-10-05T13:00:00.000Z', 'chat')).state);
  };
  const r = OPS.choreDone(store.getState(), { id: 'c_ziggy' }, ctxAt('2026-10-05T14:00:00.000Z'));
  await store.apply(r.writes, r.activity);
  await store.flush();
  assert.deepEqual(gh.state().chores.c_ziggy.log, ['2026-10-04', '2026-10-05', '2026-10-05']);
  store.dispose();
});

test('SYNC-3: a committed PUT whose response was lost is never replayed later over Claude\'s newer change', async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  loseNextPutResponse(gh);
  const first = makeStore(gh, { pendingStorage: storage, debounceMs: 60000, fetchImpl: gh.fetch });
  await first.load();
  const r = OPS.completeTask(first.getState(), { id: 't_mike' }, ctxAt(NOW));
  await first.apply(r.writes, r.activity);
  await first.flush(); // GitHub committed it; the phone never saw the answer
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(first.hasPending(), true, 'from where the tab sits, it might not have landed');
  first.dispose(); // iOS discards the tab
  // later, in chat: "Email Mike isn't actually done" -> ef undo
  gh.remoteEdit((st) => OPS.reopenTask(st, { id: 't_mike' }, ctxAt('2026-10-05T18:00:00.000Z', 'chat')).state);
  const commits = gh.commits.length;
  const second = makeStore(gh, { pendingStorage: storage, debounceMs: 60000, now: () => '2026-10-06T12:00:00.000Z', fetchImpl: gh.fetch });
  assert.equal(second.hasPending(), true, 'the saved batch was claimed');
  const t = track(second);
  await second.load();
  assert.equal(second.hasPending(), false, 'recognized as committed (its activity is on GitHub) and dropped');
  await second.flush();
  assert.equal(gh.commits.length, commits, 'nothing re-committed');
  assert.equal(gh.state().tasks.t_mike.status, 'todo', "Claude's reopen stands");
  assert.equal(second.getState().tasks.t_mike.status, 'todo');
  assert.equal(t.last().kind, 'synced');
  assert.equal(storage.m.size, 0, 'crash net emptied');
  second.dispose();
});

test('SYNC-3: a lost PUT response then a retry does not commit the same clock-out twice (spent stays 25)', async () => {
  const s = seedState();
  s.clock = { active: true, ref: 'task:t_hw', title: 'Multivariate HW 3', cat: 'inbox', start: '2026-10-05T13:35:00.000Z', goal: 5 };
  const gh = fakeGitHub({ initial: s });
  loseNextPutResponse(gh);
  const store = makeStore(gh, { debounceMs: 60000, fetchImpl: gh.fetch });
  const t = track(store);
  await store.load();
  const r = OPS.clockOut(store.getState(), { markDone: false }, ctxAt(NOW));
  await store.apply(r.writes, r.activity);
  await store.flush();
  assert.equal(t.last().kind, 'offline');
  assert.equal(gh.commits.length, 1);
  await store.refresh(); // the 'online' event / retry / sync light
  assert.equal(gh.commits.length, 1, 'no second commit');
  assert.equal(gh.state().tasks.t_hw.spent, 25);
  assert.equal(Object.keys(gh.state().sessions).length, 1);
  assert.equal(store.getState().tasks.t_hw.spent, 25);
  assert.equal(store.hasPending(), false);
  assert.equal(t.last().kind, 'synced');
  store.dispose();
});

test("SYNC-4: two tabs offline each keep their own saved queue; closing one loses nothing", async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  const A = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  const B = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await A.load();
  await B.load();
  gh.offline = true;
  const ra = OPS.completeTask(A.getState(), { id: 't_mike' }, ctxAt(NOW));
  await A.apply(ra.writes, ra.activity);
  const rb = OPS.completeTask(B.getState(), { id: 't_hw' }, ctxAt('2026-10-05T14:01:00.000Z'));
  await B.apply(rb.writes, rb.activity);
  assert.equal(storage.m.size, 2, 'one saved queue per tab');
  A.dispose(); // tab A closed while offline
  gh.offline = false;
  await B.flush(); // B saves its own change and clears only its own queue
  assert.equal(gh.state().tasks.t_hw.status, 'done');
  assert.equal(storage.m.size, 1, "A's queue is still there");
  const C = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 }); // tab A reopened
  await C.load();
  await C.flush();
  assert.equal(gh.state().tasks.t_mike.status, 'done', "tab A's check-off made it");
  assert.equal(gh.state().tasks.t_hw.status, 'done');
  assert.equal(storage.m.size, 0);
  B.dispose();
  C.dispose();
});

test("SYNC-4: a store replaced in Setup never clears the new store's saved queue, and never PUTs again", async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  const first = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await first.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  gh.beforePut = async () => { gh.beforePut = null; await gate; };
  const a = OPS.completeTask(first.getState(), { id: 't_mike' }, ctxAt(NOW));
  await first.apply(a.writes, a.activity);
  const inflight = first.flush();
  await drain();
  first.dispose(); // Setup -> Save token -> pickStore()
  const second = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await second.load();
  const b = OPS.completeTask(second.getState(), { id: 't_hw' }, ctxAt('2026-10-05T14:00:05.000Z'));
  await second.apply(b.writes, b.activity);
  release();
  await inflight; // the old store's PUT lands after it was disposed
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.ok(savedBatches(storage).some((x) => x.writes.some((w) => w.col === 'tasks' && w.id === 't_hw')), "the new store's write is still saved");
  second.dispose(); // tab killed before second's debounce fired
  const third = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  await third.load();
  await third.flush();
  assert.equal(gh.state().tasks.t_hw.status, 'done', "second store's write made it");
  assert.equal(gh.commits.length, 2, 't_mike once (first store), t_hw once (third store)');
  assert.match(gh.commits[1].message, /Multivariate HW 3/);
  assert.doesNotMatch(gh.commits[1].message, /Email Mike/);
  assert.equal(storage.m.size, 0);
  third.dispose();
});

test('SYNC-4: a disposed store whose PUT conflicts stops instead of retrying', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh, { debounceMs: 60000 });
  await store.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  gh.beforePut = async () => {
    gh.beforePut = null;
    await gate;
    gh.remoteEdit((s) => applyWrites(s, [{ op: 'update', col: 'tasks', id: 't_hw', data: { notes: 'from claude' } }]));
  };
  const a = OPS.completeTask(store.getState(), { id: 't_mike' }, ctxAt(NOW));
  await store.apply(a.writes, a.activity);
  const inflight = store.flush();
  await drain();
  store.dispose();
  release();
  await inflight;
  await drain(5);
  assert.equal(gh.count('PUT'), 1, 'no retry after dispose');
  assert.equal(gh.state().tasks.t_mike.status, 'todo');
});

test('SYNC-4: a saved queue from the previous version (one shared v1 key) is claimed and pushed once', async () => {
  const gh = fakeGitHub();
  const storage = memStorage();
  const mine = doneWrites('t_mike', 'Email Mike');
  storage.setItem(`ef.pending.v1:${OWNER}/${REPO}:~:${PATH}`, JSON.stringify({ v: 1, at: NOW, writes: mine.writes, activity: mine.activity }));
  const store = makeStore(gh, { pendingStorage: storage, debounceMs: 60000 });
  assert.equal(store.hasPending(), true);
  await store.load();
  await store.flush();
  assert.equal(gh.state().tasks.t_mike.status, 'done');
  assert.equal(gh.commits[0].message, commitMessage(mine.activity));
  assert.equal(storage.m.size, 0);
  store.dispose();
});

test('SYNC-6: a lagging replica serving an older, never-seen version cannot pin the board to it', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  const older = { ...gh.file };
  gh.remoteEdit((st) => OPS.completeTask(st, { id: 't_mike' }, ctxAt(NOW, 'chat')).state);
  await store.load(); // sees the head (t_mike done)
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  gh.staleNext = older; // one poll hits a replica one commit behind
  await store.refresh();
  await store.refresh(); // replica caught up
  assert.equal(store.getState().tasks.t_mike.status, 'done', 'back on the real head');
  await store.refresh();
  assert.equal(gh.calls.at(-1).headers['If-None-Match'], `W/"etag-${gh.file.sha}"`, 'polling the head again (304s), not stuck');
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  store.dispose();
});

test('SYNC-6: after a poll pulled a new version, a lagging replica serving the previous one is ignored (confirmed, no rollback)', async () => {
  const gh = fakeGitHub();
  const store = makeStore(gh);
  const t = track(store);
  await store.load();
  const v1 = { ...gh.file };
  gh.remoteEdit((st) => OPS.completeTask(st, { id: 't_mike' }, ctxAt(NOW, 'chat')).state);
  await store.refresh();
  assert.equal(store.getState().tasks.t_mike.status, 'done');
  const renders = t.states.length;
  gh.staleNext = v1;
  await store.refresh();
  assert.equal(store.getState().tasks.t_mike.status, 'done', 'no rollback to the version we left');
  assert.equal(t.states.length, renders, 'no flicker');
  store.dispose();
});

test('SEC-2: website commits carry the configured author and committer (noreply), and none when not configured', async () => {
  const author = { name: 'Danny Zweben', email: '176344411+dzweben@users.noreply.github.com' };
  const gh = fakeGitHub();
  const store = makeStore(gh, { author });
  await store.load();
  await store.apply(doneWrites('t_mike', 'Email Mike').writes, []);
  await store.flush();
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body.author, author);
  assert.deepEqual(put.body.committer, author);
  store.dispose();

  const gh2 = fakeGitHub();
  const plain = makeStore(gh2, { author: { name: 'x', email: '' } }); // incomplete -> ignored
  await plain.load();
  await plain.apply(doneWrites('t_mike', 'Email Mike').writes, []);
  await plain.flush();
  const put2 = gh2.calls.find((c) => c.method === 'PUT');
  assert.equal('author' in put2.body, false);
  assert.equal('committer' in put2.body, false);
  plain.dispose();
});

test('SEC-6: the store never persists the token, whichever tokenStorage the UI chose', async () => {
  for (const tokenStorage of ['local', 'session']) {
    const gh = fakeGitHub();
    const storage = memStorage();
    gh.offline = false;
    const store = makeStore(gh, { pendingStorage: storage, tokenStorage, debounceMs: 60000 });
    await store.load();
    await store.apply(doneWrites('t_mike', 'Email Mike').writes, []);
    assert.equal(storage.m.size, 1, 'the queue is saved');
    for (const [k, v] of storage.m) {
      assert.doesNotMatch(k, new RegExp(TOKEN));
      assert.doesNotMatch(v, new RegExp(TOKEN));
    }
    await store.flush();
    assert.ok(gh.calls.every((c) => !c.body || !JSON.stringify(c.body).includes(TOKEN)), 'never in a request body');
    assert.equal(gh.state().tasks.t_mike.status, 'done');
    store.dispose();
  }
});

// ------------------------------------------------------------ local store

test('localStore: seed on first load, persists applies, a new store reads them back', async () => {
  const storage = memStorage();
  const seed = seedState();
  const a = createLocalStore(seed, { storage, now: () => NOW });
  assert.equal(a.mode, 'local');
  const t = track(a);
  const s0 = await a.load();
  assert.deepEqual(s0, seed);
  assert.equal(t.last().kind, 'synced');
  assert.equal(t.last().message, LOCAL_MESSAGE);

  const w = addWrites({ id: 't_loc', title: 'Local Zoë 🎸' });
  await a.apply(w.writes, w.activity);
  assert.equal(a.getState().tasks.t_loc.title, 'Local Zoë 🎸');
  assert.equal(t.states.length, 2);
  assert.ok(storage.getItem('ef.state.v1'));

  const b = createLocalStore(seed, { storage });
  const s1 = await b.load();
  assert.equal(s1.tasks.t_loc.title, 'Local Zoë 🎸');
  assert.deepEqual(s1, a.getState());

  // refresh() re-reads storage (another tab wrote)
  await b.apply(doneWrites('t_mike', 'Email Mike').writes, []);
  await a.refresh();
  assert.equal(a.getState().tasks.t_mike.status, 'done');
  assert.equal(a.hasPending(), false);
  await a.flush();
  a.dispose();
  b.dispose();
});

test('localStore: custom key, broken storage and junk JSON fall back to the seed without throwing', async () => {
  const seed = seedState();
  const storage = memStorage();
  storage.setItem('ef.preview.v1', '{not json');
  const a = createLocalStore(seed, { storage, key: 'ef.preview.v1' });
  assert.deepEqual(await a.load(), seed);

  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('nope'); },
  };
  const b = createLocalStore(seed, { storage: broken });
  const t = track(b);
  assert.deepEqual(await b.load(), seed);
  await b.apply(doneWrites('t_mike', 'Email Mike').writes, []);
  assert.equal(b.getState().tasks.t_mike.status, 'done', 'still works in memory');
  assert.equal(t.last().kind, 'synced');
  await b.refresh();
  assert.equal(b.getState().tasks.t_mike.status, 'done', 'refresh keeps memory when storage is unreadable');

  const c = createLocalStore(undefined, { storage: null });
  assert.deepEqual(await c.load(), emptyState());
  a.dispose();
  b.dispose();
  c.dispose();
});
