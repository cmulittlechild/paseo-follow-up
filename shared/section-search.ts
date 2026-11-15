import type { Obligation, Pr } from "./model";
import type { Activity } from "./activity";
import type { RepairRow } from "./task-rows";
import { shortTitle } from "./task-rows";
import { answerLabel, answerStatus, type Question } from "./questions";
import type { ItemField } from "./search";

/**
 * What each workspace panel section searches (section search, shared/search.ts `filterItems`). Shown fields are the
 * row's own text; hidden ones come back as line 2 ("Evidence · …") when only they matched.
 */
export type SectionId = "prs" | "tasks" | "activity";
export const SECTION_PLACEHOLDER: Record<SectionId, string> = { prs: "Search pull requests", tasks: "Search tasks", activity: "Search activity" };
/** The empty result: "No tasks match ‘x’". */
export function noMatchLine(section: SectionId, query: string): string {
  const q = query.trim();
  return section === "prs" ? `No pull requests match ‘${q}’` : section === "tasks" ? `No tasks match ‘${q}’` : `No activity matches ‘${q}’`;
}
/** "2 of 12": matches over every item in the section, folded ones included. */
export const matchCount = (n: number, of: number) => `${n} of ${of}`;

/** Pull requests: number and title (shown), the branch and failed check names (hidden). */
export function prFields(pr: Pr): ItemField[] {
  const s = pr.snapshot;
  const branch = s?.headBranch || pr.stack;
  return [
    { label: "Title", text: s?.title ?? pr.stack, shown: true },
    { label: "PR", text: `#${pr.number}`, shown: true },
    ...(branch ? [{ label: "Branch", text: branch, shown: false }] : []),
    ...[...new Set([...(s?.failedChecks ?? []), ...(s?.otherFailedChecks ?? [])])].map(text => ({ label: "Check", text, shown: false })),
  ];
}

/** A task: its title (shown) and its evidence (hidden). */
export function taskFields(o: Pick<Obligation, "title" | "evidence">): ItemField[] {
  return [{ label: "Title", text: o.title, shown: true }, ...(o.evidence.trim() ? [{ label: "Evidence", text: o.evidence, shown: false }] : [])];
}
/** A task Follow-up found on a PR: its short title and the PR chip, both on the row. */
export function repairFields(r: RepairRow): ItemField[] {
  return [{ label: "Title", text: shortTitle(r.task), shown: true }, { label: "PR", text: r.pr, shown: true }];
}

/** A timeline entry: its line and its detail, both on the row. */
export function activityFields(r: Pick<Activity, "text" | "detail">): ItemField[] {
  return [{ label: "Text", text: r.text, shown: true }, ...(r.detail ? [{ label: "Detail", text: r.detail, shown: true }] : [])];
}

/** The Questions tab's line 2: the answer, where it is on its way, or why it was withdrawn. */
export function questionStatus(q: Question): string {
  const s = answerStatus(q);
  return q.answer ? `${s && !s.delivered ? `${s.label} · ` : ""}${answerLabel(q, q.answer.choice, q.answer.words)}` : q.closed ? `Withdrawn: ${q.closed.reason}` : "Waiting for you";
}
/** A question: "Q2 · title" and its status line, both on the row. */
export function questionFields(q: Question): ItemField[] {
  return [{ label: "Question", text: `${q.id} · ${q.title}`, shown: true }, { label: "Status", text: questionStatus(q), shown: true }];
}

/**
 * The section's query is the panel's own view state: one per section, and it belongs to the workspace it was typed
 * in. Opening another workspace reads as closed (the query clears), with no effect to run.
 */
export type SectionQuery = { workspaceId: string; query: string } | null;
export const queryFor = (state: SectionQuery, workspaceId: string): string | null => state && state.workspaceId === workspaceId ? state.query : null;
