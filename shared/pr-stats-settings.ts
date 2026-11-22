import { z } from "zod";
import { DEFAULT_HOURS, PERIODS } from "./pr-stats";

/**
 * PR statistics' settings (`stats.json`, docs/pr-stats.md): which repositories are on, per repository its window,
 * team filter and ignore list, and the host-wide clock, slice and time zone. Agents read them with `pr_stats_settings`
 * and change them with `set_pr_stats` (invariant 3); the developer in Settings → Following → PR statistics.
 *
 * Nothing is built in (invariant 24): an empty install has no repository on, no team and no names.
 */
export const STATS_TEAM_MAX = 200;
export const STATS_IGNORE_MAX = 100;
/** A week's days in a working-hours schedule. */
export const SCHEDULE_DAYS_MAX = 7;
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const statsRepoName = z.string().trim().regex(REPO, "Use owner/repo.").refine(r => !r.split("/").some(p => p === "." || p === ".."), "Use owner/repo.");
const login = z.string().trim().min(1).max(100).regex(/^[\w.[\]-]+$/, "A GitHub login");
/** An ignore pattern: a login, `*` matching anything (`renovate*`). */
const pattern = z.string().trim().min(1).max(100).regex(/^[\w.[\]*-]+$/, "A login, with * as a wildcard");
export const STATS_WINDOW_DAYS = [30, 90, 180] as const;
export const statsTeamSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("people"), logins: z.array(login).min(1).max(STATS_TEAM_MAX) }),
  /** A GitHub team, `org/slug`; read once a day. A token that can't read it shows everyone, and says so. */
  z.object({ kind: z.literal("github"), team: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "Use org/team-slug.") }),
]);
export type StatsTeam = z.infer<typeof statsTeamSchema>;
const scheduleSchema = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(SCHEDULE_DAYS_MAX), from: z.number().int().min(0).max(1439), to: z.number().int().min(1).max(1440) }).refine(s => s.to > s.from, "Hours end after they start.");
const at = z.number().int().nonnegative();

/** What the last sync left, kept here so Settings and `pr_stats_settings` never load a repository's records. */
export const statsStatusSchema = z.object({
  records: z.number().int().nonnegative(),
  coveredTo: at.nullable(), backfillDone: z.boolean(),
  lastSyncAt: at.nullable(), lastCost: z.number().nonnegative(),
  waiting: z.object({ reason: z.enum(["governor", "budget", "slice", "busy"]), until: at.nullable() }).nullable(),
  error: z.object({ message: z.string(), status: z.number().int().nullable(), at }).nullable(),
  cappedTo: at.nullable(),
  /** The GitHub team filter's members as last read, or why they couldn't be. */
  teamMembers: z.object({ team: z.string(), logins: z.array(login).max(STATS_TEAM_MAX).nullable(), error: z.string().nullable(), at }).nullable().optional(),
}).strict();
export type StatsStatus = z.infer<typeof statsStatusSchema>;

export const statsRepoSettingsSchema = z.object({
  /** On: synced and shown. Off with data kept: "Paused · data up to <date>". Deleting removes the entry. */
  enable_stats: z.boolean(),
  windowDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).default(90),
  team: statsTeamSchema.default({ kind: "everyone" }),
  ignore: z.array(pattern).max(STATS_IGNORE_MAX).default([]),
  enabledAt: at.nullable().default(null),
  /** The estimate shown when it was turned on: PRs changed in the window and the points reading them costs. */
  estimate: z.object({ prs: z.number().int().nonnegative(), points: z.number().int().nonnegative(), at }).nullable().default(null),
  status: statsStatusSchema.nullable().default(null),
}).strict();
export type StatsRepoSettings = z.infer<typeof statsRepoSettingsSchema>;

export const statsSettingsSchema = z.object({
  repos: z.record(statsRepoName, statsRepoSettingsSchema).default({}),
  /** The share of GitHub's hourly limit stats may spend in any rolling hour (D3: 5 %). */
  slice: z.number().min(0.01).max(0.1).default(0.05),
  /** D4: calendar time by default; working hours on one weekly schedule in one zone. */
  clock: z.enum(["calendar", "working"]).default("calendar"),
  hours: scheduleSchema.default(DEFAULT_HOURS),
  /** null: the developer's device zone (`follow.client-time-zone`), else UTC. */
  timeZone: z.string().min(1).max(64).nullable().default(null),
  weekStart: z.union([z.literal(0), z.literal(1)]).default(1),
  /** D5: stacked PRs start their clocks when their parent was reached. */
  enable_stack_aware: z.boolean().default(true),
}).strict();
export type StatsSettings = z.infer<typeof statsSettingsSchema>;
export const emptyStatsSettings = (): StatsSettings => statsSettingsSchema.parse({});

