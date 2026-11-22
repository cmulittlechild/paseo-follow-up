import test from "node:test";
import assert from "node:assert/strict";
import { derive, firstResponse, ignored, MIN_N, nearestRank, periodRange, personDetail, previousRange, sizeBucket, stackParents, statsModel, summarize, workingSeconds, zonedTime, type StatsOptions } from "../shared/pr-stats";
import { parseStatsRecord, type StatsRecord } from "../shared/pr-stats-records";
import { FakeStatsGithub, PEOPLE } from "./support/fake-stats-github";
import { clock } from "./fixtures";

/** Hours from a fixed Monday 09:00 UTC, in epoch seconds. */
const H0 = Date.parse("2026-01-05T09:00:00Z") / 1000;
const h = (hours: number) => H0 + Math.round(hours * 3600);
const rec = (o: Partial<StatsRecord> & { n: number }): StatsRecord => ({
  a: "alice", t: `PR ${o.n}`, c: h(0), u: h(1), r: o.r === undefined ? (o.c ?? h(0)) : o.r, k: o.k === undefined ? (o.c ?? h(0)) : o.k, m: null, x: null, s: "O", d: false,
  add: 10, del: 5, f: 1, b: "main", h: `branch-${o.n}`, rq: [], rv: [], fc: [], ...o,
});
const UTC: StatsOptions = { timeZone: "UTC", defaultBranch: "main" };
const all: { start: number; end: number } = { start: 0, end: h(1000) };

test("stats metrics: nearest-rank median and p75, with n", () => {
  assert.equal(nearestRank([1, 2, 3, 4], 0.5), 2);
  assert.equal(nearestRank([1, 2, 3, 4], 0.75), 3);
  assert.equal(nearestRank([5], 0.75), 5);
  assert.equal(nearestRank([], 0.5), null);
  assert.deepEqual(summarize([30, 10, 20]), { n: 3, median: 20, p75: 30 });
  assert.equal(MIN_N, 3);
  assert.deepEqual([9, 10, 49, 50, 249, 250, 999, 1000].map(sizeBucket), ["XS", "S", "S", "M", "M", "L", "L", "XL"]);
});

test("stats metrics: periods in a time zone (This week from Monday 00:00 local, Last week, 30 and 90 days)", () => {
  // Wednesday 2026-01-07 10:00 in Berlin (UTC+1).
  const now = Date.parse("2026-01-07T09:00:00Z") / 1000;
  const week = periodRange("week", now, "Europe/Berlin");
  assert.equal(new Date(week.start * 1000).toISOString(), "2026-01-04T23:00:00.000Z");
  assert.equal(week.end, now);
  const last = periodRange("last-week", now, "Europe/Berlin");
  assert.equal(new Date(last.start * 1000).toISOString(), "2025-12-28T23:00:00.000Z");
  assert.equal(last.end, week.start);
  assert.equal(periodRange("30d", now, "Europe/Berlin").start, now - 30 * 86_400);
  assert.equal(new Date(periodRange("week", now, "Europe/Berlin", 0).start * 1000).toISOString(), "2026-01-03T23:00:00.000Z", "a Sunday week start");
  assert.deepEqual(previousRange({ start: 100, end: 160 }), { start: 40, end: 100 });
  // Across the spring DST change: Monday 2026-03-30 00:00 is UTC+2.
  assert.equal(new Date(periodRange("week", Date.parse("2026-03-31T12:00:00Z") / 1000, "Europe/Berlin").start * 1000).toISOString(), "2026-03-29T22:00:00.000Z");
});

test("stats metrics: working hours are the overlap with the schedule, across a weekend and a DST change", () => {
  const hours = { days: [1, 2, 3, 4, 5], from: 9 * 60, to: 18 * 60 };
  // Friday 17:00 to Monday 10:00 Berlin: one hour Friday, one Monday.
  const fri = zonedTime(2026, 1, 9, 17 * 60, "Europe/Berlin"), mon = zonedTime(2026, 1, 12, 10 * 60, "Europe/Berlin");
  assert.equal(workingSeconds(fri, mon, hours, "Europe/Berlin"), 2 * 3600);
  // The same across the spring change (2026-03-29): still two hours.
  assert.equal(workingSeconds(zonedTime(2026, 3, 27, 17 * 60, "Europe/Berlin"), zonedTime(2026, 3, 30, 10 * 60, "Europe/Berlin"), hours, "Europe/Berlin"), 2 * 3600);
  // A whole DST Sunday on an all-day schedule is 23 hours, a fall-back Sunday 25.
  const allDay = { days: [0], from: 0, to: 24 * 60 };
  assert.equal(workingSeconds(zonedTime(2026, 3, 29, 0, "Europe/Berlin"), zonedTime(2026, 3, 30, 0, "Europe/Berlin"), allDay, "Europe/Berlin"), 23 * 3600);
  assert.equal(workingSeconds(zonedTime(2026, 10, 25, 0, "Europe/Berlin"), zonedTime(2026, 10, 26, 0, "Europe/Berlin"), allDay, "Europe/Berlin"), 25 * 3600);
  assert.equal(workingSeconds(h(5), h(1), hours, "UTC"), 0);
  // A working-hours model measures in working seconds.
  const model = statsModel([rec({ n: 1, c: fri, r: fri, k: fri, rv: [["bob", "A", mon]] })], all, mon, { timeZone: "Europe/Berlin", clock: "working", hours });
  assert.equal(model.team.wait.median, 2 * 3600);
});

