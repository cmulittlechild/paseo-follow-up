// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md).
// Pure: the deck's cards and their order come from Home's model, the inbox rows and the workspaces already on the
// client, so opening Catch up costs no read of its own. The session's order (skips, More context parking a
// workspace, its return) is a pure state machine here, so the client, the agent tool and the tests agree.
import { z } from "zod";
import type { HomeModel, Workstream } from "./home";
import type { InboxRow } from "./inbox";
import type { NeedItem } from "./attention";

export type CardKind = "permission" | "question" | "item" | "brief" | "finished";
/**
 * One card: one thing to act on. A workspace with two questions and a merge is three cards, kept together so its
 * context is read once. `key` is stable across refreshes, so the deck can tell a card that went away from a new one.
 */
export type DeckCard = { key: string; kind: CardKind; s: Workstream; questionId?: string; item?: NeedItem };

type Source = {
  model: Pick<HomeModel, "groups">;
  rows: readonly Pick<InboxRow, "agentId" | "needs" | "brief">[];
  /** The workspace's Needs-you items in block order (stopped questions first), from `needsYou`. */
  items: (workspaceId: string) => readonly NeedItem[];
};

const BRIEF_CARD_KINDS = ["decision", "action", "review"];

/**
 * The deck, in Home's Needs-you order: the order the developer already sees in the list (blocking asks first, then
 * decisions, then finished turns; inside a tier the chosen sort, AI priority included). Inside a workstream: a pending
 * permission, then each open question, then every other item, then the agent's own ask when nothing above speaks for it.
 */
export function deckCards({ model, rows, items }: Source): DeckCard[] {
  const needs = model.groups.find(g => g.id === "needs")?.items ?? [];
  const out: DeckCard[] = [];
  for (const s of needs) {
    const row = s.agentId ? rows.find(r => r.agentId === s.agentId) ?? null : null;
    const reasons = row?.needs?.reasons.map(r => r.reason) ?? [];
    const before = out.length;
    if (reasons.includes("permission")) out.push({ key: `${s.key}|permission`, kind: "permission", s });
    const asks = s.workspaceId ? items(s.workspaceId) : [];
    for (const item of asks) {
      if (item.kind === "question") out.push({ key: `${s.key}|${item.questionId}`, kind: "question", s, questionId: item.questionId, item });
      else out.push({ key: `${s.key}|${item.key}`, kind: "item", s, item });
    }
    const brief = row?.brief as { kind?: string; questionIds?: string[] } | null | undefined;
    const pointsAtQuestion = !!brief?.questionIds?.length && out.slice(before).some(c => c.kind === "question");
    if (brief && !pointsAtQuestion && BRIEF_CARD_KINDS.includes(brief.kind ?? "")) out.push({ key: `${s.key}|brief`, kind: "brief", s });
    if (out.length === before) out.push({ key: `${s.key}|finished`, kind: "finished", s });
  }
  return out;
}

/** The workstream a card key belongs to (`agent:<id>` or `ws:<id>`): cards of one workstream move together. */
export const groupOf = (key: string) => key.slice(0, key.indexOf("|") < 0 ? key.length : key.indexOf("|"));

/** What happened to a card this session. `gone`: it left Needs you elsewhere (answered on another device, the agent moved on). */
export type Outcome = "done" | "skipped" | "later" | "gone";
export type SessionStats = { done: number; skipped: number; later: number; gone: number; waiting: number };

/**
 * A Catch up session. `order` is every card key seen this session (done ones stay, so Back works); `pos` is the card
 * on screen, `order.length` once nothing is left. `parked` maps a workstream waiting for More context to its request.
 */
export type Session = { order: string[]; pos: number; outcomes: Record<string, Outcome>; parked: Record<string, string>; lapped?: boolean };

export const startSession = (cards: readonly Pick<DeckCard, "key">[]): Session => ({ order: cards.map(c => c.key), pos: 0, outcomes: {}, parked: {} });

