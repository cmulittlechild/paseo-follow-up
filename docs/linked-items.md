# Linked items

The verified things a workspace's work is about: Linear issues, Slack threads, Claude artifacts, docs, GitHub issues
and, when someone links one on purpose, any other URL. PRs are not linked items, because they have their own card.

## Files

- `shared/linked.ts` is pure, with no I/O. It holds the schema, identity (`classifyLink`), dedupe across origins
  (`upsertItem`), exclusions, the cap, the Linear candidate queue (`noteCandidate`, `setTeams`, `dueChecks`,
  `applyCheck`, `takeBudget`) and the one-time migration from Summary links (`migrateAboutLinks`).
- `server/linked.ts` has `LinkedStore` (`linked.json`, written atomically, read on use and never cached in the worker),
  `LinkedService` (drain and migrate) and `liveLinkedSources`, which runs Linear's `get_issue` and `list_teams`
  through mcpproxy, like the Summary.
- `shared/linked-extract.ts` is pure too. It extracts references from text Follow-up already reads (`timelineRefs`,
  `workspaceRefs`).
- `shared/linked-display.ts` is pure: what the chip, the sheet and Home's search show. `client/linked.tsx` draws it, and
  `client/brand-icons.ts` holds the marks.
- `index.server.ts` runs a loop every 10 minutes, the first 90 s after start: migrate once, note the workspace
  record's references, then drain.

## How items get in

- **`link_item` / `unlink_item`** (an agent, origin `registered`) and **`set_linked_items`** / `follow.set-linked-items`
  (the developer or an agent for them, origin `manual`).
  - A Linear key is confirmed with Linear on the spot. An unknown key or a non-team prefix is refused, not stored.
  - When Linear can't be read, the key waits as a candidate.
  - A PR is refused and pointed to `register_pr`.
- **Extraction** (origin `extracted`) rides discovery's own timeline batch (`PaseoGateway.linkRefs`). Only loaded
  agents are read, so a dormant agent is never woken for this.
  - Strong: Linear tool receipts, Slack threads the agent read, URLs in completed tool calls, the developer's own
    messages, and the goal, title, PR titles and branches.
  - Weak: agent prose and other agents' messages. A weak key waits for a second sighting before Linear is asked.
  - Only entries past the cached cursor count, so a re-read overlap is never a second sighting.
  - Follow-up's own messages, bare keys in shell commands, PRs and generic URLs never count.
- **Spec and published artifacts** (origins `spec`, `published`) are derived in the view (`linkedView`) from
  `w.spec` and `w.artifacts`, never copied. The spec is tagged and left out of the counts.

## Rules

- **Precision over recall.** An extracted Linear key is a *candidate* and never renders until Linear confirms it.
  It also needs a team prefix that is a known Linear team (`list_teams`, read at most once a day), so lookalikes like
  STATUS-1025 or REVISION-2026 never show.
- **Not found** is remembered in `rejected` and never checked again. A read error is retried after 1 h, 6 h and 24 h,
  then dropped. There is never a "couldn't be read" row.
- **Budget:** at most 6 checks per drain and 120 a day. There are no checks while the resource governor says the VM is
  short of room. An empty queue (the steady state) costs one small file read and no MCP call.
- **Trust order** when one key arrives from several origins: manual > registered > spec/published > extracted. A
  more trusted origin takes the record over; a less trusted one only fills in missing fields.
- **Exclusions stick.** A removed key stays out against every origin. Only the developer adding it back clears it,
  and Undo restores the removed item as it was.
- **Cap:** 50 items per workspace. The oldest extracted item makes room. Registered and manual items are never
  evicted silently: adding past the cap with nothing extracted to evict is refused.
- **Migration (`about-links-1`):** runs once. Summary links Linear had confirmed (with a title), Slack threads with a
  channel, artifacts and docs carry over. Bare keys become candidates. PRs and generic links are dropped.

## UI

The design is §5 of the Linked items design; the rules below are what the code holds to.

- **The references line** (`ReferencesLine`) sits under the Summary and above the status sentence in the panel, the
  larger view and Home's detail pane. It holds the Spec chip (moved out of the title row, so it never jumps) and the
  Linked chip. Phones show the same line under the Summary, never in the 44px bar: beside Home and settings it
  would push settings off-screen at 390pt. With no spec and nothing linked there is no
  line at all, so the panel looks as it did before (`referencesShown`).
