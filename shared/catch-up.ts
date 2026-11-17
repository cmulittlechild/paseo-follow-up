// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md).
// Pure: the deck's cards and their order come from Home's model, the inbox rows and the workspaces already on the
// client, so opening Catch up costs no read of its own.
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
    if (brief && !pointsAtQuestion && ["decision", "action", "review"].includes(brief.kind ?? "")) out.push({ key: `${s.key}|brief`, kind: "brief", s });
    if (out.length === before) out.push({ key: `${s.key}|finished`, kind: "finished", s });
  }
  return out;
}

/**
 * The session's order: the deck as it was when Catch up opened, new cards appended at the end (never jumping the
 * queue under the developer's thumb), skipped cards moved behind everything still to do.
 */
export function reconcile(order: readonly string[], live: readonly DeckCard[]): string[] {
  const known = new Set(order);
  return [...order, ...live.map(c => c.key).filter(k => !known.has(k))];
}

export type Outcome = "done" | "skipped" | "later" | "asked" | "gone";
export type SessionStats = { done: number; skipped: number; later: number; asked: number; gone: number };
export const statsOf = (outcomes: ReadonlyMap<string, Outcome>): SessionStats => {
  const s: SessionStats = { done: 0, skipped: 0, later: 0, asked: 0, gone: 0 };
  for (const o of outcomes.values()) s[o === "done" ? "done" : o]++;
  return s;
};

/** The keys, one place, so the help line and the handler agree. Option letters pick; these never collide with A–H. */
export const CATCH_UP_KEYS = [
  { key: "A–H", what: "Pick an option" },
  { key: "⌘↵", what: "Send" },
  { key: "J / →", what: "Skip" },
  { key: "K / ←", what: "Back" },
  { key: "M", what: "More context" },
  { key: "N", what: "Add a note" },
  { key: "L", what: "Later" },
  { key: "O", what: "Open chat" },
  { key: "Esc", what: "Leave" },
] as const;

/**
 * The mode's name in every place it shows, so renaming it is one edit (the name is still Tom's pick; the design doc
 * lists the options). Code identifiers stay `catch-up` until the name is chosen.
 */
export const MODE = {
  name: "Go through",
  button: (n: number) => `Go through ${n}`,
  command: "Follow-up: Go through what needs you",
  progress: (at: number, of: number) => `${at} of ${of}`,
  finished: "Nothing else needs you",
  empty: "Nothing needs you",
} as const;
