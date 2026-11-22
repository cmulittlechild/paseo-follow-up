import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsGate } from "../server/pr-stats-gate";
import { statsPath, StatsStore } from "../server/pr-stats-store";
import { statsPageQuery, statsReviewsQuery, StatsSync } from "../server/pr-stats-sync";
import { statsRecordSchema, TITLE_MAX } from "../shared/pr-stats-records";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

/**
 * Invariant `stats-records-hold-no-text`: PR statistics keep numbers, times, logins, branch names and a title capped at
 * TITLE_MAX. The queries never ask for a body, a comment's text, a diff or a file list, and a record has no field
 * that could hold one.
 */
test("stats-records-hold-no-text: the queries ask for no body, comment text, diff or file list", () => {
  for (const query of [statsPageQuery(25, false), statsPageQuery(10, true), statsReviewsQuery([1, 2, 3])]) {
    assert.doesNotMatch(query, /\bbody(Text|HTML)?\b|\bfiles\b|\bpatch\b|\bdiff\b|\bemail\b/i, query);
  }
});

test("stats-records-hold-no-text: a stored record has only the schema's fields, and the file holds no PR body", async () => {
  let now = clock;
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-privacy-"));
  try {
    const fake = new FakeStatsGithub(() => now);
    fake.prs[0]!.title = "x".repeat(400);
    const gate = new StatsGate({ budget: () => undefined, noteRateLimit: () => undefined, noteLimited: () => undefined, allowsBackground: () => true, slice: () => 0.1, now: () => now });
    const store = trackPersistence(directory, new StatsStore(directory, { now: () => now, log: () => undefined }));
    // The fake's nodes carry a body the real query never asks for: the parse must not keep it either way.
    const leaky = { graphql: async (r: string, q: string, v: Record<string, string>) => {
      const body = await fake.graphql(r, q, v);
      for (const node of body.data?.repository?.pullRequests?.nodes ?? []) node.body = "Secret body text";
      return body;
    }, rest: fake.rest.bind(fake) };
    await new StatsSync({ api: leaky, gate, store, now: () => now, log: () => undefined }).run("example/app", { backfillPages: 100 });
    await store.flush();
    const text = await readFile(statsPath(directory, "example/app")!, "utf8");
    assert.doesNotMatch(text, /Secret body/);
    const keys = new Set(Object.keys(statsRecordSchema.shape));
    for (const record of JSON.parse(text).records) {
      for (const key of Object.keys(record)) assert.ok(keys.has(key), `unexpected field ${key}`);
      assert.ok(record.t.length <= TITLE_MAX);
    }
    void now; now += 0;
  } finally { await rm(directory, { recursive: true, force: true }); }
});
