# EF Console architecture (the contract)

This file is the source of truth for how the pieces fit. Every module, the
CLI, and the website code against the shapes and function signatures here.
If you change a shape, change it here first.

## Product priorities

1. **The running to-do list** is the product. Fast capture ("email mike - tomorrow"),
   a clear Today list, check-offs, push-backs, and a 14-day calendar.
2. Chores and the "just 5 minutes" clock-in.
3. Accomplishments (what got done, streaks).
4. Long-term projects as a light side panel (progress + next milestone).
No prioritization matrix and no weekly-hours budgeting.

## The loop: the repo is the database

```
Danny ──chat──▶ Claude (CLAUDE.md playbook), every turn:
                  1. git pull                        (picks up Danny's website commits)
                  2. ef changes                      (what Danny did since Claude's last turn)
                  3. ef add / done / move / plan ... (edits data/state.json)
                  4. ef brief --write                (the check-in shown on the website)
                  5. ef commit && git push           (author: Danny Zweben)
                  ▼
        github.com/dzweben/ef-dashboard-management  ── data/state.json (every change = a commit)
                  ▲
Danny ──taps──▶ EF Console website (GitHub Pages, docs/index.html)
                reads + writes data/state.json through the GitHub Contents API
                with Danny's fine-grained token (kept in his browser only).
                Each burst of taps becomes one commit, authored by Danny.
```

- **Website:** `docs/index.html`, one self-contained file built from `src/ui` by
  `npm run build`. Served by GitHub Pages from the `docs/` folder.
- **Database:** `data/state.json` at the repo root. Git history is the track
  record and the accomplishment log.
- **One functional core:** `src/engine/*` is pure JS (no DOM, no Node APIs),
  shared by the website (bundled by esbuild) and the CLI (Node ESM).

## Conventions

- Dates are local calendar strings `YYYY-MM-DD` in the settings timezone
  (`America/New_York` by default). Never store a JS Date in state.
- Timestamps are ISO-8601 UTC strings from `new Date().toISOString()`.
- Durations are integer **minutes**.
- IDs: `t_` task, `p_` project, `c_` chore, `s_` session, `a_` activity, `b_`
  block. Category ids are short slugs (`rsa`, `admin`). Generated ids are
  `<prefix><8 base36 chars>` from `makeId(prefix)` in `model.js`.
- Every engine function that needs "now" or "today" takes it as an argument
  (`ctx.now`, `ctx.today`) so tests are deterministic. Only `dates.todayISO()`
  and `dates.nowISO()` read the clock.
- Engine functions never mutate their inputs. They return new objects.
- Never write client names or initials, or any clinical detail, into state.
  Clinical to-dos stay generic ("Session notes", "Client prep").

## State (`data/state.json`)

```js
State = {
  schema: 1,
  settings: Settings,
  cats:     { [catId]: Category },
  tasks:    { [taskId]: Task },
  projects: { [projectId]: Project },
  chores:   { [choreId]: Chore },
  sessions: { [sessionId]: Session },
  activity: { [activityId]: Activity },
  clock:    Clock,
  brief:    Brief | null,
  sync:     Sync
}
```
`state.json` is written with 2-space indentation and keys in a stable order
(`serializeState` in `model.js`) so git diffs stay readable.

### Task

