import { readFile } from "node:fs/promises";
import type { GithubOff } from "../shared/github-setup";
import { join } from "node:path";
import { graphitePrUrl } from "../shared/presentation";
import { defaultHours, personDetail, periodRange, statsModel, type Period, type Schedule, type StatsOptions } from "../shared/pr-stats";
import { defaultWeekStart } from "../shared/workweek";
import { emptyStatsSettings, statsSettingsSchema, type PrStatsOutput, type SetPrStatsInput, type StatsEstimate, type StatsRepoSettings, type StatsSettings, type StatsSettingsView, type StatsStatus } from "../shared/pr-stats-settings";
import { STATS_PAGE_SIZE } from "../shared/pr-stats-records";
import type { GithubApi } from "./github-api";
import { StatsGate, type GateDeps, type RateLimit, type ReadOrigin } from "./pr-stats-gate";
import { StatsStore, type RepoStats } from "./pr-stats-store";
import { StatsSync } from "./pr-stats-sync";
import { WriteBehind, type WriteHealth } from "./write-behind";

/**
 * PR statistics, the service (docs/pr-stats.md): `stats.json` (which repositories are on and how), the opt-in
 * estimate, the model the page and `pr_stats` read, and when the sync runs.
 *
 * When it runs (D6): `tick()` rides the engine's existing loop and starts nothing on its own timer. A repository on
 * is synced when its last run is `SYNC_IDLE_MS` old (an hour: ~1-2 points while nobody looks), or `SYNC_VIEWING_MS`
 * while its page is on screen (`viewing`, set by the page's feed), one repository at a time, never awaited by the
 * engine, and every request still passes the gate (invariant 67, `stats-never-spend-below-low`). A refresh (the page's icon, `pr_stats fresh`) runs
 * one incremental pass now, through the same gate.
 *
 * The team filter's GitHub team (`org/slug`) is read once a day through the gate; a token that can't read it leaves
 * the filter showing everyone with one plain line (invariant 75, `stats-learn-the-team-from-the-data`).
 */
export const SYNC_IDLE_MS = 60 * 60_000;
export const SYNC_VIEWING_MS = 5 * 60_000;
export const TEAM_READ_MS = 24 * 60 * 60_000;
/** Bytes a record takes on disk, for the opt-in estimate (measured 294-340). */
export const BYTES_PER_RECORD = 320;

