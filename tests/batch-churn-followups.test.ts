import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHome } from "../shared/home";
import { briefOutlived, liveFlag, sectionOf, type InboxRow } from "../shared/inbox";
import type { Sources } from "../server/inbox-classifier";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { runningFinishViolations } from "../shared/status-invariants";

/**
 * Three finds from the review-batch-churn renders (2026-11-23), each fixed for its class.
 * (a) a-running-agent-is-not-finished: Follow-up's repair started the main agent's next turn, and Home listed the
 *     workspace in Needs you as "Finished · No ask stated" with Sign off while the agent was working.
 */

const T0 = "2026-11-08T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const FOLLOW_UP_MESSAGE = '<paseo-system version="1" kind="agent-message" message-id="m">\nFollow-up batch\n</paseo-system>';

async function inboxFor(t: { after(fn: () => unknown): void }, status: () => string, lastUserMessageAt: () => string | null = () => null) {
  const dir = await mkdtemp(join(tmpdir(), "churn-followups-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let minute = 1;
  const agentInfo = (): AgentInfo => ({ id: "a1", workspaceId: "w1", parentAgentId: null, title: "Main", status: status(), archivedAt: null, updatedAt: T0, lastUserMessageAt: lastUserMessageAt(), requiresAttention: false, attentionReason: null });
  const directory: Directory = {
    async agents() { return [agentInfo()]; },
    async workspaces() { return [{ id: "w1", name: "Webhook signatures" }]; },
    async agent(id) { return id === "a1" ? agentInfo() : null; },
    async tail() { return [{ type: "user_message", text: FOLLOW_UP_MESSAGE }]; },
    async clearAttention() {},
  };
  const none: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };
  const inbox = testStore(Inbox, dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: none, guard: async () => null, graceMs: 5, now: () => Date.parse(at(minute)) });
  await inbox.store.mutate(s => { s.importedAt = T0; s.lastSeen = at(0); s.primedAt = T0; s.notifiedAt = T0; });
  return { inbox, tick: (m: number) => { minute = m; }, row: async () => { await (inbox as unknown as { refreshDirectory(): Promise<void> }).refreshDirectory(); return (await inbox.list()).rows.find(r => r.agentId === "a1")!; } };
}

test("a-running-agent-is-not-finished: Follow-up's message starts the next turn, and the last turn's finish that asked nothing leaves Needs you", async t => {
  let status = "idle";
  const f = await inboxFor(t, () => status);
  await f.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "completed" }, "t1");
  const finished = await f.row();
  assert.equal(sectionOf(finished, Date.parse(at(2))), "needs", "an idle agent's finish is news");
  assert.ok(!finished.brief || finished.brief.source === "none", "and it asked nothing");

  // Follow-up's repair goes out and the agent starts working on it.
  f.tick(5); status = "running";
  await f.inbox.turnStarted({ id: "a1", workspaceId: "w1" }, "t2");
  const working = await f.row();
  assert.equal(working.needs, null, "a running agent is not 'Finished'");
  assert.equal(working.brief, null, "and no surface draws the last turn's \"Finished · No ask stated\" card");
  assert.equal(sectionOf(working, Date.parse(at(6))), "running");
  const home = buildHome({ rows: [working], tracked: [], paseo: [{ id: "w1", name: "Webhook signatures", project: null }], now: Date.parse(at(6)) } as never);
  assert.equal(home.needs, 0, "Home has nothing in Needs you for it");
  assert.equal(home.byKey.get("agent:a1")?.group, "running", "it reads as working");
  assert.deepEqual(runningFinishViolations([working]), []);

  // The turn ends: its own finish flags again.
  f.tick(9); status = "idle";
  await f.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "completed" }, "t2");
  assert.equal(sectionOf(await f.row(), Date.parse(at(10))), "needs");
});