```js
{
  id: "t_k3j9x0aa",
  title: "Email Mike",
  cat: "admin",              // category id; "inbox" when unknown
  status: "todo",            // "todo" | "done" | "dropped"
  due: null,                 // "YYYY-MM-DD" hard deadline, or null
  time: null,                // "HH:MM" 24h, for meetings/appointments, or null
  plan: "2026-10-06",        // do-date: the day Danny intends to do it, or null
  est: 10,                   // estimated total minutes, or null if unknown
  spent: 0,                  // minutes logged so far (clock-ins, finished blocks)
  blocks: [],                // Block[] work sessions for multi-day work
  project: null,             // project id or null
  prio: 1,                   // 0 low, 1 normal, 2 high, 3 critical
  kind: "email",             // "task"|"deadline"|"meeting"|"appt"|"email"|"errand"|"reading"|"writing"|"analysis"
  notes: "",
  subs: [],                  // [{ id: "s1", t: "Read manual", done: false, est: 180 }]
  triage: false,             // true = stale item; Danny must say done / reschedule / drop
  moved: 0,                  // how many times it was pushed to a later day
  win: false,                // true = headline accomplishment when done
  created: "2026-10-05T13:00:00.000Z",
  updated: "2026-10-05T13:00:00.000Z",
  doneAt: null,              // ISO when status became "done"
  src: "chat"                // "chat" | "dash" | "import"
}
Block = { id: "b_x1", d: "2026-10-07", m: 60, done: false, auto: true }
```

Where a task shows up on the calendar for day `D`:
- **plan chip** if `plan === D`.
- **block chip** for each block with `d === D`.
- **deadline pin** if `due === D` (drawn as a diamond + "DUE").
- Meetings/appointments (`kind` meeting/appt) with `time` show the time.

"Today" rules (`views.todayView`):
- `overdue`: status todo, `due < today`, not triage.
- `dueToday`: status todo, `due === today`.
- `planned`: status todo, `plan === today`, `due !== today`.
- `carried`: status todo, `plan < today`, (`due` null or `> today`), not triage
  (display-only roll-over; the engine never rewrites `plan` by itself).
- `blocks`: undone blocks with `d === today`, with their task (task status todo).
- `triage`: status todo and `triage === true`.
- `chores`: active chores that are due (see Chore).
- `meetings`: status todo, kind meeting/appt, (`plan` or `due`) === today, sorted by time.
- `doneToday`: tasks whose `doneAt` falls on today in the settings timezone.
A task appears in only the first matching bucket in this order:
triage, overdue, dueToday, meetings, planned, carried. Block entries are separate.

Remaining work: `remaining(task) = max(0, (est ?? 0) - spent)`.
Allocated future: Σ `m` over undone blocks with `d >= today`.
Shortfall: `remaining - allocatedFuture` (only when `est` is set).
Checking a block done adds `block.m` to `spent`; un-checking subtracts it.

### Project

```js
{
  id: "p_rsa", name: "RSA manuscript", cat: "rsa",
  kind: "project",           // "project" | "role" | "course"
  status: "active",          // "active" | "paused" | "done"
  due: null, goal: "Submit RSA manuscript to a journal",
  milestones: [{ id: "m1", t: "Methods", due: null, done: true, doneAt: "…" }],
  weeklyHours: null, notes: "", order: 0, created: "…", updated: "…"
}
```

### Chore

```js
{
  id: "c_ziggy", title: "Walk Ziggy", cat: "ziggy",
  every: 1,          // days between repeats (1 = daily, 7 = weekly)
  perDay: 2,         // only for every === 1: target count per day
  last: "2026-10-04",
  log: ["2026-10-04"], // dates done, oldest first, capped at 90 entries (a date may repeat)
  min: 5,            // the "just 5 minutes" default
  active: true, notes: "", created: "…", updated: "…"
}
```
Due when: `every === 1` → today's count in `log` < `perDay`;
otherwise `last == null || diffDays(last, today) >= every`.
`urgency = every === 1 ? (perDay - todayCount) / perDay : (last ? diffDays(last, today) / every : 1)`.

### Session — clock-in history

```js
{ id: "s_…", ref: "task:t_…" | "chore:c_…" | "free", title: "Laundry",
  cat: "home", start: "…ISO", end: "…ISO", min: 12, d: "2026-10-05" }
```

### Clock — at most one running timer

```js
{ active: true, ref: "chore:c_laundry", title: "Laundry", cat: "home", start: "…ISO", goal: 5 }
// or { active: false }
```