/** Still to act on: not done, later or gone. Skipped cards stay open; they come round again after the rest. */
const open = (s: Session, key: string) => { const o = s.outcomes[key]; return !o || o === "skipped"; };
/** A card forward moves may land on: open, and not in a workstream waiting for context. */
const landable = (s: Session, key: string) => open(s, key) && !s.parked[groupOf(key)];

/**
 * The next card after `from`: the next landable one in order, else the first skipped one from the start (one second
 * pass, `lapped`), else `order.length` (finished). On the second pass a skip moves forward only, so skipping everything
 * ends at the finished screen with "Catch up on N skipped" instead of going round for ever.
 */
export function advance(s: Session, from: number): Pick<Session, "pos" | "lapped"> {
  for (let i = from + 1; i < s.order.length; i++) if (landable(s, s.order[i]) && (s.lapped || s.outcomes[s.order[i]] !== "skipped")) return { pos: i, lapped: s.lapped };
  if (!s.lapped) for (let i = 0; i < s.order.length; i++) if (i !== from && landable(s, s.order[i])) return { pos: i, lapped: true };
  return { pos: s.order.length, lapped: s.lapped };
}
export const nextPos = (s: Session, from: number): number => advance(s, from).pos;

/** Back: the card before, whatever happened to it (done cards show what was sent; a parked one shows it is asking). */
export const prevPos = (s: Session): number => Math.max(0, Math.min(s.pos, s.order.length) - 1);

/** Records what happened to the card on screen and moves on. */
export function settle(s: Session, outcome: Outcome, key = s.order[s.pos]): Session {
  if (key === undefined) return s;
  const next = { ...s, outcomes: { ...s.outcomes, [key]: outcome } };
  return s.order[s.pos] === key ? { ...next, ...advance(next, s.pos) } : next;
}

/**
 * More context was asked about the card on screen: its workstream waits (every card of it, so its context is read
 * once when it returns) and the deck moves on to the next workstream at once. Tom, 2026-11-17: "Getting more context
 * may take a bit, so make it skip to the next workspace".
 */
export function park(s: Session, requestId: string, key = s.order[s.pos]): Session {
  if (key === undefined) return s;
  const next = { ...s, parked: { ...s.parked, [groupOf(key)]: requestId } };
  return s.order[s.pos] !== undefined && groupOf(s.order[s.pos]) === groupOf(key) ? { ...next, ...advance(next, s.pos) } : next;
}

/**
 * The live deck changed: cards that left Needs you are `gone`, new ones join at the end (never jumping the queue under
 * the developer's thumb), and a parked workstream whose request settled comes back as the very next card: its open
 * cards move to right after the one on screen (or become the current one when the deck had finished). The card on
 * screen never changes under the developer, except to `gone`.
 */
export function sync(s: Session, live: readonly Pick<DeckCard, "key">[], settled: (requestId: string) => boolean): Session {
  const liveKeys = new Set(live.map(c => c.key));
  const known = new Set(s.order);
  let order = [...s.order, ...live.map(c => c.key).filter(k => !known.has(k))];
  const outcomes = { ...s.outcomes };
  for (const k of order) if (!liveKeys.has(k) && open({ ...s, outcomes }, k)) outcomes[k] = "gone";
  let pos = s.pos;
  const parked = { ...s.parked };
  for (const [group, requestId] of Object.entries(s.parked)) {
    if (!settled(requestId)) continue;
    delete parked[group];
    const current = order[pos];
    const back = order.filter(k => groupOf(k) === group && k !== current && open({ ...s, outcomes }, k));
    if (!back.length) continue;
    const rest = order.filter(k => !back.includes(k));
    const at = current === undefined ? rest.length : rest.indexOf(current) + 1;
    order = [...rest.slice(0, at), ...back, ...rest.slice(at)];
    pos = current === undefined ? at : order.indexOf(current);
  }
  return { order, pos, outcomes, parked };
}

