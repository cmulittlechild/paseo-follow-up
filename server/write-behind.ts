import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * an-ack-never-waits-on-the-disk: a small JSON file that is saved behind the reply. 2026-11-14 (CI, rpc-ack):
 * follow.save-reviewers waited 1458 ms on reviewers.json's fsync, and follow.inbox-list 664 ms on an inbox.json write it
 * queued behind. The event loop was idle both times; a loaded runner's fsync alone outlasted the 500 ms budget.
 *
 * The owner keeps the value in memory, validated and authoritative, and hands each new value to set(). The write runs
 * outside the owner's queue, the way Store.flush does: one write at a time, always of the newest value (coalesced), as a
 * temp file, fsync, then rename. A failed write keeps the value, logs, and retries with backoff. From the third failed
 * attempt it reports to `WriteHealth`, which the worker shows as its error line until the write lands. flush() (the
 * worker's stop) writes what is pending and waits for it.
 *
 * Durability: a crash before the write lands loses that value, as it does for state.json and inbox.json.
 */
export type Encoded = string | Buffer[];
export interface WriteBehindOptions<T> {
  path: string;
  encode: (value: T) => Encoded;
  /** 0: as soon as the reply is out. More: at most one write per window (the inbox). */
  delayMs?: number;
  /** The wait before retry `attempt` (1-based) after a failure. */
  retryMs?: (attempt: number) => number;
  /** Called once a value has landed in the file. */
  onWritten?: (value: T) => void;
  health?: WriteHealth;
  log?: (line: string) => void;
}
/** Failed attempts that make a failure the developer's business (until then it's logged only). */
export const SURFACE_AFTER = 3;
export const retryBackoff = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 30_000);

export class WriteBehind<T> {
  private pending: { value: T } | null = null;
  private inflight: { value: T } | null = null;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private written: { value: T } | null = null;
  /** Consecutive failed attempts; 0 once a write lands. */
  attempts = 0;
  writes = 0;
  lastError: string | null = null;
  /** Where a failure that keeps failing is reported; the worker sets its own. */
  health: WriteHealth | undefined;
  constructor(private o: WriteBehindOptions<T>) { this.health = o.health; }

  /** Saves `value` behind the caller: it returns at once. A newer set() before the write starts replaces it. */
  set(value: T): void {
    if (this.inflight?.value === value && !this.pending) return;
    if (this.written?.value === value && !this.pending && !this.inflight) return;
    this.pending = { value };
    this.arm(this.attempts ? this.retryDelay() : this.o.delayMs ?? 0);
  }
  /** Writes what is pending now and waits for it (and any write in flight). Throws when the write fails. */
  async flush(): Promise<void> {
    this.disarm();
    while (this.writing) await this.writing.catch(() => undefined);
    if (this.pending) await this.start();
  }
  /** Whether a value waits for its write to start (a newer set() would replace it at no cost). */
  get queued(): boolean { return !!this.pending; }
  /** Whether a value hasn't landed yet. */
  get dirty(): boolean { return !!(this.pending || this.inflight); }

  private retryDelay(): number { return (this.o.retryMs ?? retryBackoff)(this.attempts); }
  private arm(ms: number): void {
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => { this.timer = null; void this.start().catch(() => undefined); }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }
  private disarm(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private start(): Promise<void> {
    if (this.writing) return this.writing;
    const job = this.pending;
    if (!job) return Promise.resolve();
    this.pending = null; this.inflight = job;
    const run = this.writeOnce(job).finally(() => {
      this.inflight = null; this.writing = null;
      if (this.pending) this.arm(this.attempts ? this.retryDelay() : this.o.delayMs ?? 0);
    });
    this.writing = run;
    return run;
  }
  private async writeOnce(job: { value: T }): Promise<void> {
    try {
      await writeAtomic(this.o.path, this.o.encode(job.value));
    } catch (error) {
      this.attempts++;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pending ??= job; // a newer value supersedes it; otherwise it's retried
      (this.o.log ?? console.warn)(`[follow-up] couldn't save ${basename(this.o.path)} (attempt ${this.attempts}): ${this.lastError}; kept in memory, retrying`);
      if (this.attempts >= SURFACE_AFTER) this.health?.fail(this.o.path, this.attempts, this.lastError);
      throw error;
    }
    if (this.attempts) (this.o.log ?? console.warn)(`[follow-up] saved ${basename(this.o.path)} after ${this.attempts} failed attempt${this.attempts === 1 ? "" : "s"}`);
    this.attempts = 0; this.lastError = null; this.writes++; this.written = job;
    this.health?.clear(this.o.path);
    this.o.onWritten?.(job.value);
  }
}

/** Files whose saving keeps failing, for the worker's error line (loadError ?? hookError ?? saveError ?? engine.error). */
export class WriteHealth {
  private failing = new Map<string, { attempts: number; error: string }>();
  fail(path: string, attempts: number, error: string): void { this.failing.set(path, { attempts, error }); }
  clear(path: string): void { this.failing.delete(path); }
  /** One line for the first failing file, or null when every save has landed. */
  message(): string | null {
    const first = [...this.failing][0];
    if (!first) return null;
    const [path, { attempts, error }] = first;
    return `Follow-up couldn't save ${basename(path)} (${attempts} attempts: ${error}). Your change is kept and saving keeps retrying; check the disk and Follow-up's data folder.`;
  }
}

/** Temp file, fsync, rename: the file holds the old value or the new one, never part of one. Owner-only. */
export async function writeAtomic(path: string, data: Encoded): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${basename(path, ".json")}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (typeof data === "string") await file.writeFile(data); else await writeParts(file, data);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Writes every part, however the OS splits a vectored write. */
export async function writeParts(file: FileHandle, parts: Buffer[]): Promise<void> {
  let rest = parts;
  while (rest.length) {
    const { bytesWritten } = await file.writev(rest.length > 512 ? rest.slice(0, 512) : rest);
    let n = bytesWritten, i = 0;
    while (i < rest.length && n >= rest[i]!.length) n -= rest[i++]!.length;
    rest = rest.slice(i);
    if (n > 0) rest = [rest[0]!.subarray(n), ...rest.slice(1)];
    if (bytesWritten === 0 && rest.length) throw new Error(`${file.fd}: the write made no progress`);
  }
}
