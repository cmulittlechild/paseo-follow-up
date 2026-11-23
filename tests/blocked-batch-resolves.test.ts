import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import { queueEngine } from "./support/queue";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Runtime, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import type { Snapshot, Workspace } from "../shared/model";
import { headline, needsYou } from "../shared/attention";
import { batchView } from "../shared/status";
import { violations } from "../shared/status-invariants";
import { repairRows } from "../shared/task-rows";
import { clock, workspace, pr, snapshot } from "./fixtures";

// 2026-11-18 (2.2.0): a repair batch the agent acknowledged blocked ("nothing for an agent to fix; the reviewer must
// re-review or dismiss their stale review") stayed in Needs you as "The tasks didn't finish" with Open main agent,
// still there two hours after its PR merged. Invariants a-batch-item-leaves-once-nothing-applies and
// a-human-only-outcome-is-a-human-item.

async function fixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-blocked-"));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; const state: Runtime = { busy: false, reason: null, archived: false };
  const observations = new Map<string, Snapshot | null>(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: { messageId: string; text: string }[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery", contextPath: "/fixture/recovery.json" }), observe: async () => state,
    send: async (_w, b, text) => { sends.push({ messageId: b.messageId, text }); }, label: async () => {}, arrived: async () => null,
    recoveryRuntime: async () => ({ busy: false, reason: null }) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => { const s = observations.get(p.key); return [p.key, s ? { snapshot: { ...s, observedAt: new Date(now).toISOString() }, error: null } : { snapshot: null, error: "GitHub didn't answer" }]; })) };
  const engine = new Engine(store, github, gateway, () => now);
  await queueEngine(engine, gateway, root);
  const get = async () => (await store.snapshot()).workspaces[0];
  return { engine, sends, get, store, now: () => now, advance: (ms: number) => { now += ms; }, observe: (key: string, s: Snapshot | null) => observations.set(key, s) };
}
/** A PR whose only review is a stale CHANGES_REQUESTED: no open threads, nothing left in the code. */
const staleReview = () => snapshot({ reviewDecision: "CHANGES_REQUESTED" });
const reviewed = () => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: staleReview() })] });
const STALE = "No change since the last two batches: 0 unresolved threads. CHANGES_REQUESTED is alice's stale review (the bot's fix is already in). Needs the reviewer to re-review or dismiss; nothing for an agent to fix.";

/** Queue and send the review repair, then let the agent acknowledge it blocked. */
async function blockedBy(f: Awaited<ReturnType<typeof fixture>>, result = STALE, humanOnly?: boolean) {
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, "the review repair went out");
  const sent = (await f.get()).batches.find(b => b.state === "sent")!;
  await f.engine.acknowledge("main-agent", sent.id, "blocked", result, undefined, humanOnly);
  f.advance(1_000);
  return sent.id;
}
/** Needs you without the Done check, which rightly appears once every PR has merged. */
const kinds = (w: Workspace, now: number) => needsYou(w, now).filter(i => !(i.kind === "send" && i.finish)).map(i => i.kind);

test("a blocked review batch leaves Needs you once its PR merges (no hand edit)", async t => {
  const f = await fixture(t, reviewed());
  const id = await blockedBy(f, "The build tool is missing on this machine.");
  await f.engine.tick();
  assert.deepEqual(kinds(await f.get(), f.now()), ["retry"], "while the PR is open, the agent's blocker is the developer's");
  f.observe("example/app#1", snapshot({ state: "MERGED", reviewDecision: "APPROVED", mergedAt: new Date(f.now()).toISOString() }));
  f.advance(60_000); await f.engine.tick();
  const w = await f.get();
  const b = w.batches.find(b => b.id === id)!;
  assert.notEqual(b.state, "blocked");
  assert.match(b.result, /#1 merged/);
  assert.deepEqual(kinds(w, f.now()), [], "nothing it asked for still applies");
  assert.equal(batchView(w, f.now())?.kind, "finish", "what's left is the Done check, not a stuck repair");
  assert.deepEqual(violations(w, f.now()), []);
});

test("a blocked batch settles when the condition behind it is gone, though the PR is still open", async t => {
  const f = await fixture(t, reviewed());
  const id = await blockedBy(f, "The build tool is missing on this machine.");
  f.observe("example/app#1", snapshot({ reviewDecision: "APPROVED" }));
  f.advance(60_000); await f.engine.tick();
  const w = await f.get();
  assert.equal(w.batches.find(b => b.id === id)!.state, "cancelled");
  assert.match(w.batches.find(b => b.id === id)!.result, /GitHub no longer shows/);
  assert.deepEqual(kinds(w, f.now()), []);
});

test("unknown is not off: a PR GitHub didn't answer for keeps its blocked batch", async t => {
  const f = await fixture(t, reviewed());
  const id = await blockedBy(f, "The build tool is missing on this machine.");
  f.observe("example/app#1", null);
  f.advance(60_000); await f.engine.tick();
  assert.equal((await f.get()).batches.find(b => b.id === id)!.state, "blocked");
});

test("an unconfirmed batch whose PR merged settles too", async t => {
  const w = reviewed();
  w.prs[0].snapshot = snapshot({ state: "MERGED", reviewDecision: "APPROVED" });
  w.batches.push({ id: "u", messageId: "m", attempts: 1, result: "Delivery wasn't confirmed.", recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
    tasks: [{ key: "review:example/app#1", kind: "review", target: "example/app#1", title: "Use /fix-pr for example/app#1 (changes requested)", fingerprint: "f" }], state: "uncertain", createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), settledAt: null });
  const f = await fixture(t, w);
  f.observe("example/app#1", w.prs[0].snapshot!);
  await f.engine.tick();
  assert.equal((await f.get()).batches.find(b => b.id === "u")!.state, "cancelled");
  assert.deepEqual(kinds(await f.get(), f.now()), []);
});

