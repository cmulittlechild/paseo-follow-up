import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { statsRecordSchema, STATS_PAGE_SIZE, type StatsRecord } from "../shared/pr-stats-records";
import { WriteBehind, type WriteHealth } from "./write-behind";

/**
 * PR statistics' records, one file per opted-in repository: `plugin-data/follow-up/stats/<owner>/<repo>.json`
 * (docs/pr-stats.md, docs/data-files.md). The sync merges pages into it; the metrics read it.
 *
 * Resources (invariant `stats-are-computed-on-read`): a repository's records are in memory only while something reads
 * or syncs it. `open` loads the file and keeps it in an LRU of `STATS_LOADED_MAX` repositories, each dropped
 * `STATS_KEEP_MS` after its last use, so nothing stays loaded between reads. Writes go through `WriteBehind` (an ack
 * never waits on the disk) as parts: each record's bytes are encoded once per record object and reused until that PR
 * changes, so a page of 25 PRs re-encodes 25 records, never the whole file (`a-mutation-costs-what-it-changes`).
 */
export const STATS_LOADED_MAX = 2;
export const STATS_KEEP_MS = 5 * 60_000;
/** Past this many records a repository's window shortens (oldest first) and the page says to which date. */
export const STATS_RECORDS_MAX = 25_000;
/** Allowed history windows in days (D7: 90 by default). */
export const STATS_WINDOWS = [30, 90, 180] as const;
export const STATS_WINDOW_DEFAULT = 90;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const at = z.number().int().nonnegative();
export const statsMetaSchema = z.object({
  repo: z.string().regex(REPO),
  /** The repository's default branch, from the last page read (stack detection: a PR based elsewhere may be stacked). */
  defaultBranch: z.string().nullable(),
  /** The newest updatedAt an incremental walk has fully covered (epoch s); null before the first page. */
  highWater: at.nullable(),
  /** An incremental walk cut short by the gate, resumed from here: its cursor and the newest updatedAt it saw. */
  incremental: z.object({ after: z.string(), high: at }).nullable(),
  /** The 90-day backfill: the cursor to continue from, whether it reached the window's start, how far back it reached. */
  backfill: z.object({ after: z.string().nullable(), done: z.boolean(), coveredTo: at.nullable() }),
  /** The page size: STATS_PAGE_SIZE, halved after a 502 or RESOURCE_LIMITS answer until a page succeeds. */
  page: z.number().int().positive(),
  windowDays: z.number().int().positive(),
  /** PRs whose reviews ran past the page; a follow-up query reads the rest. */
  pendingReviews: z.array(z.number().int().positive()),
  lastSyncAt: at.nullable(),
  /** Points the last run spent, and pages it read. */
  lastCost: z.number().nonnegative(),
  lastPages: z.number().int().nonnegative(),
  /** Why the last run stopped short of done: the gate's reason and when it reopens, or a read error. */
  waiting: z.object({ reason: z.enum(["governor", "budget", "slice", "busy"]), until: at.nullable() }).nullable(),
  error: z.object({ message: z.string(), status: z.number().int().nullable(), at }).nullable(),
  /** Set when the record cap shortened the window: the date records reach back to. */
  cappedTo: at.nullable(),
}).strict();
export type StatsMeta = z.infer<typeof statsMetaSchema>;
export type RepoStats = { meta: StatsMeta; records: Map<number, StatsRecord> };

export function freshMeta(repo: string, windowDays = STATS_WINDOW_DEFAULT): StatsMeta {
  return { repo, defaultBranch: null, highWater: null, incremental: null, backfill: { after: null, done: false, coveredTo: null }, page: STATS_PAGE_SIZE, windowDays, pendingReviews: [], lastSyncAt: null, lastCost: 0, lastPages: 0, waiting: null, error: null, cappedTo: null };
}

/** The file for a repository, or null for a name that isn't `owner/repo` (never a path outside `stats/`). */
export function statsPath(directory: string, repo: string): string | null {
  if (!REPO.test(repo) || repo.split("/").some(part => part === "." || part === "..")) return null;
  const [owner, name] = repo.split("/");
  return join(directory, "stats", owner!, `${name}.json`);
}

const recordBytes = new WeakMap<StatsRecord, Buffer>();
const bytesOf = (record: StatsRecord): Buffer => { let b = recordBytes.get(record); if (!b) { b = Buffer.from(JSON.stringify(record)); recordBytes.set(record, b); } return b; };
const COMMA = Buffer.from(","), END = Buffer.from("]}");
/** The file as parts: the meta, then each record's cached bytes. Byte for byte `JSON.stringify({ v, meta, records })`. */
export function encodeStats(stats: RepoStats): Buffer[] {
  const parts: Buffer[] = [Buffer.from(`{"v":1,"meta":${JSON.stringify(stats.meta)},"records":[`)];
  let first = true;
  for (const record of stats.records.values()) { if (!first) parts.push(COMMA); parts.push(bytesOf(record)); first = false; }
  parts.push(END);
  return parts;
}

