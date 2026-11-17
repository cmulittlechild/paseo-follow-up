import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRequests, CONTEXT_FILE } from "../server/context-requests";
import { rm, trackPersistence } from "./support/store-temp-dir";

const input = { workspaceId: "w1", agentId: "a1", cardKey: "agent:a1|Q1", card: "Q1: Which retry policy?", target: "agent" as const, ask: "I don't get it" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "context-requests-"));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const store = trackPersistence(directory, new ContextRequests(directory, () => now));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store, tick: (ms: number) => { now += ms; } };
}

test("an ask is recorded at once, pushes the feed, and saves behind the reply", async t => {
  const { directory, store } = await fixture(t);
  let pushes = 0;
  store.onChange = () => { pushes++; };
  const { request, fresh } = await store.ask(input, "developer", "a1");
  assert.ok(fresh);
  assert.equal(request.state, "asking");
  assert.equal(pushes, 1);
  await store.flush();
  const saved = JSON.parse(await readFile(join(directory, CONTEXT_FILE), "utf8"));
  assert.equal(saved.requests[0].id, request.id);
  // Reopened: the ask survives a worker restart.
  const again = trackPersistence(directory, new ContextRequests(directory));
  assert.equal((await again.list())[0].id, request.id);
});

test("one open ask per card: asking again returns the open one", async t => {
  const { store } = await fixture(t);
  const first = await store.ask(input, "developer", "a1");
  const second = await store.ask({ ...input, ask: "Why does it matter?" }, "developer", "a1");
  assert.equal(second.fresh, false);
  assert.equal(second.request.id, first.request.id);
  assert.equal((await store.list()).length, 1);
});

test("only the asked agent answers, and the answer settles the ask", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask(input, "developer", "a1");
  await assert.rejects(store.reply(request.id, "someone-else", "No."), /another agent/);
  await assert.rejects(store.reply("ctx-missing", "a1", "No."), /No open context request/);
  const answered = await store.reply(request.id, "a1", "  It picks how often a failed charge retries.  ");
  assert.equal(answered.state, "answered");
  assert.equal(answered.answer, "It picks how often a failed charge retries.");
  assert.ok(answered.settledAt);
});

test("a turn that ends without context_reply settles the ask as chat; a turn from before the ask doesn't", async t => {
  const { store, tick } = await fixture(t);
  store.turnStarted("a1"); // a turn already running before the ask: no ask open yet, nothing remembered
  const { request } = await store.ask(input, "developer", "a1");
  await store.turnEnded("a1");
  assert.equal((await store.list())[0].state, "asking", "the turn that was running when they asked isn't the reply");
  tick(1000);
  store.turnStarted("a1");
  tick(5000);
  await store.turnEnded("a1");
  const r = (await store.list()).find(x => x.id === request.id)!;
  assert.equal(r.state, "chat");
});

test("a failed send settles the ask as failed with the reason", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask({ ...input, target: "overseer", agentId: null }, "developer", null);
  await store.fail(request.id, "The Overseer is off.");
  const r = (await store.list())[0];
  assert.equal(r.state, "failed");
  assert.equal(r.error, "The Overseer is off.");
});

test("asks expire after a day", async t => {
  const { store, tick } = await fixture(t);
  await store.ask(input, "developer", "a1");
  tick(25 * 3_600_000);
  assert.deepEqual(await store.list(), []);
});
