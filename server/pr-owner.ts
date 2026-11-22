import type { State, Workspace } from "../shared/model";
import { buildHome, GROUP_TITLE, HOME_GROUPS, type BadgeTone, type HomeGroupId, type Workstream } from "../shared/home";
import { isLive } from "../shared/agent-load";

/** Duplicate claims are ambiguous. Never route by recency or by PR title. */
export function prOwner(state: State, repo: string, number: number) {
  const claims = state.workspaces.filter(w => w.enable_tracking && !w.archived)
    .flatMap(w => w.prs.filter(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)
      .map(p => ({ workspaceId: w.id, agentId: p.registeredAgentId ?? w.mainAgentId })));
  return claims.length === 1 ? claims[0] : null;
}

/** Only repository identities from active tracked PRs cross the browser bridge. */
export function browserRepositories(state: State): string[] {
  return [...new Set(state.workspaces.filter(w => w.enable_tracking && !w.archived)
    .flatMap(w => w.prs.map(p => p.repo.toLowerCase())))]
    .filter(repo => repo.length <= 201 && /^[\w.-]+\/[\w.-]+$/.test(repo) && repo.split("/").every(p => p !== "." && p !== ".."))
    .sort().slice(0, 100);
}

/** The live Paseo facts about a workspace's main agent that the browser view needs. */
export type BrowserAgent = { status: string; pendingPermissions?: unknown[]; requiresAttention?: boolean; attentionReason?: string | null; backgroundWork?: { count?: unknown } | null };
/**
 * The color of a row's state, so the browser never parses Follow-up's English. It comes from the same tone Home paints
 * the row's first badge (or headline) with: attention (amber), danger (red), success (green), accent (blue: running,
 * sending, finished), muted.
 */
export const BROWSER_TONES = ["attention", "danger", "success", "accent", "muted"] as const;
export type BrowserTone = typeof BROWSER_TONES[number];
const TONE: Record<BadgeTone | Workstream["tone"], BrowserTone> = { warning: "attention", danger: "danger", success: "success", merged: "success", accent: "accent", running: "accent", muted: "muted" };
export type BrowserWorkspaceView = { group: HomeGroupId; state: string; tone: BrowserTone };
export type BrowserWorkspace = { workspaceId: string; agentId: string; title: string; agentStatus: string } & BrowserWorkspaceView;
export const BROWSER_WORKSPACE_LIMIT = 3;

/** Every active tracked workspace that registered this PR. Unlike `prOwner`, several are expected: a stack or a review workspace. */
export function prClaims(state: State, repo: string, number: number): Workspace[] {
  return state.workspaces.filter(w => w.enable_tracking && !w.archived && w.prs.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What Follow-up is fixing, in the words a PR page reader expects: threads, checks, conflicts. */
function fixDetail(w: Workspace, fallback: string): string {
  const open = w.prs.map(p => p.snapshot).filter(s => s?.state === "OPEN" && s.complete);
  const threads = open.reduce((n, s) => n + s!.threads.length, 0);
  const checks = open.reduce((n, s) => n + s!.failedChecks.length, 0);
  if (threads) return plural(threads, "thread");
  if (checks) return plural(checks, "failing check");
  if (open.some(s => s!.conflict)) return "Conflict";
  return fallback;
}

/**
 * Follow-up's one line for a workspace ("Needs you · Merge ready"), from the same model Home uses, plus the
 * main agent's live Paseo attention, which Home reads from the inbox and the server does not have otherwise.
 */
export function browserWorkspaceState(w: Workspace, agent: BrowserAgent | null, now = Date.now()): BrowserWorkspaceView {
  const row = buildHome({ rows: [], tracked: [w], paseo: [], now }).byKey.get(`ws:${w.id}`);
  const group = row?.group ?? "quiet";
  if (group === "needs") return { group, state: `${GROUP_TITLE.needs} · ${row!.badges[0]?.text ?? row!.word ?? "Action"}`, tone: TONE[row!.badges[0]?.tone ?? row!.tone] };
  if (!agent) {
    // The main agent is closed. Done work has nothing left to do; anything else needs the developer to pick an agent.
    return row?.readyToArchive ? { group, state: "Done · ready to archive", tone: "success" } : { group: "needs", state: `${GROUP_TITLE.needs} · Agent closed`, tone: "attention" };
  }
  if (agent.pendingPermissions?.length || agent.attentionReason === "permission") return { group: "needs", state: `${GROUP_TITLE.needs} · Permission`, tone: TONE.warning };
  // Paseo's attention reason outlives the turn it describes: a running agent's "error" is the last turn's, not now's.
  // 0.16: live background work counts as running too (no "Finished" while a job it started still runs).
  const running = isLive(agent);
  if (agent.status === "error" || agent.attentionReason === "error" && !running) return { group: "needs", state: `${GROUP_TITLE.needs} · Error`, tone: TONE.danger };
  if (group === "sending") return { group, state: `${GROUP_TITLE.sending} · ${fixDetail(w, row!.line)}`, tone: TONE.running };
  if (group === "running" || running) return { group: "running", state: GROUP_TITLE.running, tone: TONE.running };
  if (agent.requiresAttention) return { group: "needs", state: `${GROUP_TITLE.needs} · Finished`, tone: TONE.accent };
  if (group === "waiting") return { group, state: row!.line ? `${GROUP_TITLE.waiting} · ${row!.line}` : GROUP_TITLE.waiting, tone: TONE.muted };
  return row?.readyToArchive ? { group, state: "Done · ready to archive", tone: TONE.success } : { group, state: GROUP_TITLE.quiet, tone: TONE.muted };
}

/**
 * Most urgent first, then most recently updated. At most three; `more` counts the rest. A claim whose main agent is
 * closed (`agent: null`) stays, as "Needs you · Agent closed" with `agentStatus: "closed"`; the caller leaves out a claim
 * whose agent it couldn't read at all, since an unknown agent is not a closed one.
 */
export function browserWorkspaces(entries: { workspace: Workspace; agent: BrowserAgent | null }[], now = Date.now()): { workspaces: BrowserWorkspace[]; more: number } {
  const rows = entries.map(({ workspace: w, agent }) => ({ w, view: { workspaceId: w.id, agentId: w.mainAgentId, title: w.title, agentStatus: !agent ? "closed" : agent.pendingPermissions?.length ? "permission" : agent.status, ...browserWorkspaceState(w, agent, now) } }));
  rows.sort((a, b) => HOME_GROUPS.indexOf(a.view.group) - HOME_GROUPS.indexOf(b.view.group) || b.w.updatedAt.localeCompare(a.w.updatedAt) || a.w.id.localeCompare(b.w.id));
  return { workspaces: rows.slice(0, BROWSER_WORKSPACE_LIMIT).map(r => r.view), more: Math.max(0, rows.length - BROWSER_WORKSPACE_LIMIT) };
}
