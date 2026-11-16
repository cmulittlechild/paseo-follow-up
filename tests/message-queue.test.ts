import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, answerItemId, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion, developerAnswer } from "../server/questions";
import { DeliveryDeferred } from "../server/delivery";
import { MessageQueue, QUEUE_FILE, queueTimeScale } from "../server/message-queue";
import { AMBIGUOUS_MS, NEVER_LEFT_MS, PROBE_MS, PROBE_SLOW_MS, PROBE_BACKOFF_AFTER_MS, QUEUE_RECENT, deliveryStatus, queueFileSchema } from "../shared/queue";
import { clock, workspace, pr } from "./fixtures";
import { testQueue } from "./support/queue";

/**
 * a-message-is-saved-before-sent-and-arrives-once (AGENTS.md). Every message Follow-up sends an agent goes through one
 * queue: saved before Paseo hears of it, retried until it lands, and never resent without reading the chat first.
 *
 * Bugs it fixes, each failing on main before the queue (2026-11-16):
 * - A Q answer whose send wasn't confirmed sat "unconfirmed" until the developer pressed Resend: nothing retried it.
 * - A card answer whose send timed out but did arrive was sent again by the 15 s retry, under the same messageId.
 *   Paseo doesn't refuse a resend by messageId (it skips the second timeline row; the provider still runs the prompt),
 *   so the agent got the answer twice while its chat showed it once.
 */

const runtime: Runtime = { busy: false, reason: null, archived: false };
const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }) };
const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: null }])) };

async function setup(t: { after(fn: () => unknown): void }, o: Parameters<typeof testQueue>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "follow-queue-"));
  const store = new Store(root);
  const stops: (() => Promise<unknown> | void)[] = [];
  t.after(async () => { for (const stop of stops) await stop(); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const w = workspace({ prs: [pr()] });
  askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" } as never, "work-around", clock);
  await store.mutate(s => { s.workspaces.push(w); });
  const q = await testQueue(root, o);
  const engine = new Engine(store, github, gateway, q.queue.now);
  engine.attachQueue(q.queue);
  stops.push(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); });
  const question = async () => (await store.snapshot()).workspaces[0].questions[0];
  const delivery = async () => (await question()).answer!.delivery;
  const file = async () => queueFileSchema.parse(JSON.parse(await readFile(join(root, QUEUE_FILE), "utf8")));
  return { root, store, engine, ...q, question, delivery, file, wid: w.id, stops };
}

test("class bug: an answer Paseo didn't confirm is retried on its own, after the chat shows it never arrived", async t => {
  let calls = 0;
  const f = await setup(t, { deliver: async target => { calls++; if (calls === 1) throw new Error("socket closed"); return target.recipients[0]!; }, arrived: async () => false });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const waiting = await f.delivery();
  assert.equal(waiting.state, "retrying", "a send that may have left reads Retrying, never silently stuck");
  assert.equal(f.timers.pending[0], AMBIGUOUS_MS[0]);
  await f.timers.fire(); await f.engine.idle();
  assert.equal(calls, 2, "resent once the chat showed it isn't there");
  assert.equal((await f.delivery()).state, "sent");
  assert.deepEqual(f.timers.pending, [], "no timer while the queue is empty");
});

test("live bug: an answer whose send timed out but arrived is never sent a second time", async t => {
  const received: string[] = [];
  const f = await setup(t, {
    // Paseo takes the message (the agent has it) and its reply never comes back.
    deliver: (_target, _text, messageId) => { received.push(messageId); return new Promise(() => undefined); },
    arrived: async (_agent, messageId) => received.includes(messageId),
  });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); void f.engine.idle();
  assert.equal(await f.timers.fire(), f.queue.attemptMs, "the attempt's deadline"); await f.engine.idle();
  assert.equal((await f.delivery()).state, "retrying");
  await f.timers.fire(); await f.engine.idle();
  assert.equal(received.length, 1, "the arrival check found it, so it isn't sent again");
  assert.equal((await f.delivery()).state, "sent");
});

