import { WATCH_DEFAULT_MS, parsePrRef } from "../shared/check-watch";
import type { State, Workspace } from "../shared/model";
import type { CheckWatches } from "./check-watches";
import { githubOffText, type GithubOff } from "../shared/github-setup";

/** How long the tool waits for its own workspace's nudged read before it answers from what it has. */
export const ANSWER_READ_MS = 8_000;

type Input = { agentId: string; prs?: string[]; minutes?: number; cancel?: boolean };
type Deps = {
  state: () => Promise<State>;
  watches: Pick<CheckWatches, "add" | "answered" | "cancel" | "check">;
  /** The engine's nudge of one workspace: its PRs read with the usual backoff (a watched PR is due once). */
  nudge: (workspaceId: string) => Promise<void>;
  hostVersion: () => Promise<string>;
  /** The caller's workspace as Paseo knows it (for an untracked caller's wording only). */
  callerWorkspace?: () => Promise<string | null>;
  /** register_pr's own path, for the caller's PR that Follow-up doesn't follow yet. */
  register?: (repo: string, number: number) => Promise<unknown>;
  readMs?: number;
  /** Why GitHub is off on the host (works-without-github), or null: then nothing is watched and the answer says so. */
  githubOff?: () => Promise<GithubOff | null>;
};
type Answer = { text: string; waiting: string[]; done: { pr: string; result: string; text: string }[]; notFollowed: string[] };

/** GitHub off (works-without-github): nothing is watched, and the answer says what's missing and how to turn it on. */
export function githubOffChecksAnswer(off: GithubOff, prs?: string[]): Answer {
  return { text: `${githubOffText(off, "Waiting for checks")} Until then, end your turn and check once later; never poll in a loop.`, waiting: [], done: [], notFollowed: prs?.length ? prs : ["this workspace's PRs"] };
}
/** Paseo 0.17 serves subscribe_change_request; the version is the only sign (server_info has no feature flag for it). */
export function hostWatches(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 17);
}
export function unseenAdvice(version: string): string {
  return hostWatches(version)
    ? "Paseo can watch it instead: call subscribe_change_request with the PR's URL and end your turn; Paseo messages you when its checks finish."
    : "End your turn and check it once later (a single gh pr checks), never in a loop.";
}
const ownerOf = (state: State, agentId: string): Workspace | undefined =>
  state.workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === agentId || w.contributorAgentIds?.includes(agentId)));
const open = (w: Workspace) => w.prs.filter(p => p.snapshot?.state !== "MERGED" && p.snapshot?.state !== "CLOSED");

/**
 * wait_for_checks: one watch per PR, answered at once from Follow-up's own read of the caller's workspace (the engine's
 * nudge: a probe for a PR read before), then one message after the turn when the checks finish
 * (docs/wait-for-checks.md). Scoped to the caller's own workspace; PRs Follow-up can't see are named with the way on.
 */
