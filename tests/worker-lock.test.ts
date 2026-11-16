import { testStore, rm } from "./support/store-temp-dir";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { OWNER_START_SLACK_MS, RECOVERY_STALE_MS, Store, workerOwner } from "../server/store";
import { fakeServer, hangingHost } from "./support/hanging-host";

/**
 * a-new-worker-starts-once-the-old-one-exits. 2026-11-16: Paseo updated itself and restarted its daemon worker, which
 * exited without stopping its plugins; the old Follow-up worker outlived it while the new daemon started a new one.
 * Its Store.lock found worker.lock owned by a live pid and threw, start-up turned that into a permanent load error,
 * and Follow-up stayed down after the old worker exited, until the plugin was reloaded.
 */
const FAST = { fast: 100, fastForMs: 60_000, slow: 30_000 };

async function previousWorker(t: TestContext, lock: string, holdMs: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/plugin-process.mjs"), lock, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  return child;
}
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "follow-lock-")); t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a-new-worker-starts-once-the-old-one-exits: the lock waits for a live previous worker and is claimed once it exits", async t => {
  const dir = await directory(t);
  const old = await previousWorker(t, join(dir, "worker.lock"), 2_000);
  const store = testStore(Store, dir); t.after(() => store.close().catch(() => undefined));
  const waits: (number | null)[] = [];
  const started = Date.now();
  const unlock = await store.lock({ onWait: pid => waits.push(pid), pollMs: FAST });
  assert.notEqual(old.exitCode, null, "claimed only after the previous worker exited");
  assert.ok(Date.now() - started >= 1_500, "it waited for the previous worker");
  assert.ok(waits.length > 0 && waits.every(pid => pid === old.pid), "it reported the wait, naming the previous worker");
  assert.match(await readFile(join(dir, "worker.lock"), "utf8"), new RegExp(`^${process.pid}:`));
  await unlock();
  assert.equal(existsSync(join(dir, "worker.lock")), false);
});

test("a-new-worker-starts-once-the-old-one-exits: a reused pid that isn't a plugin process doesn't hold the lock", async t => {
  const dir = await directory(t);
  const other = spawn("sleep", ["30"], { stdio: "ignore" }); t.after(() => other.kill("SIGKILL"));
  await writeFile(join(dir, "worker.lock"), `${other.pid}:an-old-worker`);
  assert.equal(workerOwner(other.pid!), false, "a running pid that is not a plugin process");
  const store = testStore(Store, dir); t.after(() => store.close().catch(() => undefined));
  const waits: (number | null)[] = [];
  await store.lock({ onWait: pid => waits.push(pid), pollMs: FAST });
  assert.deepEqual(waits, [], "stale at once: no wait");
  assert.match(await readFile(join(dir, "worker.lock"), "utf8"), new RegExp(`^${process.pid}:`));
});

