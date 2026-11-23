import type { ListObligation as Obligation, ListWorkspace as Workspace } from "./list";
import { followUpObligations } from "./follow-up";
import { blockedOnDeveloper } from "./model";
import { ANSWERED_TASK, blockedLine, finishedTask, IN_NEEDS_YOU, linkedQuestion, taskStatus, type TaskAgents, type TaskStatus } from "./task-status";
import { isStale, taskDue } from "./task-due";
import { taskSchedule } from "./task-trigger";

// ---------- the developer's view of the agent's tasks (invariant tasks-are-the-agent-s) ----------
//
// Tasks are the agent's to-do list, not the developer's. The developer needs three things from it: how many are open,
// whether the agent is keeping up (a stale task: due, nudged twice, no answer), and what moves each one. So the card is
// one collapsed line by default ("5 open · 1 due · 1 stale"), due stays neutral (it's the agent's normal work), and only
// stale is amber. Expanded, a row says what moves it in a few words. The send queue, repairs, finished tasks and the
// schedule editor live elsewhere (the Next message card, Activity, the task's own detail).

/** What moves an open task, in the order the card lists them: what needs a look first, what's elsewhere last. */
export type TaskKind = "stale" | "due" | "working" | "blocked" | "after-pr" | "recheck" | "scheduled" | "open" | "needs-you";
const ORDER: readonly TaskKind[] = ["stale", "due", "working", "blocked", "after-pr", "recheck", "scheduled", "open", "needs-you"];

export type TaskViewRow = {
  o: Obligation;
  kind: TaskKind;
  /** The row's one line: what moves it ("Due · #231 merged", "After #232 merges", "Re-check Nov 25", "In Needs you"). */
  meta: string;
  /** The shared status (agent link, delivery tone), for the working and delivery cases. */
  status: TaskStatus;
  /** The agent's own note, shown under a stale or due row: what it will do when it gets to it. */
  note: string | null;
  /** When it is or was due, for ordering within a kind. */
  at: number;
};

/** A blocked line short enough for one row; the whole reason is in the row's detail. */
export const BLOCKED_ROW_MAX = 44;
const cut = (s: string, max: number) => s.length <= max ? s : `${s.slice(0, max).replace(/[\s,;:·]+\S*$/, "")}…`;


export function taskViewRow(o: Obligation, w: Workspace, agents: TaskAgents = w.taskAgents ?? {}, now = Date.now()): TaskViewRow {
  const status = taskStatus(o, w, agents, now);
  const d = taskDue(o, w, now);
  const at = d?.dueAt ? Date.parse(d.dueAt) : Number.POSITIVE_INFINITY;
  const note = (o.evidence ?? "").trim() || null;
  const row = (kind: TaskKind, meta: string, withNote = false): TaskViewRow => ({ o, kind, meta, status, note: withNote ? note : null, at });
  const q = linkedQuestion(o, w);
  // Still the developer's move: Needs you holds it, and the row only points there.
  if (q && !q.answer && !q.closed) return row("needs-you", IN_NEEDS_YOU);
  if (blockedOnDeveloper(o) && !q) return row("needs-you", IN_NEEDS_YOU);
  if (q?.answer && !d) return row("blocked", ANSWERED_TASK);
  if (d?.due) return isStale(o, d) ? row("stale", `Stale · ${d.fact} · nudged twice, no answer`, true) : row("due", d.label, true);
  if (o.status === "working") return row("working", status.text);
  if (o.status === "blocked") return row("blocked", cut(blockedLine(o, w), BLOCKED_ROW_MAX));
  if (status.tone === "queued" || status.tone === "sent" || status.tone === "ready") return row("scheduled", status.text);
  if (o.enable_follow_up && o.trigger) return row("scheduled", taskSchedule(o, w, now).label);
  if (o.afterPrs.length) return row("after-pr", status.text);
  if (o.recheckAt) return row("recheck", status.text);
  return row("open", status.text);
}

/** The open tasks the developer sees, in the card's order: stale and due first (oldest first), Needs you's last. */
export function taskViewRows(w: Workspace, agents: TaskAgents = w.taskAgents ?? {}, now = Date.now()): TaskViewRow[] {
  return followUpObligations(w).filter(o => !finishedTask(o)).map(o => taskViewRow(o, w, agents, now))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.at - b.at);
}

const WEEK = 7 * 86_400_000;

export type TaskSummary = { open: number; due: number; stale: number; finished: number; finishedThisWeek: number };

export function taskSummary(w: Workspace, now = Date.now(), rows = taskViewRows(w, undefined, now)): TaskSummary {
  const finished = followUpObligations(w).filter(finishedTask);
  return {
    open: rows.length,
    due: rows.filter(r => r.kind === "due").length,
    stale: rows.filter(r => r.kind === "stale").length,
    finished: finished.length,
    finishedThisWeek: finished.filter(o => o.finishedAt && now - Date.parse(o.finishedAt) <= WEEK).length,
  };
}

/** The collapsed line's parts: neutral counts, and the stale count apart so it alone can be amber. */
export function summaryParts(s: TaskSummary): { neutral: string; stale: string | null } {
  const parts = [`${s.open} open`, ...(s.due ? [`${s.due} due`] : [])];
  return { neutral: parts.join(" · "), stale: s.stale ? `${s.stale} stale` : null };
}

/** The footer: where finished tasks went. Null when none finished. */
export function finishedLine(s: TaskSummary): string | null {
  if (!s.finished) return null;
  return s.finishedThisWeek ? `${s.finishedThisWeek} finished this week · in Activity` : `${s.finished} finished · in Activity`;
}
