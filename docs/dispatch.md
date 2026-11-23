# New: start work from an issue, a PR, a link or a sentence

New (internal name: dispatch) starts a workspace and an agent from a source, with an action. The source is a Linear
issue, a GitHub issue or PR link, another link, or the developer's own words. The action says what the agent is asked
to do. Phase 1 shipped in three PRs: the core and the agent tools, the dialog and its entry points, and Settings → New work.

## Files

| File | What it holds |
| --- | --- |
| `shared/dispatch.ts` | Pure rules: actions as data and the built-ins, `renderAction` (placeholders, the 4 KB `{body}` clip, the developer's note), `parseSource`, titles and branches, `resolveWhere` (which project, and why), the record and `dispatch.json` schemas, and the RPC input schemas. Safe on the phone (no Node APIs). |
| `shared/linear-issues.ts` | One typed Linear issue record (`LinearIssue`) and the parsers for `list_issues` and `get_issue` replies, a cut-off reply included (`salvageArray`). The Morning brief reuses it. |
| `server/linear-issues.ts` | `LinearIssues`: the reader, through mcpproxy like the Summary. `list` walks every page up to its limit and is shared for `LIST_TTL_MS` (60 s); `get` reads one issue with its description; `search` runs only on an explicit press. A missing mcpproxy or Linear server reads as `missing`, not as an error. |
| `shared/new-view.ts` | The dialog as pure data: the left list (`newRows`: My issues, a pasted source, "Start from your words", "Search all of Linear"), what a row sends to the preview, the action bar (`actionBar`: ↵ the first action, ⌥↵ the second, the rest under More, Open it when the source has a workspace), the four steps of a dispatch, Home's row (`homeRecords`, `recordLine`) and the keys (`newKey`). |
| `client/new.tsx` | The dialog (`NewDialog`), its host on Home (`NewHost`: a dialog over everything on desktop web, a full screen on a phone), `openNew`, and Home's dispatch rows with Undo (`DispatchRows`). |
| `client/action-row.tsx` | The action row (`ActionRow`): ↵ the first action, ⌥↵ the second, More, or Open it. It starts nothing itself (the caller's `onAction`), so any surface can mount it (the Morning brief's queue). |
| `client/new-entry.tsx` | The sidebar's New row (`addSidebarHeaderItem`, id `new`). |
| `shared/new-settings.ts` | Settings → New work as pure data: each action row (its ↵/⌥↵ key, PRs only, Edited, Added by an agent, Reset and Delete), the learned teams offered as rules, the category's line. |
| `client/new-settings.tsx` | Settings → New work (`NewWorkCategory`): Actions, Where work goes, Bases. |
| `server/dispatch.ts` | `DispatchStore` (`dispatch.json`) and `DispatchService`: sources, preview, dispatch, the background create, retries, cancel, Undo, and the action and settings edits. Every outside effect is an injected dependency, so tests run it on a fake Paseo. |

## Actions

An action is data: a name, an icon, a description, instructions with placeholders, an agent (or New's default), a
workspace kind (`worktree` or `local`), a branch rule and what Follow-up does after the start. The placeholders are
`{title} {url} {key} {body} {kind} {team} {repo} {base} {branch}`; an unknown one is refused when the action is saved,
by name. A line left holding only empty placeholders is dropped, so typed text without a key or URL still reads as a
sentence. The developer's note goes after the instructions as "Note from the developer: …".

Built-ins, in order: Create PR, Plan as artifact, Investigate, Just open (hidden by default; the project folder), and
Check out PR (offered only for a PR link). A built-in can be edited, hidden, moved or reset, never deleted. The saved
list is `null` until the developer changes something, so new built-ins reach everyone.

## Where work goes

`resolveWhere` decides the project, in this order, and always says why:

1. The developer's pick.
2. The link's repository (a GitHub issue or PR).
3. The project of the source's live workspace ("Where its workspace is"): an issue already being worked on is never
   ambiguous, so its preview offers Open it with starting another in the same project.
4. The team's rule (Linear team key → project). A rule naming a project that is gone asks again and says so.
5. Learned: at least `LEARN_MIN` (2) of the team's linked workspaces, `LEARN_SHARE` (70 %) of them in one project.
6. For a source with no team (a link or words), the last used project, drawn as a guess, unless the no-team rule is
   `ask`.
7. The only project that can take a worktree.
8. Otherwise ambiguous: New asks, and a pick for a team with no rule is saved as that team's rule (asked once per team).

The base is the project's saved base, else the repository's default branch (`origin/HEAD`, read once an hour), else
`main`. The branch is the issue's own Linear branch name or one from the title; Paseo picks a free name if it's taken.

## A dispatch

`follow.dispatch` checks the preview's blockers, writes a `queued` record and replies. The create runs after the reply,
so the dialog never waits on Paseo:

- **creating**: `workspaces.create` with a branch-off worktree, a PR checkout (`action: "checkout"`, `githubPrNumber`
  and `checkoutSource`, as Send to Paseo does), or the project folder for Just open.
- **starting**: the agent, with the rendered instructions as its first message.
- **created**: Undo is offered for `UNDO_WINDOW_MS` (10 minutes) and archives the workspace. The source is linked to it.
- **failed**: Paseo refused the workspace (nothing was created), or the agent couldn't start, in which case the
  workspace just created is archived again (`a-failed-dispatch-leaves-nothing-behind`). The record says what was left.
- **queued** again while Paseo can't be reached, retried after 15 s, 1 min, then every 5 min. Undo on a queued
  dispatch cancels it.

A worker that restarts while a dispatch is creating or starting marks it failed and says to check Paseo's sidebar. It
never creates again blind, which could make a second workspace.

## Rules

- `dispatch-needs-a-click-or-a-confirmed-plan`: nothing is created except from the developer's click or an agent's
  confirmed plan. The agent tool `dispatch` dry-runs first (the same preview the dialog shows). Its plan freezes the
  resolved project and the instructions' hash, and confirm is refused if what it would send has changed.
- `the-overseer-starts-what-the-developer-asked` (invariant 105): the Overseer's dispatch passes its start gate, which
  hands the source's Linear key to `gate(actor, key)`. Only keys the developer's latest message approved pass: named in
  a chat request, proposed by the Overseer before a "yes", or answered New workspace on its card.
- `a-failed-dispatch-leaves-nothing-behind`: see above.
- `new-reads-nothing-while-closed`: Linear is read only when New asks; the one timer is a queued dispatch's retry.
  Settings → New work reads New's own settings once when the tab opens, never Linear.
- `an-action-is-data` and `new-never-switches-the-project-silently`: see AGENTS.md's invariants.
- The Overseer's own dispatches keep its new-workspace gate: the developer's latest message must ask for or approve a
  new workspace. Its `start_workspace` is an alias of `dispatch` with Create PR for one release.

## The dialog

Every entry point goes through one path, `openNew` (`client/new.tsx`): Home's **+ New** (first in Home's header), the
sidebar's **New** row, ⌘K **Follow-up: New…** (its title names the key) and **New from anywhere**, the Display setting
`new_shortcut` (⌘⇧N, ⌘⇧O or None). Unset, the key is ⌘⇧N in Paseo's desktop app and ⌘⇧O in a browser tab, because
Chrome keeps Ctrl/Cmd+Shift+N for a new incognito window and never hands it to a page (`newShortcutPreset`,
`shared/search-key.ts`); a pick wins everywhere. The key shares Search from anywhere's one capture listener
(`client/search-key.ts`), and pressing it again closes New. The Home on screen shows the dialog in place; with none on
screen (a chat in front, or only a Home Paseo keeps mounted behind) the request waits and Home opens with
`?new=<nonce>`, whose host shows it (`enterNew`, `index.client.tsx`). Which Home shows it is the host slot's rule
(`client/host-slot.tsx`, invariant 96 `new-opens-where-you-are`): the one showing it keeps it, else the newest host on
screen, never a hidden one; Report an issue and Rename title with AI use the same slot.

- **Desktop:** the sources on the left (the field, focused, then My issues: only issues you could start, the first
  preselected; each row says where it would go, or "→ which project?" when New would ask), everything about the selected
  source on the right (Project, From, Workspace, Branch, Title, Agent, Show instructions, a note), and the action bar
  across the bottom. ↵ runs the first action, ⌥↵ the second, ⇧↵ searches all of Linear, ↑↓ move, ⌘I shows the
  instructions, Esc closes. Once created: ⌘↵ opens the workspace, ⌘Z undoes.
- **Phone:** the list with the bar pinned at the bottom, then a preview screen for any other row; on both, the bar's
  line names the target, its base, the agent and its mode before the click.
- **Which project:** the project choices commit at once (up to four, then Other… for the full list); the fields below
  fill in once one is picked.
- **A source with a live workspace:** Open it (↵) leads, and starting another stays under the usual gate.
- **Issues that already have a workspace** (`a-taken-issue-is-not-a-suggestion`, invariant 95) are never suggested:
  My issues folds them into one quiet last row, "N issues already have a workspace", that opens in place; each is muted and
  names its workspace, and ↵ opens it. Preselection and ↑/↓ reach them only once the fold is open, and a list with
  nothing else says "Nothing new to start." above the fold. Pasting one's link still shows it first, with
  Open it as ↵. One predicate decides it, `issueWorkspaces` (`shared/issue-workspace.ts`): a live workspace that links
  the issue, or one tracking a PR whose branch or title names its key as a whole token (`acme-12-…`, "ACME-12 …";
  ACME-12 never matches ACME-123). Several: the PR's workspace over one that only links it, then the most recently
  active. The worker builds it once per read from state it holds (`issueHolders`, `takenIssues` in `index.server.ts`)
  for New's list (`taken` in `follow.dispatch-sources` and `dispatch_sources`, with each one's `routes[key].existing`),
  dispatch's `existing` (paste, preview and the `dispatch` dry run) and the Morning brief's queue.
