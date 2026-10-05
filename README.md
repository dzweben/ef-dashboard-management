# EF Console

Danny's running to-do list, 14-day calendar, chores clock-in, wins wall, and
long-term projects, with Claude as the chat front end.

- **Website:** https://dzweben.github.io/ef-dashboard-management/
  Check things off, drag them between days, add to-dos from the terminal bar
  (`email mike - tomorrow`), hit "just 5 min" to clock in on a chore. Every
  change is saved as a commit to this repo under Danny's name.
- **Chat:** tell Claude things like `email mike - tomorrow`, `what's due today?`,
  `push the RSA intro to thursday`, `starting laundry`. Every turn Claude pulls
  your website changes, updates the list, plans time for big deadlines, writes
  a check-in that shows on the site, and commits + pushes.
- **Database:** `data/state.json`. Git history is the track record.

## One-time setup

1. **Turn on the website.** Repo **Settings → Pages → Build and deployment →
   Source: Deploy from a branch**, branch = the default branch, folder = `/docs`
   → Save. The site appears at the URL above within a minute or two.
2. **Let the site save.** Create a fine-grained token at
   https://github.com/settings/personal-access-tokens/new
   - Repository access: **Only select repositories → ef-dashboard-management**
   - Repository permissions: **Contents → Read and write**
   - Expiration: up to a year
   Open the site → **Setup** → paste the token → Save. It's stored only in
   that browser. Do this once per device (phone + laptop).
3. **Privacy.** The repo is public right now, so anyone could read
   `data/state.json`. Making it private keeps the data private (the site then
   reads it with your token). GitHub Pages on a private repo needs GitHub Pro,
   which is free with the GitHub Student Developer Pack.

## Talking to Claude

| You say | What happens |
|---|---|
| `email mike - tomorrow` | to-do on tomorrow, filed under Admin |
| `RSA intro draft by fri ~3h` | deadline Friday, 3h booked across the days before |
| `meet with teij thu at 3pm` | meeting on Thursday at 3pm |
| `walk ziggy 2x a day` | a daily chore with two check-ins |
| `#predis pick committee - next week` | explicit category with `#` |
| `done with the dentist call` | checked off |
| `push the OCD script to wednesday` | moved (Claude tracks how often things get pushed) |
| `starting laundry` | clocked in for 5 minutes. Just start. |
| `what's due today?` / `what's coming up?` | the board, deadlines, and the next 2 weeks |

## Developing

```bash
npm install          # esbuild (only needed to rebuild the website)
npm test             # engine + store + CLI tests
npm run build        # src/ui → docs/index.html (the website)
node bin/ef.mjs help # the CLI Claude uses every turn
```

- `docs/ARCHITECTURE.md`: data shapes and every module's API
- `src/engine/`: pure logic shared by the website and the CLI
- `src/store/`: GitHub-backed store (Contents API, optimistic saves, conflict merge)
- `src/ui/`: the website (`src/ui/README.md` is the design brief)
- `CLAUDE.md`: how Claude runs each turn
