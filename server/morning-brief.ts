import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { liveRun, sourceDirectory, type SourceDirectory } from "./source-tools";
import { clockFor, type BriefSettings, type Clock } from "../shared/linear-queue";
import {
  applyPlanChange, applyQueueChange, canonicalArtifactUrl, effectivePlan, emptyMorningBrief, importFromRegistry, morningBriefFileSchema, moveToCompass, planSources,
  parseChatRefs, recordFound, type BriefSettingsView, type FoundPlan, type PlanPreview, type MorningBriefFile, type PlanChange, type PlanRead, type PlanView, type QueueChange,
} from "../shared/morning-brief";

/** One short line for a failed chat or plan read: a timeout, a failed command, or the error's first line. */
function readError(error: unknown, what = "The chat search"): string {
  const e = error as { killed?: unknown; signal?: unknown; message?: unknown };
  if (e?.killed || e?.signal === "SIGTERM") return `${what} didn't answer in time.`;
  const message = typeof e?.message === "string" ? e.message.split("\n")[0] : String(error);
  if (!/^Command failed/i.test(message)) return message.slice(0, 200);
  return what === "The chat search" ? "mcpproxy couldn't run the chat search." : `${what} couldn't be read.`;
}

export class MorningBriefStore extends JsonFileStore<MorningBriefFile> {
  constructor(directory: string) {
    super({ path: join(directory, "morning-brief.json"), schema: morningBriefFileSchema as never, empty: emptyMorningBrief });
  }
}

/** Where the morning-brief skill keeps its registry: read once, at run time, on this host only. */
export const SKILL_REGISTRY = join(homedir(), ".codex/skills/morning-brief/references/sources.json");

type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
const runFile: Run = liveRun;

/**
 * The chat search the one-time move resolves names with (and `brief_chat_search`, an alias of compass_find): read-only `mcpproxy call tool-read` calls, 20 s each, to whichever
 * server has the chat recipe's tools (found by their shape, never by a server name: shared/brief-sources.ts). Each
 * call carries only the inputs that tool's schema takes. `allowed`: the brief's switches (a chat source turned off
 * isn't searched).
 */
export type ChatSearch = {
  people(query: string): Promise<string>;
  channels(query: string): Promise<string>;
};
export function mcpproxyChat(run: Run = runFile, opts: { tools?: SourceDirectory; allowed?: () => Promise<((server: string) => boolean) | undefined> } = {}): ChatSearch {
  const tools = opts.tools ?? sourceDirectory(run);
  const call = async (role: string, args: Record<string, unknown>, reason: string) => tools.call("chat", role, args, { reason, timeoutMs: 20_000, allowed: await opts.allowed?.() });
  const words = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    people: q => call("people", { keywords: words(q), query: q.trim(), natural_language_query: "", limit: 10, response_format: "detailed" }, "move the weekly plan's person into Compass"),
    channels: q => call("channels", { keywords: words(q), query: q.trim(), natural_language_query: "", limit: 10, channel_types: "public_channel,private_channel", response_format: "detailed" }, "move the weekly plan's channels into Compass"),
  };
}

export type MorningBriefDeps = {
  store: MorningBriefStore;
  /** The chat search the one-time move resolves a name without an id with. Null: none connected (names stay unmoved). */
  chat: ChatSearch | null;
  /** FOLLOW_UP_PLAN_URL: wins over every mode, shown read-only. */
  env: () => string | null | undefined;
  /** The developer's device zone (follow.client-time-zone). */
  deviceZone: () => string | null;
  registry?: string;
  /** One artifact read (the ranker's), kept as its plan for the day. */
  readPlan?: (url: string) => Promise<{ title: string | null; items: unknown[] }>;
  /** The ranker's cached plan read, its items matched to issues. */
  lastRead?: () => Promise<PlanRead | null>;
  /** Read the sources that post the plan now (Compass's read of just those). */
  readPlans?: () => Promise<void>;
  now?: () => number;
  newId?: () => string;
  onChange?: () => void;
  log?: (line: string) => void;
};

/**
 * The brief's settings (Settings → Compass's When, and the plan card): the queue's settings and this week's plan. One
 * file (`morning-brief.json`), Compass's settings beside them. The plan arrives from Compass: a source that posts the
 * plan shares a claude.ai artifact, Compass's read sees it and calls `recordPlan`, and its title is read at once. There
 * is no search of its own and no timer (the-brief-has-one-timer). The skill registry is imported once, and Find it
 * for me's person and channels move into Compass once (one-place-for-priority-inputs).
 */
