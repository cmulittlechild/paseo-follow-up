import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JsonFileStore } from "./json-file-store";
import { mcpproxyText } from "./about";
import { clockFor, isWorkday, zoned, type BriefSettings, type Clock } from "../shared/linear-queue";
import {
  PLAN_FIND_DAYS, applyPlanChange, applyQueueChange, canonicalArtifactUrl, effectivePlan, emptyMorningBrief, findArtifactLink, findReady, importFromRegistry, morningBriefFileSchema,
  parseChatRefs, recordFound, searches, type BriefSettingsView, type ChatRef, type FoundPlan, type PlanPreview, type MorningBriefFile, type PlanChange, type PlanRead, type PlanView, type QueueChange,
} from "../shared/morning-brief";

/** One short line for a failed chat or plan read: a timeout, a failed command, or the error's first line. */
function readError(error: unknown, what = "The chat search"): string {
  const e = error as { killed?: unknown; signal?: unknown; message?: unknown };
  if (e?.killed || e?.signal === "SIGTERM") return `${what} didn't answer in time.`;
  const message = typeof e?.message === "string" ? e.message.split("\n")[0] : String(error);
  return /^Command failed/i.test(message) ? `${what} couldn't be read.` : message.slice(0, 200);
}

export class MorningBriefStore extends JsonFileStore<MorningBriefFile> {
  constructor(directory: string) {
    super({ path: join(directory, "morning-brief.json"), schema: morningBriefFileSchema as never, empty: emptyMorningBrief });
  }
}

/** Where the morning-brief skill keeps its registry: read once, at run time, on this host only. */
export const SKILL_REGISTRY = join(homedir(), ".codex/skills/morning-brief/references/sources.json");

const exec = promisify(execFile);
type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
const runFile: Run = async (command, args, timeout) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;

/**
 * The chat search Find it for me and the pickers use: read-only `mcpproxy call tool-read` calls, 20 s each. The tool
 * names are the chat server the ranker already reads; discovering the chat source by its tools' shape (any server
 * with a message search that takes filters) is the next phase's (docs/morning-brief.md).
 */
export type ChatSearch = {
  messages(args: { filters: string; limit: number }): Promise<string>;
  people(query: string): Promise<string>;
  channels(query: string): Promise<string>;
};
export const CHAT_TOOLS = { messages: "slack-user:slack_search_public_and_private", people: "slack-user:slack_search_users", channels: "slack-user:slack_search_channels" } as const;
export function mcpproxyChat(run: Run = runFile): ChatSearch {
  const call = async (tool: string, args: unknown, reason: string) => mcpproxyText(await run("mcpproxy", ["call", "tool-read", `--tool-name=${tool}`, `--json_args=${JSON.stringify(args)}`, `--reason=Follow-up: ${reason}`, "--log-level=error", "-o", "json"], 20_000));
  const words = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    messages: ({ filters, limit }) => call(CHAT_TOOLS.messages, { keywords: [], filters, natural_language_query: "", sort: "timestamp", sort_dir: "desc", limit, include_context: false, response_format: "detailed" }, "find this week's plan link"),
    people: q => call(CHAT_TOOLS.people, { keywords: words(q), natural_language_query: "", limit: 10, response_format: "detailed" }, "pick who posts the weekly plan"),
    channels: q => call(CHAT_TOOLS.channels, { keywords: words(q), natural_language_query: "", limit: 10, channel_types: "public_channel,private_channel", response_format: "detailed" }, "pick where the weekly plan is posted"),
  };
}


export type MorningBriefDeps = {
  store: MorningBriefStore;
  chat: ChatSearch | null;
  /** FOLLOW_UP_PLAN_URL: wins over every mode, shown read-only. */
  env: () => string | null | undefined;
  /** The developer's device zone (follow.client-time-zone). */
  deviceZone: () => string | null;
  registry?: string;
  /** One artifact read (the ranker's), kept as its plan for the day. */
  readPlan?: (url: string) => Promise<{ title: string | null; items: unknown[] }>;
  /** The ranker's cached plan read. */
  lastRead?: () => Promise<PlanRead | null>;
  now?: () => number;
  onChange?: () => void;
  log?: (line: string) => void;
};

