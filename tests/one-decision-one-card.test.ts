import test from "node:test";
import assert from "node:assert/strict";
import { askQuestion, coverNote, developerAnswer, needsYouQuestions, syncTaskQuestions, withdrawQuestion } from "../server/questions";
import { updateObligation } from "../server/obligations";
import { needsYou } from "../shared/attention";
import { summary, type Workspace } from "../shared/model";
import { isOpen } from "../shared/questions";
import { taskStatus } from "../shared/task-status";
import { violations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * 2026-11-22, Tom: "a lot of the time, 2 questions are created for the same thing". An agent asked Q1 with options and
 * the developer answered it; then a second card appeared: the task's title, "A task is blocked on this. The agent works
 * on the rest.", the body "Q1: may I <the action>?" and no options. The agent had marked the task blocked with ask
 * "Q1: may I …?", and syncTaskQuestions made a card from every blocked task with an ask without looking at the
 * questions already asked. Invariant one-decision-one-card.
 */
const MAIN = "main-agent";
const empty = () => workspace({ prs: [], obligations: [] });
const options = [{ letter: "A", label: "Drop it now", consequence: "Frees the space today." }, { letter: "B", label: "Keep it a week", consequence: "Rollback stays possible." }];
const askQ1 = (w: Workspace, task?: string) => askQuestion(w, MAIN, { title: "Drop the legacy orders table", question: "May I drop the legacy orders table after the backfill?", options, recommend: "A", ...(task ? { task } : {}) }, "work-around", clock).question;
const block = (w: Workspace, input: { id?: string; ask?: string; question?: string }) =>
  updateObligation(w, { title: "Clean up after the orders backfill", status: "blocked", evidence: "Backfill verified.", caller: MAIN, ...input });
const cards = (w: Workspace) => w.questions.filter(isOpen);
const taskCards = (w: Workspace) => w.questions.filter(q => q.via === "task");
const oneCard = (w: Workspace) => assert.deepEqual(violations(w, clock).filter(v => v.id === "one-decision-one-card"), []);

test("one-decision-one-card: the reported sequence (Q1 answered, then the task blocked on \"Q1: may I …?\") makes no second card", () => {
  const w = empty();
  const q1 = askQ1(w);
  developerAnswer(w, q1.id, "A", undefined, "send", clock);
  const o = block(w, { ask: "Q1: may I drop the legacy orders table?" });
  syncTaskQuestions(w, clock);
  assert.deepEqual(taskCards(w), [], "no card from the task");
  assert.equal(w.obligations[0].coveredBy, "Q1");
  assert.deepEqual(needsYou(w, clock).filter(i => i.kind === "question" || i.kind === "decision"), [], "nothing left in Needs you: the developer decided");
  assert.equal(taskStatus(o, w).text, "Answered · waits on the agent", "the answer shows on the task");
  assert.notEqual(summary(w, clock).status, "needs-you", "the agent's move now, not the developer's");
  assert.match(coverNote(w, o.id)!, /^Already answered as Q1/);
  assert.equal(syncTaskQuestions(w, clock), false, "a second sync changes nothing");
  oneCard(w);
});

test("one-decision-one-card: a task blocked while its question is open waits on that card, before and after the answer", () => {
  const w = empty();
  const o = block(w, { ask: "Can we drop the legacy orders table?" });
  w.obligations[0].status = "pending"; delete w.obligations[0].ask;
  const q1 = askQ1(w, o.id);
  block(w, { id: o.id, ask: "Need the developer's call on dropping the old table" });
  syncTaskQuestions(w, clock);
  assert.deepEqual(cards(w).map(q => q.id), [q1.id], "one card: the question asked with task set");
  assert.equal(taskStatus(w.obligations[0], w).text, "In Needs you");
  assert.match(coverNote(w, o.id)!, /^Already asked as Q1/);
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question" || i.kind === "decision").length, 1);
  oneCard(w);
  developerAnswer(w, q1.id, "B", undefined, "send", clock);
  syncTaskQuestions(w, clock);
  assert.deepEqual(taskCards(w), [], "answering it never brings a second card");
  oneCard(w);
});

test("one-decision-one-card: update_obligation question=\"Q1\" blocks on the asked question and writes its words as the ask", () => {
  const w = empty();
  const q1 = askQ1(w);
  const o = block(w, { question: q1.id });
  assert.equal(o.ask, "Q1: May I drop the legacy orders table after the backfill?");
  assert.equal(o.coveredBy, "Q1");
  syncTaskQuestions(w, clock);
  assert.deepEqual(taskCards(w), []);
  assert.throws(() => updateObligation(w, { id: o.id, title: o.title, status: "waiting", question: "Q1", caller: MAIN }), /status=blocked/);
  assert.throws(() => block(w, { id: o.id, question: "Q9" }), /No question Q9/);
  // A blocked update that leaves both out keeps the ask and its cover.
  block(w, { id: o.id });
  syncTaskQuestions(w, clock);
  assert.equal(w.obligations[0].coveredBy, "Q1");
  assert.deepEqual(taskCards(w), []);
  oneCard(w);
});

test("one-decision-one-card: a card the task made closes when the question is asked with options (ask_question or needs_you)", () => {
  for (const how of ["ask_question", "needs_you"] as const) {
    const w = empty();
    const o = block(w, { ask: "May I drop the legacy orders table after the backfill?" });
    syncTaskQuestions(w, clock);
    const [made] = taskCards(w);
    assert.ok(made && isOpen(made), "the task asked first");
    if (how === "ask_question") askQ1(w, o.id);
    else needsYouQuestions(w, MAIN, { decisions: [{ question: "May I drop the legacy orders table after the backfill?", options: [{ label: "Drop it now" }, { label: "Keep it a week" }], recommend: 0 }] }, "work-around", clock, null);
    syncTaskQuestions(w, clock);
    assert.equal(made.closed?.reason, "Already asked as Q2.", how);
    assert.equal(cards(w).length, 1, `${how}: one card left, the one with options`);
    assert.equal(cards(w)[0].options.length, 2);
    oneCard(w);
  }
});

test("one-decision-one-card: live duplicates close on the next sync with a reason the developer understands", () => {
  const w = empty();
  const q1 = askQ1(w);
  developerAnswer(w, q1.id, "A", undefined, "send", clock);
  const o = block(w, { ask: "Q1: may I drop the legacy orders table?" });
  // What main's sync left in live data: the task's own card, no cover recorded.
  w.questions.push({ id: "Q2", title: o.title, question: o.ask!, options: [], recommend: null, big: null, background: null, links: [], prKey: null,
    taskId: o.id, taskRevision: o.revision, askedBy: MAIN, askedAt: new Date(clock).toISOString(), mode: "work-around", answer: null, closed: null, via: "task" });
  // Uncovered twin: an open question asked with task set, beside the task's own card.
  const v = empty();
  const t = block(v, { ask: "Need a call on the old table" });
  syncTaskQuestions(v, clock);
  v.questions.push({ ...askQ1(empty(), undefined), id: "Q2", taskId: t.id });
  assert.ok(violations(v, clock).some(x => x.id === "one-decision-one-card"), "an open ask_question twin of a task card is a violation");
  assert.equal(syncTaskQuestions(w, clock), true);
  assert.equal(w.questions[1].closed?.reason, "Already answered as Q1.");
  assert.equal(w.questions[1].answer, null, "nothing is answered for the developer");
  oneCard(w);
  syncTaskQuestions(v, clock);
  assert.equal(v.questions[0].closed?.reason, "Already asked as Q2.");
  oneCard(v);
});

test("one-decision-one-card: a new decision still asks; a withdrawn question covers nothing; a superseded one is followed", () => {
  const w = empty();
  const q1 = askQ1(w);
  developerAnswer(w, q1.id, "A", undefined, "send", clock);
  const o = block(w, { ask: "Which region should the new orders replica live in?" });
  w.questions[0].taskId = o.id;
  syncTaskQuestions(w, clock);
  assert.equal(taskCards(w).length, 1, "a different decision on the same task gets its card");
  assert.equal(w.obligations[0].coveredBy, undefined);
  oneCard(w);

  const x = empty();
  const asked = askQ1(x);
  withdrawQuestion(x, MAIN, asked.id, "Not needed.", clock);
  block(x, { ask: "Q1: may I drop the legacy orders table?" });
  syncTaskQuestions(x, clock);
  assert.equal(taskCards(x).length, 1, "a withdrawn question asks nothing, so the task asks");

  const y = empty();
  askQ1(y);
  const q2 = askQuestion(y, MAIN, { title: "Drop the legacy orders table", question: "May I drop the legacy orders table after the backfill?", options: [...options, { letter: "C", label: "Archive it to cold storage" }], recommend: "C" }, "work-around", clock, { supersedes: "Q1" }).question;
  block(y, { ask: "Q1: may I drop the legacy orders table?" });
  syncTaskQuestions(y, clock);
  assert.equal(y.obligations[0].coveredBy, q2.id, "a superseded question is followed to its replacement");
  assert.deepEqual(taskCards(y), []);
  oneCard(y);
});

test("one-decision-one-card: a changed ask drops the cover and looks again; leaving blocked drops it", () => {
  const w = empty();
  askQ1(w);
  const o = block(w, { ask: "Q1: may I drop the legacy orders table?" });
  syncTaskQuestions(w, clock);
  assert.equal(w.obligations[0].coveredBy, "Q1");
  block(w, { id: o.id, ask: "Which region should the new orders replica live in?" });
  assert.equal(w.obligations[0].coveredBy, undefined);
  syncTaskQuestions(w, clock);
  assert.equal(taskCards(w).length, 1);
  updateObligation(w, { id: o.id, title: o.title, status: "working", caller: MAIN });
  syncTaskQuestions(w, clock);
  assert.equal(w.obligations[0].coveredBy, undefined);
  oneCard(w);
});

test("one-decision-one-card: an ask that mentions an unrelated open question in passing still gets its own card", () => {
  const w = empty();
  for (const [title, question] of [["Staging host", "Which staging host runs the nightly batch?"], ["Font for the invoices", "Should invoices switch to the new serif font?"], ["Cache size", "How large may the thumbnail cache grow?"]])
    askQuestion(w, MAIN, { title, question, options: [], recommend: undefined }, "work-around", clock);
  const q4 = askQuestion(w, MAIN, { title: "Retry window for the importer", question: "How long should the importer wait between retries?", options, recommend: "A" }, "work-around", clock).question;
  assert.equal(q4.id, "Q4");
  const o = block(w, { ask: "May I ship the Q4 report to finance?" });
  syncTaskQuestions(w, clock);
  assert.equal(w.obligations[0].coveredBy, undefined, "a passing mention links nothing");
  assert.equal(taskCards(w).length, 1, "the decision gets its own card, so it isn't dropped");
  assert.ok(isOpen(q4), "the unrelated question is untouched");
  assert.equal(coverNote(w, o.id), null);
  oneCard(w);
  // Leading with the id ("Q4 - …", "(Q4) …") or a question asked for this task still links.
  for (const ask of ["Q4 - how long between retries?", "(Q4) retry window?"]) {
    const v = empty();
    askQuestion(v, MAIN, { title: "Retry window for the importer", question: "How long should the importer wait between retries?", options, recommend: "A" }, "work-around", clock);
    block(v, { ask: ask.replace("Q4", "Q1") });
    syncTaskQuestions(v, clock);
    assert.equal(v.obligations[0].coveredBy, "Q1", ask);
    assert.deepEqual(taskCards(v), []);
  }
});