export class MorningBrief {
  private importing: Promise<void> | null = null;
  constructor(private d: MorningBriefDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  /** The file, after the one-time import and the one-time move. */
  async read(): Promise<MorningBriefFile> {
    await (this.importing ??= this.importOnce().then(() => this.moveOnce()).finally(() => { this.importing = null; }));
    return this.d.store.read();
  }
  async settings(): Promise<BriefSettings> { return (await this.read()).queue; }
  async clock(): Promise<Clock> { return clockFor((await this.read()).queue, this.d.deviceZone()); }
  async planUrl(): Promise<string | null> { return effectivePlan(await this.read(), this.d.env()).url; }

  /**
   * The one-time import (decision Q6): with nothing set yet, the morning-brief skill's registry's discovery block
   * becomes the plan's person and channels (moved into Compass next) and its verified link the first find. Read at run
   * time, never copied, logged or edited. It runs once, found or not; a setting already made is never replaced.
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
      const untouched = !f.plan.link && !f.plan.person && !f.found;
      if (imported && untouched) { f.plan = imported.plan; if (imported.found) f.found = imported.found; }
    });
    if (imported) this.d.log?.("[follow-up] morning brief: imported the plan settings from the morning-brief skill (once)");
  }

  /**
   * The one-time move (one-place-for-priority-inputs): Find it for me's person and channels become a Compass source
   * that posts the plan, in the same file. A name kept without a chat id is looked up once by the chat search (an exact
   * name match); one still not found stays in `plan.unmoved`, by name, so nothing is lost (invariant 7).
   */
  private async moveOnce(): Promise<void> {
    const file = await this.d.store.read();
    if (file.plan.movedAt) return;
    const need = [...(file.plan.person && !file.plan.person.id ? [["people", file.plan.person.name] as const] : []), ...file.plan.channels.filter(c => !c.id).map(c => ["channels", c.name] as const)];
    const resolve = new Map<string, string>();
    for (const [kind, name] of need) {
      if (!this.d.chat) break;
      try {
        const hit = parseChatRefs(await (kind === "people" ? this.d.chat.people(name) : this.d.chat.channels(name)), kind).find(r => r.id && r.name.toLowerCase() === name.toLowerCase());
        if (hit?.id) resolve.set(`${kind === "people" ? "@" : "#"}${name.toLowerCase()}`, hit.id);
      } catch { /* not found: it stays unmoved, by name */ }
    }
    let moved = false;
    await this.d.store.mutate(f => {
      if (f.plan.movedAt) return;
      const r = moveToCompass(f.plan, f.compass, { now: this.now(), newId: () => this.d.newId?.() ?? `s-${randomBytes(5).toString("hex")}`, resolve });
      f.plan = r.plan; f.compass = r.compass; moved = r.moved;
    });
    if (moved) this.d.log?.("[follow-up] morning brief: moved this week's plan's person and channels into Compass (once)");
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
      mode: file.plan.mode, link: file.plan.link, linkAt: file.plan.linkAt, replaceWhenNewer: file.plan.replaceWhenNewer,
      url: eff.url, source: eff.source, env: canonicalArtifactUrl(this.d.env()),
      found: file.found, previous: file.previous,
      read: read && read.url === eff.url ? read : null,
      sources: planSources(file.compass).map(s => ({ id: s.id, label: s.label })), unmoved: file.plan.unmoved, importedAt: file.importedAt,
    };
  }

  async setQueue(change: QueueChange): Promise<BriefSettingsView> {
    await this.read();
    await this.d.store.mutate(f => { f.queue = applyQueueChange(f.queue, change); });
    this.d.onChange?.();
    return this.view();
  }

  /** Change the plan settings. `find` reads the sources that post the plan now. A pasted link that isn't a claude.ai artifact is refused. */
  async setPlan(change: PlanChange): Promise<PlanView> {
    const before = await this.read();
    const next = applyPlanChange(before.plan, change, this.now());
    if (!next.ok) throw new Error(next.error);
    await this.d.store.mutate(f => { f.plan = next.plan; });
    if (change.find) await this.d.readPlans?.().catch(() => undefined);
    this.d.onChange?.();
    return this.planView();
  }

  /**
   * A plan Compass found (a claude.ai artifact a "Posts the plan" source shared): it becomes this week's, the one
   * before it last week's, and a new one's title is read at once (the ranker's plan read for the day). Returns whether
   * it was new.
   */
  async recordPlan(found: Omit<FoundPlan, "foundAt">): Promise<boolean> {
    const file = await this.read();
    if (file.found?.url === found.url || file.previous?.url === found.url) return false;
    // Older than the plan in hand: a read over the last week can meet last week's link after this week's.
    if (file.found?.postedAt && found.postedAt && Date.parse(found.postedAt) <= Date.parse(file.found.postedAt)) return false;
    await this.d.store.mutate(f => { Object.assign(f, recordFound(f, { ...found, foundAt: new Date(this.now()).toISOString() })); });
    const url = await this.planUrl();
    if (url === found.url) void this.d.readPlan?.(url).then(() => this.d.onChange?.(), () => undefined);
    this.d.onChange?.();
    return true;
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
}
