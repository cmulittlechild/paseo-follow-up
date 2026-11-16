// A burst of short-lived garbage (the kind the worker makes when agents end turns and the app reads), then light
// background allocation, then the worker's compaction. Prints RSS and V8's young generation (new_space) before the
// burst, after it, and after compacting.
//
// Every phase is sized by what it allocates (a count of steps), never by time: on a contended CPU a time-boxed burst
// allocates less, V8 grows the young generation only part way (32 of 64 MB, measured), and the RSS the test compares
// shrinks into noise. Steps yield with setImmediate, so the burst runs as fast as the CPU allows and ends the same.
// `plain` runs a plain gc() instead of compacting: what a runtime that ignores the memory-reducing flavor does.
import { getHeapSpaceStatistics } from "node:v8";
import { compactHeap } from "../../server/memory";
const mb = (n: number) => Math.round(n / 1048576);
const rss = () => mb(process.memoryUsage().rss);
const young = () => mb(getHeapSpaceStatistics().find(x => x.space_name === "new_space")?.space_size ?? 0);
let keep: unknown[] = [];
const churn = (perStep: number, steps: number) => new Promise<void>(resolve => {
  let n = 0;
  const step = () => {
    for (let i = 0; i < perStep; i++) { keep.push({ a: "x".repeat(200), b: [i, 2, 3] }); if (keep.length > 2000) keep = []; }
    if (++n >= steps) resolve(); else setImmediate(step);
  };
  step();
});
compactHeap();
await churn(200, 100);
const before = rss(), youngBefore = young();
await churn(4_000, 500);
await churn(200, 100);
const burst = rss(), youngBurst = young();
const plain = process.argv.includes("plain");
const compacted = plain ? ((globalThis as { gc?: () => void }).gc?.(), true) : compactHeap();
await churn(200, 50);
console.log(JSON.stringify({ before, burst, after: rss(), youngBefore, youngBurst, youngAfter: young(), compacted }));