/** The progress line's numbers: the card on screen out of every card this session, and what is waiting for context. */
export function statsOf(s: Session): SessionStats {
  const out: SessionStats = { done: 0, skipped: 0, later: 0, gone: 0, waiting: 0 };
  for (const o of Object.values(s.outcomes)) out[o]++;
  out.waiting = s.order.filter(k => s.parked[groupOf(k)] && open(s, k)).length;
  return out;
}

/** The keys, one place, so the help line, the tooltips and the handler agree. Option letters pick; these never collide with A–H. */
/**
 * Catch up's keys (desktop web): one list that the handler (`catchUpKey`), the S sheet and the hint line read, so
 * they never disagree. `combos` spell each key the way Paseo's bundle does (PASEO_BOUND, shared/search-key.ts):
 * tests/catch-up-keys.test.ts fails if one is a combo Paseo binds, Home's search key, or one of the search-from-
 * anywhere presets. Paseo takes Shift+? (its shortcuts dialog) and Escape (interrupt agent) when focus is outside a
 * field, which is exactly when these fire, so the sheet is S and leaving is X.
 */
export type CatchUpAction = "pick" | "own" | "send" | "skip" | "back" | "more" | "chip" | "ask-overseer" | "ask-agent" | "note" | "later" | "chat" | "rail" | "rail-up" | "rail-down" | "keys" | "leave";
/** A key as this platform spells it: ⌘ on a Mac, Ctrl elsewhere (as the Send button's own hint reads). */
export const keyLabel = (key: string, mac: boolean) => mac ? key : key.replace("⌘", "Ctrl ");

export const CATCH_UP_KEYS: readonly { key: string; what: string; action: CatchUpAction; combos: readonly string[]; when?: "more" | "rail" }[] = [
  { key: "A–H", what: "Pick an option", action: "pick", combos: ["A", "B", "C", "D", "E", "F", "G", "H"] },
  { key: "W", what: "Write your own answer", action: "own", combos: ["W"] },
  { key: "⌘↵", what: "Send", action: "send", combos: ["Cmd+Enter", "Ctrl+Enter"] },
  { key: "J / →", what: "Skip", action: "skip", combos: ["J", "ArrowRight"] },
  { key: "K / ←", what: "Back", action: "back", combos: ["K", "ArrowLeft"] },
  { key: "M", what: "More context", action: "more", combos: ["M"] },
  { key: "1–4", what: "Pick a More context ask", action: "chip", combos: ["Digit"], when: "more" },
  { key: "⌘↵", what: "Ask the Overseer", action: "ask-overseer", combos: ["Cmd+Enter", "Ctrl+Enter"], when: "more" },
  { key: "⌘⇧↵", what: "Ask the agent", action: "ask-agent", combos: ["Cmd+Shift+Enter", "Ctrl+Shift+Enter"], when: "more" },
  { key: "N", what: "Add a note", action: "note", combos: ["N"] },
  { key: "L", what: "Later", action: "later", combos: ["L"] },
  { key: "O", what: "Open chat", action: "chat", combos: ["O"] },
  { key: "R", what: "Go to the queue, and back", action: "rail", combos: ["R"] },
  { key: "↑ / ↓", what: "Move in the queue (Enter opens)", action: "rail-up", combos: ["ArrowUp", "ArrowDown"], when: "rail" },
  { key: "S", what: "Show the keys", action: "keys", combos: ["S"] },
  { key: "X", what: "Leave Catch up", action: "leave", combos: ["X"] },
];

export type KeyPress = { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; composing?: boolean; mac: boolean };
/**
 * What a key press does in Catch up, or null to leave it alone (Paseo's, the field's, the browser's). Pure, so the
 * map is tested without a DOM. `typing`: focus is in a text field, where only the More context box's ⌘↵ and ⌘⇧↵ act
 * (a card field's ⌘↵ is its own SubmitScope's). `inRail`: focus is in the queue.
 */