export async function waitForChecksAnswer(input: Input, deps: Deps): Promise<Answer> {
  const state = await deps.state();
  const w = ownerOf(state, input.agentId);
  const refs = input.prs ?? [];
  if (input.cancel) {
    let n = 0;
    if (!refs.length) n = await deps.watches.cancel(input.agentId);
    else for (const ref of refs) { const key = keyFor(w, ref); if (key) n += await deps.watches.cancel(input.agentId, key); }
    return { text: n ? `Stopped waiting on ${n} PR${n === 1 ? "" : "s"}.` : "You weren't waiting on any of those.", waiting: [], done: [], notFollowed: [] };
  }
  const off = await deps.githubOff?.();
  if (off) return githubOffChecksAnswer(off, input.prs);
  if (!w) {
    const advice = unseenAdvice(await deps.hostVersion());
    return { text: `Follow-up doesn't follow this workspace, so it can't tell you when checks finish. ${advice}`, waiting: [], done: [], notFollowed: refs.length ? refs : ["this workspace's PRs"] };
  }
  const notFollowed: string[] = [];
  const reasons: string[] = [];
  const keys: string[] = [];
  if (!refs.length) keys.push(...open(w).map(p => p.key));
  for (const ref of refs) {
    const parsed = parsePrRef(ref);
    if (!parsed) { notFollowed.push(ref); reasons.push(`"${ref}" isn't a PR URL, owner/repo#N or number.`); continue; }
    if (parsed.forge === "other") { notFollowed.push(ref); continue; }
    const matches = parsed.repo ? w.prs.filter(p => p.key.toLowerCase() === `${parsed.repo}#${parsed.number}`.toLowerCase()) : w.prs.filter(p => p.number === parsed.number);
    if (matches.length === 1) { keys.push(matches[0].key); continue; }
    if (!parsed.repo) { notFollowed.push(ref); reasons.push(matches.length ? `#${parsed.number} is ambiguous here; use owner/repo#${parsed.number}.` : `#${parsed.number} isn't one of this workspace's PRs.`); continue; }
    // The caller's own PR, not registered yet: register it as register_pr would (its stack can be fixed later).
    if (deps.register) {
      try { await deps.register(parsed.repo, parsed.number); keys.push(`${parsed.repo}#${parsed.number}`); continue; }
      catch (error) { reasons.push(`${parsed.repo}#${parsed.number}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    notFollowed.push(ref);
  }
  const unique = [...new Set(keys)];
  if (!unique.length) {
    const advice = notFollowed.length ? ` ${unseenAdvice(await deps.hostVersion())}` : "";
    return { text: (refs.length ? `Follow-up doesn't follow ${notFollowed.join(", ")}.${reasons.length ? " " + reasons.join(" ") : ""}` : "This workspace has no open PRs Follow-up follows. Register yours with register_pr, then call again.") + advice, waiting: [], done: [], notFollowed };
  }
  const ms = (input.minutes ?? WATCH_DEFAULT_MS / 60_000) * 60_000;
  const urls = new Map((await deps.state()).workspaces.find(x => x.id === w.id)?.prs.map(p => [p.key, p.snapshot?.url ?? ""]) ?? []);
  const watches = [];
  for (const key of unique) watches.push(await deps.watches.add({ agentId: input.agentId, workspaceId: w.id, prKey: key, url: urls.get(key) ?? "", ms }));
  // One read of this workspace's due PRs (each watched PR is due once after its wait began), bounded: past it the
  // watch answers by message like any other.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([deps.nudge(w.id).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, deps.readMs ?? ANSWER_READ_MS); })]);
  clearTimeout(timer);
  const done: Answer["done"] = [];
  const waiting: string[] = [];
  for (const watch of watches) {
    const { fire } = await deps.watches.check(watch).catch(() => ({ fire: null }));
    await deps.watches.answered(watch.id, !!fire);
    if (fire) done.push({ pr: watch.prKey, result: fire.kind, text: fire.text });
    else waiting.push(watch.prKey);
  }
  const lines = [
    ...done.map(d => d.text),
    waiting.length ? `Waiting on ${waiting.join(", ")}. End your turn now: Follow-up sends you one message when the checks on the current head finish (or it merges, closes or conflicts), from the reads it already makes. Don't poll GitHub meanwhile.` : null,
    notFollowed.length ? `Not followed by Follow-up: ${notFollowed.join(", ")}.${reasons.length ? " " + reasons.join(" ") : ""} ${unseenAdvice(await deps.hostVersion())}` : null,
  ].filter(Boolean);
  return { text: lines.join("\n"), waiting, done, notFollowed };
}
function keyFor(w: Workspace | undefined, ref: string): string | null {
  const parsed = parsePrRef(ref);
  if (!parsed) return null;
  if (parsed.repo) return `${parsed.repo}#${parsed.number}`;
  return w?.prs.find(p => p.number === parsed.number)?.key ?? null;
}
