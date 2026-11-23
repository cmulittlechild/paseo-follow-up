import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../server/engine";
import { Github } from "../server/github";
import type { GithubApi } from "../server/github-api";
import { PrStats } from "../server/pr-stats";
import { DEVELOPER_SLOT_WAIT_MS, StatsGate } from "../server/pr-stats-gate";
import { StatsStore } from "../server/pr-stats-store";
import { StatsSync } from "../server/pr-stats-sync";
import { Store } from "../server/store";
import { estimateBlocked, type StatsEstimate } from "../shared/pr-stats-settings";
import type { Budget } from "../shared/poll";
import { FakeStatsGithub } from "./support/fake-stats-github";
import { rm, testStore, trackPersistence } from "./support/store-temp-dir";
import { clock, workspace } from "./fixtures";

/**
 * Invariant 106, `a-read-the-developer-starts-never-waits-on-the-governor` (AGENTS.md). The governor holds background
 * work while the machine is busy; a read the developer starts (the PR stats turn-on estimate, the page's Refresh, an
 * agent's `pr_stats fresh`, a workspace's Refresh) is not background work and still goes. GitHub's budget and stats'
 * share still bind it. 2026-11-23: the turn-on sheet showed only "Paused while this machine is busy" with Turn on off.
 */

async function statsService(o: { allows?: boolean; remaining?: number } = {}) {
  let now = clock;
  let allows = o.allows ?? false;
  const directory = await mkdtemp(join(tmpdir(), "fu-dev-reads-"));
  const fake = new FakeStatsGithub(() => now);
  const calls: string[] = [];
  const api = { graphql: async (repo: string, query: string, vars: Record<string, string>) => {
    if (query.includes("search(")) { calls.push("search"); return { data: { rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(now + 3_600_000).toISOString(), limit: 5000 }, repository: repo === fake.repo ? { id: "R1" } : null, search: { issueCount: repo === fake.repo ? fake.inWindow(90).length : 0 } } }; }
    if (query.includes("organization(")) { calls.push("team"); return { data: { organization: null } }; }
    calls.push("page");
    return fake.graphql(repo, query, vars);
  }, rest: fake.rest.bind(fake) };
  const budgets = new Map<string, Budget>();
  if (o.remaining !== undefined) budgets.set("example", { remaining: o.remaining, resetAt: now + 30 * 60_000, limit: 5000 });
  const stats = trackPersistence(directory, new PrStats({ directory, api, clientTimeZone: () => "UTC", now: () => now, log: () => undefined,
    gate: { budget: owner => budgets.get(owner), noteRateLimit: (owner, r) => budgets.set(owner, { remaining: r.remaining!, resetAt: Date.parse(r.resetAt!), limit: r.limit }), noteLimited: () => undefined, allowsBackground: () => allows } }));
  return { directory, fake, stats, calls, setAllows: (v: boolean) => { allows = v; }, now: () => now };
}

