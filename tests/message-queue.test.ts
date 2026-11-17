import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rm, testStore } from "./support/store-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, answerItemId, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion, developerAnswer } from "../server/questions";
import { ConversationGone, DeliveryDeferred } from "../server/delivery";
import { MessageQueue, QUEUE_FILE, queueTimeScale } from "../server/message-queue";
import { AMBIGUOUS_MS, NEVER_LEFT_MS, PROBE_MS, PROBE_SLOW_MS, PROBE_BACKOFF_AFTER_MS, QUEUE_RECENT, deliveryStatus, queueFileSchema, queueItemStop } from "../shared/queue";
import { clock, workspace, pr } from "./fixtures";
import { markerInFile, markerSince } from "../server/transcript";
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
  const store = testStore(Store, root);
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
  assert.match(deliveryStatus({ state: d.state, reason: d.reason, nextAt: d.nextAt }, () => "12:04").detail, /^Queued: Paseo unreachable\. Next try at 12:04\.$/);
  reachable = true;
  f.queue.reconnected(); await f.engine.idle();
  assert.equal((await f.delivery()).state, "sent", "the daemon came back: sent at once, not at the next 5 min step");
  assert.equal(calls, 8);
});

test("live bug (2026-11-17): an answer whose arrival can't be known climbs 15 s, 1 min, 5 min, 15 min, then keeps checking every 15 min; it never ends Failed", async t => {
  let calls = 0; let known: boolean | null = null;
  const f = await setup(t, { deliver: async target => { calls++; if (calls === 1) throw new Error("Timeout waiting for message (60000ms)"); return target.recipients[0]!; }, arrived: async () => known });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const waits: number[] = [];
  for (let i = 0; i < AMBIGUOUS_MS.length + 3 && f.timers.pending.length; i++) { waits.push(await f.timers.fire()); await f.engine.idle(); }
  assert.deepEqual(waits, [...AMBIGUOUS_MS, AMBIGUOUS_MS.at(-1)!, AMBIGUOUS_MS.at(-1)!, AMBIGUOUS_MS.at(-1)!], "the last step repeats");
  const d = await f.delivery();
  assert.equal(d.state, "retrying", "still the queue's to deliver, never Failed with nothing next");
  assert.ok(d.nextAt, "it says when it checks again");
  assert.equal(deliveryStatus({ state: d.state, reason: d.reason, nextAt: d.nextAt }).action, "try-now");
  assert.equal(calls, 1, "never resent blind");
  // The chat can tell at last (the agent loaded, or its transcript covers the send): it isn't there, so it goes once.
  known = false;
  await f.timers.fire(); await f.engine.idle();
  assert.equal(calls, 2); assert.equal((await f.delivery()).state, "sent");
  assert.deepEqual(f.timers.pending, [], "no timer once it is sent");
});

test("live bug (2026-11-17), the agent Paseo couldn't load: every send times out and the chat says it isn't there; resends back off and it goes once the agent loads", async t => {
  // A plugin's refresh took the agent out of Paseo's agent manager for 27 minutes: each send waited on the load until
  // the client's 60 s timeout, and its transcript (written last before the send) showed the answer wasn't there.
  let loads = false; let sends = 0;
  const f = await setup(t, { deliver: async target => { sends++; if (!loads) throw new Error("Timeout waiting for message (60000ms)"); return target.recipients[0]!; }, arrived: async () => false });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const waits: number[] = [];
  for (let i = 0; i < 6 && f.timers.pending.length; i++) { waits.push(await f.timers.fire()); await f.engine.idle(); }
  assert.deepEqual(waits, [...AMBIGUOUS_MS, AMBIGUOUS_MS.at(-1)!, AMBIGUOUS_MS.at(-1)!], "backs off like a check that can't tell, never a resend every 15 s");
  assert.equal(sends, 7, "one send per step, each after the chat showed it missing");
  assert.equal((await f.delivery()).state, "retrying");
  loads = true;
  await f.timers.fire(); await f.engine.idle();
  assert.equal((await f.delivery()).state, "sent", "the agent is back: delivered");
  assert.equal(f.delivered.length, 1, "it reached the agent once");
});

