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
                  1. ef sync                         (git pull --rebase --autostash + what Danny did
                                                      on the website that arrived with this pull)
                  2. ef add / done / move / plan ... (edits data/state.json)
                  3. ef brief --write                (the check-in shown on the website)
                  4. ef commit && ef push            (author: Danny Zweben; when the website saved
                                                      meanwhile, push pulls --rebase and retries)
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
- **Database:** `data/state.json` at the repo root, on origin's **default
  branch** (the only branch the website reads and writes). Git history is the
  track record and the accomplishment log.
- **Merging:** `data/state.json` is never merged as text. `bin/ef-merge.mjs` is
  a git merge driver (`merge.efstate.driver = node bin/ef-merge.mjs %O %A %B`,
  `.gitattributes`: `data/state.json merge=efstate`) that `ef` registers in the
  clone on every run. It writes `applyWrites(A, diffWrites(O, B))` to `%A`
  (canonical `serializeState`), so both sides' edits survive field by field
  and no conflict markers can land in the file. During `git pull --rebase`, `A`
  is upstream (website) and `B` is the local commit being replayed (chat), so
  chat wins only fields both sides changed; those are reported.
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
- `carried`: status todo, `plan < today`, (`due` null or `> today`), not triage and
  not a past meeting (display-only roll-over; the engine never rewrites `plan` by itself).
- `blocks`: undone blocks with `d === today`, with their task (task status todo).
- `triage`: status todo and `triage === true`, or a past meeting/appointment
  (`schedule.isPastEvent`: kind meeting/appt whose day, plan else due, is before
  today with no due date still ahead). It happened or it didn't, so it is a
  "did it happen?" item, never carried-over work; risks, auto-planning and the
  brief's focus skip it.
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
  log: ["2026-10-04"], // dates done, kept sorted oldest first, capped at 90 entries (a date may repeat)
  start: null,       // first due date ("laundry every week - sat") or null; only used while never logged
  min: 5,            // the "just 5 minutes" default
  active: true, notes: "", created: "…", updated: "…"
}
```
Due when: never logged (`last` null, empty `log`) and `start > today` → not due,
next due `start`; else `every === 1` → today's count in `log` < `perDay`;
otherwise `last == null || diffDays(last, today) >= every`.
`urgency = every === 1 ? (perDay - todayCount) / perDay : (last ? diffDays(last, today) / every : 1)`.

### Session — clock-in history

```js
{ id: "s_…", ref: "task:t_…" | "chore:c_…" | "free", title: "Laundry",
  cat: "home", start: "…ISO", end: "…ISO", min: 12, d: "2026-10-05",
  rawMin: 790, capped: true }   // only on a capped session (see below)
```
A session counts at most `SESSION_CAP_MIN` (180, `model.js`) minutes: a timer
left running overnight logs 180 and keeps the wall-clock length in `rawMin` with
`capped: true` (its activity reads "180m (capped; clock ran 790m)"; `ef clock out`
says so). `d` is the local day the session started; a chore clock-out logs the
chore on that day. `stats` applies the same cap to sessions saved without `min`.

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
`ef sync` reports website activity by **id**, not by timestamp:
`brief.changesBetween(prePull, postPull)` over the working-tree state before and
after the pull, so a check-off stamped before Claude's last sync that only
reached GitHub later (offline queue, debounce, clock skew) is still reported
exactly once. Website commits that `ef push` merges in mid-turn are reported by
`ef push` itself (`changesBetween(prePush, postPush)`). `lastClaudeSync` only
advances after a successful pull; it now only bounds the "commits touching data"
git log in the sync output.

### Activity — what happened, for Claude's "I see you…" and commit messages

```js
{ id: "a_…", at: "…ISO", src: "dash" | "chat", type: "add"|"done"|"undone"|
  "move"|"edit"|"drop"|"delete"|"clock"|"chore"|"sub"|"block"|"milestone"|"cat"|"settings"|
  "archive",
  ref: "t_…", title: "Email Mike", from: null, to: null }
