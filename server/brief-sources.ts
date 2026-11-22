import { applySourcesChange, briefSources, GITHUB_SOURCE, recipe, sourceId, sourcesLine, type BriefSource, type RecipeId, type SourceRead, type SourcesChange, type SourcesView, type Upstream } from "../shared/brief-sources";
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
  /** gh's account count, refreshed after each read (the card never waits on gh); null until gh first answers. */
  private accounts: number | null = null;
  private countingAccounts: Promise<void> | null = null;
  constructor(private d: BriefSourcesDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }

  /** Ask mcpproxy again: its servers and their read tools. One check at a time. */
  check(): Promise<void> {
    return this.checking ??= (async () => {
      try {
        const [upstreams] = await Promise.all([this.d.tools.upstreams(), this.d.tools.discover(true)]);
        this.upstreamList = upstreams; this.lastError = null;
      } catch (e) { this.lastError = `mcpproxy couldn't list its servers: ${oneLine(e)}`; this.d.log?.(`[follow-up] morning brief: ${this.lastError}`); }
      await this.d.store.mutate(f => { f.sources.checkedAt = new Date(this.now()).toISOString(); });
    })().finally(() => { this.checking = null; this.d.onChange?.(); });
  }

  /** The rows, with each source's last read: the newest of the ranker's run, the sweep and a Retry. */
  private async rows(): Promise<BriefSource[]> {
    this.countingAccounts ??= this.d.githubAccounts().then(a => { this.accounts = a.length; }, () => { this.accounts = 0; }).finally(() => { this.countingAccounts = null; });
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
    return briefSources({ upstreams: this.upstreamList ?? [], matched, on: file.sources.on, reads, github: { accounts } });
  }

  /** The card's rows. `check` (Settings opening) asks mcpproxy again after replying; so does a first read. */
  async view(opts: { check?: boolean } = {}): Promise<SourcesView> {
    if (opts.check || (!this.upstreamList && !this.lastError)) void this.check();
    const sources = await this.rows();
    const file = await this.d.store.read();
    return { sources, checkedAt: file.sources.checkedAt, error: this.lastError, line: sourcesLine(sources), checking: !!this.checking, retrying: [...this.retrying] };
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
    const next = applySourcesChange((await this.d.store.read()).sources.on, rows, change);
    if (!next.ok) throw new Error(next.error);
    await this.d.store.mutate(f => { f.sources.on = next.on; });
    if (change.check) void this.check();
    if (change.retry && !this.retrying.has(change.retry)) {
      const row = rows.find(r => r.id === change.retry)!;
      this.retrying.add(row.id);
      void this.retry(row).finally(() => { this.retrying.delete(row.id); this.d.onChange?.(); });
    }
    this.d.onChange?.();
    return this.view();
  }

  /** Settle: a running check and Retries (tests and the agent tool's caller that wants the outcome). */
  async settled(): Promise<void> { while (this.checking || this.retrying.size) await (this.checking ?? new Promise(r => setTimeout(r, 20))); }

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

  /** The worker's loop: once a workday, after the sweep time, ask mcpproxy again (with the morning run). */
  async tick(): Promise<void> {
    if (this.checking) return;
    const file = await this.d.store.read();
    const clock = clockFor(file.queue, this.d.deviceZone());
    const now = this.now(); const z = zoned(now, clock.timeZone);
    if (!isWorkday(now, clock)) return;
    const [h, m] = file.queue.sweepAt.split(":").map(Number);
    if (z.hour * 60 + z.minute < h * 60 + m) return;
    if (file.sources.checkedAt && zoned(Date.parse(file.sources.checkedAt), clock.timeZone).day === z.day && Date.parse(file.sources.checkedAt) >= now - (z.hour * 60 + z.minute - h * 60 - m) * 60_000) return;
    await this.check();
  }
}
