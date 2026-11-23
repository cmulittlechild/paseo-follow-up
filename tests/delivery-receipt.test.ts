import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, testStore } from "./support/store-temp-dir";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion } from "../server/questions";
import { deliveryReceipt, deliveryStatus, queueView, receiptNote } from "../shared/queue";
import { clock, workspace, pr } from "./fixtures";
import { testQueue } from "./support/queue";

// Paseo 0.17.2+ (#10483): sendMessage returns an AgentMessageReceipt. Its shape, quoted from @getpaseo/client 0.17.2's
// daemon-client.d.ts:
//
//   export interface AgentMessageReceipt {
//       deliveryStatus?: "queued";
//       activeTurnBehavior?: AgentActiveTurnBehavior;
//       guidance?: string;
//   }
//
// and its sendAgentMessage returns `{ ...(payload.deliveryStatus ? { deliveryStatus } : {}), ...(activeTurnBehavior ?
// …), ...(guidance ? …) }`, so a send that wasn't held answers `{}` or just its behavior. 0.17.1's client resolves
// sendMessage with nothing. The live host is 0.17.1, so these receipts are the client's types, not a captured reply.
const HELD = { deliveryStatus: "queued", activeTurnBehavior: "queue", guidance: "The agent is mid-turn; it reads this when the turn ends." };
const FELL_BACK = { activeTurnBehavior: "interrupt" };
const STEERED = { activeTurnBehavior: "steer" };

test("a receipt is kept only when it says something; 0.17.1's nothing is null", () => {
  assert.equal(deliveryReceipt(undefined), null, "0.17.1: sendMessage resolves with nothing");
  assert.equal(deliveryReceipt({}), null, "0.17.2 with nothing to say");
  assert.deepEqual(deliveryReceipt(HELD), HELD);
  assert.deepEqual(deliveryReceipt({ ...FELL_BACK, extra: 1 }), FELL_BACK, "unknown fields dropped");
  assert.equal(deliveryReceipt({ guidance: "x".repeat(900) })!.guidance!.length, 400, "bounded");
});

test("one wording on every card: held reads Queued, a fallen-back steer says the turn stopped, else Sent as before", () => {
  assert.deepEqual(deliveryStatus({ state: "sent" }), { label: "Sent", detail: "Sent to the agent.", tone: "success", action: null, pending: false }, "older hosts unchanged");
  assert.deepEqual(deliveryStatus({ state: "sent", receipt: STEERED }), deliveryStatus({ state: "sent" }), "a steer that steered says nothing more");
  const held = deliveryStatus({ state: "sent", receipt: HELD });
  assert.deepEqual([held.label, held.tone, held.action, held.pending], ["Queued", "muted", null, false], "Paseo's queue, not Follow-up's: no Try now, nothing pending");
  assert.match(held.detail, /until the agent's current turn ends/);
  assert.equal(deliveryStatus({ state: "sent", receipt: FELL_BACK }).label, "Sent");
  assert.match(deliveryStatus({ state: "sent", receipt: FELL_BACK }).detail, /turn was stopped/);
  assert.equal(receiptNote(null), null);
});

const runtime: Runtime = { busy: false, reason: null, archived: false };
const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }) };
const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: null }])) };

async function setup(t: { after(fn: () => unknown): void }, receipt: unknown) {
  const root = await mkdtemp(join(tmpdir(), "follow-receipt-"));
  const store = testStore(Store, root);
  const w = workspace({ prs: [pr()] });
  askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" } as never, "work-around", clock);
  await store.mutate(s => { s.workspaces.push(w); });
  const q = await testQueue(root, { deliver: async target => receipt === undefined ? target.recipients[0]! : { to: target.recipients[0]!, receipt: deliveryReceipt(receipt) } });
  const engine = new Engine(store, github, gateway, q.queue.now);
  engine.attachQueue(q.queue);
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return { store, engine, queue: q.queue, wid: w.id };
}

test("the receipt lands on the queue item, its view (queue_list) and the answer's delivery", async t => {
  const f = await setup(t, HELD);
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const delivery = (await f.store.snapshot()).workspaces[0].questions[0].answer!.delivery;
  assert.equal(delivery.state, "sent");
  assert.deepEqual(delivery.receipt, HELD);
  const item = f.queue.list().recent.at(-1)!;
  assert.deepEqual(item.receipt, HELD);
  assert.deepEqual(queueView(item).receipt, HELD, "agents read it through queue_list");
  assert.equal(deliveryStatus({ state: delivery.state as "sent", receipt: delivery.receipt }).label, "Queued");
});

test("Paseo 0.17.1 (no receipt): nothing is stored and nothing reads differently", async t => {
  const f = await setup(t, undefined);
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const delivery = (await f.store.snapshot()).workspaces[0].questions[0].answer!.delivery;
  assert.equal(delivery.state, "sent");
  assert.equal("receipt" in delivery, false);
  assert.equal(f.queue.list().recent.at(-1)!.receipt, null);
});

test("the harness's receipt override counts only under the temp dir", async () => {
  const { harnessReceipt } = await import("../server/message-queue");
  const env = { FOLLOW_UP_HARNESS_RECEIPT: JSON.stringify(HELD) };
  assert.deepEqual(harnessReceipt(join(tmpdir(), "x"), env), HELD);
  assert.equal(harnessReceipt("/home/user/.paseo/plugin-data/follow-up", env), null, "never on a real data dir");
  assert.equal(harnessReceipt(join(tmpdir(), "x"), {}), null);
});