/** `set_pr_stats` and Settings' writes. Per repository: `enable` (true needs a confirmed plan's estimate shown first), `delete` with `enable: false`, `windowDays`, `team`, `ignore`; host-wide: `slice`, `clock`, `hours`, `timeZone`, `weekStart`, `enable_stack_aware`. */
export const setPrStatsInputSchema = z.object({
  repo: statsRepoName.optional(),
  enable: z.boolean().optional(),
  delete: z.boolean().optional(),
  windowDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).optional(),
  team: statsTeamSchema.optional(),
  ignore: z.array(pattern).max(STATS_IGNORE_MAX).optional(),
  slice: z.number().min(0.01).max(0.1).optional(),
  clock: z.enum(["calendar", "working"]).optional(),
  hours: scheduleSchema.optional(),
  timeZone: z.string().min(1).max(64).nullable().optional(),
  weekStart: z.union([z.literal(0), z.literal(1)]).optional(),
  enable_stack_aware: z.boolean().optional(),
}).strict();
export type SetPrStatsInput = z.infer<typeof setPrStatsInputSchema>;

/** The opt-in sheet's numbers: PRs changed in the window (`search(issueCount)`, 1 point) and what reading them costs. */
export const statsEstimateSchema = z.object({
  repo: z.string(),
  prs: z.number().int().nonnegative().nullable(),
  /** ~1 point per page of 25, plus review follow-ups. */
  points: z.number().int().nonnegative().nullable(),
  slicePoints: z.number().int().nonnegative(),
  /** About 320 bytes a PR. */
  bytes: z.number().int().nonnegative().nullable(),
  /** Why there is no estimate: the repository can't be read, or the gate is closed. */
  error: z.string().nullable(),
});
export type StatsEstimate = z.infer<typeof statsEstimateSchema>;

export const statsRepoRowSchema = z.object({
  repo: z.string(),
  /** off: never on (or deleted); on; paused: off with data kept. */
  state: z.enum(["off", "on", "paused"]),
  settings: statsRepoSettingsSchema.nullable(),
});
export const statsSettingsViewSchema = z.object({
  settings: statsSettingsSchema,
  /** Every repository Follow-up knows (tracked PRs, project remotes, settings) and every one with stats. */
  repos: z.array(statsRepoRowSchema),
  /** The zone numbers are computed in. */
  timeZone: z.string(),
  estimate: statsEstimateSchema.nullable(),
});
export type StatsSettingsView = z.infer<typeof statsSettingsViewSchema>;

export const prStatsInputSchema = z.object({
  repo: statsRepoName.optional(),
  period: z.enum(PERIODS as [string, ...string[]]).optional(),
  /** One person's drill-down. */
  person: login.optional(),
  clock: z.enum(["calendar", "working"]).optional(),
  /** One incremental sync now, still through the gate. */
  fresh: z.boolean().optional(),
}).strict();
const summary = z.object({ n: z.number().int(), median: z.number().nullable(), p75: z.number().nullable() });
const person = z.object({ login: z.string(), opened: z.number().int(), openedStacks: z.number().int(), merged: z.number().int(), wait: summary, reviews: z.number().int(), reviewStacks: z.number().int(), turnaround: summary });
export const prStatsOutputSchema = z.object({
  repo: z.string().nullable(),
  /** Repositories with stats (on or paused), for the repo picker. */
  repos: z.array(z.object({ repo: z.string(), state: z.enum(["on", "paused"]) })),
  period: z.string(),
  range: z.object({ start: z.number(), end: z.number() }),
  clock: z.enum(["calendar", "working"]),
  timeZone: z.string(),
  hours: scheduleSchema,
  model: z.object({
    team: z.object({ opened: z.number().int(), openedStacks: z.number().int(), merged: z.number().int(), wait: summary, timeToMerge: summary, reviewToMerge: summary, waitingNow: z.number().int(), reviews: z.number().int(), mergedWithoutReview: z.number().int(), deletedUsers: z.number().int(), bots: z.number().int(), sizes: z.record(z.string(), z.number().int()) }),
    people: z.array(person),
    /** Waiting for a first review now, longest first, each with its PR url (invariant 23). */
    waiting: z.array(z.object({ number: z.number().int(), url: z.string(), author: z.string().nullable(), title: z.string(), since: z.number(), wait: z.number(), size: z.string(), lines: z.number().int(), requested: z.array(z.string()), above: z.number().int() })),
    stale: z.number().int(),
  }).nullable(),
  person: z.object({
    login: z.string(), row: person.nullable(),
    prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string(), state: z.string(), created: z.number(), wait: z.number().nullable(), waiting: z.boolean(), firstResponder: z.string().nullable(), merged: z.number().nullable(), size: z.string() })),
    reviewed: z.array(z.object({ number: z.number().int(), url: z.string(), author: z.string().nullable(), title: z.string(), at: z.number() })),
  }).nullable(),
  /** Sync state: honest coverage ("so far" until it reaches the period's start), why it waits, the last error. */
  sync: z.object({ records: z.number().int(), coveredTo: z.number().nullable(), backfillDone: z.boolean(), coversPeriod: z.boolean(), lastSyncAt: z.number().nullable(), waiting: statsStatusSchema.shape.waiting, error: statsStatusSchema.shape.error, cappedTo: z.number().nullable() }).nullable(),
  /** A GitHub team filter the token can't read: shown as everyone, with this line. */
  teamNotice: z.string().nullable(),
  /** No repository on, or none named: what to do. */
  empty: z.string().nullable(),
});
export type PrStatsOutput = z.infer<typeof prStatsOutputSchema>;

