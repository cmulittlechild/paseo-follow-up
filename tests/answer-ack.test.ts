import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefStep, type Brief, type BriefContent } from "../shared/brief";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion } from "../server/questions";
import { clock, pr, workspace } from "./fixtures";
import { settleTime } from "./support/hanging-host";
import { testQueue } from "./support/queue";
import { DeliveryDeferred } from "../server/delivery";
import { readFile } from "node:fs/promises";

/**
 * Bug (2026-11-11): "Your answer wasn't sent. Plugin RPC timed out: follow-up.invoke" on a question card.
 *
 * follow.brief-action awaited the message to the agent before replying. For a dormant agent Paseo first resumes it and
 * then waits for its run to start (up to 60 s): 86 s that morning, while a plugin RPC gets 30 s. The answer did arrive,
 * 88 s later, but the card said it hadn't, and Retry sent it again under a new messageId (the agent got Q4 twice).
 *
 * The rule these tests hold: an answer RPC replies once the answer is recorded, within ACK_MS, whatever Paseo does;
 * the send runs after, under one messageId per answer, and a retry or a double click never sends twice.
 *
 * Retry delays and attempt deadlines run on FakeTimers: a test fires them in order and awaits idle(), never the wall
 * clock (the last test below holds that for this file and tests/rpc-ack.test.ts).
 */
const ACK_MS = 500;
const NOW = "2026-11-11T08:52:42.000Z";
const never = () => new Promise<string>(() => undefined);

const content: BriefContent = { source: "agent", kind: "decision", ask: "Which encoding?", sourceLine: "From the agent",
  decisions: [{ id: "D1", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8", consequence: null }, { letter: "B", label: "UTF-8 with BOM", consequence: null }], recommend: null }] } as never;
const open = (): Brief => briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content, flagged: true, seq: 1, questionIds: [] }, NOW).brief!;

type QueueOptions = Parameters<typeof testQueue>[1];
async function inbox(t: { after(fn: () => unknown): void }, o: QueueOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "follow-answer-ack-"));
  const agent: AgentInfo = { id: "main", workspaceId: "w", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
  const directory = { agents: async () => [agent], workspaces: async () => [{ id: "w", name: "W" }], agent: async () => agent, tail: async () => [], clearAttention: async () => {} } as unknown as Directory;
  const rows: Brief[] = [];
  const options = { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never,
    guard: async () => null, graceMs: 5, now: () => Date.parse(NOW), briefs: { sink: async (_a: string, b: Brief) => { rows.push(b); }, call: async () => null, pr: async () => null } } as never;
  const box = new Inbox(dir, options);
  const q = await testQueue(dir, o);
  box.attachQueue(q.queue);
  await box.store.mutate(s => { s.entries.main = { ...(s.entries.main ?? {}), agentId: "main", brief: open() } as never; });
  const stops: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const stop of stops) await stop(); box.stop(); q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await box.store.flush?.().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  return { box, rows, dir, options, stops, ...q, brief: async () => (await box.store.snapshot()).entries.main!.brief! };
}

test("brief-action replies within ACK_MS while Paseo is still resuming the agent, and the answer is recorded", async t => {
  const { box, brief, queue } = await inbox(t, { deliver: never });
  const r = await settleTime(() => box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0001" }), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `brief-action took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with the send still pending; the card's RPC must not wait for delivery`);
  assert.equal(r.error, null);
  const b = await brief();
  assert.equal(b.state, "answered"); assert.equal(b.answerId, "answer-0001"); assert.deepEqual(b.delivery, { state: "sending", error: null });
  assert.equal(queue.list().items.length, 1, "the answer waits in the queue until Paseo confirms it");
});

test("Retry and double clicks: the same answerId never sends twice, and every attempt uses one messageId", async t => {
  let release!: () => void; const ids: string[] = [];
  const { box, brief, queue } = await inbox(t, { deliver: async (target, _t, messageId) => { ids.push(messageId); await new Promise<void>(r => { release = r; }); return target.recipients[0]!; } });
  const first = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0002" });
  void box.idle();
  // The client's Retry after a lost reply, and a second click, both carry the same answerId.
  const again = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0002" });
  const third = await box.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "D1", choice: "A" }], answerId: "answer-0002" });
  assert.deepEqual([again.id, third.id], [first.id, first.id]);
  while (!release) await new Promise(r => setImmediate(r));
  release(); await box.idle();
  assert.equal(ids.length, 1, "one send for one answer");
  assert.equal(queue.list().items.length, 0); assert.equal((await brief()).delivery, null, "delivered: nothing pending on the card");
  // A different answer to the same card is still refused: the card was answered.
  await assert.rejects(box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "B", answerId: "answer-0003" }), /already answered/);
});

test("a send that never left retries on its own and the card says when; it never reads failed", async t => {
  let ok = false; const ids: string[] = [];
  const { box, brief, rows, timers } = await inbox(t, { deliver: async (target, _t, messageId) => { ids.push(messageId); if (!ok) throw new DeliveryDeferred("Paseo unreachable"); return target.recipients[0]!; } });
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0004" });
  await box.idle();
  assert.deepEqual(timers.pending, [15_000], "the first attempt never left; one retry waits");
  assert.equal((await brief()).delivery?.state, "queued");
  assert.equal(rows.at(-1)?.delivery?.state, "queued", "the chat card is updated to say so");
  assert.equal(await timers.fire(), 15_000); await box.idle();
  assert.equal(await timers.fire(), 60_000); await box.idle();
  assert.equal((await brief()).delivery?.state, "queued", "still queued, never failed");
  ok = true;
  // Try now on the card: the same answerId.
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0004" });
  await box.idle();
  assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 1, "one messageId for every attempt");
  assert.equal((await brief()).delivery, null);
});

