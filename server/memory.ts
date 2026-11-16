import { getHeapSpaceStatistics, setFlagsFromString } from "node:v8";
import { readFile, rename, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

type Gc = (options?: { type?: "major" | "minor"; execution?: "sync" | "async"; flavor?: "regular" | "last-resort" }) => void;
let cached: Gc | null | undefined;
function gcFunction(): Gc | null {
  if (cached !== undefined) return cached;
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    setFlagsFromString("--no-expose-gc");
    cached = typeof gc === "function" ? gc as Gc : null;
  } catch { cached = null; }
  return cached;
}

/**
 * One memory-reducing garbage collection: a full, compacting collection that also shrinks V8's young generation and
 * releases the pages V8 keeps pooled. A plain `gc()` does neither (Node 24: RSS 108 → 108 MB after a burst; the
 * memory-reducing flavor: 108 → 54). Paseo starts plugin processes itself, so there's no --expose-gc: the flag is set
 * for one fresh context only, which leaves no `gc` global behind. Returns false where the runtime refuses.
 */
export function compactHeap(): boolean {
  const gc = gcFunction();
  if (!gc) return false;
  try { gc({ type: "major", execution: "sync", flavor: "last-resort" }); } catch { try { gc(); } catch { return false; } }
  return true;
}

/** One settle: `forced` when the 10-minute fallback ran it, not a quiet minute. */
export type Settle = { at: number; beforeMb: number; afterMb: number; ms: number; cpuMs: number; forced: boolean };
export type SettlerOptions = { growthMb?: number; minGapMs?: number; quietSamples?: number; quietUtilization?: number; maxWaitMs?: number; now?: () => number; rssMb?: () => number; compact?: () => boolean; cpuMs?: () => number };
/**
 * Memory a burst grows comes back when the burst ends (memory-returns-after-a-burst). Under a burst of work V8 grows its
 * young generation to its cap (128 MB on Node 24) and keeps it, or its pages pooled, for as long as anything
 * allocates; the worker always does, so RSS stepped up with every busy period and never came down. `observe` gets the
 * worker's RSS and event-loop utilization every 5 s. One memory-reducing collection (60-100 ms, the event loop
 * blocked) runs when RSS is `growthMb` over where the last one left it, `minGapMs` has passed, and the worker is quiet:
 * mean utilization under 1 % over the last 12 samples (a minute). Mid-burst the young generation would grow straight
 * back, and a burst's utilization is low too (median 3 %, harness 2026-11-16), so the gate is the minute's mean, which
 * was quiet in 2 of 109 burst samples and 95 of 158 gap samples. Busy for `maxWaitMs` past the threshold, it runs anyway. A collection that gives back under 8 MB (a runtime that ignores the memory-reducing flavor,
 * or growth outside V8) doubles the gap, up to an hour, so a futile one doesn't repeat.
 */