test("a send that never left never fails: 15 s, 1 min, then every 5 min, and at once when the daemon comes back", async t => {
  let reachable = false; let calls = 0;
  const f = await setup(t, { deliver: async target => { calls++; if (!reachable) throw new DeliveryDeferred("Paseo unreachable"); return target.recipients[0]!; } });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) { waits.push(await f.timers.fire()); await f.engine.idle(); }
  assert.deepEqual(waits, [NEVER_LEFT_MS[0], NEVER_LEFT_MS[1], NEVER_LEFT_MS[2], NEVER_LEFT_MS[2], NEVER_LEFT_MS[2], NEVER_LEFT_MS[2]]);
  const d = await f.delivery();
  assert.equal(d.state, "queued", "never Failed: nothing was sent");
  assert.match(deliveryStatus({ state: d.state, reason: d.reason, nextAt: d.nextAt }, () => "12:04").detail, /^Queued: Paseo unreachable, retrying at 12:04\.$/);
  reachable = true;
  f.queue.reconnected(); await f.engine.idle();
  assert.equal((await f.delivery()).state, "sent", "the daemon came back: sent at once, not at the next 5 min step");
  assert.equal(calls, 8);
});

test("an ambiguous send whose arrival can't be known climbs 15 s, 1 min, 5 min, 15 min, then fails; Retry resends without asking", async t => {
  let calls = 0;
  const f = await setup(t, { deliver: async target => { calls++; if (calls === 1) throw new Error("connection reset"); return target.recipients[0]!; }, arrived: async () => null });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const waits: number[] = [];
  while (f.timers.pending.length) { waits.push(await f.timers.fire()); await f.engine.idle(); }
  assert.deepEqual(waits, [...AMBIGUOUS_MS]);
  const d = await f.delivery();
  assert.equal(d.state, "failed"); assert.equal(calls, 1, "never resent blind");
  assert.equal(deliveryStatus({ state: "failed", reason: d.reason }).action, "retry");
  await f.engine.answer(f.wid, "Q1", "A", undefined, "resend"); await f.engine.idle();
  assert.equal(calls, 2); assert.equal((await f.delivery()).state, "sent");
});

test("saved before sent: when Paseo hears of the message, queue.json already holds it as sending under that messageId", async t => {
  let seen: unknown = null;
  const f = await setup(t, { deliver: async (target, _text, messageId) => {
    const file = queueFileSchema.parse(JSON.parse(await readFile(join(f.root, QUEUE_FILE), "utf8")));
    seen = file.items.map(i => ({ state: i.state, messageId: i.envelope?.messageId === messageId }));
    return target.recipients[0]!;
  } });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  assert.deepEqual(seen, [{ state: "sending", messageId: true }]);
  await f.queue.flush();
  const file = await f.file();
  assert.deepEqual(file.items, [], "sent items leave the file");
  assert.equal(file.recent.length, 1); assert.equal(file.recent[0].text, "", "the tail keeps no text");
});

test("a reload mid-send reads the chat first: arrived is kept as sent, missing is sent once", async t => {
  for (const arrivedBefore of [true, false]) {
    let called!: () => void; const out = new Promise<void>(r => { called = r; });
    const f = await setup(t, { deliver: () => { called(); return new Promise(() => undefined); } });
    await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); void f.engine.idle(); await out;
    assert.equal((await f.file()).items[0].state, "sending");
    f.queue.stop();
    // The worker reloads: a new queue over the same file.
    const sent: string[] = [];
    const next = await testQueue(f.root, { deliver: async (target, _t, id) => { sent.push(id); return target.recipients[0]!; }, arrived: async () => arrivedBefore });
    const engine = new Engine(f.store, github, gateway, next.queue.now); engine.attachQueue(next.queue);
    await engine.adoptAnswers();
    f.stops.push(async () => { next.queue.stop(); await next.queue.writer.flush().catch(() => undefined); });
    next.queue.start(); await engine.idle();
    assert.equal(sent.length, arrivedBefore ? 0 : 1, arrivedBefore ? "it had arrived: not sent again" : "it never arrived: sent once");
    assert.equal((await f.delivery()).state, "sent");
  }
});

