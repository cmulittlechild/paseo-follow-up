import type { Task } from "./model";

/**
 * What a queued or sent message holds, in the developer's words (Q141, invariant 16): one word per thing. A PR condition
 * Follow-up found (a conflict, review feedback, a failing check, a restack) is a "repair"; "task" is only the agent's
 * own to-do list (an obligation the message carries), so "Agent's tasks" and the Messages card never share a word.
 * The message an agent receives keeps its own wording (server/tasks.ts).
 */
export const REPAIR_KINDS: readonly Task["kind"][] = ["conflict", "review", "checks", "restack"];
export const isRepair = (t: Pick<Task, "kind">) => REPAIR_KINDS.includes(t.kind);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 repairs", "1 task", "2 repairs and 1 task". Anything else a message carries (the Done check, recovery) counts as a task. */
export function sendItems(items: readonly Pick<Task, "kind">[]): string {
  const repairs = items.filter(isRepair).length, tasks = items.length - repairs;
  return [repairs ? plural(repairs, "repair") : "", tasks ? plural(tasks, "task") : ""].filter(Boolean).join(" and ") || plural(0, "repair");
}

/** A Send button's title: "Send 2 repairs", or "Send message" when it carries both kinds (the count stays in its label). */
export const sendButton = (what: string): string => what.includes(" and ") ? "Send message" : `Send ${what}`;