test("stats metrics: drafts count as opened; bots, the ignore list and deleted users never make a row", () => {
  const records = [
    rec({ n: 1, d: true, r: null, k: null }),
    rec({ n: 2, a: "renovate[bot]", ab: 1 }),
    rec({ n: 3, a: "deploy-robot" }),
    rec({ n: 4, a: null }),
    rec({ n: 5, a: "bob", rv: [["deploy-robot", "A", h(2)], ["alice", "A", h(3)]] }),
  ];
  const model = statsModel(records, all, h(10), { ...UTC, ignore: ["deploy-*"] });
  assert.equal(model.team.opened, 3, "alice's draft, bob's PR and the deleted user's");
  assert.equal(model.team.bots, 1);
  assert.equal(model.team.deletedUsers, 1);
  assert.deepEqual(model.people.map(p => p.login).sort(), ["alice", "bob"]);
  assert.equal(firstResponse(records[4]!, ["deploy-*"])!.by, "alice", "an ignored reviewer isn't the first response");
  assert.ok(ignored("Deploy-Robot", ["deploy-*"]) && !ignored("deployer", ["deploy-robot"]));
  // A team filter keeps only its people.
  assert.deepEqual(statsModel(records, all, h(10), { ...UTC, team: ["Bob"] }).people.map(p => p.login), ["bob"]);
});

test("stats-measure-from-the-ask: the review clock starts at the ask, never at creation", () => {
  // Opened as a draft at 0, ready at 10, asked at 12, reviewed at 15: waited 3 h.
  const pr = rec({ n: 1, c: h(0), r: h(10), k: h(12), rq: [["bob", h(12)]], rv: [["bob", "C", h(15)]] });
  const model = statsModel([pr], all, h(20), UTC);
  assert.equal(model.team.wait.median, 3 * 3600);
  assert.equal(model.people[0]!.wait.n, 1);
  // A comment before ready isn't a response; the PR waits from the ask.
  const early = rec({ n: 2, c: h(0), r: h(10), k: h(10), fc: [] });
  const waiting = statsModel([early], all, h(14), UTC).waiting;
  assert.deepEqual(waiting.map(w => [w.number, w.wait]), [[2, 4 * 3600]]);
  // The author's own comment-review is never a response.
  assert.equal(firstResponse(rec({ n: 3, rv: [["alice", "M", h(1)]] })), null);
});

test("stats-measure-from-the-ask: a stacked PR's clock starts when its parent was reached (stack-aware), else at its ask", () => {
  const parent = rec({ n: 1, h: "alice/one", k: h(0), rv: [["bob", "A", h(5)]] });
  const child = rec({ n: 2, b: "alice/one", h: "alice/two", c: h(0.1), k: h(1), rv: [["bob", "A", h(6)]] });
  assert.equal(stackParents([parent, child], "main").get(2)?.n, 1);
  const child2 = statsModel([child, parent], all, h(10), UTC);
  assert.deepEqual(child2.team.wait, { n: 2, median: 3600, p75: 5 * 3600 });
  const off = statsModel([parent, child], all, h(10), { ...UTC, stackAware: false });
  assert.deepEqual(off.team.wait, { n: 2, median: 5 * 3600, p75: 5 * 3600 }, "off: the child waited from its own ask");
  assert.equal(off.team.openedStacks, 1, "two PRs, one stack");
  assert.equal(off.people[0]!.openedStacks, 1);
  // A parent based on a release branch with no parent PR isn't stacked.
  assert.equal(stackParents([rec({ n: 9, b: "release-1" })], "main").size, 0);
});

test("stats metrics: waiting now folds a stack's upper PRs under the PR they wait behind, and old ones under Stale", () => {
  const base = rec({ n: 10, h: "s/1", k: h(0), u: h(0) });
  const up1 = rec({ n: 11, b: "s/1", h: "s/2", c: h(0.1), k: h(0.2), u: h(0) });
  const up2 = rec({ n: 12, b: "s/2", h: "s/3", c: h(0.2), k: h(0.3), u: h(0) });
  const other = rec({ n: 20, a: "bob", k: h(2), u: h(2), rq: [["carol", h(2)], ["@backend", h(2)], ["dan", h(1)]], rr: [["dan", h(1.5)]] });
  const stale = rec({ n: 30, a: "bob", k: h(-800), u: h(-800) });
  const model = statsModel([base, up1, up2, other, stale], all, h(5), UTC);
  assert.deepEqual(model.waiting.map(w => [w.number, w.above]), [[10, 2], [20, 0]]);
  assert.deepEqual(model.waiting[1]!.requested.sort(), ["@backend", "carol"], "a removed request isn't who it waits on");
  assert.equal(model.stale, 1);
  assert.equal(model.team.waitingNow, 2);
});

