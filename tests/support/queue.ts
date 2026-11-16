import { MessageQueue, type Courier, type Target } from "../../server/message-queue";
import { FakeTimers } from "./fake-timers";

/**
 * A MessageQueue for tests: FakeTimers drive its quiet window, retries and attempt deadlines (the queue's clock follows
 * them), and the courier records every message that reached an agent. `quiet: 0` makes a send go out on `idle()`.
 */
export type Delivery = { target: Target; text: string; messageId: string; by?: string; to: string };
export async function testQueue(directory: string, o: { deliver?: Courier["deliverTo"]; arrived?: Courier["arrived"]; probe?: Courier["probe"]; quiet?: number; cap?: number; start?: number } = {}) {
  const timers = new FakeTimers();
  const start = o.start ?? Date.parse("2026-11-16T09:00:00.000Z");
  const delivered: Delivery[] = [];
  const courier: Courier = {
    deliverTo: async (target, text, messageId, by) => {
      const to = o.deliver ? await o.deliver(target, text, messageId, by) : target.recipients[0]!;
      delivered.push({ target, text, messageId, by, to });
      return to;
    },
    arrived: o.arrived ?? (async (_agentId, messageId) => delivered.some(d => d.messageId === messageId)),
    ...(o.probe ? { probe: o.probe } : {}),
  };
  const queue = new MessageQueue(directory, courier, { writeMs: 0 });
  queue.timers = timers;
  queue.now = () => start + timers.now;
  queue.quietMs = o.quiet ?? 0;
  queue.capMs = o.cap ?? (o.quiet ?? 0);
  await queue.load();
  return { queue, timers, delivered, courier };
}

/** Attaches a test queue to an Inbox and returns the texts that reached agents (in order), plus their messageIds. */
export async function attachSent(inbox: { attachQueue(q: MessageQueue): void }, directory: string): Promise<string[] & { ids: string[]; queue: MessageQueue }> {
  const sent = [] as unknown as string[] & { ids: string[]; queue: MessageQueue };
  sent.ids = [];
  const { queue } = await testQueue(directory, { deliver: async (target, text, messageId) => { sent.push(text); sent.ids.push(messageId); return target.recipients[0]!; } });
  inbox.attachQueue(queue);
  sent.queue = queue;
  return sent;
}

/** Stops an Inbox's attached queue and lands its writes and the inbox's, so a test can remove its directory. */
export async function quiesce(inbox: { stop(): void; store: { flush?: () => Promise<void> } }): Promise<void> {
  const queue = (inbox as unknown as { queue: MessageQueue | null }).queue;
  inbox.stop(); queue?.stop();
  await queue?.writer.flush().catch(() => undefined);
  await inbox.store.flush?.().catch(() => undefined);
}

/**
 * An Engine on a test queue (server/message-queue.ts): repairs, recovery and answers go through it, and tick(),
 * sendPending() and startRecovery() wait until the queue has settled what is due, so a test reads the outcome
 * right after, as it did before the queue. Repairs reach `gateway.send` (by the batch's messageId), answers
 * `deliver` when given.
 */
export async function queueEngine<E extends { attachQueue(q: MessageQueue): void; tick(...a: any[]): Promise<void>; sendPending(...a: any[]): Promise<any>; startRecovery(...a: any[]): Promise<any>; recover(): Promise<void>; store: { snapshot(): Promise<any>; flush?(): Promise<void> } }>(
  engine: E, gateway: { send(w: any, b: any, text: string): Promise<void>; arrived?(w: any, b: any): Promise<boolean | null> }, directory: string,
  o: { deliver?: Courier["deliverTo"]; arrived?: Courier["arrived"] } = {},
) {
  const find = async (messageId: string) => {
    for (const w of (await engine.store.snapshot()).workspaces) for (const b of w.batches) if (b.messageId === messageId) return { w, b };
    return null;
  };
  const q = await testQueue(directory, {
    deliver: async (target, text, messageId, by) => {
      const hit = await find(messageId);
      if (hit) { await gateway.send(hit.w, { ...hit.b, recipientAgentId: hit.b.recipientAgentId ?? target.recipients[0] }, text); return target.recipients[0]!; }
      return o.deliver ? o.deliver(target, text, messageId, by) : target.recipients[0]!;
    },
    arrived: o.arrived ?? (async (_agent, messageId) => { const hit = await find(messageId); return hit && gateway.arrived ? gateway.arrived(hit.w, hit.b) : null; }),
  });
  engine.attachQueue(q.queue);
  // As at worker start: batches already on their way join the queue, and what is due goes now.
  await (engine as unknown as { adoptBatches?(): Promise<void> }).adoptBatches?.();
  q.queue.start();
  for (const name of ["tick", "sendPending", "startRecovery", "recover"] as const) {
    const original = ((engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name])?.bind(engine);
    if (!original) continue;
    (engine as Record<string, unknown>)[name] = async (...a: unknown[]) => { const r = await original(...a); if (name === "recover") { await (engine as unknown as { adoptBatches?(): Promise<void> }).adoptBatches?.(); q.queue.start(); } await q.queue.idle(); await q.queue.writer.flush().catch(() => undefined); await engine.store.snapshot(); return name === "tick" || name === "recover" ? r : (await engine.store.snapshot()).workspaces.find((w: { id: string }) => w.id === a[0]) ?? r; };
  }
  return q;
}
