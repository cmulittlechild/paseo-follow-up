import type { ListPr as Pr } from "./list";
import { configuredReviewers, reviewerLabel, withoutAuthor } from "./reviewers";

/**
 * a-click-on-add-reviewers-asks (2026-11-24, Tom: "make it so when I click Add Reviewers it just does that, no popup,
 * and make sure it allows me doing it for a lot of prs one after the other"): "Add reviewers to #240: Ravi" opened the
 * PR sheet, where a second Add reviewers sent the request. The row already names who it asks, so its click asks
 * exactly them, at once. The sheet and its picker open only when there is nobody to name (no saved list, or only the
 * author on it). Each row keeps its own pending and done state, so clicks on five rows in a row all land, and a row
 * the developer clicked holds its place until they leave (keep-in-place.ts). Agent tools keep dry run, then confirm.
 */

/** What one click on Add reviewers asks, known when the button draws. */
export type ReviewersScope = {
  prKey: string;
  number: number;
  /** The saved logins the click asks (the repository's list, else the default), minus the PR's author. */
  logins: string[];
  /** The same people as a person reads them (reviewerLabel), in order: the names the row shows. */
  names: string[];
  /** A screen reader's name for the button: who it asks, on which PR. */
  a11y: string;
  /** The same once asked: "Requested Ravi and Mina on pull request #240". */
  doneA11y: string;
};

const both = (names: readonly string[]) => names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The click's scope from the saved lists, or null when nobody is set for this PR (then the button opens the picker:
 * there's nothing to name). Reads the same lists as the row's title (suggestedReviewers), so the two never differ.
 */
export function reviewersScope(pr: Pick<Pr, "key" | "number" | "repo" | "snapshot">, saved = configuredReviewers(pr.repo)): ReviewersScope | null {
  const asked = withoutAuthor(saved, pr.snapshot?.reviewers?.author);
  if (!asked.length) return null;
  const names = asked.map(reviewerLabel);
  return { prKey: pr.key, number: pr.number, logins: asked.map(r => r.login), names, a11y: `Ask ${both(names)} to review pull request #${pr.number}`, doneA11y: `Requested ${both(names)} on pull request #${pr.number}` };
}

/** What came of one click: the request RPC's reply, or the error it threw. */
export type ReviewersOutcome = { state: "submitted" | "uncertain" | "failed" | "error"; result: string };

/**
 * One source for the button and the line under it (a-click-on-add-reviewers-asks). `running`: the click is in flight.
 * A done row says "Requested" on the button and nothing more; an unconfirmed one "Unconfirmed", with GitHub's reply under it; a
 * refused one keeps "Add reviewers" (try again) with why under it. `compact`: a phone's button sits on the row's line
 * beside the title that names the PR and the people, so it keeps one short word ("Request", "Sending…", "Requested")
 * and the title keeps the room to say whom the click asks; its accessible name still says it in full (scope.a11y).
 * Never a bare "Ask": in Follow-up an ask is the developer's question or decision, not a review request.
 */
export function reviewersWords(scope: ReviewersScope, outcome: ReviewersOutcome | null, running = false, compact = false): { button: string; line: string | null; tone: "warning" | null; done: boolean } {
  const idle = compact ? "Request" : "Add reviewers";
  if (running) return { button: compact ? "Sending…" : "Requesting…", line: null, tone: null, done: false };
  // Done says it on the button alone, so the row keeps its height and the rows under it don't move.
  if (outcome?.state === "submitted") return { button: "Requested", line: null, tone: null, done: true };
  if (outcome?.state === "uncertain") return { button: "Unconfirmed", line: `Unconfirmed: ${outcome.result}`, tone: "warning", done: true };
  if (outcome) return { button: idle, line: `Not requested: ${outcome.result}`, tone: "warning", done: false };
  return { button: idle, line: null, tone: null, done: false };
}
