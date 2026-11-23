import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { atomic } from "./overseer";
import { claudeArgs, claudeRunner, type AiJobs, type RunInput } from "./ai-jobs";
import { NoSourceError, sourceDirectory, type SourceDirectory } from "./source-tools";
import { parseEvents, parseMail, rangeArgs } from "../shared/brief-sources";
import {
  damped, emptyReasons, fillReasons, workspaceInputs, healthLine, inRankWindow, RANK_STRICT, REASON_SYSTEM, reasonInputs, reasonReplySchema, stableInputs, rankPrompt, rankReplySchema, RANK_SYSTEM, rankWorkstream, toPriorities,
  type NotStarted, type RankAsked, type RankEvent, type RankInputs, type RankIssue, type RankMessage, type RankPlanning, type RankReview, type RankSource, type SourceHealth,
} from "../shared/ranker";
import type { Priority } from "../shared/priorities";
import type { RankCompassNote } from "../shared/compass";
import type { WorkstreamRow } from "../shared/overseer";
import { truncated } from "../shared/scale";
import { canonicalArtifactUrl } from "../shared/morning-brief";
import { ARTIFACT_READ } from "./job-guard";
import { clockFor, BRIEF_SETTINGS_DEFAULT, priorityName, zoned, type Clock, type QueueIssue } from "../shared/linear-queue";

import { ghAccounts, githubApi, type AccountReads } from "./github-api";
const exec = promisify(execFile);

/** The inputs' fingerprint: equal means the model would see the same material. */
export const inputsHash = (inputs: RankInputs) => createHash("sha256").update(stableInputs(inputs)).digest("hex").slice(0, 32);
/**
 * What decides whether the model runs again: the inputs, plus who ranks and how (provider, model, effort, the
 * prompt). Switching the ranker to another model in Settings → Agents re-ranks at the next run.
 */
export const rankKey = (inputs: RankInputs, role: Pick<RankerRole, "provider" | "model" | "thinking">) =>
  createHash("sha256").update(stableInputs(inputs)).update(JSON.stringify([role.provider, role.model, role.thinking, RANK_SYSTEM, RANK_STRICT, REASON_SYSTEM])).digest("hex").slice(0, 32);

// ---------- role ----------

/**
 * The ranker's provider, model and limits, from the ranker role in Settings → Agents. These defaults match its
 * ROLE_DEFAULTS.ranker and fill any limit the role leaves unset. Never a hardcoded model at the call site.
 */
export type RankerRole = { provider: string; model: string | null; thinking: string | null; dailyCap: number; maxPromptChars: number | null; cadenceMinutes: number };
export const RANKER_ROLE_DEFAULT: RankerRole = { provider: "claude", model: "sonnet", thinking: null, dailyCap: 24, maxPromptChars: 60_000, cadenceMinutes: 60 };

// ---------- sources ----------

export type RankSources = {
  linear(): Promise<RankIssue[]>;
  /** DMs and mentions since `since` (ms). */
  slack(since: number): Promise<RankMessage[]>;
  /** Today's meetings (`days` from the start of today), when a calendar source is on. */
  calendar?(day: { start: string; end: string; timeZone: string }): Promise<RankEvent[]>;
  /** What the Ask sources that are on found this morning (stored by the morning's asks; the ranker never asks). */
  asks?(): Promise<RankAsked[]>;
  /** Compass's live notes (server/compass.ts): stored by its reads; the ranker never reads a source for them. */
  compass?(): Promise<RankCompassNote[]>;
  /** Unread mail since `since` (ms), when the mail source is on (off until turned on); `now` is the ranker's clock. */
  mail?(since: number, now: number): Promise<RankMessage[]>;
  github(): Promise<RankReview[]>;
  /** The CPO's plan, read once a day at most (the caller caches). Null when there's no plan to read. */
  planning(url: string): Promise<RankPlanning | null>;
};

const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;

/** The Morning brief's queue as the ranker reads it: an issue with its change since the last workday. */
export function rankIssue(i: QueueIssue & { change: string | null }): RankIssue {
  return { key: i.key, title: i.title, priority: i.priority ? priorityName(i.priority) : null, status: i.state, due: i.due, project: i.project, milestone: i.milestone, url: i.url, change: i.change };
}

