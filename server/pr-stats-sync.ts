import { FLAG, PAGE_COMMENTS, PAGE_REVIEWS, PAGE_TIMELINE, parseStatsRecord, STATS_PAGE_MIN, STATS_PAGE_SIZE, withAllReviews, type StatsRecord } from "../shared/pr-stats-records";
import type { GithubApi } from "./github-api";
import type { GateReason, RateLimit, StatsGate } from "./pr-stats-gate";
import { STATS_RECORDS_MAX, type RepoStats, type StatsStore } from "./pr-stats-store";

/**
 * PR statistics' sync (docs/pr-stats.md, design §2.3): two walks over one keyset-paged query, every request through
 * the gate (`StatsGate`, invariant `stats-never-spend-below-low`).
 *
 * - **Incremental**: from the newest PR down until `updatedAt < highWater − OVERLAP_S` (clock skew and same-second
 *   updates), then `highWater` = the newest updatedAt seen. Usually one page. Cut short by the gate, it resumes from
 *   its cursor next run and only then moves `highWater`, so nothing updated in between is skipped.
 * - **Backfill**: continues from its saved cursor until `updatedAt < now − window` (90 days by default), at most
 *   `BACKFILL_PAGES_PER_RUN` pages a run, recording how far back it reached (`coveredTo`).
 *
 * GitHub's cursors on `orderBy: UPDATED_AT` encode the sort key, so a PR updated mid-walk jumps to the front (the next
 * incremental pass reads it) without shifting the rest. A 502 or RESOURCE_LIMITS answer halves the page for that
 * repository until a page succeeds. A PR with more than PAGE_REVIEWS reviews gets one follow-up read for all of them,
 * `REVIEWS_BATCH` PRs per query by alias. Records older than the window are dropped at the end of every run, and past
 * `STATS_RECORDS_MAX` the oldest go first.
 */
export const OVERLAP_S = 120;
export const BACKFILL_PAGES_PER_RUN = 20;
export const INCREMENTAL_PAGES_PER_RUN = 20;
export const REVIEWS_BATCH = 10;
/** Reviews a follow-up reads per PR (the page reads PAGE_REVIEWS). */
export const REVIEWS_FOLLOW_UP = 100;
/** Consecutive failed pages before a run gives up (each one halves the page first). */
const FAILURES_PER_RUN = 3;

const PR_FIELDS = `number title createdAt updatedAt closedAt mergedAt state isDraft additions deletions changedFiles
author{login __typename} baseRefName headRefName
reviews(first:${PAGE_REVIEWS}){totalCount nodes{author{login __typename} state submittedAt}}
comments(first:${PAGE_COMMENTS}){totalCount nodes{createdAt author{login __typename}}}
timelineItems(first:${PAGE_TIMELINE},itemTypes:[READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,REVIEW_REQUESTED_EVENT,REVIEW_REQUEST_REMOVED_EVENT]){pageInfo{hasNextPage} nodes{__typename
...on ReadyForReviewEvent{createdAt}
...on ConvertToDraftEvent{createdAt}
...on ReviewRequestedEvent{createdAt requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{slug}}}
...on ReviewRequestRemovedEvent{createdAt requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{slug}}}}}`;
/** The page query (design §2.2, measured at 1 point per page of 25). No bodies, no comment text, no diff. */
export function statsPageQuery(first: number, withCursor: boolean): string {
  return `query($owner:String!,$name:String!${withCursor ? ",$after:String!" : ""}){rateLimit{cost remaining resetAt limit}
repository(owner:$owner,name:$name){defaultBranchRef{name}
pullRequests(first:${first}${withCursor ? ",after:$after" : ""},orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{${PR_FIELDS}}}}}`;
}
/** All reviews of up to REVIEWS_BATCH PRs, one alias each. */
export function statsReviewsQuery(numbers: number[]): string {
  const prs = numbers.map((n, i) => `p${i}:pullRequest(number:${n}){number reviews(first:${REVIEWS_FOLLOW_UP}){nodes{author{login __typename} state submittedAt}}}`).join(" ");
  return `query($owner:String!,$name:String!){rateLimit{cost remaining resetAt limit} repository(owner:$owner,name:$name){${prs}}}`;
}

type Node = Record<string, any>;
export type SyncResult = {
  repo: string;
  /** Pages and follow-ups read, and the points they cost. */
  pages: number; cost: number;
  /** Records added or changed. */
  changed: number;
  /** Why it stopped before it was done (the gate), or null. */
  waiting: { reason: GateReason; until: number | null } | null;
  error: string | null;
  backfillDone: boolean;
};
type Page = { nodes: Node[]; hasNext: boolean; endCursor: string | null; defaultBranch: string | null };

