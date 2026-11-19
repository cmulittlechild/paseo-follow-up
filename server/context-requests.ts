import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WriteBehind } from "./write-behind";
import { CONTEXT_ANSWER_MAX, contextFileSchema, plainAnswer, pruneContext, sameCard, type ContextFile, type ContextRequest, type ContextTarget } from "../shared/catch-up";

export const CONTEXT_FILE = "context.json";

export type AskInput = { workspaceId: string | null; agentId: string | null; cardKey: string; card: string; target: ContextTarget; ask: string };

/**
 * an-ask-goes-only-to-an-agent-that-can-answer-it: who a More context ask goes to. Always the card's workspace's main
 * agent (CONTEXT_REPLY_ROLE), the only role that has context_reply, whoever is named on the card: a contributor's
 * question, or a recovery agent's, is still the workstream's, and its main agent answers. A workspace Follow-up doesn't
 * track has no main agent, so nothing there could answer on the card, and the ask is refused with a way on. A main
 * agent that was closed is still asked: the queue resumes it, or fails the ask if it is gone, and the card comes back.
 */
export function contextRecipient(workspace: { enable_tracking: boolean; mainAgentId: string } | undefined, caller: string | null): { agentId: string } | { error: string } {
  if (!workspace?.enable_tracking || !workspace.mainAgentId) return { error: "Follow-up doesn't track this card's workspace, so no agent can answer on the card. Open its chat to ask there." };
  if (caller && workspace.mainAgentId === caller) return { error: "ask_context asks another agent about its card for the developer; explain your own ask in your reply." };
  return { agentId: workspace.mainAgentId };
}

/**
 * Catch up's More context requests (docs/needs-you.md#catch-up): what the developer asked about a card, who answers
 * (the card's workspace's main agent), and the answer once `context_reply` brings it. The value lives in memory and
 * saves behind the reply (an-ack-never-waits-on-the-disk); a change calls `onChange`, which pushes Home's feed, so the
 * client learns an answer arrived without polling. Small by construction: at most CONTEXT_MAX requests, none older
 * than CONTEXT_KEEP_MS.
 */
export class ContextRequests {
  private value: ContextFile | null = null;
  readonly persist: WriteBehind<ContextFile>;
  onChange: () => void = () => undefined;
  constructor(readonly directory: string, private now: () => number = Date.now) {
    this.persist = new WriteBehind({ path: join(directory, CONTEXT_FILE), encode: v => JSON.stringify(v) });
  }
  async flush(): Promise<void> { await this.persist.flush(); }

  private async load(): Promise<ContextFile> {
    if (this.value) return this.value;
    let value: ContextFile;
    try { value = contextFileSchema.parse(JSON.parse(await readFile(join(this.directory, CONTEXT_FILE), "utf8"))); }
    catch { value = { requests: [] }; } // Lost context requests cost a re-ask, never a broken Home.
    if (this.value) return this.value;
    // 2.2.0-beta.3 could ask the Overseer, which has no context_reply: an ask of it still open never ends on its own.
    // Its answer, if any, is in the Overseer's chat (an-ask-goes-only-to-an-agent-that-can-answer-it).
    const at = new Date(this.now()).toISOString();
    const stuck = value.requests.some(r => r.target === "overseer" && r.state === "asking");
    this.value = stuck ? { requests: value.requests.map(r => r.target === "overseer" && r.state === "asking" ? { ...r, state: "chat" as const, settledAt: at } : r) } : value;
    if (stuck) this.persist.set(this.value);
    return this.value;
  }
  private save(requests: ContextRequest[]): void {
    this.value = contextFileSchema.parse({ requests: pruneContext(requests, this.now()) });
    this.persist.set(this.value);
    this.onChange();
  }

  async list(filter: { workspaceId?: string } = {}): Promise<ContextRequest[]> {
    const { requests } = await this.load();
    const live = pruneContext(requests, this.now());
    return filter.workspaceId ? live.filter(r => r.workspaceId === filter.workspaceId) : live;
  }