/**
 * `slack_search_public_and_private` in concise form: "1. DM with Tom, Dana Levi - Dana Levi: text… 2026-11-09 18:12:18 IST".
 * The developer's own messages and bots are dropped.
 */
export function parseSlackSearch(text: string, self: string | null): RankMessage[] {
  const out: RankMessage[] = [];
  const body = (() => { try { const j = JSON.parse(text) as { results?: string }; return typeof j.results === "string" ? j.results : text; } catch { return text; } })();
  for (const m of body.matchAll(/(?:^|\n)\s*\d+\.\s+([\s\S]*?)(?=\n\s*\d+\.\s|\n*$)/g)) {
    const item = m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    const at = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [A-Z]{2,4})?)\s*$/.exec(item);
    const rest = at ? item.slice(0, at.index).trim() : item;
    const head = /^(.*?),\s*([^:]{1,80}?)\s*-\s*([^:]{1,80}?):\s*([\s\S]*)$/.exec(rest);
    const where = head ? head[1] : "Slack"; const who = head ? head[3].trim() : null; const msg = (head ? head[4] : rest).replace(/…$/, "").trim();
    if (!msg || (who && self && who.toLowerCase() === self.toLowerCase()) || /^(GitHub|Linear|Graphite|Jira|Sentry|Datadog|Slackbot)\b/i.test(who ?? "")) continue;
    out.push({ where, who, text: msg, at: at ? at[1] : null });
  }
  return out;
}

/** `gh search prs --review-requested=@me --json number,title,url,repository,author`. */
export function parseReviewRequests(stdout: string): RankReview[] {
  let j: unknown; try { j = JSON.parse(stdout); } catch { return []; }
  // REST `search/issues` ({items}) or `gh search prs --json` (an array).
  const list = Array.isArray(j) ? j : Array.isArray((j as { items?: unknown })?.items) ? (j as { items: unknown[] }).items : [];
  return list.flatMap(raw => {
    const r = raw as { number?: unknown; title?: unknown; url?: unknown; html_url?: unknown; repository_url?: unknown; repository?: { nameWithOwner?: unknown; name?: unknown }; author?: { login?: unknown }; user?: { login?: unknown } };
    const repo = str(r.repository?.nameWithOwner) ?? str(r.repository?.name) ?? /\/repos\/([^/]+\/[^/]+)$/.exec(str(r.repository_url) ?? "")?.[1] ?? null;
    return typeof r.number === "number" && repo && str(r.title) ? [{ repo, number: r.number, title: str(r.title)!, url: str(r.html_url) ?? str(r.url), author: str(r.author?.login) ?? str(r.user?.login) }] : [];
  });
}

export const planReplySchema = z.object({
  title: z.string().trim().max(200).nullable().catch(null).default(null),
  // Items as objects, or plain lines (models sometimes flatten them); anything else is dropped, not fatal.
  items: truncated(z.union([
    z.object({ level: z.string().trim().min(1).max(30).catch("item"), title: z.string().trim().min(1).max(300), keys: z.array(z.string().trim().max(30)).max(10).catch([]).default([]) }),
    z.string().trim().min(1).max(300).transform(title => ({ level: "item", title, keys: title.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [] })),
  ]).nullable().catch(null), 120).transform(items => items.filter((i): i is { level: string; title: string; keys: string[] } => !!i).slice(0, 80)),
});
export const PLAN_SYSTEM = "You read one Claude artifact with the Artifact tool, action \"read\" only, and summarise its planning content. Never call the Artifact tool with any other action (never publish, update, delete, comment or share). Reply with one JSON object only: {\"title\": string|null, \"items\": [{\"level\": \"initiative|project|milestone|issue\", \"title\": string, \"keys\": [Linear keys like ACME-123]}]}. Focus on this week; at most 60 items. Never include share keys, links or raw HTML.";

/**
 * The plan reader: one Claude turn with only the Artifact tool, which Paseo's Claude provider enables with CLAUDE_CODE_ARTIFACT=1.
 * The plan is someone else's text, so the job guard (ARTIFACT_READ) lets through the read action only, whatever it says.
 */
export const planArgs = (input: RunInput) => {
  const base = claudeArgs(input);
  const tools = base.indexOf("--tools");
  base.splice(tools, 2, "--tools", "Artifact", "--allowedTools", "Artifact");
  base[base.indexOf("--max-turns") + 1] = "4";
  return base;
};