/**
 * Settings → Morning brief: the queue's settings, the plan link and its finder. One file (`morning-brief.json`). The
 * finder runs with the morning sweep (from the worker's 15 s loop: the-brief-has-one-timer), on Look again, and when
 * the developer or an agent changes who or where; never on its own timer. The skill registry is imported once.
 */
export class MorningBrief {
  private importing: Promise<void> | null = null;
  private finding: Promise<MorningBriefFile["check"]> | null = null;
  constructor(private d: MorningBriefDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  /** The file, after the one-time import. */
  async read(): Promise<MorningBriefFile> {
    await (this.importing ??= this.importOnce().finally(() => { this.importing = null; }));
    return this.d.store.read();
  }
  async settings(): Promise<BriefSettings> { return (await this.read()).queue; }
  async clock(): Promise<Clock> { return clockFor((await this.read()).queue, this.d.deviceZone()); }
  async planUrl(): Promise<string | null> { return effectivePlan(await this.read(), this.d.env()).url; }

  /**
   * The one-time import (decision Q6): with nothing set yet, the morning-brief skill's registry's discovery block
   * becomes Find it for me and its verified link the first find. Read at run time, never copied, logged or edited.
   * It runs once, found or not; a setting the developer already made is never replaced.
   */
  private async importOnce(): Promise<void> {
    const file = await this.d.store.read();
    if (file.importedAt) return;
    const at = new Date(this.now()).toISOString();
    let imported: ReturnType<typeof importFromRegistry> = null;
    try { imported = importFromRegistry(await readFile(this.d.registry ?? SKILL_REGISTRY, "utf8"), this.now()); } catch { imported = null; }
    await this.d.store.mutate(f => {
      if (f.importedAt) return;
      f.importedAt = at;
      const untouched = f.plan.mode === "off" && !f.plan.link && !f.plan.person;
      if (imported && untouched) { f.plan = imported.plan; if (imported.found) f.found = imported.found; }
    });
    if (imported) this.d.log?.("[follow-up] morning brief: imported the plan settings from the morning-brief skill (once)");
  }

  async view(): Promise<BriefSettingsView> {
    const file = await this.read();
    const device = this.d.deviceZone();
    const clock = clockFor(file.queue, device);
    const zoneFrom = file.queue.timeZone && clock.timeZone === file.queue.timeZone ? "setting" : device && clock.timeZone === device ? "device" : "host";
    return { queue: file.queue, clock: { ...clock, zoneFrom }, plan: await this.planView(file) };
  }

  async planView(f?: MorningBriefFile): Promise<PlanView> {
    const file = f ?? await this.read();
    const eff = effectivePlan(file, this.d.env());
    const read = await this.d.lastRead?.().catch(() => null) ?? null;
    return {
      ...file.plan, url: eff.url, source: eff.source, env: canonicalArtifactUrl(this.d.env()),
      found: file.found, previous: file.previous, check: file.check,
      read: read && read.url === eff.url ? read : null,
      canFind: !!this.d.chat, findDays: PLAN_FIND_DAYS, importedAt: file.importedAt,
    };
  }

  async setQueue(change: QueueChange): Promise<BriefSettingsView> {
    await this.read();
    await this.d.store.mutate(f => { f.queue = applyQueueChange(f.queue, change); });
    this.d.onChange?.();
    return this.view();
  }

  /**
   * Change the plan settings. Changing who or where (or turning Find it for me on) searches right away, as does
   * `find`. A pasted link that isn't a claude.ai artifact is refused.
   */
  async setPlan(change: PlanChange): Promise<PlanView> {
    const before = await this.read();
    const next = applyPlanChange(before.plan, change, this.now());
    if (!next.ok) throw new Error(next.error);
    await this.d.store.mutate(f => {
      const moved = JSON.stringify([f.plan.person, f.plan.channels]) !== JSON.stringify([next.plan.person, next.plan.channels]);
      f.plan = next.plan;
      // Someone else, or other channels: what was found for the old ones isn't theirs.
      if (moved) { f.found = null; f.previous = null; f.check = null; }
    });
    const after = await this.read();
    const whoChanged = JSON.stringify([before.plan.person, before.plan.channels]) !== JSON.stringify([after.plan.person, after.plan.channels]);
    const turnedOn = before.plan.mode !== after.plan.mode && searches(after.plan);
    if (searches(after.plan) && (change.find || whoChanged || turnedOn)) await this.find();
    else if (change.find && findReady(after.plan)) await this.find();
    this.d.onChange?.();
    return this.planView();
  }

  /** `brief_plan {link}`: the link a change would use, and its title read first (the dry run of `set_brief_plan`). */
  async preview(link: string): Promise<PlanPreview> {
    const url = canonicalArtifactUrl(link);
    if (!url) return { url: null, error: "That isn't a claude.ai artifact link (https://claude.ai/artifact/…)." };
    const r = await this.readTitle(url);
    return "error" in r ? { url, error: r.error } : { url, ...r };
  }

  /** Read the plan's title now (the dry run of `set_brief_plan`, and Settings after a paste). */
  async readTitle(url: string): Promise<{ title: string | null; items: number } | { error: string }> {
    if (!this.d.readPlan) return { error: "The plan reader isn't available." };
    try { const r = await this.d.readPlan(url); return { title: r.title, items: r.items.length }; }
    catch (e) { return { error: readError(e, "The plan") }; }
  }

  /**
   * Find it for me: the newest message from the person in the channels, over 14 days, that links a claude.ai
   * artifact. One search. Not found keeps last week's plan (the brief says so).
   */
  find(): Promise<MorningBriefFile["check"]> {
    return this.finding ??= this.findOnce().finally(() => { this.finding = null; this.d.onChange?.(); });
  }
  private async findOnce(): Promise<MorningBriefFile["check"]> {
    const file = await this.read();
    const p = file.plan;
    const at = new Date(this.now()).toISOString();
    const done = async (check: NonNullable<MorningBriefFile["check"]>, found?: FoundPlan) => {
      await this.d.store.mutate(f => { f.check = check; if (found) Object.assign(f, recordFound(f, found)); });
      return check;
    };
    if (!findReady(p)) return done({ at, status: "error", error: "Pick who posts it and where." });
    if (!this.d.chat) return done({ at, status: "unavailable", error: "No chat search is connected." });
    const after = new Date(this.now() - PLAN_FIND_DAYS * 86_400_000).toISOString().slice(0, 10);
    const from = p.person!.id ? `from:<@${p.person!.id}>` : `from:${p.person!.name.replace(/\s+/g, ".")}`;
    const where = p.channels.map(c => c.id ? `in:<#${c.id}>` : `in:#${c.name}`).join(" ");
    try {
      const reply = await this.d.chat.messages({ filters: `${from} ${where} has:link after:${after}`, limit: 20 });
      const hit = findArtifactLink(reply);
      if (!hit) return done({ at, status: "not-found", error: null });
      return done({ at, status: "found", error: null }, { url: hit.url, postedAt: hit.postedAt, where: hit.where, foundAt: at });
    } catch (e) {
      const error = readError(e);
      this.d.log?.(`[follow-up] morning brief: plan search failed: ${error}`);
      return done({ at, status: "error", error });
    }
  }

  /** The worker's loop: once a workday, after the sweep time, Find it for me looks again (with the morning sweep). */
  async tick(): Promise<void> {
    if (this.finding) return;
    const file = await this.read();
    if (!searches(file.plan)) return;
    const clock = clockFor(file.queue, this.d.deviceZone());
    const now = this.now();
    const z = zoned(now, clock.timeZone);
    if (!isWorkday(now, clock) || file.findDay === z.day) return;
    const [h, m] = file.queue.sweepAt.split(":").map(Number);
    if (z.hour * 60 + z.minute < h * 60 + m) return;
    await this.d.store.mutate(f => { f.findDay = z.day; });
    await this.find();
  }

  /** The pickers: people or channels matching a query, from the chat source's own search. */
  async searchChat(kind: "people" | "channels", query: string): Promise<{ results: ChatRef[]; error: string | null }> {
    if (!this.d.chat) return { results: [], error: "No chat search is connected." };
    try { return { results: parseChatRefs(await (kind === "people" ? this.d.chat.people(query) : this.d.chat.channels(query)), kind), error: null }; }
    catch (e) { return { results: [], error: readError(e) }; }
  }
}
