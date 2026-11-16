import { testStore, rm } from "./support/store-temp-dir";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { ListCache } from "../server/list-cache";
import { snapshot, pr, workspace } from "./fixtures";

// Invariant committed-workspaces-are-owned (AGENTS.md): a committed workspace is the store's own copy, frozen from the
// commit on (not from the next save), and never a caller's object. A caller that keeps a reference to what it put in
// a draft can't change the store through it, and readers can tell an unchanged workspace by identity.
async function store(t: TestContext, writeMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), "follow-owned-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const s = testStore(Store, directory, writeMs); t.after(() => s.close().catch(() => undefined));
  await s.mutate(state => { state.workspaces = [workspace({ id: "a", title: "First" }), workspace({ id: "b", title: "Second" })]; });
  return s;
}
const find = async (s: Store, id: string) => (await s.snapshot()).workspaces.find(w => w.id === id)!;

test("a later change to a caller's object doesn't reach the store", async t => {
  const s = await store(t);
  const observed = snapshot({ title: "As observed" });
  await s.mutateWorkspace("a", w => { w.prs = [pr({ snapshot: observed })]; });
  observed.title = "Changed by its owner later";
  assert.equal((await find(s, "a")).prs[0].snapshot!.title, "As observed");
  assert.equal(Object.isFrozen(observed), false, "the caller's object stays the caller's: never frozen by the store");
});

test("a committed workspace is frozen from the commit, before any save: a write to it throws", async t => {
  const s = await store(t, 60_000);
  await s.mutateWorkspace("a", w => { w.title = "Renamed"; });
  assert.equal(s.writes, 0, "committed, not saved yet: the write window is a minute");
  const w = await find(s, "a");
  assert.throws(() => { w.title = "Mutated outside the store"; }, TypeError);
  assert.throws(() => { w.prs.push(pr()); }, TypeError);
  assert.equal((await find(s, "a")).title, "Renamed");
});

test("ListCache reuses an unchanged workspace's entry across list calls, and rebuilds only the changed one", async t => {
  const s = await store(t, 60_000);
  const cache = new ListCache();
  const first = cache.answer(await s.snapshot());
  const entry = (r: typeof first, id: string) => r.workspaces.find(w => w.id === id)!;
  await s.mutateWorkspace("a", w => { w.title = "Renamed"; });
  const second = cache.answer(await s.snapshot());
  const third = cache.answer(await s.snapshot(), second.revision);
  assert.equal(entry(second, "b"), entry(first, "b"), "an untouched workspace keeps its entry");
  assert.notEqual(entry(second, "a"), entry(first, "a"));
  assert.equal(entry(second, "a").title, "Renamed");
  // Before the store froze at commit, a committed-but-unsaved workspace was rebuilt on every call until the next save.
  assert.equal(cache.answer(await s.snapshot()).workspaces.find(w => w.id === "a"), entry(second, "a"), "a committed, unsaved change is built once");
  assert.deepEqual(third.workspaces, [], "nothing changed since the last revision");
});