/** The Artifact tool needs CLAUDE_CODE_ARTIFACT=1, and Claude Code drops it when nonessential traffic is off. */
export const PLAN_ENV = { CLAUDE_CODE_ARTIFACT: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" };

/** Moved to shared/morning-brief.ts (Settings → Morning brief owns the plan link); kept here for older imports. */
export { canonicalArtifactUrl };

type Run = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<string>;
/** A source the developer turned off in Settings → Morning brief: the ranker reads it as "off", not failed. */
export class SourceOffError extends Error { constructor(label: string) { super(`${label} is off in the brief.`); this.name = "SourceOffError"; } }
/** The brief's switches for one source: whether it's on, and which mcpproxy servers it may read. */
export type SourceGate = (id: "chat" | "calendar" | "mail" | "github") => Promise<{ on: boolean; allowed?: (server: string) => boolean }>;
const runFile: Run = async (command, args, timeout, env) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) })).stdout;

/** Every github.com account `gh` is logged in to: review requests can sit on a work account that isn't the active one. */
export { ghAccounts };

/** The live sources: read-only mcpproxy calls, in-process GitHub reads, and one Artifact read for the plan. */
export function liveRankSources(jobs: AiJobs, opts: { run?: Run; tools?: SourceDirectory; gate?: SourceGate; github?: AccountReads; slackSelf?: string | null; slackUser?: string | null; model?: () => Promise<string | null>; /** The `claude` command the plan reader runs (tests: a fake provider). */ claude?: string; queue?: { forRanker(): Promise<(QueueIssue & { change: string | null })[]> } } = {}): RankSources {
  const run = opts.run ?? runFile;
  // The chat, calendar and mail servers are whichever have those recipes' tools (nothing-built-in-about-a-workplace).
  const tools = opts.tools ?? sourceDirectory(run);
  const gate = async (id: Parameters<SourceGate>[0], label: string) => {
    const g = await opts.gate?.(id) ?? { on: id !== "mail" };
    if (!g.on) throw new SourceOffError(label);
    return g.allowed;
  };
  const reason = "rank today's workstreams";
  return {
    async linear() {
      // The Morning brief's snapshot (server/linear-queue.ts): the whole queue was swept this morning, so the ranker
      // reads no Linear itself: its top issues by priority plus every changed one (the-queue-is-whole).
      if (!opts.queue) throw new Error("The Linear queue isn't set up.");
      return (await opts.queue.forRanker()).map(rankIssue);
    },
    async slack(since) {
      const allowed = await gate("chat", "Chat");
      const after = new Date(since).toISOString().slice(0, 10);
      const base = { limit: 20, response_format: "concise", sort: "timestamp", include_context: false, natural_language_query: "" };
      const search = async (args: Record<string, unknown>) => parseSlackSearch(await tools.call("chat", "messages", { ...base, ...args }, { reason, timeoutMs: 60_000, allowed }), opts.slackSelf ?? null);
      const dms = await search({ filters: `is:dm after:${after}` });
      // The developer's own chat id, from the chat tool's description.
      const user = opts.slackUser !== undefined ? opts.slackUser : await tools.selfId(allowed).catch(() => null);
      const mentions = user ? await search({ keywords: [`<@${user}>`], filters: `after:${after}` }) : [];
      const seen = new Set<string>();
      return [...mentions, ...dms].filter(m => { const k = `${m.who}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
    },
    async calendar(day) {
      const allowed = await gate("calendar", "Calendar");
      const tool = await tools.tool("calendar", "events", allowed);
      if (!tool) throw new NoSourceError("calendar", "events");
      const args = rangeArgs(await tools.props(tool), day.start, day.end, day.timeZone);
      return parseEvents(await tools.call("calendar", "events", args, { reason, timeoutMs: 30_000, allowed }));
    },
    async mail(since, now) {
      const allowed = await gate("mail", "Mail");
      const days = Math.max(1, Math.ceil((now - since) / 86_400_000));
      return parseMail(await tools.call("mail", "messages", { query: `is:unread to:me newer_than:${days}d`, q: `is:unread to:me newer_than:${days}d`, limit: 20, maxResults: 20 }, { reason, timeoutMs: 30_000, allowed }))
        .map(m => ({ where: "mail", who: m.from, text: m.subject, at: m.at }));
    },
    async github() {
      // Each logged-in account's own review requests (a work account is often not the active one).
      // In process (worker-reads-github-in-process): the account list and each account's token are resolved once
      // and cached; the searches are HTTPS.
      await gate("github", "GitHub");
      const gh = opts.github ?? githubApi();
      const accounts = await gh.accounts().catch(() => [] as string[]);
      // REST search: `gh search prs` goes through GraphQL search, whose secondary limit a busy work account hits often
      // (it then read as "no review requests").
      const search = async (account: string | null) => parseReviewRequests(JSON.stringify(await gh.restAs(account, "search/issues?q=" + encodeURIComponent("is:pr is:open archived:false review-requested:@me") + "&per_page=30")));
      if (accounts.length <= 1) return search(accounts[0] ?? null);
      const seen = new Set<string>(); const out: RankReview[] = []; let read = 0; let failed = 0;
      for (const user of accounts) {
        try {
          for (const r of await search(user)) { const k = `${r.repo}#${r.number}`; if (!seen.has(k)) { seen.add(k); out.push(r); } }
          read++;
        } catch { failed++; /* the others still count */ }
      }
      // An account that couldn't search may hold the requests: none found plus a failure is a failure, not "none".
      if (!read || (failed && !out.length)) throw new Error(`${failed} gh account(s) couldn't search review requests.`);
      return out;
    },
    async planning(url) {
      const model = (await opts.model?.()) ?? "sonnet";
      const r = await jobs.run({ name: "rank-plan", prompt: `Read this artifact with the Artifact tool (action "read"): ${url}\nThen reply with the JSON object.`, system: PLAN_SYSTEM, schema: planReplySchema, model,
        // Always Claude: the Artifact tool is Claude Code's.
        provider: "claude", runner: claudeRunner(opts.claude ?? "claude", planArgs, PLAN_ENV, ARTIFACT_READ), timeoutMs: 180_000, maxOutputChars: 20_000 });
      if (!r.ok) throw new Error(r.error);
      // A plan with nothing in it is a failed read (the model sometimes answers before reading), not an empty week.
      if (!r.value.items.length) throw new Error("The plan came back empty.");
      return { title: r.value.title, url, items: r.value.items.map(i => ({ level: i.level, title: i.title, keys: i.keys.filter(k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)) })) };
    },
  };
}

