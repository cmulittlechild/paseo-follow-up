import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, heldAgentSide, repairItemId, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion } from "../server/questions";
import { envelopeParts } from "../shared/queue";
import { parseAnswerMessage } from "../shared/questions";
import { parseBatchPrompt } from "../shared/chat";
import { clock, workspace, pr, snapshot } from "./fixtures";
import { testQueue } from "./support/queue";

/**
 * Repairs on the message queue (a-message-is-saved-before-sent-and-arrives-once):
 * - answers never wait behind repairs and steer into a running turn; repairs wait for an idle agent;
 * - an answer going to an idle agent takes the pending repair along: one message, one turn, not two;
 * - the developer's Send replies once the message is queued, never after a Paseo call.
 */
async function setup(t: { after(fn: () => unknown): void }, w = workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] })) {
  const root = await mkdtemp(join(tmpdir(), "follow-queue-repairs-"));
  const store = new Store(root);
  askQuestion(w, w.mainAgentId, { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" } as never, "work-around", clock);
  await store.mutate(s => { s.workspaces.push(w); });
  let runtime: Runtime = { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true };
  let observeDelay: Promise<void> | null = null;
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), send: async () => { throw new Error("repairs go through the queue"); }, label: async () => {},
    observe: async () => { if (observeDelay) await observeDelay; return runtime; } };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(now).toISOString() }, error: null }])) };
  let now = clock;
  const q = await testQueue(root, { start: clock });
  const engine = new Engine(store, github, gateway, () => now);
  engine.attachQueue(q.queue);
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return { store, engine, ...q, wid: w.id, set: (r: Partial<Runtime>) => { runtime = { ...runtime, ...r }; }, hang: (p: Promise<void> | null) => { observeDelay = p; }, advance: (ms: number) => { now += ms; },
    get: async () => (await store.snapshot()).workspaces[0] };
}

test("a busy agent: the answer steers in alone, the repair waits until the agent is idle", async t => {
  const f = await setup(t);
  await f.engine.tick();
  const batch = (await f.get()).batches.find(b => b.state === "pending")!;
  f.set({ busy: true });
  await f.engine.sendPending(f.wid, batch.id);
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send");
  await f.engine.idle();
  assert.equal(f.delivered.length, 1, "only the answer went");
  assert.match(f.delivered[0].text, /^Follow-up answer Q1 \(/);
  assert.equal(envelopeParts(f.delivered[0].text).length, 1);
  assert.equal((await f.get()).batches[0].state, "pending");
  assert.match((await f.get()).batches[0].refusal?.reason ?? "", /turn to end/, "the batch line says why it waits");
  f.set({ busy: false });
  await f.engine.tick(); await f.engine.idle();
  assert.equal(f.delivered.length, 2, "the repair went once the tick saw the agent idle");
  assert.ok(parseBatchPrompt(f.delivered[1].text));
  assert.equal((await f.get()).batches[0].state, "sent");
});

test("ride-along: an answer to an idle agent carries the pending repair, in one message with both contracts intact", async t => {
  const f = await setup(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick();
  const batch = (await f.get()).batches.find(b => b.state === "pending")!;
  assert.ok(!f.queue.get(repairItemId(f.wid, batch.id)), "the repair is still inside its settle window, not queued");
  await f.engine.answer(f.wid, "Q1", "B", "keep it short", "send");
  await f.engine.idle();
  assert.equal(f.delivered.length, 1, "one message, one turn");
  const parts = envelopeParts(f.delivered[0].text);
  assert.equal(parts.length, 2);
  assert.equal(parseAnswerMessage(parts[0]!)?.choice, "B", "the answer goes first");
  assert.equal(parseAnswerMessage(parts[0]!)?.words, "keep it short");
  assert.match(parts[1]!, new RegExp(`^Follow-up batch ${batch.id}\\n\\n`), "the batch keeps its header for acknowledge_batch");
  const w = await f.get();
  assert.equal(w.batches[0].state, "sent"); assert.equal(w.questions[0].answer!.delivery.state, "sent");
});

test("ride-along never takes a repair Auto wouldn't send: Auto off, a hold, or a busy agent", async t => {
  for (const [name, patch, runtime] of [
    ["Auto off", { enable_auto_sends: false }, {}],
    ["a hold", { enable_auto_sends: true, hold: "Paused by the developer" }, {}],
    ["busy", { enable_auto_sends: true }, { busy: true }],
  ] as const) {
    const f = await setup(t, workspace({ ...patch, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
    await f.engine.tick(); f.set(runtime);
    await f.engine.answer(f.wid, "Q1", "A", undefined, "send");
    await f.engine.idle();
    assert.equal(f.delivered.length, 1, name); assert.equal(envelopeParts(f.delivered[0].text).length, 1, `${name}: the answer alone`);
    assert.equal((await f.get()).batches[0].state, "pending", name);
  }
});

test("Send replies at once while Paseo takes a minute to answer, and the batch reads Queued", async t => {
  const f = await setup(t);
  await f.engine.tick();
  const batch = (await f.get()).batches.find(b => b.state === "pending")!;
  let release!: () => void; f.hang(new Promise<void>(r => { release = r; }));
  const started = performance.now();
  const w = await f.engine.sendPending(f.wid, batch.id);
  const ms = performance.now() - started;
  assert.ok(ms < 300, `Send took ${Math.round(ms)} ms with Paseo hanging`);
  assert.equal(w.batches.find(b => b.id === batch.id)!.state, "pending", "Queued on the batch line");
  assert.ok(f.queue.get(repairItemId(f.wid, batch.id)), "saved on the queue");
  void f.engine.idle();
  release(); f.hang(null); await f.engine.idle();
  assert.equal((await f.get()).batches[0].state, "sent");
});

test("a Send held by Session Guard goes on the tick that sees the agent free, never on the retry ladder", async t => {
  const f = await setup(t);
  await f.engine.tick();
  const batch = (await f.get()).batches.find(b => b.state === "pending")!;
  f.set({ reason: "Session Guard paused this agent" });
  await f.engine.sendPending(f.wid, batch.id); await f.engine.idle();
  assert.equal(f.delivered.length, 0, "nothing reaches the agent while Session Guard owns the pause");
  assert.match((await f.get()).batches[0].refusal?.reason ?? "", /Session Guard/, "the batch line says why it waits");
  f.set({ reason: null });
  await f.engine.tick(); await f.engine.idle();
  assert.equal(f.delivered.length, 1, "sent on the next tick, not after the ladder's next step");
  assert.equal((await f.get()).batches[0].state, "sent");
});

test("holds the tick can't see clear on their own: a tick never retries them", () => {
  for (const r of ["Paseo unreachable", "waits for the last message to finish", "waits until GitHub answers, so the message isn't based on stale PRs"]) assert.equal(heldAgentSide(r), false, r);
  for (const r of ["waits for the agent's turn to end, so it isn't interrupted", "Session Guard paused this agent", "waiting for the agent's permission prompt"]) assert.equal(heldAgentSide(r), true, r);
});