// ── Words (Settings, the opt-in sheet, pr_stats_settings) ──────────────────────────────────────────────────────────

const shortDate = (s: number, timeZone: string) => { try { return new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }); } catch { return new Date(s * 1000).toISOString().slice(0, 10); } };
const count = (n: number) => n.toLocaleString("en-US");
export const sizeWords = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
/** One repository's line in Settings: "On · 3,248 PRs · 90 days · 1.0 MB", "On · reading · back to Oct 3", "Paused · data up to Nov 2", "Off". */
export function statsRepoLine(row: z.infer<typeof statsRepoRowSchema>, timeZone: string): string {
  const s = row.settings, st = s?.status ?? null;
  if (row.state === "off" || !s) return "Off";
  if (row.state === "paused") return st?.lastSyncAt ? `Paused · data up to ${shortDate(st.lastSyncAt, timeZone)}` : "Paused";
  if (!st || st.lastSyncAt === null) return `On · ${s.windowDays} days · first read starting`;
  const parts = ["On"];
  if (!st.backfillDone) parts.push(st.coveredTo ? `reading · back to ${shortDate(st.coveredTo, timeZone)}` : "reading");
  parts.push(`${count(st.records)} PR${st.records === 1 ? "" : "s"}`);
  if (s.estimate && !st.backfillDone) parts[parts.length - 1] = `≈ ${count(st.records)} of ${count(s.estimate.prs)} PRs`;
  parts.push(`${s.windowDays} days`, sizeWords(st.records * 320));
  return parts.join(" · ");
}
/** Why a repository's stats aren't reading right now, in the page's words; null when nothing holds them. */
export function statsRepoWait(row: z.infer<typeof statsRepoRowSchema>): string | null {
  const st = row.settings?.status;
  if (!st || row.state !== "on") return null;
  if (st.error) return `Can't read ${row.repo}${st.error.status ? ` (HTTP ${st.error.status}: ${st.error.message})` : ` (${st.error.message})`}.`;
  if (!st.waiting) return null;
  const at = st.waiting.until ? new Date(st.waiting.until * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  return st.waiting.reason === "budget" ? `GitHub limit low · updates again${at ? ` at ${at}` : " after GitHub's reset"}.`
    : st.waiting.reason === "governor" ? "Paused while this machine is busy."
    : st.waiting.reason === "slice" ? `Paused · stats used their share of GitHub's limit this hour${at ? ` · next read ${at}` : ""}.`
    : null;
}
/** The opt-in sheet's cost line. */
export function estimateLines(e: StatsEstimate, slice: number): { cost: string; time: string } | null {
  if (e.prs === null || e.points === null) return null;
  const perHour = Math.max(1, e.slicePoints);
  const hours = e.points / perHour;
  const time = hours <= 1 ? "About an hour or less." : `About ${Math.ceil(hours)} hours.`;
  return { cost: `Reading them costs about ${count(e.points)} GitHub points, spread so stats never use more than ${Math.round(slice * 100)}% of your hourly limit (${count(e.slicePoints)} points).`, time };
}
