# New: start work from an issue, a PR, a link or a sentence

New (internal name: dispatch) starts a workspace and an agent from a source, with an action. The source is a Linear
issue, a GitHub issue or PR link, another link, or the developer's own words. The action says what the agent is asked
to do. Phase 1 ships in three PRs: the core and the agent tools (this one), the dialog and its entry points, and then
Settings → New work.

## Files

| File | What it holds |
| --- | --- |
| `shared/dispatch.ts` | Pure rules: actions as data and the built-ins, `renderAction` (placeholders, the 4 KB `{body}` clip, the developer's note), `parseSource`, titles and branches, `resolveWhere` (which project, and why), the record and `dispatch.json` schemas, and the RPC input schemas. Safe on the phone (no Node APIs). |
| `shared/linear-issues.ts` | One typed Linear issue record (`LinearIssue`) and the parsers for `list_issues` and `get_issue` replies, a cut-off reply included (`salvageArray`). The Morning brief reuses it. |
| `server/linear-issues.ts` | `LinearIssues`: the reader, through mcpproxy like the Summary. `list` walks every page up to its limit and is shared for `LIST_TTL_MS` (60 s); `get` reads one issue with its description; `search` runs only on an explicit press. A missing mcpproxy or Linear server reads as `missing`, not as an error. |
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
3. The team's rule (Linear team key → project). A rule naming a project that is gone asks again and says so.
4. Learned: at least `LEARN_MIN` (2) of the team's linked workspaces, `LEARN_SHARE` (70 %) of them in one project.
5. For a source with no team (a link or words), the last used project, drawn as a guess, unless the no-team rule is
   `ask`.
6. The only project that can take a worktree.
7. Otherwise ambiguous: New asks, and a pick for a team with no rule is saved as that team's rule (asked once per team).

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
- `a-failed-dispatch-leaves-nothing-behind`: see above.
- `new-reads-nothing-while-closed`: Linear is read only when New asks; the one timer is a queued dispatch's retry.
- The Overseer's own dispatches keep its new-workspace gate: the developer's latest message must ask for or approve a
  new workspace. Its `start_workspace` is an alias of `dispatch` with Create PR for one release.

## Agent tools

`dispatch` (planned), `dispatch_sources`, `dispatch_records`, `dispatch_undo` (planned), `dispatch_actions`,
`set_dispatch_actions` (planned), `dispatch_settings` and `set_dispatch_settings` (planned). See
[rpcs-and-tools.md](rpcs-and-tools.md).

## Known gaps in phase 1

- Starting in an existing worktree.
- Attachments (images, files) with the source.
- Picking a host other than this daemon.