type Entry = { stats: RepoStats; usedAt: number; timer: ReturnType<typeof setTimeout> | null };
export class StatsStore {
  private loaded = new Map<string, Entry>();
  private loading = new Map<string, Promise<RepoStats>>();
  private writers = new Map<string, WriteBehind<RepoStats>>();
  /** Files read from disk (tests: a record read loads once, and again only after it was dropped). */
  loads = 0;
  constructor(readonly directory: string, private o: { now?: () => number; keepMs?: number; max?: number; health?: WriteHealth; log?: (line: string) => void } = {}) {}
  private get now() { return this.o.now ?? Date.now; }

  /** Repositories in memory now. */
  inMemory(): string[] { return [...this.loaded.keys()]; }

  /**
   * A repository's records, loaded for this use. The object stays the same while it is loaded; callers read it and
   * hand changes to `save`. A missing or unreadable file is an empty store (unknown is not off: nothing is lost by
   * reading again).
   */
  async open(repo: string): Promise<RepoStats> {
    const path = statsPath(this.directory, repo);
    if (!path) throw new Error(`Not a repository: ${repo}`);
    const hit = this.loaded.get(repo);
    if (hit) { this.touch(repo, hit); return hit.stats; }
    let pending = this.loading.get(repo);
    if (!pending) {
      pending = (async () => {
        // A write still landing for a store dropped from memory is the newest copy: let it land before reading.
        await this.writers.get(repo)?.flush().catch(() => undefined);
        const stats = await this.read(repo, path);
        const entry: Entry = { stats, usedAt: this.now(), timer: null };
        this.loaded.set(repo, entry); this.touch(repo, entry); this.evict();
        return stats;
      })().finally(() => this.loading.delete(repo));
      this.loading.set(repo, pending);
    }
    return pending;
  }
  private async read(repo: string, path: string): Promise<RepoStats> {
    this.loads++;
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return { meta: freshMeta(repo), records: new Map() };
    try {
      const raw = JSON.parse(text) as { meta?: unknown; records?: unknown };
      const meta = statsMetaSchema.parse(raw.meta);
      const records = new Map<number, StatsRecord>();
      let dropped = 0;
      for (const item of Array.isArray(raw.records) ? raw.records : []) {
        const parsed = statsRecordSchema.safeParse(item);
        if (parsed.success) records.set(parsed.data.n, Object.freeze(parsed.data)); else dropped++;
      }
      if (dropped) (this.o.log ?? console.warn)(`[follow-up] PR stats: dropped ${dropped} unreadable record${dropped === 1 ? "" : "s"} of ${repo}`);
      return { meta: { ...meta, repo }, records };
    } catch (error) {
      (this.o.log ?? console.warn)(`[follow-up] PR stats: ${repo}'s file is unreadable (${error instanceof Error ? error.message : String(error)}); starting it again`);
      return { meta: freshMeta(repo), records: new Map() };
    }
  }
  private touch(repo: string, entry: Entry): void {
    entry.usedAt = this.now();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.drop(repo), this.o.keepMs ?? STATS_KEEP_MS);
    (entry.timer as { unref?: () => void }).unref?.();
  }
  private evict(): void {
    const max = this.o.max ?? STATS_LOADED_MAX;
    while (this.loaded.size > max) {
      const oldest = [...this.loaded].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]!;
      this.drop(oldest[0]);
    }
  }
  /** Drops a repository from memory; its pending write still lands (the writer keeps the value). */
  drop(repo: string): void {
    const entry = this.loaded.get(repo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.loaded.delete(repo);
    const writer = this.writers.get(repo);
    if (writer && !writer.dirty) this.writers.delete(repo);
  }

  /**
   * Merges records into a loaded repository and saves it behind the caller. A record equal to the stored one keeps
   * the stored object (and its encoded bytes): a write that changes nothing isn't a write.
   */
  merge(stats: RepoStats, records: StatsRecord[]): number {
    let changed = 0;
    for (const record of records) {
      const old = stats.records.get(record.n);
      if (old && bytesOf(old).equals(Buffer.from(JSON.stringify(record)))) continue;
      stats.records.set(record.n, Object.freeze(record)); changed++;
    }
    return changed;
  }
  /** Saves a repository behind the caller (WriteBehind: coalesced, temp + fsync + rename). */
  save(stats: RepoStats): void {
    const repo = stats.meta.repo;
    const path = statsPath(this.directory, repo);
    if (!path) return;
    let writer = this.writers.get(repo);
    if (!writer) {
      writer = new WriteBehind<RepoStats>({ path, encode: encodeStats, health: this.o.health, log: this.o.log, onWritten: () => { if (!this.loaded.has(repo) && !this.writers.get(repo)?.dirty) this.writers.delete(repo); } });
      this.writers.set(repo, writer);
    }
    writer.set({ meta: stats.meta, records: new Map(stats.records) });
  }
  /** Removes a repository's file and anything in memory (turning stats off with "Also delete"). */
  async delete(repo: string): Promise<void> {
    const path = statsPath(this.directory, repo);
    if (!path) return;
    this.drop(repo);
    const writer = this.writers.get(repo);
    if (writer) { await writer.flush().catch(() => undefined); this.writers.delete(repo); }
    await unlink(path).catch(() => undefined);
  }
  /** Writes everything pending (the worker's stop, test cleanup). */
  async flush(): Promise<void> { for (const writer of [...this.writers.values()]) await writer.flush(); }
  /** Drops everything from memory and clears the timers (the worker's stop, after flush). */
  close(): void { for (const repo of [...this.loaded.keys()]) this.drop(repo); }
}