test("quiet window: an envelope waits 2 s after the newest item, but never more than 8 s after the first", async t => {
  const f = await setup(t, { quiet: 2_000, cap: 8_000 });
  for (let i = 0; i < 6; i++) f.queue.enqueue({ id: `m${i}`, kind: "answer", key: "busy", ref: { workspaceId: "gone", questionId: "Q9" }, messageId: `id-${i}`, text: `part ${i}`, state: "queued", createdAt: new Date(f.queue.now()).toISOString() });
  assert.deepEqual(f.timers.pending, [2_000]);
  // A click every 1.5 s keeps the workspace busy; the cap still sends at 8 s.
  const g = await setup(t, { quiet: 2_000, cap: 8_000 });
  const add = (i: number) => g.queue.enqueue({ id: `n${i}`, kind: "answer", key: "busy", ref: { workspaceId: "gone", questionId: "Q9" }, messageId: `nid-${i}`, text: `part ${i}`, state: "queued" });
  add(0);
  for (let i = 1; i < 8; i++) { g.timers.now += 1_500; add(i); }
  assert.ok(Math.max(...g.timers.pending) <= 8_000 - g.timers.now + 1, `armed at ${g.timers.pending}, past the 8 s cap`);
});

test("recipient at send time: an archived or unfollowed workspace cancels the answer with the reason on its card", async t => {
  const f = await setup(t, { quiet: 2_000, cap: 8_000 });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send");
  await f.store.mutate(s => { s.workspaces[0].archived = true; });
  await f.timers.fire(); await f.engine.idle();
  const d = await f.delivery();
  assert.equal(d.state, "cancelled"); assert.match(d.reason!, /archived/);
  assert.equal(f.delivered.length, 0);
  assert.equal(deliveryStatus({ state: d.state, reason: d.reason }).label, "Not sent");
});

test("the asker's replacement: recipients are read when the envelope goes out, so the main agent gets it", async t => {
  const f = await setup(t, { quiet: 2_000, cap: 8_000, deliver: async target => target.recipients.find(r => r !== "main-agent") ?? target.recipients.at(-1)! });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send");
  await f.store.mutate(s => { s.workspaces[0].mainAgentId = "successor"; });
  await f.timers.fire(); await f.engine.idle();
  assert.deepEqual(f.delivered[0].target.recipients, ["main-agent", "successor"]);
  assert.equal((await f.delivery()).to, "successor");
});

test("upgrade: 2.0's unconfirmed and queued answers join the queue once; the unconfirmed one is checked before it is resent", async t => {
  const f = await setup(t, { arrived: async () => true });
  await f.store.mutate(s => {
    developerAnswer(s.workspaces[0], "Q1", "A", undefined, "send", clock);
    s.workspaces[0].questions[0].answer!.delivery.state = "unconfirmed";
  });
  await f.engine.adoptAnswers(); await f.engine.adoptAnswers();
  assert.equal(f.queue.list().items.length, 1, "adopted once");
  const item = f.queue.get(answerItemId(f.wid, await f.question()))!;
  assert.equal(item.state, "uncertain");
  f.queue.start(); await f.engine.idle();
  assert.equal(f.delivered.length, 0, "it had arrived: nothing resent");
  assert.equal((await f.delivery()).state, "sent");
});

test("the file stays tiny: settled items keep only a short tail", async t => {
  const f = await setup(t);
  for (let i = 0; i < 40; i++) f.queue.enqueue({ id: `m${i}`, kind: "answer", key: "w", ref: { workspaceId: f.wid, questionId: "Q404" }, messageId: `id-${i}`, text: "x".repeat(2_000), state: "queued" });
  await f.engine.idle(); await f.queue.flush();
  const raw = await readFile(join(f.root, QUEUE_FILE), "utf8");
  const file = queueFileSchema.parse(JSON.parse(raw));
  assert.equal(file.items.length, 0); assert.equal(file.recent.length, QUEUE_RECENT);
  assert.ok(raw.length < 16_000, `queue.json is ${raw.length} bytes`);
});

test("an unreadable queue.json starts empty instead of stopping the worker", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-queue-bad-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, QUEUE_FILE), "{not json");
  const q = new MessageQueue(root, { deliverTo: async () => "a", arrived: async () => null });
  await q.load();
  assert.deepEqual(q.list().items, []);
});