- **The Linked chip** (`linkedChip`): a mark and a count per kind, in the order linear, slack, artifact, doc, issue,
  link; at most 4 kinds on desktop and 3 on phones, then `+N` (the hidden kinds' item total). Counts are the view's
  `counts`: done and cancelled count, the spec, PRs and candidates don't. No status colour and no arrow. The desktop
  tooltip reads "6 Linear issues · 2 Slack threads · 1 artifact"; the accessible label spells out the `+N` too.
- **The sheet** (`LinkedSheet`, a host `Modal` titled "Linked"):
  - One field, "Filter, or paste a link or key". Typing filters. A key or URL not in the list becomes a "+ Add …" row
    (`pasteToAdd`), and Enter adds it through `follow.set-linked-items`. The server's refusal shows inline under the
    field. A PR is refused on the spot, and so is anything new at the 50-item cap (`LINKED_FULL`, the server's copy
    too), so there is never an Add row that can only fail. Desktop focuses the field; phones don't.
  - The spec, when there is one, is its own row above the groups (`linkedSpec`): the chip doesn't count it, so it sits
    under no head. Groups by kind (`linkedGroups`), headed "Linear · 6", each head equal to its rows. Open items
    first, newest first; done and cancelled behind "N done". More than 10 open rows show 8 plus "Show N more".
  - Rows (`linkedRow`): a lead, the title, and who linked it and why. A row opens the item in the browser. `⋯`
    (desktop: on hover or focus; phones: always) shows Copy link and Remove inline, or Edit spec link… on the spec,
    which swaps to the spec sheet. Remove is immediate, with an in-sheet "Removed … · Undo" for 6 s, 8 on phones, held while
    hovered or focused (host toasts can't carry an action).
  - First load shows 3 skeleton rows. A change writes the returned view into the `linkedKey` query and invalidates
    Home's index; saving the spec invalidates `linkedKey` too.
- **The disclosure row** (`LinkedItemsRow`): "Linked items" under the spec row in "Spec, agent and recovery", with
  Open, or Add when nothing is linked.
- **Home search** matches linked keys and titles (search field `linked`), and a match through a link says so on the
  row's second line: "Linked · ACME-1312 Vendor sync drops SCIM groups". The index comes from `follow.linked-index`,
  fetched only while the search field has text and kept a minute (`useLinkedIndex`), so Home's list poll never reads
  `linked.json`. Numbers match exactly or by prefix, never by a typo (`tokenMatch`), so "ACME-1312" can't find the
  workspace linking ACME-1352; words keep their typo tolerance.
- **Reads:** a surface showing the line reads `follow.linked-items` once when it mounts and keeps it a minute. Nothing
  polls.

## Local artifact and Claude Docs titles

`shared/local-titles.ts` is the shared title index and precedence rule. `server/local-titles.ts` reads completed
Artifact and Claude Docs tool receipts from the timeline batch discovery already has. Artifact names prefer the
publish input's title, then the source HTML's title, then description, then filename. Source reads are asynchronous,
limited to the first 8 KB and harmless when a file has disappeared. A completed Artifact read can contribute an HTML
or explicitly labelled page title without counting as a publish. Unknown-tool timeline projection preserves input
and output, including MCP text blocks. Failed calls, assets, list and quickstart receipts contribute nothing.

The index includes every tracked workspace's `artifacts`, specs and locally titled linked artifacts/docs. A title
known in one workspace fills an unnamed item in another, including existing items at worker start. The backfill is
idempotent and runs without timeline or network reads. New sightings repeat the same fill operation, so a title
learned later repairs existing links. Explicit linked and spec names are never overwritten. Published artifact
records retain stronger evidence over a later weaker or untitled receipt.

Claude Docs `container.create` names are paired with the corresponding successful result URL; operations without a
returned URL cannot safely name a link. Live create receipts were not available during development; projected
unknown-tool payload retention is confirmed in Paseo's projection source and tests. Fixtures cover create results
as MCP text blocks. Claude Docs URLs under `/doc/`, `/docs/` and their public forms classify as `doc`.

When no local evidence exists, the artifact row says **Claude artifact**, with its publisher or workspace mention
and calendar date beneath it. The spec uses the same Claude artifact fallback. No request goes to claude.ai, and
no model session starts to recover a name. Tests: `tests/local-titles.test.ts`, `tests/spec.test.ts`,
`tests/linked-ui.test.ts` and the `a-linked-item-uses-every-known-local-title` status invariant.

`server/transcript-titles.ts` maintains one local receipt index for artifacts still unnamed after the cheap index.
A background tick runs only with untitled artifacts, is gated by the resource governor, and reads at most 2 MB in
1 MB chunks. Scope is every Claude agent whose local agent record belongs to a tracked workspace, including
historical sessions. Agent metadata is listed once per scope change or five minutes; only the resulting session
files are opened. No timeline read or agent wake is possible through this service.

`title-index.json` stores one cursor per transcript (inode, size, mtime, byte offset, a bounded partial line and at
most 64 pending Artifact inputs) and URL/title evidence with its source path. Each byte is indexed once, and later
passes read only appends. Replaced, truncated or edited-in-place files restart. A completed file is a persistent
negative result until it changes, so a missing title never causes another per-URL scan. All publish receipts met
along the way contribute their best title using the same resolver; an index hit fills any tracked workspace's link.
When every artifact is named, no transcript discovery, stat or read occurs. If untitled artifacts remain but all
in-scope files are caught up, only append detection runs, without reading transcript content. Oversized individual
lines are skipped rather than retained without bound. Raw transcript prose is never persisted in this index.
