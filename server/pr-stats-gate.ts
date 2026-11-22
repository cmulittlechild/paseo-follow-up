import { budgetTier, DEFAULT_LIMIT, type Budget } from "../shared/poll";

/**
 * The one gate every PR-statistics request passes (invariant `stats-never-spend-below-low`, docs/pr-stats.md).
 * Stats are the least important thing Follow-up reads from GitHub, so they yield to everything:
 *
 * 1. the governor allows background work (nothing while the VM is constrained or critical);
 * 2. the account's budget tier is `normal` (≥ 40 % of the limit left): stats stop at `low`, far above the 20 %
 *    reserve the PR poller and agents' own `gh` calls live on;
 * 3. the stats slice isn't spent: the `rateLimit.cost` of stats responses in the last rolling hour, plus the next
 *    page's expected cost (the last page's), stays within `slice × limit` (5 % = 250 of 5000 points by default);
 * 4. no other stats request is in flight.
 *
 * The ledger and the one-in-flight rule are worker-wide, not per account: stricter than the design's per-account
 * rule (two opted-in repositories on different accounts share one slice), and it never needs the account map.
 * Every response's `rateLimit` goes to `noteRateLimit`, the same per-owner `Budget` the PR poller reads
 * (`Github.noteRateLimit`), so a burst seen by either one throttles both (`stats-feed-the-shared-budget`).
 */
export const STATS_SLICE_DEFAULT = 0.05;
export const STATS_SLICE_MIN = 0.01;
export const STATS_SLICE_MAX = 0.1;
export const SLICE_WINDOW_MS = 60 * 60_000;
/** A page's cost before any was measured: 1 point per page of 25 (design §2.2). */
export const EXPECTED_PAGE_COST = 1;

export type GateReason = "governor" | "budget" | "slice" | "busy";
export type GateAnswer = { ok: true } | { ok: false; reason: GateReason; until: number | null };
export type RateLimit = { cost?: number; remaining?: number; resetAt?: string; limit?: number };
export interface GateDeps {
  /** The account's budget as the PR poller last saw it (`Github.budget`). */
  budget(owner: string): Budget | undefined;
  /** Feeds a stats response's rateLimit into that same budget. */
  noteRateLimit(owner: string, rate: RateLimit): void;
  /** Records that GitHub refused for the limit, until `resetAt`. */
  noteLimited(owner: string, resetAt: number): void;
  allowsBackground(): boolean;
  /** The slice as a fraction of the hourly limit (settings); clamped to [STATS_SLICE_MIN, STATS_SLICE_MAX]. */
  slice?(): number;
  now?: () => number;
}

export class StatsGate {
  private ledger: { at: number; cost: number }[] = [];
  private inFlight = false;
  private expected = EXPECTED_PAGE_COST;
  private now: () => number;
  constructor(private deps: GateDeps) { this.now = deps.now ?? Date.now; }

  private limitOf(owner: string): number { const b = this.deps.budget(owner); return b?.limit && b.limit > 0 ? b.limit : DEFAULT_LIMIT; }
  private sliceShare(): number { const s = this.deps.slice?.() ?? STATS_SLICE_DEFAULT; return Number.isFinite(s) ? Math.min(STATS_SLICE_MAX, Math.max(STATS_SLICE_MIN, s)) : STATS_SLICE_DEFAULT; }
  private prune(now: number): void { while (this.ledger.length && this.ledger[0]!.at <= now - SLICE_WINDOW_MS) this.ledger.shift(); }
  /** Points stats spent in the rolling hour. */
  spent(): number { this.prune(this.now()); return this.ledger.reduce((sum, e) => sum + e.cost, 0); }
  /** The slice in points for this owner's account. */
  slicePoints(owner: string): number { return Math.floor(this.sliceShare() * this.limitOf(owner)); }

  /** Whether a stats request for `owner`'s repository may go out now, `cost` being what it is expected to cost. */
  mayRead(owner: string, cost = this.expected): GateAnswer {
    const now = this.now();
    if (!this.deps.allowsBackground()) return { ok: false, reason: "governor", until: null };
    const budget = this.deps.budget(owner);
    if (budgetTier(budget, now) !== "normal") return { ok: false, reason: "budget", until: budget?.resetAt ?? null };
    this.prune(now);
    const cap = this.slicePoints(owner);
    let spent = this.ledger.reduce((sum, e) => sum + e.cost, 0);
    if (spent + cost > cap) {
      // The slice reopens when enough of the hour's oldest spending rolls out of the window.
      let until = now + SLICE_WINDOW_MS;
      for (const e of this.ledger) { spent -= e.cost; if (spent + cost <= cap) { until = e.at + SLICE_WINDOW_MS; break; } }
      return { ok: false, reason: "slice", until };
    }
    if (this.inFlight) return { ok: false, reason: "busy", until: null };
    return { ok: true };
  }

  /**
   * Runs one stats request through the gate: refused (with the answer) when the gate is closed, else `request` runs
   * as the only stats request in flight, and its `rateLimit` is charged to the slice and fed to the shared budget.
   */
  async run<T>(owner: string, request: () => Promise<{ value: T; rate: RateLimit | undefined }>, cost = this.expected): Promise<{ ok: true; value: T } | Extract<GateAnswer, { ok: false }>> {
    const answer = this.mayRead(owner, cost);
    if (!answer.ok) return answer;
    this.inFlight = true;
    try {
      const { value, rate } = await request();
      this.charge(owner, rate, cost);
      return { ok: true, value };
    } catch (error) {
      const e = error as { rateLimited?: boolean; resetAt?: number };
      if (e?.rateLimited) this.deps.noteLimited(owner, e.resetAt ?? this.now() + 10 * 60_000);
      // A request that failed may still have cost something; charge the expectation so failures can't loop free.
      this.ledger.push({ at: this.now(), cost });
      throw error;
    } finally { this.inFlight = false; }
  }
  private charge(owner: string, rate: RateLimit | undefined, fallback: number): void {
    const cost = typeof rate?.cost === "number" && rate.cost >= 0 ? rate.cost : fallback;
    this.ledger.push({ at: this.now(), cost });
    if (cost > 0) this.expected = cost;
    if (rate && typeof rate.remaining === "number") this.deps.noteRateLimit(owner, rate);
  }
}