- **Failures:** the remedy leads: Change agent when the agent didn't start (the workspace was archived again), Change
  base when a new worktree couldn't be made; Try again otherwise. Home's row for a failure says why first and offers
  Try again (New, on that source).
- **Agent:** the chip picks the provider, model and mode for this dispatch only (`agent` on the input, kept on the
  record so a retry starts the same agent).
- **Home's row:** dispatches in progress, failed in the last hour, or still undoable come on the home feed
  (`dispatches`), so Home reads nothing of its own; on a Paseo without feeds (0.15) Home reads them once on start and
  once each time New closes, never on a timer. One that finishes while New is closed says so in a toast with Undo.

`new-reads-nothing-while-closed`: closed, New makes no request (no feed, no timer). Open, it reads the list once, a
preview per selection, and one record a second only while a dispatch is starting.

## Settings

Settings → New work has three sections. It reads `follow.dispatch-actions` and `follow.dispatch-settings` when the tab
opens and never polls; every change goes through `follow.set-dispatch-actions` and `follow.set-dispatch-settings`, the
RPCs the agent tools `set_dispatch_actions` and `set_dispatch_settings` run.

- **Actions**: every action in New's order, with its key (↵ for the first shown for an issue, ⌥↵ for the second), "PRs
  only", "Edited" or "Added by an agent". Each row moves up or down and shows or hides; an edited built-in has Reset to
  built-in, an added one has Delete (asked twice). Reset all to built-in restores the shipped list.
- **Where work goes**: the no-team rule ("The project you used last" or "Ask which project"), each team's rule (change
  it or remove it), Add a rule (a team key and a project), and each team whose history points at one project without a
  rule, offered as "Make it a rule".
- **Bases**: the base branch per project that can take a worktree; empty is the repository's default branch.

The agent New starts for an action without its own is **Settings → Agents → New work** (role `dispatch`). Its default
is "Same as the Overseer": the Overseer's provider, model, mode and effort. A pick of its own is a normal row (provider,
model, effort, permissions). The New-from-anywhere key is in Settings → Inbox & display ([settings.md](settings.md)).

## Agent tools

`dispatch` (planned), `dispatch_sources`, `dispatch_records`, `dispatch_undo` (planned), `dispatch_actions`,
`set_dispatch_actions` (planned), `dispatch_settings` and `set_dispatch_settings` (planned). See
[rpcs-and-tools.md](rpcs-and-tools.md).

## Known gaps in phase 1

- Starting in an existing worktree.
- Attachments (images, files) with the source.
- Picking a host other than this daemon.