const seconds = (iso: unknown) => typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? Math.floor(Date.parse(iso) / 1000) : null;
const status = (error: unknown): number | null => { const s = (error as { status?: unknown })?.status; return typeof s === "number" ? s : null; };
/** A failure that a smaller page may get past: a timeout (502/504) or GitHub's RESOURCE_LIMITS_EXCEEDED. */
export function tooBig(error: unknown): boolean {
  const s = status(error);
  return s === 502 || s === 504 || /RESOURCE_LIMITS|timeout|timed out|abort/i.test(String((error as { message?: string })?.message ?? ""));
}
class GraphqlError extends Error { constructor(message: string, readonly status: number | null) { super(message); } }

export class StatsSync {
  private now: () => number;
  constructor(private o: { api: GithubApi; gate: StatsGate; store: StatsStore; now?: () => number; log?: (line: string) => void }) { this.now = o.now ?? Date.now; }

  /**
   * One run for a repository: the incremental walk, review follow-ups, then backfill pages while the gate allows.
   * Never throws: a read error is stored on the repository (`meta.error`) and returned.
   */
  async run(repo: string, o: { backfillPages?: number; incrementalPages?: number } = {}): Promise<SyncResult> {
    const stats = await this.o.store.open(repo);
    const result: SyncResult = { repo, pages: 0, cost: 0, changed: 0, waiting: null, error: null, backfillDone: stats.meta.backfill.done };
    const meta = () => stats.meta;
    const set = (patch: Partial<RepoStats["meta"]>) => { stats.meta = { ...stats.meta, ...patch }; };
    let failures = 0;
    /** One page through the gate; null when the gate is closed or the run should stop. */
    const page = async (after: string | null): Promise<Page | null> => {
      while (true) {
        const size = meta().page;
        let answer;
        try {
          answer = await this.o.gate.run(repo.split("/")[0]!, async () => {
            const body = await this.o.api.graphql(repo, statsPageQuery(size, after !== null), { owner: repo.split("/")[0]!, name: repo.split("/")[1]!, ...(after !== null ? { after } : {}) });
            return { value: body, rate: body?.data?.rateLimit as RateLimit | undefined };
          });
        } catch (error) {
          failures++;
          if (tooBig(error) && failures < FAILURES_PER_RUN) { set({ page: Math.max(STATS_PAGE_MIN, Math.floor(size / 2)) }); continue; }
          if (tooBig(error)) set({ page: Math.max(STATS_PAGE_MIN, Math.floor(size / 2)) });
          this.fail(stats, error, result);
          return null;
        }
        if (!answer.ok) { result.waiting = { reason: answer.reason, until: answer.until }; return null; }
        const body = answer.value as Node;
        result.pages++; result.cost += Number(body?.data?.rateLimit?.cost) || 0;
        const errors: Node[] = Array.isArray(body?.errors) ? body.errors : [];
        if (errors.some(e => e?.type === "RESOURCE_LIMITS_EXCEEDED") && size > STATS_PAGE_MIN && failures + 1 < FAILURES_PER_RUN) { failures++; set({ page: Math.max(STATS_PAGE_MIN, Math.floor(size / 2)) }); continue; }
        const connection = body?.data?.repository?.pullRequests;
        if (!connection) {
          const notFound = body?.data && body.data.repository === null;
          this.fail(stats, new GraphqlError(notFound ? "not found or no access" : errors[0]?.message ?? "GitHub returned no pull requests", notFound ? 404 : null), result);
          return null;
        }
        // A page that succeeded at a smaller size: back to the full page for the next run.
        if (size !== STATS_PAGE_SIZE) set({ page: STATS_PAGE_SIZE });
        failures = 0;
        return { nodes: Array.isArray(connection.nodes) ? connection.nodes.filter(Boolean) : [], hasNext: !!connection.pageInfo?.hasNextPage, endCursor: connection.pageInfo?.endCursor ?? null, defaultBranch: body.data.repository.defaultBranchRef?.name ?? null };
      }
    };
    const take = (p: Page, from: number) => {
      const records: StatsRecord[] = [];
      for (const node of p.nodes) {
        const u = seconds(node.updatedAt);
        if (u === null || u < from) continue;
        try { records.push(parseStatsRecord(node)); } catch { /* a PR without times can't be counted */ }
      }
      result.changed += this.o.store.merge(stats, records);
      const pending = new Set(meta().pendingReviews);
      for (const r of records) if ((r.fl ?? 0) & FLAG.reviewsTruncated) pending.add(r.n);
      if (p.defaultBranch !== meta().defaultBranch && p.defaultBranch) set({ defaultBranch: p.defaultBranch });
      set({ pendingReviews: [...pending] });
    };
    const windowStart = () => Math.floor(this.now() / 1000) - meta().windowDays * 86_400;

    try {
      // Incremental (once the backfill has set a high-water mark).
      if (meta().highWater !== null) {
        const stop = meta().highWater! - OVERLAP_S;
        let after = meta().incremental?.after ?? null, high = meta().incremental?.high ?? meta().highWater!;
        for (let n = 0; n < (o.incrementalPages ?? INCREMENTAL_PAGES_PER_RUN); n++) {
          const p = await page(after);
          if (!p) break;
          take(p, Math.max(stop, windowStart()));
          for (const node of p.nodes) high = Math.max(high, seconds(node.updatedAt) ?? 0);
          const reached = p.nodes.some(node => (seconds(node.updatedAt) ?? 0) < stop);
          if (reached || !p.hasNext || !p.endCursor) { set({ highWater: high, incremental: null }); after = null; break; }
          after = p.endCursor; set({ incremental: { after, high } });
        }
      }
      if (!result.error && !result.waiting) await this.followUps(repo, stats, result);
      // Backfill.
      if (!result.error && !result.waiting && !meta().backfill.done) {
        for (let n = 0; n < (o.backfillPages ?? BACKFILL_PAGES_PER_RUN); n++) {
          const backfill = meta().backfill;
          const p = await page(backfill.after);
          if (!p) break;
          const from = windowStart();
          take(p, from);
          if (meta().highWater === null) set({ highWater: Math.max(0, ...p.nodes.map(node => seconds(node.updatedAt) ?? 0)) });
          const oldest = Math.min(...p.nodes.map(node => seconds(node.updatedAt) ?? Infinity));
          const done = !p.hasNext || !p.endCursor || oldest < from;
          set({ backfill: { after: done ? null : p.endCursor, done, coveredTo: done ? from : Number.isFinite(oldest) ? oldest : backfill.coveredTo } });
          if (done) break;
        }
        result.backfillDone = meta().backfill.done;
        if (!result.error && !result.waiting) await this.followUps(repo, stats, result);
      }
      if (!result.error && !result.waiting) set({ waiting: null });
      if (!result.error && result.pages > 0) set({ error: null });
    } finally {
      this.retain(stats);
      if (result.waiting) set({ waiting: { reason: result.waiting.reason, until: result.waiting.until === null ? null : Math.floor(result.waiting.until / 1000) } });
      set({ lastSyncAt: Math.floor(this.now() / 1000), lastCost: result.cost, lastPages: result.pages });
      this.o.store.save(stats);
    }
    return result;
  }

