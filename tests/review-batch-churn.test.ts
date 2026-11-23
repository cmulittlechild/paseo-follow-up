import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import { queueEngine } from "./support/queue";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, healBatches, type Runtime, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import type { Batch, Snapshot, Workspace } from "../shared/model";
import { needsYou } from "../shared/attention";
import { activity } from "../shared/activity";
import { violations, INVARIANTS } from "../shared/status-invariants";
import { repairRows } from "../shared/task-rows";
import { backgroundCount, isLive } from "../shared/agent-load";
import { IN_PROGRESS_MAX_MS, sendDecision } from "../shared/send-decision";
import { clock, workspace, pr, snapshot } from "./fixtures";

// 2026-11-23: in one workspace a review kept getting new comments and replies. Each new fingerprint made a new message,
// and the one already sent was cancelled seconds later as "No longer needed: GitHub no longer shows what it asked for"
// although the review was still there, overwriting the agent's answer. The agent's "already on it with my subagent"
// (acknowledged blocked: there was no other word for it) showed as "The repairs didn't finish"; Retry sent the identical
// items again (attempts 2, then 3) and rewrote the answered batch as cancelled; a blocked answer held the queue, so
// nothing went out on its own. Invariant a-changed-review-updates-never-cancels.

const PR = "acme/app#12";
const thread = (id: string, at: string) => ({ id, updatedAt: at });
const review = (threads: { id: string; updatedAt: string }[]) => snapshot({ threads });
const T1 = thread("t1", "2026-01-01T09:00:00Z");

async function fixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-churn-"));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; const runtime: Runtime = { busy: false, reason: null, archived: false, backgroundBusy: false, mainBusy: null };
  const observations = new Map<string, Snapshot | null>(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: { messageId: string; text: string }[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery", contextPath: "/fixture/recovery.json" }), observe: async () => ({ ...runtime }),
    send: async (_w, b, text) => { sends.push({ messageId: b.messageId, text }); }, label: async () => {}, arrived: async () => null,
    recoveryRuntime: async () => ({ busy: false, reason: null }) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => { const s = observations.get(p.key); return [p.key, s ? { snapshot: { ...s, observedAt: new Date(now).toISOString() }, error: null } : { snapshot: null, error: "GitHub didn't answer" }]; })) };
  const engine = new Engine(store, github, gateway, () => now);
  await queueEngine(engine, gateway, root);
  const get = async () => (await store.snapshot()).workspaces[0];
  return { engine, sends, get, store, runtime, now: () => now, advance: (ms: number) => { now += ms; }, observe: (key: string, s: Snapshot | null) => observations.set(key, s) };
}
type F = Awaited<ReturnType<typeof fixture>>;
const reviewed = () => workspace({ enable_auto_sends: true, prs: [pr({ key: PR, repo: "acme/app", number: 12, snapshot: review([T1]) })] });

/** Queue the review repair, let it go out, and return the sent batch. */
async function sendOne(f: F): Promise<Batch> {
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  const sent = (await f.get()).batches.find(b => b.state === "sent");
  assert.ok(sent, "the review repair went out");
  return sent;
}
const IN_PROGRESS = "Dana's subagent is on these threads; its test run is going. It pushes once it passes.";

test("a review that gets new comments after it went out is an update, never \"No longer needed\"", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  await f.engine.acknowledge("main-agent", first.id, "blocked", IN_PROGRESS);
  // Sam adds a thread and replies on the first one a few minutes later: the same review, new content.
  f.advance(120_000);
  f.observe(PR, review([thread("t1", "2026-01-01T10:01:00Z"), thread("t2", "2026-01-01T10:01:30Z")]));
  await f.engine.tick();
  let w = await f.get();
  const old = w.batches.find(b => b.id === first.id)!;
  assert.doesNotMatch(old.result, /No longer needed/, "the review is still there");
  assert.equal(old.state, "blocked", "the agent's answer keeps its outcome");
  assert.equal(old.result, IN_PROGRESS, "and its words");
  assert.equal(old.movedOn?.why, "changed");
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "retry"), "an update isn't a failure");
  f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 2, "the update goes out on its own: the answered batch doesn't hold the queue");
  assert.match(f.sends[1].text, /since the last message: 1 new thread, 1 with new replies/, "the agent reads what moved, not the whole review again");
  w = await f.get();
  const row = activity(w).find(r => r.key === `stopped:${first.id}`);
  assert.ok(row && row.tone === "muted" && /updated on GitHub/.test(row.text), `Activity calls it an update, got ${JSON.stringify(row)}`);
  assert.deepEqual(violations(w, f.now()), []);
});