test("only a gone conversation ends Failed; Retry there resends without asking", async t => {
  let calls = 0;
  const f = await setup(t, { deliver: async target => { calls++; if (calls === 1) throw new ConversationGone("main-agent", "No conversation found"); return target.recipients[0]!; } });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  const d = await f.delivery();
  assert.equal(d.state, "failed"); assert.match(d.reason!, /conversation is gone/);
  assert.deepEqual(f.timers.pending, [], "nothing scheduled: the target can't take messages");
  assert.equal(deliveryStatus({ state: "failed", reason: d.reason }).action, "retry");
  await f.engine.answer(f.wid, "Q1", "A", undefined, "resend"); await f.engine.idle();
  assert.equal(calls, 2); assert.equal((await f.delivery()).state, "sent");
});

test("a restart resumes what it left: sending reads back uncertain, and an old Failed with no gone target goes back to checking", async t => {
  const f = await setup(t);
  const base = { kind: "answer" as const, key: "w", ref: { workspaceId: f.wid, questionId: "Q404" }, text: "Follow-up answer Q404 (x): A", createdAt: "2026-11-16T08:00:00.000Z" };
  await writeFile(join(f.root, QUEUE_FILE), JSON.stringify({ version: 1, items: [
    { ...base, id: "a", messageId: "m-a", state: "sending", envelope: { messageId: "m-a", to: null, at: "2026-11-16T08:00:01.000Z" } },
    { ...base, id: "b", messageId: "m-b", state: "failed", unknowns: 4, reason: "Follow-up couldn't confirm the agent got it.", envelope: { messageId: "m-b", to: null, at: "2026-11-16T08:00:01.000Z" } },
    { ...base, id: "c", messageId: "m-c", state: "failed", gone: "old-agent", reason: "The agent's conversation is gone, so it can't take messages.", envelope: { messageId: "m-c", to: "old-agent", at: "2026-11-16T08:00:01.000Z" } },
  ] }));
  const next = await testQueue(f.root, { arrived: async () => null });
  f.stops.push(async () => { next.queue.stop(); await next.queue.writer.flush().catch(() => undefined); });
  const state = (id: string) => next.queue.get(id)!;
  assert.equal(state("a").state, "uncertain"); assert.equal(state("b").state, "uncertain"); assert.equal(state("c").state, "failed");
  for (const id of ["a", "b"]) assert.ok(state(id).nextAt, `${id} has a next try`);
  assert.equal(queueItemStop(state("c")), null, "a gone target may stay Failed");
});

/**
 * a-queued-message-never-stops-short (the class of 2026-11-17's lost answer): every way out of a send ends in exactly
 * one of delivered (confirmed, or found in the chat), a scheduled next try, or Failed because its target is gone, with
 * the reason. A grid over every send outcome and every arrival answer, followed past the whole ladder.
 */
