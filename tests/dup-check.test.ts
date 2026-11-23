import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { updateObligation } from "../server/obligations";
import { DUP_MAX, normTitle, similarOpen, titleSimilarity } from "../shared/task-dup";
import { obligationRpc } from "../shared/contracts";
import { listEntry } from "../shared/list";
import { clock, workspace } from "./fixtures";

/**
 * a-new-task-is-checked-once. 2026-11-22 live audit: 3-4 true duplicate tasks (the same work added twice, one of them
 * left open after the other closed) and 66 tasks renamed in place. A write without an id is checked once, against the
 * workspace's open tasks: the caller's own exact title updates that task, a similar title is refused with the ids to
 * update by (pass new=true to add it anyway), and a clean write adds nothing to the reply.
 */
const MAIN = "main-agent";
const SUB = "sub-agent";
const empty = () => workspace({ prs: [], obligations: [] });
const add = (w: ReturnType<typeof empty>, title: string, extra: Record<string, unknown> = {}) =>
  updateObligation(w, { title, status: "pending", caller: MAIN, now: clock, ...extra });

test("a-new-task-is-checked-once: the caller's exact title again updates that task instead of adding a copy", () => {
  const w = empty();
  const first = add(w, "Wire alert thresholds into config");
  const again = add(w, "wire alert thresholds into config.", { status: "waiting", evidence: "Waits for the review." });
  assert.equal(again.id, first.id, "case and punctuation don't make a different task");
  assert.equal(w.obligations.length, 1);
  assert.equal(again.status, "waiting");
  assert.equal(first.createdBy, MAIN);
});

test("a-new-task-is-checked-once: a similar open title is refused with up to 3 lines naming each by id; new=true adds it", () => {
  const w = empty();
  const ids = ["Check alert emails in staging", "Check alert emails in production", "Check alert email copy in staging", "Check the alert emails"].map(t => add(w, t, { new: true }).id);
  assert.equal(w.obligations.length, 4, "new=true adds a task whatever is open");
  assert.throws(() => add(w, "Check alert emails on staging"), (e: Error) => {
    const lines = e.message.split("\n");
    assert.ok(lines.length <= DUP_MAX, `at most ${DUP_MAX} lines: ${e.message}`);
    assert.match(lines[0], new RegExp(`^Similar open task: ${ids[0]} "Check alert emails in staging" \\(pending\\)\\. Update it by id, or pass new=true for a separate task\\.$`), "the closest first, with what to do");
    for (const l of lines.slice(1)) assert.match(l, /^Similar open task: \S+ ".+" \(\w+\)\.$/);
    assert.ok(e.message.length < 400, "about 20 tokens a line");
    return true;
  });
  assert.equal(w.obligations.length, 4, "nothing was added");
  // Another agent's exact title is not a repeat of this caller's write: it is asked about, not merged.
  assert.throws(() => updateObligation(w, { title: "Check alert emails in staging", status: "pending", caller: SUB, now: clock }), /Similar open task: /);
});

test("a-new-task-is-checked-once: clean writes, finished tasks, renames and Follow-up's own edits are never flagged", () => {
  const w = empty();
  const a = add(w, "Backfill alert history for existing plans");
  const b = add(w, "Confirm the usage export with billing");
  assert.equal(w.obligations.length, 2, "unrelated titles add with no question");
  updateObligation(w, { id: a.id, title: "Backfill alert history", status: "done", evidence: "Backfilled.", caller: MAIN, now: clock });
  assert.equal(add(w, "Backfill alert history for existing plans").id === a.id, false, "a finished task is history: the same title is a new task");
  updateObligation(w, { id: b.id, title: "Confirm the usage export with billing and finance", status: "pending", caller: MAIN, now: clock });
  assert.equal(w.obligations.find(o => o.id === b.id)!.title, "Confirm the usage export with billing and finance", "a rename keeps its id and is never checked");
  assert.doesNotThrow(() => updateObligation(w, { title: "Confirm the usage export with billing", status: "pending", now: clock }), "no caller (Follow-up's own write): unchecked");
});

test("a-new-task-is-checked-once: similarity is token Jaccard on the first 60 characters", () => {
  assert.equal(titleSimilarity("Check alert emails in staging", "check ALERT emails, in staging!"), 1);
  assert.ok(titleSimilarity("Check alert emails in staging", "Check alert emails on staging") >= 0.5);
  assert.ok(titleSimilarity("Wire alert thresholds", "Backfill alert history") < 0.5);
  assert.equal(normTitle("x".repeat(80)).length, 80, "the exact-title rule reads the whole title");
  const w = workspace({ prs: [], obligations: Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, title: `Task number ${i} about thing ${i}`, status: "pending" as const, afterPrs: [], evidence: "", enable_follow_up: false, revision: 0 })) });
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) similarOpen(w, "Task number 3 about thing 3");
  assert.ok((performance.now() - t0) / 100 < 5, "14 open tasks (the live max) cost well under a millisecond a write");
});

test("a-new-task-is-checked-once: the agent can say new=true, and who made a task stays on the server", async () => {
  assert.equal(obligationRpc.input.safeParse({ agentId: MAIN, title: "x", status: "pending", new: true }).success, true);
  const mcp = await readFile(join(import.meta.dirname, "..", "server", "mcp.mjs"), "utf8");
  assert.match(mcp, /new: \{ type: "boolean", description: "Add a separate task even though a similar open one exists\." \}/);
  const w = empty();
  add(w, "Wire alert thresholds");
  assert.equal("createdBy" in (listEntry(w) as { obligations: object[] }).obligations[0], false, "the panel never needs it");
});

test("a-new-task-is-checked-once: two long titles sharing their first 60 characters are two tasks, never merged", () => {
  // #287 review: templated titles ("… after deploy of #283" / "… #290") cut at 60 characters were one title, so the
  // second write renamed and updated the first.
  const w = empty();
  const stem = "Verify the vendors table migration after the deploy of the billing service ";
  assert.ok(stem.length > 60);
  const first = add(w, `${stem}#283`);
  assert.throws(() => add(w, `${stem}#290`), new RegExp(`Similar open task: ${first.id} `), "close enough to ask, not the same task");
  assert.equal(w.obligations.length, 1);
  assert.equal(first.title, `${stem}#283`, "the first task is untouched");
  const second = add(w, `${stem}#290`, { new: true });
  assert.notEqual(second.id, first.id);
  assert.equal(add(w, `${stem}#290`, { status: "waiting" }).id, second.id, "the whole exact title still updates its own task");
  assert.equal(w.obligations.length, 2);
});
