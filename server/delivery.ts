import { createHash } from "node:crypto";
export class DeliveryDeferred extends Error {}

/** The provider no longer has the agent's conversation: every send fails, so Follow-up stops sending to it. */
export class ConversationGone extends Error { constructor(readonly agentId: string, reason: string) { super(reason); this.name = "ConversationGone"; } }

/**
 * Paseo 0.16 refused the messageId itself (its per-agent, per-messageId receipt): agent_request_outcome_unknown (a
 * receipt left pending by a daemon that died mid-send; every later send under that id is refused for good) or
 * agent_request_key_conflict (the id was used for other text). Nothing was sent now; whether the first one landed is
 * for the chat to say.
 */
export const idRefused = (error: unknown): boolean => /agent_request_(outcome_unknown|key_conflict)/.test(error instanceof Error ? error.message : String(error));

/** A UUID-shaped id fixed by `seed`: the same answer always goes out under the same messageId. */
export function stableMessageId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/**
 * The clock answer delivery waits on: retry delays and each attempt's deadline. Real timers in the worker (unref'd, so a
 * pending retry never holds a process open); tests pass tests/support/fake-timers.ts and fire them in order, never sleep.
 */
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
export const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** `work`, or a rejection after `ms`: a hung call never holds a record in `sending` forever. */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string, timers: Timers = realTimers): Promise<T> {
  let timer: unknown;
  const deadline = new Promise<never>((_, reject) => { timer = timers.set(() => reject(new Error(message)), ms); });
  return Promise.race([work, deadline]).finally(() => timers.clear(timer));
}