test("invariant grid: no outcome leaves an item failed or waiting with nothing next, unless its target is gone", async t => {
  type Send = "ok" | "deferred" | "unreachable" | "error" | "hang" | "gone";
  const sends: Send[] = ["ok", "deferred", "unreachable", "error", "hang", "gone"];
  const answers: (boolean | null | "throws")[] = [true, false, null, "throws"];
  for (const first of sends) for (const answer of answers) {
    let calls = 0;
    const f = await setup(t, {
      deliver: async target => {
        calls++;
        const outcome = calls === 1 ? first : "error";
        if (outcome === "deferred") throw new DeliveryDeferred("waiting for the agent's permission prompt");
        if (outcome === "unreachable") throw new DeliveryDeferred("Paseo unreachable");
        if (outcome === "error") throw new Error("Timeout waiting for message (60000ms)");
        if (outcome === "hang") return new Promise<string>(() => undefined);
        if (outcome === "gone") throw new ConversationGone(target.recipients[0]!, "No conversation found");
        return target.recipients[0]!;
      },
      arrived: async () => { if (answer === "throws") throw new Error("socket closed"); return answer; },
    });
    await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); void f.engine.idle();
    for (let i = 0; i < 12 && f.timers.pending.length; i++) {
      await f.timers.fire(); await f.queue.idle();
      for (const item of f.queue.list().items) {
        const why = queueItemStop(item);
        assert.equal(why, null, `${first}/${String(answer)} step ${i}: ${why}`);
      }
    }
    for (const item of [...f.queue.list().items, ...f.queue.list().recent]) assert.equal(queueItemStop(item), null, `${first}/${String(answer)} at the end: ${queueItemStop(item)}`);
    f.queue.stop();
  }
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
  const q = testStore(MessageQueue, root, { deliverTo: async () => "a", arrived: async () => null });
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
  assert.equal(d.state, "queued"); assert.equal(Date.parse(d.nextAt!), Date.parse("2026-11-16T09:00:00.000Z") + f.timers.now + PROBE_SLOW_MS, "the card's 'Next try at' is the next probe");
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

test("a waiting item's status line says when the next try is, not the state's own name", () => {
  const clock = () => "12:04", nextAt = "2026-11-16T12:04:00.000Z";
  const retrying = deliveryStatus({ state: "retrying", reason: null, nextAt }, clock);
  assert.equal(retrying.label, "Next try at 12:04");
  assert.match(retrying.detail, /^Next try at 12:04\. Not confirmed yet\./);
  assert.equal(deliveryStatus({ state: "queued", reason: "Paseo unreachable", nextAt }, clock).detail, "Queued: Paseo unreachable. Next try at 12:04.");
  assert.equal(deliveryStatus({ state: "queued", reason: null, nextAt: null }, clock).detail, "Queued.");
  for (const state of ["queued", "retrying"] as const) assert.doesNotMatch(JSON.stringify(deliveryStatus({ state, reason: "Paseo unreachable", nextAt }, clock)), /retrying at/i);
});

test("an unloaded agent's transcript says \"not there\" only when what was read reaches back to the send", () => {
  const since = Date.parse("2026-11-16T09:00:00.000Z");
  const line = (at: string, text: string) => JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: text } });
  const marker = "Follow-up answer Q7 (Cache policy): A";
  const before = line("2026-11-16T08:59:00.000Z", "earlier work"), after = line("2026-11-16T09:01:00.000Z", "later work");
  assert.equal(markerSince([before, line("2026-11-16T09:00:05.000Z", `${marker}\n\nmore`)], false, since, marker), true, "found");
  assert.equal(markerSince([before, after], false, since, marker), false, "the tail reaches back past the send and has no marker");
  assert.equal(markerSince([after], false, since, marker), null, "the tail starts after the send: it may have scrolled out");
  assert.equal(markerSince([after], true, since, marker), false, "the whole file was read");
  assert.equal(markerSince(["not json", "{}"], false, since, marker), null, "no dated line: unknown");
  assert.equal(markerSince([before], false, since, ""), null, "no marker to look for: unknown");
});

test("an unloaded agent's transcript is read back to the send, past a fixed tail: a busy agent's megabytes don't make it unknown", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-queue-transcript-")); t.after(() => rm(root, { recursive: true, force: true }));
  const since = Date.parse("2026-11-16T09:00:00.000Z");
  const marker = "Follow-up answer Q7 (Cache policy): A";
  const line = (at: string, text: string) => JSON.stringify({ type: "assistant", timestamp: at, message: { content: text } });
  // 6 MB written after the send (far more than the 512 KB tail), an hour of older work before it.
  const busy = Array.from({ length: 3_000 }, (_, i) => line(new Date(since + 5_000 + i * 100).toISOString(), "x".repeat(2_000))).join("\n");
  const older = Array.from({ length: 1_000 }, (_, i) => line(new Date(since - 3_600_000 + i * 1_000).toISOString(), "y".repeat(2_000))).join("\n");
  const missing = join(root, "missing.jsonl"), found = join(root, "found.jsonl");
  await writeFile(missing, `${older}\n${busy}\n`);
  await writeFile(found, `${older}\n${line(new Date(since + 1_000).toISOString(), marker)}\n${busy}\n`);
  assert.equal(await markerInFile(missing, since, marker), false, "read back past the send: not there");
  assert.equal(await markerInFile(found, since, marker), true, "found behind 6 MB of later work");
  assert.equal(await markerInFile(missing, since, marker, 2 * 1024 * 1024), null, "past the read cap: unknown, never a guess");
});