export class HeapSettler {
  private baseline: number | null = null;
  private last = -Infinity;
  private gap: number;
  private recent: number[] = [];
  private overSince: number | null = null;
  readonly settles: Settle[] = [];
  /** Settles since start, by what let them run: a quiet minute, or the fallback (live verification, heartbeat.json). */
  quietSettles = 0;
  forcedSettles = 0;
  /** The mean event-loop utilization over the last minute's samples, or null before the first. */
  utilization(): number | null { return this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : null; }
  constructor(private o: SettlerOptions = {}) { this.gap = o.minGapMs ?? 120_000; }
  observe(rssMb: number, utilization = 0): Settle | null {
    const now = (this.o.now ?? Date.now)();
    const window = this.o.quietSamples ?? 12;
    this.recent.push(utilization); if (this.recent.length > window) this.recent.shift();
    if (this.baseline === null || rssMb < this.baseline) { this.baseline = rssMb; this.overSince = null; return null; }
    if (rssMb < this.baseline + (this.o.growthMb ?? 48)) { this.overSince = null; return null; }
    this.overSince ??= now;
    if (now - this.last < this.gap) return null;
    const quiet = this.recent.length >= window && this.recent.reduce((a, b) => a + b, 0) / window < (this.o.quietUtilization ?? 0.01);
    if (!quiet && now - this.overSince < (this.o.maxWaitMs ?? 600_000)) return null;
    const cpu = this.o.cpuMs ?? (() => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; });
    const t0 = performance.now(); const c0 = cpu();
    const ran = (this.o.compact ?? compactHeap)();
    const ms = Math.round(performance.now() - t0); const cpuMs = Math.round(cpu() - c0);
    this.last = now; this.overSince = null;
    if (!ran) return null;
    const after = (this.o.rssMb ?? (() => process.memoryUsage().rss / 1048576))();
    const settle = { at: now, beforeMb: Math.round(rssMb), afterMb: Math.round(after), ms, cpuMs, forced: !quiet };
    if (quiet) this.quietSettles++; else this.forcedSettles++;
    this.gap = rssMb - after < 8 ? Math.min(this.gap * 2, 3_600_000) : (this.o.minGapMs ?? 120_000);
    this.baseline = after; this.settles.push(settle); if (this.settles.length > 20) this.settles.shift();
    console.error(`[follow-up] memory settled: ${settle.beforeMb} → ${settle.afterMb} MB, ${ms} ms (cpu ${cpuMs} ms)`);
    return settle;
  }
}

export type MemoryBeat = { at: number; rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number; youngMb: number | null; utilization: number | null; quietSettles: number; forcedSettles: number; settles: Settle[] };
const mb = (n: number) => Math.round(n / 1048576 * 10) / 10;
const round = (u: number | null) => u === null ? null : Math.round(u * 10000) / 10000;
/**
 * The worker's memory as heartbeat.json reports it: process.memoryUsage(), V8's young generation, the last minute's mean
 * event-loop utilization (is the 1 % quiet gate reachable on this host?), and the settles, quiet and forced counted.
 */
export function memoryBeat(settler: HeapSettler): MemoryBeat {
  const m = process.memoryUsage();
  const young = getHeapSpaceStatistics().find(x => x.space_name === "new_space");
  return { at: Date.now(), rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers), youngMb: young ? mb(young.space_size) : null, utilization: round(settler.utilization()), quietSettles: settler.quietSettles, forcedSettles: settler.forcedSettles, settles: settler.settles.slice(-5) };
}

/**
 * The worker's memory watch, from the end of startup: the settler gets RSS and event-loop utilization every 5 s, and
 * heartbeat.json gets a `memory` field every minute, so live numbers need no /proc. The rest of the heartbeat
 * (`version`, `at`, `error`: the installer's probation) is kept as written.
 */
export function watchMemory(o: { heartbeatFile: string; settler?: HeapSettler; sampleMs?: number; beatMs?: number }): { settler: HeapSettler; stop(): void } {
  const settler = o.settler ?? new HeapSettler();
  let elu = performance.eventLoopUtilization();
  settler.observe(process.memoryUsage().rss / 1048576);
  const sample = setInterval(() => {
    const next = performance.eventLoopUtilization();
    settler.observe(process.memoryUsage().rss / 1048576, performance.eventLoopUtilization(next, elu).utilization);
    elu = next;
  }, o.sampleMs ?? 5_000);
  const beat = setInterval(() => void (async () => {
    const current = JSON.parse(await readFile(o.heartbeatFile, "utf8").catch(() => "{}")) as Record<string, unknown>;
    const temporary = `${o.heartbeatFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...current, memory: memoryBeat(settler) }), { mode: 0o600 });
    await rename(temporary, o.heartbeatFile);
  })().catch(() => undefined), o.beatMs ?? 60_000);
  sample.unref?.(); beat.unref?.();
  return { settler, stop: () => { clearInterval(sample); clearInterval(beat); } };
}
