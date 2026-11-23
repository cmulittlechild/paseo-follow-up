import test from "node:test";
import assert from "node:assert/strict";
import { cellValue, columnMax, durationWords, medianCell, personLine, personWords, rangeWords, sortPeople, syncLine, teamFacts, type Person } from "../shared/pr-stats-page";
import { periodRange } from "../shared/pr-stats";
import type { PrStatsOutput } from "../shared/pr-stats-settings";

const sum = (n: number, median: number | null, p75: number | null = median) => ({ n, median, p75 });
const person = (login: string, o: Partial<Person> = {}): Person => ({ login, opened: 0, openedStacks: 0, merged: 0, wait: sum(0, null), reviews: 0, reviewStacks: 0, turnaround: sum(0, null), ...o });

test("stats page: durations in the page's words", () => {
  assert.equal(durationWords(45 * 60), "45m");
  assert.equal(durationWords(3 * 3600 + 10 * 60), "3h 10m");
  assert.equal(durationWords(5 * 3600), "5h");
  assert.equal(durationWords(26 * 3600), "1d 2h");
  assert.equal(durationWords(48 * 3600), "2d");
});

test("stats page: a median under 3 PRs is '-' with n on hover, never a value to draw", () => {
  const few = medianCell(sum(2, 3600));
  assert.equal(few.text, "-"); assert.equal(few.value, null); assert.match(few.hover, /^n = 2/);
  const ok = medianCell(sum(7, 3 * 3600 + 600, 6 * 3600 + 2400));
  assert.equal(ok.text, "3h 10m"); assert.equal(ok.value, 3 * 3600 + 600); assert.equal(ok.hover, "median 3h 10m · p75 6h 40m · n = 7");
});

test("stats page: every column sorts largest first, a '-' last, ties by login; opened is the default", () => {
  const people = [
    person("carol", { opened: 5, wait: sum(4, 21 * 3600), reviews: 3, turnaround: sum(3, 8 * 3600) }),
    person("alice", { opened: 9, merged: 7, wait: sum(7, 3 * 3600), reviews: 12, turnaround: sum(10, 4500) }),
    person("erin", { opened: 3, merged: 2, wait: sum(2, 99 * 3600), reviews: 4 }),
    person("bob", { opened: 5, merged: 5, wait: sum(5, 10 * 3600), reviews: 9 }),
  ];
  assert.deepEqual(sortPeople(people, "opened").map(p => p.login), ["alice", "bob", "carol", "erin"]);
  assert.deepEqual(sortPeople(people, "wait").map(p => p.login), ["carol", "bob", "alice", "erin"], "erin's 2 PRs are '-', last despite 99h");
  assert.deepEqual(sortPeople(people, "turnaround").map(p => p.login), ["carol", "alice", "bob", "erin"]);
  assert.equal(cellValue(people[2]!, "wait"), null);
  assert.deepEqual(columnMax(people), { opened: 9, merged: 7, wait: 21 * 3600, reviews: 12, turnaround: 8 * 3600 });
  assert.equal(personWords(people[2]!), "3 opened · 2 merged · waited - (n 2) · 4 reviews · turnaround - (n 0)");
  assert.equal(personLine(people[2]!, "opened"), "2\u00a0merged · 4\u00a0reviews", "a phone row drops the sorted column and the \"-\" medians");
});

test("stats page: This week's range starts on the zone's own first day", () => {
  // Sunday 2026-01-11 10:00 in Cairo (UTC+2): a Friday–Saturday weekend, so the week began this morning at 00:00.
  const now = Date.parse("2026-01-11T08:00:00Z") / 1000;
  const sunday = { period: "week", range: periodRange("week", now, "Africa/Cairo"), timeZone: "Africa/Cairo" } as const;
  assert.equal(rangeWords(sunday), "Sun, Jan 11 – now");
  const monday = { period: "week", range: periodRange("week", now, "Europe/Berlin"), timeZone: "Europe/Berlin" } as const;
  assert.equal(rangeWords(monday), "Mon, Jan 5 – now");
  const last = { period: "last-week", range: periodRange("last-week", now, "Africa/Cairo"), timeZone: "Africa/Cairo" } as const;
  assert.equal(rangeWords(last), "Sun, Jan 4 – Sat, Jan 10");
});

test("stats page: the sync line says so far while reading, why it waits, and a refusal in red", () => {
  const now = 1_800_000_000;
  const base = { records: 1240, coveredTo: Date.parse("2026-01-23T00:00:00Z") / 1000, backfillDone: false, coversPeriod: false, lastSyncAt: now - 120, waiting: null, error: null, cappedTo: null };
  const at = (sync: PrStatsOutput["sync"]) => syncLine({ sync, timeZone: "UTC" }, now);
  assert.deepEqual(at(base), { text: "Reading · back to Jan 23 · 1,240 PRs so far", tone: "muted", soFar: true });
  assert.equal(at({ ...base, waiting: { reason: "budget", until: null } })!.tone, "warning");
  assert.match(at({ ...base, waiting: { reason: "budget", until: null } })!.text, /GitHub limit low/);
  assert.equal(at({ ...base, waiting: { reason: "governor", until: null } })!.tone, "muted");
  const refused = at({ ...base, backfillDone: true, coversPeriod: true, error: { message: "not found or no access", status: 404, at: now } })!;
  assert.equal(refused.tone, "danger"); assert.equal(refused.text, "GitHub returned 404: not found or no access. Showing the last good read, from 2m ago.");
  assert.deepEqual(at({ ...base, backfillDone: true, coversPeriod: true }), { text: "Updated 2m ago", tone: "muted", soFar: false });
  // The period is read while older history still loads: said from the period's side, and not a warning.
  assert.deepEqual(at({ ...base, coversPeriod: true, waiting: { reason: "budget", until: null } })!.tone, "muted");
  assert.match(at({ ...base, coversPeriod: true })!.text, /^This period is read · still reading older PRs \(back to Jan 23\)/);
});

test("stats page: the team line names no one", () => {
  const facts = teamFacts({ team: { opened: 31, openedStacks: 24, merged: 24, wait: sum(20, 5 * 3600 + 2400), timeToMerge: sum(0, null), reviewToMerge: sum(0, null), waitingNow: 5, reviews: 52, mergedWithoutReview: 0, deletedUsers: 0, bots: 0, sizes: {} }, people: [], waiting: [], stale: 0 });
  assert.deepEqual(facts.map(f => `${f.value} ${f.label}`), ["31 opened in 24 stacks", "24 merged", "5h 40m median wait for a first review", "52 reviews given"]);
});
