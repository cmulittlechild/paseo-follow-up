import { actorBy, type Actor } from "../shared/actor";
import { allNeeds, dismissPrint, isDismissedNeed, type NeedItem } from "../shared/attention";
import type { Workspace } from "../shared/model";
import { dismissQuestion, undoDismiss } from "./questions";

/**
 * Dismiss for every Needs-you item (dismissing-anything-in-needs-you-sends-the-agent-nothing): "this no longer needs
 * me". Only this record changes. Nothing is queued or sent, so no agent spends a turn or a token on it, and nothing
 * Follow-up holds is dropped: a dismissed send's batch stays queued on its Tasks rows, a dismissed retry's batch stays
 * blocked, a paused workspace stays paused, an undelivered message keeps retrying. The item comes back when what it is
 * about changes (dismissPrint), or on Undo.
 *
 * A question closes as dismissed (server/questions.ts dismissQuestion). An agent's turn-end brief is the inbox's
 * (Inbox.dismiss). Everything else is pinned here, on `Workspace.dismissed`.
 */

/** How the toast and the tool name the item: "Q3", or what the row says. */
export function dismissName(item: Pick<NeedItem, "kind" | "title"> & { questionId?: string }): string {
  if (item.kind === "question" && item.questionId) return item.questionId;
  const title = item.title.trim();
  return `"${title.length > 70 ? `${title.slice(0, 69)}…` : title}"`;
}

/** Workspace items an agent may not dismiss for the developer: the main agent's own workspace (its asks and its work). */
function refuseOwn(w: Workspace, actor: Actor): void {
  if (actor.kind === "agent" && actor.agentId === w.mainAgentId)
    throw new Error("This is your own workspace's Needs you: what it asks is the developer's to dismiss. dismiss_item dismisses another workspace's items for the developer.");
}

export function dismissItem(w: Workspace, key: string, actor: Actor, now: number): { name: string } {
  const question = /^question:(Q\d+)$/.exec(key)?.[1];
  if (question) { dismissQuestion(w, question, actor, now); return { name: question }; }
  const item = allNeeds(w, now).find(i => i.key === key);
  // Moot, not failed: the item left Needs you by itself (merged, sent, resumed) before the click landed.
  if (!item) throw new Error(`${key} is already gone from Needs you.`);
  const print = dismissPrint(item, w);
  if (isDismissedNeed(w, key, print)) throw new Error(`${key} is already dismissed.`);
  refuseOwn(w, actor);
  // Keep only dismissals that still hold: a changed item's old print would never match again.
  const live = new Map(allNeeds(w, now).map(i => [i.key, dismissPrint(i, w)]));
  w.dismissed = [...(w.dismissed ?? []).filter(d => d.key !== key && live.get(d.key) === d.print),
    { key, print, title: item.title.slice(0, 400), at: new Date(now).toISOString(), by: actorBy(actor) }].slice(-100);
  return { name: dismissName(item) };
}

/** Undo: the item is back in Needs you as it was. */
export function undoDismissItem(w: Workspace, key: string, actor: Actor): { name: string } {
  const question = /^question:(Q\d+)$/.exec(key)?.[1];
  if (question) { undoDismiss(w, question); return { name: question }; }
  const entry = w.dismissed?.find(d => d.key === key);
  if (!entry) throw new Error(`${key} isn't dismissed, so there is nothing to undo.`);
  refuseOwn(w, actor);
  w.dismissed = w.dismissed!.filter(d => d.key !== key);
  return { name: dismissName({ kind: "hold", title: entry.title }) };
}

/** What the developer dismissed that still holds, for workspace_status: the agent learns only when it looks. */
export function dismissedNeeds(w: Workspace, now: number): NonNullable<Workspace["dismissed"]> {
  if (!w.dismissed?.length) return [];
  const all = allNeeds(w, now);
  return w.dismissed.filter(d => all.some(i => i.key === d.key && dismissPrint(i, w) === d.print));
}