```
`archive` is written by `ef archive` (src `chat`, `to` = the archive file paths) so
the commit message says where the old done tasks went.
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
  offDays: [],
  capOverrides: {}            // { "YYYY-MM-DD": minutes } one-day capacity ("less time tomorrow")
}
```
`cap` is the focus minutes per weekday Danny realistically has for to-dos.
`capOverrides` replaces `cap` for one date only (`ef settings --cap-on tomorrow=90`;
`=none` removes it; overrides older than a week are dropped when it is edited);
`capacityFor(settings, iso)` reads it first (offDays still win: 0), so `dayLoad`,
the calendar and `allocate` all honour it. `normalizeSettings` keeps valid dates
with whole non-negative minutes, sorted by date (`model.normalizeCapOverrides`).
In `diffWrites` it merges per date like `cap`.

## Writes

Every mutation in `ops.js` returns `{ state, writes, activity }`:

```js
Write = { op: "set" | "update" | "delete", col: "tasks", id: "t_…", data?: {...},
          inc?: { field: delta }, arr?: { field: ArraySpec } }
// col is a collection name, or "meta" with id "settings"|"clock"|"brief"|"sync"
```
- `set` creates or replaces a whole entry. With `ifAbsent: true` (collections only)
  it only creates: skipped when an entry with that id already exists, so a replay
  onto a newer state never replaces a doc someone else created meanwhile.
  `ops.addCategory` marks its category this way; the website store marks every
  queued create this way (a category Claude made from chat with the same slug
  is kept and the tab's task files under it).
- `update` shallow-merges top-level fields of `data` into an existing entry
  (arrays in `data` replace wholesale; for meta `settings`, a plain-object field
  such as `cap` merges one level deep: `{ cap: { mon: 90 } }` changes Monday
  only). Then the optional fine-grained parts apply:
  - `inc: { spent: 25 }`: numeric delta added to the current value (missing → 0),
    floored at 0. Used for `tasks.spent` and `tasks.moved`, so concurrent time
    logs add up.
  - `arr: { subs: { upsert: [el], insert: [el], patch: { id: {…} }, remove: [id], was: { id: el }, order: [id] } }`
    for id-arrays (`tasks.subs`, `tasks.blocks`, `projects.milestones`), applied
    in this order: `remove` deletes by id (with `was`, an element the other side
    changed since is kept: an edit beats a delete); `upsert` replaces the element
    with that id in place or appends it; `insert` appends a NEW element, and if a
    different element already has its id (both sides added "s3") ours takes the
    next free id ("s4"), which later writes in the same `applyWrites` call follow
    (so a queue is replayed in ONE call); `patch` merges only the changed fields
    into the element (a block checked done survives a re-plan); `order` lists ids
    first in that order (emitted only when the order changed).
  - `arr: { log: { add: [v], remove: [v] } }` for value arrays: `chores.log` is a
    multiset (append each added value, remove the first occurrence of each removed
    one, sort oldest first, keep the last 90); `settings.offDays` and `cats.aliases`
    are sets.
  The field tables are exported from `model.js`: `INC_FIELDS`, `ID_ARRAY_FIELDS`,
  `MULTISET_FIELDS`, `SET_FIELDS`. `inc` and multiset `add` are not idempotent:
  a replayer must never apply the same batch twice (the store drops a queued
  batch once its activity ids are in the remote file).
  An update to a missing entry is ignored.
- `activity` entries are also included in `writes` as `set` on `activity`.
- `model.applyWrites(state, writes)` applies writes to a state (pure).
- `model.diffWrites(base, next)` → the writes turning `base` into `next`, using the
  fine-grained forms above for those known fields (field-level `update` for meta
  `settings`, where `cap` / `capOverrides` send only the changed keys and a removed
  key falls back to a whole `set`; `set` for clock / brief / sync). Anything it
  can't express exactly goes wholesale in `data`, so
  `applyWrites(base, diffWrites(base, next))` always reproduces `next` (asserted
  for every op in `test/ops.test.js`). It does not mark creates `ifAbsent`, so in
  the git merge driver a doc both sides created keeps chat's version. Contract (3-way merge):
  `applyWrites(remote, diffWrites(base, ours))` keeps remote's concurrent changes
  to other fields and elements and applies ours on top; counters add up. The
  website store queues `diffWrites(before, after)` per tap and rebases with
  `applyWrites(remote, queued)`; the git merge driver (`bin/ef-merge.mjs`) does
  the same for `git pull --rebase`.

## Engine modules and signatures

All in `src/engine/`, ESM, pure. `ctx = { now: ISO, today: "YYYY-MM-DD", src }`.

### model.js (written)
`SCHEMA_VERSION`, `GROUPS`, `KINDS`, `STATUSES`, `PRIO_LABELS`, `COLLECTIONS`,
`META_DOCS`, `DEFAULT_SETTINGS`, `INBOX_CATEGORY`, `makeId`, `slugify`,
`normalizeTask/Project/Chore/Category/Settings/Clock/Brief/Sync`, `normalizeCapOverrides`,
`emptyState`, `normalizeState(raw)`, `serializeState(state)`, `applyWrites(state, writes)`,
`diffWrites(base, next)`, `clone`, `SESSION_CAP_MIN` (180), `INC_FIELDS`,
`ID_ARRAY_FIELDS`, `MULTISET_FIELDS`, `SET_FIELDS`.

### defaults.js (written)
`DEFAULT_CATEGORIES`. Aliases must be specific to their category: a generic word
("visit") wins on its own and misfiles personal to-dos ("visit grandma" → clinical),
so the clinical alias is "home visit".

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
  Friday), `eom`/`end of month`, `eod`/`end of (the) day` (today; followed by a
  date, that date: "eod fri" is Friday and consumes both), `in N days|weeks`, `M/D`, `M/D/YY(YY)`,
  `YYYY-MM-DD`, `oct 12`, `october 12th`, `12 oct`, bare ordinal `12th` (next
  occurrence of that day of month, today counts). Month/day without a year means
  this year's date unless that is more than 60 days in the past (then next year),
  so "10/1" typed on Oct 5 is Oct 1 (overdue) and "1/15" typed in October is next January.