  /**
   * Records an ask. One open ask per card, from whichever surface (`sameCard`: Catch up's key or the question's own):
   * asking again while it's open returns that one (`fresh: false`).
   */
  async ask(input: AskInput, by: string, askedOf: string | null): Promise<{ request: ContextRequest; fresh: boolean }> {
    const { requests } = await this.load();
    const open = requests.find(r => r.state === "asking" && sameCard(r, input));
    if (open) return { request: open, fresh: false };
    const request: ContextRequest = {
      id: `ctx-${randomUUID()}`, ...input, askedOf, state: "asking", answer: null, error: null,
      askedAt: new Date(this.now()).toISOString(), settledAt: null, deliveredAt: null, by,
    };
    this.save([...requests, request]);
    return { request, fresh: true };
  }

  private async update(id: string, change: (r: ContextRequest) => ContextRequest | null): Promise<ContextRequest | null> {
    const { requests } = await this.load();
    const i = requests.findIndex(r => r.id === id);
    if (i < 0) return null;
    const next = change(requests[i]);
    if (!next || next === requests[i]) return requests[i];
    this.save(requests.map((r, j) => j === i ? next : r));
    return next;
  }

  /**
   * The asked agent's answer (context_reply). Only the agent it was asked of may answer it (ownership comes from the
   * daemon, invariant 5); an answer to a settled request replaces it, so a corrected reply wins.
   */
  async reply(id: string, caller: string, text: string): Promise<ContextRequest> {
    const r = (await this.list()).find(x => x.id === id);
    if (!r) throw new Error(`No open context request ${id}. It may have expired; the developer can ask again.`);
    if (r.askedOf !== caller) throw new Error("This context request was asked of another agent.");
    const answer = plainAnswer(text).slice(0, CONTEXT_ANSWER_MAX);
    if (!answer) throw new Error("context_reply: give text, the explanation for the developer.");
    return (await this.update(id, x => ({ ...x, state: "answered", answer, error: null, settledAt: new Date(this.now()).toISOString() })))!;
  }

  /** The send failed for good (the agent is gone): the card comes back saying so. */
  fail(id: string, error: string): Promise<ContextRequest | null> {
    return this.update(id, r => r.state !== "asking" ? r : { ...r, state: "failed", error: error.slice(0, 500), settledAt: new Date(this.now()).toISOString() });
  }

  /** The ask reached its agent (the queue sent it). Earlier deliveries win: it is the first. */
  delivered(id: string, at: string): Promise<ContextRequest | null> {
    return this.update(id, r => r.state !== "asking" || r.deliveredAt ? r : { ...r, deliveredAt: at });
  }

  /**
   * An agent's turn ended. Every ask it owes that was delivered before now and still has no context_reply settles as
   * `chat`: the answer is in its chat, and the card comes back with Open chat. Delivery, not the turn's start, is the
   * test, so a prompt steered into a turn already running counts, and nothing in memory is lost on a restart. Costs a
   * lookup in a list of at most CONTEXT_MAX; no reads.
   */
  async turnEnded(agentId: string): Promise<void> {
    const owed = (await this.list()).filter(r => r.state === "asking" && r.askedOf === agentId && r.deliveredAt && Date.parse(r.deliveredAt) <= this.now());
    for (const r of owed) await this.update(r.id, x => x.state !== "asking" ? x : { ...x, state: "chat", settledAt: new Date(this.now()).toISOString() });
  }

  /**
   * After a restart: anything still asking is re-derived from what the worker can read without waking anyone. `sent`
   * says when the queue delivered it (null: not yet, or not a queued ask); `idle` says the agent isn't in a turn now.
   * Delivered to an agent that is idle means its turn ended while the worker was down, so it settles as `chat`; a send
   * that failed for good fails the ask.
   */
  async reconcile(look: (r: ContextRequest) => { sent: string | null; failed: string | null; idle: boolean }): Promise<void> {
    for (const r of (await this.list()).filter(x => x.state === "asking" && x.askedOf)) {
      const seen = look(r);
      if (seen.failed) { await this.fail(r.id, seen.failed); continue; }
      const at = r.deliveredAt ?? seen.sent;
      if (at && !r.deliveredAt) await this.delivered(r.id, at);
      if (at && seen.idle) await this.turnEnded(r.askedOf!);
    }
  }
}
