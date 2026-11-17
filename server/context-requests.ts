import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WriteBehind } from "./write-behind";
import { CONTEXT_ANSWER_MAX, contextFileSchema, pruneContext, type ContextFile, type ContextRequest, type ContextTarget } from "../shared/catch-up";

export const CONTEXT_FILE = "context.json";

export type AskInput = { workspaceId: string | null; agentId: string | null; cardKey: string; card: string; target: ContextTarget; ask: string };

/**
 * Catch up's More context requests (docs/needs-you.md#catch-up): what the developer asked about a card, who answers
 * (the Overseer or the card's agent), and the answer once `context_reply` brings it. The value lives in memory and
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
    this.value ??= value;
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

  /** Records an ask. One open ask per card: asking again while it's open returns that one (`fresh: false`). */
  async ask(input: AskInput, by: string, askedOf: string | null): Promise<{ request: ContextRequest; fresh: boolean }> {
    const { requests } = await this.load();
    const open = requests.find(r => r.cardKey === input.cardKey && r.state === "asking");
    if (open) return { request: open, fresh: false };
    const request: ContextRequest = {
      id: `ctx-${randomUUID()}`, ...input, askedOf, state: "asking", answer: null, error: null,
      askedAt: new Date(this.now()).toISOString(), settledAt: null, by,
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

  /** Who replies is learnt after the send (the Overseer's id). */
  setAskedOf(id: string, askedOf: string): Promise<ContextRequest | null> {
    return this.update(id, r => r.askedOf === askedOf ? r : { ...r, askedOf });
  }

  /**
   * The asked agent's answer (context_reply). Only the agent it was asked of may answer it (ownership comes from the
   * daemon, invariant 5); an answer to a settled request replaces it, so a corrected reply wins.
   */
  async reply(id: string, caller: string, text: string): Promise<ContextRequest> {
    const r = (await this.list()).find(x => x.id === id);
    if (!r) throw new Error(`No open context request ${id}. It may have expired; the developer can ask again.`);
    if (r.askedOf !== caller) throw new Error("This context request was asked of another agent.");
    const answer = text.trim().slice(0, CONTEXT_ANSWER_MAX);
    if (!answer) throw new Error("context_reply: give text, the explanation for the developer.");
    return (await this.update(id, x => ({ ...x, state: "answered", answer, error: null, settledAt: new Date(this.now()).toISOString() })))!;
  }

  /** The send failed for good (no Overseer, the agent archived): the card comes back saying so. */
  fail(id: string, error: string): Promise<ContextRequest | null> {
    return this.update(id, r => r.state !== "asking" ? r : { ...r, state: "failed", error: error.slice(0, 500), settledAt: new Date(this.now()).toISOString() });
  }

  /**
   * An asked agent's turn ended. If it started after the ask and the agent didn't reply with the tool, the answer is in
   * its chat: the card comes back with Open chat. Costs a lookup in a list of at most CONTEXT_MAX; no reads.
   */
  private started = new Map<string, number>();
  /** An agent's turn started: remembered only while that agent owes a reply. */
  turnStarted(agentId: string): void {
    if (this.value?.requests.some(r => r.state === "asking" && r.askedOf === agentId)) this.started.set(agentId, this.now());
  }
  async turnEnded(agentId: string): Promise<void> {
    const turnStartedAt = this.started.get(agentId) ?? null;
    this.started.delete(agentId);
    if (!this.value?.requests.some(r => r.state === "asking" && r.askedOf === agentId)) return;
    for (const r of this.value.requests.filter(r => r.state === "asking" && r.askedOf === agentId)) {
      if (turnStartedAt === null || turnStartedAt < Date.parse(r.askedAt)) continue;
      await this.update(r.id, x => x.state !== "asking" ? x : { ...x, state: "chat", settledAt: new Date(this.now()).toISOString() });
    }
  }
}