  /** Reads all reviews of PRs whose reviews ran past the page, REVIEWS_BATCH per query, through the gate. */
  private async followUps(repo: string, stats: RepoStats, result: SyncResult): Promise<void> {
    while (stats.meta.pendingReviews.length) {
      const batch = stats.meta.pendingReviews.slice(0, REVIEWS_BATCH);
      let answer;
      try {
        answer = await this.o.gate.run(repo.split("/")[0]!, async () => {
          const body = await this.o.api.graphql(repo, statsReviewsQuery(batch), { owner: repo.split("/")[0]!, name: repo.split("/")[1]! });
          return { value: body, rate: body?.data?.rateLimit as RateLimit | undefined };
        });
      } catch (error) { this.fail(stats, error, result); return; }
      if (!answer.ok) { result.waiting = { reason: answer.reason, until: answer.until }; return; }
      const body = answer.value as Node;
      result.pages++; result.cost += Number(body?.data?.rateLimit?.cost) || 0;
      const updated: StatsRecord[] = [];
      batch.forEach((n, i) => {
        const record = stats.records.get(n), node = body?.data?.repository?.[`p${i}`];
        if (record && Array.isArray(node?.reviews?.nodes)) updated.push(withAllReviews(record, node.reviews.nodes));
      });
      result.changed += this.o.store.merge(stats, updated);
      // A PR that came back without reviews (deleted, no access) isn't asked about again.
      stats.meta = { ...stats.meta, pendingReviews: stats.meta.pendingReviews.slice(batch.length) };
    }
  }

  /** Drops records older than the window, and the oldest past STATS_RECORDS_MAX. */
  private retain(stats: RepoStats): void {
    const from = Math.floor(this.now() / 1000) - stats.meta.windowDays * 86_400;
    for (const [n, r] of stats.records) if (r.u < from) stats.records.delete(n);
    if (stats.records.size > STATS_RECORDS_MAX) {
      const sorted = [...stats.records.values()].sort((a, b) => b.u - a.u);
      for (const r of sorted.slice(STATS_RECORDS_MAX)) stats.records.delete(r.n);
      stats.meta = { ...stats.meta, cappedTo: sorted[STATS_RECORDS_MAX - 1]!.u, backfill: { after: null, done: true, coveredTo: sorted[STATS_RECORDS_MAX - 1]!.u } };
    }
    const kept = new Set(stats.meta.pendingReviews.filter(n => stats.records.has(n)));
    if (kept.size !== stats.meta.pendingReviews.length) stats.meta = { ...stats.meta, pendingReviews: [...kept] };
  }

  private fail(stats: RepoStats, error: unknown, result: SyncResult): void {
    const e = error as { message?: string; rateLimited?: boolean; resetAt?: number };
    if (e?.rateLimited) { result.waiting = { reason: "budget", until: e.resetAt ?? null }; return; }
    const message = e?.message ?? String(error);
    result.error = message;
    stats.meta = { ...stats.meta, error: { message, status: status(error), at: Math.floor(this.now() / 1000) } };
    (this.o.log ?? console.warn)(`[follow-up] PR stats: reading ${stats.meta.repo} failed: ${message}`);
  }
}
