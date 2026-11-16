import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AMBIGUOUS_MS, QUEUE_ATTEMPT_MS, QUEUE_CAP_MS, QUEUE_QUIET_MS, QUEUE_RECENT, neverLeftDelay, queueFileSchema, queueItemSchema, type QueueFile, type QueueItem, type QueueItemInput, type NewQueueItem, type QueueKind } from "../shared/queue";
import { ConversationGone, DeliveryDeferred, realTimers, withDeadline, type Timers } from "./delivery";
import { WriteBehind, type WriteHealth } from "./write-behind";

/**
 * a-message-is-saved-before-sent-and-arrives-once: one durable outbox (queue.json) and one sender per workspace.
 *
 * - Every message is in queue.json before anything talks to Paseo: the send marks its items `sending` with the
 *   envelope's messageId and waits for that write (one awaited write per send; the outcome rides the next coalesced
 *   write). A reload between the two leaves `sending`, read back as `uncertain`.
 * - A send that never left (Paseo unreachable, no agent, a permission prompt, Session Guard) retries on NEVER_LEFT_MS
 *   forever, and at once on worker start and when the daemon connection comes back. It never ends in failed.
 * - A send that left unconfirmed (an error after the message went out, the attempt's deadline) is `uncertain`: before
 *   any resend the agent's chat is read for the messageId (Courier.arrived). There: sent. Not there: resent. Unknown:
 *   the next AMBIGUOUS_MS step, and failed only after the whole ladder. Paseo never refuses a resend by messageId (it
 *   only skips the timeline row; the provider runs the prompt again), so a blind resend arrives twice.
 * - The recipient is resolved when the envelope goes out (Channel.resolve), never at enqueue: an answer whose asker was
 *   archived reaches the workspace's agent, and a workspace no longer followed cancels it with a reason on the card.
 * - No polling: a timer exists only while a workspace has an item due, at the end of the quiet window (QUEUE_QUIET_MS
 *   after the newest item, at most QUEUE_CAP_MS after the first) or its retry time.
 * - Settled items leave the file once their record's mirror is written; the newest few stay for follow_queue_list.
 */
export type Target = { workspaceId: string | null; recipients: string[] };
export type Resolution = { target: Target } | { cancel: string } | { settled: "sent" | "cancelled"; reason?: string } | { defer: string };
/** One kind of message: where it goes now and how its record shows the item's state. */
export interface Channel {
  resolve(item: QueueItem): Promise<Resolution>;
  /** Writes the record's mirror of the item (Q answer delivery, brief delivery). Never throws to the queue. */
  project(item: QueueItem): Promise<void>;
}
/** How messages reach Paseo. PaseoGateway in the worker; fakes in tests. */
export interface Courier {
  /** Sends to the first available recipient and returns it. DeliveryDeferred: nothing was sent. */
  deliverTo(target: Target, text: string, messageId: string, by?: string): Promise<string>;
  /** Whether `messageId` is in the agent's chat since `since` (`marker`: the text to look for where ids aren't kept). Null: unknown. */
  arrived(agentId: string, messageId: string, since: string, marker: string): Promise<boolean | null>;
}

export const QUEUE_FILE = "queue.json";

export class MessageQueue {
  timers: Timers = realTimers;
  now: () => number = Date.now;
  quietMs = QUEUE_QUIET_MS;
  capMs = QUEUE_CAP_MS;
  attemptMs = QUEUE_ATTEMPT_MS;
  /**
   * Harness only (FOLLOW_UP_QUEUE_TIME_SCALE, e.g. 0.01): shrinks every retry wait and the attempt deadline, so a check
   * reaches Retrying and Failed in seconds. Unset (1) everywhere else.
   */
  scale = Math.min(1, Math.max(0.001, Number(process.env.FOLLOW_UP_QUEUE_TIME_SCALE) || 1));
  private items = new Map<string, QueueItem>();
  private recent: QueueItem[] = [];
  private migrations: string[] = [];
  private channels = new Map<QueueKind, Channel>();
  private lastEnqueue = new Map<string, number>();
  private armed = new Map<string, { handle: unknown; at: number }>();
  private draining = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private running = new Set<Promise<unknown>>();
  private stopped = false;
  private loaded = false;
  readonly writer: WriteBehind<QueueFile>;
  /** Sends that went out (tests and the harness count them). */
  sends = 0;
  constructor(readonly directory: string, private courier: Courier, o: { health?: WriteHealth; writeMs?: number } = {}) {
    this.writer = new WriteBehind<QueueFile>({ path: join(directory, QUEUE_FILE), encode: v => JSON.stringify(v), delayMs: o.writeMs ?? 1_000, health: o.health });
  }

