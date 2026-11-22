# PR statistics

PR statistics answer "who opened the most PRs this week" and "whose PRs wait longest for a first review" for
repositories the developer turns on, one at a time. The team, the bots and the numbers all come from the repository's
own data: nothing is built in (invariant 24).

Status: the data layer, the metrics, the settings (Settings → Following → PR statistics) and the agent tools
(`pr_stats`, `pr_stats_settings`, `set_pr_stats`). The page builds on them.

## Files

| File | What it is |
| --- | --- |
| `shared/pr-stats-records.ts` | The compact record kept per PR, its schema, and `parseStatsRecord` from the page query's nodes (`readyAtOf`, bots, the review follow-up's `withAllReviews`). |
| `shared/pr-stats.ts` | The metrics: pure functions of the records, a period, the settings and `now` (`statsModel`, `personDetail`, `periodRange`, `WorkingClock`). |
| `shared/pr-stats-settings.ts` | `stats.json`'s schema, `set_pr_stats`'s input, the RPC outputs and Settings' words (`statsRepoLine`, `statsRepoWait`, `estimateLines`). |
| `server/pr-stats.ts` | `PrStats`: the settings file, the opt-in estimate, the model reads, and when syncs run. |
| `client/pr-stats-settings.tsx` | Settings → Following → PR statistics and the opt-in sheet. |
| `server/pr-stats-gate.ts` | `StatsGate`: the one gate every stats request passes, and the rolling-hour ledger of what stats spent. |
| `server/pr-stats-store.ts` | `StatsStore`: one file per repository, loaded only for a read (an LRU of two, dropped after five minutes), saved through `WriteBehind`. |
| `server/pr-stats-sync.ts` | `StatsSync`: the incremental and backfill walks, page halving, review follow-ups and retention. |
| `tests/support/fake-stats-github.ts` | A fake GitHub with a fictional `example/app` of 300 PRs (stacks, bots, drafts, deleted users, busy PRs). |

## Turning it on (opt-in per repository)

Nothing is on in a new install, and nothing is read until a repository is turned on.

- **Settings → Following → PR statistics** (after Shipping PRs) lists every repository Follow-up knows (tracked PRs,
  project remotes, Shipping PRs' list) with a switch, plus a field to add another `owner/repo`. Each row says where it
  is: "On · 3,248 PRs · 90 days · 1.0 MB", "On · reading · back to Oct 3 · ≈ 1,240 of 3,250 PRs", "Paused · data up
  to Nov 2", or "Off", and why it isn't reading (GitHub limit low, the machine busy, the hour's share used, or a read
  error).
- **The opt-in sheet** (the switch turns on only from its Turn on): about N PRs changed in the last 90 days (one
  `search(issueCount)`, 1 point, through the gate), what reading them costs against the share of the hourly limit,
  that stats pause under 40 %, and what is stored where. A repository the token can't read is refused there with the
  reason, and Turn on stays off.
