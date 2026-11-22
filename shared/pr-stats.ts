import type { StatsRecord } from "./pr-stats-records";

/**
 * PR statistics' metrics (docs/pr-stats.md, design §1): pure functions of the stored records, a period, the settings
 * and `now`. Every number is computed when it is read (invariant 68); nothing here keeps state.
 *
 * Shared rules:
 * - A person is a GitHub login. Bots were dropped when records were parsed; the repository's ignore list
 *   (`ignore`, case-insensitive, `*` wildcard) drops service accounts that look human, everywhere. A deleted user's PR
 *   (author null) counts in team totals only, never in a person's row.
 * - In the team: every person, or only the team filter's people when one is set.
 * - Every review clock starts at `reviewStart`, never at creation (invariant `stats-measure-from-the-ask`): the ask
 *   (`k`), and for a stacked PR (stack-aware, the default) not before its parent got its first response, or merged
 *   without one. A stacked PR whose parent is still waiting hasn't started its clock.
 * - Durations are calendar seconds, or working seconds (the overlap with one weekly schedule in one time zone).
 *   Aggregates are the nearest-rank median and p75 with n; with n < MIN_N a surface shows "-" and "n = 2".
 * - Times are epoch seconds.
 */
export const MIN_N = 3;
/** Below this many PRs a number is shown muted ("few PRs"). */
export const FEW_N = 5;
/** A waiting PR not updated for this long folds into "Stale (N)". */
export const STALE_S = 30 * 86_400;
/** Stacked PRs created this close together are one stack ("N PRs in K stacks"). */
export const STACK_GAP_S = 24 * 3600;
export const SIZE_BUCKETS = [["XS", 10], ["S", 50], ["M", 250], ["L", 1000], ["XL", Infinity]] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number][0];

export type Schedule = { days: number[]; from: number; to: number };
/** Mon–Fri 09:00–18:00 (minutes from local midnight; days 0 = Sunday). */
export const DEFAULT_HOURS: Schedule = { days: [1, 2, 3, 4, 5], from: 9 * 60, to: 18 * 60 };
export type Period = "week" | "last-week" | "30d" | "90d";
export const PERIODS: Period[] = ["week", "last-week", "30d", "90d"];
export type StatsOptions = {
  timeZone: string;
  /** 1 = Monday (default), 0 = Sunday. */
  weekStart?: number;
  /** Working hours for the working clock; calendar time when `clock` is "calendar". */
  clock?: "calendar" | "working";
  hours?: Schedule;
  ignore?: string[];
  /** Picked people; null or empty: everyone. */
  team?: string[] | null;
  stackAware?: boolean;
  defaultBranch?: string | null;
};
export type Range = { start: number; end: number };
export type Summary = { n: number; median: number | null; p75: number | null };

// ── Time zones ────────────────────────────────────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }); }
    formatters.set(timeZone, f);
  }
  return f;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** The local calendar fields of an instant in a time zone (an unknown zone reads as UTC). */
