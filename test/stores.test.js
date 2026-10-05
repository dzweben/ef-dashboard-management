import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubStore, encodeBase64Utf8, decodeBase64Utf8, READONLY_MESSAGE, TOKEN_MESSAGE,
} from '../src/store/githubstore.js';
import { createLocalStore, LOCAL_MESSAGE } from '../src/store/localstore.js';
import { emptyState, normalizeState, serializeState, applyWrites } from '../src/engine/model.js';
import { commitMessage } from '../src/engine/brief.js';

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

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
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

test('load: a bad token -> error status with the Setup message, and load rejects', async () => {
  const gh = fakeGitHub();
  gh.validToken = 'something-else';
  const store = makeStore(gh);
  const t = track(store);
  await assert.rejects(store.load(), (err) => err.message === TOKEN_MESSAGE);
  assert.equal(t.last().kind, 'error');
  assert.equal(t.last().message, TOKEN_MESSAGE);
  assert.equal(store.getState(), null);
  store.dispose();
});

test('load: invalid JSON on GitHub is an error and nothing is overwritten', async () => {
  const gh = fakeGitHub({ initial: '{ "tasks": { oops' });
  const store = makeStore(gh);
  const t = track(store);
  await assert.rejects(store.load());
  assert.equal(t.last().kind, 'error');
  assert.match(t.last().message, /valid JSON/);
  // a tap anyway: the store refuses to PUT over a file it couldn't read
  const { writes, activity } = addWrites({ id: 't_x', title: 'X' });
  await store.apply(writes, activity);
  await store.flush();
  assert.equal(gh.count('PUT'), 0);
  assert.equal(gh.file.text, '{ "tasks": { oops');
  assert.equal(store.hasPending(), true);
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