test("an unconfirmed send whose review changed is superseded, not \"No longer needed\"", async t => {
  const w = reviewed();
  w.batches.push({ id: "u", messageId: "m", attempts: 1, result: "Delivery wasn't confirmed.", recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
    tasks: [{ key: `review:${PR}`, kind: "review", target: PR, title: "Use /fix-pr for acme/app#12 (1 open thread)", fingerprint: "old", parts: ["t1@2026-01-01T08:00:00Z"] }], state: "uncertain", createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), settledAt: null });
  const f = await fixture(t, w);
  await f.engine.tick();
  const b = (await f.get()).batches.find(b => b.id === "u")!;
  assert.equal(b.state, "cancelled");
  assert.doesNotMatch(b.result, /No longer needed/);
  assert.equal(b.movedOn?.why, "changed");
});

test("\"No longer needed\" stays for a review that is really gone, and the answer keeps its words", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  await f.engine.acknowledge("main-agent", first.id, "blocked", IN_PROGRESS);
  f.observe(PR, review([]));
  f.advance(60_000); await f.engine.tick();
  const w = await f.get();
  const b = w.batches.find(b => b.id === first.id)!;
  assert.equal(b.movedOn?.why, "gone");
  assert.match(b.movedOn!.reason, /No longer needed/);
  assert.equal(b.result, IN_PROGRESS);
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "retry"));
});

test("in_progress: the same items aren't sent again while the agent's work runs; they wait for it to settle", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  await f.engine.acknowledge("main-agent", first.id, "in_progress", IN_PROGRESS);
  f.runtime.busy = true; f.runtime.backgroundBusy = true; // its subagent at work; the main agent is free
  let w = await f.get();
  const b = w.batches.find(b => b.id === first.id)!;
  assert.equal(b.state, "completed"); assert.equal(b.inProgress, true);
  for (let i = 0; i < 6; i++) { f.advance(10 * 60_000); await f.engine.tick(); }
  w = await f.get();
  assert.equal(f.sends.length, 1, "an hour of the subagent working sends nothing again");
  assert.ok(!w.batches.some(b => b.state === "pending"), "nothing queued for the same items");
  assert.ok(!needsYou(w, f.now()).length, `not a failure, got ${needsYou(w, f.now()).map(i => i.kind)}`);
  assert.match(repairRows(w, 20, f.now()).open[0]?.text ?? "", /is on it/);
  assert.deepEqual(violations(w, f.now()), []);
  // The work ends and GitHub still shows the same review: it goes out again, toward the usual cap.
  f.runtime.busy = false; f.runtime.backgroundBusy = false;
  f.advance(60_000); await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 2);
});

test("in_progress never holds forever: a busy signal that can't clear lets the items go after IN_PROGRESS_MAX_MS", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  await f.engine.acknowledge("main-agent", first.id, "in_progress", IN_PROGRESS);
  f.runtime.busy = true; f.runtime.backgroundBusy = true;
  f.advance(IN_PROGRESS_MAX_MS + 60_000); await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 2);
});

test("Retry keeps the agent's answer: the answered batch is marked sent again, never cancelled", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  await f.engine.acknowledge("main-agent", first.id, "blocked", IN_PROGRESS);
  const { controlWorkspace } = await import("../server/agent-actions");
  await f.store.mutate(s => { controlWorkspace(s, { workspaceId: "workspace", retryBatchId: first.id }, f.now()); });
  const w = await f.get();
  const b = w.batches.find(b => b.id === first.id)!;
  assert.equal(b.state, "blocked"); assert.equal(b.result, IN_PROGRESS); assert.equal(b.movedOn?.why, "retried");
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "retry" && i.batchId === first.id));
});

