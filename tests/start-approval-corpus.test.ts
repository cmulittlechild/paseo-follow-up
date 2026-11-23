import test from "node:test";
import assert from "node:assert/strict";
import { approvalCovers, startApproval, startRefusal } from "../shared/overseer";
import { briefAnswer, briefAnswers } from "../shared/brief";

// One corpus of how the developer asks the Overseer for new work, and how they don't
// (the-overseer-starts-what-the-developer-asked). Each row: the developer's message, what the Overseer said before it
// (its proposal, or ""), and the keys it approves: an array, "any" (work with no key named), or null (nothing).

const PROPOSED_TWO = "ACME-12 and ACME-14 have no workspace yet. Start one for each?";
const PROPOSED_ONE = "Nobody owns ACME-12. Want me to start a workspace for it?";

type Row = [message: string, proposal: string, approves: string[] | "any" | null];
const CORPUS: Row[] = [
  // Requests: plurals, imperatives, polite questions, keys on their own lines.
  ["create workspaces for these: ACME-12 ACME-14", "", ["ACME-12", "ACME-14"]],
  ["Can you create workspaces for these: ACME-12 ACME-14", "", ["ACME-12", "ACME-14"]],
  ["Can you create workspaces for these:\nACME-12\nACME-14", "", ["ACME-12", "ACME-14"]],
  ["start ACME-12", "", ["ACME-12"]],
  ["Start ACME-12 and ACME-14", "", ["ACME-12", "ACME-14"]],
  ["spin these two up", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["spin up agents for ACME-12", "", ["ACME-12"]],
  ["kick them off", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["can you work on ACME-12 in a new workspace", "", ["ACME-12"]],
  ["could you please start a new workspace for ACME-14?", "", ["ACME-14"]],
  ["open a workspace for this", PROPOSED_ONE, ["ACME-12"]],
  ["open a workspace for the flaky login test", PROPOSED_ONE, "any"],
  ["start a new workspace for it", "", "any"],
  ["new worktrees for ACME-12 and ACME-14 please", "", ["ACME-12", "ACME-14"]],
  ["I want a new workspace for the export bug", "", "any"],
  ["let's start ACME-12", "", ["ACME-12"]],
  ["ok, start both", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["start ACME-12 but not ACME-14", PROPOSED_TWO, ["ACME-12"]],
  ["start working on ACME-12", "", ["ACME-12"]],
  ["pick up ACME-12", "", ["ACME-12"]],
  ["launch an agent for this", PROPOSED_ONE, ["ACME-12"]],
  ["set up a worktree for ACME-12", "", ["ACME-12"]],
  // Saying yes to the Overseer's proposal.
  ["yes", PROPOSED_ONE, ["ACME-12"]],
  ["yes", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["go ahead", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["yes, go ahead", "", "any"],
  ["do both", PROPOSED_TWO, ["ACME-12", "ACME-14"]],
  ["yes, just ACME-12", PROPOSED_TWO, ["ACME-12"]],
  ["sure, but not ACME-14", PROPOSED_TWO, ["ACME-12"]],
  ["sounds good", PROPOSED_ONE, ["ACME-12"]],
  // Questions, refusals and other asks never approve.
  ["which open workspaces need me?", "", null],
  ["which open workspaces need me?", PROPOSED_TWO, null],
  ["don't start a workspace yet", PROPOSED_TWO, null],
  ["do not create workspaces for these", PROPOSED_TWO, null],
  ["how many agents are running?", "", null],
  ["is there an open workspace for ACME-12?", "", null],
  ["what's the status of ACME-12?", "", null],
  ["should I start a workspace for ACME-12?", "", null],
  ["do you have a workspace for ACME-12?", "", null],
  ["tell the export agent to fix it", "", null],
  ["open the PR for ACME-12", "", null],
  ["make a summary of it", PROPOSED_ONE, null],
  ["create a PR for ACME-12", "", null],
  ["start the tests for ACME-12", "", null],
  ["open ACME-12", "", null],
  ["no", PROPOSED_TWO, null],
  ["not yet", PROPOSED_TWO, null],
  ["wait, hold off", PROPOSED_TWO, null],
  ["the export is broken, someone should look", "", null],
  ["", PROPOSED_TWO, null],
];

test("the corpus: what each phrasing approves", () => {
  for (const [message, proposal, want] of CORPUS) {
    const a = startApproval(message, proposal);
    const got = !a ? null : a.keys === null ? "any" : [...a.keys].sort();
    assert.deepEqual(got, want === null || want === "any" ? want : [...want].sort(), `${JSON.stringify(message)} after ${JSON.stringify(proposal)}`);
  }
});

test("a declined key is refused even when the rest is approved", () => {
  const a = startApproval("start ACME-12 but not ACME-14", "")!;
  assert.equal(approvalCovers(a, "ACME-12"), true);
  assert.equal(approvalCovers(a, "ACME-14"), false);
  assert.match(startRefusal(a, "ACME-14"), /said no to ACME-14/);
});

const card = (picks: Record<string, string>, words: Record<string, string> = {}) => briefAnswers("Start workspaces for ACME-12 and ACME-14?", [
  { id: "D1", question: "Start a new workspace for ACME-12?", options: [{ letter: "A", label: "New workspace" }, { letter: "B", label: "Skip" }] },
  { id: "D2", question: "Start a new workspace for ACME-14?", options: [{ letter: "A", label: "New workspace" }, { letter: "B", label: "Skip" }] },
], picks, words);

test("card answers approve exactly the decisions answered New workspace", () => {
  const keys = (text: string) => { const a = startApproval(text); return a ? { keys: a.keys, declined: a.declined } : null; };
  assert.deepEqual(keys(card({ D1: "A", D2: "A" })), { keys: ["ACME-12", "ACME-14"], declined: [] });
  assert.deepEqual(keys(card({ D1: "A", D2: "B" })), { keys: ["ACME-12"], declined: ["ACME-14"] });
  assert.deepEqual(keys(card({ D1: "A" })), { keys: ["ACME-12"], declined: ["ACME-14"] }, "a skipped decision is not approved");
  assert.equal(keys(card({ D1: "B", D2: "B" })), null);
  assert.deepEqual(keys(card({ D1: "other", D2: "B" }, { D1: "yes, start it" })), { keys: ["ACME-12"], declined: ["ACME-14"] }, "Something else in their own words");
  // One decision, the older single-answer format; a question without a key approves the work it names.
  assert.deepEqual(keys(briefAnswer("D1", "Start a new workspace for ACME-12?", "A", "New workspace")), { keys: ["ACME-12"], declined: [] });
  assert.deepEqual(keys(briefAnswer("D1", "Start a new workspace for ACME-12?", "B", "Skip")), null);
  assert.deepEqual(keys("Follow-up answer D1 (Which agent should take it?): C — New workspace\nContinue with this choice."), { keys: null, declined: [] });
  assert.equal(keys("Follow-up answer D1 (Which agent should take it?): A — SCIM\nContinue with this choice."), null);
});

test("the refusal names what counts and one plain ask, never 'only the card'", () => {
  for (const r of [startRefusal(null, "ACME-12"), startRefusal(startApproval("start ACME-14")!, "ACME-12")]) {
    assert.match(r, /request in chat/);
    assert.match(r, /"Start a workspace for ACME-12\?"/);
    assert.doesNotMatch(r, /only (approval|an answer|a click) (from|on) (its|your)( own)? card|card only/i);
  }
  assert.match(startRefusal(startApproval("start ACME-14")!, "ACME-12"), /approved ACME-14, not ACME-12/);
});
