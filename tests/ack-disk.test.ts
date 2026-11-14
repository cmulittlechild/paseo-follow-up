import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../server/inbox";
import { ReviewerConfigStore } from "../server/reviewer-config";
import { AgentSettingsStore } from "../server/agent-settings";
import { stopWorker } from "../server/teardown";
import { SURFACE_AFTER, WriteBehind, WriteHealth } from "../server/write-behind";
import { emptyReviewerConfig, reviewerConfig, setReviewerConfig } from "../shared/reviewers";
import { slowFsync } from "./support/slow-disk";

// Invariant an-ack-never-waits-on-the-disk (server/write-behind.ts): no client RPC's reply waits on an fsync, and no
// read queues behind a write in flight. 2026-11-13/14 CI (rpc-ack): follow.inbox-list waited 664 ms behind an
// inbox.json write and follow.save-reviewers 1458 ms on reviewers.json's fsync, with the event loop idle. The
// end-to-end guard is tests/rpc-ack.test.ts, which runs every client RPC with fsync 2 s slow.

const SLOW_MS = 1_000;
/** Well under SLOW_MS: a call that waited on the fsync can't pass. */
const FAST_MS = 150;

async function dir(t: { after(fn: () => unknown): void }) {
  const d = await mkdtemp(join(tmpdir(), "follow-ack-disk-")); t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise(r => setTimeout(r, 10)); }
}
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now(); const value = await work(); return { value, ms: performance.now() - start };
}

test("an-ack-never-waits-on-the-disk: an inbox read or mutation during a slow inbox.json write answers at once", async t => {
  const d = await dir(t);
  const disk = await slowFsync(SLOW_MS); t.after(() => disk.undo());
  const store = new InboxStore(d, Date.now, 20);
  await store.mutate(s => { s.importedAt = "2026-11-10T00:00:00.000Z"; });
  await until(() => disk.syncs() >= 1); // the window's write is in its fsync now
  const read = await timed(() => store.snapshot());
  assert.ok(read.ms < FAST_MS, `snapshot waited ${Math.round(read.ms)} ms on the write in flight`);
  assert.equal(read.value.importedAt, "2026-11-10T00:00:00.000Z", "the read sees the change before it lands");
  const change = await timed(() => store.mutate(s => { s.primedAt = "2026-11-10T00:00:01.000Z"; }));
  assert.ok(change.ms < FAST_MS, `a mutation waited ${Math.round(change.ms)} ms on the write in flight`);
  await store.flush();
  const file = JSON.parse(await readFile(join(d, "inbox.json"), "utf8"));
  assert.equal(file.importedAt, "2026-11-10T00:00:00.000Z");
  assert.equal(file.primedAt, "2026-11-10T00:00:01.000Z", "the newer change lands too, after the one in flight");
});

test("an-ack-never-waits-on-the-disk: save-reviewers' save returns before the fsync, and reviewers.json lands after", async t => {
  const d = await dir(t);
  const disk = await slowFsync(SLOW_MS); t.after(() => disk.undo());
  t.after(() => setReviewerConfig(emptyReviewerConfig()));
  const store = new ReviewerConfigStore(d);
  const save = await timed(() => store.save("example/app", [{ login: "ana", name: "Ana" }]));
  assert.ok(save.ms < FAST_MS, `save waited ${Math.round(save.ms)} ms on the disk`);
  assert.deepEqual(reviewerConfig().repos["example/app"]?.map(r => r.login), ["ana"], "the saved list is what Needs you reads at once");
  assert.deepEqual((await store.read()).repos["example/app"]?.map(r => r.login), ["ana"], "memory is authoritative before the file lands");
  assert.equal(existsSync(join(d, "reviewers.json")), false, "the reply came before the write");
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(join(d, "reviewers.json"), "utf8")).repos, { "example/app": [{ login: "ana", name: "Ana" }] });
  assert.equal((await stat(join(d, "reviewers.json"))).mode & 0o777, 0o600, "owner-only, as before");
});