const seconds = (ms: number) => Math.floor(ms / 1000);
export type PrStatsDeps = {
  /** Why GitHub is off on the host (works-without-github), or null: while off, no sync starts on the timer. */
  githubOff?: () => Promise<GithubOff | null>;
  directory: string;
  api: GithubApi;
  /** The gate's view of the shared budget and the governor. */
  gate: Omit<GateDeps, "slice" | "now">;
  /** The developer's device zone (`follow.client-time-zone`), when known. */
  clientTimeZone: () => string | null;
  /** Whether a repository ships through Graphite (its PR links open there, invariant 23, `a-row-that-names-a-pr-opens-it-in-one-click`). */
  graphite?: (repo: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
  health?: WriteHealth;
};

export class PrStats {
  private cached: StatsSettings | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  readonly persist: WriteBehind<StatsSettings>;
  readonly store: StatsStore;
  readonly gate: StatsGate;
  readonly sync: StatsSync;
  private running: Promise<void> | null = null;
  /** Repositories whose page is on screen now (the feed's subscribers), with how many. */
  private viewing = new Map<string, number>();
  /**
   * Something the page shows may have changed: a repository's run ended (its status summary moved) or a setting was
   * written (null: host-wide or which repositories are on). The worker pushes the page's feed and Home's from it; no timer.
   */
  onChange: ((repo: string | null) => void) | null = null;
  private now: () => number;
  constructor(private d: PrStatsDeps) {
    this.now = d.now ?? Date.now;
    this.persist = new WriteBehind({ path: join(d.directory, "stats.json"), encode: s => JSON.stringify(s, null, 2), health: d.health, log: d.log });
    this.store = new StatsStore(d.directory, { now: this.now, health: d.health, log: d.log });
    this.gate = new StatsGate({ ...d.gate, slice: () => this.cached?.slice ?? 0.05, now: this.now });
    this.sync = new StatsSync({ api: d.api, gate: this.gate, store: this.store, now: this.now, log: d.log });
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────────────────────────────

  async settings(): Promise<StatsSettings> {
    if (this.cached) return this.cached;
    let settings: StatsSettings;
    try { settings = statsSettingsSchema.parse(JSON.parse(await readFile(join(this.d.directory, "stats.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") (this.d.log ?? console.warn)(`[follow-up] PR stats: stats.json is unreadable (${error instanceof Error ? error.message : String(error)}); using the defaults until it is saved again`);
      settings = emptyStatsSettings();
    }
    this.cached = settings;
    return settings;
  }
  private mutate(work: (s: StatsSettings) => void): Promise<StatsSettings> {
    const next = this.tail.then(async () => {
      const draft = structuredClone(await this.settings());
      work(draft);
      const parsed = statsSettingsSchema.parse(draft);
      this.cached = parsed; this.persist.set(parsed);
      return parsed;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  timeZone(settings: StatsSettings): string { return settings.timeZone ?? this.d.clientTimeZone() ?? "UTC"; }
  /** The schedule and week start in use: a saved one wins, else the zone's usual week (shared/workweek.ts). */
  week(settings: StatsSettings, timeZone: string): { hours: Schedule; weekStart: 0 | 1 } {
    return { hours: settings.hours ?? defaultHours(timeZone), weekStart: settings.weekStart ?? defaultWeekStart(timeZone) };
  }

  /** Settings → PR statistics and `pr_stats_settings`: every known repository and its state; `estimate` for the opt-in sheet. */
  async view(known: Iterable<string>, o: { repo?: string; estimate?: boolean } = {}): Promise<StatsSettingsView> {
    const settings = await this.settings();
    const names = new Set<string>([...known, ...Object.keys(settings.repos)]);
    const repos = [...names].sort().map(repo => {
      const own = settings.repos[repo] ?? null;
      return { repo, state: own ? (own.enable_stats ? "on" as const : "paused" as const) : "off" as const, settings: own };
    });
    const timeZone = this.timeZone(settings);
    return { settings, repos, timeZone, ...this.week(settings, timeZone), estimate: o.repo && o.estimate ? await this.estimate(o.repo) : null };
  }

  /**
   * The opt-in sheet's numbers: PRs updated in the window (`search(issueCount)`, 1 point, through the gate) and what
   * reading them costs. A repository the token can't read is refused here, with GitHub's reason. Every caller is a
   * request (the sheet, `pr_stats_settings estimate`, the count kept when Turn on is pressed), so it is a developer's
   * read: it skips the governor and still respects GitHub's budget and stats' share (invariant 106).
   */
  async estimate(repo: string, windowDays = 90, origin: ReadOrigin = "developer"): Promise<StatsEstimate> {
    const owner = repo.split("/")[0]!;
    const slicePoints = this.gate.slicePoints(owner);
    const since = new Date(this.now() - windowDays * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    const query = `query($owner:String!,$name:String!,$q:String!){rateLimit{cost remaining resetAt limit} repository(owner:$owner,name:$name){id} search(type:ISSUE,query:$q,first:0){issueCount}}`;
    try {
      const answer = await this.gate.run(owner, async () => {
        const body = await this.d.api.graphql(repo, query, { owner, name: repo.split("/")[1]!, q: `repo:${repo} is:pr updated:>=${since}` });
        return { value: body, rate: body?.data?.rateLimit as RateLimit | undefined };
      }, { origin });
      const none = { repo, prs: null, points: null, slicePoints, bytes: null, wait: null, unreadable: false };
      if (!answer.ok) return { ...none, error: gateLine(answer.reason, answer.until), wait: { reason: answer.reason, until: answer.until } };
      const body = answer.value as Record<string, any>;
      if (!body?.data?.repository) return { ...none, error: `Can't read ${repo} with this GitHub account (not found or no access).`, unreadable: true };
      const prs = Number(body.data.search?.issueCount) || 0;
      // A page of 25 is 1 point; review follow-ups add about one more point per 250 PRs.
      const points = Math.ceil(prs / STATS_PAGE_SIZE) + Math.ceil(prs / 250);
      return { repo, prs, points, slicePoints, bytes: prs * BYTES_PER_RECORD, error: null, wait: null, unreadable: false };
    } catch (error) {
      const e = error as { message?: string; status?: number; rateLimited?: boolean; resetAt?: number };
      if (e?.rateLimited) return { repo, prs: null, points: null, slicePoints, bytes: null, error: gateLine("budget", e.resetAt ?? null), wait: { reason: "budget", until: e.resetAt ?? null }, unreadable: false };
      return { repo, prs: null, points: null, slicePoints, bytes: null, error: `Can't read ${repo} (${e?.status ? `HTTP ${e.status}: ` : ""}${e?.message ?? String(error)}).`, wait: null, unreadable: e?.status === 404 };
    }
  }

  /** Settings' writes and `set_pr_stats` (confirmed). Turning a repository on starts its first sync on the next tick. */
  async set(input: SetPrStatsInput): Promise<StatsSettings> {
    const { repo } = input;
    const perRepo = input.enable !== undefined || input.delete !== undefined || input.windowDays !== undefined || input.team !== undefined || input.ignore !== undefined;
    if (perRepo && !repo) throw new Error("Name the repository (owner/repo) to change.");
    if (input.delete && input.enable !== false) throw new Error("Delete only with enable: false (turn stats off and delete the data).");
    if (repo && input.enable === undefined && !input.delete && !(await this.settings()).repos[repo] && perRepo) throw new Error(`PR statistics aren't on for ${repo}. Turn them on first (enable: true).`);
    if (input.delete && repo) await this.store.delete(repo);
    const settings = await this.mutate(s => {
      if (input.slice !== undefined) s.slice = input.slice;
      if (input.clock !== undefined) s.clock = input.clock;
      if (input.hours !== undefined) s.hours = input.hours;
      if (input.timeZone !== undefined) s.timeZone = input.timeZone;
      if (input.weekStart !== undefined) s.weekStart = input.weekStart;
      if (input.enable_stack_aware !== undefined) s.enable_stack_aware = input.enable_stack_aware;
      if (!repo) return;
      if (input.delete) { delete s.repos[repo]; return; }
      const own: StatsRepoSettings = s.repos[repo] ?? { enable_stats: false, windowDays: 90, team: { kind: "everyone" }, ignore: [], enabledAt: null, estimate: null, status: null };
      if (input.enable === true && !own.enable_stats) own.enabledAt = seconds(this.now());
      if (input.enable !== undefined) own.enable_stats = input.enable;
      if (input.windowDays !== undefined) own.windowDays = input.windowDays;
      if (input.team !== undefined) { own.team = input.team; if (own.status) own.status = { ...own.status, teamMembers: null }; }
      if (input.ignore !== undefined) own.ignore = [...new Set(input.ignore.map(p => p.toLowerCase()))];
      s.repos[repo] = own;
    });
    if (repo && input.windowDays !== undefined && !input.delete) {
      const stats = await this.store.open(repo);
      if (stats.meta.windowDays !== input.windowDays) {
        // A longer window reads further back; a shorter one drops what's now outside at the next run.
        stats.meta = { ...stats.meta, windowDays: input.windowDays, ...(input.windowDays > stats.meta.windowDays ? { backfill: { ...stats.meta.backfill, done: false } } : {}) };
        this.store.save(stats);
      }
    }
    this.onChange?.(repo ?? null);
    return settings;
  }
  /** Records the estimate the developer (or an agent) saw when turning a repository on. */
  async noteEstimate(repo: string, estimate: StatsEstimate): Promise<void> {
    if (estimate.prs === null || estimate.points === null) return;
    await this.mutate(s => { const own = s.repos[repo]; if (own) own.estimate = { prs: estimate.prs!, points: estimate.points!, at: seconds(this.now()) }; });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private prUrl(repo: string, number: number): string { return this.d.graphite?.(repo) ? graphitePrUrl({ repo, number }) : `https://github.com/${repo}/pull/${number}`; }
  /** The page's and `pr_stats`'s model for one repository and period (records load for this read only, invariant 68, `stats-are-computed-on-read`). */
  async read(input: { repo?: string; period?: string; person?: string; clock?: "calendar" | "working"; fresh?: boolean }): Promise<PrStatsOutput> {
    const settings = await this.settings();
    const withStats = Object.entries(settings.repos).map(([repo, s]) => ({ repo, state: s.enable_stats ? "on" as const : "paused" as const }));
    const repo = input.repo ?? withStats.find(r => r.state === "on")?.repo ?? withStats[0]?.repo ?? null;
    const period = (input.period ?? "week") as Period;
    const timeZone = this.timeZone(settings);
    const now = seconds(this.now());
    const { hours, weekStart } = this.week(settings, timeZone);
    const range = periodRange(period, now, timeZone, weekStart);
    const clock = input.clock ?? settings.clock;
    const base: PrStatsOutput = { repo, repos: withStats, period, range, clock, timeZone, hours, model: null, person: null, sync: null, teamNotice: null, empty: null };
    if (!repo) return { ...base, empty: "PR statistics aren't on for any repository. Turn them on per repository in Settings → Following → PR statistics (set_pr_stats)." };
    const own = settings.repos[repo];
    if (!own) return { ...base, empty: `PR statistics aren't on for ${repo}. Turn them on in Settings → Following → PR statistics (set_pr_stats).` };
    // A refresh is the developer's read (the page's icon, `pr_stats fresh`): it skips the governor (invariant 106).
    if (input.fresh && own.enable_stats) await this.runRepo(repo, { backfillPages: 0, origin: "developer" });
    const stats = await this.store.open(repo);
    const { team, notice } = this.teamOf((await this.settings()).repos[repo] ?? own);
    const options: StatsOptions = { timeZone, weekStart, clock, hours, ignore: own.ignore, team, stackAware: settings.enable_stack_aware, defaultBranch: stats.meta.defaultBranch };
    const records = stats.records.values();
    const model = statsModel(records, range, now, options);
    const coveredTo = stats.meta.backfill.coveredTo;
    const sync = { records: stats.records.size, coveredTo, backfillDone: stats.meta.backfill.done, coversPeriod: stats.meta.backfill.done || (coveredTo !== null && coveredTo <= range.start), lastSyncAt: stats.meta.lastSyncAt, waiting: stats.meta.waiting, error: stats.meta.error, cappedTo: stats.meta.cappedTo };
    const url = (n: number) => this.prUrl(repo, n);
    const detail = input.person ? personDetail(stats.records.values(), input.person, range, now, options) : null;
    return { ...base, model: { ...model, waiting: model.waiting.map(w => ({ ...w, url: url(w.number) })) },
      person: detail ? { login: detail.login, row: detail.row, prs: detail.prs.map(p => ({ ...p, url: url(p.number) })), reviewed: detail.reviewed.map(r => ({ ...r, url: url(r.number) })) } : null,
      sync, teamNotice: notice };
  }
  /** The team filter's people, or everyone with the reason when a GitHub team can't be read (invariant 75, `stats-learn-the-team-from-the-data`). */
  private teamOf(own: StatsRepoSettings): { team: string[] | null; notice: string | null } {
    if (own.team.kind === "everyone") return { team: null, notice: null };
    if (own.team.kind === "people") return { team: own.team.logins, notice: null };
    const members = own.status?.teamMembers;
    if (members?.team === own.team.team && members.logins) return { team: members.logins, notice: null };
    if (members?.team === own.team.team && members.error) return { team: null, notice: `Can't read the team @${own.team.team} with this GitHub token, so this shows everyone. Pick people instead, or give gh read:org.` };
    return { team: null, notice: `Reading the team @${own.team.team}; this shows everyone until then.` };
  }

  // ── Sync ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** What the page's feed pushes for a repository: its status summary from stats.json (never its records). */
  async feedState(repo: string): Promise<{ repo: string; state: "on" | "paused" | "off"; lastSyncAt: number | null; records: number; coveredTo: number | null; waiting: StatsStatus["waiting"]; error: StatsStatus["error"] }> {
    const own = (await this.settings()).repos[repo];
    const st = own?.status ?? null;
    return { repo, state: !own ? "off" : own.enable_stats ? "on" : "paused", lastSyncAt: st?.lastSyncAt ?? null, records: st?.records ?? 0, coveredTo: st?.coveredTo ?? null, waiting: st?.waiting ?? null, error: st?.error ?? null };
  }
  /** Whether any repository has stats (on or paused): Home shows the PR stats icon only then. */
  async anyOn(): Promise<boolean> { return Object.keys((await this.settings()).repos).length > 0; }
  /** The page's feed: a repository on screen syncs every SYNC_VIEWING_MS instead of every hour. Returns the release. */
  watching(repo: string): () => void {
    this.viewing.set(repo, (this.viewing.get(repo) ?? 0) + 1);
    let done = false;
    return () => { if (done) return; done = true; const n = (this.viewing.get(repo) ?? 1) - 1; if (n > 0) this.viewing.set(repo, n); else this.viewing.delete(repo); };
  }
  /** Repositories due for a sync now. */
  async due(): Promise<string[]> {
    const settings = await this.settings();
    const now = this.now();
    return Object.entries(settings.repos).filter(([repo, s]) => {
      if (!s.enable_stats) return false;
      const last = s.status?.lastSyncAt ?? null;
      if (last === null || !s.status?.backfillDone) return last === null || now - last * 1000 >= SYNC_VIEWING_MS;
      return now - last * 1000 >= (this.viewing.has(repo) ? SYNC_VIEWING_MS : SYNC_IDLE_MS);
    }).map(([repo]) => repo);
  }
  /**
   * The engine loop's hook: starts due syncs one repository at a time and returns at once. A backfill keeps going on
   * the next ticks (every SYNC_VIEWING_MS) until it is done, each run inside the gate.
   */
  tick(): void {
    if (this.running) return;
    this.running = (async () => {
      if (await this.d.githubOff?.()) return;
      for (const repo of await this.due()) await this.runRepo(repo);
    })().catch(error => (this.d.log ?? console.warn)(`[follow-up] PR stats: sync failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.running = null; });
  }
  /** One run for a repository, then its status summary in stats.json and the team's members when due. */
  async runRepo(repo: string, o: { backfillPages?: number; origin?: ReadOrigin } = {}): Promise<void> {
    const own = (await this.settings()).repos[repo];
    if (!own?.enable_stats) return;
    const stats = await this.store.open(repo);
    if (stats.meta.windowDays !== own.windowDays) stats.meta = { ...stats.meta, windowDays: own.windowDays };
    await this.sync.run(repo, { ...(o.backfillPages !== undefined ? { backfillPages: o.backfillPages } : {}), ...(o.origin ? { origin: o.origin } : {}) });
    const teamMembers = await this.readTeam(repo, own);
    await this.mutate(s => { const r = s.repos[repo]; if (r) r.status = { ...summary(stats), teamMembers: teamMembers === undefined ? r.status?.teamMembers ?? null : teamMembers }; });
    this.onChange?.(repo);
  }
  /** The GitHub team's members, read once a day (1 point) through the gate; undefined when not due. */
  private async readTeam(repo: string, own: StatsRepoSettings): Promise<StatsStatus["teamMembers"] | undefined> {
    if (own.team.kind !== "github") return own.status?.teamMembers ? null : undefined;
    const last = own.status?.teamMembers;
    if (last && last.team === own.team.team && this.now() - last.at * 1000 < TEAM_READ_MS) return undefined;
    const [org, slug] = own.team.team.split("/") as [string, string];
    const owner = repo.split("/")[0]!;
    try {
      const answer = await this.gate.run(owner, async () => {
        const body = await this.d.api.graphql(repo, `query($org:String!,$slug:String!){rateLimit{cost remaining resetAt limit} organization(login:$org){team(slug:$slug){members(first:100){nodes{login}}}}}`, { org, slug });
        return { value: body, rate: body?.data?.rateLimit as RateLimit | undefined };
      });
      if (!answer.ok) return undefined;
      const nodes = (answer.value as Record<string, any>)?.data?.organization?.team?.members?.nodes;
      if (!Array.isArray(nodes)) return { team: own.team.team, logins: null, error: "not readable with this token", at: seconds(this.now()) };
      return { team: own.team.team, logins: nodes.map((n: { login?: string }) => n?.login).filter((l): l is string => typeof l === "string"), error: null, at: seconds(this.now()) };
    } catch (error) {
      return { team: own.team.team, logins: null, error: error instanceof Error ? error.message : String(error), at: seconds(this.now()) };
    }
  }

  async flush(): Promise<void> { await this.tail; await this.running?.catch(() => undefined); await this.persist.flush(); await this.store.flush(); }
  close(): void { this.store.close(); }
}

export function summary(stats: RepoStats): Omit<StatsStatus, "teamMembers"> {
  const m = stats.meta;
  return { records: stats.records.size, coveredTo: m.backfill.coveredTo, backfillDone: m.backfill.done, lastSyncAt: m.lastSyncAt, lastCost: m.lastCost, waiting: m.waiting, error: m.error, cappedTo: m.cappedTo };
}
/** The gate's reason in the page's words (`githubWaitLine`'s style). */
export function gateLine(reason: string, until: number | null): string {
  const at = until ? ` · next read ${new Date(until).toISOString().slice(11, 16)} UTC` : "";
  if (reason === "budget") return `GitHub limit low${until ? ` · updates again at ${new Date(until).toISOString().slice(11, 16)} UTC` : ""}`;
  if (reason === "governor") return "Paused while this machine is busy";
  if (reason === "slice") return `Paused · stats used their share of GitHub's limit this hour${at}`;
  return "Another stats read is running; try again in a moment";
}