export function catchUpKey(e: KeyPress, at: { typing: boolean; inMore: boolean; moreOpen: boolean; inRail: boolean }): { action: CatchUpAction; arg?: string } | null {
  if (e.composing || e.alt) return null;
  const mod = e.mac ? e.meta : e.ctrl;
  if (e.key === "Enter" && mod && (e.mac ? !e.ctrl : !e.meta)) {
    if (e.shift) return at.moreOpen && (!at.typing || at.inMore) ? { action: "ask-agent" } : null;
    if (at.moreOpen && (!at.typing || at.inMore)) return { action: "ask-overseer" };
    return at.typing ? null : { action: "send" };
  }
  if (at.typing || e.meta || e.ctrl) return null;
  if (at.inRail && (e.key === "ArrowUp" || e.key === "ArrowDown")) return { action: e.key === "ArrowUp" ? "rail-up" : "rail-down" };
  if (e.key === "ArrowRight") return { action: "skip" };
  if (e.key === "ArrowLeft") return { action: "back" };
  if (at.moreOpen && /^[1-4]$/.test(e.key)) return { action: "chip", arg: e.key };
  if (e.shift || e.key.length !== 1) return null;
  const k = e.key.toLowerCase();
  if (/^[a-h]$/.test(k)) return { action: "pick", arg: k.toUpperCase() };
  const byLetter: Record<string, CatchUpAction> = { w: "own", j: "skip", k: "back", m: "more", n: "note", l: "later", o: "chat", r: "rail", s: "keys", x: "leave" };
  return byLetter[k] ? { action: byLetter[k] } : null;
}

/**
 * The mode's name in every place it shows, so renaming it is one edit. Tom picked Catch up (2026-11-17: "people know
 * the name"); code identifiers say `catch-up` too. The Home button counts cards, not workspaces, and says so.
 */
export const MODE = {
  name: "Catch up",
  button: (n: number) => `Catch up · ${n}`,
  /** The button's accessible name and tooltip: the number is cards, which can differ from Needs you's workspaces. */
  buttonLabel: (n: number) => `Catch up on ${n} ${n === 1 ? "thing" : "things"} that need you, one at a time`,
  command: "Follow-up: Catch up on what needs you",
  progress: (at: number, of: number) => `Catch up ${at} of ${of}`,
  waiting: (n: number) => `${n} getting context`,
  finished: "All caught up",
  /** The end of a deck with cards still skipped or waiting: not caught up, so it does not say so. */
  endOfDeck: "End of the deck",
  empty: "Nothing needs you",
} as const;

// More context ------------------------------------------------------------------------------------------------------

/** Who answers: the Overseer from what it already knows (wakes no one), or the card's own agent (Tom asked, so it may wake). */
export const CONTEXT_TARGETS = ["overseer", "agent"] as const;
export type ContextTarget = typeof CONTEXT_TARGETS[number];
/** asking → answered (the reply came with context_reply), chat (the agent ended its turn without it: read its chat), failed. */
export const CONTEXT_STATES = ["asking", "answered", "chat", "failed"] as const;
export type ContextState = typeof CONTEXT_STATES[number];

/**
 * The suggestions, first one first. Tom, 2026-11-17: "most of the time, the question is just not understood and needs
 * a simple explaining and more context", so "I don't get it" leads.
 */
export const CONTEXT_ASKS = [
  { id: "explain", label: "I don't get it", text: "I don't get it. Explain this in plain words: what is being asked, why, and what each choice would mean. Add the context I need to decide." },
  { id: "why", label: "Why does it matter?", text: "Why does this matter, and what happens if it waits?" },
  { id: "tried", label: "What did it try?", text: "What has been tried so far, and what happened?" },
  { id: "recommend", label: "What if I take the recommendation?", text: "What happens if I take the recommendation?" },
] as const;