test("the stale batch already in saved state clears at start-up, even in a workspace no tick observes", async t => {
  // The live shape: blocked, three attempts, its one review task on a PR the stored snapshot shows merged.
  const w = reviewed();
  w.dormant = true;
  w.prs[0].snapshot = snapshot({ state: "MERGED", reviewDecision: "APPROVED", mergedAt: new Date(clock).toISOString() });
  w.batches.push({ id: "old", messageId: "m", attempts: 3, result: STALE, recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
    tasks: [{ key: "review:example/app#1", kind: "review", target: "example/app#1", title: "Use /fix-pr for example/app#1 (changes requested)", fingerprint: "f" }], state: "blocked", createdAt: new Date(clock - 7_200_000).toISOString(), sentAt: new Date(clock - 7_200_000).toISOString(), settledAt: new Date(clock - 7_000_000).toISOString() });
  assert.ok(violations({ ...w, dormant: false }, clock).some(v => v.id === "a-batch-item-leaves-once-nothing-applies"), "the invariant catches it");
  const f = await fixture(t, w);
  await f.engine.recover();
  const b = (await f.get()).batches.find(b => b.id === "old")!;
  assert.equal(b.state, "cancelled");
  assert.equal(b.settledAt, new Date(clock - 7_000_000).toISOString(), "the blocker's own time stays in Activity");
});

test("a human-only outcome is a PR item for the developer, not an agent failure", async t => {
  const f = await fixture(t, reviewed());
  await blockedBy(f, STALE, true);
  await f.engine.tick();
  let w = await f.get();
  const items = needsYou(w, f.now());
  assert.ok(!items.some(i => i.kind === "retry"), "never \"The repairs didn't finish\"");
  const item = items.find(i => i.kind === "person");
  assert.ok(item, `a person item, got ${items.map(i => i.kind)}`);
  assert.equal(item.title, "#1 waits on its reviewer");
  assert.equal(item.detail, STALE);
  assert.equal(item.pr?.number, 1, "it opens the PR in one click");
  assert.equal(item.kind === "person" && item.prKey, "example/app#1");
  assert.deepEqual(w.heldTasks?.map(h => [h.task.key, h.held]), [["review:example/app#1", "person"]]);
  assert.equal(repairRows(w).open[0]?.text, "Needs you · waits on a person, not the agent");
  assert.equal(batchView(w, f.now()), null, "no agent card, no stuck batch");
  assert.ok(!headline(w, f.now()).some(p => /to fix/.test(p.text)), "the header doesn't call it the agent's to fix");
  assert.deepEqual(violations(w, f.now()), []);
  f.advance(600_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, "the agent isn't sent the same review again");
  // It doesn't hold the queue: another PR's conflict still goes out.
  await f.store.mutate(s => { s.workspaces[0].prs.push(pr({ key: "example/app#2", number: 2, snapshot: snapshot({ conflict: true }) })); });
  f.observe("example/app#2", snapshot({ conflict: true }));
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 2); assert.match(f.sends[1].text, /example\/app#2/); assert.doesNotMatch(f.sends[1].text, /example\/app#1/);
  // The reviewer re-reviews: the item goes on its own.
  f.observe("example/app#1", snapshot({ reviewDecision: "APPROVED" }));
  f.advance(60_000); await f.engine.tick();
  w = await f.get();
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "person"));
  assert.ok(!w.heldTasks?.some(h => h.held === "person"));
});

test("a human-only review item clears when its PR merges", async t => {
  const f = await fixture(t, reviewed());
  await blockedBy(f, STALE, true);
  f.observe("example/app#1", snapshot({ state: "MERGED", reviewDecision: "CHANGES_REQUESTED" }));
  f.advance(60_000); await f.engine.tick();
  assert.deepEqual(kinds(await f.get(), f.now()), []);
});

test("Send to agent hands a human-only task back to the agent (the same path as the retry_task tool)", async t => {
  const f = await fixture(t, reviewed());
  await blockedBy(f, STALE, true);
  await f.engine.tick();
  const { controlWorkspace } = await import("../server/agent-actions");
  await f.store.mutate(s => { controlWorkspace(s, { workspaceId: "workspace", retryTask: "review:example/app#1" }, f.now()); });
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 2); assert.match(f.sends[1].text, /example\/app#1/);
  assert.ok(!needsYou(await f.get(), f.now()).some(i => i.kind === "person"));
});

test("acknowledge_batch offers humanOnly, and only with blocked", async t => {
  const { tools } = await import("../server/mcp.mjs") as any;
  const ack = tools.find((x: any) => x[0] === "acknowledge_batch");
  assert.ok(ack[3].humanOnly, "the tool takes humanOnly");
  const f = await fixture(t, reviewed());
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  const sent = (await f.get()).batches.find(b => b.state === "sent")!;
  await assert.rejects(f.engine.acknowledge("main-agent", sent.id, "completed", "done", undefined, true), /humanOnly/);
});
