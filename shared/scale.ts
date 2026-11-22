import { z } from "zod";

/**
 * Bounds for lists that grow with a workspace (invariant pr-scale-lists-batch-not-throw). A cap on such a list is a
 * sanity bound far above any real workspace, never a size a busy one reaches: the busiest seen so far carried 65 PRs
 * in one stack, and `tests/pr-scale.test.ts` runs 4x that. Where the far side is untrusted (the browser exchange) the
 * cap stays small and the sender batches to fit instead (`BROWSER_BATCH`).
 */
export const SCALE = {
  /** PRs or tasks named in one call about one workspace (add_reviewers, follow.refine-tasks). */
  perWorkspace: 500,
  /** Agents named in one call (sign_off, snooze, set_finish_flags). */
  agents: 500,
  /** Workspaces named in one call or one model reply (set_priorities, the ranker). */
  workspaces: 1000,
} as const;

/**
 * An array a model writes: past `max` items it keeps the first `max` instead of failing the whole reply. For model
 * output only, where a longer list is a model slip, not an attack (the reply is already bounded by its char limit).
 */
export function truncated<T extends z.ZodType>(item: T, max: number) {
  return z.preprocess(v => Array.isArray(v) ? v.slice(0, max) : v, z.array(item).max(max));
}
