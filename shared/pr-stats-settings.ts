import { z } from "zod";
import { PERIODS } from "./pr-stats";

/**
 * PR statistics' settings (`stats.json`, docs/pr-stats.md): which repositories are on, per repository its window,
 * team filter and ignore list, and the host-wide clock, slice and time zone. Agents read them with `pr_stats_settings`
 * and change them with `set_pr_stats` (invariant 3, agent parity); the developer in Settings → Following → PR statistics.
 *
 * Nothing is built in (invariant 24, `public-code-carries-no-host-identifiers`): an empty install has no repository on, no team and no names.
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
  /** null: the zone's usual workdays 9–18 (shared/workweek.ts). Never written as a default, so a new zone moves it. */
  hours: scheduleSchema.nullable().default(null),
  /** null: the developer's device zone (`follow.client-time-zone`), else UTC. */
  timeZone: z.string().min(1).max(64).nullable().default(null),
  /** null: the zone's usual week start (Sunday where the weekend is Friday–Saturday, else Monday). */
  weekStart: z.union([z.literal(0), z.literal(1)]).nullable().default(null),
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
  /** null: back to the zone's usual week. */
  hours: scheduleSchema.nullable().optional(),
  timeZone: z.string().min(1).max(64).nullable().optional(),
  weekStart: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
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
  /**
   * Why the count couldn't run now, when the stats gate held it (GitHub's limit low, stats' share spent, another read
   * running), with when it can (epoch ms; null: unknown). Turning on still goes ahead: the first sync waits the same way.
   */
  wait: z.object({ reason: z.enum(["governor", "budget", "slice", "busy"]), until: z.number().nullable() }).nullable().default(null),
  /** The account can't read the repository (not found or no access): the only answer that refuses Turn on. */
  unreadable: z.boolean().default(false),
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
  /** The schedule and week start in use: the saved ones, else the zone's usual week. */
  hours: scheduleSchema,
  weekStart: z.union([z.literal(0), z.literal(1)]),
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
    /** Waiting for a first review now, longest first, each with its PR url (invariant 23, `a-row-that-names-a-pr-opens-it-in-one-click`). */
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
/** One repository's line in Settings (its window is in its options' summary): "On · 3,248 PRs · 1.0 MB", "On · reading · back to Oct 3", "Paused · data up to Nov 2", "Off". */
export function statsRepoLine(row: z.infer<typeof statsRepoRowSchema>, timeZone: string): string {
  const s = row.settings, st = s?.status ?? null;
  if (row.state === "off" || !s) return "Off";
  if (row.state === "paused") return st?.lastSyncAt ? `Paused · data up to ${shortDate(st.lastSyncAt, timeZone)}` : "Paused";
  if (!st || st.lastSyncAt === null) return `On · ${s.windowDays} days · first read starting`;
  if (st.error) return `On · stopped · ${count(st.records)} PR${st.records === 1 ? "" : "s"} kept`;
  const parts = ["On"];
  if (!st.backfillDone) parts.push(st.coveredTo ? `reading · back to ${shortDate(st.coveredTo, timeZone)}` : "reading");
  parts.push(`${count(st.records)} PR${st.records === 1 ? "" : "s"}`);
  if (s.estimate && !st.backfillDone) parts[parts.length - 1] = `≈ ${count(st.records)} of ${count(s.estimate.prs)} PRs`;
  parts.push(sizeWords(st.records * 320));
  return parts.join(" · ");
}
/** Why a repository's stats aren't reading right now, in the page's words; null when nothing holds them. */
export function statsRepoWait(row: z.infer<typeof statsRepoRowSchema>): string | null {
  const st = row.settings?.status;
  if (!st || row.state !== "on") return null;
  return statsWaitWords(st);
}
/** The same words from a sync status (the page's sync line): a GitHub refusal, or why reading waits; null when nothing holds it. */
export function statsWaitWords(st: Pick<StatsStatus, "waiting" | "error">): string | null {
  if (st.error) return st.error.status ? `GitHub returned ${st.error.status}: ${st.error.message}.` : `GitHub refused the read: ${st.error.message}.`;
  if (!st.waiting) return null;
  const at = st.waiting.until ? new Date(st.waiting.until * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  return st.waiting.reason === "budget" ? `GitHub limit low · updates again${at ? ` at ${at}` : " after GitHub's reset"}.`
    : st.waiting.reason === "governor" ? "Paused while this machine is busy."
    : st.waiting.reason === "slice" ? `Paused · stats used their share of GitHub's limit this hour${at ? ` · next read ${at}` : ""}.`
    : null;
}
/** How loud a repository's wait line is: a GitHub refusal is red, a wait on GitHub's limit or the share amber. */
export function statsRepoWaitTone(row: z.infer<typeof statsRepoRowSchema>): "danger" | "warning" | "muted" | null {
  const st = row.settings?.status;
  if (!st || row.state !== "on") return null;
  if (st.error) return "danger";
  if (!st.waiting) return null;
  return st.waiting.reason === "budget" || st.waiting.reason === "slice" ? "warning" : st.waiting.reason === "governor" ? "muted" : null;
}
/**
 * The opt-in sheet's lines when there is no count (a-read-the-developer-starts-never-waits-on-the-governor): what Turn on
 * does now first (`lead`), then why there is no count, in plain words (`reason`). `canTurnOn` is false only for a
 * repository the account can't read; the sheet never dead-ends otherwise. `retry` asks the sheet to count again by
 * itself (another stats read was running). `time` formats an epoch-ms time in the developer's zone, with the day when
 * it isn't today.
 */
export function estimateBlocked(e: StatsEstimate | null, failure: string | null, time: (ms: number) => string): { lead: string; reason: string; canTurnOn: boolean; tone: "danger" | "neutral"; retry: boolean } | null {
  if (e && e.prs !== null && e.points !== null) return null;
  const later = "You can turn stats on now. They start reading on the next sync and show their progress here.";
  if (!e) return failure ? { lead: later, reason: `Couldn't count the PRs: ${failure}`, canTurnOn: true, tone: "neutral", retry: false } : null;
  if (e.unreadable) return { lead: e.error ?? `Can't read ${e.repo} with this GitHub account.`, reason: "Check the account has access to the repository, then try again.", canTurnOn: false, tone: "danger", retry: false };
  const at = e.wait?.until ? time(e.wait.until) : null;
  if (e.wait?.reason === "budget") return { lead: at ? `You can turn stats on now. They start reading at ${at}.` : later,
    reason: `Less than 40% of your GitHub limit is left${at ? ` until ${at}` : ""}.`, canTurnOn: true, tone: "neutral", retry: false };
  if (e.wait?.reason === "slice") return { lead: at ? `You can turn stats on now. They start reading at ${at}.` : later,
    reason: "Stats used their share of your GitHub limit this hour.", canTurnOn: true, tone: "neutral", retry: false };
  if (e.wait?.reason === "busy") return { lead: "Counting as soon as the other stats read finishes. You can turn stats on now.", reason: "Another stats read is running.", canTurnOn: true, tone: "neutral", retry: true };
  return { lead: later, reason: `Couldn't count the PRs: ${e.error ?? "GitHub didn't answer."}`, canTurnOn: true, tone: "neutral", retry: false };
}
/** The opt-in sheet's cost line. */
export function estimateLines(e: StatsEstimate, slice: number): { cost: string; time: string } | null {
  if (e.prs === null || e.points === null) return null;
  const perHour = Math.max(1, e.slicePoints);
  const hours = e.points / perHour;
  const time = hours <= 1 ? "About an hour or less." : `About ${Math.ceil(hours)} hours.`;
  return { cost: `Reading them costs about ${count(e.points)} GitHub points, spread so stats never use more than ${Math.round(slice * 100)}% of your hourly limit (${count(e.slicePoints)} points).`, time };
}