/**
 * a-queued-message-never-stops-short, two more ways a message stopped short (2026-11-17, after #230):
 * - Paseo 0.16 keeps a receipt per agent and messageId. A daemon that dies between the pending and the completed write
 *   leaves it pending, and every later send under that id is refused (agent_request_outcome_unknown) for good. The queue
 *   resent under the same id forever.
 * - A loaded agent that wrote more than the timeline read's 5 pages since the send left every check unknown.
 */
test("a messageId Paseo refuses for good (a stuck receipt) is resent under a fresh id once the chat shows it isn't there; the check looks for every id it used", async t => {
  const refused = new Set<string>(); const asked: string[][] = []; const sent: string[] = [];
  const f = await setup(t, {
    deliver: async (target, _text, messageId) => {
      sent.push(messageId);
      if (refused.size === 0) refused.add(messageId);
      if (refused.has(messageId)) throw new Error("agent_request_outcome_unknown");
      return target.recipients[0]!;
    },
    arrived: async (_agent, messageId) => { asked.at(-1)!.push(messageId); return false; },
  });
  const fire = async () => { asked.push([]); await f.timers.fire(); await f.engine.idle(); };
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  for (let i = 0; i < 3 && (await f.delivery()).state !== "sent"; i++) await fire();
  assert.equal((await f.delivery()).state, "sent", "it reached the agent");
  assert.equal(new Set(sent).size, 2, "a fresh id after the refusal");
  assert.equal(sent.filter(id => !refused.has(id)).length, 1, "the fresh id went once");
  assert.ok(asked.some(ids => ids.includes(sent[0]!)), "the check looked for the refused id before resending");
});

test("a key conflict is refused like a stuck receipt; a refused id is never retried blind, only after the chat says not there", async t => {
  const sent: string[] = []; let known: boolean | null = null;
  const f = await setup(t, {
    deliver: async (target, _text, messageId) => { sent.push(messageId); if (sent.length === 1) throw new Error("agent_request_key_conflict"); return target.recipients[0]!; },
    arrived: async () => known,
  });
  await f.engine.answer(f.wid, "Q1", "A", undefined, "send"); await f.engine.idle();
  await f.timers.fire(); await f.engine.idle();
  assert.equal(sent.length, 1, "the chat couldn't tell: nothing resent");
  known = false;
  await f.timers.fire(); await f.engine.idle();
  assert.equal(sent.length, 2); assert.notEqual(sent[1], sent[0]);
  assert.equal((await f.delivery()).state, "sent");
});

test("a loaded, busy agent: when its timeline can't tell, the transcript decides (read only for an unconfirmed item)", async () => {
  const { PaseoGateway } = await import("../server/daemon");
  const since = "2026-11-16T09:00:00.000Z";
  // Five full pages, each newer than the send and each with older ones behind it: the timeline read can't tell.
  const page = { entries: Array.from({ length: 200 }, () => ({ timestamp: "2026-11-16T09:30:00.000Z", item: { type: "assistant_message" } })), hasOlder: true, startCursor: { epoch: "e", seq: 1 } };
  const client = { fetchAgent: async () => ({ agent: { id: "a1", status: "running", activeTurn: {}, pendingPermissions: [], lastError: null } }), fetchAgentTimeline: async () => page };
  const gateway = new PaseoGateway((async (work: (c: unknown) => Promise<unknown>) => work(client)) as never);
  const looked: string[] = [];
  for (const answer of [false, true, null] as const) {
    gateway.transcriptArrived = async (agentId, marker) => { looked.push(`${agentId}:${marker}`); return answer; };
    assert.equal(await gateway.arrivedMessage("a1", "m-1", since, "Follow-up answer Q7 (x): A"), answer);
  }
  assert.equal(looked.length, 3, "the transcript was read each time the timeline couldn't tell");
  const found = { ...page, entries: [{ timestamp: "2026-11-16T09:00:05.000Z", item: { type: "user_message", clientMessageId: "m-1" } }] };
  const quick = new PaseoGateway((async (work: (c: unknown) => Promise<unknown>) => work({ ...client, fetchAgentTimeline: async () => found })) as never);
  quick.transcriptArrived = async () => { throw new Error("not read when the timeline answers"); };
  assert.equal(await quick.arrivedMessage("a1", "m-1", since, "x"), true);
});
