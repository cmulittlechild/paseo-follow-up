import test from "node:test";
import assert from "node:assert/strict";
import { buildHome, homeCounts } from "../shared/home";
import { flagFate, OLDER_AFTER_MS, type InboxRow, type Reason } from "../shared/inbox";
import { homeGroupOpen } from "../shared/settings-nav";
import { listEntries, OLDER_NOTE } from "../shared/list-entries";
import { syncTaskQuestions } from "../server/questions";
import { updateObligation } from "../server/obligations";
import { closedFlagViolations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * 2026-11-22, live: 49 agents flagged in Needs you, 42 of them closed. Closed agents' "No ask stated" and "finished"
 * flags asked nothing; two sat in workspaces archived 13 days before; a dozen asks were over a week old from agents
 * nobody would resume. Invariant briefs-from-closed-agents: such a flag leaves Needs you (drop) or folds into Older,
 * and never hides an ask that is still live.
 */
const NOW = clock;
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const row = (agentId: string, o: { status?: string; reasons?: Reason[]; days?: number; kind?: string; source?: string; questionIds?: string[]; workspaceTitle?: string | null; workspaceId?: string } = {}): InboxRow => {
  const days = o.days ?? 0.1;
  const reasons = (o.reasons ?? ["finished"]).map(reason => ({ reason, at: at(days), detail: reason, dedupeKey: `${agentId}:${reason}` }));
  return {
    agentId, workspaceId: o.workspaceId ?? `w-${agentId}`, title: "Main", workspaceTitle: o.workspaceTitle === undefined ? `Workspace ${agentId}` : o.workspaceTitle, multiRoot: false,
    status: o.status ?? "closed", delegatedFrom: null, resumesAt: null, lastActivityAt: at(days), needs: { reasons, since: at(days) }, snooze: null, signedOffAt: null,
    undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true,
    brief: o.kind ? { kind: o.kind as never, source: (o.source ?? "agent") as never, state: "open", ask: `${o.kind} ask`, at: at(days), ...(o.questionIds ? { questionIds: o.questionIds } : {}) } : null,
  };
};
const groupOf = (model: ReturnType<typeof buildHome>, agentId: string) => model.groups.find(g => g.items.some(i => i.key === `agent:${agentId}`))?.id ?? null;

test("briefs-from-closed-agents: what each flag does, from the facts Follow-up holds", () => {
  const fate = (r: InboxRow, archived = false) => flagFate(r, NOW, archived);
  // drop: nobody can act on it.
  assert.equal(fate(row("a", { kind: "unknown", days: 5 })), "drop", "a closed agent's 'No ask stated' asks nothing");
  assert.equal(fate(row("a", { days: 9 })), "drop", "a closed agent's bare finish");
  assert.equal(fate(row("a", { reasons: ["pr_merged"], days: 6 })), "drop", "a PR-merged note from a closed agent");
  assert.equal(fate(row("a", { kind: "error", reasons: ["error"], days: 13 }), true), "drop", "an archived workspace");
  assert.equal(fate(row("a", { status: "idle", kind: "permission", reasons: ["permission"], days: 13, workspaceTitle: null })), "drop", "a workspace gone from Paseo's list");
  // older: a real ask from an agent closed for days.
  assert.equal(fate(row("a", { kind: "action", days: 5 })), "older");
  assert.equal(fate(row("a", { kind: "review", days: 12 })), "older");
  assert.equal(fate(row("a", { reasons: ["error"], days: 13 })), "older", "an error asks for a look, so it folds, never drops");
  assert.equal(fate(row("a", { kind: "unknown", questionIds: ["Q4"], days: 5 })), "older", "a brief pointing at a question asks, whatever its kind");
  // show: a live ask is never hidden.
  assert.equal(fate(row("a", { kind: "action", days: 1 })), "show", "a closed agent's fresh ask");
  assert.equal(fate(row("a", { kind: "action", days: 3 - 1 / 24 })), "show", "under three days");
  assert.equal(fate(row("a", { status: "idle", kind: "action", days: 30 })), "show", "an idle agent's ask, however old");
  assert.equal(fate(row("a", { status: "idle", kind: "unknown", days: 30 })), "show", "an idle agent can still read an answer");
  assert.equal(fate(row("a", { status: "running", kind: "action", days: 2, workspaceTitle: null })), "show", "a running agent, even outside the list");
  assert.equal(fate({ ...row("a", { kind: "action", days: 1 }), workspaceId: null, workspaceTitle: null }), "show", "an agent without a workspace");
  // A newer flag on an old brief keeps it in Needs you.
  const fresh = row("a", { kind: "action", days: 6 });
  fresh.needs!.reasons.push({ reason: "pr_merged", at: at(0.2), detail: "#5 merged", dedupeKey: "m" });
  assert.equal(fate(fresh), "show");
  assert.equal(OLDER_AFTER_MS, 3 * DAY);
});

test("briefs-from-closed-agents: Home drops what nobody can act on and folds old closed asks into Older, out of the count", () => {
  const rows = [
    row("unknown", { kind: "unknown", days: 5 }), row("bare", { days: 9 }), row("merged", { reasons: ["pr_merged"], days: 3.1 }),
    row("archived", { kind: "error", reasons: ["error"], days: 13 }), row("gone", { status: "idle", kind: "permission", reasons: ["permission"], days: 13, workspaceTitle: null }),
    row("old-action", { kind: "action", days: 5 }), row("old-review", { kind: "review", days: 12 }),
    row("new-action", { kind: "action", days: 0.3 }), row("idle-action", { status: "idle", kind: "action", days: 8 }),
  ];
  const model = buildHome({ rows, tracked: [workspace({ id: "w-archived", mainAgentId: "archived", archived: true })], paseo: [], now: NOW });
  for (const id of ["unknown", "bare", "merged", "archived", "gone"]) assert.equal(groupOf(model, id), null, `${id} leaves Needs you`);
  assert.equal(groupOf(model, "old-action"), "older");
  assert.equal(groupOf(model, "old-review"), "older");
  assert.equal(groupOf(model, "new-action"), "needs");
  assert.equal(groupOf(model, "idle-action"), "needs");
  const counts = homeCounts(model);
  assert.equal(counts.needs, 2, "the badge, the strip and the brief headline count only what's live");
  assert.equal(counts.older, 2);
  assert.equal(model.groups[1]?.title, "Older", "Older sits right under Needs you");
  assert.equal(homeGroupOpen("older", { get: () => null, set: () => undefined }), false, "Older starts folded");
  const tracked = [workspace({ id: "w-archived", mainAgentId: "archived", archived: true })];
  assert.deepEqual(closedFlagViolations(model, rows, tracked, NOW), []);
  // The checker catches a live ask filed under Older, and a dropped flag drawn anyway.
  const wrong = new Map(model.byKey);
  wrong.set("agent:idle-action", { ...wrong.get("agent:idle-action")!, group: "older" });
  wrong.set("agent:bare", { ...wrong.get("agent:old-action")!, key: "agent:bare", agentId: "bare" });
  assert.deepEqual(closedFlagViolations({ byKey: wrong }, rows, tracked, NOW).map(v => v.detail), ["bare asks nothing anyone can act on but shows in older", "idle-action is in Older but is idle with a flag from the last 3 days"]);
  // Open, Older says why its rows are there (their ages alone can't); folded, it's one header.
  const entries = (closed: Set<string>) => listEntries({ model, closed, openProjects: new Set(), pages: {}, results: null, hits: null, filter: null, overseer: false, touch: false, afterNeeds: false } as never);
  assert.deepEqual(entries(new Set()).filter(e => e.key === "l:older").map(e => (e as { text: string }).text), [OLDER_NOTE]);
  assert.equal(entries(new Set(["older"])).some(e => e.key === "l:older" || (e.type === "row" && e.s.group === "older")), false);
  // It comes back the moment the agent runs again.
  const back = buildHome({ rows: rows.map(r => r.agentId === "old-action" ? { ...r, status: "idle" } : r), tracked: [], paseo: [], now: NOW });
  assert.equal(groupOf(back, "old-action"), "needs");
});

test("briefs-from-closed-agents: an old closed ask stays in Needs you while its workspace has a live item", () => {
  const w = workspace({ id: "w-main", mainAgentId: "main", prs: [], obligations: [] });
  updateObligation(w, { title: "Pick the export layout", status: "blocked", evidence: "Both layouts are built.", ask: "Which export layout should ship?", caller: "main" });
  syncTaskQuestions(w, NOW);
  const model = buildHome({ rows: [row("main", { kind: "action", days: 5, workspaceId: "w-main" })], tracked: [w], paseo: [], now: NOW });
  assert.equal(groupOf(model, "main"), "needs", "an open question in the workspace keeps the row where it's seen");
  // Dropping a row never hides the workspace's own item: the workspace row carries it.
  const dropped = buildHome({ rows: [row("main", { kind: "unknown", days: 5, workspaceId: "w-main" })], tracked: [w], paseo: [], now: NOW });
  assert.equal(groupOf(dropped, "main"), null);
  assert.equal(dropped.groups.find(g => g.id === "needs")?.items.some(i => i.key === "ws:w-main"), true);
});