// ---------- state ----------

const healthSchema = z.enum(["ok", "failed", "off"]);
export const rankerStateSchema = z.object({
  version: z.literal(1),
  lastHash: z.string().nullable(), lastRunAt: z.string().nullable(), lastModelAt: z.string().nullable(),
  day: z.string().nullable(), runsToday: z.number().int(),
  health: z.record(z.string(), healthSchema), notStarted: z.array(z.object({ key: z.string(), title: z.string(), url: z.string().nullable(), reason: z.string() })),
  last: z.object({ ok: z.boolean(), trigger: z.string(), costUsd: z.number().nullable(), durationMs: z.number(), skipped: z.string().nullable(), error: z.string().nullable(),
    provider: z.string().nullable().default(null), inputTokens: z.number().nullable().default(null), outputTokens: z.number().nullable().default(null), top: z.string().nullable().default(null), retried: z.boolean().default(false),
    /** Where the time went: reading inputs, the ranking call, the reasons follow-up. */
    timing: z.object({ inputsMs: z.number(), modelMs: z.number(), reasonsMs: z.number() }).nullable().default(null) }).nullable(),
  /** The last ranking that called a model: who ranked and what it cost (null for Codex, billed to its plan). */
  model: z.object({ provider: z.string(), costUsd: z.number().nullable() }).nullable().default(null),
  /** Each ranked workspace's last score and the fingerprint of its own inputs, for damping. */
  prev: z.record(z.string(), z.object({ score: z.number(), fp: z.string() })).default({}),
  slackSince: z.number().nullable(),
  /** Each failed source's one-line error from the last run (Settings → Morning brief shows it under the source). */
  errors: z.record(z.string(), z.string()).default({}),
  planning: z.object({ url: z.string(), at: z.string(), value: z.object({ title: z.string().nullable(), url: z.string().nullable(), items: z.array(z.object({ level: z.string(), title: z.string(), keys: z.array(z.string()) })) }) }).nullable(),
});
export type RankerState = z.infer<typeof rankerStateSchema>;
const EMPTY: RankerState = { version: 1, lastHash: null, lastRunAt: null, lastModelAt: null, day: null, runsToday: 0, health: {}, notStarted: [], last: null, slackSince: null, errors: {}, planning: null, prev: {}, model: null };