test("a-new-worker-starts-once-the-old-one-exits: a plugin process that started after the lock was written doesn't hold it", async t => {
  // The dead owner's pid reused by another plugin's worker: a daemon restart starts every plugin process at once.
  const dir = await directory(t);
  const other = await previousWorker(t, "-", 30_000);
  const lock = join(dir, "worker.lock");
  await writeFile(lock, `${other.pid}:the-dead-worker`);
  const written = new Date(Date.now() - 4 * OWNER_START_SLACK_MS);
  await utimes(lock, written, written);
  assert.equal(workerOwner(other.pid!, written.getTime()), false, "started after the lock: not its owner");
  assert.equal(workerOwner(other.pid!, Date.now()), true, "the same process counts for a lock written after it started");
  const store = testStore(Store, dir); t.after(() => store.close().catch(() => undefined));
  const waits: (number | null)[] = [];
  await store.lock({ onWait: pid => waits.push(pid), pollMs: FAST });
  assert.deepEqual(waits, [], "stale at once: no wait on an unrelated plugin's worker");
  assert.match(await readFile(lock, "utf8"), new RegExp(`^${process.pid}:`));
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

test("a-new-worker-starts-once-the-old-one-exits: a clear claim left by a worker that died mid-clear is removed, and the lock is claimed", async t => {
  // A worker killed between taking worker.lock.recovery and removing it (SIGKILL, OOM) left it for good: every start
  // then waited on it forever, and said nothing.
  for (const left of ["dead holder", "empty and old", "live but older than RECOVERY_STALE_MS"]) {
    const dir = await directory(t);
    const lock = join(dir, "worker.lock");
    await writeFile(lock, `${await deadPid()}:the-dead-worker`);
    if (left === "dead holder") await writeFile(`${lock}.recovery`, String(await deadPid()));
    else if (left === "empty and old") await writeFile(`${lock}.recovery`, "");
    else await writeFile(`${lock}.recovery`, String((await previousWorker(t, "-", 30_000)).pid));
    if (left !== "dead holder") { const old = new Date(Date.now() - 2 * RECOVERY_STALE_MS); await utimes(`${lock}.recovery`, old, old); }
    const store = testStore(Store, dir); t.after(() => store.close().catch(() => undefined));
    const waits: (number | null)[] = [];
    await store.lock({ onWait: pid => waits.push(pid), pollMs: FAST });
    assert.deepEqual(waits, [], `${left}: cleared at once, no wait`);
    assert.match(await readFile(lock, "utf8"), new RegExp(`^${process.pid}:`), left);
    assert.equal(existsSync(`${lock}.recovery`), false, left);
  }
});

test("a-new-worker-starts-once-the-old-one-exits: a live worker clearing the lock is waited for, and the wait is reported", async t => {
  const dir = await directory(t);
  const lock = join(dir, "worker.lock");
  await writeFile(lock, `${await deadPid()}:the-dead-worker`);
  const clearer = await previousWorker(t, "-", 30_000);
  await writeFile(`${lock}.recovery`, String(clearer.pid));
  setTimeout(() => void rm(`${lock}.recovery`, { force: true }), 1_000);
  const store = testStore(Store, dir); t.after(() => store.close().catch(() => undefined));
  const waits: (number | null)[] = [];
  await store.lock({ onWait: pid => waits.push(pid), pollMs: FAST });
  assert.ok(waits.length > 0 && waits.every(pid => pid === clearer.pid), "it reported waiting on the worker clearing the lock");
  assert.match(await readFile(lock, "utf8"), new RegExp(`^${process.pid}:`));
});

test("a-new-worker-starts-once-the-old-one-exits: only a lock with no valid owner is an error, and stopping ends the wait", async t => {
  const dir = await directory(t);
  await writeFile(join(dir, "worker.lock"), "not-a-pid");
  await assert.rejects(testStore(Store, dir).lock({ pollMs: FAST }), /invalid owner/);
  const live = await directory(t);
  await previousWorker(t, join(live, "worker.lock"), 60_000);
  const store = testStore(Store, live);
  const waiting = store.lock({ pollMs: { fast: 30_000, fastForMs: 60_000, slow: 30_000 } });
  await new Promise(resolve => setTimeout(resolve, 200));
  const stopped = Date.now();
  await store.close();
  await assert.rejects(waiting, /stopping/);
  assert.ok(Date.now() - stopped < 1_000, "close ends a 30 s wait at once");
});

test("a-new-worker-starts-once-the-old-one-exits: the worker answers that it is waiting, never a load error, and starts when the lock frees", { timeout: 120_000 }, async t => {
  const host = await hangingHost(); t.after(() => host.close());
  const old = await previousWorker(t, join(host.directory, "worker.lock"), 3_000);
  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());
  const list = () => handlers.get("follow.list")!.run({}, { paseo: {} }) as Promise<{ error: string | null; full?: boolean }>;
  // Before it reaches the lock, start-up (onboarding) is still running and list waits on it: poll with a short cap.
  const quick = () => Promise.race([list(), new Promise<null>(r => setTimeout(() => r(null), 100))]);
  let during = await quick();
  for (let i = 0; i < 40 && !/Waiting/.test(during?.error ?? ""); i++) during = await quick();
  assert.ok(during, "list answers at once while the worker waits");
  assert.match(during!.error ?? "", /Waiting for the previous Follow-up worker to exit \(pid \d+\)/, "it says it is waiting, at once");
  assert.equal(during!.full, false, "and keeps the client's last list");
  await once(old, "exit");
  let after = await list();
  for (let i = 0; i < 100 && after.error && /Waiting/.test(after.error); i++) { await new Promise(r => setTimeout(r, 200)); after = await list(); }
  assert.doesNotMatch(after.error ?? "", /could not start|Waiting/, "it started once the previous worker exited");
  assert.match(await readFile(join(host.directory, "worker.lock"), "utf8"), new RegExp(`^${process.pid}:`));
});

test("a-new-worker-starts-once-the-old-one-exits: a worker whose host goes away stops, frees the lock and exits", { timeout: 120_000 }, async t => {
  // 2026-11-16: the daemon worker exited without stopping its plugins and its tree kill missed them; the orphaned
  // worker kept its timers, and with them the lock. Paseo's plugin process exits only when Follow-up lets it.
  const child = fork(join(import.meta.dirname, "fixtures/orphan-worker.ts"), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [{ lock }] = await once(child, "message") as [{ lock: string }];
  const gone = Date.now();
  const exited = once(child, "exit");
  child.disconnect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([exited.then(() => "exited"), new Promise(r => { timer = setTimeout(() => r("alive"), 10_000); })]).finally(() => clearTimeout(timer));
  t.diagnostic(`disconnect-to-exit: ${Date.now() - gone} ms; lock remains: ${existsSync(lock)}`);
  assert.equal(exit, "exited", "the worker exits once its host's channel closes");
  assert.ok(Date.now() - gone < 3_000, `within Paseo's stop window: ${Date.now() - gone} ms`);
  assert.equal(existsSync(lock), false, "and frees the lock on the way out");
});

test("worker lock: release removes our claim before yielding and preserves a replacement claim", async t => {
  const dir = await directory(t);
  const store = testStore(Store, dir);
  const lock = join(dir, "worker.lock");
  const unlock = await store.lock();
  const released = unlock();
  const remains = existsSync(lock);
  await released;
  assert.equal(remains, false, "lock release must not wait in the filesystem queue after the stop deadline");
  await unlock(); // Already removed is harmless.
  await writeFile(lock, "123:replacement");
  await unlock();
  assert.equal(await readFile(lock, "utf8"), "123:replacement", "never remove a later worker's claim");
});