test("a sent message waits on other agents' work only so long: a stuck subagent never holds the queue forever", async t => {
  const f = await fixture(t, reviewed());
  const first = await sendOne(f);
  f.runtime.busy = true; f.runtime.backgroundBusy = true; // a subagent that never goes idle; the main agent's turn ended
  // A new conflict on another PR queues behind the sent message.
  await f.store.mutate(s => { s.workspaces[0].prs.push(pr({ key: "acme/app#13", repo: "acme/app", number: 13, snapshot: snapshot({ conflict: true }) })); });
  f.observe("acme/app#13", snapshot({ conflict: true }));
  f.advance(30 * 60_000); await f.engine.tick();
  let w = await f.get();
  assert.equal(sendDecision(w, f.now()).reason, "waits for the last message to finish", "while it waits, it says what for");
  f.advance(IN_PROGRESS_MAX_MS); await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  w = await f.get();
  assert.notEqual(w.batches.find(b => b.id === first.id)!.state, "sent", "the stale wait expired");
  assert.ok(f.sends.some(s => /acme\/app#13/.test(s.text)), "and the queue moved");
});

test("an agent in error or closed has no live background work", () => {
  assert.equal(backgroundCount({ status: "error", backgroundWork: { count: 1 } }), 0);
  assert.equal(backgroundCount({ status: "closed", backgroundWork: { count: 2 } }), 0);
  assert.equal(isLive({ status: "error", backgroundWork: { count: 1 } }), false);
  assert.equal(backgroundCount({ status: "idle", backgroundWork: { count: 1 } }), 1);
});

/** The live shape, synthetic: churned review batches cancelled "No longer needed", an answer Retry rewrote, a duplicate. */
function legacy(): Workspace {
  const w = reviewed();
  const at = (m: number) => new Date(clock + m * 60_000).toISOString();
  const task = (fp: string) => ({ key: `review:${PR}`, kind: "review" as const, target: PR, title: "Use /fix-pr for acme/app#12 (2 open threads)", fingerprint: fp });
  const batch = (id: string, fp: string, state: Batch["state"], result: string, m: number, attempts = 1): Batch => ({ id, messageId: `m-${id}`, attempts, result, recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
    tasks: [task(fp)], state, createdAt: at(m), sentAt: at(m + 1), settledAt: at(m + 1.2) });
  w.batches.push(
    batch("a", "f1", "cancelled", "No longer needed: GitHub no longer shows what it asked for.", 0),
    batch("b", "f2", "cancelled", "No longer needed: GitHub no longer shows what it asked for.", 5),
    batch("c", "f3", "cancelled", IN_PROGRESS, 10),          // answered, then Retry rewrote it as cancelled
    batch("d", "f3", "blocked", "Still the same two items, in progress.", 50, 2),
    batch("e", "f3", "blocked", "Still the same two items, in progress.", 55, 3),
  );
  return w;
}

test("heal: legacy churn settles on the next pass, logged in counts, and a second pass changes nothing", async t => {
  const w = legacy();
  assert.ok(violations(w, clock + 3_600_000).some(v => v.id === "a-changed-review-updates-never-cancels"), "the invariant catches the live shape");
  const counts = healBatches(w);
  assert.deepEqual(counts, { restored: 1, relabelled: 2, duplicates: 1 });
  assert.deepEqual(w.batches.map(b => [b.id, b.state, b.movedOn?.why ?? null]), [["a", "cancelled", "changed"], ["b", "cancelled", "changed"], ["c", "blocked", "retried"], ["d", "blocked", "duplicate"], ["e", "blocked", null]]);
  assert.equal(w.batches[2].result, IN_PROGRESS, "the answer Retry overwrote is the agent's again");
  assert.deepEqual(healBatches(w), { restored: 0, relabelled: 0, duplicates: 0 }, "idempotent");
  assert.deepEqual(violations(w, clock + 3_600_000).filter(v => v.id === "a-changed-review-updates-never-cancels"), []);
  // The worker's start-up pass runs it.
  const f = await fixture(t, legacy());
  const logs: string[] = []; const warn = console.warn; console.warn = (m: string) => { logs.push(m); };
  try { await f.engine.recover(); } finally { console.warn = warn; }
  assert.ok(logs.some(l => /healed batches in workspace: 1 answered restored, 2 relabelled as updated/.test(l)), logs.join("\n"));
  const healed = await f.get();
  assert.ok(needsYou(healed, clock).filter(i => i.kind === "retry").length <= 1, "at most one answer about the same items stands");
});

test("the invariant is registered", () => {
  assert.ok(INVARIANTS.some(i => i.id === "a-changed-review-updates-never-cancels"));
});