test("stats metrics: reviews given count distinct PRs; turnaround runs from a request naming the person to their next review", () => {
  const records = [
    rec({ n: 1, rq: [["bob", h(1)], ["@backend", h(1)]], rv: [["bob", "M", h(3), h(4), h(5)]] }),
    rec({ n: 2, rq: [["bob", h(2)]], rv: [["bob", "A", h(2.5)]] }),
    rec({ n: 3, rq: [["carol", h(1)]], rr: [["carol", h(2)]], rv: [["carol", "A", h(6)]] }),
    rec({ n: 4, a: "bob", rv: [["bob", "M", h(1)]] }),
  ];
  const model = statsModel(records, all, h(10), UTC);
  const bob = model.people.find(p => p.login === "bob")!;
  assert.equal(bob.reviews, 2, "PR 1 once, PR 2; never his own PR 4");
  assert.deepEqual(bob.turnaround, { n: 2, median: 1800, p75: 2 * 3600 });
  const carol = model.people.find(p => p.login === "carol")!;
  assert.equal(carol.turnaround.n, 0, "a request removed before the review isn't counted");
  assert.equal(carol.reviews, 1);
  assert.equal(model.team.reviews, 3);
});

test("stats metrics: merged, time to merge (stack-aware), first review to merge, merged without review", () => {
  const parent = rec({ n: 1, h: "p", k: h(0), s: "M", m: h(10), rv: [["bob", "A", h(4)]] });
  const child = rec({ n: 2, b: "p", h: "c", c: h(0.5), k: h(1), s: "M", m: h(12) });
  const model = statsModel([parent, child], all, h(20), UTC);
  assert.equal(model.team.merged, 2);
  assert.deepEqual(model.team.timeToMerge, { n: 2, median: 2 * 3600, p75: 10 * 3600 }, "the child from its parent's merge");
  assert.deepEqual(model.team.reviewToMerge, { n: 1, median: 6 * 3600, p75: 6 * 3600 });
  assert.equal(model.team.mergedWithoutReview, 1);
});

test("stats metrics: the period decides what counts (created, merged, first response in it)", () => {
  const pr = rec({ n: 1, c: h(0), k: h(0), s: "M", m: h(30), rv: [["bob", "A", h(28)]] });
  const early = statsModel([pr], { start: h(-1), end: h(10) }, h(40), UTC);
  assert.equal(early.team.opened, 1); assert.equal(early.team.merged, 0); assert.equal(early.team.wait.n, 0);
  const late = statsModel([pr], { start: h(20), end: h(40) }, h(40), UTC);
  assert.equal(late.team.opened, 0); assert.equal(late.team.merged, 1); assert.equal(late.team.wait.n, 1);
});

test("stats metrics: a person's drill-down lists their PRs with waits and the reviews they gave", () => {
  const records = [
    rec({ n: 1, k: h(0), rv: [["bob", "A", h(2)]] }),
    rec({ n: 2, k: h(3) }),
    rec({ n: 3, a: "bob", k: h(0), rv: [["alice", "C", h(4)]] }),
  ];
  const detail = personDetail(records, "alice", all, h(5), UTC);
  assert.deepEqual(detail.prs.map(p => [p.number, p.wait, p.waiting]).sort(), [[1, 2 * 3600, false], [2, 2 * 3600, true]]);
  assert.deepEqual(detail.reviewed.map(r => r.number), [3]);
  assert.equal(detail.row?.opened, 2);
});

test("stats metrics: the fixture's 300 PRs give people from the data only, and 10,000 records compute in well under a second", () => {
  const fake = new FakeStatsGithub(() => clock);
  const records = fake.prs.map(p => parseStatsRecord({ ...p, reviews: { totalCount: p._reviews.length, nodes: p._reviews }, comments: { totalCount: p._comments.length, nodes: p._comments }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: p._timeline } }));
  const now = Math.floor(clock / 1000);
  const model = statsModel(records, periodRange("90d", now, "UTC"), now, { ...UTC, ignore: ["deploy-robot"] });
  const logins = new Set(model.people.map(p => p.login));
  for (const login of logins) assert.ok(PEOPLE.includes(login) || /^reviewer\d+$/.test(login), login);
  assert.ok(model.people.length >= 6 && model.team.opened > 0 && model.team.wait.n > 0);
  assert.ok(derive(records, UTC).size === 300);
  const many: StatsRecord[] = [];
  for (let i = 0; i < 34; i++) for (const r of records) many.push({ ...r, n: r.n + i * 1000, h: `${r.h}-${i}`, b: r.b === "main" ? "main" : `${r.b}-${i}` });
  const started = performance.now();
  statsModel(many, periodRange("90d", now, "UTC"), now, UTC);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${many.length} records took ${Math.round(ms)} ms`);
});
