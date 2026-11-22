import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Github } from "../server/github";
import { StatsGate, SLICE_WINDOW_MS } from "../server/pr-stats-gate";
import { StatsStore } from "../server/pr-stats-store";
import { StatsSync } from "../server/pr-stats-sync";
import type { GithubApi } from "../server/github-api";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

/**
 * Invariant `stats-never-spend-below-low` (AGENTS.md): no PR-statistics request goes out unless the governor allows
 * background work, the account's budget is at the normal tier (≥ 40 % left), the stats slice of the rolling hour has
 * room, and no other stats request is in flight. Each case below must send zero requests.
 */
async function world(o: { remaining?: number; allows?: boolean; slice?: number } = {}) {
  let now = clock;
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-gate-"));
  const fake = new FakeStatsGithub(() => now);
  // The PR poller's own client: its budget is the one stats read and feed.
  const github = new Github(undefined, undefined, undefined, { graphql: async () => ({}), rest: async () => [] } satisfies GithubApi, () => now);
  if (o.remaining !== undefined) github.noteRateLimit("example", { remaining: o.remaining, resetAt: new Date(now + 30 * 60_000).toISOString(), limit: 5000 });
  let allows = o.allows ?? true;
  const gate = new StatsGate({ budget: owner => github.budget(owner), noteRateLimit: (owner, rate) => github.noteRateLimit(owner, rate), noteLimited: (owner, at) => github.noteLimited(owner, at), allowsBackground: () => allows, slice: () => o.slice ?? 0.05, now: () => now });
  const store = trackPersistence(directory, new StatsStore(directory, { now: () => now, log: () => undefined }));
  const sync = new StatsSync({ api: fake, gate, store, now: () => now, log: () => undefined });
  return { directory, fake, github, gate, sync, store, advance: (ms: number) => { now += ms; }, setAllows: (v: boolean) => { allows = v; }, now: () => now };
}

test("stats-never-spend-below-low: at the low, reserve or critical tier no stats request goes out", async () => {
  for (const [remaining, tier] of [[1999, "low"], [999, "reserve"], [99, "critical"]] as const) {
    const w = await world({ remaining });
    try {
      const result = await w.sync.run("example/app");
      assert.equal(w.fake.calls.length, 0, `${tier}: zero requests`);
      assert.equal(result.waiting?.reason, "budget", tier);
      assert.equal(result.waiting?.until, w.now() + 30 * 60_000, `${tier}: says when the budget resets`);
      const stats = await w.store.open("example/app");
      assert.equal(stats.meta.waiting?.reason, "budget", `${tier}: stored for the page and pr_stats`);
    } finally { await rm(w.directory, { recursive: true, force: true }); }
  }
  // At 40 % exactly (normal) it reads.
  const w = await world({ remaining: 2000 });
  try { await w.sync.run("example/app", { backfillPages: 1 }); assert.equal(w.fake.calls.length, 1); } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("stats-wait-for-the-governor: nothing goes out while the governor holds background work", async () => {
  const w = await world({ allows: false });
  try {
    const result = await w.sync.run("example/app");
    assert.equal(w.fake.calls.length, 0);
    assert.deepEqual(result.waiting, { reason: "governor", until: null });
    w.setAllows(true);
    await w.sync.run("example/app", { backfillPages: 1 });
    assert.equal(w.fake.calls.length, 1, "it reads once the governor allows it");
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("stats-stay-in-their-slice: once the rolling hour's slice is spent, nothing goes out until it rolls off", async () => {
  // A 1 % slice of 5000 = 50 points; pages of 10 points: five pages, then the gate closes.
  const w = await world({ slice: 0.01 });
  try {
    w.fake.cost = 10;
    const first = await w.sync.run("example/app", { backfillPages: 100 });
    assert.equal(w.fake.calls.length, 5);
    assert.equal(first.waiting?.reason, "slice");
    assert.equal(first.waiting?.until, w.now() + SLICE_WINDOW_MS, "reopens when the first page's cost rolls out of the hour");
    assert.equal(w.gate.spent(), 50);
    w.advance(10 * 60_000);
    await w.sync.run("example/app", { backfillPages: 100 });
    assert.equal(w.fake.calls.length, 5, "still inside the hour: zero requests");
    w.advance(SLICE_WINDOW_MS);
    await w.sync.run("example/app", { backfillPages: 100 });
    assert.ok(w.fake.calls.length > 5, "the next hour reads again");
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("stats-take-one-slot: a second stats request waits while one is in flight", async () => {
  const w = await world();
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = w.gate.run("example", async () => { await held; return { value: 1, rate: undefined }; });
    assert.deepEqual(w.gate.mayRead("example"), { ok: false, reason: "busy", until: null });
    const second = await w.sync.run("example/app");
    assert.equal(w.fake.calls.length, 0, "the sync's page didn't go out beside the one in flight");
    assert.equal(second.waiting?.reason, "busy");
    release(); await first;
    assert.deepEqual(w.gate.mayRead("example"), { ok: true });
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("stats-feed-the-shared-budget: a stats response moves the PR poller's budget, and the poller's low budget stops stats", async () => {
  const w = await world();
  try {
    assert.equal(w.github.budget("example"), undefined);
    w.fake.remaining = 4200;
    await w.sync.run("example/app", { backfillPages: 1 });
    assert.equal(w.github.budget("example")?.remaining, 4199, "the poller sees what stats saw");
    assert.equal(w.github.stats.points, 0, "stats' cost isn't counted as the poller's own");
    // Agents' gh calls ran the account down: the poller's next read says 1500 left. Stats stop.
    w.github.noteRateLimit("example", { remaining: 1500, resetAt: new Date(w.now() + 40 * 60_000).toISOString(), limit: 5000 });
    w.fake.calls = [];
    w.advance(5 * 60_000);
    const result = await w.sync.run("example/app");
    assert.equal(w.fake.calls.length, 0);
    assert.equal(result.waiting?.reason, "budget");
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("stats-feed-the-shared-budget: GitHub refusing stats for the limit rests the poller's account too", async () => {
  const w = await world();
  try {
    w.fake.fail = () => Object.assign(new Error("GitHub API rate limit exceeded"), { rateLimited: true, resetAt: w.now() + 20 * 60_000 });
    const result = await w.sync.run("example/app");
    assert.deepEqual(result.waiting, { reason: "budget", until: w.now() + 20 * 60_000 });
    assert.equal(result.error, null, "the limit is a wait, not an error");
    assert.equal(w.github.budget("example")?.remaining, 0);
    assert.equal(w.github.waitUntil("example/app"), w.now() + 20 * 60_000, "the workspace's GitHub-limit line shows it too");
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});
