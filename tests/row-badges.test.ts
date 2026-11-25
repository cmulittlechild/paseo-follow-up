// Invariant 113, row-badges-replace-sidebar-labels: on a Paseo that draws plugin badges on sidebar workspace rows
// (0.17.1+), Follow-up writes no sidebar label (Done is the client's row badge) and takes back the label it wrote
// before; on an older Paseo, or one whose version it can't read, the Done label stays as it was.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testStore, rm } from "./support/store-temp-dir";
import { queueEngine } from "./support/queue";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { hostAtLeast, ROW_BADGES_SINCE } from "../server/host-features";
import { doneBadge, DONE_BADGE } from "../shared/row-badges";
import { listEntry, type ListWorkspace } from "../shared/list";
import type { Workspace } from "../shared/model";
import { clock, workspace, pr, snapshot } from "./fixtures";

const merged = () => workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] });
const done = (patch: Partial<Workspace> = {}) => workspace({ ...patch, prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped and verified", declaredAt: new Date(clock).toISOString() } });

async function fixture(t: any, w: Workspace, rowBadges: (() => Promise<boolean>) | undefined) {
  const root = await mkdtemp(join(tmpdir(), "follow-row-badges-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const labels: boolean[] = []; let asked = 0;
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), observe: async () => runtime, send: async () => {}, label: async (_w, assigned) => { labels.push(assigned); },
    ...(rowBadges ? { rowBadges: async () => { asked++; return rowBadges(); } } : {}) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(clock).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => clock);
  await queueEngine(engine, gateway, root);
  return { engine, store, labels, asked: () => asked, get: async () => (await store.snapshot()).workspaces[0] };
}

test("on a host with row badges a Done workspace gets no sidebar label", async t => {
  const f = await fixture(t, done(), async () => true);
  await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.labels, [], "no set_workspace_label at all");
  assert.equal((await f.get()).managedDoneLabel, false);
});

test("on a host with row badges the Done label written before the upgrade comes off once", async t => {
  const f = await fixture(t, done({ managedDoneLabel: true }), async () => true);
  await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.labels, [false], "unassigned once, never re-assigned");
  assert.equal((await f.get()).managedDoneLabel, false);
});

test("on an older host, or one whose version is unknown, the Done label stays", async t => {
  for (const rowBadges of [undefined, async () => false, async () => { throw new Error("daemon unreachable"); }]) {
    const f = await fixture(t, done(), rowBadges);
    await f.engine.tick();
    assert.deepEqual(f.labels, [true]);
    assert.equal((await f.get()).managedDoneLabel, true);
  }
});

test("the host is asked only for a workspace that would be labelled", async t => {
  const f = await fixture(t, merged(), async () => true);
  await f.engine.tick();
  assert.equal(f.asked(), 0);
  assert.deepEqual(f.labels, []);
});

test("row badges are Paseo 0.17.1 and later, read from server_info's version", async () => {
  const at = async (version: unknown) => hostAtLeast(ROW_BADGES_SINCE, async () => ({ version }))();
  assert.equal(await at("0.17.4"), true);
  assert.equal(await at("0.17.1"), true);
  assert.equal(await at("1.0.0"), true);
  assert.equal(await at("0.17.1-beta.2"), false, "a prerelease of 0.17.1 may not have them");
  assert.equal(await at("0.17.0"), false);
  assert.equal(await at("0.16.3"), false);
  assert.equal(await at(""), false);
  assert.equal(await at(undefined), false);
  // An unknown answer is asked again; a known one is kept (the version only changes with a daemon restart).
  let reads = 0; const versions = [undefined, "0.17.4", "0.15.0"];
  const probe = hostAtLeast(ROW_BADGES_SINCE, async () => ({ version: versions[reads++] }));
  assert.equal(await probe(), false); assert.equal(await probe(), true); assert.equal(await probe(), true);
  assert.equal(reads, 2);
});

test("the Done badge shows where Home shows Done, with Home's icon and tone", () => {
  const entry = (w: Workspace) => listEntry(w) as ListWorkspace;
  assert.deepEqual(doneBadge(entry(done()), clock), { icon: "CircleCheck", label: "Done", tone: "success", accessibilityLabel: "Follow-up: Done" });
  assert.equal(DONE_BADGE.icon, "CircleCheck");
  assert.equal(doneBadge(entry(merged()), clock), null, "not declared");
  assert.equal(doneBadge(entry(done({ hold: "Check it first" })), clock), null, "Home shows it in Needs you");
  assert.equal(doneBadge(entry(done({ enable_tracking: false })), clock), null, "not followed");
  assert.equal(doneBadge(undefined, clock), null);
});
