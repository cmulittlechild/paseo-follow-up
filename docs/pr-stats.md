# PR statistics

PR statistics answer "who opened the most PRs this week" and "whose PRs wait longest for a first review" for
repositories the developer turns on, one at a time. The team, the bots and the numbers all come from the repository's
own data: nothing is built in (invariant 24).

Status: the data layer (records, store, sync and the GitHub budget gate). Nothing calls it yet; the settings, agent
tools and the page build on it.

## Files

| File | What it is |
| --- | --- |
| `shared/pr-stats-records.ts` | The compact record kept per PR, its schema, and `parseStatsRecord` from the page query's nodes (`readyAtOf`, bots, the review follow-up's `withAllReviews`). |
| `server/pr-stats-gate.ts` | `StatsGate`: the one gate every stats request passes, and the rolling-hour ledger of what stats spent. |
| `server/pr-stats-store.ts` | `StatsStore`: one file per repository, loaded only for a read (an LRU of two, dropped after five minutes), saved through `WriteBehind`. |
| `server/pr-stats-sync.ts` | `StatsSync`: the incremental and backfill walks, page halving, review follow-ups and retention. |
| `tests/support/fake-stats-github.ts` | A fake GitHub with a fictional `example/app` of 300 PRs (stacks, bots, drafts, deleted users, busy PRs). |

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
