// A burst of short-lived garbage (the kind the worker makes when agents end turns and the app reads), then light
// background allocation, then the worker's compaction. Prints RSS before the burst, after it, and after compacting.
import { compactHeap } from "../../server/memory";
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
let keep: unknown[] = [];
const churn = (perTick: number, ms: number) => new Promise<void>(resolve => {
  const end = Date.now() + ms;
  const t = setInterval(() => { for (let i = 0; i < perTick; i++) { keep.push({ a: "x".repeat(200), b: [i, 2, 3] }); if (keep.length > 2000) keep = []; } if (Date.now() > end) { clearInterval(t); resolve(); } }, 10);
});
compactHeap();
await churn(200, 1_000);
const before = mb();
await churn(4_000, 4_000);
await churn(200, 1_000);
const burst = mb();
const compacted = compactHeap();
await churn(200, 500);
console.log(JSON.stringify({ before, burst, after: mb(), compacted }));
