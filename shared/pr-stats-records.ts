import { z } from "zod";

/**
 * PR statistics (docs/pr-stats.md): the compact record kept per PR of an opted-in repository, and how it is parsed
 * from the one GraphQL query the sync reads (`STATS_PAGE_QUERY`, server/pr-stats-sync.ts).
 *
 * What a record holds is the privacy line: numbers, times, logins, branch names and a PR title capped at
 * `TITLE_MAX`. Never a body, a comment's text, a diff or a file list (`stats-records-hold-no-text`,
 * tests/pr-stats-privacy.test.ts). Times are epoch seconds. Bots are dropped at parse time wherever they act on a PR
 * (reviews, comments, requests); a bot's own PR is kept with `ab` so totals can say how many were left out. A
 * repository's ignore list (service accounts that look human) is applied when metrics are computed, so changing it
 * needs no re-read.
 */
export const TITLE_MAX = 120;
/** Review times kept per reviewer per PR: the first response and later re-reviews (review turnaround, M6). */
export const REVIEW_TIMES_MAX = 10;
/** The default page size; a 502 or RESOURCE_LIMITS answer halves it for that repository until a page succeeds. */
export const STATS_PAGE_SIZE = 25;
export const STATS_PAGE_MIN = 5;
/** Reviews, comments and timeline events per PR in the page query (design §2.2, measured). */
export const PAGE_REVIEWS = 20;
export const PAGE_COMMENTS = 10;
export const PAGE_TIMELINE = 25;

/** Record flags (bits). */
export const FLAG = {
  /** More reviews than the page read; a follow-up query reads the rest (`REVIEWS_FOLLOW_UP`). Cleared once read. */
  reviewsTruncated: 1,
  /** The first PAGE_COMMENTS comments were all the author's or bots' and there are more: the first response is from reviews only. */
  commentsTruncated: 2,
  /** More draft/ready/request events than the page read: readyAt and askedAt come from the first PAGE_TIMELINE. */
  timelineTruncated: 4,
} as const;

const at = z.number().int().nonnegative();
const login = z.string().min(1).max(100);
/**
 * One PR. Short keys: a 50-person team's 90 days are ~3,250 of these (~1 MB on disk).
 * - `n` number, `a` author login (null: a deleted user, "ghost"), `ab` 1 when the author is a bot.
 * - `t` title (≤ TITLE_MAX), `c` createdAt, `u` updatedAt, `r` readyAt (null: still a draft, never ready),
 *   `k` askedAt (the first review request at or after readyAt, else readyAt), `m` mergedAt, `x` closedAt.
 * - `s` state O/M/C, `d` draft now, `add`/`del`/`f` lines added/deleted and files changed, `b` base, `h` head.
 * - `rq` review requests `[target, at]` (a user's login, or `@slug` for a team), `rr` requests removed.
 * - `rv` reviews `[login, firstState, ...times]` per non-author person, times ascending (≤ REVIEW_TIMES_MAX);
 *   states A approved, C changes requested, M commented, D dismissed.
 * - `fc` first comment `[login, at]` per non-author person, at or after readyAt (all of them while it's a draft).
 */
export const statsRecordSchema = z.object({
  n: z.number().int().positive(),
  a: login.nullable(),
  ab: z.literal(1).optional(),
  t: z.string().max(TITLE_MAX),
  c: at, u: at,
  r: at.nullable(), k: at.nullable(),
  m: at.nullable(), x: at.nullable(),
  s: z.enum(["O", "M", "C"]),
  d: z.boolean(),
  add: z.number().int().nonnegative(), del: z.number().int().nonnegative(), f: z.number().int().nonnegative(),
  b: z.string(), h: z.string(),
  rq: z.array(z.tuple([z.string().min(1), at])),
  rr: z.array(z.tuple([z.string().min(1), at])).optional(),
  rv: z.array(z.tuple([login, z.enum(["A", "C", "M", "D"])]).rest(at)),
  fc: z.array(z.tuple([login, at])),
  fl: z.number().int().nonnegative().optional(),
}).strict();
export type StatsRecord = z.infer<typeof statsRecordSchema>;

type Node = Record<string, any>;
const seconds = (iso: unknown): number | null => { if (typeof iso !== "string") return null; const ms = Date.parse(iso); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };
/** A bot by GitHub's own type, or a login ending in `[bot]`. The ignore list is applied later (metrics). */
export function isBotActor(actor: Node | null | undefined): boolean {
  if (!actor) return false;
  return actor.__typename === "Bot" || (typeof actor.login === "string" && /\[bot\]$/i.test(actor.login));
}
const STATE = { OPEN: "O", MERGED: "M", CLOSED: "C" } as const;
const REVIEW = { APPROVED: "A", CHANGES_REQUESTED: "C", COMMENTED: "M", DISMISSED: "D" } as const;

/** When the PR stopped being a draft for the first time (design §1.1), or null while it never has. */
export function readyAtOf(createdAt: number, isDraft: boolean, events: { type: "ready" | "draft"; at: number }[]): number | null {
  const sorted = [...events].sort((p, q) => p.at - q.at);
  const first = sorted[0];
  if (first?.type === "ready") return first.at;
  if (isDraft && !sorted.some(e => e.type === "ready")) return null;
  return createdAt;
}

