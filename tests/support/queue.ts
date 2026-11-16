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
