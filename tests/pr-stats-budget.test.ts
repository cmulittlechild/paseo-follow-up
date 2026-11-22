import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Github } from "../server/github";
import { StatsGate, SLICE_WINDOW_MS } from "../server/pr-stats-gate";
import { statsPath, StatsStore } from "../server/pr-stats-store";
import { StatsSync } from "../server/pr-stats-sync";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

/**
 * stats-stay-in-their-slice, over time: a 50-person team's repository (~3,250 PRs in 90 days), synced every 5 minutes
 * for 6 hours (the page open the whole time, the worst case). The points stats spend in any rolling hour never pass
 * the slice (5 % of 5000 = 250), the backfill still finishes, and the poller's budget moves with every answer.
 */
test("stats-stay-in-their-slice: six hours of syncs never spend more than the slice in any rolling hour", async () => {
  let now = clock;
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-budget-"));
  try {
    const fake = new FakeStatsGithub(() => now, { count: 3250 });
    fake.cost = 3; // pricier than measured (1 a page), so the slice has to bite
    const spent: { at: number; cost: number }[] = [];
    const api = { graphql: async (repo: string, query: string, variables: Record<string, string>) => {
      const body = await fake.graphql(repo, query, variables);
      spent.push({ at: now, cost: body.data?.rateLimit?.cost ?? 0 });
      return body;
    }, rest: fake.rest.bind(fake) };
    const github = new Github(undefined, undefined, undefined, { graphql: async () => ({}), rest: async () => [] }, () => now);
    const gate = new StatsGate({ budget: o => github.budget(o), noteRateLimit: (o, r) => github.noteRateLimit(o, r), noteLimited: (o, at) => github.noteLimited(o, at), allowsBackground: () => true, now: () => now });
    const store = trackPersistence(directory, new StatsStore(directory, { now: () => now, log: () => undefined }));
    const sync = new StatsSync({ api, gate, store, now: () => now, log: () => undefined });
    let done = false;
    for (let minute = 0; minute < 6 * 60; minute += 5) {
      if (minute % 30 === 0) fake.touch(3250 - minute / 30, "alice");
      const result = await sync.run("example/app");
      done ||= result.backfillDone;
      now += 5 * 60_000;
    }
    const worst = Math.max(...spent.map(s => spent.filter(e => e.at >= s.at && e.at < s.at + SLICE_WINDOW_MS).reduce((sum, e) => sum + e.cost, 0)));
    assert.ok(worst <= 250, `worst rolling hour ${worst} points, slice 250`);
    assert.ok(done, "the backfill finished inside the slice");
    const stats = await store.open("example/app");
    assert.equal(stats.records.size, fake.inWindow(90).length);
    assert.equal(github.budget("example")?.remaining, fake.remaining, "the shared budget is the last answer's");
    await store.flush();
    const bytes = (await stat(statsPath(directory, "example/app")!)).size;
    assert.ok(bytes / stats.records.size < 450, `~${Math.round(bytes / stats.records.size)} bytes a record (design: 250-350)`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