/** Parses one PR node of the page query into a record. Throws on a node without the fields every record needs. */
export function parseStatsRecord(node: Node): StatsRecord {
  const number = node.number, c = seconds(node.createdAt), u = seconds(node.updatedAt);
  if (!Number.isInteger(number) || number <= 0 || c === null || u === null) throw new Error("A PR in GitHub's answer has no number or times");
  const author: string | null = typeof node.author?.login === "string" ? node.author.login : null;
  const timeline: Node[] = node.timelineItems?.nodes ?? [];
  const draftEvents = timeline.flatMap((e): { type: "ready" | "draft"; at: number }[] => {
    const t = seconds(e?.createdAt);
    if (t === null) return [];
    return e.__typename === "ReadyForReviewEvent" ? [{ type: "ready", at: t }] : e.__typename === "ConvertToDraftEvent" ? [{ type: "draft", at: t }] : [];
  });
  const r = readyAtOf(c, !!node.isDraft, draftEvents);
  const target = (reviewer: Node | null | undefined): string | null => {
    if (!reviewer) return null;
    if (reviewer.__typename === "Team" && typeof reviewer.slug === "string") return `@${reviewer.slug}`;
    if (typeof reviewer.login === "string" && !isBotActor(reviewer)) return reviewer.login;
    return null;
  };
  const requests: [string, number][] = [], removed: [string, number][] = [];
  for (const e of timeline) {
    const t = seconds(e?.createdAt), who = target(e?.requestedReviewer);
    if (t === null || !who) continue;
    if (e.__typename === "ReviewRequestedEvent") requests.push([who, t]);
    else if (e.__typename === "ReviewRequestRemovedEvent") removed.push([who, t]);
  }
  requests.sort((p, q) => p[1] - q[1]); removed.sort((p, q) => p[1] - q[1]);
  // A request made while it was a draft counts from readyAt; none at all: being ready is the ask.
  const k = r === null ? null : requests.length ? Math.max(requests[0]![1], r) : r;

  const reviews = new Map<string, { state: StatsRecord["rv"][number][1]; times: number[] }>();
  const reviewNodes: Node[] = [...(node.reviews?.nodes ?? [])].sort((p, q) => (seconds(p?.submittedAt) ?? 0) - (seconds(q?.submittedAt) ?? 0));
  for (const review of reviewNodes) addReview(reviews, review, author);
  const comments = new Map<string, number>();
  for (const comment of node.comments?.nodes ?? []) {
    const t = seconds(comment?.createdAt), who = comment?.author?.login;
    if (t === null || typeof who !== "string" || who === author || isBotActor(comment.author)) continue;
    if (r !== null && t < r) continue;
    if (!comments.has(who) || comments.get(who)! > t) comments.set(who, t);
  }
  let fl = 0;
  if ((node.reviews?.totalCount ?? 0) > (node.reviews?.nodes?.length ?? 0)) fl |= FLAG.reviewsTruncated;
  if ((node.comments?.totalCount ?? 0) > (node.comments?.nodes?.length ?? 0) && comments.size === 0) fl |= FLAG.commentsTruncated;
  if (node.timelineItems?.pageInfo?.hasNextPage) fl |= FLAG.timelineTruncated;
  const record: StatsRecord = {
    n: number, a: author, ...(isBotActor(node.author) ? { ab: 1 as const } : {}),
    t: typeof node.title === "string" ? node.title.slice(0, TITLE_MAX) : "",
    c, u, r, k, m: seconds(node.mergedAt), x: seconds(node.closedAt),
    s: STATE[node.state as keyof typeof STATE] ?? "O", d: !!node.isDraft,
    add: count(node.additions), del: count(node.deletions), f: count(node.changedFiles),
    b: typeof node.baseRefName === "string" ? node.baseRefName : "", h: typeof node.headRefName === "string" ? node.headRefName : "",
    rq: requests, ...(removed.length ? { rr: removed } : {}),
    rv: reviewList(reviews),
    fc: [...comments].sort((p, q) => p[1] - q[1]),
    ...(fl ? { fl } : {}),
  };
  return record;
}
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 ? v as number : 0;
function addReview(reviews: Map<string, { state: StatsRecord["rv"][number][1]; times: number[] }>, review: Node, author: string | null): void {
  const t = seconds(review?.submittedAt), who = review?.author?.login, state = REVIEW[review?.state as keyof typeof REVIEW];
  // PENDING (an unsubmitted draft review) has no submittedAt and no state here: never a response.
  if (t === null || typeof who !== "string" || !state || who === author || isBotActor(review.author)) return;
  const entry = reviews.get(who);
  if (!entry) { reviews.set(who, { state, times: [t] }); return; }
  if (!entry.times.includes(t)) entry.times.push(t);
  entry.times.sort((p, q) => p - q);
  if (entry.times[0] === t) entry.state = state;
  if (entry.times.length > REVIEW_TIMES_MAX) entry.times.length = REVIEW_TIMES_MAX;
}
function reviewList(reviews: Map<string, { state: StatsRecord["rv"][number][1]; times: number[] }>): StatsRecord["rv"] {
  return [...reviews].map(([who, { state, times }]) => [who, state, ...times] as StatsRecord["rv"][number]).sort((p, q) => (p[2] ?? 0) - (q[2] ?? 0));
}

/** Merges the reviews a follow-up query read (all of a PR's reviews) into its record and clears the truncation flag. */
export function withAllReviews(record: StatsRecord, reviewNodes: Node[]): StatsRecord {
  const reviews = new Map<string, { state: StatsRecord["rv"][number][1]; times: number[] }>();
  for (const [who, state, ...times] of record.rv) reviews.set(who, { state, times: [...times] });
  const sorted = [...reviewNodes].sort((p, q) => (seconds(p?.submittedAt) ?? 0) - (seconds(q?.submittedAt) ?? 0));
  for (const review of sorted) addReview(reviews, review, record.a);
  const fl = (record.fl ?? 0) & ~FLAG.reviewsTruncated;
  const { fl: _old, ...rest } = record;
  return { ...rest, rv: reviewList(reviews), ...(fl ? { fl } : {}) };
}