### Brief — Claude's latest check-in, shown on the website

```js
{ at: "…ISO", headline: "3 things today. Start with the 5-minute laundry sort.",
  lines: ["…"], asks: ["Did the ABCD review meeting happen?"], focus: ["t_…"] }
```

### Sync

```js
{ lastClaudeSync: "…ISO" | null, lastActivitySeen: "…ISO" | null }
```

### Activity — what happened, for Claude's "I see you…" and commit messages

```js
{ id: "a_…", at: "…ISO", src: "dash" | "chat", type: "add"|"done"|"undone"|
  "move"|"edit"|"drop"|"delete"|"clock"|"chore"|"sub"|"block"|"milestone"|"cat"|"settings",
  ref: "t_…", title: "Email Mike", from: null, to: null }
```
`ef sync`/`ef changes` prunes entries older than 45 days.

### Category

```js
{ id: "rsa", name: "RSA", group: "research", color: "#89b7ff", glyph: "RS",
  aliases: ["rsa", "nyx"], order: 10, note: "", archived: false, created: "…" }
```
Groups in display order: `research`, `clinical`, `coursework`, `teaching`,
`service`, `admin`, `life`. The `inbox` category always exists.

### Settings

```js
{
  tz: "America/New_York", owner: "Danny", weekStart: "mon",
  cap: { mon: 240, tue: 240, wed: 240, thu: 240, fri: 180, sat: 90, sun: 150 },
  maxBlock: 120, minBlock: 30, defaultEst: 20, horizon: 14,
  offDays: []
}
```
`cap` is the focus minutes per weekday Danny realistically has for to-dos.

## Writes

Every mutation in `ops.js` returns `{ state, writes, activity }`:

```js
Write = { op: "set" | "update" | "delete", col: "tasks", id: "t_…", data?: {...} }
// col is a collection name, or "meta" with id "settings"|"clock"|"brief"|"sync"
```
- `set` creates or replaces a whole entry.
- `update` shallow-merges top-level fields into an existing entry (arrays replace
  wholesale). An update to a missing entry is ignored.
- `activity` entries are also included in `writes` as `set` on `activity`.
- `model.applyWrites(state, writes)` applies writes to a state (pure). This is
  how the website rebases its pending changes onto a newer remote state after a
  conflict: fetch remote, `applyWrites(remote, pending)`, commit again.

## Engine modules and signatures

All in `src/engine/`, ESM, pure. `ctx = { now: ISO, today: "YYYY-MM-DD", src }`.

### model.js (written)
`SCHEMA_VERSION`, `GROUPS`, `KINDS`, `STATUSES`, `PRIO_LABELS`, `COLLECTIONS`,
`META_DOCS`, `DEFAULT_SETTINGS`, `INBOX_CATEGORY`, `makeId`, `slugify`,
`normalizeTask/Project/Chore/Category/Settings/Clock/Brief/Sync`, `emptyState`,
`normalizeState(raw)`, `serializeState(state)`, `applyWrites(state, writes)`, `clone`.

### defaults.js (written)
`DEFAULT_CATEGORIES`.

### dates.js
- `todayISO(tz)`, `nowISO()`
- `isISODate(s)`, `addDays(iso, n)`, `diffDays(a, b)` (= b − a, whole days)
- `dow(iso)` (0 Sun … 6 Sat), `dowKey(iso)` (`"mon"`…), `isWeekend(iso)`
- `startOfWeek(iso, weekStart = "mon")`, `rangeDays(startIso, n)`
- `localDateOf(isoTimestamp, tz)` → `"YYYY-MM-DD"`, `localTimeOf(isoTimestamp, tz)` → `"HH:MM"`
- `fmtDay(iso)` → `"Mon 10/5"`, `fmtMonthDay(iso)` → `"Oct 5"`, `fmtWeekday(iso)` → `"Mon"`,
  `fmtRelative(iso, today)` → `"today"|"tomorrow"|"yesterday"|"Fri"|"in 9d"|"3d ago"`,
  `fmtTime(hhmm)` → `"3:30pm"`
