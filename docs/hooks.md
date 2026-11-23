# Provider hooks

## Installing the hooks

`server/agent-hooks.ts` (`AgentHooks`):

- **What it installs.** It writes `agent-hook.mjs` (from `server/hook-source.ts`, generated from
  `server/agent-hook.mjs`) into `plugin-data/follow-up/`. It adds one command per event to Claude Code's
  `~/.claude/settings.json` and Codex's `~/.codex/hooks.json` for SessionStart, UserPromptSubmit, PostToolUse and
  Stop.
- **When it's written.** `AgentHooks.start()` rewrites `agent-hook.mjs` and the settings entries on every worker
  start (each plugin load or reload). `stop()` removes them at teardown.
- **Reversible.** Entries end with `# paseo-follow-up-hook`, and `reconcileHooks` removes them.
- **Written through symlinks.** Settings files are often symlinks (dotfiles, a shared account dir). Every write to a
  user-owned config file goes through `server/write-through.ts`: it resolves the path, then backs up and replaces the
  target, so a link stays a link. A dangling link is refused with an error naming the path; Follow-up never creates
  the missing target. `tests/write-through.test.ts` fails when a module that names a user config file writes it
  another way.
- **Never from a harness into a real home.** When `plugin-data/follow-up` is under the OS temp dir (a test or
  harness daemon), Follow-up skips, with a warning, any settings file outside the temp dir, whatever
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` it inherited.
- **Lease.** The worker renews `hooks-enabled.json` every 30 s, and it expires 120 s after the last renewal. The
  hook does nothing without a fresh lease, so a stopped Follow-up costs nothing.

## What the hook does (`server/agent-hook.mjs`)

It runs on every event, so it reads only small files: `scopes.json`, `brief.json`, its `hook-state/` markers, and
`tools-instance.json`. It never reads `state.json` when `scopes.json` exists. It skips subagent events, recovery
agents and anything without `PASEO_AGENT_ID`.

| Event | Effect |
| --- | --- |
| SessionStart | Adds Follow-up's instructions for tracked agents (worded for the agent's PR workflow, contributor or main; in a workspace whose repositories are all No review, `workflow.noReview` in `scopes.json`, the agent merges its own PR once CI is green, see `mergeLine`; one team repository keeps the team wording), the native tools' guidance (`nativeExtras`, since native tools carry no MCP instructions), and Wait's guidance (`waitExtras`: `waitInstruction` when `FOLLOW_UP_WAIT=1`, or on Paseo 0.16 `backgroundWorkInstruction` when `FOLLOW_UP_BACKGROUND_WORK=1`). Root agents, tracked or not, also get one line on waiting for CI without polling (`checksLine`). Untracked Claude sessions with Wait get only Wait's guidance. On Paseo 0.17 the static parts go in the system prompt instead and the hook leaves them out (see [Static text in the system prompt](#static-text-in-the-system-prompt-paseo-017)). |
| UserPromptSubmit | Starts a turn marker. Repeats the context when it changed (Codex always repeats). Tells a demoted agent once that it lost the main role. For the Overseer, injects the digest. |
| PostToolUse | Marks the turn dirty after shell or edit tools. Says once per session that native tools are detached after a reload. When a shell command polls GitHub for CI (`pollsGithub`), adds once per turn, never blocking, that the agent should call `wait_for_checks` and end its turn ([wait-for-checks.md](wait-for-checks.md)); tracked and untracked root agents. |
| Stop | Blocks the stop once if a dirty turn didn't `sync_workspace` (read from `hook-state/sync-<agent>.json`, written by the RPC handler, so any tool spelling counts), or if a root Claude session didn't call `needs_you` (`shouldNudge`). Also blocks to name the agent's due tasks (`pickNudges` over `scopes.json`'s `due`: at most 3, each at most twice and once a day; nothing when none is due; [due by fact](workspaces.md)). Never blocks twice in one turn, or while background tasks run. |

## Static text in the system prompt (Paseo 0.17)

On a host whose session-open result takes `appendSystemPrompt` (Paseo 0.17.0+, detected by `features.checkoutWorktreeList`,
which 0.17.0 first advertises; 0.16's schema is strict and would refuse the field), the worker puts the static parts
of the SessionStart text in the session's system prompt (`withSystemPrompt`, `server/session-prompt.ts`) for Claude
and for Codex from 0.121 (`codex --version`; older Codex throws on a new thread with plugin instructions). It names
the parts in `FOLLOW_UP_SYSTEM_PROMPT` (`needsYou`, `action`, `overseer`, `wait`, `backgroundWork`, `checks`) and the
hook leaves exactly those out, so the agent reads each once (`inPrompt`).

- **What moves** is only what the hook surely adds from the launch env (`promptParts`): a native root agent's role texts
  and `checksLine`, the Overseer's role texts, and Wait's guidance for any session. The workspace instructions stay
  the hook's: they follow the role and the PR workflow, which change mid-session.
- **Who gets what doesn't change**: `tests/session-prompt.test.ts` runs every role (main native and stdio, contributor,
  untracked root, the Overseer, a subagent, recovery, a background helper) on both paths and checks that the system
  prompt plus the hook equal what the hook alone added, each part once. Recovery and background agents get nothing
  (invariant 9).
- **Compaction:** the system prompt survives compaction and resume as it is; SessionStart still re-runs on compact and
  re-adds only what stayed the hook's. A setting changed mid-session (the inbox turned off) reaches the system prompt
  at the session's next open.
- On an older host or provider, nothing changes: no `appendSystemPrompt`, no flag, the hook adds it all.

## Env flags

The worker sets these at `agent.session_open`:

- `FOLLOW_UP_TOOLS`: `native` or `stdio`.
- `FOLLOW_UP_PROVIDER`.
- `FOLLOW_UP_ROOT`.
- `FOLLOW_UP_BRIEF`: the provider, when the nudge applies.
- `FOLLOW_UP_SYSTEM_PROMPT`: Paseo 0.17, the static parts already in the system prompt (comma-separated).
- `FOLLOW_UP_OVERSEER`.
- `FOLLOW_UP_RECOVERY`.
- `FOLLOW_UP_CLI`: the bridge path.
- `FOLLOW_UP_WAIT`.
- `FOLLOW_UP_BACKGROUND_WORK` (Paseo 0.16, instead of `FOLLOW_UP_WAIT`).

Tests: `tests/agent-hooks.test.ts` and `tests/hook-native.test.ts` (the hook is imported with
`FOLLOW_UP_HOOK_IMPORT=1`, so `main()` doesn't run), plus `tests/session-mcp.test.ts`.