  register(kind: QueueKind, channel: Channel): void { this.channels.set(kind, channel); }

  /** Reads queue.json. A send a reload interrupted is `uncertain`: its chat is read before anything is resent. */
  async load(): Promise<void> {
    let file: QueueFile = { version: 1, items: [], recent: [], migrations: [] };
    try { file = queueFileSchema.parse(JSON.parse(await readFile(join(this.directory, QUEUE_FILE), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[follow-up] queue.json unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`); }
    for (const item of file.items) {
      if (item.state === "sending") Object.assign(item, { state: "uncertain", reason: "Follow-up reloaded mid-send", nextAt: this.iso() });
      this.items.set(item.id, item);
    }
    this.recent = file.recent; this.migrations = file.migrations; this.loaded = true;
  }
  migrated(name: string): boolean { return this.migrations.includes(name); }
  /** Moves items in once (upgrade): those already here are kept. Waits for the write, so the old copy may be dropped after. */
  async adopt(name: string, inputs: QueueItemInput[]): Promise<void> {
    for (const input of inputs) { const item = queueItemSchema.parse(input); if (!this.items.has(item.id)) this.items.set(item.id, item); }
    if (!this.migrations.includes(name)) this.migrations = [...this.migrations, name];
    await this.saveNow();
  }

  /** Worker start: everything due goes now (a send the worker was down for never waits out its ladder). */
  start(): void {
    const now = this.iso();
    for (const item of this.items.values()) if (item.state === "uncertain" || item.state === "queued" && item.nextAt) item.nextAt = now;
    for (const key of this.keys()) this.drainSoon(key);
  }
  /** The daemon connection came back: sends that never left go at once. */
  reconnected(): void {
    const now = this.iso();
    for (const item of this.items.values()) if (item.state === "queued" && item.attempts > 0) item.nextAt = now;
    for (const key of this.keys()) this.arm(key);
  }

  /** Saves a new message (coalesced write) and arms its workspace's quiet window. An existing id is returned as it is. */
  enqueue(input: NewQueueItem): QueueItem {
    const existing = this.items.get(input.id);
    if (existing) return existing;
    const item = queueItemSchema.parse({ ...input, state: input.state ?? "queued", createdAt: input.createdAt ?? this.iso() });
    this.items.set(item.id, item);
    this.lastEnqueue.set(item.key, this.now());
    this.save();
    this.arm(item.key);
    return item;
  }
  get(id: string): QueueItem | null { return this.items.get(id) ?? this.recent.find(i => i.id === id) ?? null; }
  list(filter: { key?: string; agentId?: string } = {}): { items: QueueItem[]; recent: QueueItem[] } {
    const pick = (i: QueueItem) => (!filter.key || i.key === filter.key) && (!filter.agentId || i.to === filter.agentId || i.envelope?.to === filter.agentId || i.ref.agentId === filter.agentId);
    return { items: [...this.items.values()].filter(pick), recent: this.recent.filter(pick) };
  }

  /**
   * Retry (Failed) resends at once: the developer read the chat, so no arrival check. Try now (Queued, Retrying) moves
   * its time to now and keeps the check. Settled items can't be retried.
   */
  async retry(id: string): Promise<QueueItem> {
    const item = this.items.get(id);
    if (!item) throw new Error("That message is no longer queued: it was sent or cancelled.");
    if (item.state === "sending") return item;
    if (item.state === "failed") Object.assign(item, { state: "queued", envelope: null, unknowns: 0, attempts: 0, reason: null });
    item.nextAt = this.iso();
    await this.project(item); this.save();
    this.drainSoon(item.key);
    return item;
  }
  async cancel(id: string, reason: string): Promise<QueueItem> {
    const item = this.items.get(id);
    if (!item) throw new Error("That message is no longer queued: it was sent or cancelled.");
    if (item.state === "sending") throw new Error("That message is being sent right now; it can't be cancelled.");
    await this.settle(item, "cancelled", reason, null);
    return item;
  }

  /** Settles what is due now (tests, stop): a timer already due drains at once instead of waiting for its tick. */
  async idle(): Promise<void> {
    for (;;) {
      const now = this.now();
      for (const [key, { handle, at }] of [...this.armed]) if (at <= now) { this.timers.clear(handle); this.armed.delete(key); this.drainSoon(key); }
      if (!this.running.size && !this.draining.size) return;
      await Promise.allSettled([...this.running, ...this.draining.values()]);
    }
  }
  async flush(): Promise<void> { if (this.loaded) { this.writer.set(this.snapshot()); } await this.writer.flush(); }
  stop(): void { this.stopped = true; for (const { handle } of this.armed.values()) this.timers.clear(handle); this.armed.clear(); }

  // ---- the sender -------------------------------------------------------------------------------------------------

  private keys(): Set<string> { return new Set([...this.items.values()].map(i => i.key)); }
  private dueAt(item: QueueItem): number | null {
    if (item.state !== "queued" && item.state !== "uncertain") return null;
    if (item.nextAt) return Date.parse(item.nextAt);
    const last = this.lastEnqueue.get(item.key);
    const created = Date.parse(item.createdAt);
    return last === undefined ? created : Math.min(last + this.quietMs, created + this.capMs);
  }
  /** One timer per workspace, only while it has something due. */
  private arm(key: string): void {
    if (this.stopped) return;
    const times = [...this.items.values()].filter(i => i.key === key).map(i => this.dueAt(i)).filter((t): t is number => t !== null);
    const current = this.armed.get(key);
    if (!times.length) { if (current) { this.timers.clear(current.handle); this.armed.delete(key); } return; }
    const at = Math.min(...times);
    if (current && current.at === at) return;
    if (current) this.timers.clear(current.handle);
    const handle = this.timers.set(() => { this.armed.delete(key); this.drainSoon(key); }, Math.max(0, at - this.now()));
    this.armed.set(key, { handle, at });
  }
  private drainSoon(key: string): void {
    if (this.stopped) return;
    if (this.draining.has(key)) { this.again.add(key); return; }
    const run = this.drain(key)
      .catch(error => console.warn(`[follow-up] queue drain failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.draining.delete(key); if (this.again.delete(key)) this.drainSoon(key); else this.arm(key); });
    this.draining.set(key, run);
  }
  private async drain(key: string): Promise<void> {
    const now = this.now();
    const due = [...this.items.values()].filter(i => i.key === key && (this.dueAt(i) ?? Infinity) <= now);
    for (const item of due) {
      if (this.stopped) return;
      await this.one(item);
    }
  }
  /** One item: resolve its recipient now, check the chat if a send may have left, then send. */
  private async one(item: QueueItem): Promise<void> {
    const channel = this.channels.get(item.kind);
    if (!channel) return;
    let r: Resolution;
    try { r = await channel.resolve(item); }
    catch (error) { r = { defer: error instanceof Error ? error.message : String(error) }; }
    if ("settled" in r) return this.settle(item, r.settled, r.reason ?? null, item.to);
    if ("cancel" in r) return this.settle(item, "cancelled", r.cancel, null);
    if ("defer" in r) return this.neverLeft(item, r.defer);
    const { target } = r;
    if (item.state === "uncertain" && item.envelope) {
      const arrived = await this.check(item, target);
      if (arrived.found) return this.settle(item, "sent", null, arrived.found);
      if (arrived.unknown) {
        item.unknowns++;
        if (item.unknowns >= AMBIGUOUS_MS.length) { item.state = "failed"; item.nextAt = null; item.reason = "Follow-up couldn't confirm the agent got it."; }
        else item.nextAt = this.iso(AMBIGUOUS_MS[item.unknowns] * this.scale);
        await this.project(item); this.save();
        return;
      }
    }
    await this.send(item, target);
  }
  private async check(item: QueueItem, target: Target): Promise<{ found: string | null; unknown: boolean }> {
    const env = item.envelope!;
    const marker = item.text.split("\n")[0]!.slice(0, 200);
    let unknown = false;
    for (const agentId of env.to ? [env.to] : target.recipients) {
      const seen = await this.courier.arrived(agentId, env.messageId, env.at, marker).catch(() => null);
      if (seen === true) return { found: agentId, unknown: false };
      if (seen === null) unknown = true;
    }
    return { found: null, unknown };
  }
  private async send(item: QueueItem, target: Target): Promise<void> {
    const messageId = item.messageId;
    Object.assign(item, { state: "sending", envelope: { messageId, to: null, at: this.iso() }, nextAt: null });
    // Saved before Paseo hears of it: a reload from here on reads the chat before resending.
    await this.saveNow();
    await this.project(item);
    if (this.stopped) return;
    try {
      this.sends++;
      const to = await withDeadline(this.courier.deliverTo(target, item.text, messageId, item.by), this.attemptMs * this.scale, "Paseo didn't confirm the message in time", this.timers);
      // A stopped worker writes nothing: the next one owns queue.json and reads this send back as uncertain.
      if (this.stopped) return;
      if (item.envelope) item.envelope.to = to;
      await this.settle(item, "sent", null, to);
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof DeliveryDeferred) { item.envelope = null; return this.neverLeft(item, error.message); }
      if (error instanceof ConversationGone) { Object.assign(item, { state: "failed", nextAt: null, reason: "The agent's conversation is gone, so it can't take messages." }); await this.project(item); this.save(); return; }
      Object.assign(item, { state: "uncertain", reason: "Paseo didn't confirm it", nextAt: this.iso(AMBIGUOUS_MS[Math.min(item.unknowns, AMBIGUOUS_MS.length - 1)] * this.scale) });
      console.warn(`[follow-up] ${item.kind} ${item.id} not confirmed: ${error instanceof Error ? error.message : String(error)}`);
      await this.project(item); this.save();
    }
  }
  private async neverLeft(item: QueueItem, reason: string): Promise<void> {
    item.attempts++;
    Object.assign(item, { state: item.envelope ? "uncertain" : "queued", reason, nextAt: this.iso(neverLeftDelay(item.attempts) * this.scale) });
    await this.project(item); this.save();
  }
  private async settle(item: QueueItem, state: "sent" | "cancelled", reason: string | null, to: string | null): Promise<void> {
    Object.assign(item, { state, reason, to, nextAt: null, settledAt: this.iso() });
    await this.project(item);
    this.items.delete(item.id);
    this.recent = [...this.recent.filter(i => i.id !== item.id), { ...item, text: "" }].slice(-QUEUE_RECENT);
    this.save();
  }
  private async project(item: QueueItem): Promise<void> {
    await this.channels.get(item.kind)?.project(item).catch(error => console.warn(`[follow-up] couldn't update the ${item.kind} record: ${error instanceof Error ? error.message : String(error)}`));
  }
  private snapshot(): QueueFile { return { version: 1, items: [...this.items.values()].map(i => ({ ...i })), recent: this.recent, migrations: this.migrations }; }
  private save(): void { if (this.loaded) this.writer.set(this.snapshot()); }
  private async saveNow(): Promise<void> { this.writer.set(this.snapshot()); await this.writer.flush(); }
  private iso(delta = 0): string { return new Date(this.now() + delta).toISOString(); }
}
