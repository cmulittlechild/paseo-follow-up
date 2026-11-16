import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerHasActions, answerHeading, resendTitle } from "../shared/questions";
import { DELIVERY_STATES } from "../shared/queue";

/**
 * 2026-11-16 (harness renders): the question dialog's action row opened only for a fixed state list that left out
 * failed and retrying, so a Failed answer read "Check the agent's chat, then Retry." with no Retry button. The row is
 * now derived from resendTitle: every state that offers a button opens it.
 */
test("every delivery state whose card offers Retry or Try now opens the action row", () => {
  const states = [...DELIVERY_STATES, "unconfirmed", "copied", "in-chat"];
  for (const state of states) for (const nextAt of [null, "2026-11-16T12:04:00.000Z"]) {
    const d = { state, nextAt };
    if (resendTitle(d)) assert.ok(answerHasActions(d), `${state}${nextAt ? " with a retry time" : ""} offers ${resendTitle(d)} but its row stays closed`);
  }
  assert.equal(resendTitle({ state: "failed" }), "Retry");
  assert.equal(resendTitle({ state: "retrying", nextAt: "2026-11-16T12:04:00.000Z" }), "Try now");
});

test("the dialog gates its action row on answerHasActions, not on a list of its own", () => {
  const source = readFileSync(new URL("../client/questions.tsx", import.meta.url), "utf8");
  assert.match(source, /const actions = \(open \|\| q\.answer && answerHasActions\(q\.answer\.delivery\)\)/);
  assert.doesNotMatch(source, /function resendTitle/, "one resendTitle, in shared/questions.ts");
});

test("only a delivered answer reads green: queued, retrying and failed keep the check but stay neutral", () => {
  const q = (delivery: Record<string, unknown>) => ({ options: [{ letter: "A", label: "An hour" }], answer: { choice: "A", by: "developer", at: "2026-11-16T09:00:00.000Z", delivery } }) as never;
  for (const state of ["queued", "sending", "retrying", "failed"]) {
    const h = answerHeading(q({ state, at: "2026-11-16T09:00:00.000Z" }))!;
    assert.equal(h.delivered, false, state); assert.equal(h.waiting, false, state);
  }
  assert.equal(answerHeading(q({ state: "sent", at: "2026-11-16T09:00:00.000Z" }))!.delivered, true);
  const source = readFileSync(new URL("../client/questions.tsx", import.meta.url), "utf8");
  assert.match(source, /backgroundColor: heading\.delivered \? tint\(c\.statusSuccess, c\) : c\.surface1/);
});
