import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { readError, linearMissing } from "./linear-issues";
import type { LinearIssue } from "../shared/linear-issues";
import {
  BRIEF_SETTINGS_DEFAULT, QUEUE, briefSince, byUrgency, changeLine, changesSince, current, diffSweeps, emptyQueueFile, leftCause, leftKeys, markSeen, missedRead, morningDue,
  priorityName, pruneLog, queueFileSchema, queueIssues, toQueueIssue, workdaySince, zoned,
  type BriefSettings, type Clock, type LogEntry, type QueueChange, type QueueFile, type QueueIssue, type Sweep, type SweepTrigger,
} from "../shared/linear-queue";

export class LinearQueueStore extends JsonFileStore<QueueFile> {
  constructor(directory: string) {
    super({ path: join(directory, "linear-queue.json"), schema: queueFileSchema as never, empty: emptyQueueFile });
  }
}

/** The slice of the Linear reader (server/linear-issues.ts) a sweep uses. */
export type QueueReader = {
  queuePage(state: string, cursor: string | null, limit?: number): Promise<{ issues: LinearIssue[]; next: string | null; readable: boolean; whole: boolean }>;
  leftIssue(key: string): Promise<LinearIssue | null>;
  /** The developer's Linear user id; read once, cached in the store. */
  viewerId(): Promise<string | null>;
};

export type LinearQueueDeps = {
  store: LinearQueueStore;
  linear: QueueReader;
  settings?: () => Promise<BriefSettings>;
  clock: () => Promise<Clock>;
  /** Workspaces by Linear key (unarchived, with the key linked): "has a workspace" in the queue view. */
  workspaces?: () => Promise<Map<string, { workspaceId: string; title: string }>>;
  /** The governor: background sweeps (the morning one) wait while this is true. */
  tight?: () => Promise<boolean> | boolean;
  now?: () => number;
  onChange?: () => void;
  log?: (line: string) => void;
};

/** A cut-off page is read again with fewer issues; past the last size the sweep is partial. */
const RETRY_LIMITS = [10, 5] as const;
/** How long `sweep_queue` and Sweep now wait for a sweep before answering "still sweeping". */
export const SWEEP_WAIT_MS = 45_000;

export type SweepResult = { ok: boolean; complete: boolean; total: number; pages: number; reads: number; changes: number; error: string | null; durationMs: number; trigger: SweepTrigger };
export type QueueFilter = "all" | "no-workspace" | "changed";
export type QueueView = {
  status: {
    sweptAt: string | null; complete: boolean | null; running: boolean; total: number;
    last: QueueFile["last"];
    /** "showing Friday 18:00's": the snapshot is older than the last attempt, which failed or was partial. */
    stale: boolean;
    timeZone: string; sweepAt: string;
  };
  since: string | null;
  changes: (QueueChange & { line: string; workspace: { workspaceId: string; title: string } | null })[];
  groups: { priority: number; name: string; count: number; issues: (QueueIssue & { workspace: { workspaceId: string; title: string } | null; change: string | null })[] }[];
  counts: { all: number; noWorkspace: number; changed: number };
  more: number;
};

/**
 * The Morning brief's Linear queue (docs/morning-brief.md). One sweep at a time reads every page of the developer's
 * issues in the queue's states (the-queue-is-whole: or says it is partial, and a partial sweep never replaces a whole
 * one), diffs it against the last complete sweep, and logs the changes for 14 days. It runs at the workday's sweep time
 * (from the worker's existing 15 s loop: the-brief-has-one-timer), when the brief is opened on a snapshot older than
 * 6 h, and on Sweep now; never otherwise.
 */