test("106: the turn-on estimate counts PRs while the machine is busy", async () => {
  const s = await statsService({ allows: false });
  try {
    const e = await s.stats.estimate("example/app");
    assert.equal(e.error, null, `no refusal, got: ${e.error}`);
    assert.equal(e.prs, s.fake.inWindow(90).length);
    assert.deepEqual(s.calls, ["search"]);
    // The settings view the sheet reads goes the same way.
    const view = await s.stats.view([], { repo: "example/app", estimate: true });
    assert.equal(view.estimate?.prs, s.fake.inWindow(90).length);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("106: the estimate still respects GitHub's budget, and says when it can read", async () => {
  const s = await statsService({ allows: true, remaining: 1500 });
  try {
    const e = await s.stats.estimate("example/app");
    assert.equal(e.prs, null);
    assert.deepEqual(s.calls, [], "under 40 % of the limit: nothing goes out");
    assert.equal(e.wait?.reason, "budget");
    assert.equal(e.wait?.until, s.now() + 30 * 60_000);
    assert.equal(e.unreadable, false);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

test("106: Refresh on the stats page reads while the machine is busy; the background sync waits", async () => {
  const s = await statsService({ allows: true });
  try {
    await s.stats.set({ repo: "example/app", enable: true });
    await s.stats.runRepo("example/app", { backfillPages: 100 });
    s.setAllows(false);
    s.calls.length = 0;
    await s.stats.runRepo("example/app");
    assert.deepEqual(s.calls, [], "a background run waits on the governor");
    await s.stats.read({ repo: "example/app", fresh: true });
    assert.ok((s.calls as string[]).includes("page"), `Refresh read GitHub: ${s.calls.join(",")}`);
  } finally { await rm(s.directory, { recursive: true, force: true }); }
});

async function gateWorld(o: { allows?: boolean; remaining?: number } = {}) {
  const now = clock;
  const directory = await mkdtemp(join(tmpdir(), "fu-dev-gate-"));
  const fake = new FakeStatsGithub(() => now);
  const github = new Github(undefined, undefined, undefined, { graphql: async () => ({}), rest: async () => [] } satisfies GithubApi, () => now);
  if (o.remaining !== undefined) github.noteRateLimit("example", { remaining: o.remaining, resetAt: new Date(now + 30 * 60_000).toISOString(), limit: 5000 });
  const gate = new StatsGate({ budget: owner => github.budget(owner), noteRateLimit: (owner, rate) => github.noteRateLimit(owner, rate), noteLimited: (owner, at) => github.noteLimited(owner, at), allowsBackground: () => o.allows ?? true, now: () => now });
  const store = trackPersistence(directory, new StatsStore(directory, { now: () => now, log: () => undefined }));
  const sync = new StatsSync({ api: fake, gate, store, now: () => now, log: () => undefined });
  return { directory, fake, gate, sync };
}

test("106: the gate skips the governor only for a developer's read; budget and share bind both", async () => {
  const busy = await gateWorld({ allows: false });
  try {
    assert.deepEqual(busy.gate.mayRead("example"), { ok: false, reason: "governor", until: null });
    assert.deepEqual(busy.gate.mayRead("example", 1, "developer"), { ok: true });
    const bg = await busy.sync.run("example/app");
    assert.equal(busy.fake.calls.length, 0);
    assert.equal(bg.waiting?.reason, "governor");
    await busy.sync.run("example/app", { backfillPages: 1, origin: "developer" });
    assert.ok(busy.fake.calls.length > 0, "a developer's run reads");
  } finally { await rm(busy.directory, { recursive: true, force: true }); }
  const low = await gateWorld({ allows: false, remaining: 1999 });
  try {
    const answer = low.gate.mayRead("example", 1, "developer");
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.reason, "budget");
    const run = await low.sync.run("example/app", { origin: "developer" });
    assert.equal(low.fake.calls.length, 0, "the low tier holds a developer's read too");
    assert.equal(run.waiting?.reason, "budget");
  } finally { await rm(low.directory, { recursive: true, force: true }); }
});

test("106: a developer's read waits for the read in flight and goes before the next background read", async () => {
  const w = await gateWorld();
  try {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const order: string[] = [];
    const first = w.gate.run("example", async () => { await held; order.push("background"); return { value: 1, rate: undefined }; });
    const mine = w.gate.run("example", async () => { order.push("developer"); return { value: 2, rate: undefined }; }, { origin: "developer" });
    // While a developer's read waits, background reads are refused, so a sync page can't take the slot first.
    assert.deepEqual(w.gate.mayRead("example"), { ok: false, reason: "busy", until: null });
    release();
    assert.deepEqual(await first, { ok: true, value: 1 });
    assert.deepEqual(await mine, { ok: true, value: 2 });
    assert.deepEqual(order, ["background", "developer"]);
    assert.deepEqual(w.gate.mayRead("example"), { ok: true }, "the slot is free again");
    assert.ok(DEVELOPER_SLOT_WAIT_MS <= 30_000, "a click waits seconds, not minutes");
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const estimate = (o: Partial<StatsEstimate>): StatsEstimate => ({ repo: "acme/app", prs: null, points: null, slicePoints: 250, bytes: null, error: null, wait: null, unreadable: false, ...o });

test("106: the turn-on sheet never dead-ends", () => {
  const at = Date.parse("2026-03-02T14:30:00Z");
  assert.equal(estimateBlocked(estimate({ prs: 10, points: 1 }), null, time), null, "a count shows the numbers instead");
  const low = estimateBlocked(estimate({ error: "GitHub limit low", wait: { reason: "budget", until: at } }), null, time)!;
  assert.equal(low.canTurnOn, true);
  assert.match(low.why, /GitHub limit is under 40% until 14:30/);
  assert.match(low.next, /start reading at 14:30/);
  const slice = estimateBlocked(estimate({ error: "x", wait: { reason: "slice", until: at } }), null, time)!;
  assert.equal(slice.canTurnOn, true);
  assert.match(slice.why, /share of GitHub's limit/);
  const busy = estimateBlocked(estimate({ error: "x", wait: { reason: "busy", until: null } }), null, time)!;
  assert.equal(busy.canTurnOn, true);
  assert.match(busy.next, /try again in a moment/);
  const failed = estimateBlocked(null, "The request timed out.", time)!;
  assert.equal(failed.canTurnOn, true);
  assert.match(failed.why, /timed out/);
  const http = estimateBlocked(estimate({ error: "Can't read acme/app (HTTP 502: Bad gateway)." }), null, time)!;
  assert.equal(http.canTurnOn, true);
  const unreadable = estimateBlocked(estimate({ error: "Can't read acme/app with this GitHub account (not found or no access).", unreadable: true }), null, time)!;
  assert.equal(unreadable.canTurnOn, false, "only a repository the account can't read refuses Turn on");
  assert.match(unreadable.next, /access/);
  for (const b of [low, slice, busy, failed, http, unreadable]) assert.doesNotMatch(`${b.why} ${b.next}`, /machine is busy|governor/i);
});

test("106: a workspace's Refresh reads its PRs while the governor pauses the engine; nothing else runs", async t => {
  const root = await mkdtemp(join(tmpdir(), "fu-dev-engine-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = testStore(Store, root);
  const w = workspace({ enable_auto_sends: true });
  await store.mutate(s => { s.workspaces.push(w); });
  const reads: string[][] = [];
  let discovered = 0, sends = 0, observedAgents = 0;
  const engine = new Engine(store, { observe: async (prs: { key: string }[]) => { reads.push(prs.map(p => p.key)); return new Map(); } },
    { discover: async () => { discovered++; return []; }, observe: async () => { observedAgents++; return { busy: false, reason: null, archived: false }; }, send: async () => { sends++; }, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), label: async () => {} });
  engine.paused = () => true;
  await engine.tick({ background: true });
  assert.deepEqual(reads, [], "the timer's tick waits");
  await engine.tick({ workspaceId: w.id });
  assert.equal(reads.length, 1, "Refresh read the workspace's PRs");
  assert.deepEqual(reads[0], w.prs.map(p => p.key));
  assert.deepEqual([discovered, observedAgents, sends], [0, 0, 0], "no discovery, agent reads or sends while paused");
});

/**
 * The class guard: every place the worker asks the governor for background room is listed here with why it is a
 * background path. A new one fails until it is listed, so a click can't quietly end up behind the background gate.
 */
const BACKGROUND_ONLY: Record<string, string> = {
  "roomForBackground: async () => governor.allowsBackground()": "Linked's 10-minute drain and the Summary's pre-writes; on-demand Summaries use roomOnDemand",
  "engine.paused = () => !governor.allowsBackground()": "Engine.run: the timer, nudges and discovery wait; a Refresh with a workspace still reads its PRs",
  "allowsBackground: () => governor.allowsBackground()": "StatsGate: background syncs wait; developer reads (origin: developer) skip it",
  "sending: sendingOf(w, Date.now(), { held: !governor.allowsBackground() })": "a label: says auto-sends are held",
  "tight: async () => !governor.allowsBackground()": "Overseer's digest backstop and auto-send label; the ranker's scheduled runs (manual runs go)",
  "tight: () => !governor.allowsBackground()": "the morning sweep, the morning asks, Compass's morning read (Sweep now, Read now and Retry don't ask it)",
  "autoSendsHeld: () => !governor.allowsBackground()": "a label: says auto-sends are held",
  "if (governor.allowsBackground()) try {": "the local-title recovery loop",
};

test("106: every governor gate in the worker is on a background path", async () => {
  const source = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  const lines = source.split("\n").filter(l => l.includes("governor.allowsBackground()"));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const listed = Object.keys(BACKGROUND_ONLY).some(k => line.includes(k));
    assert.ok(listed, `a new governor gate: list it in BACKGROUND_ONLY with why no click goes through it, or let the developer's path skip it:\n${line.trim()}`);
  }
});
