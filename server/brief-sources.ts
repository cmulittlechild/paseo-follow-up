import { applySourcesChange, briefSources, GITHUB_SOURCE, recipe, sourceId, sourcesLine, upstreamHealth, type BriefSource, type RecipeId, type SourceRead, type SourcesChange, type SourcesView, type Upstream } from "../shared/brief-sources";
import { isGithubOff, type GithubOff } from "../shared/github-setup";
import type { AskItem } from "../shared/ask";
import type { AskPlan, AskResult } from "./ask";
import { clockFor, isWorkday, zoned } from "../shared/linear-queue";
import type { MorningBriefStore } from "./morning-brief";
import type { SourceDirectory } from "./source-tools";

/** The ranker's sources as the Sources card names them. */
const RANK_TO_RECIPE = { slack: "chat", calendar: "calendar", mail: "mail" } as const;

export type BriefSourcesDeps = {
  store: MorningBriefStore;
  tools: SourceDirectory;
  /** The ranker's last run: what each source read, and each failed one's line. */
  ranker: () => Promise<{ lastRunAt: string | null; health: Record<string, string>; errors: Record<string, string> }>;
  /** The queue's last sweep (the Linear source's read). */
  sweep: () => Promise<SourceRead | null>;
  /** Every github.com account `gh` is logged in to. */
  githubAccounts: () => Promise<string[]>;
  /** Retry: one read of a source now. Throws its error. */
  probe: (id: RecipeId | "github") => Promise<void>;
  deviceZone: () => string | null;
  /** One Ask of a server (server/ask.ts askSource, bound to the worker's directory, jobs and the Summary's role). */
  ask?: (server: string, opts: { since: number; plan: AskPlan | null; timeZone: string }) => Promise<AskResult>;
  /** The governor says the VM is tight: the morning's asks wait (they spend model calls). */
  tight?: () => boolean;
  /**
   * A morning's asks stored items that differ from the last ones: the ranker's next tick runs once even inside its
   * cadence, so today's items reach today's rank (its scheduled run can start before the asks finish).
   */
  onAsked?: () => void;
  now?: () => number;
  onChange?: () => void;
  log?: (line: string) => void;
};

const oneLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].replace(/\s+/g, " ").slice(0, 200);

/**
 * Settings → Morning brief's Sources (docs/morning-brief.md#sources): what mcpproxy has, which recipe each server
 * matches, the developer's switches and each source's health. mcpproxy is asked when Settings opens (`view({check})`),
 * on Check sources again, and once on a workday morning with the sweep (`tick`); never on its own timer. The RPCs
 * answer at once from what's known: a check or a Retry runs after the reply, and the view says it's running.
 */