test("a-running-agent-is-not-finished: after a worker restart mid-turn, the turn's prompt stands in for its unrecorded start", async t => {
  // 2026-11-23 (the batch-churn renders, state c): the plugin was disabled and enabled while the agent worked; the new
  // worker had no turn start for it, so Home listed the running workspace in Needs you as finished again.
  let status = "idle"; let prompt: string | null = null;
  const f = await inboxFor(t, () => status, () => prompt);
  await f.inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "completed" }, "t1");
  // Follow-up's message (a user message to Paseo) starts the next turn, but this worker never sees turn_started.
  f.tick(5); status = "running"; prompt = at(4);
  const working = await f.row();
  assert.equal(working.turnStartedAt, at(4), "the prompt that started the turn is its start");
  assert.equal(working.needs, null, "a running agent is not 'Finished'");
  assert.deepEqual(runningFinishViolations([working]), []);
  // A prompt older than the finish (a turn Paseo started on its own) says nothing about it: the finish stands.
  prompt = at(0);
  assert.equal((await f.row()).needs?.reasons[0]?.reason, "finished");
});

test("a-running-agent-is-not-finished: a finish that asks something, or has an open question, still stands while the agent works", () => {
  const needs = { reasons: [{ reason: "finished" as const, at: at(1), detail: "", dedupeKey: "a1:finished" }], since: at(1) };
  const ask = { kind: "decision", source: "agent", state: "open", at: at(1) };
  assert.deepEqual(liveFlag("running", needs, ask, at(5)).needs, needs, "a real ask stands");
  const question = { kind: "unknown", source: "none", state: "open", at: at(1), questionIds: ["Q1"] };
  assert.deepEqual(liveFlag("running", needs, question, at(5)).needs, needs, "an open question stands");
  const noAsk = { kind: "unknown", source: "none", state: "open", at: at(1) };
  assert.equal(liveFlag("running", needs, noAsk, at(5)).needs, null, "no ask: outlived");
  assert.equal(liveFlag("running", needs, noAsk, at(5)).brief, null, "its card too");
  assert.deepEqual(liveFlag("running", needs, ask, at(5)).brief, ask, "a real ask's card stays");
  assert.deepEqual(liveFlag("running", needs, noAsk, at(0)).needs, needs, "a finish newer than the turn start is this turn's");
  assert.deepEqual(liveFlag("running", needs, noAsk, null).needs, needs, "without a known turn start nothing is dropped");
  assert.deepEqual(liveFlag("idle", needs, noAsk, at(5)).needs, needs, "an idle agent keeps it");
});

test("a-running-agent-is-not-finished: the invariant catches a running row that still flags an outlived finish", () => {
  const row = { agentId: "a1", status: "running", turnStartedAt: at(5), needs: { reasons: [{ reason: "finished", at: at(1), detail: "", dedupeKey: "a1:finished" }], since: at(1) }, brief: { kind: "unknown", source: "none", state: "open", ask: "No ask stated", at: at(1) } } as unknown as InboxRow;
  assert.equal(runningFinishViolations([row]).length, 1);
  assert.deepEqual(runningFinishViolations([{ ...row, status: "idle" }]), []);
});

test("a-running-agent-is-not-finished: the chat's card of an outlived finish reads as the turn before", () => {
  const noAsk = { kind: "unknown", source: "none", state: "open", at: at(1) };
  const running = { status: "running", turnStartedAt: at(5) };
  assert.equal(briefOutlived(noAsk, running), true);
  assert.equal(briefOutlived(noAsk, { status: "idle", turnStartedAt: null }), false, "an idle agent's finish is its news");
  assert.equal(briefOutlived(noAsk, { status: "running", turnStartedAt: at(0) }), false, "this turn's own card");
  assert.equal(briefOutlived({ ...noAsk, questionIds: ["Q1"] }, running), false, "an open question stands");
  assert.equal(briefOutlived({ ...noAsk, kind: "decision", source: "agent" }, running), false, "a real ask stands");
  assert.equal(briefOutlived({ ...noAsk, state: "answered" }, running), false, "only an open card");
});
