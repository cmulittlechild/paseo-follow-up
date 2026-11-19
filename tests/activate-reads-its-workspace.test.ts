import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueEngine } from "./support/queue";
import { extractHistory } from "../server/discovery";
import { Engine, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import { clock, workspace, pr } from "./fixtures";

// Following a workspace reads its PRs fresh and every other one with the usual backoff. Before 2026-11-19 it ran a
// full fresh read of every tracked PR: ~100 GraphQL points per follow at 100 open PRs.
test("github-reads-scale-with-change: following a workspace doesn't re-read every tracked PR", async t => {
  const directory = await mkdtemp(join(tmpdir(), "follow-activate-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = testStore(Store, directory);
  await store.mutate(state => { state.workspaces.push({ ...workspace({ id: "other", mainAgentId: "other-agent", prs: [pr({ key: "acme/app#7", number: 7 })] }), enable_tracking: true }); });
  const gateway: Gateway = {
    prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }),
    discover: async (_s, id?: string) => [{ id: "new", title: "New", mainAgentId: "new-agent", messageAt: null, history: extractHistory([]) }, ...(id ? [] : [{ id: "other", title: "Other", mainAgentId: "other-agent", messageAt: null, history: extractHistory([]) }])],
    observe: async () => ({ busy: false, reason: null, archived: false }),
    send: async () => {}, label: async () => {},
  };
  const calls: { keys: string[]; o: { background?: boolean; fresh?: Set<string> } }[] = [];
  const github = { observe: async (prs: { key: string }[], o: { background?: boolean; fresh?: Set<string> } = {}) => { calls.push({ keys: prs.map(p => p.key), o }); return new Map(); } };
  const engine = new Engine(store, github as never, gateway, () => clock);
  await queueEngine(engine, gateway, directory);
  await engine.activate("new");
  for (let i = 0; !calls.length && i < 50; i++) await new Promise(r => setTimeout(r, 10));
  const read = calls.find(c => c.keys.includes("acme/app#7"));
  assert.ok(read, "the tick after following still observes the other workspace");
  assert.equal(read!.o.background, true, "with the usual backoff, not a full fresh read");
  assert.ok(!read!.o.fresh?.has("acme/app#7"));
});

test("github-budget-low-says-when: while reads wait for the budget, the workspace says until when; then it clears", async t => {
  const { githubWaitLine } = await import("../shared/presentation");
  const directory = await mkdtemp(join(tmpdir(), "follow-wait-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = testStore(Store, directory);
  await store.mutate(state => { state.workspaces.push(workspace({ id: "w", prs: [pr({ key: "acme/app#7", number: 7 })] }), workspace({ id: "merged-only", mainAgentId: "m2", prs: [pr({ key: "acme/app#8", number: 8, snapshot: { ...pr().snapshot!, state: "MERGED" } })] })); });
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/fixture/r.json" }), observe: async () => ({ busy: false, reason: null, archived: false }), send: async () => {}, label: async () => {} };
  let until: number | null = clock + 20 * 60_000; let now = clock;
  const github = { observe: async () => new Map(), waitUntil: () => until };
  const engine = new Engine(store, github as never, gateway, () => now);
  await queueEngine(engine, gateway, directory);
  await engine.tick({ background: true });
  const [w, mergedOnly] = (await store.snapshot()).workspaces;
  assert.deepEqual(w.githubWait, { until: new Date(clock + 20 * 60_000).toISOString() });
  assert.equal(mergedOnly.githubWait ?? null, null, "only merged PRs: nothing to wait for");
  assert.match(githubWaitLine(w, now)!.title, /^GitHub budget low · next check /);
  assert.equal(githubWaitLine(w, clock + 21 * 60_000), null, "past the reset the line is gone even before a tick");
  until = null; now += 15_000;
  await engine.tick({ background: true });
  assert.equal((await store.snapshot()).workspaces[0].githubWait, null);
});