export function localParts(at: number, timeZone: string): { y: number; m: number; d: number; hour: number; minute: number; second: number; weekday: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(at * 1000))) parts[p.type] = p.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS[parts.weekday!] ?? 0 };
}
/** The zone's offset from UTC at an instant, in seconds. */
function offset(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  return (Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) / 1000) - at;
}
/** The instant a local wall-clock time happens (the later instant in a DST gap's repeat, the shifted one in a gap). */
export function zonedTime(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d) / 1000 + minutes * 60;
  let guess = wall - offset(wall, timeZone);
  guess = wall - offset(guess, timeZone);
  return guess;
}
const addDays = (y: number, m: number, d: number, days: number) => { const t = new Date(Date.UTC(y, m - 1, d + days)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

/** A period's `[start, end)` in the time zone (D9: This week, Last week, 30 days, 90 days). */
export function periodRange(period: Period, now: number, timeZone: string, weekStart = 1): Range {
  if (period === "30d" || period === "90d") return { start: now - (period === "30d" ? 30 : 90) * 86_400, end: now };
  const p = localParts(now, timeZone);
  const back = (p.weekday - weekStart + 7) % 7;
  const monday = addDays(p.y, p.m, p.d, -back);
  const start = zonedTime(monday.y, monday.m, monday.d, 0, timeZone);
  if (period === "week") return { start, end: now };
  const before = addDays(monday.y, monday.m, monday.d, -7);
  return { start: zonedTime(before.y, before.m, before.d, 0, timeZone), end: start };
}
/** The period of the same length right before (a comparison). */
export function previousRange(r: Range): Range { return { start: r.start - (r.end - r.start), end: r.start }; }

/**
 * Working seconds between two instants: the schedule's open intervals, one per scheduled local day (DST-aware: each
 * day's open and close are computed in the zone), with prefix sums, so a duration is two binary searches. Built for
 * one read (one model) and widened when an instant falls outside what it covers.
 */
export class WorkingClock {
  private opens: number[] = []; private closes: number[] = []; private before: number[] = [];
  private lo = Infinity; private hi = -Infinity;
  constructor(private schedule: Schedule, private timeZone: string) {}
  private build(lo: number, hi: number): void {
    this.lo = lo - 2 * 86_400; this.hi = hi + 2 * 86_400;
    const days = new Set(this.schedule.days);
    this.opens = []; this.closes = []; this.before = [];
    const first = localParts(this.lo, this.timeZone);
    let total = 0;
    for (let i = 0; ; i++) {
      const day = addDays(first.y, first.m, first.d, i);
      if (zonedTime(day.y, day.m, day.d, 0, this.timeZone) > this.hi) break;
      if (!days.has(new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay())) continue;
      const open = zonedTime(day.y, day.m, day.d, this.schedule.from, this.timeZone), close = zonedTime(day.y, day.m, day.d, this.schedule.to, this.timeZone);
      if (close <= open) continue;
      this.opens.push(open); this.closes.push(close); this.before.push(total);
      total += close - open;
    }
  }
  /** Working seconds from the start of what it covers to `t`. */
  private cumulative(t: number): number {
    let a = 0, b = this.opens.length - 1, i = -1;
    while (a <= b) { const mid = (a + b) >> 1; if (this.opens[mid]! <= t) { i = mid; a = mid + 1; } else b = mid - 1; }
    if (i < 0) return 0;
    return this.before[i]! + Math.min(t, this.closes[i]!) - this.opens[i]!;
  }
  between(from: number, to: number): number {
    if (to <= from) return 0;
    if (from < this.lo || to > this.hi) this.build(Math.min(from, this.lo === Infinity ? from : this.lo + 2 * 86_400), Math.max(to, this.hi === -Infinity ? to : this.hi - 2 * 86_400));
    return this.cumulative(to) - this.cumulative(from);
  }
}
/** Seconds of `[from, to)` inside the weekly schedule, in the time zone. */
export function workingSeconds(from: number, to: number, schedule: Schedule, timeZone: string): number {
  return new WorkingClock(schedule, timeZone).between(from, to);
}
/** The duration function a read measures with: calendar seconds, or working seconds on one clock built for the read. */
export function durationClock(o: Pick<StatsOptions, "clock" | "hours" | "timeZone">): (from: number, to: number) => number {
  if (o.clock !== "working") return (from, to) => Math.max(0, to - from);
  const clock = new WorkingClock(o.hours ?? DEFAULT_HOURS, o.timeZone);
  return (from, to) => clock.between(from, to);
}

// ── Aggregates ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The nearest-rank p-quantile: the ⌈p·n⌉-th smallest. */
export function nearestRank(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;
}
export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: nearestRank(sorted, 0.5), p75: nearestRank(sorted, 0.75) };
}
export function sizeBucket(lines: number): SizeBucket { return SIZE_BUCKETS.find(([, max]) => lines < max)![0]; }