export type RankTrigger = "schedule" | "manual" | "overseer";
export type RankResult = {
  ok: boolean; trigger: RankTrigger; dryRun: boolean;
  /** Why the model wasn't called: nothing changed, the daily cap, memory, a run already going, off. */
  skipped: "same" | "cap" | "tight" | "busy" | "off" | "sources" | null;
  priorities: (Priority & { title: string })[]; notStarted: NotStarted[]; health: Partial<Record<RankSource, SourceHealth>>; healthLine: string;
  costUsd: number | null; durationMs: number; error: string | null; dropped: string[];
};

export type RankerDeps = {
  directory: string;
  jobs: AiJobs;
  sources: RankSources;
  workstreams(): Promise<WorkstreamRow[]>;
  priorities: { read(): Promise<Priority[]>; write(batch: Priority[], replace: boolean): Promise<Priority[]> };
  role(): Promise<RankerRole>;
  enabled(): Promise<boolean>;
  /** The resource governor: background runs wait while this is true. Manual runs still go. */
  tight?: () => Promise<boolean>;
  planningUrl?: () => Promise<string | null>;
  /** Where the developer's day is (the brief's clock). Default: the host's zone and its usual week. */
  clock?: () => Promise<Clock>;
  now?: () => number;
  /** The brief's windows (Settings → Morning brief): chat hours, and calendar days from the start of today. */
  windows?: () => Promise<{ chatHours: number; calendarDays: number }>;
  /** Why a source failed (one short line). Defaults to console.warn, the daemon log. */
  log?: (line: string) => void;
};

const PLAN_EVERY_MS = 24 * 3_600_000;
/** Unchanged inputs keep the last ranking; it is re-stamped before Home's 6-hour freshness runs out. */
const RESTAMP_MS = 4 * 3_600_000;

/**
 * One ranking run at a time. Inputs are read in sequence (concurrency 1), hashed, and the model is called only
 * when they changed. State lives in ranker.json, priorities in priorities.json; neither touches state.json.
 */
export class Ranker {
  private running: Promise<RankResult> | null = null;
  /** Whether a ranking is running now (Settings → General waits for it). */
  isRunning(): boolean { return this.running != null; }
  /** A run started or finished (the Home feed pushes the ranker's status). */
  onRunChange: () => void = () => {};
  constructor(private d: RankerDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private clock(): Promise<Clock> { return this.d.clock?.() ?? Promise.resolve(clockFor(BRIEF_SETTINGS_DEFAULT, null)); }
  private get path() { return join(this.d.directory, "ranker.json"); }
  /**
   * Read a plan now (Settings → Morning brief, `set_brief_plan`'s dry run): one artifact read, kept as the ranker's
   * plan for the day, so the next ranking doesn't read it again.
   */
  async readPlan(url: string): Promise<RankPlanning> {
    const value = await this.d.sources.planning(url);
    if (!value) throw new Error("The plan couldn't be read.");
    const s = await this.state();
    await mkdir(this.d.directory, { recursive: true, mode: 0o700 });
    await atomic(this.path, { ...s, planning: { url, at: new Date(this.now()).toISOString(), value } });
    return value;
  }
  async state(): Promise<RankerState> { try { return rankerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); } catch { return { ...EMPTY }; } }

  /** New input that should reach today's rank (the morning's Ask items): the next scheduled tick runs once, cadence or not. */
  private dueNow = false;
  markDue(): void { this.dueNow = true; }

  /** The scheduled run: in the window, at the role's cadence (or once after markDue), only with room to spare. */
  async tick(): Promise<RankResult | null> {
    if (this.running || !inRankWindow(this.now(), await this.clock()) || !await this.d.enabled()) return null;
    const [s, role] = await Promise.all([this.state(), this.d.role()]);
    if (!this.dueNow && s.lastRunAt && this.now() - Date.parse(s.lastRunAt) < role.cadenceMinutes * 60_000) return null;
    if (await this.d.tight?.()) return null;
    return this.run({ trigger: "schedule" });
  }

