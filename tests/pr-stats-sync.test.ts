import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsGate } from "../server/pr-stats-gate";
import { statsPath, StatsStore } from "../server/pr-stats-store";
import { BACKFILL_PAGES_PER_RUN, StatsSync } from "../server/pr-stats-sync";
import { FLAG, STATS_PAGE_SIZE } from "../shared/pr-stats-records";
import type { Budget } from "../shared/poll";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

/** A sync over the fake repository with an open gate (normal budget, a generous slice) and a pinned clock. */
async function setup(o: { count?: number; slice?: number } = {}) {
  let now = clock;
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-"));
  const github = new FakeStatsGithub(() => now, { count: o.count });
  const budgets = new Map<string, Budget>();
  const gate = new StatsGate({ budget: owner => budgets.get(owner), noteRateLimit: (owner, r) => budgets.set(owner, { remaining: r.remaining!, resetAt: Date.parse(r.resetAt!), limit: r.limit }), noteLimited: (owner, resetAt) => budgets.set(owner, { remaining: 0, resetAt }), allowsBackground: () => true, slice: () => o.slice ?? 0.1, now: () => now });
  const open = () => trackPersistence(directory, new StatsStore(directory, { now: () => now, log: () => undefined }));
  const store = open();
  const sync = (s = store) => new StatsSync({ api: github, gate, store: s, now: () => now, log: () => undefined });
  return { directory, github, gate, store, open, sync, budgets, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("stats sync: the first run reads 90 days of PRs, and only those, a page of 25 at a time", async () => {
  const t = await setup();
  try {
    const result = await t.sync().run("example/app", { backfillPages: 100 });
    const want = t.github.inWindow(90);
    const stats = await t.store.open("example/app");
    assert.equal(result.error, null);
    assert.equal(result.backfillDone, true);
    assert.deepEqual([...stats.records.keys()].sort((a, b) => a - b), want.map(p => p.number).sort((a, b) => a - b), "every PR updated in the window, none older");
    assert.ok(t.github.calls.filter(c => c.kind === "page").every(c => c.first === STATS_PAGE_SIZE));
    const pages = t.github.calls.filter(c => c.kind === "page").length;
    assert.equal(pages, Math.ceil((want.length + 1) / STATS_PAGE_SIZE), "it stops at the first page reaching past the window");
    assert.equal(stats.meta.defaultBranch, "main");
    assert.ok(stats.meta.highWater! >= Math.max(...want.map(p => Date.parse(p.updatedAt) / 1000)));
    await t.store.flush();
    const file = JSON.parse(await readFile(statsPath(t.directory, "example/app")!, "utf8"));
    assert.equal(file.records.length, stats.records.size, "the file holds what memory holds");
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: an incremental pass reads from the newest down to the high-water mark (with overlap), usually one page", async () => {
  const t = await setup();
  try {
    await t.sync().run("example/app", { backfillPages: 100 });
    t.github.calls = [];
    t.advance(60 * 60_000);
    const old = t.github.prs.find(p => p.number < 20 && p.author?.__typename === "User" && p.author.login !== "erin")!.number;
    t.github.touch(280, "erin"); t.github.touch(old, "erin");
    const result = await t.sync().run("example/app");
    assert.equal(t.github.calls.length, 1, "one page");
    assert.equal(result.changed, 2);
    const stats = await t.store.open("example/app");
    assert.ok(stats.records.get(old)!.rv.some(([who]) => who === "erin"), "an old PR updated now is read again");
    assert.equal(stats.meta.highWater, Math.floor(t.now() / 1000));
    // Nothing changed: still one page, nothing written into the records.
    t.github.calls = []; t.advance(60 * 60_000);
    const quiet = await t.sync().run("example/app");
    assert.equal(t.github.calls.length, 1); assert.equal(quiet.changed, 0);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: the backfill resumes from its cursor after a restart, and reports how far back it reached", async () => {
  const t = await setup();
  try {
    const first = await t.sync().run("example/app", { backfillPages: 3 });
    assert.equal(first.backfillDone, false);
    let stats = await t.store.open("example/app");
    assert.equal(stats.records.size, 75);
    const coveredTo = stats.meta.backfill.coveredTo!;
    assert.ok(coveredTo > Math.floor(t.now() / 1000) - 90 * 86_400, "coverage is a date inside the window");
    await t.store.flush(); t.store.close();
    // A new worker: a new store over the same directory.
    const store = t.open();
    t.github.calls = [];
    const second = await t.sync(store).run("example/app", { backfillPages: 100 });
    assert.equal(second.backfillDone, true);
    const firstBackfill = t.github.calls.find(c => c.kind === "page" && c.after !== null);
    assert.ok(firstBackfill, "the backfill continued from a cursor, not from the top");
    stats = await store.open("example/app");
    assert.equal(stats.records.size, t.github.inWindow(90).length);
    assert.equal(t.github.calls.filter(c => c.kind === "page").length, 1 + Math.ceil((t.github.inWindow(90).length + 1) / 25) - 3, "an incremental page, then only the pages not read yet");
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: a 502 or RESOURCE_LIMITS answer halves the page for that repository until a page succeeds", async () => {
  for (const failure of ["502", "resource"] as const) {
    const t = await setup();
    try {
      let failed = 0;
      t.github.fail = call => {
        if (call.kind !== "page" || failed >= 1) return undefined;
        failed++;
        return failure === "502" ? Object.assign(new Error("GitHub HTTP 502"), { status: 502 }) : { data: null, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits for this query exceeded." }] };
      };
      const result = await t.sync().run("example/app", { backfillPages: 2 });
      assert.equal(result.error, null, failure);
      const firsts = t.github.calls.filter(c => c.kind === "page").map(c => c.first);
      assert.deepEqual(firsts.slice(0, 3), [25, 12, 25], `${failure}: 25 failed, 12 succeeded, then back to 25`);
    } finally { await rm(t.directory, { recursive: true, force: true }); }
  }
});

test("stats sync: repeated failures stop the run with the error kept, and a later success clears it", async () => {
  const t = await setup();
  try {
    t.github.fail = () => Object.assign(new Error("GitHub HTTP 502"), { status: 502 });
    const result = await t.sync().run("example/app");
    assert.match(result.error!, /502/);
    assert.equal(t.github.calls.length, 3, "three tries, each on a smaller page, then it stops");
    assert.equal((await t.store.open("example/app")).meta.error?.status, 502);
    t.github.fail = null; t.advance(60 * 60_000);
    await t.sync().run("example/app", { backfillPages: 100 });
    assert.equal((await t.store.open("example/app")).meta.error, null);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: a repository the token can't read says so (404), with nothing stored", async () => {
  const t = await setup();
  try {
    const result = await t.sync().run("example/private");
    assert.match(result.error!, /not found or no access/);
    const stats = await t.store.open("example/private");
    assert.equal(stats.records.size, 0);
    assert.equal(stats.meta.error?.status, 404);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: a PR with more reviews than the page gets one follow-up read for all of them, batched", async () => {
  const t = await setup();
  try {
    await t.sync().run("example/app", { backfillPages: 100 });
    const busy = t.github.inWindow(90).filter(p => p._reviews.length > 20).map(p => p.number);
    assert.ok(busy.length >= 1, "the fixture has PRs past the page");
    const stats = await t.store.open("example/app");
    for (const n of busy) {
      const record = stats.records.get(n)!;
      assert.equal((record.fl ?? 0) & FLAG.reviewsTruncated, 0, `#${n}: flag cleared once read`);
      assert.equal(record.rv.length, 25, `#${n}: every reviewer`);
    }
    const followUps = t.github.calls.filter(c => c.kind === "reviews");
    assert.ok(followUps.length >= 1 && followUps.every(c => c.numbers.length <= 10));
    assert.deepEqual(stats.meta.pendingReviews, []);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: records older than the window are dropped at the next run", async () => {
  const t = await setup();
  try {
    await t.sync().run("example/app", { backfillPages: 100 });
    t.advance(30 * 86_400_000);
    await t.sync().run("example/app");
    const stats = await t.store.open("example/app");
    const from = Math.floor(t.now() / 1000) - 90 * 86_400;
    assert.ok([...stats.records.values()].every(r => r.u >= from));
    assert.ok(stats.records.size < t.github.inWindow(120).length);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});

test("stats sync: the backfill reads at most BACKFILL_PAGES_PER_RUN pages a run", async () => {
  const t = await setup({ count: 1500 });
  try {
    await t.sync().run("example/app");
    assert.equal(t.github.calls.filter(c => c.kind === "page").length, BACKFILL_PAGES_PER_RUN);
  } finally { await rm(t.directory, { recursive: true, force: true }); }
});
