# Compass

Compass takes the developer's priorities from where the developer takes them: the people and places that decide what
they work on first. A **source** says whose words count, where to read them and what they tell Follow-up. Each workday
morning Follow-up reads what those people said, a fast model turns it into **notes** that quote them, each note finds
its workspace, and AI priority ranks the work by it.

Files: `shared/compass.ts` (the model, validation, dates, matching, a note's life), `server/compass.ts` (the reads, the
extraction job, `compass.json`), `client/compass-settings.tsx` (the Compass card in Settings → Morning brief).

## The rule that keeps it generic

> Code knows kinds of things. Config names the developer's things. Instructions say what their words mean.

- **Code** ships reader kinds (a conversation now; docs, trackers and calendars later), roles, validation, matching and
  default reading notes, all written about "a person", "a place" and "the developer". It names no tool, server,
  company, person or workflow (invariant 99, widening 82).
- **Config** (`morning-brief.json` `compass`, edited in Settings and by `set_compass`) decides what is read and where
  results go.
- **Instructions** (the developer's "How to read this" per source, at most 600 characters, and "How to read your
  Compass" for all of them, at most 1000) decide how what was read is understood. They never change what is read,
  what is written or where a result goes (invariant 100).

## A source

```ts
{ id, label, who, places[1-5], roles[], instructions, enable_needs_you, enabled, addedBy, addedAt }
```

- **who:** a person, up to 5 people, or the developer's own words (`me`). Everyone in a place (`anyone`) is in the
  schema and comes in a later release, with its caps (decision R1).
- **places:** a conversation (DM, group, channel, thread), picked from the chat tool's own search (`compass_find`), so
  every place carries the tool's own id. Doc, tracker and calendar places are in the schema; a change naming one is
  refused with one line of why until its reader ships, never saved to sit unread.
- **roles:** Sets my priorities, Posts the plan, Deadlines, A customer's voice, My own notes, Background. Each ships
  generic reading notes (`ROLE_INFO`). Background makes no notes.
- **Presets** (`PRESETS`) only fill a new source's fields. One whose reader isn't here is listed with its why.
- **Glossary:** the developer's words → an issue key (or workspace or account), checked when saved, read by matching
  before anything else.
- **expiry** (undated days 7, grace 1, decay 3 workdays) is editable. **routing** and **cadence** (Off, 1 h, 2 h, 4 h;
  default 2 h) are stored with their defaults for the releases that use them.

## Reading

- **When:** once a workday after the sweep time, from the worker's 15 s loop (`Compass.tick`, the-brief-has-one-timer),
  while the governor allows background work; on Read now (`read_compass`); and over the last week when a place is
  added. The daytime read while the app is open comes in a later release.
- **How:** by cursor in time order, never by a relevance search. The chat recipe's `history` role (a conversation id
  and an oldest time, matched by shape) is read newest page first, at most `COMPASS.pagesMax` pages; without one, the
  message search sorted by time, one day at a time, and the place says it's on the slower path. A read that fails
  keeps the cursor, so the next read covers the gap. Thread replies are read with their parent's thread in a later
  release.
- **Whose words:** only the source's people reach the model; the developer's own replies come along marked as context
  (for "never mind") and can never become a note; anyone else in the place is dropped before the model.
- **Caps** (`COMPASS`): 8 sources, 5 places each, 25 model calls a day for all of Compass, 40 messages and 8 k
  characters a call, 60 live notes. A cap reached says so on the place ("Paused until tomorrow"), never silently.

## Extraction

One call per read that has new words from the source, on the **Summaries** role's model (Claude Haiku by default)
through `AiJobs`. The prompt is, in order: the rules, the role notes, the developer's global reading notes, the
source's, today in the developer's zone, the source's open notes, then the messages fenced as data. No workspace list:
matching is Follow-up's.

**The guard.** The words are other people's, so extraction runs only where Follow-up can take every tool away: Claude
under the job guard's empty grant (`server/job-guard.ts`), Codex in its read-only sandbox. With Summaries on any other
provider, Compass reads nothing at all, not even the conversation, and the Compass card and `compass` say why in one
line ("Compass doesn't read on Gemini: Follow-up can't take its tools away. Pick Claude or Codex for Summaries in
Settings → Agents."). The general gap for other providers' jobs closes in a later release.

**Validation** (`validateExtraction`): a note stands only when its quote is a verbatim substring of the message
(whitespace folded), its keys are written in the message or come from the glossary, its date comes from the words
(`resolveUntil`, which wins unless the developer's reading notes name the phrase) or lies within 60 days, and its
message is the source's own, not a reply of the developer's. Author, time and link are the message's. A refused note
is logged by rule code only (`quote-not-found`, `key-not-in-text`, …). No retry.

## Notes

`compass.json` holds each place's cursor, the notes, today's model-call count, the morning read's day, the last read
and the last refused rule codes. Never the text read: a note keeps its quote (at most 280 characters), dropped 7 days
after the note ends.

- **Matching** (`placeNote`): the glossary first, then a key's workspace (`issueWorkspaces`, invariant 95's one
  predicate), then one token score per workspace (title, Summary, linked titles, PR branch) chosen at ≥ 0.5 and 0.15
  above the next. A key with no workspace makes the note about that issue. Otherwise it is unplaced.
- **Life** (`settleNotes`): a dated note lives through its date plus grace; an undated one for `undatedDays` after it
  was last said; a retraction ends it; a newer note from the same source on the same subject supersedes it. Notes from
  different people that disagree are all kept: Follow-up never picks between people.
- **Settings** opens a source's live notes under its row: what each says, the words it quotes, its date and where it
  went.
- **AI priority** reads the live notes (`Compass.forRanker`, at most 20, soonest first) as its COMPASS section, with
  rules for how strong each role and strength is. A note's reason line names Compass as its source
  (`PRIORITY_SOURCES` `compass`). New notes mark the ranker due once (`Ranker.markDue`).

## Tools

| Tool | Kind | Does |
| --- | --- | --- |
| `compass` | read | Sources, glossary, presets, each place's last read, live notes (optionally one workspace's) with the titles of the workspaces they went to, and `blocked`. |
| `compass_find` | read | People or channels from the chat tool's own search, each with the place `set_compass` takes. |
| `set_compass` | planned | Add, edit or remove a source; reading notes; glossary; expiry. |
| `read_compass` | planned | Read now; waits up to 30 s, then `running`. |

"Set up Compass from my DM with my PM" is `compass` → `compass_find` → `set_compass` (dry run, then confirm).