// ── People ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a login is on the ignore list (case-insensitive, `*` matches anything). */
export function ignored(login: string, ignore: string[] = []): boolean {
  const l = login.toLowerCase();
  return ignore.some(pattern => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (!p.includes("*")) return p === l;
    return new RegExp(`^${p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(l);
  });
}

// ── Derived per record ────────────────────────────────────────────────────────────────────────────────────────────

type Derived = {
  record: StatsRecord;
  parent: StatsRecord | null;
  firstResponse: { at: number; by: string } | null;
  /** The review clock's start, or null (a draft, or a stacked PR whose parent hasn't been reached). */
  start: number | null;
  /** The stack this PR belongs to (its root's number), for "N PRs in K stacks". */
  stack: number;
};
/** The first response: the earliest review or comment by a person who isn't the author, ignored or a bot, at or after ready. */
export function firstResponse(r: StatsRecord, ignore: string[] = []): { at: number; by: string } | null {
  if (r.r === null) return null;
  let best: { at: number; by: string } | null = null;
  for (const [who, , ...times] of r.rv) {
    if (who === r.a || ignored(who, ignore)) continue;
    const t = times.find(x => x >= r.r!);
    if (t !== undefined && (!best || t < best.at)) best = { at: t, by: who };
  }
  for (const [who, t] of r.fc) {
    if (who === r.a || ignored(who, ignore) || t < r.r) continue;
    if (!best || t < best.at) best = { at: t, by: who };
  }
  return best;
}

/**
 * Each record's parent PR (a stack): its base isn't the default branch and is another PR's head. When several PRs
 * used that head, the newest created at or before it.
 */
export function stackParents(records: Iterable<StatsRecord>, defaultBranch: string | null | undefined): Map<number, StatsRecord> {
  const byHead = new Map<string, StatsRecord[]>();
  const all = [...records];
  for (const r of all) { const list = byHead.get(r.h); if (list) list.push(r); else byHead.set(r.h, [r]); }
  const parents = new Map<number, StatsRecord>();
  for (const r of all) {
    if (!r.b || r.b === defaultBranch || r.s === "C") continue;
    const candidates = (byHead.get(r.b) ?? []).filter(p => p.n !== r.n);
    if (!candidates.length) continue;
    const before = candidates.filter(p => p.c <= r.c).sort((a, b) => b.c - a.c);
    parents.set(r.n, before[0] ?? candidates.sort((a, b) => b.c - a.c)[0]!);
  }
  return parents;
}

export function derive(records: Iterable<StatsRecord>, o: StatsOptions): Map<number, Derived> {
  const all = [...records];
  const ignore = o.ignore ?? [];
  const parents = stackParents(all, o.defaultBranch ?? null);
  const out = new Map<number, Derived>();
  for (const r of all) out.set(r.n, { record: r, parent: parents.get(r.n) ?? null, firstResponse: firstResponse(r, ignore), start: null, stack: r.n });
  const stackAware = o.stackAware ?? true;
  for (const d of out.values()) {
    const k = d.record.k;
    if (k === null) continue;
    if (!stackAware || !d.parent) { d.start = k; continue; }
    const parent = out.get(d.parent.n);
    const reached = parent?.firstResponse?.at ?? d.parent.m;
    d.start = reached === null || reached === undefined ? null : Math.max(k, reached);
  }
  // Stacks: parent chains whose PRs were created within STACK_GAP_S of each other.
  const root = (n: number, seen = new Set<number>()): number => {
    const d = out.get(n)!;
    if (!d.parent || seen.has(n) || !out.has(d.parent.n) || Math.abs(d.record.c - d.parent.c) > STACK_GAP_S) return n;
    seen.add(n);
    return root(d.parent.n, seen);
  };
  for (const d of out.values()) d.stack = root(d.record.n);
  return out;
}

// ── The model ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PersonRow = {
  login: string;
  /** M1, and how many stacks those PRs make (a lone PR is a stack of one). */
  opened: number; openedStacks: number;
  /** M2. */
  merged: number;
  /** M3 of their PRs (they waited). */
  wait: Summary;
  /** M5: distinct PRs of others they reviewed first in the period. */
  reviews: number; reviewStacks: number;
  /** M6: from a request naming them to their next review. */
  turnaround: Summary;
};
export type WaitingRow = { number: number; author: string | null; title: string; since: number; wait: number; size: SizeBucket; lines: number; requested: string[]; above: number };
export type TeamNumbers = {
  opened: number; openedStacks: number; merged: number;
  wait: Summary; timeToMerge: Summary; reviewToMerge: Summary;
  waitingNow: number; reviews: number; mergedWithoutReview: number;
  /** PRs by deleted users in the period (in totals, never a row), and bot PRs left out. */
  deletedUsers: number; bots: number;
  sizes: Record<SizeBucket, number>;
};
export type StatsModel = { range: Range; team: TeamNumbers; people: PersonRow[]; waiting: WaitingRow[]; stale: number };

const inRange = (t: number | null, r: Range) => t !== null && t >= r.start && t < r.end;

/** Everything the leaderboard, its header and `pr_stats` show for one period. */
export function statsModel(records: Iterable<StatsRecord>, range: Range, now: number, o: StatsOptions): StatsModel {
  const ignore = o.ignore ?? [];
  const team = o.team?.length ? new Set(o.team.map(l => l.toLowerCase())) : null;
  const person = (login: string | null): login is string => !!login && !ignored(login, ignore) && (!team || team.has(login.toLowerCase()));
  const clock = durationClock(o);
  const derived = derive(records, o);
  const rows = new Map<string, { opened: Set<number>; stacks: Set<number>; merged: number; waits: number[]; reviewed: Set<number>; reviewedStacks: Set<number>; turnarounds: number[] }>();
  const row = (login: string) => { let r = rows.get(login); if (!r) { r = { opened: new Set(), stacks: new Set(), merged: 0, waits: [], reviewed: new Set(), reviewedStacks: new Set(), turnarounds: [] }; rows.set(login, r); } return r; };
  const t: TeamNumbers = { opened: 0, openedStacks: 0, merged: 0, wait: summarize([]), timeToMerge: summarize([]), reviewToMerge: summarize([]), waitingNow: 0, reviews: 0, mergedWithoutReview: 0, deletedUsers: 0, bots: 0, sizes: { XS: 0, S: 0, M: 0, L: 0, XL: 0 } };
  const teamStacks = new Set<number>(), waits: number[] = [], toMerge: number[] = [], reviewToMerge: number[] = [];
  const waitingAll: (WaitingRow & { updated: number; parentWaiting: number | null })[] = [];
  for (const d of derived.values()) {
    const r = d.record;
    if (r.ab) { if (inRange(r.c, range)) t.bots++; continue; }
    const author = r.a;
    const counted = author === null || person(author);
    if (author === null && inRange(r.c, range)) t.deletedUsers++;
    if (counted && inRange(r.c, range)) {
      t.opened++; teamStacks.add(d.stack); t.sizes[sizeBucket(r.add + r.del)]++;
      if (author) { const p = row(author); p.opened.add(r.n); p.stacks.add(d.stack); }
    }
    if (counted && r.s === "M" && inRange(r.m, range)) {
      t.merged++;
      if (author) row(author).merged++;
      const askedFrom = d.record.k !== null ? (d.parent && (o.stackAware ?? true) && d.parent.m !== null ? Math.max(d.record.k, d.parent.m) : d.record.k) : null;
      if (askedFrom !== null) toMerge.push(clock(askedFrom, r.m!));
      if (d.firstResponse && d.firstResponse.at < r.m!) reviewToMerge.push(clock(d.firstResponse.at, r.m!)); else t.mergedWithoutReview++;
    }
    // M3: the author waited from the clock's start to the first response.
    if (counted && d.firstResponse && d.start !== null && inRange(d.firstResponse.at, range)) {
      const w = clock(d.start, d.firstResponse.at);
      waits.push(w);
      if (author) row(author).waits.push(w);
    }
    // M4: waiting now (independent of the period).
    if (counted && r.s === "O" && !r.d && !d.firstResponse) {
      if (d.start !== null) waitingAll.push({ number: r.n, author, title: r.t, since: d.start, wait: clock(d.start, now), size: sizeBucket(r.add + r.del), lines: r.add + r.del, requested: requestedNow(r), above: 0, updated: r.u, parentWaiting: null });
      else if (r.k !== null && d.parent) waitingAll.push({ number: r.n, author, title: r.t, since: r.k, wait: 0, size: sizeBucket(r.add + r.del), lines: r.add + r.del, requested: requestedNow(r), above: 0, updated: r.u, parentWaiting: d.parent.n });
    }
    // M5 and M6: per reviewer.
    for (const [who, , ...times] of r.rv) {
      if (who === author || !person(who)) continue;
      const first = times[0];
      if (first !== undefined && inRange(first, range)) { const p = row(who); p.reviewed.add(r.n); p.reviewedStacks.add(d.stack); t.reviews++; }
    }
    for (const [target, asked] of r.rq) {
      if (target.startsWith("@") || target === author || !person(target)) continue;
      const from = Math.max(asked, r.r ?? asked, d.start ?? asked);
      const review = r.rv.find(([who]) => who === target);
      const answer = review ? (review.slice(2) as number[]).find(x => x >= from) : undefined;
      if (answer === undefined || !inRange(answer, range)) continue;
      if ((r.rr ?? []).some(([who, at]) => who === target && at >= asked && at <= answer)) continue;
      row(target).turnarounds.push(clock(from, answer));
    }
  }
  t.openedStacks = teamStacks.size;
  t.wait = summarize(waits); t.timeToMerge = summarize(toMerge); t.reviewToMerge = summarize(reviewToMerge);
  // Fold a stacked PR whose parent is still waiting under that parent ("#412 + 6 above in its stack").
  const shown = new Map<number, WaitingRow & { updated: number; parentWaiting: number | null }>();
  for (const w of waitingAll) if (w.parentWaiting === null) shown.set(w.number, w);
  for (const w of waitingAll) {
    if (w.parentWaiting === null) continue;
    let n: number | null = w.parentWaiting; const seen = new Set<number>();
    while (n !== null && !shown.has(n) && !seen.has(n)) { seen.add(n); n = derived.get(n)?.parent?.n ?? null; }
    if (n !== null && shown.has(n)) shown.get(n)!.above++;
  }
  const fresh = [...shown.values()].filter(w => now - w.updated <= STALE_S);
  const waiting = fresh.sort((a, b) => b.wait - a.wait || a.number - b.number).map(({ updated: _u, parentWaiting: _p, ...w }) => w);
  t.waitingNow = waiting.length;
  const people: PersonRow[] = [...rows].map(([login, p]) => ({ login, opened: p.opened.size, openedStacks: p.stacks.size, merged: p.merged, wait: summarize(p.waits), reviews: p.reviewed.size, reviewStacks: p.reviewedStacks.size, turnaround: summarize(p.turnarounds) }))
    .filter(p => p.opened || p.merged || p.wait.n || p.reviews || p.turnaround.n)
    .sort((a, b) => b.opened - a.opened || b.merged - a.merged || a.login.localeCompare(b.login));
  return { range, team: t, people, waiting, stale: shown.size - fresh.length };
}
/** Who a PR is waiting on: requested now (requests minus removals), people and teams. */
function requestedNow(r: StatsRecord): string[] {
  const out = new Map<string, number>();
  for (const [who, at] of r.rq) out.set(who, Math.max(out.get(who) ?? 0, at));
  for (const [who, at] of r.rr ?? []) if ((out.get(who) ?? Infinity) <= at) out.delete(who);
  return [...out.keys()];
}

export type PersonPr = { number: number; title: string; state: StatsRecord["s"]; created: number; wait: number | null; waiting: boolean; firstResponder: string | null; merged: number | null; size: SizeBucket };
export type PersonDetail = { login: string; row: PersonRow | null; prs: PersonPr[]; reviewed: { number: number; author: string | null; title: string; at: number }[] };
/** One person's drill-down: their PRs in the period (with their waits) and the reviews they gave. */
export function personDetail(records: Iterable<StatsRecord>, login: string, range: Range, now: number, o: StatsOptions): PersonDetail {
  const all = [...records];
  const model = statsModel(all, range, now, o);
  const derived = derive(all, o);
  const clock = durationClock(o);
  const prs: PersonPr[] = [], reviewed: PersonDetail["reviewed"] = [];
  const me = login.toLowerCase();
  for (const d of derived.values()) {
    const r = d.record;
    if (r.a?.toLowerCase() === me && (inRange(r.c, range) || inRange(r.m, range) || inRange(d.firstResponse?.at ?? null, range) || (r.s === "O" && !d.firstResponse))) {
      const waiting = r.s === "O" && !r.d && !d.firstResponse && d.start !== null;
      prs.push({ number: r.n, title: r.t, state: r.s, created: r.c, wait: d.start === null ? null : d.firstResponse ? clock(d.start, d.firstResponse.at) : waiting ? clock(d.start, now) : null, waiting, firstResponder: d.firstResponse?.by ?? null, merged: r.m, size: sizeBucket(r.add + r.del) });
    }
    const mine = r.rv.find(([who]) => who.toLowerCase() === me);
    if (mine && r.a?.toLowerCase() !== me && inRange(mine[2] ?? null, range)) reviewed.push({ number: r.n, author: r.a, title: r.t, at: mine[2]! });
  }
  prs.sort((a, b) => b.created - a.created); reviewed.sort((a, b) => b.at - a.at);
  return { login, row: model.people.find(p => p.login.toLowerCase() === me) ?? null, prs, reviewed };
}