  run(opts: { trigger: RankTrigger; dryRun?: boolean; force?: boolean }): Promise<RankResult> {
    if (this.running) return this.running.then(r => ({ ...r, skipped: "busy" as const }));
    this.running = this.once(opts).finally(() => { this.running = null; this.onRunChange(); });
    this.onRunChange();
    return this.running;
  }

  private async once({ trigger, dryRun = false, force = false }: { trigger: RankTrigger; dryRun?: boolean; force?: boolean }): Promise<RankResult> {
    const started = this.now();
    const base = (patch: Partial<RankResult>): RankResult => ({ ok: false, trigger, dryRun, skipped: null, priorities: [], notStarted: [], health: {}, healthLine: "", costUsd: null, durationMs: this.now() - started, error: null, dropped: [], ...patch });
    if (!await this.d.enabled()) return base({ skipped: "off" });
    if (trigger === "schedule" && await this.d.tight?.()) return base({ skipped: "tight" });
    // The run starts here: only now does it take markDue's mark, so a skip above (off, or the governor turning tight
    // between tick's check and this one) keeps today's Ask items due for the next tick.
    this.dueNow = false;
    const s = await this.state();
    const role = await this.d.role();
    const clock = await this.clock();
    const day = zoned(started, clock.timeZone).day;
    const runsToday = s.day === day ? s.runsToday : 0;

    // Inputs, one source at a time. A failing source is reported, never fatal.
    const health: Partial<Record<RankSource, SourceHealth>> = {};
    const errors: Record<string, string> = {};
    // Off in the brief, or no server has the recipe's tools: "off", not a failure.
    const read = async <T>(source: RankSource, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { const v = await fn(); health[source] = "ok"; return v; }
      catch (e) {
        if (e instanceof SourceOffError || e instanceof NoSourceError) { health[source] = "off"; return fallback; }
        const line = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
        health[source] = "failed"; errors[source] = line;
        (this.d.log ?? console.warn)(`[follow-up] ranker: ${source} read failed: ${line}`);
        return fallback;
      }
    };
    const windows = await this.d.windows?.().catch(() => null) ?? { chatHours: 48, calendarDays: 1 };
    const today = zoned(started, clock.timeZone);
    // Midnight in the developer's zone: now less the zone's hour and minute (and the seconds).
    const dayStart = started - (today.hour * 60 + today.minute) * 60_000 - (started % 60_000);
    const calendarDay = { start: new Date(dayStart).toISOString(), end: new Date(dayStart + windows.calendarDays * 86_400_000).toISOString(), timeZone: clock.timeZone };
    // The three outside reads are independent subprocesses (mcpproxy, gh), so they run side by side; the plan is
    // cached for the day. Workstreams come from Follow-up's in-memory directory, no daemon request.
    // The whole chat window every run, so equal inputs hash equal; the read time is kept for the log.
    const slackSince = started;
    const chatSince = started - windows.chatHours * 3_600_000;
    const asks = await this.d.sources.asks?.().catch(() => [] as RankAsked[]) ?? [];
    const compass = await this.d.sources.compass?.().catch(() => [] as RankCompassNote[]) ?? [];
    const [rows, linear, slack, github, calendar, mail] = await Promise.all([
      this.d.workstreams(),
      read("linear", () => this.d.sources.linear(), []),
      read("slack", () => this.d.sources.slack(chatSince), []),
      read("github", () => this.d.sources.github(), []),
      this.d.sources.calendar ? read("calendar", () => this.d.sources.calendar!(calendarDay), [] as RankEvent[]) : Promise.resolve([] as RankEvent[]),
      this.d.sources.mail ? read("mail", () => this.d.sources.mail!(chatSince, started), [] as RankMessage[]) : Promise.resolve([] as RankMessage[]),
    ]);
    const url = await this.d.planningUrl?.().catch(() => null) ?? null;
    let planning: RankPlanning | null = null; let planCache = s.planning;
    if (!url) health.planning = "off";
    else if (s.planning && s.planning.url === url && started - Date.parse(s.planning.at) < PLAN_EVERY_MS) { planning = s.planning.value; health.planning = "ok"; }
    else {
      planning = await read("planning", () => this.d.sources.planning(url), null);
      if (planning) planCache = { url, at: new Date(started).toISOString(), value: planning };
      else if (s.planning?.url === url) planning = s.planning.value; // keep yesterday's plan over none
    }
    const inputs: RankInputs = { workstreams: rows.map(rankWorkstream), linear, slack, github, planning, ...(calendar.length ? { calendar } : {}), ...(mail.length ? { mail } : {}), ...(asks.length ? { asks } : {}), ...(compass.length ? { compass } : {}), ...(windows.chatHours !== 48 ? { chatHours: windows.chatHours } : {}) };
    const hash = rankKey(inputs, role);
    const inputsMs = this.now() - started;
    const last = (l: Partial<NonNullable<RankerState["last"]>> & { ok: boolean }): NonNullable<RankerState["last"]> => ({ trigger, costUsd: null, durationMs: this.now() - started, skipped: null, error: null, provider: role.provider, inputTokens: null, outputTokens: null, top: null, retried: false, timing: null, ...l });
    const save = async (patch: Partial<RankerState>) => dryRun ? undefined : (await mkdir(this.d.directory, { recursive: true, mode: 0o700 }), atomic(this.path, { ...s, day, runsToday, health, planning: planCache, slackSince, errors, lastRunAt: new Date(started).toISOString(), ...patch }));

    // Nothing from outside could be read (no logins, mcpproxy down, an isolated test daemon): a ranking would have
    // nothing to go on, so don't spend a model call. The next tick tries again at the cadence.
    if (!(["linear", "slack", "github", "planning", "calendar", "mail"] as const).some(k => health[k] === "ok")) {
      await save({ last: last({ ok: false, skipped: "sources", error: "No outside source could be read." }) });
      return base({ skipped: "sources", health, healthLine: healthLine(health), error: "No outside source could be read." });
    }
    // Nothing changed: keep the ranking, re-stamping it before it goes stale.
    if (!force && hash === s.lastHash) {
      const stored = (await this.d.priorities.read()).filter(p => p.by === "ranker");
      const newest = stored.reduce((m, p) => p.at > m ? p.at : m, "");
      if (!dryRun && stored.length && started - Date.parse(newest) > RESTAMP_MS) await this.d.priorities.write(stored.map(p => ({ ...p, at: new Date(started).toISOString() })), false);
      await save({ last: last({ ok: true, skipped: "same", top: this.titled(stored, inputs).sort((a, b) => b.score - a.score)[0]?.title ?? null }) });
      return base({ ok: true, skipped: "same", health, healthLine: healthLine(health), notStarted: s.notStarted, priorities: this.titled(stored, inputs) });
    }
    if (runsToday >= role.dailyCap && trigger !== "manual") {
      await save({ last: last({ ok: false, skipped: "cap" }) });
      return base({ skipped: "cap", health, healthLine: healthLine(health) });
    }

    const maxPromptChars = role.maxPromptChars ?? 60_000;
    const previous = Object.entries(s.prev).map(([id, p]) => ({ id, score: p.score }));
    const prompt = rankPrompt(inputs, day, maxPromptChars, previous, clock.timeZone);
    const modelStart = this.now();
    // Claude follows the rules as written; other models get the reason rule restated at the end.
    const system = role.provider === "claude" ? RANK_SYSTEM : RANK_SYSTEM + RANK_STRICT;
    let r = await this.d.jobs.run({ name: "rank", prompt, system, schema: rankReplySchema, provider: role.provider, model: role.model ?? undefined, thinking: role.thinking, maxPromptChars, maxOutputChars: 40_000, timeoutMs: 240_000 });
    const add = (a: number | null | undefined, b: number | null | undefined) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    let cost = r.costUsd, inTok = r.inputTokens ?? null, outTok = r.outputTokens ?? null, retried = false;
    // Reasons missing (Codex at low effort left most empty): one small follow-up for just those workspaces, with only
    // their material, asking only for reasons. The first reply's scores stand. Still empty after it: Paseo's own fact.
    const modelMs = this.now() - modelStart; const reasonsStart = this.now();
    const missing = r.ok ? emptyReasons(r.value, inputs) : [];
    if (r.ok && missing.length) {
      retried = true;
      const again = await this.d.jobs.run({ name: "rank-reasons", prompt: rankPrompt(reasonInputs(inputs, missing), day, maxPromptChars, [], clock.timeZone), system: role.provider === "claude" ? REASON_SYSTEM : REASON_SYSTEM + RANK_STRICT.replace('"priorities"', '"reasons"'),
        schema: reasonReplySchema, provider: role.provider, model: role.model ?? undefined, thinking: role.thinking, maxPromptChars, maxOutputChars: 20_000, timeoutMs: 120_000 });
      cost = add(cost, again.costUsd); inTok = add(inTok, again.inputTokens); outTok = add(outTok, again.outputTokens);
      if (again.ok) r = { ...r, value: fillReasons(r.value, again.value) };
    }
    const durationMs = this.now() - started;
    const timing = { inputsMs, modelMs, reasonsMs: retried ? this.now() - reasonsStart : 0 };
    const usage = { provider: role.provider, costUsd: cost, inputTokens: inTok, outputTokens: outTok, durationMs, retried, timing };
    if (!r.ok) {
      await save({ runsToday: runsToday + 1, last: last({ ok: false, error: r.error, ...usage }) });
      return base({ health, healthLine: healthLine(health), costUsd: cost, error: r.error });
    }
    const at = new Date(this.now()).toISOString();
    const ranked = toPriorities(r.value, inputs, at);
    const { notStarted, dropped } = ranked;
    // Damping: a workspace whose own inputs didn't change moves at most STEADY_CAP from its last score.
    const fps = new Map(inputs.workstreams.map(w => [w.id, createHash("sha256").update(workspaceInputs(w, inputs)).digest("hex").slice(0, 16)]));
    const priorities = damped(ranked.priorities, new Map(Object.entries(s.prev)), fps);
    const prev = Object.fromEntries(priorities.map(p => [p.workspaceId, { score: p.score, fp: fps.get(p.workspaceId) ?? "" }]));
    // The ranker's own job: stored directly (set_priorities without the confirm step), replacing its last ranking.
    if (!dryRun && priorities.length) await this.d.priorities.write(priorities, true);
    const titled = this.titled(priorities, inputs);
    await save({ lastHash: hash, lastModelAt: at, runsToday: runsToday + 1, notStarted, prev, model: { provider: role.provider, costUsd: cost }, last: last({ ok: true, top: titled[0]?.title ?? null, ...usage }) });
    return base({ ok: true, priorities: titled, notStarted, health, healthLine: healthLine(health), costUsd: cost, durationMs, dropped });
  }

