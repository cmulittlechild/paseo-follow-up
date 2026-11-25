/**
 * What Follow-up gives an agent on each kind of provider (an-agent-on-any-provider-gets-follow-up). Paseo runs agents
 * on many providers (Claude Code, Codex, OpenCode, Pi, Copilot, Cursor, Kimi, Kiro, any ACP agent); Follow-up's core
 * works on every one, and the few parts that need Claude Code or Codex say so in one line.
 *
 * - Tools: every provider. Paseo serves plugin tools through its agent MCP to any provider that takes MCP servers.
 * - Instructions: Claude Code and Codex through the SessionStart hook (or the system prompt on Paseo 0.17); every other
 *   provider through the system prompt only (Paseo 0.17's appendSystemPrompt), which Paseo passes to OpenCode, Pi and
 *   plugin providers but not yet to ACP agents.
 * - Turn-end checks (the sync, needs_you and due-task reminders), per-turn context and Wait: hooks, which exist only in
 *   Claude Code and Codex.
 * - Helper jobs: any provider (server/job-agent.ts); a job that reads other people's words needs Claude or Codex
 *   (sources-are-read-only, shared/agent-settings.ts guardedProvider).
 */

/** Providers Follow-up installs its hook into (server/agent-hooks.ts: Claude Code's settings.json, Codex's hooks.json). */
export const HOOK_PROVIDERS = ["claude", "codex"] as const;
export const hasHooks = (provider: string) => (HOOK_PROVIDERS as readonly string[]).includes(provider);

/** Paseo 0.17.4's ACP providers: their sessions don't take a plugin's system prompt, so they get the tools only. */
export const ACP_PROVIDERS = ["copilot", "cursor", "kimi", "kiro", "trae", "acp"] as const;
type ProviderConfig = { agents?: { providers?: Record<string, { extends?: unknown } | null | undefined> } } | null | undefined;
/**
 * Whether Paseo runs this provider over ACP: one of its built-in ACP providers, or a provider in Paseo's config whose
 * `extends` chain reaches one (a generic ACP agent the developer added, under any id they chose). Decided from the
 * config, never from a list of ids alone.
 */
export function isAcp(provider: string, config?: ProviderConfig): boolean {
  const custom = config?.agents?.providers ?? {};
  const seen = new Set<string>();
  for (let id: unknown = provider; typeof id === "string" && !seen.has(id); id = custom[id]?.extends) {
    if ((ACP_PROVIDERS as readonly string[]).includes(id)) return true;
    seen.add(id);
  }
  return false;
}
const list = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

type NoteProvider = { id: string; label: string; available: boolean; reason?: string | null; acp?: boolean };

/**
 * What to do to get what needs Claude Code or Codex, from what Paseo has: use them when one is available, turn one on
 * when Paseo has it turned off, install one otherwise. Never "pick" a provider the developer can't pick.
 */
export function guardAction(providers: readonly NoteProvider[]): string {
  const guarded = providers.filter(p => hasHooks(p.id));
  if (guarded.some(p => p.available)) return "Use Claude Code or Codex";
  if (guarded.some(p => /turned off/i.test(p.reason ?? ""))) return "Turn on Claude Code or Codex in Paseo";
  return "Install Claude Code or Codex";
}

/**
 * Settings → Agents' one block under the helper rows, at most two short lines: what works on the developer's other
 * providers (and, for ACP agents, the one thing Paseo doesn't pass yet), then what needs Claude Code or Codex with the
 * one thing to do (guardAction). `summariesOn` is the provider Summaries runs on: off Claude and Codex it leaves out
 * linked items, and Compass and Ask read nothing (sources-are-read-only). Why AI priority can't run is on its row.
 * Empty when there's nothing to say.
 */
export function providerNotes(providers: readonly NoteProvider[], summariesOn: string | null): string[] {
  const others = providers.filter(p => p.available && !hasHooks(p.id));
  const acp = others.filter(p => p.acp ?? isAcp(p.id)).map(p => p.label);
  const needs = [
    ...(others.length ? ["turn-end reminders", "Wait for background jobs"] : []),
    ...(summariesOn && !hasHooks(summariesOn) ? ["Summaries' linked issues", "Compass", "Ask"] : []),
  ];
  return [
    others.length ? `Works on ${list(others.map(p => p.label))}: Follow-up's tools, PR tracking and repairs.${acp.length ? ` Paseo doesn't pass Follow-up's instructions to ${list(acp)} yet.` : ""}` : null,
    needs.length ? `Needs Claude Code or Codex: ${list(needs)}. ${guardAction(providers)} for ${needs.length > 1 ? "these" : "it"}.` : null,
  ].filter((x): x is string => !!x);
}