export const CONTEXT_ANSWER_MAX = 4000;
const iso = z.string().max(40);
export const contextRequestSchema = z.object({
  id: z.string().min(1).max(80),
  workspaceId: z.string().nullable(),
  /** The card's agent (the one that asked); the request's own recipient is `askedOf`. */
  agentId: z.string().nullable(),
  cardKey: z.string().min(1).max(400),
  /** One line naming what the card asks ("Q12: Which retry policy?"), for the prompt and the agent tool. */
  card: z.string().max(300),
  target: z.enum(CONTEXT_TARGETS),
  /** The developer's words, or a suggestion's text. */
  ask: z.string().min(1).max(2000),
  /** The agent that should reply (the card's agent, or the Overseer once it is known). */
  askedOf: z.string().nullable(),
  state: z.enum(CONTEXT_STATES),
  answer: z.string().max(CONTEXT_ANSWER_MAX).nullable(),
  error: z.string().max(500).nullable(),
  askedAt: iso,
  settledAt: iso.nullable(),
  /**
   * When the ask actually reached `askedOf` (the queue sent it, or the Overseer took it). The first turn end after this
   * without a context_reply settles it as `chat`, so a prompt steered into a running turn counts too. Absent in files
   * from before it existed.
   */
  deliveredAt: iso.nullable().default(null),
  /** Who asked: "developer" or "agent:<id>" (agent parity). */
  by: z.string().max(120),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export const contextFileSchema = z.object({ requests: z.array(contextRequestSchema) });
export type ContextFile = z.infer<typeof contextFileSchema>;

/** Settled requests are kept this long (the card shows the answer when it returns), and at most this many. */
export const CONTEXT_KEEP_MS = 24 * 3_600_000;
export const CONTEXT_MAX = 50;
export const contextSettled = (r: Pick<ContextRequest, "state">) => r.state !== "asking";

/** The tool an asked agent replies with (native tools carry the follow_ prefix; the stdio bridge doesn't). */
const REPLY_TOOL = "context_reply";

/** The message the card's agent gets. It asks for an explanation, not action, and never counts as the developer's answer. */
export function agentContextPrompt(r: Pick<ContextRequest, "id" | "card" | "ask">): string {
  return [
    `The developer is catching up on what needs them and is looking at your ask: ${r.card}`,
    `They want more context before they answer: "${r.ask}"`,
    `Explain in plain words, short (under ${CONTEXT_ANSWER_MAX} characters), with what they need to decide. This isn't their answer: don't act on the ask yet, and keep it open.`,
    `Reply with ${REPLY_TOOL} (follow_${REPLY_TOOL} as a native tool) and requestId "${r.id}" so the answer shows on their card, then end your turn.`,
  ].join("\n");
}

/** The Overseer's version: it answers from what it can read without waking anyone, and doesn't forward the ask. */
export function overseerContextPrompt(r: Pick<ContextRequest, "id" | "card" | "ask">, workspace: string): string {
  return [
    `The developer is catching up on what needs them and is looking at a card from ${workspace}: ${r.card}`,
    `They want more context before they answer: "${r.ask}"`,
    `Answer from what you can read (workstreams, agent_digest) without waking agents and without forwarding this to the agent. Plain words, short (under ${CONTEXT_ANSWER_MAX} characters).`,
    `Reply with ${REPLY_TOOL} and requestId "${r.id}" so the answer shows on their card.`,
  ].join("\n");
}

/** A request older than CONTEXT_KEEP_MS goes, then the oldest past CONTEXT_MAX; an asking one is kept while it is young. */
export function pruneContext(requests: readonly ContextRequest[], now: number): ContextRequest[] {
  const young = requests.filter(r => now - Date.parse(r.askedAt) < CONTEXT_KEEP_MS);
  return young.slice(Math.max(0, young.length - CONTEXT_MAX));
}

/**
 * A context answer as the card shows it: plain words. Agents often answer in Markdown, which the card would show as
 * literal ** and # marks, so emphasis, heading and quote marks go; links and line breaks stay.
 */
export function plainAnswer(text: string): string {
  return text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => a ?? b).replace(/^\s{0,3}(#{1,6}|>)\s+/gm, "").trim();
}

/** The ask as the card's header quotes it: its first sentence ("I don't get it."), not the whole prompt. */
export const askHeadline = (ask: string): string => (ask.match(/^.+?[.?!](?=\s|$)/)?.[0] ?? ask).slice(0, 120);
