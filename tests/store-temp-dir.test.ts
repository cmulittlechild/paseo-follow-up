import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStores, storeCleanupProblems } from "./support/store-temp-dir-guard";
import { JsonFileStore } from "../server/json-file-store";
import { z } from "zod";
import { rm, testStore, trackPersistence } from "./support/store-temp-dir";

// Test the ordering, not an rm retry: every registered writer must settle before removal starts.
test("store cleanup drains every instance and nested directory, but leaves siblings alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-cleanup-"));
  const calls: string[] = [];
  const writer = (directory: string, name: string) => trackPersistence(directory, {
    async flush() { await access(root); calls.push(name); },
  });
  writer(root, "first"); writer(root, "reopened"); writer(join(root, "child"), "child");
  const sibling = writer(`${root}-sibling`, "sibling");
  await rm(root, { recursive: true, force: true });
  assert.deepEqual(calls, ["first", "reopened", "child"]);
  await assert.rejects(access(root), { code: "ENOENT" });
  // Remove the registration without trying to access a directory we already removed.
  sibling.flush = async () => { calls.push("sibling"); };
  await rm(`${root}-sibling`, { recursive: true, force: true });
  assert.equal(calls.at(-1), "sibling");
});

test("failed flush preserves the directory and stays registered for a later cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-cleanup-"));
  let fails = true, calls = 0;
  trackPersistence(root, { async flush() { calls++; if (fails) throw new Error("disk unavailable"); } });
  await assert.rejects(rm(root, { recursive: true, force: true }), /disk unavailable/);
  await access(root);
  fails = false;
  await rm(root, { recursive: true, force: true });
  assert.equal(calls, 2);
});

test("cleanup drains a JsonFileStore's inherited mutation queue without an extra save", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-cleanup-"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class QueuedStore extends JsonFileStore<{ n: number }> {
    constructor(directory: string) {
      super({ path: join(directory, "queued.json"), schema: z.object({ n: z.number() }), empty: () => ({ n: 0 }),
        move: async (from, to) => { entered(); await gate; await rename(from, to); } });
    }
  }
  const store = testStore(QueuedStore, root);
  const writing = store.mutate(state => { state.n = 1; });
  void writing.catch(() => undefined);
  let removing: Promise<void> | undefined;
  try {
    await started;
    removing = rm(root, { recursive: true, force: true });
    let removed = false;
    void removing.then(() => { removed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, false);
    await access(root);
    release(); await writing; await removing;
    assert.equal(store.writes, 1, "draining a write-through queue must not save a second value");
    await assert.rejects(access(root), { code: "ENOENT" });
  } finally {
    release(); await writing; await removing;
    await rm(root, { recursive: true, force: true });
  }
});

for (const method of ["flush", "mutate"]) test(`cleanup discovery follows inherited ${method} through an imported alias and multiple base classes`, () => {
  const classes = discoverStores(new Map([
    ["../server/base", `export class Base { async ${method}() {} }`],
    ["../server/middle", 'import { Base as Parent } from "./base"; export class Middle extends Parent {}'],
    ["../server/child", 'import { Middle } from "./middle"; export class Child extends Middle {}'],
  ]));
  const problems = storeCleanupProblems(classes, "child.test.ts", `
    import { Child as Store } from "../server/child";
    import { rm } from "node:fs/promises";
    const store = new Store("fixture");
  `);
  assert.equal(problems.length, 2, `inherited ${method} must guard both construction and raw removal`);
});

test("invariant 39: tests construct queued writers through the cleanup helper and never import raw rm", async () => {
  const sources = new Map<string, string>();
  for (const file of await readdir("server")) if (file.endsWith(".ts")) {
    sources.set(`../server/${file.slice(0, -3)}`, await readFile(join("server", file), "utf8"));
  }
  const classes = discoverStores(sources), problems: string[] = [];
  for (const file of await readdir("tests")) if (file.endsWith(".test.ts")) {
    problems.push(...storeCleanupProblems(classes, file, await readFile(join("tests", file), "utf8")));
  }
  assert.deepEqual(problems, []);
});