test("the harness time scale counts only for a data dir under the temp dir: a stray variable never shortens a real ladder", () => {
  const env = { FOLLOW_UP_QUEUE_TIME_SCALE: "0.01" };
  assert.equal(queueTimeScale(join(tmpdir(), "follow-harness-x", "home", "plugin-data", "follow-up"), env), 0.01, "a harness run");
  assert.equal(queueTimeScale("/home/user/.paseo/plugin-data/follow-up", env), 1, "a developer's machine: ignored");
  assert.equal(queueTimeScale(join(tmpdir(), "x"), {}), 1, "unset");
  for (const bad of ["0", "-1", "2", "abc", "1"]) assert.equal(queueTimeScale(join(tmpdir(), "x"), { FOLLOW_UP_QUEUE_TIME_SCALE: bad }), 1, bad);
});

test("Paseo unreachable: one connect-only probe every 15 s, 60 s after 10 min, none once nothing waits; a probe that connects sends at once", async t => {
  let up = false; let probes = 0; let sends = 0;
  const f = await setup(t, { deliver: async target => { sends++; if (!up) throw new DeliveryDeferred("Paseo unreachable"); return target.recipients[0]!; }, probe: async () => { probes++; return up; } });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  assert.equal(sends, 1);
  assert.deepEqual(f.timers.pending, [PROBE_MS], "one timer: the probe, not a ladder step per workspace");
  const waits: number[] = [];
  while (f.timers.now < PROBE_BACKOFF_AFTER_MS + 3 * PROBE_SLOW_MS) { waits.push(await f.timers.fire()); await f.engine.idle(); assert.equal(f.timers.pending.length, 1, "still one timer"); }
  const fast = PROBE_BACKOFF_AFTER_MS / PROBE_MS;
  assert.deepEqual(waits.slice(0, fast), Array(fast).fill(PROBE_MS));
  assert.deepEqual(waits.slice(fast), Array(waits.length - fast).fill(PROBE_SLOW_MS), "backs off to 60 s after 10 min down");
  assert.equal(sends, 1, "a failed probe sends nothing: it only connects");
  assert.equal(probes, waits.length);
  const d = await f.delivery();
  assert.equal(d.state, "queued"); assert.equal(Date.parse(d.nextAt!), Date.parse("2026-11-16T09:00:00.000Z") + f.timers.now + PROBE_SLOW_MS, "the card's 'retrying at' is the next probe");
  up = true;
  await f.timers.fire(); await f.engine.idle();
  assert.equal((await f.delivery()).state, "sent", "the probe connected: sent at once");
  assert.equal(sends, 2);
  assert.deepEqual(f.timers.pending, [], "nothing waits: no probe, no timer");
});

test("any connection the worker opens sends what waited on Paseo at once; cancelling the last one stops the probe", async t => {
  let up = false; let probes = 0;
  const f = await setup(t, { deliver: async target => { if (!up) throw new DeliveryDeferred("Paseo unreachable"); return target.recipients[0]!; }, probe: async () => { probes++; return false; } });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  up = true;
  f.queue.reconnected(); await f.engine.idle();
  assert.equal((await f.delivery()).state, "sent", "a tick's connection (or any other) reopened: sent without waiting for the probe");
  assert.equal(probes, 0);
  assert.deepEqual(f.timers.pending, []);
  const g = await setup(t, { deliver: async () => { throw new DeliveryDeferred("Paseo unreachable"); }, probe: async () => { probes++; return false; } });
  await g.engine.answer(g.wid, "Q1", "A", undefined, "send"); await g.engine.idle();
  assert.equal(g.timers.pending.length, 1);
  const [item] = g.queue.list().items;
  await g.queue.cancel(item!.id, "Cancelled by the developer");
  assert.deepEqual(g.timers.pending, [], "nothing waits: the probe stops at once");
});

test("the probe only connects: it reads no agent, so nothing wakes, and a dropped connection reads as down", async () => {
  const { PaseoGateway } = await import("../server/daemon");
  const touched: string[] = [];
  const client = (status: string) => new Proxy({ connectionState: { status } }, { get: (o, k) => { if (k !== "connectionState" && k !== "then") touched.push(String(k)); return (o as Record<string | symbol, unknown>)[k]; } });
  const via = (status: string | null) => new PaseoGateway((async (work: (c: unknown) => Promise<unknown>) => { if (status === null) throw new Error("ECONNREFUSED"); return work(client(status)); }) as never);
  assert.equal(await via("connected").probe(), true);
  assert.equal(await via("disconnected").probe(), false);
  assert.equal(await via(null).probe(), false);
  assert.deepEqual(touched, [], "no daemon call beyond the connection itself");
});
