# EF Console UI: component contract + design brief

## Design brief: punk zine × hacked terminal

Danny asked for it to be **super punk-y and techy, fun to look at, and beautiful**.
The product is a **running to-do list** first; everything else supports it.

- Ground: photocopy-black with grain, halftone dots and CRT scanlines (`base.css` does this).
- Panels: hard black boxes, 2px rules, **sharp corners**, hard offset shadows
  (`.panel`, `.panel.is-pink|is-cyan|is-acid`). No rounded cards, no soft blur shadows.
- Neons from tokens only: `--pink` (accent, urgency, primary buttons), `--acid`
  (done, wins, streaks), `--cyan` (info, focus, links), `--hazard` (warnings,
  tape), `--blood` (overdue/critical). Category colors come from `cat.color`
  via `catStyle(cat)` → `--c`.
- Type: `--font-display` stencil (panel titles, uppercase), `--font-shout`
  condensed heavy (big numbers), `--font-mono` (labels, chips, inputs, data,
  times), `--font-body` (task titles, prose), `--font-scrawl` marker (Claude's
  notes, celebratory stamps, empty-state quips). Use scrawl sparingly.
- Punk devices (use with intent, not everywhere): `.tape` masking-tape labels
  (calendar day headers, section stamps), `.sticker` paper notes (Claude's brief),
  `.hazard` stripes (overdue section rule), `.glitch[data-text]` (logo + big
  moments), slight rotations (−2°…2°) on stickers/stamps only, `[ BRACKETED ]`
  mono labels (`.label.is-bracket`), `//` and `>` terminal prefixes.
- Techy devices: the quick-add is a terminal prompt (`> ` + blinking block
  cursor), mono readouts, segmented LED meters (`.meter`), timestamps, a sync
  status light.
- Motion: one orchestrated moment = the check-off (X slashes in, an acid
  "DONE" stamp thunks onto the row, a few square confetti bits). Everything else is
  fast and small. Respect `prefers-reduced-motion` (base.css already clamps).
- Phone first-class: at ≤720px the tab bar becomes a fixed bottom bar
  (`padding-bottom: env(safe-area-inset-bottom)`), the overview stacks to one
  column, touch targets ≥40px, the drawer becomes a bottom sheet. 16px side
  gutter; never horizontal page scroll (only `.hscroll` containers scroll).
- Copy: short, direct, a little punk. Buttons say what they do ("Done",
  "Push to tomorrow", "Start 5 min"). No emoji as section markers.
- Accessibility: every control is a real `<button>`/`<input>` with a label or
  `aria-label`; visible focus (`--focus-ring`); state shown by form AND color
  (e.g. overdue has the hazard stripe and the word OVERDUE).

## Files

```
src/ui/
  main.js            boot, store, ctx, tabs, render loop, overlays   (written)
  dom.js             h(), s(), mount(), catMark(), drag helpers       (written)
  template.html      page fragment; build inlines CSS + JS           (written)
  styles/tokens.css  design tokens                                    (written)
  styles/base.css    shared primitives                                (written)
  icons.js           icon(name) → inline SVG element
  views/header.js    mountHeader(el, ctx) → { update(ctx), tick(ctx) }
  views/taskrow.js   taskRow(task, ctx, opts) → Element
  views/today.js     renderToday(ctx) → Element
  views/brief.js     renderBrief(ctx) → Element
  views/deadlines.js renderDeadlines(ctx) → Element
  views/overview.js  renderOverview(ctx) → Element
  views/drawer.js    renderDrawer(ctx), renderMoveSheet(ctx), renderClockSheet(ctx) → Element
  views/calendar.js  renderCalendar(ctx, { days = 14, compact = false }) → Element
  views/chores.js    renderChores(ctx, { compact = false }) → Element
  views/projects.js  renderProjects(ctx, { compact = false }) → Element
  views/wins.js      renderWins(ctx, { compact = false }) → Element
  views/all.js       renderAll(ctx) → Element
  views/setup.js     renderSetup(ctx) → Element
  fx/burst.js        burst(el, color), stamp(el, text)
  styles/<view>.css  one stylesheet per view file (build concatenates all)
```

Each view returns a fresh Element on every render (main.js re-renders the
active view on every state/UI change, coalesced per animation frame). Views
keep no module-level mutable state except what's documented here; transient
UI state lives in `ctx.ui` via `ctx.setUI(patch)`. Text inputs that must keep
focus across renders live in the header (mounted once) or in overlays
(`renderDrawer` etc. — main.js re-renders overlays too, so overlay inputs keep
their in-progress values in `ctx.ui.drawerDraft` and restore focus by `id`;
see "Overlays" below).

Rules main.js and `dom.mount` enforce so a re-render never eats input:
- **Writes wait for the board.** `ctx.act` refuses (toast "Still loading your
  board…") until the current store has delivered real state (`ctx.loaded`), and
  while the store is in `error` after a failed first load (e.g. a rejected
  token, even if the store shows a read-only fallback). A new token/repo
  (`setToken`/`saveConfig`) starts a new store, unloaded again. Before load the
  quick-add preview says LOADING BOARD instead of guessing "new category".
- **No swap under a pressed pointer.** Renders are held from `pointerdown` until
  the click has run (or `pointerup` + 400ms with no click), so a field that
  commits on blur at mousedown can't replace the button being clicked.
- **Date/time fields keep their DOM while focused.** Rebuilding one resets its
  segment caret, so the view/overlay holding a focused `type=date|time` input is
  not re-mounted until focus leaves (focusout re-renders).
- **Re-render twins don't commit.** Chromium fires `change`/`blur` on a focused
  field while it is removed. `dom.mount` marks it (`isReplacing(el)`) when the new
  tree has a field with the same id; change/blur handlers skip committing then,
  because the twin shows the draft and gets focus back. When the field just goes
  away (overlay closed, tab switched), the change commits as usual.
- Text fields that save on leave keep typing in a draft: `ctx.ui.drawerDraft`
  (drawer) or `ctx.ui.drafts` via `setup.editField(ctx, key, stored, commit)`.
  Typed dates in the drawer commit on blur / Enter only, never mid-segment, and
  only when sane (`dom.isSaneDate`: year 1900–2199); picker picks commit at once.

## ctx (built by main.js `buildCtx()`)

```js
ctx = {
  state, today, now, tz,                // State, "YYYY-MM-DD", ISO, "America/New_York"
  vm: {                                  // precomputed engine views (memoized per state+today)
    today:     todayView(state, today),
    cal:       calendarView(state, today, 14),   // starts TODAY, rolling 14 days
    deadlines: upcomingDeadlines(state, today, 30),
    backlog:   backlog(state),
    projects:  projectView(state, today),
    chores:    choreView(state, today),
    risks:     risks(state, today),
    streak:    streak(state, today),
    week:      weekStats(state, today),
    heatmap:   heatmap(state, today, 12),
    wins:      wins(state, {}),
  },
  cat(id) → Category (falls back to inbox), cats,
  ui: { tab, drawer: {taskId}|null, move: {taskId, blockId}|null, clockSheet: {ref}|null, filters: {}, ... },
  loaded: bool,                          // false until the current store delivers its first state
  store: { mode: "github"|"local"|"readonly", status: {kind, at, message}, canWrite, refresh() },
  config: { owner, repo, branch, path, author }, hasToken,   // author: noreply identity for website commits
  act(opName, args, { toast, kind, undo }) → Promise<result|null>   // opName from engine/ops.js OPS
  setUI(patch), rerender(),
  openTask(taskId), openMove(taskId, blockId?), openClock(ref?), closeOverlay(),
  toast(message, { kind: "info"|"good"|"error", action: { label, fn }, ms }),
  fx: { burst(el, color), stamp(el, text) },
  icon(name) → SVGElement,
  setToken(token), clearToken(), saveConfig({ owner, repo, branch, path }),
}
```

Typical calls:
```js
ctx.act('completeTask', { id }, { toast: 'Done. Nice.', undo: () => ctx.act('reopenTask', { id }) })
ctx.act('moveTask', { id, to: '2026-10-07' }, { toast: 'Pushed to Wed' })
ctx.act('moveBlock', { id, blockId, to })
ctx.act('addTask', parsedFields)                // from parse.parseQuickAdd
ctx.act('clockIn', { ref: 'chore:c_laundry', title, cat, goal: 5 })
ctx.act('clockOut', { markDone: true })
ctx.act('choreDone', { id })
ctx.act('toggleSub', { id, subId })
ctx.act('editTask', { id, patch: { est: 60 } })
ctx.act('applyAllocation', { updates })         // from schedule.allocate
```

## Shared components

### `taskRow(task, ctx, opts)` (views/taskrow.js)
`opts = { block?: Block, context?: "today"|"calendar"|"all"|"project"|"deadline", showDate?: bool, compact?: bool, carried?: bool, overdue?: bool }`

Row layout (grid): `[check] [catmark] [title + meta line] [actions]`
- check: `<input type=checkbox class=check>`; toggles completeTask/reopenTask
  (for a block row: toggleBlock). On complete: `ctx.fx.burst(rowEl, 'var(--acid)')`
  and `ctx.fx.stamp(rowEl, 'DONE')` before the act resolves.
- title: body font; done → line-through in acid with the text dimmed.
  Click title → `ctx.openTask(id)`.
- meta line (mono chips): est/remaining (`45M`), block minutes (`BLOCK 1H`),
  due (`DUE FRI` / `DUE TODAY` hot / `OVERDUE 3D` crit), time (`3:30PM`),
  subtasks (`2/4`), moved (`PUSHED ×3` warn when ≥2), project name, carried
  (`FROM MON`).
- actions (always visible on touch, on hover/focus-within on desktop):
  `▶ 5` (clockIn with goal 5), `→` push (openMove), `✎` (openTask).
- draggable on desktop: `draggable=true`, `setDragData(ev, { taskId, blockId })`.
- data attributes: `data-task-id`, `data-block-id`.

### Drag and drop
Payload `{ taskId, blockId|null }` via `setDragData/getDragData` (dom.js).
Drop targets: calendar day cells (and the "Today" panel header). Dropping a
block → `moveBlock`; a task → `moveTask`. Highlight the target with a dashed
pink outline while dragging over.

## Overlays (views/drawer.js)

- **Task drawer** (`ctx.ui.drawer = { taskId }`): right-side panel on desktop
  (min(440px, 100vw)), bottom sheet on phone (max-height 86vh, scroll inside).
  Fields: title, category (select of cats grouped by group), plan date, due
  date, time, estimate (`parseDuration` input, e.g. "1h30"), priority (4
  segmented buttons), notes (textarea), subtasks (check list + add input),
  blocks (list with date + minutes + done check; "Auto-plan" button runs
  `schedule.allocate(state, { today, taskIds: [id] })` then
  `act('applyAllocation', { updates })`), and actions: Done, Drop, Delete
  (two-step: first click turns the button into "Really delete?"; opening or
  closing any overlay disarms it). Save on
  change of each field (blur/change → `act('editTask', ...)`), not on every
  keystroke. Escape / backdrop click closes.
- **Move sheet** (`ctx.ui.move = { taskId, blockId }`): quick picks Today,
  Tomorrow, +2 days, Next Mon, This weekend, plus the 14 day chips from
  `ctx.vm.cal` (each with its load meter) and a native `<input type=date>`.
  Picking one runs moveTask/moveBlock and closes with a toast. A date typed or
  picked in the date field is kept on `ctx.ui.move.date` until Move is tapped.
- **Clock sheet** (`ctx.ui.clockSheet = { ref }`): the "just 5 minutes"
  picker. Big copy: "5 minutes. That's it." Suggestions: due chores first
  (from `ctx.vm.chores`), then today's tasks; a free-text "something else"
  field. Start → `act('clockIn', { ref, title, cat, goal: 5 })`.

Overlay root element: `h('div.overlay-root', …)` containing a backdrop
`button.overlay-backdrop` (aria-label "Close") and the sheet. Inputs inside
overlays must have stable `id`s; on re-render, restore focus to
`document.activeElement.id` if it existed (main.js does not do this for you;
drawer.js does it after building).

## Header (views/header.js) — mounted once

`mountHeader(el, ctx)` builds static DOM once and returns
`{ update(ctx), tick(ctx) }` (`update` on every render, `tick` every second for clocks).
- Left: logo `EF//CONSOLE` (`.glitch` with `data-text`), under it
  `DANNY // MON 10.05 // 09:41:07 ET` in mono.
- Sync light: a square LED + label from `ctx.store.status.kind`
  (`SYNCED` acid, `SAVING…` cyan blinking, `PENDING` hazard, `OFFLINE`/`ERROR`
  blood, `READ-ONLY` ink-3 with a "Connect" link to Setup). Click → `ctx.store.refresh()`.
- Quick-add terminal (the hero of the page): a wide input styled as a
  terminal line: `> ` prompt in pink, mono text, blinking block cursor when
  empty and unfocused, placeholder `email mike - tomorrow`. Under it a live
  parse preview row of chips (category with its color, PLAN/DUE date as
  `fmtDay`, time, estimate, priority, recurring) from `parseQuickAdd`.
  Enter → `act('addTask', fields)` (or `addChore` when `recurring`) → clear,
  toast "Added: Email Mike → Tue 10/6". `#newtag` that matches nothing → the
  preview shows `NEW CATEGORY: newtag` and adding creates it first
  (`act('addCategory', { name })`). Keyboard: `/` or Ctrl/Cmd+K focuses it.
- Vitals strip (re-rendered by `update`): 5 readouts in a row (2×3 grid on phone):
  TODAY `done/total` with an LED meter; OVERDUE count (blood when >0, with hazard
  stripe); DUE 7D count; LOAD today `planned/cap` minutes meter (hot when >100%);
  STREAK `N DAYS` in acid shout type.
- Clock widget: if `state.clock.active`: title, elapsed `MM:SS` counting up
  in shout type, a ring/meter toward `goal` minutes, buttons Stop (clockOut)
  and Done (clockOut markDone). When elapsed passes the goal, the copy flips to
  "5 MIN DONE. KEEP GOING?" in acid. If no clock: a big pink button
  `▶ JUST 5 MIN` → `ctx.openClock()`.

## Overview (views/overview.js) — the default tab

Desktop ≥1100px, 12-column grid, gap 20px:
```
[ Today (cols 1–7, rows 1–2)          ][ Claude brief sticker (8–12) ]
[                                     ][ Chores / 5-min (8–12)        ]
[ 14-day calendar (1–12), compact                                     ]
[ Deadlines radar (1–6)               ][ Projects compact (7–12)      ]
[ Wins compact (1–12)                                                 ]
```
720–1100px: two columns; ≤720px: one column in this order: Today, Brief,
Chores, Calendar, Deadlines, Projects, Wins. Before `ctx.loaded`, render
skeleton panels with a mono `LOADING…` scanline shimmer.

## Today panel (views/today.js)

Title `// TODAY` + `fmtDay(today)` tape + `done/total`. Sections in order,
each only if non-empty, each with a mono header + count:
1. **DID THESE HAPPEN?** (triage) — rows with three inline buttons: `✓ Yes`
   (completeTask), `↻ Today` (moveTask to today), `✕ Drop` (dropTask).
2. **OVERDUE** — hazard stripe rule above, rows with `OVERDUE Nd` crit chips.
3. **DUE TODAY**
4. **MEETINGS** (sorted by time)
5. **PLANNED**
6. **WORK BLOCKS** (taskRow with `opts.block`; checking toggles the block)
7. **ROLLED OVER** (carried, with `FROM <weekday>` chip and a one-tap `→ Tomorrow`)
8. **DONE TODAY** (collapsed by default to a count + toggle; acid strikethrough)
Empty state when nothing is open: a `.sticker` with scrawl "Clear board." and
a hint to type a to-do above. Panel header is a drop target (drop → move to today).

## Brief (views/brief.js)

`.sticker` (paper, tape strip, −0.6° rotation) titled `CLAUDE SAYS` in mono,
`headline` in scrawl, `lines` as a tight list, `asks` as `?` lines in pink,
and `updated 2h ago` (`fmtRelative` on the ISO date + time). No brief →
sticker saying "No check-in yet. Message Claude: what's due today?".

## Deadlines (views/deadlines.js)

`// INCOMING` list from `ctx.vm.deadlines` (next 30 days): each row = catmark,
title, `DUE <fmtDay>` and `Nd` countdown in shout type (pink ≤2d, hazard ≤7d),
a runway meter of allocated vs remaining minutes, a status chip
(`OK` acid, `TIGHT` hazard, `AT RISK` blood, `UNPLANNED` hot, `NO ESTIMATE` warn),
and an `AUTO-PLAN` button for at-risk/unplanned ones
(`schedule.allocate` + `applyAllocation`). Show `ctx.vm.risks` of type
overbooked as a hazard line at the top.

## Calendar (views/calendar.js)

Rolling 14 days starting today (`ctx.vm.cal`), 2 rows × 7 columns on
desktop; on phone a vertical list of days (one per row, horizontal chip
wrap). Each day cell: `.tape` header with weekday + date (today's tape is
pink with "TODAY"), a load meter (`load.total / load.cap`, hot >100%,
blood >130%), deadline pins first (◆ DUE + title, pink), meetings with time,
then plan chips and block chips (catdot + title + minutes), then chores due
that day as small dashed chips. Chips are draggable; cells are drop
targets. Click a chip → openTask. Weekend columns slightly darker; off days
hatched. Compact mode (overview): max 4 chips per day + `+N more` button that
switches to the Calendar tab. Full mode also shows the backlog (`ctx.vm.backlog`)
as a draggable strip "UNSCHEDULED" under the grid.

## Chores (views/chores.js)

`// CHORES` + subtitle "5 minutes counts." Each active chore = tile: catmark,
title, `every` cadence (`DAILY ×2`, `WEEKLY`, `EVERY 3D`), a decay meter
(urgency: acid fresh → hazard due → blood overdue), "last: 3d ago", buttons
`DID IT` (choreDone; acid flash) and `▶ 5 MIN` (clockIn goal = chore.min).
Daily chores with perDay>1 show pips (● ● for done today vs target). Full
mode adds an inline "add chore" form (title, every N days) → `addChore`.

## Projects (views/projects.js)

Long-term projects, light: a card per active project — name in stencil,
catmark, goal line, progress `pct` as a big shout number + segmented meter,
milestones as a vertical checklist (toggleMilestone), next milestone
highlighted, open/done task counts, `due` countdown if set. Compact mode: top
4 by nearest due/next milestone, no milestone list (just next milestone).
Full mode adds paused/done sections and "add project" (name, category) →
`addProject`, and "add milestone" inline.

## Wins (views/wins.js)

The accomplishments wall: big `STREAK N` (acid shout) + best, this week's
done count + minutes logged, a 12-week heatmap grid (7 rows Mon–Sun ×
weeks; cell color = acid at opacity by count, today outlined pink, tooltip
`title` with date + count), per-category done bars this week (catdot +
bar), and a scrolling list of recent wins (`ctx.vm.wins`, milestones
stamped "MILESTONE"). Compact mode: streak + heatmap + last 5 wins.

## All tasks (views/all.js)

Filter bar: search input (id `all-search`, filters by title/notes), status
toggle chips (OPEN / DONE / DROPPED / ALL), category chips (multi-select,
colored), sort select (due, plan, category, newest). Results grouped by
category group with counts, each a `taskRow(context: 'all', showDate: true)`.
Filters live in `ctx.ui.filters`.

## Setup (views/setup.js)

1. **GitHub connection**: explains in two lines that the site saves to
   `data/state.json` in the repo as commits under Danny's name. Shows
   owner/repo/branch/path (editable, Save → `ctx.saveConfig`), a password
   input for a fine-grained token (Save → `ctx.setToken`, Forget →
   `ctx.clearToken`), a link to `https://github.com/settings/personal-access-tokens/new`
   with the exact scopes ("Only select repositories → ef-dashboard-management;
   Repository permissions → Contents: Read and write"), and the current status.
2. **Categories**: grouped list; each row: color input (`<input type=color>`),
   name input, group select, glyph input (≤3 chars), aliases (comma list),
   archive toggle → `editCategory`. Add-category form → `addCategory`.
3. **Capacity**: 7 weekday number inputs (minutes) → `editSettings({ patch: { cap } })`.
4. **Chores**: list with every/perDay/min edits, deactivate → `editChore`.
5. About: build info, link to the repo, "Refresh now" button.

## FX (fx/burst.js)

- `burst(el, color)`: ~14 small squares (4–7px) burst from the element's
  checkbox position, gravity, fade, 600ms, CSS transforms only; positioned
  `fixed` from `getBoundingClientRect()`; removed after. No-op under reduced motion.
- `stamp(el, text)`: a rotated (−8°) bordered acid/pink stamp with `text` in
  stencil type, scales from 1.6 → 1 with a thunk, stays 700ms, fades. Appended
  to `document.body` at the element's position.
