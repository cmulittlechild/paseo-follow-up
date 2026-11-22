import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { FLAG, isBotActor, parseStatsRecord, readyAtOf, REVIEW_TIMES_MAX, withAllReviews } from "../shared/pr-stats-records";
import { encodeStats, freshMeta, statsPath, StatsStore } from "../server/pr-stats-store";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

const T = (h: number) => new Date(Date.parse("2026-01-05T09:00:00Z") + h * 3_600_000).toISOString();
const S = (h: number) => Math.floor((Date.parse("2026-01-05T09:00:00Z") + h * 3_600_000) / 1000);
const user = (login: string) => ({ login, __typename: "User" });
const node = (o: Record<string, unknown> = {}) => ({
  number: 7, title: "Add retry budget", createdAt: T(0), updatedAt: T(10), closedAt: null, mergedAt: null, state: "OPEN", isDraft: false,
  additions: 10, deletions: 2, changedFiles: 1, author: user("alice"), baseRefName: "main", headRefName: "alice/retry",
  reviews: { totalCount: 0, nodes: [] }, comments: { totalCount: 0, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, ...o,
});
const ev = (type: string, h: number, extra: Record<string, unknown> = {}) => ({ __typename: type, createdAt: T(h), ...extra });

test("stats records: readyAt is the first ready event, else createdAt, and null for a draft that never was ready", () => {
  assert.equal(readyAtOf(100, false, []), 100, "opened ready");
  assert.equal(readyAtOf(100, false, [{ type: "ready", at: 150 }]), 150, "opened as a draft, then ready");
  assert.equal(readyAtOf(100, true, [{ type: "draft", at: 120 }, { type: "ready", at: 150 }]), 100, "opened ready, back to draft: ready since creation");
  assert.equal(readyAtOf(100, true, []), null, "a draft that never was ready");
  assert.equal(readyAtOf(100, false, [{ type: "ready", at: 200 }, { type: "draft", at: 160 }]), 100, "order is by time, not by list position");
});

test("stats records: askedAt is the first request at or after readyAt; a request while a draft counts from readyAt", () => {
  const asked = (events: unknown[], draft = false) => parseStatsRecord(node({ isDraft: draft, timelineItems: { pageInfo: { hasNextPage: false }, nodes: events } })).k;
  assert.equal(asked([]), S(0), "no request at all: being ready is the ask");
  assert.equal(asked([ev("ReviewRequestedEvent", 3, { requestedReviewer: user("bob") })]), S(3));
  assert.equal(asked([ev("ReadyForReviewEvent", 5), ev("ReviewRequestedEvent", 1, { requestedReviewer: user("bob") }), ev("ReviewRequestedEvent", 8, { requestedReviewer: user("carol") })]), S(5), "a request made while a draft starts the clock at ready");
  assert.equal(asked([ev("ReviewRequestedEvent", 1, { requestedReviewer: user("bob") })], true), null, "still a draft: no ask");
  const record = parseStatsRecord(node({ timelineItems: { pageInfo: { hasNextPage: true }, nodes: [ev("ReviewRequestedEvent", 2, { requestedReviewer: { __typename: "Team", slug: "backend" } }), ev("ReviewRequestRemovedEvent", 4, { requestedReviewer: user("bob") }), ev("ReviewRequestedEvent", 1, { requestedReviewer: { login: "helper", __typename: "Bot" } })] } }));
  assert.deepEqual(record.rq, [["@backend", S(2)]], "teams as @slug, bots never");
  assert.deepEqual(record.rr, [["bob", S(4)]]);
  assert.equal(record.fl, FLAG.timelineTruncated);
});

test("stats records: reviews and comments by the author or a bot never count; a ghost author is null", () => {
  const record = parseStatsRecord(node({
    reviews: { totalCount: 5, nodes: [
      { author: user("alice"), state: "COMMENTED", submittedAt: T(1) },
      { author: { login: "dependabot", __typename: "Bot" }, state: "APPROVED", submittedAt: T(1) },
      { author: user("bob"), state: "COMMENTED", submittedAt: T(3) },
      { author: user("bob"), state: "APPROVED", submittedAt: T(6) },
      { author: user("carol"), state: "PENDING", submittedAt: null },
    ] },
    comments: { totalCount: 3, nodes: [{ createdAt: T(0.5), author: { login: "ci[bot]", __typename: "User" } }, { createdAt: T(1), author: user("alice") }, { createdAt: T(2), author: user("dan") }] },
  }));
  assert.deepEqual(record.rv, [["bob", "M", S(3), S(6)]]);
  assert.deepEqual(record.fc, [["dan", S(2)]]);
  assert.equal(record.ab, undefined);
  assert.equal(parseStatsRecord(node({ author: null })).a, null);
  assert.equal(parseStatsRecord(node({ author: { login: "renovate[bot]", __typename: "Bot" } })).ab, 1);
  assert.ok(isBotActor({ login: "x[bot]", __typename: "User" }));
  assert.ok(!isBotActor({ login: "deploy-robot", __typename: "User" }), "a human-looking account is the ignore list's job");
});

test("stats records: comments before readyAt don't count, and a page of only the author's comments says so", () => {
  const early = parseStatsRecord(node({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [ev("ReadyForReviewEvent", 5)] }, comments: { totalCount: 1, nodes: [{ createdAt: T(2), author: user("bob") }] } }));
  assert.deepEqual(early.fc, []);
  const own = parseStatsRecord(node({ comments: { totalCount: 30, nodes: Array.from({ length: 10 }, (_, i) => ({ createdAt: T(i), author: user("alice") })) } }));
  assert.equal(own.fl, FLAG.commentsTruncated);
});