### parse.js
- `parseQuickAdd(text, { today, cats, settings, now? })` →
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
    it sets **due** instead of plan, unless the deliverable belongs to someone
    else: titles starting with email/ask/tell/call/text/remind/reply/grade/
    proctor/schedule/book/discuss… and words after "about"/"re"/"regarding" don't
    count ("email prof about exam - fri" is a do-day; "submit exam - fri" is due).
  - A trailing `for <date>` is a date only when more than one word precedes `for`
    ("buy cake for friday" → plan Fri; "prep for thursday" stays the title).
  - `at 3pm` / `3:30pm` / `@ 15:00` sets time; title starting with meet/meeting/
    call/zoom/appointment/1:1 or containing "meeting" → kind meeting; dentist/
    doctor/appt → kind appt. A connector right before the time is consumed:
    `by`/`before`/`due`/`no later than` make the line's date **due**
    ("tomorrow by 5pm" → due tomorrow 17:00); `after`/`around`/`until`/`~` make it
    **plan** (not for "stop/swing/drop by"). A bare `11:59` is 23:59; a bare 8–11
    o'clock (no am/pm, no leading zero) with tonight/evening/night is pm.
  - A time with no date and no recurrence lands on **today** (plan; due with
    "by"/"before"), not the backlog, via an implicit token with empty `text`. With
    `now` (ISO) given and on `today`, a time already past rolls to tomorrow. A
    caller that sets its own date (`ef add --due/--plan`) drops that implicit day.
  - `by eod fri` / `fri by eod` / `fri end of day` → due Friday; `by eod` alone → due today.
  - `~30m`, `(2h)`, `30min`, `1.5h`, `for 45 min` set est.
  - `!` → prio 2, `!!`/`!!!`/`urgent`/`asap` → prio 3, `low`/`someday` → prio 0
    (a trailing "low" is read before and after the date, so "sat low" keeps Sat).
  - `#tag` sets category (id, name, or alias, case-insensitive, prefix ≥ 3).
  - Recurrence. Strong forms always recur: `every day|week|N days|other day|<weekday>`,
    `2x a day`, `twice a day`. Bare cadence words (daily, nightly, everyday,
    weekly, biweekly, fortnightly, monthly, `<weekday>s`/`on <weekday>s`) recur
    only when no one-off date was given; next to a date they stay in the title
    ("submit weekly report by fri" is a task due Fri; "laundry weekly" is a chore).
    A recurring line with a future date becomes a chore whose `start` is that date.
  - A recurring line with no category gets cat `home` (when it exists), catReason
    "chores default to Home", catConfidence 0.3: the preview matches where
    `addChore` files it.
  - The leftover text, trimmed of separators/punctuation, is the title. First
    letter capitalized; a lowercase word right after email/call/text/ping/meet
    with/ask/tell/remind/message/thank/follow up with/reply to/schedule with is
    capitalized (a name); after Dr/Prof only when it is not a stop word
    ("Email Prof about exam").
  - kind `email` when the title starts with email/reply/respond; `reading` for
    read; `writing` for write/draft/edit; `analysis` for run/analyze/analyses/glm.
  - No date and no time → plan and due stay null (backlog).
