# Morning brief: the whole Linear queue

Someone who triages work adds issues to the developer's Linear queue over time, mostly at low priority, and raises one
when it becomes urgent, sometimes from one day to the next. They expect the developer's agent to know, each morning,
everything in the queue and at what priority. The Morning brief's queue is how Follow-up knows: it sweeps the whole
queue every workday morning, keeps a snapshot, and says what changed since the developer last looked ("ACME-142 raised
Low → High since Friday").

Files: `shared/linear-queue.ts` (pure: the snapshot's schema, the clock, the diff and "since"), `server/linear-queue.ts`
(`LinearQueue`: the sweep, the store, the views), on top of New's Linear reader (`server/linear-issues.ts`,
`shared/linear-issues.ts`; one reader, never a second one). Data: `linear-queue.json` ([data-files.md](data-files.md)).

This is phase 1 of the brief's upgrade. The brief's "Since" block, the queue screen and the Needs-you item for an issue
raised with no workspace come next (they build on New's dialog and actions), then Settings → Morning brief with the
weekly plan's link, then every source the proxy can reach, then Ask for sources Follow-up doesn't know.

## The sweep

- **What it reads:** for each state type that counts as the queue (Triage, Backlog, Todo, In Progress by default),
  `linear:list_issues {assignee: "me", state, orderBy: "createdAt", limit: 25, fields: QUEUE_FIELDS}`, following the
  cursor until Linear says there is no next page. Pages stay at 25 because mcpproxy cuts replies near 20 k characters.
  A queue of 150 costs about 7 reads. **By creation time, never update time:** an issue updated while the sweep walks
  (raised mid-sweep, the very event the brief is for) would jump to a page already read and be missed. Creation order
  doesn't move. (New's list keeps `updatedAt`: it reads one page, not a walk.)
- **A cut-off page** (`parseIssuePage(...).whole` false: the JSON didn't parse and only whole issues were salvaged) is
  read again with 10, then 5 issues. Still cut off, the sweep is partial: its end can't be trusted.
- **Bounded:** at most `QUEUE.pagesMax` (40) pages across every state. Past that the sweep is partial ("1000+ issues").
- **Issues that left:** an issue in the last complete sweep that is missing now gets one `get_issue` (the most urgent
  `QUEUE.lookupsMax`, 20, a sweep) to say why: done, canceled, reassigned (to whom), moved to a state that isn't the
  queue, or gone. The rest read "left your queue".
- **A missed read is not a leave:** a lookup that finds the issue still in a queue state and assigned to the developer
  means the walk missed it (a page that moved under it). It goes back into this sweep with the lookup's facts, and
  nothing is logged for it beyond what really changed. "Assigned to the developer" is exact, not a name match: the
  lookup asks for `assigneeId`, compared with the developer's Linear user id from `linear:get_user {query: "me"}`
  (read-only; one call, only in a sweep that has issues to look up, then cached in `linear-queue.json` as `viewer`).
  With no viewer id (the read failed) the issue reads as left, as before.
- **Who raised it** isn't read: Linear's `get_issue` history (`stateHistory`) records workflow states, not priority
  changes, so the brief says "raised Low → High" without a name.
- One sweep at a time; a second caller joins the one in flight. Every call is a short `mcpproxy call tool-read`
  process with a 20 s bound, as the Summary's are.

## The snapshot and the log

`linear-queue.json` keeps the last two complete sweeps and a 14-day log. Each log entry is one issue's change between
two complete sweeps: its facts (priority, due date, state) before (none: it is new) and after (none: it left), plus why
it left. The log is what answers "since Friday" on a Monday.

**`the-queue-is-whole`** (invariant 76): the sweep reads every page or says it is partial, and a partial sweep never
replaces a complete one (it is kept only while there is no complete sweep at all). A failed sweep keeps the last
complete snapshot; the status says which one is showing (`stale`). A missed read is never a change: an issue the walk
missed but a lookup finds still the developer's, in a queue state, is neither "left" nor, next sweep, "new".

## What changed, and since when

`changesSince(log, since)` folds every entry after `since` per issue: its facts before its first entry against those
after its last, so Low → Medium → High reads "raised Low → High" and a raise taken back reads as nothing. Kinds: new,
raised, lowered, due (added, moved or removed), state, left. They're ordered most urgent first across kinds (priority,
then the nearest due date), issues that left last: a new Urgent issue sits above a Low → High raise.

**`a-change-is-against-what-you-last-saw`** (invariant 77): "since" is a stored point, never "the last 24 h". It is the
time the developer last read the brief before this viewing session (`seen.prior`): opening the brief (`follow.linear-queue`
with `open: true`) records `seen.at`, and an open more than `QUEUE.sessionGapMs` (4 h) after the last one starts a new
session, moving `prior` up. So the changes stay on screen while the developer reads, and the next morning shows what
moved since. With no read yet it falls back to the last workday's sweep (`workdaySince`: the newest sweep from before
today). An agent's read (`linear_queue`) never moves it.

## When it runs

**`the-brief-has-one-timer`** (invariant 78): the sweep runs only

- once each workday at the sweep time (07:00 in the developer's zone by default), from the worker's existing 15 s loop
  (`LinearQueue.tick`, no timer of its own), while the governor allows background work. A host that was off at 07:00
  sweeps at its first tick after; a tight governor makes it wait, still due;
- when the developer opens the brief and the last complete sweep is older than `QUEUE.staleMs` (6 h), in the
  background, so the reply doesn't wait on Linear;
- on Sweep now (`sweep_queue`), which waits up to 45 s and then answers `running`;
- once, when the ranker runs with no snapshot at all (a fresh install).

Nothing reads Linear while the brief is closed except the morning sweep.

## The clock

"07:00", "today" and "a workday" are in the developer's zone: Settings → Morning brief's zone when set (next phase),
else the zone the developer's device reports (`follow.client-time-zone`), else the host's own. The workdays are the
zone's usual week (Sunday to Thursday where the weekend is Friday and Saturday, from CLDR's week data; Monday to Friday
elsewhere) until the setting says otherwise. The ranker's automatic runs use the same clock. Nothing names a fixed zone.

## Who reads it

- **The ranker** (`forRanker`, [ai-roles.md](ai-roles.md#priority-ranker-beta)): the queue's top 40 by priority plus
  every issue changed since the last workday's sweep (stable all day, so opening the brief doesn't re-rank), each with
  its change. Its "not started" list is read from the queue: Urgent, or raised to High or Urgent, with no workstream.
- **Agents:** `linear_queue` (read: the queue by priority, filtered all / no-workspace / changed, each issue's workspace
  or none and its change, the changes since, the sweep's health) and `sweep_queue` (planned). The Overseer, untracked
  root agents and main agents get them; contributors, recovery agents and subagents don't (invariant 4).
- An issue "has a workspace" when an unarchived workspace has its key linked (New's rule).

## Cost

| | Reads | Model calls |
| --- | --- | --- |
| A morning sweep of 150 issues | about 7, plus up to 20 for issues that left (and one `get_user`, once ever) | 0 |
| The ranker | none of its own (it reads the snapshot) | unchanged |

Idle, the queue costs one file stat per 15 s tick. Tests: `tests/linear-queue.test.ts`, `tests/ranker.test.ts`.