export class LinearQueue {
  private running: Promise<SweepResult> | null = null;
  constructor(private d: LinearQueueDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private settings() { return this.d.settings?.() ?? Promise.resolve(BRIEF_SETTINGS_DEFAULT); }
  isRunning() { return !!this.running; }
  read(): Promise<QueueFile> { return this.d.store.read(); }

  /** The worker's loop: the morning sweep once a workday after the sweep time, the governor permitting. Cheap when not due. */
  async tick(): Promise<SweepResult | null> {
    if (this.running) return null;
    const [file, settings, clock] = await Promise.all([this.read(), this.settings(), this.d.clock()]);
    const now = this.now();
    if (!morningDue(file, now, clock, settings.sweepAt)) return null;
    if (await this.d.tight?.()) return null; // still due: the next tick tries again
    const day = zoned(now, clock.timeZone).day;
    await this.d.store.mutate(f => { f.morningDay = day; });
    return this.sweep("morning");
  }

  /** One sweep; a second caller joins the one in flight. */
  sweep(trigger: SweepTrigger): Promise<SweepResult> {
    if (this.running) return this.running;
    this.running = this.once(trigger).finally(() => { this.running = null; this.d.onChange?.(); });
    this.d.onChange?.();
    return this.running;
  }

  /** Sweep now (the button or `sweep_queue`): waits up to `waitMs`, then answers that it is still sweeping. */
  async sweepNow(trigger: SweepTrigger, waitMs = SWEEP_WAIT_MS): Promise<SweepResult | { running: true }> {
    const run = this.sweep(trigger);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<{ running: true }>(resolve => { timer = setTimeout(() => resolve({ running: true }), waitMs); });
    try { return await Promise.race([run, late]); } finally { if (timer) clearTimeout(timer); }
  }

  private async once(trigger: SweepTrigger): Promise<SweepResult> {
    const started = this.now();
    const settings = await this.settings();
    let reads = 0, pages = 0;
    const issues: Record<string, QueueIssue> = {};
    let complete = true, error: string | null = null, partial: string | null = null;
    try {
      // Every page of every queue state, PAGE_SIZE at a time; a cut-off page is re-read smaller.
      outer: for (const state of settings.states) {
        let cursor: string | null = null;
        for (;;) {
          if (pages >= QUEUE.pagesMax) { complete = false; partial = `partial: ${QUEUE.pagesMax * 25}+ issues`; break outer; }
          let page = await this.d.linear.queuePage(state, cursor); reads++;
          for (const limit of RETRY_LIMITS) {
            if (page.whole) break;
            page = await this.d.linear.queuePage(state, cursor, limit); reads++;
          }
          if (!page.readable && !page.issues.length) throw new Error("Linear's reply couldn't be read.");
          pages++;
          for (const i of page.issues) if (i.stateType !== "completed" && i.stateType !== "canceled") issues[i.key] = toQueueIssue(i);
          if (!page.whole) { complete = false; partial = "partial: a page came back cut off"; break outer; }
          if (!page.next) break;
          cursor = page.next;
        }
      }
    } catch (e) {
      error = linearMissing(e) ? "Linear isn't connected." : readError(e);
    }
    const at = new Date(started).toISOString();
    if (error) {
      // A failed sweep keeps the last complete snapshot; the status says which one is showing.
      await this.d.store.mutate(f => { f.last = { at, trigger, ok: false, complete: false, pages, reads, durationMs: this.now() - started, error, total: 0 }; });
      this.d.log?.(`[follow-up] linear queue: sweep failed: ${error}`);
      return { ok: false, complete: false, total: 0, pages, reads, changes: 0, error, durationMs: this.now() - started, trigger };
    }
    const next: Sweep = { at, complete, pages, issues };
    const file = await this.read();
    const prev = file.sweeps.find(s => s.complete) ?? null;
    // Issues that left: one lookup each (the most urgent LOOKUPS_MAX), to say done, canceled or reassigned.
    // A lookup that finds the issue still the developer's, in a queue state, is a missed read: it goes back into this
    // sweep from the lookup and logs nothing (the-queue-is-whole).
    const left: Record<string, LogEntry["left"]> = {};
    if (prev && complete) {
      const keys = leftKeys(prev, next);
      let viewer = file.viewer;
      if (keys.length && !viewer) {
        try { viewer = await this.d.linear.viewerId(); reads++; } catch { viewer = null; }
        if (viewer) { const id = viewer; await this.d.store.mutate(f => { f.viewer = id; }); }
      }
      for (const key of keys) {
        try {
          const found = await this.d.linear.leftIssue(key);
          if (found && missedRead(found, viewer, settings.states)) issues[key] = toQueueIssue(found);
          else left[key] = leftCause(found, settings.states);
        } catch { left[key] = { cause: "unknown", state: null, to: null }; }
        reads++;
      }
    }
    const entries = prev && complete ? diffSweeps(prev, next, left) : [];
    await this.d.store.mutate(f => {
      if (complete) f.sweeps = [next, ...f.sweeps.filter(s => s.complete)].slice(0, 2);
      // the-queue-is-whole: a partial sweep replaces only a partial one (or nothing), never a complete one.
      else if (!f.sweeps.some(s => s.complete)) f.sweeps = [next];
      if (entries.length || f.log.some(e => started - Date.parse(e.at) > QUEUE.logDays * 86_400_000)) f.log = [...pruneLog(f.log, started), ...entries];
      f.last = { at, trigger, ok: true, complete, pages, reads, durationMs: this.now() - started, error: partial, total: Object.keys(issues).length };
    });
    return { ok: true, complete, total: Object.keys(issues).length, pages, reads, changes: entries.length, error: partial, durationMs: this.now() - started, trigger };
  }

  /**
   * The developer opened the brief: sweep in the background when the last complete sweep is older than 6 h, and mark
   * the read (a-change-is-against-what-you-last-saw). Returns the view against the read before this session.
   */
  async open(): Promise<QueueView> {
    const now = this.now();
    const file = await this.read();
    const last = file.sweeps.find(s => s.complete) ?? null;
    if (!this.running && (!last || now - Date.parse(last.at) >= QUEUE.staleMs)) void this.sweep("open").catch(() => undefined);
    await this.d.store.mutate(f => { f.seen = markSeen(f.seen, now); });
    return this.view({});
  }

  /** The queue as the brief, the queue screen and `linear_queue` read it. `since` defaults to the brief's. */
  async view(o: { filter?: QueueFilter; since?: string | null; limit?: number }): Promise<QueueView> {
    const [file, settings, clock, workspaces] = await Promise.all([this.read(), this.settings(), this.d.clock(), this.d.workspaces?.().catch(() => new Map()) ?? Promise.resolve(new Map())]);
    const now = this.now();
    const since = o.since !== undefined ? o.since : briefSince(file, now, clock, settings.since);
    const snap = current(file);
    const changes = changesSince(file.log, since).map(c => ({ ...c, line: changeLine(c), workspace: workspaces.get(c.key) ?? null }));
    const changed = new Map(changes.map(c => [c.key, c.line]));
    const all = queueIssues(snap).map(i => ({ ...i, workspace: workspaces.get(i.key) ?? null, change: changed.get(i.key) ?? null }));
    const filtered = o.filter === "no-workspace" ? all.filter(i => !i.workspace) : o.filter === "changed" ? all.filter(i => i.change) : all;
    const limit = o.limit ?? filtered.length;
    const shown = filtered.slice(0, limit);
    const groups = [1, 2, 3, 4, 0].map(priority => ({ priority, name: priorityName(priority), count: filtered.filter(i => i.priority === priority).length, issues: shown.filter(i => i.priority === priority) })).filter(g => g.count);
    const lastAttempt = file.last;
    return {
      status: { sweptAt: snap?.at ?? null, complete: snap?.complete ?? null, running: this.isRunning(), total: all.length, last: lastAttempt,
        stale: !!snap && !!lastAttempt && lastAttempt.at !== snap.at, timeZone: clock.timeZone, sweepAt: settings.sweepAt },
      since, changes, groups,
      counts: { all: all.length, noWorkspace: all.filter(i => !i.workspace).length, changed: all.filter(i => i.change).length },
      more: Math.max(0, filtered.length - shown.length),
    };
  }

  /**
   * The ranker's Linear input: the queue's top issues by priority plus every issue changed since the last workday's
   * sweep (stable all day, so opening the brief doesn't re-rank), each with its change. No snapshot yet: one sweep first.
   */
  async forRanker(): Promise<(QueueIssue & { change: string | null })[]> {
    let file = await this.read();
    if (!current(file)) { await this.sweep("ranker"); file = await this.read(); }
    const snap = current(file);
    if (!snap) throw new Error(file.last?.error ?? "Linear couldn't be read.");
    const changes = changesSince(file.log, workdaySince(file, this.now(), await this.d.clock())).filter(c => !c.kinds.includes("left"));
    const changed = new Map(changes.map(c => [c.key, changeLine(c)]));
    const top = queueIssues(snap).slice(0, QUEUE.rankerTop);
    const extra = queueIssues(snap).filter(i => changed.has(i.key) && !top.includes(i));
    return [...top, ...extra].sort(byUrgency).map(i => ({ ...i, change: changed.get(i.key) ?? null }));
  }
}
