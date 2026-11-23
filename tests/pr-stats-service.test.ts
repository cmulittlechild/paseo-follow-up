import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrStats, SYNC_IDLE_MS, SYNC_VIEWING_MS } from "../server/pr-stats";
import { statsPath } from "../server/pr-stats-store";
import { statsRepoLine, statsRepoWait, statsRepoWaitTone } from "../shared/pr-stats-settings";
import type { Budget } from "../shared/poll";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { clock } from "./fixtures";

/** The service over the fake repository: search and team queries answered beside the fake's pages. */
async function service(o: { teamReadable?: boolean; zone?: string; at?: number } = {}) {
  let now = o.at ?? clock;
  let zone = o.zone ?? "Europe/Berlin";
  const directory = await mkdtemp(join(tmpdir(), "fu-stats-svc-"));
  const fake = new FakeStatsGithub(() => now);
  const calls: string[] = [];
  const api = { graphql: async (repo: string, query: string, vars: Record<string, string>) => {
    if (query.includes("search(")) { calls.push("search"); return { data: { rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(now + 3_600_000).toISOString(), limit: 5000 }, repository: repo === fake.repo ? { id: "R1" } : null, search: { issueCount: repo === fake.repo ? fake.inWindow(90).length : 0 } } }; }
    if (query.includes("organization(")) { calls.push("team"); return { data: { rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(now + 3_600_000).toISOString(), limit: 5000 }, organization: o.teamReadable ? { team: { members: { nodes: [{ login: "alice" }, { login: "bob" }] } } } : null } }; }
    calls.push("page");
    return fake.graphql(repo, query, vars);
  }, rest: fake.rest.bind(fake) };
  const budgets = new Map<string, Budget>();
  const stats = trackPersistence(directory, new PrStats({ directory, api, clientTimeZone: () => zone, now: () => now, log: () => undefined,
    gate: { budget: owner => budgets.get(owner), noteRateLimit: (owner, r) => budgets.set(owner, { remaining: r.remaining!, resetAt: Date.parse(r.resetAt!), limit: r.limit }), noteLimited: () => undefined, allowsBackground: () => true } }));
  const idle = async () => { stats.tick(); for (let i = 0; i < 200 && (stats as unknown as { running: unknown }).running; i++) await new Promise(r => setTimeout(r, 2)); };
  return { directory, fake, stats, calls, idle, advance: (ms: number) => { now += ms; }, now: () => now, setZone: (z: string) => { zone = z; } };
}