export class BriefSources {
  private upstreamList: Upstream[] | null = null;
  private checking: Promise<void> | null = null;
  private lastError: string | null = null;
  private retrying = new Set<string>();
  private previewing = new Set<string>();
  private asking: Promise<void> | null = null;
  /** gh's account count, refreshed after each read (the card never waits on gh); null until gh first answers. */
  private accounts: number | null = null;
  private githubOff: GithubOff | null = null;
  private countingAccounts: Promise<void> | null = null;
  constructor(private d: BriefSourcesDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  /** Ask mcpproxy again: its servers and their read tools. One check at a time. */
  check(): Promise<void> {
    return this.checking ??= (async () => {
      try {
        const [upstreams] = await Promise.all([this.d.tools.upstreams(), this.d.tools.discover("always")]);
        this.upstreamList = upstreams; this.lastError = null;
      } catch (e) { this.lastError = `mcpproxy couldn't list its servers: ${oneLine(e)}`; this.d.log?.(`[follow-up] morning brief: ${this.lastError}`); }
      await this.d.store.mutate(f => { f.sources.checkedAt = new Date(this.now()).toISOString(); });
    })().finally(() => { this.checking = null; this.d.onChange?.(); });
  }

  /** The rows, with each source's last read: the newest of the ranker's run, the sweep and a Retry. */
  private async rows(): Promise<BriefSource[]> {
    this.countingAccounts ??= this.d.githubAccounts().then(a => { this.accounts = a.length; this.githubOff = null; }, e => { this.accounts = 0; this.githubOff = isGithubOff(e) ? e.off : null; }).finally(() => { this.countingAccounts = null; });
    const accounts = this.accounts;
    const [file, rank, sweep] = await Promise.all([this.d.store.read(), this.d.ranker().catch(() => null), this.d.sweep().catch(() => null)]);
    const discovery = this.d.tools.cached();
    const matched = discovery?.matched ?? [];
    const reads: Record<string, SourceRead | undefined> = {};
    const newer = (id: string, r: SourceRead | null | undefined) => { if (r && (!reads[id] || reads[id]!.at < r.at)) reads[id] = r; };
    // Each recipe's reads land on the server that served it: the first one that's on.
    const serving = (id: RecipeId) => matched.find(m => m.recipe === id && (file.sources.on[sourceId(m.server)] ?? recipe(id).defaultOn))?.server ?? null;
    if (rank?.lastRunAt) {
      for (const [k, id] of Object.entries(RANK_TO_RECIPE)) {
        const h = rank.health[k]; const server = serving(id);
        if (server && (h === "ok" || h === "failed")) newer(sourceId(server), { at: rank.lastRunAt, ok: h === "ok", error: h === "failed" ? rank.errors[k] ?? "The last read failed." : null });
      }
      const gh = rank.health.github;
      if (gh === "ok" || gh === "failed") newer(GITHUB_SOURCE, { at: rank.lastRunAt, ok: gh === "ok", error: gh === "failed" ? rank.errors.github ?? "The last read failed." : null });
    }
    const linear = serving("linear");
    if (linear) newer(sourceId(linear), sweep);
    for (const [id, r] of Object.entries(file.sources.reads)) newer(id, r);
    return briefSources({ upstreams: this.upstreamList ?? [], matched, on: file.sources.on, reads, github: { accounts, off: this.githubOff }, asked: file.sources.asked, now: this.now() });
  }

  /** The card's rows. `check` (Settings opening) asks mcpproxy again after replying; so does a first read. */
  async view(opts: { check?: boolean } = {}): Promise<SourcesView> {
    if (opts.check || (!this.upstreamList && !this.lastError)) void this.check();
    const sources = await this.rows();
    const file = await this.d.store.read();
    return { sources, checkedAt: file.sources.checkedAt, error: this.lastError, line: sourcesLine(sources), checking: !!this.checking, retrying: [...this.retrying], previewing: [...this.previewing] };
  }

  /** Whether a recipe's source is on, and which of its servers the brief may read (the ranker's and the finder's gate). */
  async gate(id: RecipeId | "github", opts: { cachedOnly?: boolean } = {}): Promise<{ on: boolean; allowed?: (server: string) => boolean }> {
    const on = (await this.d.store.read()).sources.on;
    if (id === "github") return { on: on[GITHUB_SOURCE] ?? true };
    const allowed = (server: string) => on[sourceId(server)] ?? recipe(id).defaultOn;
    const discovery = opts.cachedOnly ? this.d.tools.cached() : await this.d.tools.discover().catch(() => null);
    // No server has it: "on" (the read itself reports there's nothing to read). One that's off everywhere: off.
    const servers = (discovery?.matched ?? []).filter(m => m.recipe === id);
    return { on: !servers.length ? recipe(id).defaultOn : servers.some(m => allowed(m.server)), allowed };
  }

  /** Turn sources on or off, Retry one, or check again. Unknown ids, Paseo and sources with no recipe are refused. */
  /** Turn sources on or off (at once), Retry one or check again (after the reply: the view says they're running). */
  async set(change: SourcesChange): Promise<SourcesView> {
    const rows = await this.rows();
    const next = applySourcesChange((await this.d.store.read()).sources.on, rows, change, this.now());
    if (!next.ok) throw new Error(next.error);
    await this.d.store.mutate(f => { f.sources.on = next.on; });
    if (change.check) void this.check();
    if (change.retry && !this.retrying.has(change.retry)) {
      const row = rows.find(r => r.id === change.retry)!;
      this.retrying.add(row.id);
      void (row.kind === "ask" ? this.ask(row, false) : this.retry(row)).finally(() => { this.retrying.delete(row.id); this.d.onChange?.(); });
    }
    if (change.preview && !this.previewing.has(change.preview)) {
      const row = rows.find(r => r.id === change.preview)!;
      this.previewing.add(row.id);
      void this.ask(row, true).finally(() => { this.previewing.delete(row.id); this.d.onChange?.(); });
    }
    this.d.onChange?.();
    return this.view();
  }

  /** Settle: a running check and Retries (tests and the agent tool's caller that wants the outcome). */
  async settled(): Promise<void> { while (this.checking || this.asking || this.retrying.size || this.previewing.size) await (this.checking ?? this.asking ?? new Promise(r => setTimeout(r, 20))); }

  /**
   * One Ask of an Ask source (a preview, a Retry or the morning's): its plan reused while fresh, its result kept as
   * the source's last ask. "Since" is its last morning ask, else a day ago.
   */
  private async ask(row: BriefSource, preview: boolean): Promise<void> {
    if (!this.d.ask || !row.server) return;
    const file = await this.d.store.read();
    const last = file.sources.asked[row.id];
    const since = last && !last.preview ? Date.parse(last.at) : this.now() - 86_400_000;
    const timeZone = clockFor(file.queue, this.d.deviceZone()).timeZone;
    const r = await this.d.ask(row.server, { since, plan: file.sources.plans[row.server] ?? null, timeZone });
    await this.d.store.mutate(f => {
      f.sources.asked[row.id] = { at: r.at, preview, items: r.items, calls: r.calls, error: r.error ? r.error.slice(0, 300) : null };
      if (r.plan) f.sources.plans[row.server!] = r.plan;
    });
  }

  /** What the Ask sources that are on found this morning, for the ranker (it reads them; it never asks). */
  async askedItems(): Promise<{ source: string; items: AskItem[] }[]> {
    const file = await this.d.store.read();
    const day = this.now() - 86_400_000;
    return Object.entries(file.sources.asked)
      .filter(([id, a]) => file.sources.on[id] === true && !a.preview && !a.error && a.items.length && Date.parse(a.at) >= day)
      .map(([id, a]) => ({ source: id.replace(/^mcp:/, ""), items: a.items }));
  }

  /** The morning's asks: each Ask source that's on, once a workday after the sweep time, one at a time. */
  private async morningAsks(dayStart: number): Promise<void> {
    // Cheap first (the loop runs every 15 s): only Ask sources that are on, whose upstream is fine in the last list
    // (a signed-out or disconnected one is skipped here, so it costs one store read a tick), and not asked since this
    // morning's sweep time. No upstream list yet: unknown is not off, so it counts.
    const file0 = await this.d.store.read();
    const upstreamOk = (server: string) => !this.upstreamList || upstreamHealth(this.upstreamList.find(u => u.name === server)).health === "ok";
    const due = (this.d.tools.cached()?.matched ?? []).some(m => !m.recipe && m.readTools > 0 && file0.sources.on[sourceId(m.server)] === true && upstreamOk(m.server)
      && !((a => a && !a.preview && Date.parse(a.at) >= dayStart)(file0.sources.asked[sourceId(m.server)])));
    if (!due || !this.d.ask) return;
    return this.asking ??= (async () => {
      const rows = (await this.rows()).filter(r => r.kind === "ask" && r.on && r.server && upstreamOk(r.server));
      const file = await this.d.store.read();
      let changed = false;
      for (const row of rows) {
        const last = file.sources.asked[row.id];
        if (last && !last.preview && Date.parse(last.at) >= dayStart) continue;
        if (this.d.tight?.()) break;
        const before = last && !last.preview ? JSON.stringify(last.items) : null;
        await this.ask(row, false);
        const after = (await this.d.store.read()).sources.asked[row.id];
        if (after && !after.error && JSON.stringify(after.items) !== before) changed = true;
      }
      if (changed) this.d.onAsked?.();
    })().finally(() => { this.asking = null; this.d.onChange?.(); });
  }

  /** One read of a source now; its result is the source's health until the next read. */
  private async retry(row: BriefSource): Promise<void> {
    const id: RecipeId | "github" | null = row.id === GITHUB_SOURCE ? "github" : row.recipe;
    if (!id) return;
    const at = new Date(this.now()).toISOString();
    let read: SourceRead;
    try { await this.d.probe(id); read = { at, ok: true, error: null }; }
    catch (e) { read = { at, ok: false, error: oneLine(e) }; }
    await this.d.store.mutate(f => { f.sources.reads[row.id] = read; });
  }

  /** The worker's loop: once a workday, after the sweep time, ask mcpproxy again (with the morning run), then the Ask sources. */
  async tick(): Promise<void> {
    if (this.checking || this.asking) return;
    const file = await this.d.store.read();
    const clock = clockFor(file.queue, this.d.deviceZone());
    const now = this.now(); const z = zoned(now, clock.timeZone);
    if (!isWorkday(now, clock)) return;
    const [h, m] = file.queue.sweepAt.split(":").map(Number);
    if (z.hour * 60 + z.minute < h * 60 + m) return;
    const sweptAt = now - (z.hour * 60 + z.minute - h * 60 - m) * 60_000;
    if (!(file.sources.checkedAt && zoned(Date.parse(file.sources.checkedAt), clock.timeZone).day === z.day && Date.parse(file.sources.checkedAt) >= sweptAt)) await this.check();
    await this.morningAsks(sweptAt);
  }
}