- `inferCategory(title, cats)` → `{ id, confidence (0–1), reason }`. Alias hits
  (word-boundary) are ranked by specificity first: +1 for an alias typed in
  capitals ("OCD"), +1 inside a short "Label:" prefix, −1 for an action verb
  starting a clause ("email jason", "…and email chloe"); then alias length, then
  category `order`. A hit → 0.9; two categories tied on specificity → 0.45 with a
  reason naming both (`ef add` then prints its "ask Danny" hint); keyword rule →
  0.6; else inbox 0.

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
- `capacityFor(settings, iso)` → minutes: 0 on offDays, else `capOverrides[iso]`,
  else the weekday `cap`
- `isPastEvent(task, today)` → true for an open meeting/appt whose day (plan, else
  due) is before today and that has no due date still ahead (see `todayView` triage)
- `remaining(task)`, `allocatedFuture(task, today)`, `shortfall(task, today)`
- `dayLoad(state, iso)` → `{ d, planned, blocks, total, cap, free, ratio }`
  (planned = Σ (est ?? defaultEst) − spent, floored at 0, of todo tasks with
  plan === d and no undone blocks; blocks = Σ m of undone blocks on d of todo tasks)
- `allocate(state, { today, taskIds, replan })` →
  `{ updates: { [taskId]: Block[] }, risks: Risk[] }`. EDF order (due asc,
  prio desc). Candidates: todo tasks with `est` and `due`, `remaining > 0`, not past events.
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
  (triage includes past meetings/appointments, `schedule.isPastEvent`)
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
- `addTask(state, partial, ctx)` (partial may include parsed quick-add fields; a
  recurring one becomes a chore, with `start` = its plan/due date when that is in
  the future, or a no-op with `duplicateOf: choreId` when an active chore with the
  same title (ignoring case and punctuation) exists: `ef add` then updates its
  cadence instead of adding a twin, and no new category is created)
