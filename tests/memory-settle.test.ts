import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HeapSettler, watchMemory, type MemoryBeat } from "../server/memory";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Invariant memory-returns-after-a-burst (AGENTS.md): what a burst of work grows comes back once it ends. V8 grows its
// young generation to its cap under a burst and keeps it (or its pages, pooled) while anything allocates; only a
// memory-reducing collection returns it. 2026-11-15: the live worker stepped 232 → 325 → 376 MB over busy periods.
test("the worker's compaction returns what a burst of garbage grew", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/fixtures/burst-child.ts"], { timeout: 30_000 });
  const r = JSON.parse(stdout.trim().split("\n").pop()!) as { before: number; burst: number; after: number; compacted: boolean };
  assert.ok(r.compacted, "compaction ran");
  // Ratios, not MB: the child's base RSS moves with the runtime. Measured (Node 24.20, 5 runs): the burst grew RSS
  // 1.55-1.8x and compaction returned 97-104 % of it; a plain gc() returns none of it.
  assert.ok(r.burst >= r.before * 1.3, `the burst grew RSS (${r.before} → ${r.burst} MB), or the test measures nothing`);
  const returned = (r.burst - r.after) / (r.burst - r.before);
  // A runtime that ignores the memory-reducing flavor (Node 20) runs a plain collection and fails here, loudly.
  assert.ok(returned >= 0.8, `compaction returned ${Math.round(returned * 100)} % of the burst's growth (before ${r.before}, burst ${r.burst}, after ${r.after} MB); a runtime that ignores gc's memory-reducing flavor returns ~0 %`);
});

test("the settler compacts once RSS is over its baseline and the worker has been quiet for a minute, at most once per gap", () => {
  let now = 0; let rss = 200; let runs = 0; let gives = 95;
  const s = new HeapSettler({ growthMb: 48, minGapMs: 120_000, now: () => now, rssMb: () => rss, cpuMs: () => 0, compact: () => { runs++; rss -= gives; return true; } });
  const tick = (mb: number, u: number, times = 1) => { for (let i = 0; i < times; i++) { now += 5_000; rss = mb; s.observe(mb, u); } };
  tick(200, 0.002, 12); assert.equal(runs, 0, "quiet but at its baseline");
  tick(230, 0.002, 12); assert.equal(runs, 0, "under the growth threshold");
  tick(240, 0.04, 6); tick(300, 0.04, 18); assert.equal(runs, 0, "a burst (busy first, then RSS over the threshold) doesn't settle");
  tick(300, 0.002, 6); assert.equal(runs, 0, "half a minute of quiet isn't enough");
  tick(300, 0.002, 6); assert.equal(runs, 1, "a quiet minute over the threshold settles");
  tick(300, 0.002, 12); assert.equal(runs, 1, "not again inside the gap");
  tick(300, 0.002, 12); assert.equal(runs, 2, "again once the gap has passed");
  tick(300, 0.04, 110); assert.equal(runs, 2, "busy: waits");
  tick(300, 0.04, 10); assert.equal(runs, 3, "busy ten minutes past the threshold: settles anyway");
  gives = 2; tick(330, 0.002, 24); assert.equal(runs, 4);
  tick(400, 0.002, 30); assert.equal(runs, 4, "a futile collection doubles the gap");
  tick(400, 0.002, 20); assert.equal(runs, 5);
});

test("heartbeat.json gets the worker's memory and keeps what the installer reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "follow-memory-"));
  const file = join(dir, "heartbeat.json");
  await writeFile(file, JSON.stringify({ version: "9.9.9", at: 1, error: null }));
  const watch = watchMemory({ heartbeatFile: file, sampleMs: 20, beatMs: 30 });
  try {
    let beat: { version?: string; at?: number; memory?: MemoryBeat } = {};
    for (let i = 0; i < 100 && !beat.memory; i++) { await new Promise(r => setTimeout(r, 20)); beat = JSON.parse(await readFile(file, "utf8")); }
    assert.equal(beat.version, "9.9.9"); assert.equal(beat.at, 1);
    const m = beat.memory!;
    assert.ok(m.rssMb > 0 && m.heapUsedMb > 0 && m.heapTotalMb >= m.heapUsedMb && m.externalMb >= 0 && m.arrayBuffersMb >= 0, JSON.stringify(m));
    assert.ok(m.youngMb === null || m.youngMb >= 0); assert.deepEqual(m.settles, []);
  } finally { watch.stop(); await rm(dir, { recursive: true, force: true }); }
});