- `fmtMinutes(m)` → `"45m"`, `"1h"`, `"1h 30m"`; `parseDuration(text)` → minutes or null
  (`"30m"`, `"1.5h"`, `"2 hrs"`, `"90 min"`, `"1h30"`, `"1h 30m"`)
- `parseTime(text)` → `"HH:MM"` or null (`"3pm"`, `"3:30 pm"`, `"15:00"`, `"noon"`)
- `parseDatePhrase(text, today)` → `{ date, consumed }` or null, where `consumed`
  is the matched substring. Supports: today, tonight, tomorrow/tmrw/tmr/tom,
  yesterday, weekday names and 3-letter abbreviations (bare = next occurrence
  strictly after today; `this <wd>` = in this Mon-start week, or the coming one if
  already past; `next <wd>` = that weekday in the following Mon-start week),
  `next week` (next Monday), `this weekend`/`weekend` (coming Saturday, today if
  Sat), `eow`/`end of week` (this Friday; if today is Fri/Sat/Sun the next
  Friday), `eom`/`end of month`, `in N days|weeks`, `M/D`, `M/D/YY(YY)`,
  `YYYY-MM-DD`, `oct 12`, `october 12th`, `12 oct`, bare ordinal `12th` (next
  occurrence of that day of month, today counts). Month/day without a year picks
  the next occurrence on or after today.

### parse.js
- `parseQuickAdd(text, { today, cats, settings })` →
  ```js
  { title, due, plan, time, est, prio, cat, catConfidence, catReason,
    newCatName,        // "#foo" that matched no category → suggest creating it
    kind, recurring,   // { every, perDay } or null → becomes a Chore
    tokens: [{ type, text, value }] }
  ```
  Rules:
  - A trailing ` - <date>` / ` — ` / ` – ` or `@<date>` or `on <date>` sets **plan**.
    `by`/`due`/`deadline` + date sets **due**. If the title contains
    due/deadline/exam/quiz/submit/turn in and a date was given by a separator,
    it sets **due** instead of plan.
  - `at 3pm` / `3:30pm` / `@ 15:00` sets time; title starting with meet/meeting/
    call/zoom/appointment/1:1 or containing "meeting" → kind meeting; dentist/
    doctor/appt → kind appt.
  - `~30m`, `(2h)`, `30min`, `1.5h`, `for 45 min` set est.
  - `!` → prio 2, `!!`/`!!!`/`urgent`/`asap` → prio 3, `low`/`someday` → prio 0.
  - `#tag` sets category (id, name, or alias, case-insensitive, prefix ≥ 3).
  - `every day|daily|weekly|every N days|every week|every other day|2x a day|twice a day` → recurring.
  - The leftover text, trimmed of separators/punctuation, is the title. First
    letter capitalized; a lowercase word right after email/call/text/ping/meet
    with/ask/tell/remind/message/thank/follow up with/reply to/schedule with is
    capitalized (a name).
  - kind `email` when the title starts with email/reply/respond; `reading` for
    read; `writing` for write/draft/edit; `analysis` for run/analyze/analyses/glm.
  - No date at all → plan and due stay null (backlog).
- `inferCategory(title, cats)` → `{ id, confidence (0–1), reason }`. Alias hit
  (word-boundary, longest alias wins) → 0.9; keyword rule → 0.6; else inbox 0.

### categories.js
- re-exports `DEFAULT_CATEGORIES`
- `oklchToHex(l, c, h)`, `hexToOklch(hex)` → `{ l, c, h }`
- `GROUP_HUES` = `{ research: [170, 340], clinical: [345, 20], coursework: [70, 130], teaching: [120, 160], service: [320, 360], admin: [200, 260], life: [20, 180] }`
- `pickColor(existingHexes, group)` → hex at OKLCH L 0.78, C 0.12, at the hue
  inside the group band (wrapping past 360) farthest from all existing hues