test("stats records: the review follow-up merges every review and clears the flag; times per reviewer are capped", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ author: user(i < 15 ? "bob" : `r${i}`), state: "COMMENTED", submittedAt: T(i + 1) }));
  const first = parseStatsRecord(node({ reviews: { totalCount: 25, nodes: many.slice(0, 20) } }));
  assert.equal(first.fl, FLAG.reviewsTruncated);
  const full = withAllReviews(first, many);
  assert.equal(full.fl, undefined);
  assert.equal(full.rv.length, 11, "bob plus ten others");
  assert.equal(full.rv[0]!.length - 2, REVIEW_TIMES_MAX, "bob's times capped");
});

test("stats store: a written file reads back the same, byte for byte JSON.stringify", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-store-"));
  try {
    const store = trackPersistence(directory, new StatsStore(directory, { now: () => clock, log: () => undefined }));
    const stats = await store.open("example/app");
    store.merge(stats, [parseStatsRecord(node()), parseStatsRecord(node({ number: 8 }))]);
    store.save(stats);
    await store.flush();
    const text = await readFile(statsPath(directory, "example/app")!, "utf8");
    assert.equal(text, JSON.stringify({ v: 1, meta: stats.meta, records: [...stats.records.values()] }));
    assert.equal(Buffer.concat(encodeStats(stats)).toString(), text);
    store.close();
    const again = trackPersistence(directory, new StatsStore(directory, { now: () => clock, log: () => undefined }));
    assert.deepEqual([...(await again.open("example/app")).records.keys()], [7, 8]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stats store: an unchanged record keeps its object; a bad name never becomes a path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-store-"));
  try {
    const store = trackPersistence(directory, new StatsStore(directory, { now: () => clock, log: () => undefined }));
    const stats = await store.open("example/app");
    store.merge(stats, [parseStatsRecord(node())]);
    const kept = stats.records.get(7);
    assert.equal(store.merge(stats, [parseStatsRecord(node())]), 0);
    assert.equal(stats.records.get(7), kept);
    assert.equal(statsPath(directory, "../etc"), null);
    assert.equal(statsPath(directory, "example/.."), null);
    await assert.rejects(store.open("a/b/c"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stats-are-computed-on-read: records load for a read, at most two repositories stay loaded, and each drops after its keep time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-lru-"));
  try {
    for (const repo of ["example/a", "example/b", "example/c"]) {
      const path = statsPath(directory, repo)!;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ v: 1, meta: freshMeta(repo), records: [parseStatsRecord(node())] }));
    }
    const store = trackPersistence(directory, new StatsStore(directory, { now: () => clock, keepMs: 30, log: () => undefined }));
    assert.deepEqual(store.inMemory(), [], "nothing is loaded before a read");
    await store.open("example/a"); await store.open("example/b"); await store.open("example/a");
    assert.equal(store.loads, 2, "a repeated read doesn't load again");
    await store.open("example/c");
    assert.equal(store.inMemory().length, 2, "an LRU of two");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(store.inMemory(), [], "dropped after the keep time");
    // An unreadable file is an empty store, never an error.
    await writeFile(statsPath(directory, "example/a")!, "{not json");
    assert.equal((await store.open("example/a")).records.size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
