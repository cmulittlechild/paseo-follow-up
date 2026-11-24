# Morning brief: the whole Linear queue

Someone who triages work adds issues to the developer's Linear queue over time, mostly at low priority, and raises one
when it becomes urgent, sometimes from one day to the next. They expect the developer's agent to know, each morning,
everything in the queue and at what priority. The Morning brief's queue is how Follow-up knows: it sweeps the whole
queue every workday morning, keeps a snapshot, and says what changed since the developer last looked ("ACME-142 raised
Low → High since Friday").

Files: `shared/linear-queue.ts` (pure: the snapshot's schema, the clock, the diff and "since"), `server/linear-queue.ts`
(`LinearQueue`: the sweep, the store, the views), on top of New's Linear reader (`server/linear-issues.ts`,
`shared/linear-issues.ts`; one reader, never a second one). Data: `linear-queue.json` ([data-files.md](data-files.md)).

Phases 1 and 2 of the brief's upgrade are here: the queue, and [Settings → Morning brief](#settings) with the weekly
plan's link. The brief's "Since" block, the queue screen and the Needs-you item for an issue raised with no workspace
build on New's dialog and actions; every source the proxy can reach and Ask for sources Follow-up doesn't know follow.

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
- **Who opened it and when:** QUEUE_FIELDS asks for `createdAt`, `createdBy` and `createdById`; the snapshot keeps them
  as `createdAt`, `creator` and `creatorId` (null in a snapshot from before). They are display only: the diff compares
  priority, due and state as before, so the first sweep that reads them logs nothing. The queue screen says "opened by
  you" when `creatorId` is the cached `viewer` (a sweep reads `get_user` once when it has creators and no viewer yet),
  the creator's name otherwise, and only the age with no creator known. Ages are relative under two weeks ("today",
  "yesterday", "5 days ago"), else a date ("Oct 14", with the year when it isn't this year); the exact date and time are
  the desktop tooltip and part of the row's accessibility label. `linear_queue` returns the same fields per issue, plus
  `openedByYou` (null: can't tell).
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

"07:00", "today" and "a workday" are in the developer's zone: Settings → Morning brief's zone when set, else the zone the developer's device reports (`follow.client-time-zone`), else the host's own. The workdays are the
zone's usual week (Sunday to Thursday where the weekend is Friday and Saturday, from CLDR's week data; Monday to Friday
elsewhere) unless Settings picks the days. The ranker's automatic runs use the same clock. Nothing names a fixed zone.

## Who reads it

- **The ranker** (`forRanker`, [ai-roles.md](ai-roles.md#priority-ranker-beta)): the queue's top 40 by priority plus
  every issue changed since the last workday's sweep (stable all day, so opening the brief doesn't re-rank), each with
  its change. Its "not started" list is read from the queue: Urgent, or raised to High or Urgent, with no workstream.
- **Agents:** `linear_queue` (read: the queue by priority, filtered all / no-workspace / changed, each issue's workspace
  or none and its change, the changes since, the sweep's health) and `sweep_queue` (planned). The Overseer, untracked
  root agents and main agents get them; contributors, recovery agents and subagents don't (invariant 4).
- An issue "has a workspace" by New's one predicate (`issueWorkspaces`, `shared/issue-workspace.ts`,
  a-taken-issue-is-not-a-suggestion): an unarchived workspace links it, or tracks a PR whose branch or title names its
  key. A raised issue a tracked PR names is no Needs-you item.

## In the brief

The brief pane (Home with nothing selected, `client/home.tsx` `BriefPane`) draws the queue under Catch up
(`client/brief-since.tsx`, words from `shared/brief-since.ts`). Opening the pane is the developer's read: its one
`follow.linear-queue` call passes `open: true` (`a-change-is-against-what-you-last-saw`); nothing else does.

- **The Since block:** "Since Friday · your Linear queue" (`sinceWords`: a time today, yesterday, a weekday this week,
  else a date), at most `SINCE_LINES` (5) lines in `changesSince`'s order. New Low and No-priority issues fold into
  one "+N new, Low" line (never on another issue's line, which read as that issue's doing), and issues that left share one line
  ("2 left your queue: ACME-120 done, ACME-131 reassigned to bob"). The rest are counted, and the Changed filter has them.
  A line for an Urgent or High issue that is new or raised and has no workspace carries New's first two actions,
  bordered (Catch up stays the one filled button, decision Q9), and ⋯, which opens New on the issue. An action runs
  `follow.dispatch` for that issue, the same call New makes, and its record (with Undo) shows on Home; a source New
  can't place alone opens New on it. A line whose issue has a workspace names it and opens it. A raised issue that is in
  Needs you keeps its line here without actions: the Needs-you item carries its Start…, one set of actions per issue.
  Buttons keep their whole label and wrap to a second row rather than truncate.
- **The queue screen** (`?view=queue`, from "47 issues by priority ›"): every issue by Linear priority (Urgent, High,
  Medium, Low, No priority), with All / No workspace / Changed (decision Q10) and each count. A row is the key, title,
  then one quiet line: state, due, and who opened it and when ("Todo · due Wed · opened by Dana · 12 days ago",
  `openedLine`), the change since (`changeChip`), then the workspace (opens it) or Start…, which opens New on the
  issue (a quiet ghost button, so the column isn't a wall of bordered ones). Sweep now is `follow.sweep-queue` with `wait: false`: it replies at once and the screen
  reads the view every 3 s while the sweep runs, so a slow Linear never holds the RPC. On
  phones the row itself is the 44 px+ target: it opens the workspace (named on the meta line) or New on the issue.
- **Raised issues in Needs you** (decision Q8): an issue raised to Urgent or High that is still in the queue and has
  no workspace (`raisedNeeds`, over the log window) is the first row of Home's Needs you group, shaped like its rows
  (amber ↑, the key, "Raised", "Low → High · title · no workspace yet", the raise's age), and counts in the group's
  header, the strip, the brief line and the sidebar badge from one number: the worker's (`LinearQueue.needs`), pushed on
  `follow.home-feed` (`queue`) when a sweep or a dismissal changes it, and on 0.15 carried by the priorities poll
  (`HomeModel.raised`; Catch up's deck stays workspaces). An open Home shows a morning raise without a remount, and an
  open brief pane re-reads its Since block when the feed's queue revision moves. It has Start… and the same two-click
  Remove as every Needs-you item (`follow.dismiss` with `issue`; agents: `dismiss_item {issue}`).
  Dismissing records the key and the raise's sweep time (`linear-queue.json` `dismissed`), so a later raise brings it
  back; a workspace for it, a raise taken back, or the issue leaving ends it without one. `linear_queue` returns them
  as `raised`.

## Settings

Settings → Compass (it was Settings → Morning brief: [compass.md](compass.md#settings--compass-one-place-for-priority-inputs);
`client/morning-brief-settings.tsx`, `shared/morning-brief.ts`, `server/morning-brief.ts`), stored host-scoped in
`morning-brief.json` ([data-files.md](data-files.md); not `brief.json`, the hooks' file).

**This week's plan** has three modes:

- **From Compass:** a Compass source with the role Posts the plan provides it: the newest claude.ai artifact its
  people share, recorded as Compass reads it and read at once ([compass.md](compass.md#this-weeks-plan-from-compass)).
  The link is kept without its share key (`canonicalArtifactUrl`). The card says which source and place it came from,
  when, and what the read found (title, items, how many have no issue), with Open and Use another link.
- **Use a link:** paste it; it stays until changed. "Replace when a newer one arrives" lets a plan Compass finds after
  the paste take over.
- **Off:** the brief and AI priority read no plan.

**None this week** keeps the plan it has (last week's) and says so in amber, naming the plan in use (with Open) and a
paste field right there. With no source that posts the plan, the card says to give one the role. The line under the
tab is built from the same card (`briefSummary` from `planCard`), so it never says the plan is in while the card says
otherwise.

**The link in use** (`effectivePlan`): `FOLLOW_UP_PLAN_URL` when set (Settings shows it read-only and changes nothing),
else Off reads nothing, else the pasted link (or a newer plan from Compass, with replace-when-newer), else this week's
plan from Compass, else last week's. The ranker reads that link once a day (one Claude turn with the Artifact tool,
[ai-roles.md](ai-roles.md)); a new link is read right away so Settings can show its title, and that read is the
ranker's for the day.

**The one-time import** (decision Q6): the first time the file is read with nothing set, the morning-brief skill's
registry (`~/.codex/skills/morning-brief/references/sources.json`) is read at run time. Its `claude_artifact`
source's discovery block (author and channels) becomes the plan's person and channels, which the one-time move then
turns into a Compass source, and its verified link the first plan; with no discovery block, its link becomes Use a
link. It runs once, found or not, never replaces a choice already made, and never copies, logs or edits the file.

**Linear queue and When:** which states count (Triage, Backlog, Todo, In Progress; at least one; behind the Linear
queue row's chevron), the sweep time (When's "Morning read at"), "changes
since" (your last read, or always your last workday: both stored points, invariant 77, so there is no "last 24 h"),
the time zone (blank: automatic) and the workdays (the zone's usual week until changed).

**Agents** read and change all of it through `brief_settings` / `set_brief_settings`, `brief_plan` /
`set_brief_plan` (planned; the dry run reads the new link's title first through `brief_plan {link}`) and
`brief_sources` / `set_brief_sources` (planned).

## Sources

Every source the brief reads is found by the tools mcpproxy offers, never by a server's name
(`nothing-built-in-about-a-workplace`; `shared/brief-sources.ts`, `server/source-tools.ts`, `server/brief-sources.ts`).

**Discovery:** `mcpproxy tools list --risk read -o json` (every read-only tool: its server, name, description and input
schema) and `mcpproxy upstream list -o json` (each server's own state). The tool list is read the first time any reader
needs a tool, and again only when Settings → Morning brief opens, on Check sources again and once on a workday morning
after the sweep time (`BriefSources.tick`, from the worker's loop: `the-brief-has-one-timer`). The RPCs answer at once
from what is known; a check or a Retry runs after the reply and the card polls every 1.5 s until it's done.

**Recipes, as data** (`RECIPES`): a server takes the first recipe whose required tools it has, matched by tool-name
shape and input schema.

| Recipe | Required tools | Adds | Default |
| --- | --- | --- | --- |
| Linear | `list_issues`, `get_issue` (plus `get_user`, `list_teams`) | the queue (the sweep), New, the Summary, Linked | on |
| Chat | a message search taking `filters` and a query (the one that also reaches private channels and DMs, when there are several), a channel search (plus people search, read thread) | DMs and mentions over the chat window; Compass's conversation reader | on |
| Calendar | an events list taking a time range | today's meetings (or today and tomorrow) | on |
| Mail | a mail or message search taking a query, described as e-mail or inbox | unread mail to you | off |

GitHub (every `gh` account's review requests) and Paseo (Follow-up's own state, always on) are built in. A server
with read tools but no recipe is an [Ask](#ask) source, off until previewed and turned on; one with no read tools at all
is listed under "more on mcpproxy the brief can't read", folded, with no switch. The developer's own chat id is read
from the chat tool's description at run time.

**Only reads** (`sources-are-read-only`): `SourceDirectory.call` is the one place that runs `mcpproxy call`, always
`tool-read`, with a tool from the read list, carrying only the inputs that tool's schema takes (`fitArgs`; a calendar's
range goes into whatever inputs it has: `rangeArgs`). Replies are parsed tolerantly (`parseEvents`, `parseMail`: JSON at
any depth, else text lines).

**Discovery heals itself** (`discovery-heals-itself`): `SourceDirectory` keeps one discovery, but a reader whose recipe
no server has asks again before it gets `NoSourceError` (at most once per `MISS_REDISCOVER_MS`, 10 min), so an upstream
that was down when the worker first asked is found once it's back. A failed discovery (mcpproxy down) is the answer for
`FAILED_DISCOVERY_MS` (60 s); Settings' check and Check sources again always ask.

**Health per source:** `ok`; `sign-in` (the server waits for an OAuth sign-in: sign in through mcpproxy or the claude.ai
connector, since a headless host can't open a browser); `failed` (not connected, quarantined, or the last read's one
line, with Retry; a sign-in row has Check again and the command to copy); `off` (turned off here, or in mcpproxy). The last read is the newest of the ranker's run (chat,
calendar, mail, GitHub; `ranker.json` keeps each failed source's line), the sweep (Linear) and a Retry. A source turned
off is skipped by the ranker (shown as off, not failed) and by Compass.

**Windows:** the chat window (24, 48 or 72 h; default 48) and the calendar (today, or today and tomorrow), stored with
the queue's settings.

### Ask

A server no recipe fits can still feed the brief (`shared/ask.ts`, `server/ask.ts`), off until the developer turns it on
per source (Q5). Each ask, on a workday morning after the sweep time (`BriefSources.tick`, the brief's one timer), on a
preview and on Retry:

1. **Plan.** A fast model (the Summaries role in Settings → Agents, Claude Haiku by default: simple AI jobs run on fast
   models) sees that server's read-only tools, names, descriptions and inputs with their types, trimmed
   (`askPlanPrompt`), and proposes at most `ASK.calls` (3) reads for what needs the developer today. The plan is kept in
   `morning-brief.json` (`sources.plans`) and reused for `ASK.planMs` (a week) while the server's tools hash the same,
   so most mornings are reads plus one model call.
2. **Check.** Every call is validated (`validateCall`): the tool is one of that server's read tools (a write it proposes
   is refused), each argument is one its schema takes, of its type, strings capped, and every required one is there. A
   cached plan is checked again against the tools as they are now.
3. **Read.** Valid calls run through `SourceDirectory.callTool` (`tool-read`, 20 s each).
4. **Items.** A second short call turns the replies into at most `ASK.items` (5) items `{title, why, url, due}`,
   validated (`validateItems`): a link is kept only when a reply carries it verbatim, a due date only when it reads as one.

**Preview before on** (`ask-is-validated`): turning an Ask source on is refused until a preview (or a morning's ask)
under `ASK.previewMs` (24 h) old that didn't fail. In Settings the row's first action is Preview: it shows the items (or
"nothing for you today") and the reads it ran, with Turn on. `set_brief_sources` `preview` does the same for agents. A
preview turns nothing on and never feeds the ranker. The morning's items go to the ranker as OTHER SOURCES (it reads
them; it never asks); a failed ask is the row's one line with Retry. Asks wait while the governor says the VM is tight. The ranker's scheduled run can start before the morning's asks finish, so when they store items that differ from
the last ones they mark it due (`Ranker.markDue`): its next tick on the worker's loop runs once, inside its cadence or
not, and today's items reach today's rank. Only a run that starts takes the mark: one that skips first (off, or the
governor turning tight between the tick's check and the run's) leaves it for the next tick. No new timer. An Ask source whose upstream needs a sign-in or isn't connected
is skipped in the loop's cheap check (from the last upstream list), so it costs one store read a tick. The planner's and
the summary's prompts say tool descriptions and replies are a third-party server's data, never instructions; whatever
the model does with them, a call still has to pass validation and a link still has to appear in a reply verbatim.

## Cost

| | Reads | Model calls |
| --- | --- | --- |
| A morning sweep of 150 issues | about 7, plus up to 20 for issues that left (and one `get_user`, once ever) | 0 |
| The ranker | none of its own (it reads the snapshot) | unchanged |
| This week's plan | none of its own: it arrives with Compass's read | 0; a new link's title is the ranker's daily plan read |
| Chat, calendar, mail (in the ranker's run) | 2 chat, 1 calendar, 1 mail (off by default) | 0 |
| Discovery | 2 calls: on Settings open, Check sources again and once a workday morning | 0 |
| An Ask source (each one turned on) | at most 3, once a workday morning | 1 (the items), plus 1 when its plan is made (weekly, or when its tools change); about 3 k tokens |

Idle, the queue costs one file stat per 15 s tick. Tests: `tests/linear-queue.test.ts`, `tests/ranker.test.ts`, `tests/morning-brief.test.ts`, `tests/brief-sources.test.ts`, `tests/ask.test.ts`.