- `resolveCategory(token, cats)` → category or null (id, name, alias; case-insensitive; unique prefix ≥ 3)
- `makeCategory(name, { group, cats, color, aliases, glyph })` → Category with a
  unique slug id (suffix -2, -3 on clash), color from `pickColor` unless given
- `KEYWORD_RULES` = `[{ re, cat, reason }]` used by `parse.inferCategory`:
  email/reply/schedule/pay/register/form/reimburse/book/renew → admin;
  meet/meeting/1:1/zoom → meetings; clean/laundry/vacuum/dishes/groceries/trash → home;
  walk/vet → ziggy; dentist/doctor/psychiatr/pharmacy → health;
  client/session notes/supervision/assessment/intake → psc;
  homework/hw/assignment/quiz/exam/reading → (course cat with the earliest due task, else inbox);
  undergrad/mentee/RA → undergrad; committee/student rep → gradroles;
  manuscript/paper/revision/reviewer → manuscripts.

### schedule.js
- `capacityFor(settings, iso)` → minutes (0 on offDays)
- `remaining(task)`, `allocatedFuture(task, today)`, `shortfall(task, today)`
- `dayLoad(state, iso)` → `{ d, planned, blocks, total, cap, free, ratio }`
  (planned = Σ (est ?? defaultEst) − spent, floored at 0, of todo tasks with
  plan === d and no undone blocks; blocks = Σ m of undone blocks on d of todo tasks)
- `allocate(state, { today, taskIds, replan })` →
  `{ updates: { [taskId]: Block[] }, risks: Risk[] }`. EDF order (due asc,
  prio desc). Candidates: todo tasks with `est` and `due`, `remaining > 0`.
  Never moves `auto:false` or done blocks. With `replan` (default true), undone
  auto blocks are removed and re-placed; without it, only the shortfall is
  added. Places blocks from `max(today, task.plan ?? today)` to `due − 1` (the
  due day only if no earlier day exists), spreading evenly, each block in
  `[minBlock, maxBlock]` except a final remainder, never over a day's free
  capacity (free accounts for blocks placed earlier in the same run).
  `updates[taskId]` is the task's full new `blocks` array.
- `risks(state, today)` → `Risk[]`, each
  `{ type: "under-allocated"|"needs-estimate"|"crunch"|"overbooked", taskId?, d?, minutes?, message }`.
  needs-estimate: todo with due within 21 days, est null, and kind writing/
  analysis/deadline or a project, or a title matching presentation/manuscript/
  paper/poster/exam/talk/workshop/thesis.

### views.js
- `todayView(state, today)` → `{ overdue, dueToday, meetings, planned, carried, blocks: [{ task, block }], triage, chores, doneToday, counts: { open, done, total } }`
- `calendarView(state, start, days = 14)` → `[{ d, isToday, isPast, isWeekend, isOff, load, items: [{ type: "plan"|"block"|"due"|"meeting", task, block? }], chores: [chore…] , done: [task…] }]`
  (chores: chores scheduled to come due that day, from `last + every`)
- `upcomingDeadlines(state, today, days = 30)` → `[{ task, daysLeft, remaining, allocated, shortfall, status: "ok"|"tight"|"at-risk"|"unplanned"|"no-estimate" }]`
- `backlog(state)` → todo tasks with no plan, no due, no blocks, not triage
- `projectView(state, today)` → `[{ project, pct, msDone, msTotal, tasksOpen, tasksDone, nextMilestone, remainingMin, allocatedMin }]`
- `choreView(state, today)` → `[{ chore, due, urgency, todayCount, daysSince, nextDue }]`, most urgent first

