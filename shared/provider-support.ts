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
const isAcp = (provider: string) => (ACP_PROVIDERS as readonly string[]).includes(provider);
const list = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The one line that says what agents on the developer's other providers miss, and why; null when every available
 * provider has hooks. Settings → Agents shows it under the helper rows.
 */
export function noHooksLine(providers: readonly { id: string; label: string; available: boolean }[]): string | null {
  const others = providers.filter(p => p.available && !hasHooks(p.id));
  if (!others.length) return null;
  const prompt = others.filter(p => !isAcp(p.id)).map(p => p.label);
  const acp = others.filter(p => isAcp(p.id)).map(p => p.label);
  const why = "the turn-end reminders (sync, needs you, due tasks) and Wait run as Claude Code and Codex hooks";
  const parts = [
    prompt.length ? `Agents on ${list(prompt)} get Follow-up's tools and instructions, not ${why.replace(" run as", ", which run as")}.` : null,
    acp.length ? `Agents on ${list(acp)} get the tools only: Paseo doesn't pass plugin instructions to ACP agents yet, and ${why}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}