- `completeTask(state, { id }, ctx)` / `reopenTask` / `dropTask` / `deleteTask`
- `moveTask(state, { id, to }, ctx)` (sets plan; later than before → `moved += 1`; clears triage)
- `moveBlock(state, { id, blockId, to }, ctx)` (block becomes `auto:false`)
- `toggleBlock(state, { id, blockId }, ctx)` (adjusts `spent`)
- `editTask(state, { id, patch }, ctx)` (a new title is also rewritten in that task's
  activity entries, sessions, the running clock and the brief, so a scrubbed
  identifier doesn't linger in history; same for chore and project renames)
- `toggleSub(state, { id, subId }, ctx)`, `addSub(state, { id, t, est }, ctx)`, `removeSub`
- `clockIn(state, { ref, title, cat, goal }, ctx)` (stops a running clock first, logging it)
- `clockOut(state, { markDone }, ctx)` → session (capped at `SESSION_CAP_MIN`, see
  Session); adds minutes to the task's `spent`; for a chore ref, marks the chore
  done on the day the session started
- `logTime(state, { ref, minutes }, ctx)`
- `choreDone(state, { id, date? }, ctx)` (optional past `date`; the log stays sorted
  and `last` is the latest date), `addChore` (no-op with `duplicateOf` for a
  same-title active chore), `editChore` (also `start`), `deleteChore`
- `addCategory(state, { name, group, color, aliases }, ctx)` (its `set` is
  `ifAbsent`), `editCategory`
- `addProject`, `editProject`, `toggleMilestone(state, { id, msId }, ctx)`, `addMilestone`
- `applyAllocation(state, { updates }, ctx)`
- `setBrief(state, brief, ctx)`, `editSettings(state, { patch }, ctx)`
- `scrubText(state, { find, replace }, ctx)`: removes `find` (case-insensitive,
  literal) from every stored text (tasks, chores, projects, cats, sessions,
  activity, clock, brief); logs one generic activity entry (`ef scrub`)
- `OPS` = `{ name: fn }` registry used by the website and the CLI.

### brief.js
- `buildBrief(state, { today, now })` → `{ headline, lines, asks, focus, text }`
  (the first ask flags a clock running past `SESSION_CAP_MIN`; focus excludes
  triage items)
- `changesSince(state, sinceIso)` → activity entries from the website since then, grouped
  (by device timestamp; `ef changes` only). A task that was dropped and then
  reopened (the toast's undo) nets out like done/undone.
- `changesBetween(before, after, { src })` → same shape, from activity ids in
  `after` but not in `before` (src `dash` by default, `'any'` for all); `ef sync`
  and `ef push` use it
- `missingCategoryCheck(state, today)` → questions about stale categories
- `commitMessage(activity[])` → one-line summary + bullet body for git

## Stores (`src/store/`)

```js
store = {
  mode: "github" | "local" | "readonly",
  load(),                 // Promise<State>
  subscribe(onState),     // called on every change; returns unsubscribe
  onStatus(cb),           // { kind: "synced"|"saving"|"pending"|"offline"|"error"|"readonly"|"conflict", at, message }
  apply(writes, activity),// optimistic local apply, then persist; rejects with
                          // err.code === 'not_loaded' until a load through the API succeeded
  refresh(),              // pull remote now
  getState(),
  isLoaded(),             // true once real state was loaded (a read-only fallback copy is not)
  hasPending(), flush(), dispose()
}
```
- `githubstore.js` `createGitHubStore({ owner, repo, branch, path, token, fetchImpl, debounceMs = 2500, pollMs = 45000, author, pendingStorage })`
  GET `/repos/{o}/{r}/contents/{path}?ref={branch}` (base64 JSON + `sha`),
  PUT the whole file with `sha`. `apply(writes, activity)` computes
  `after = applyWrites(state, writes)` and queues ONE batch per call =
  `diffWrites(state, after)` (collection `set`s marked `ifAbsent`, replayed
  create-if-absent) plus the activity ids it creates; it rejects with
  `err.code === 'not_loaded'` (`NOT_LOADED`, messages `LOADING_MESSAGE` /
  `NOT_LOADED_MESSAGE` or the load error) until a load through the API succeeded.
  Rebase: whenever a remote copy is taken (load, poll, 409/422, public fallback),
  batches whose activity ids are already in the remote file are dropped (they
  landed; `inc` and multiset adds must never replay twice), then
  `applyWrites(remote, queued)` in one call; 409/422 → refetch and retry (max 3).
  After a successful PUT, batches are removed by id. Commit message from
  `brief.commitMessage(pendingActivity)`. `author: { name, email }` goes in every
  PUT as both author and committer. Polls with `If-None-Match` ETag and on
  `visibilitychange`; the ETag only advances from responses the store uses, and a
  version it already left is re-read once before it can roll the board back. On a
  401/403/HTTP-error load the status stays `error` and the public raw file is shown
  read-only (writes still refused). Without a token it reads
  `https://raw.githubusercontent.com/{o}/{r}/{branch}/{path}` read-only. The token
  is never persisted by the store (`tokenStorage` is accepted and ignored).
  Crash net: each instance saves its queue under its own key
  `ef.pending.v2:{o}/{r}:{branch|~}:{path}#{id}`; a new store claims every matching
  key (and the old shared v1 key), re-saves under its own key, then deletes them;
  a disposed store stops writing storage and sending PUTs.
- `localstore.js` `createLocalStore(seedState, { key = "ef.state.v1" })`: localStorage
  (try/catch), for the offline preview and tests.

## CLI (`bin/`)

- `bin/ef.mjs`: the command line Claude runs every turn (`ef help`). Edits go
  through `OPS` with `ctx.src = 'chat'`. Text arguments come from argv (Claude
  single-quotes them) or, with a lone `-`, from stdin (`ef add - <<'EOF'`, one
  to-do per line), so the shell never expands Danny's text. Any command that
  changed nothing exits 1; ambiguous / unmatched task queries exit 2 with
  candidates.
- Git (never `reset --hard`): `ef sync` = `git pull --rebase --autostash origin
  <branch>` (network errors retried, nothing else), then reports
  `changesBetween(prePull, postPull)`. `ef push` = `git push`; on "fetch first /
  non-fast-forward" it pulls the same way and retries (max 5); a server-side
  rejection (`[remote rejected]`, rulesets, hooks) or a rejection while origin
  has nothing new exits 1; a conflict in a non-data file aborts the rebase and
  exits 3 (nothing lost). Both warn loudly when the checked-out branch is not
  origin's default branch (`git ls-remote --symref origin HEAD`, or `EF_BRANCH`)
  and never switch branches. Neither pulls **code** silently: before the rebase
  they fetch and, if origin changed anything outside `data/` since the merge base,
  pull nothing and print `CODE CHANGED ON GITHUB` with the files and commits (sync
  continues on local data; push exits 3) until rerun with `--allow-code`. The
  website's token can write the whole repo and lives in localStorage on the
  shared `dzweben.github.io` origin, and git runs `bin/ef-merge.mjs` from the work
  tree during the pull, so a leaked token must never become code Claude runs; a
  website (`dash:`) commit that touches code is flagged as a likely leak.
- `bin/ef-merge.mjs %O %A %B`: the `efstate` merge driver (see "The loop").
  `ef` registers it (`git config merge.efstate.driver`, `.git/info/attributes`)
  on every run; both-sides-changed fields are appended to `$EF_MERGE_NOTES`
  (JSON lines) for ef to print.

## Website (`src/ui/`)

Vanilla JS, bundled by esbuild into one inline `<script>` in `docs/index.html`.
`ctx.act` refuses writes (toast "Still loading your board…") until the current
store has delivered state, while it is in `error` after a failed first load, and
whenever `store.isLoaded()` is false (a read-only fallback copy is not a base to
write on); a store swap (new token / repo) starts unloaded again, and callbacks
from a replaced store are ignored. The GitHub store gets
`author: DEFAULT_CONFIG.author` (Danny Zweben, GitHub noreply address), used as
author and committer. Quick-add parses with `now`, so the preview and the saved
item agree.
`scripts/build.mjs --preview` embeds `data/state.json` as
`window.__EF_PREVIEW__` with every `<`, `>`, `&`, U+2028 and U+2029 written as a
`\uXXXX` escape, so no stored text can end or merge script tags.
See `src/ui/README.md` for the component contract and design.