### stats.js
- `doneOn(state, d)` → tasks done on local day d
- `heatmap(state, today, weeks = 12)` → `[{ d, count, minutes }]` oldest first, ending today
- `streak(state, today)` → `{ current, best }` (days with ≥1 completion, chore, or session;
  current counts back from today, or from yesterday if today is still empty)
- `weekStats(state, today)` → `{ done, byCat: { cat: n }, minutes, wins: Task[], chores }`
- `wins(state, { since })` → `[{ at, title, cat, kind: "task"|"milestone" }]` newest first

### ops.js
Every op: `(state, args, ctx) → { state, writes, activity }` and never throws on
a missing id (returns no writes). Activity `src` is `ctx.src`.
- `addTask(state, partial, ctx)` (partial may include parsed quick-add fields)
- `completeTask(state, { id }, ctx)` / `reopenTask` / `dropTask` / `deleteTask`
- `moveTask(state, { id, to }, ctx)` (sets plan; later than before → `moved += 1`; clears triage)
- `moveBlock(state, { id, blockId, to }, ctx)` (block becomes `auto:false`)
- `toggleBlock(state, { id, blockId }, ctx)` (adjusts `spent`)
- `editTask(state, { id, patch }, ctx)`
- `toggleSub(state, { id, subId }, ctx)`, `addSub(state, { id, t, est }, ctx)`, `removeSub`
- `clockIn(state, { ref, title, cat, goal }, ctx)` (stops a running clock first, logging it)
- `clockOut(state, { markDone }, ctx)` → session; adds minutes to the task's `spent`;
  for a chore ref, marks the chore done today
- `logTime(state, { ref, minutes }, ctx)`
- `choreDone(state, { id }, ctx)`, `addChore`, `editChore`, `deleteChore`
- `addCategory(state, { name, group, color, aliases }, ctx)`, `editCategory`
- `addProject`, `editProject`, `toggleMilestone(state, { id, msId }, ctx)`, `addMilestone`
- `applyAllocation(state, { updates }, ctx)`
- `setBrief(state, brief, ctx)`, `editSettings(state, { patch }, ctx)`
- `OPS` = `{ name: fn }` registry used by the website and the CLI.

### brief.js
- `buildBrief(state, { today, now })` → `{ headline, lines, asks, focus, text }`
- `changesSince(state, sinceIso)` → activity entries from the website since then, grouped
- `missingCategoryCheck(state, today)` → questions about stale categories
- `commitMessage(activity[])` → one-line summary + bullet body for git

## Stores (`src/store/`)

```js
store = {
  mode: "github" | "local" | "readonly",
  load(),                 // Promise<State>
  subscribe(onState),     // called on every change; returns unsubscribe
  onStatus(cb),           // { kind: "synced"|"saving"|"pending"|"offline"|"error"|"readonly"|"conflict", at, message }
  apply(writes, activity),// optimistic local apply, then persist
  refresh(),              // pull remote now
  getState()
}
```
- `githubstore.js` `createGitHubStore({ owner, repo, branch, path, token, fetchImpl, debounceMs = 2500, pollMs = 45000 })`
  GET `/repos/{o}/{r}/contents/{path}?ref={branch}` (base64 JSON + `sha`),
  PUT the whole file with `sha`; 409/422 → refetch, `applyWrites(remote, pending)`,
  retry (max 3). Commit message from `brief.commitMessage(pendingActivity)`.
  Polls with `If-None-Match` ETag and on `visibilitychange`. Without a token it
  reads `https://raw.githubusercontent.com/{o}/{r}/{branch}/{path}` read-only.
- `localstore.js` `createLocalStore(seedState, { key = "ef.state.v1" })`: localStorage
  (try/catch), for the offline preview and tests.

## Website (`src/ui/`)

Vanilla JS, bundled by esbuild into one inline `<script>` in `docs/index.html`.
See `src/ui/README.md` for the component contract and design.