test("an-ack-never-waits-on-the-disk: validation still rejects before the reply, and nothing is saved", async t => {
  const d = await dir(t);
  const store = new AgentSettingsStore(d);
  await assert.rejects(store.save("about", { provider: "has spaces" }), /isn't valid/);
  assert.equal(store.persist.dirty, false, "a refused change is never queued for the disk");
  assert.equal((await store.role("about")).isDefault, true, "memory keeps the old value");
  await store.flush();
  assert.equal(existsSync(join(d, "agents.json")), false);
});

test("an-ack-never-waits-on-the-disk: the worker's stop writes a pending settings save before the lock goes", async t => {
  const d = await dir(t);
  const agents = new AgentSettingsStore(d);
  const reviewers = new ReviewerConfigStore(d);
  t.after(() => setReviewerConfig(emptyReviewerConfig()));
  await agents.setWait(false);
  await reviewers.save(null, [{ login: "lead", name: null }]);
  assert.ok(agents.persist.dirty && reviewers.persist.dirty, "both saves are still pending");
  let unlockedWith: string[] | null = null;
  await stopWorker({
    ready: Promise.resolve(), actions: { close: async () => {} }, closeConnections: async () => {}, engine: { stop: async () => {} },
    store: { close: async () => {} }, files: [agents, reviewers],
    unlock: async () => { unlockedWith = [existsSync(join(d, "agents.json")), existsSync(join(d, "reviewers.json"))].map(String); },
  });
  assert.deepEqual(unlockedWith, ["true", "true"], "both files were written before the lock was released");
  assert.equal(JSON.parse(await readFile(join(d, "agents.json"), "utf8")).enable_wait, false);
  assert.deepEqual(JSON.parse(await readFile(join(d, "reviewers.json"), "utf8")).defaults, [{ login: "lead", name: null }]);
});

test("an-ack-never-waits-on-the-disk: a failing write logs, retries with backoff, surfaces after a few attempts, then lands once the disk recovers", async t => {
  const d = await dir(t);
  const blocked = join(d, "blocked");
  await writeFile(blocked, "a file where the folder should be"); // every write fails (ENOTDIR) until it goes
  const logs: string[] = []; const health = new WriteHealth(); const waits: number[] = [];
  const file = new WriteBehind<{ n: number }>({ path: join(blocked, "settings.json"), encode: v => JSON.stringify(v), retryMs: attempt => { waits.push(attempt); return 20; }, health, log: line => logs.push(line) });
  file.set({ n: 1 });
  await until(() => file.attempts >= SURFACE_AFTER);
  assert.equal(health.message() !== null, true, `after ${SURFACE_AFTER} attempts the worker's error line names it`);
  assert.match(health.message()!, /couldn't save settings\.json \(\d+ attempts: .*\)\. Your change is kept and saving keeps retrying/);
  assert.ok(logs.length >= SURFACE_AFTER && logs.every(l => /^\[follow-up\] couldn't save settings\.json \(attempt \d+\): .*; kept in memory, retrying$/.test(l)), logs.join("\n"));
  assert.deepEqual(waits.slice(0, 3), [1, 2, 3], "each retry asks the backoff for its attempt");
  file.set({ n: 2 }); // a newer value replaces the one that kept failing
  await rm(blocked); // the disk recovers
  await until(() => file.writes === 1);
  assert.deepEqual(JSON.parse(await readFile(join(blocked, "settings.json"), "utf8")), { n: 2 }, "the newest value lands, once");
  assert.equal(health.message(), null, "the error line clears once it lands");
  assert.equal(file.attempts, 0);
  assert.match(logs.at(-1)!, /^\[follow-up\] saved settings\.json after \d+ failed attempts$/);
});

test("an-ack-never-waits-on-the-disk: the worker shows a save that keeps failing as its error line", async () => {
  const source = await readFile("index.server.ts", "utf8");
  assert.equal(source.match(/loadError \?\? hookError \?\? writeHealth\.message\(\) \?\? engine\.error/g)?.length, 3, "follow.list, follow.get and the workspaces feed carry it");
  assert.match(source, /for \(const file of \[reviewerStore\.persist, agentSettings\.persist, prWorkflow\.persist, inbox\.store\.persist\]\) file\.health = writeHealth;/);
  assert.match(source, /stopWorker\(\{ files: \[reviewerStore, agentSettings, prWorkflow\]/);
});