  private titled(items: Priority[], inputs: RankInputs) {
    const by = new Map(inputs.workstreams.map(w => [w.id, w.title]));
    return items.map(p => ({ ...p, title: by.get(p.workspaceId) ?? p.workspaceId }));
  }

  /** For Home's sort header: the last run and what it could read. */
  async status(): Promise<{ enabled: boolean; running: boolean; lastRunAt: string | null; healthLine: string; error: string | null; costUsd: number | null; notStarted: number;
    last: { ok: boolean; skipped: string | null; top: string | null; provider: string | null; inputTokens: number | null; outputTokens: number | null } | null }> {
    const s = await this.state();
    const l = s.last;
    // The cost shown is the standing ranking's (the last model run), so a skipped run doesn't blank it.
    return { enabled: await this.d.enabled(), running: !!this.running, lastRunAt: s.lastRunAt, healthLine: healthLine(s.health as Partial<Record<RankSource, SourceHealth>>), error: l?.error ?? null, costUsd: s.model?.costUsd ?? null, notStarted: s.notStarted.length,
      last: l ? { ok: l.ok, skipped: l.skipped, top: l.top, provider: s.model?.provider ?? null, inputTokens: l.inputTokens, outputTokens: l.outputTokens } : null };
  }

  /**
   * Starts a run and returns at once: a slow model would outlast the plugin RPC's ~60 s timeout. The caller polls
   * status() until running is false. A run already going is joined, not doubled.
   */
  start(opts: { trigger: RankTrigger; force?: boolean }): { started: boolean } {
    if (this.running) return { started: false };
    void this.run(opts).catch(() => undefined);
    return { started: true };
  }
}