test("a hung send is capped: it reads Retrying, and the chat is read before it goes again", async t => {
  const received: string[] = [];
  let called!: () => void; const out = new Promise<void>(r => { called = r; });
  const { box, brief, timers } = await inbox(t, { deliver: (_target, _t, messageId) => { received.push(messageId); called(); return never(); }, arrived: async (_a, messageId) => received.includes(messageId) });
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0005" });
  void box.idle(); await out;
  assert.equal(await timers.fire(), 120_000, "the attempt's deadline"); await box.idle();
  assert.equal((await brief()).delivery?.state, "retrying");
  await timers.fire(); await box.idle();
  assert.equal(received.length, 1, "it had arrived: not sent twice");
  assert.equal((await brief()).delivery, null);
});

test("an answer recorded before a reload goes out at the next worker start, under the same messageId, and the stopped worker writes nothing", async t => {
  let called!: () => void; const out = new Promise<void>(r => { called = r; });
  const { box, dir, options, queue, timers, stops } = await inbox(t, { deliver: () => { called(); return never(); } });
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0006" });
  void box.idle(); await out;
  const pending = queue.list().items[0];
  box.stop(); queue.stop();
  let writesAfterStop = 0;
  const mutate = box.store.mutate.bind(box.store);
  box.store.mutate = (work => { writesAfterStop++; return mutate(work); }) as typeof box.store.mutate;
  // The worker reloads: a fresh Inbox and queue over the same directory.
  const next = new Inbox(dir, options);
  const sent: { agentId: string; messageId: string }[] = [];
  const q = await testQueue(dir, { deliver: async (target, _t, messageId) => { sent.push({ agentId: target.recipients[0]!, messageId }); return target.recipients[0]!; }, arrived: async () => false });
  next.attachQueue(q.queue);
  stops.push(async () => { next.stop(); q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await next.store.flush().catch(() => undefined); });
  q.queue.start(); await next.idle();
  assert.deepEqual(sent, [{ agentId: "main", messageId: pending.messageId }]);
  assert.equal(q.queue.list().items.length, 0);
  // The stopped worker's attempt gives up afterwards: it must not write anything over the new one's.
  assert.equal(await timers.fire(), 120_000);
  assert.equal(writesAfterStop, 0, "a stopped worker writes nothing");
  assert.deepEqual(timers.pending, [], "a stopped worker schedules no retry");
});

test("upgrade: 2.0's outbox in inbox.json moves into the queue once, and its sending entry is read back before a resend", async t => {
  const { box, queue } = await inbox(t, { arrived: async () => true });
  await box.store.mutate(s => { s.outbox = [{ answerId: "a-old", agentId: "main", briefId: "brief:t1", messageId: "m-old", text: "Follow-up answer D1 (Which encoding?): A — UTF-8", at: NOW, attempts: 1, state: "sending", error: null }]; });
  await box.adoptOutbox(); await box.adoptOutbox();
  assert.equal((await box.store.snapshot()).outbox.length, 0, "the old outbox empties once the queue holds it");
  assert.deepEqual(queue.list().items.map(i => [i.id, i.state, i.envelope?.messageId]), [["brief:main:a-old", "uncertain", "m-old"]]);
  queue.start(); await box.idle();
  assert.equal(queue.list().items.length, 0);
  assert.equal(queue.list().recent[0].state, "sent", "it had arrived: kept as sent, not sent again");
});

test("answer-question replies within ACK_MS while delivery hangs; the question reads sending until it lands", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-answer-ack-q-"));
  const store = new Store(root);
  const w = workspace({ prs: [pr()] });
  askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" } as never, "work-around", clock);
  await store.mutate(s => { s.workspaces.push(w); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  let release!: (to: string) => void;
  const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }) };
  const q = await testQueue(root, { deliver: () => new Promise<string>(r => { release = r; }) });
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const engine = new Engine(store, { observe: async () => new Map() } as never, gateway, q.queue.now);
  engine.attachQueue(q.queue);
  const r = await settleTime(() => engine.answer(w.id, "Q1", "A", undefined, "send"), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `answer-question took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with delivery pending`);
  assert.equal((await store.snapshot()).workspaces[0].questions[0].answer!.delivery.state, "sending");
  void engine.idle();
  while (!release) await new Promise(r => setImmediate(r));
  release("main-agent"); await engine.idle();
  assert.equal((await store.snapshot()).workspaces[0].questions[0].answer!.delivery.state, "sent");
});

test("the card's answer ids pass the RPC's schema", async () => {
  const { briefActionRpc } = await import("../shared/contracts");
  const { newAnswerId } = await import("../shared/brief");
  const ids = new Set(Array.from({ length: 200 }, () => newAnswerId()));
  assert.equal(ids.size, 200, "one per Send, never reused across answers");
  for (const answerId of ids) assert.ok(briefActionRpc.input.safeParse({ agentId: "main", briefId: "brief:t1", answerId }).success, answerId);
});

test("invariant: answer-ack and rpc-ack never wait on the wall clock for retries or deadlines", async () => {
  // settleTime's cap (tests/support/hanging-host.ts) bounds an ACK and is the only timer allowed; retries use FakeTimers.
  for (const file of ["answer-ack.test.ts", "rpc-ack.test.ts"]) {
    const source = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const name = "invariant: answer-ack and rpc-ack never wait";
    const own = file === "answer-ack.test.ts" ? source.slice(0, source.indexOf(name)) : source;
    assert.doesNotMatch(own, /setTimeout|setInterval|\bsleep\(|timers\/promises|deliveryRetryMs = \[\s*\d{1,3}\b/, `${file} waits on real time: fire FakeTimers instead`);
  }
});
