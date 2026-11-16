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
// The child's young generation is pinned (--max-semi-space-size), so a burst grows it to the same cap on every machine:
// V8's default size moves with the machine's memory. Its new_space is two semi-spaces at the cap.
const SEMI_SPACE_MB = 32;
async function runBurst(extra: string[] = []) {
  const { stdout } = await promisify(execFile)(process.execPath, [`--max-semi-space-size=${SEMI_SPACE_MB}`, ...extra, "--import", "tsx", "tests/fixtures/burst-child.ts", ...extra.includes("--expose-gc") ? ["plain"] : []], { timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").pop()!) as { before: number; burst: number; after: number; youngBefore: number; youngBurst: number; youngAfter: number; compacted: boolean };
}

function checkBurst(r: Awaited<ReturnType<typeof runBurst>>) {
  assert.ok(r.compacted, "compaction ran");
  const seen = `RSS ${r.before} → ${r.burst} → ${r.after} MB, young generation ${r.youngBefore} → ${r.youngBurst} → ${r.youngAfter} MB`;
  // The burst is sized by allocation, so it reaches the cap however contended the CPU is (a time-boxed burst stopped at
  // 32 of 64 MB under load and the RSS ratio fell to 1.34x against 1.3x: the flake this replaced).
  assert.equal(r.youngBurst, 2 * SEMI_SPACE_MB, `the burst grew the young generation to its cap, or the test measures nothing (${seen})`);
  // Ratios, not MB: the child's base RSS moves with the runtime. Measured (Node 24.20): the burst grows RSS 1.6-1.8x.
  assert.ok(r.burst >= r.before * 1.3, `the burst grew RSS (${seen})`);
  // A runtime that ignores the memory-reducing flavor (Node 20) runs a plain collection: it keeps the young generation
  // at its cap and returns ~0 % of the RSS, and fails both checks below, loudly.
  assert.ok(r.youngAfter <= r.youngBefore * 2, `compaction shrank the young generation (${seen})`);
  const returned = (r.burst - r.after) / (r.burst - r.before);
  assert.ok(returned >= 0.8, `compaction returned ${Math.round(returned * 100)} % of the burst's growth (${seen}); a runtime that ignores gc's memory-reducing flavor returns ~0 %`);
}

// Invariant memory-returns-after-a-burst (AGENTS.md): what a burst of work grows comes back once it ends. V8 grows its
// young generation to its cap under a burst and keeps it (or its pages, pooled) while anything allocates; only a
// memory-reducing collection returns it. 2026-11-15: the live worker stepped 232 → 325 → 376 MB over busy periods.
test("the worker's compaction returns what a burst of garbage grew", async () => {
  checkBurst(await runBurst());
});

test("a plain collection, what a runtime that ignores the memory-reducing flavor runs, fails the burst check", async () => {
  const r = await runBurst(["--expose-gc"]);
  assert.throws(() => checkBurst(r), /compaction shrank the young generation|compaction returned/);
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
  assert.deepEqual(s.settles.map(x => x.forced), [false, false, true], "the fallback's settle is marked forced");
  assert.equal(s.quietSettles, 2); assert.equal(s.forcedSettles, 1);
  assert.ok(Math.abs(s.utilization()! - 0.04) < 1e-9, "the last minute's mean utilization");
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
    assert.ok(m.utilization !== null && m.utilization >= 0 && m.utilization <= 1, `utilization ${m.utilization}`);
    assert.equal(m.quietSettles, 0); assert.equal(m.forcedSettles, 0);
  } finally { watch.stop(); await rm(dir, { recursive: true, force: true }); }
});