- **Turning off** asks in place: "Turn off, keep data" is the bordered default (the repository shows "Paused · data up
  to <date>", stays readable and isn't read); "Also delete the N PRs" is the quiet red extra and removes the file at
  once.
- **Options**: per repository, its history (30, 90 or 180 days), its team (everyone, picked people, or a GitHub team
  `org/slug`) and who is hidden (logins, `*` wildcard; bots always are); host-wide, the GitHub share (1-10 %, 5 % by
  default), the clock (calendar time or working hours on one schedule in the developer's zone) and whether stacked PRs
  count fairly (on by default).

Agents do the same (invariant 3): `pr_stats_settings` reads it (`estimate: true` with a `repo` for the sheet's
numbers) and `set_pr_stats` changes it as a planned write whose dry run shows the estimate before `enable: true`.
`pr_stats` reads the model: a period's people and team numbers, a person's drill-down, the PRs waiting for a first
review now with their urls (invariant 23), and `fresh: true` for one incremental sync first. Read tools go to the
Overseer and untracked root agents with the other action tools.

## When it syncs

`PrStats.tick()` rides the engine's loop: no timer of its own, never awaited by the loop. A repository that is on
syncs every 5 minutes until its backfill is done, then hourly while nobody looks (~1-2 points an hour), and every 5
minutes while its page is on screen (`watching`). One repository at a time; every request through the gate. A GitHub
team filter's members are read once a day (1 point); a token that can't read the team leaves the filter showing
everyone and says so in one line (invariant 71, `stats-learn-the-team-from-the-data`).

## The query

One query, keyset-paged by update time, newest first (`statsPageQuery`): each PR's numbers, times, author, branches,
its first 20 reviews (author, state, time), first 10 comments (author and time only), and its first 25 draft, ready,
review-requested and request-removed events. GitHub reports its cost in the same answer (`rateLimit { cost }`).
Measured 2026-11-22 on public repositories: **1 point per page of 25**, so about 4 points per 100 PRs; a 90-day
backfill of an 800-PR repository cost 33 points.

A PR with more than 20 reviews gets one follow-up read for all of them (`statsReviewsQuery`, ten PRs per query by
alias). A 502 or `RESOURCE_LIMITS_EXCEEDED` halves the page for that repository (25, 12, 6, 5) until a page succeeds;
three failures in a row end the run with the error kept on the repository.

## The sync

Two walks share one file per repository:

- **Incremental**: from the newest PR down to the high-water mark minus two minutes (`OVERLAP_S`), then the mark moves
  to the newest update seen. Usually one page. If the gate stops it partway, it resumes from its cursor on the next
  run and only then moves the mark.
- **Backfill**: from its saved cursor until updates are older than the window (90 days by default), at most
  `BACKFILL_PAGES_PER_RUN` pages a run, recording how far back it reached (`coveredTo`) so the page can say "back to
  Oct 3" honestly.

GitHub's cursors on `UPDATED_AT` carry the sort key, so a PR updated during a walk jumps to the front, where the next
incremental pass reads it, and nothing else shifts. Each run drops records older than the window; past
`STATS_RECORDS_MAX` (25,000) the oldest go first and `cappedTo` says to which date.

## The budget gate

Every request, pages and follow-ups alike, goes through `StatsGate.run` (invariant 67,
`stats-never-spend-below-low`). It refuses, sending nothing, when:

1. the governor holds background work (`allowsBackground()`);
2. the account's budget tier isn't `normal`, so stats stop with 40 % of GitHub's hourly limit left, far above the 20 %
   reserve the PR poller and agents' own `gh` calls depend on;
3. the stats slice is spent: the cost of stats answers in the last rolling hour plus the next page's expected cost
   would pass `slice × limit` (5 % of 5000 = 250 points by default, 1–10 % allowed);
4. another stats request is in flight.

The ledger and the one-in-flight rule are worker-wide, stricter than per account. Every answer's `rateLimit` goes to
`Github.noteRateLimit`, the same per-owner budget the PR poller reads, and a rate-limit refusal goes to
`Github.noteLimited`, so a burst either one sees throttles both. A refused run stores why and when it reopens
(`meta.waiting`: `governor`, `budget` with GitHub's reset, `slice` with the time the hour's oldest spending rolls off,
or `busy`).

## Metrics

Every number is a pure function of the records, the period, the settings and `now` (`shared/pr-stats.ts`), computed
when it is read. `statsModel` returns what the leaderboard, its header and `pr_stats` show for one period;
`personDetail` one person's drill-down.

- **People.** A person is a login. Bots were dropped at parse time; the repository's ignore list (case-insensitive,
  `*` wildcard, `ignored`) drops service accounts everywhere. A deleted user's PRs count in team totals
  (`deletedUsers`) and never make a row. With a team filter only its people count.
- **Periods** (`periodRange`, D9): This week (from the week's first day, Monday by default, 00:00 in the time zone),
  Last week, 30 days and 90 days. `previousRange` is the same length right before.
- **Clocks** (invariant 70, `stats-measure-from-the-ask`). Every review clock starts at `reviewStart`: the ask, and
  for a stacked PR (stack-aware, the default) no earlier than its parent's first response, or its parent's merge
  without one. Calendar seconds by default; working seconds (`WorkingClock`: one weekly schedule in one zone,
  Mon-Fri 9-18 by default, each local day's hours computed in the zone so DST is exact) as a setting. A working
  clock is built once per read, so 10,000 records compute in about 50 ms either way.
- **Stacks** (`stackParents`, `derive`): a PR whose base isn't the default branch and is another PR's head has that
  PR as its parent (the newest created before it, when a branch name was reused). Parent chains created within 24 h
  are one stack, so counts can say "9 PRs in 2 stacks" (`openedStacks`, `reviewStacks`; a lone PR is a stack of one).
- **Aggregates**: nearest-rank median and p75 (the ⌈p·n⌉-th smallest) with n (`summarize`); a surface shows "-" with
  n below `MIN_N` (3) and mutes below `FEW_N` (5). Never a mean.

| Metric | What it counts |
| --- | --- |
| Opened (M1) | PRs created in the period, drafts included, per author; with stacks. |
| Merged (M2) | PRs merged in the period, per author. |
| Wait for first review (M3) | For PRs whose first response (the earliest review or comment by someone else, from ready on) is in the period: response minus `reviewStart`. Per author (they waited) and team. |
| Waiting now (M4) | Open, not draft, clock started, no response: longest first, with who it waits on (requests minus removals). A stacked PR whose parent is still waiting is folded under it (`above`); one not updated in 30 days folds into `stale`. Independent of the period. |
| Reviews given (M5) | Per reviewer, distinct PRs of others whose first review by them is in the period. |
| Review turnaround (M6) | Per reviewer, from each request naming them (or ready, or the stacked start, if later) to their next review, for reviews in the period; a team request never counts for a person; a request removed before the review doesn't count. |
| Time to merge (M7) | Merged in the period: merge minus the ask (stacked: minus the parent's merge, if later). |
| First review to merge (M8) | Merged with a response: merge minus the first response. |
| Merged without review (M10) | A count, never a ranking. |
| Size (M9) | Lines added plus deleted, bucketed XS < 10, S < 50, M < 250, L < 1000, XL. |

## Records and privacy

A record (`StatsRecord`) holds numbers, epoch-second times, logins, branch names and the title capped at 120
characters. Never a body, a comment's text, a diff or a file list (invariant 69, `stats-records-hold-no-text`).
Bots by GitHub's type or a `[bot]` login are dropped wherever they act on a PR; a bot's own PR is kept with `ab` so
totals can say how many were left out. A human-looking service account is the repository's ignore list's job, applied
when metrics are computed. A deleted user's PR has author `null`. A 50-person team's 90 days are about 3,250 records,
~1 MB on disk.

What each record keeps for the clocks: `r` (ready: the first ready event if the PR opened as a draft, else its
creation, null for a draft that never was ready), `k` (asked: the first review request, counted from ready when made
on a draft, else ready itself), every request and removal, each reviewer's review times, and each commenter's first
comment from ready on.

## Resources

Invariant 68 (`stats-are-computed-on-read`): records are in memory only while something reads or syncs them.
`StatsStore.open` loads a file and keeps it in an LRU of `STATS_LOADED_MAX` (2) repositories, each dropped
`STATS_KEEP_MS` (5 minutes) after its last use. A save goes through `WriteBehind` as parts, each record's bytes encoded
once per record object, so a page re-encodes the PRs it changed, never the whole file; a record equal to the stored
one keeps the stored object.

## Tests

- `tests/pr-stats-gate.test.ts`: zero requests at the low, reserve and critical tiers, with the governor holding
  background work, with the slice spent, or with a request in flight; the shared budget moves both ways.
- `tests/pr-stats-budget.test.ts`: six hours of syncs every five minutes on a 3,250-PR repository never spend more
  than the slice in any rolling hour, and the backfill still finishes.
- `tests/pr-stats-sync.test.ts`: the first backfill reads exactly the window, incremental overlap, a backfill resumed
  after a restart, page halving, repeated failures, a repository the token can't read, review follow-ups, retention.
- `tests/pr-stats-records.test.ts`: ready and asked times, bots, the author's own replies, deleted users, the store's
  file format and its LRU.
- `tests/pr-stats-privacy.test.ts`: the queries ask for no text, and a stored record has only the schema's fields.
- `tests/pr-stats-service.test.ts`: an empty install reads nothing; the estimate and its refusal; on, synced on the
  loop's tick, hourly, every 5 minutes while viewed; off keeps the data, delete removes it; the team filter.
- `npm run test:scale` seeds one repository that is on with 3,250 records (`scripts/scale-seed.ts`, `STATS_SEED`):
  with the page closed the worker never loads it, and idle RSS and CPU stay inside the budgets.
- `tests/pr-stats-metrics.test.ts`: a table per metric: drafts, ready and ask times, bots, the ignore list, deleted
  users, the team filter, stack-aware starts and folding, removed requests, working hours across a weekend and both
  DST changes, periods in a zone, nearest-rank, and 10,000 records.