test("pr stats: nothing is on, read or loaded in an empty install", async () => {
  const s = await service();
  try {
    const view = await s.stats.view(["example/app"]);
    assert.deepEqual(view.repos.map(r => [r.repo, r.state]), [["example/app", "off"]]);
    assert.equal(view.timeZone, "Europe/Berlin", "the developer's device zone");
    await s.idle();
    assert.deepEqual(s.calls, [], "no repository on: no GitHub read");
    const out = await s.stats.read({});
    assert.equal(out.model, null);
    assert.match(out.empty!, /aren't on for any repository/);
    assert.deepEqual(s.stats.store.inMemory(), []);
    assert.equal(existsSync(join(s.directory, "stats.json")), false);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("pr stats: the estimate counts the repository's PRs for 1 point, and refuses one the token can't read", async () => {
  const s = await service();
  try {
    const e = await s.stats.estimate("example/app");
    assert.equal(e.prs, s.fake.inWindow(90).length);
    assert.equal(e.points, Math.ceil(e.prs! / 25) + Math.ceil(e.prs! / 250));
    assert.equal(e.slicePoints, 250);
    assert.equal(e.error, null);
    const refused = await s.stats.estimate("example/private");
    assert.equal(refused.prs, null);
    assert.match(refused.error!, /Can't read example\/private/);
    assert.deepEqual(s.calls, ["search", "search"]);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("pr stats: turning a repository on syncs it on the loop's tick, hourly after the backfill, every 5 minutes while viewed", async () => {
  const s = await service();
  try {
    await s.stats.set({ repo: "example/app", enable: true });
    await s.idle();
    let view = await s.stats.view([]);
    const row = view.repos[0]!;
    assert.equal(row.state, "on");
    assert.equal(row.settings!.status!.records, s.fake.inWindow(90).length);
    assert.equal(row.settings!.status!.backfillDone, true);
    assert.match(statsRepoLine(row, "UTC"), /^On · \d[\d,]* PRs · \d+ KB$/);
    s.calls.length = 0;
    s.advance(SYNC_VIEWING_MS);
    await s.idle();
    assert.deepEqual(s.calls, [], "not due yet: synced less than an hour ago and nobody is looking");
    const release = s.stats.watching("example/app");
    await s.idle();
    assert.deepEqual(s.calls, ["page"], "the page on screen: one incremental page");
    release();
    s.calls.length = 0; s.advance(SYNC_VIEWING_MS); await s.idle();
    assert.deepEqual(s.calls, []);
    s.advance(SYNC_IDLE_MS); await s.idle();
    assert.deepEqual(s.calls, ["page"], "an hour later, one page");
    // The model reads the records for this read only, with each PR's link.
    const out = await s.stats.read({ repo: "example/app", period: "90d" });
    assert.ok(out.model!.people.length > 0);
    assert.ok(out.model!.waiting.every(w => w.url === `https://github.com/example/app/pull/${w.number}`));
    assert.equal(out.sync!.coversPeriod, true);
    view = await s.stats.view([]);
    assert.ok(view.settings.repos["example/app"]!.enabledAt);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("pr stats: turning off keeps the data by default (paused, readable, not read); delete removes it at once", async () => {
  const s = await service();
  try {
    await s.stats.set({ repo: "example/app", enable: true });
    await s.idle();
    await s.stats.set({ repo: "example/app", enable: false });
    const paused = (await s.stats.view([])).repos[0]!;
    assert.equal(paused.state, "paused");
    assert.match(statsRepoLine(paused, "UTC"), /^Paused · data up to /);
    s.calls.length = 0; s.advance(2 * SYNC_IDLE_MS); await s.idle();
    assert.deepEqual(s.calls, [], "a paused repository isn't read");
    assert.ok((await s.stats.read({ repo: "example/app", period: "90d" })).model!.team.opened > 0, "still readable");
    await assert.rejects(s.stats.set({ repo: "example/app", delete: true }), /Delete only with enable: false/);
    await s.stats.store.flush();
    assert.ok(existsSync(statsPath(s.directory, "example/app")!));
    await s.stats.set({ repo: "example/app", enable: false, delete: true });
    assert.equal(existsSync(statsPath(s.directory, "example/app")!), false);
    const view = await s.stats.view(["example/app"]);
    assert.equal(view.repos[0]!.state, "off");
    assert.match((await s.stats.read({ repo: "example/app" })).empty!, /aren't on for example\/app/);
    await s.stats.flush();
    assert.deepEqual(JSON.parse(await readFile(join(s.directory, "stats.json"), "utf8")).repos, {});
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("stats-learn-the-team-from-the-data: an unreadable GitHub team shows everyone and says so; a readable one filters", async () => {
  for (const readable of [false, true]) {
    const s = await service({ teamReadable: readable });
    try {
      await s.stats.set({ repo: "example/app", enable: true });
      await s.stats.set({ repo: "example/app", team: { kind: "github", team: "example/backend" }, ignore: ["Deploy-*"] });
      await s.idle();
      const out = await s.stats.read({ repo: "example/app", period: "90d" });
      const logins = out.model!.people.map(p => p.login);
      assert.ok(!logins.includes("deploy-robot"), "the ignore list, case-insensitive with a wildcard");
      if (readable) { assert.equal(out.teamNotice, null); assert.ok(logins.every(l => ["alice", "bob"].includes(l))); }
      else { assert.match(out.teamNotice!, /Can't read the team @example\/backend.*shows everyone/); assert.ok(logins.length > 2); }
      assert.equal(s.calls.filter(c => c === "team").length, 1, "read once");
      s.advance(SYNC_IDLE_MS); await s.idle();
      assert.equal(s.calls.filter(c => c === "team").length, 1, "not again within a day");
    } finally { await rm(s.directory, { recursive: true, force: true }); }
  }
});

test("stats-learn-the-team-from-the-data: the week is the zone's usual one unless saved, and the default is never written", async () => {
  // Sunday 2026-01-11 10:00 in Jerusalem (UTC+2).
  const s = await service({ zone: "Asia/Jerusalem", at: Date.parse("2026-01-11T08:00:00Z") });
  try {
    let view = await s.stats.view([]);
    assert.deepEqual(view.hours, { days: [0, 1, 2, 3, 4], from: 9 * 60, to: 18 * 60 }, "a Friday–Saturday weekend: Sun–Thu");
    assert.equal(view.weekStart, 0);
    let read = await s.stats.read({ period: "week" });
    assert.equal(new Date(read.range.start * 1000).toISOString(), "2026-01-10T22:00:00.000Z", "This week starts this Sunday, not last Monday");
    assert.deepEqual(read.hours.days, [0, 1, 2, 3, 4]);
    // Another setting writes stats.json; the zone's week stays unsaved.
    await s.stats.set({ slice: 0.02 });
    await s.stats.flush();
    const file = JSON.parse(await readFile(join(s.directory, "stats.json"), "utf8")) as { hours: unknown; weekStart: unknown };
    assert.equal(file.hours, null);
    assert.equal(file.weekStart, null);
    // So a new zone moves it.
    s.setZone("Europe/Berlin");
    view = await s.stats.view([]);
    assert.deepEqual(view.hours.days, [1, 2, 3, 4, 5]);
    assert.equal(view.weekStart, 1);
    // A saved schedule and week start win over the zone.
    s.setZone("Asia/Jerusalem");
    await s.stats.set({ hours: { days: [1, 2, 3, 4, 5], from: 8 * 60, to: 17 * 60 }, weekStart: 1 });
    view = await s.stats.view([]);
    assert.deepEqual(view.hours, { days: [1, 2, 3, 4, 5], from: 8 * 60, to: 17 * 60 });
    assert.equal(view.weekStart, 1);
    read = await s.stats.read({ period: "week" });
    assert.equal(new Date(read.range.start * 1000).toISOString(), "2026-01-04T22:00:00.000Z", "the saved Monday start");
    // null goes back to the zone's week.
    await s.stats.set({ hours: null, weekStart: null });
    assert.equal((await s.stats.view([])).weekStart, 0);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("pr stats: the page's feed and Home's icon: a run's end and a settings write announce the repository; the status comes from stats.json", async () => {
  const s = await service();
  try {
    const changed: (string | null)[] = [];
    s.stats.onChange = repo => changed.push(repo);
    assert.equal(await s.stats.anyOn(), false, "nothing on: Home shows no PR stats icon");
    await s.stats.set({ repo: "example/app", enable: true });
    assert.deepEqual(changed, ["example/app"]);
    assert.equal(await s.stats.anyOn(), true);
    await s.idle();
    assert.ok(changed.filter(r => r === "example/app").length >= 2, "the first run's end pushes the page");
    const state = await s.stats.feedState("example/app");
    assert.equal(state.state, "on"); assert.equal(state.records, s.fake.inWindow(90).length); assert.ok(state.lastSyncAt);
    await s.stats.set({ slice: 0.02 });
    assert.equal(changed.at(-1), null, "a host-wide setting pushes every open page");
    await s.stats.set({ repo: "example/app", enable: false });
    assert.equal((await s.stats.feedState("example/app")).state, "paused");
    assert.equal(await s.stats.anyOn(), true, "paused still has data to show");
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("pr stats: Settings' lines say why a repository isn't reading", () => {
  const base = { repo: "example/app", state: "on" as const, settings: { enable_stats: true, windowDays: 90 as const, team: { kind: "everyone" as const }, ignore: [], enabledAt: 1, estimate: { prs: 3250, points: 143, at: 1 },
    status: { records: 1240, coveredTo: Date.parse("2026-10-03T12:00:00Z") / 1000, backfillDone: false, lastSyncAt: 2, lastCost: 20, waiting: null, error: null, cappedTo: null } } };
  assert.equal(statsRepoLine(base, "UTC"), "On · reading · back to Oct 3 · ≈ 1,240 of 3,250 PRs · 397 KB");
  assert.equal(statsRepoWait(base), null);
  assert.equal(statsRepoWaitTone(base), null);
  assert.equal(statsRepoLine({ ...base, settings: { ...base.settings, status: { ...base.settings.status, error: { message: "x", status: 404, at: 1 } } } }, "UTC"), "On · stopped · 1,240 PRs kept");
  assert.equal(statsRepoWaitTone({ ...base, settings: { ...base.settings, status: { ...base.settings.status, error: { message: "x", status: 404, at: 1 } } } }), "danger");
  assert.equal(statsRepoWaitTone({ ...base, settings: { ...base.settings, status: { ...base.settings.status, waiting: { reason: "slice", until: null } } } }), "warning");
  assert.match(statsRepoWait({ ...base, settings: { ...base.settings, status: { ...base.settings.status, waiting: { reason: "budget", until: 1_800_000_000 } } } })!, /^GitHub limit low · updates again at \d\d:\d\d\.$/);
  assert.equal(statsRepoWait({ ...base, settings: { ...base.settings, status: { ...base.settings.status, error: { message: "not found or no access", status: 404, at: 1 } } } }), "GitHub returned 404: not found or no access.");
  assert.equal(statsRepoLine({ repo: "x/y", state: "off", settings: null }, "UTC"), "Off");
});
