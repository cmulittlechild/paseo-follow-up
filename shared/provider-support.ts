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

/**
 * The one line that says what agents on the developer's other providers miss, and why; null when every available
 * provider has hooks. Settings → Agents shows it under the helper rows.
 */
export function noHooksLine(providers: readonly { id: string; label: string; available: boolean; acp?: boolean }[]): string | null {
  const others = providers.filter(p => p.available && !hasHooks(p.id));
  if (!others.length) return null;
  const acpOf = (p: { id: string; acp?: boolean }) => p.acp ?? isAcp(p.id);
  const acp = others.filter(acpOf).map(p => p.label);
  // Outcome first, then why; what still works, so "tools only" never reads as "doesn't work" (critique 2026-11-25).
  const parts = [
    `Your agents on ${list(others.map(p => p.label))} get Follow-up's tools, and Follow-up still tracks their PRs and sends them repairs.`,
    acp.length ? `On ${list(acp)} they don't get Follow-up's instructions: Paseo doesn't pass a plugin's instructions to ACP agents yet.` : null,
    "Turn-end reminders (sync, say what needs you, due tasks) and Wait for background jobs need Claude Code or Codex, whose hooks run them.",
  ];
  return parts.filter(Boolean).join(" ");
}
