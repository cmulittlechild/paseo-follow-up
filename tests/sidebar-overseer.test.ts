import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listOverseerRow, overseerLineRanges, overseerRowState, overseerRowTarget } from "../shared/overseer";

// one-row-everywhere: Paseo's sidebar view is Home's list, so it pins the Overseer row whenever Home would.
const on = { enabled: true, agentId: "overseer-1", error: null };
const idle = { status: "idle", needs: null, snooze: null, brief: null } as const;
const running = { ...idle, status: "running" } as const;
const asks = { ...idle, needs: { reasons: [], since: "2026-03-05T10:00:00.000Z" }, brief: { state: "open", kind: "decision", ask: "Pick the release order" } } as never;
const cases: [string, Parameters<typeof overseerRowState>[0], Parameters<typeof overseerRowState>[1]][] = [
  ["start", { enabled: true, agentId: null, error: null }, null],
  ["error", { ...on, error: "the agent was archived" }, idle],
  ["running", on, running],
  ["asks", on, asks],
  ["idle", on, idle],
];

test("the sidebar view lists the Overseer row exactly when Home would, in every state", () => {
  for (const [state, status, row] of cases) {
    const home = overseerRowState(status, row);
    assert.equal(home?.state, state);
    assert.deepEqual(listOverseerRow(status, row, ""), home, `${state}: same row as Home`);
  }
  assert.equal(listOverseerRow({ enabled: false, agentId: null, error: null }, null, ""), null, "off on Home, off here");
});

test("a filter keeps the Overseer row only when the query is about it", () => {
  assert.equal(listOverseerRow(on, idle, "over")?.state, "idle");
  assert.equal(listOverseerRow(on, asks, "release order")?.state, "asks", "words of its line");
  assert.equal(listOverseerRow(on, idle, "billing"), null, "anything else hides it");
});

test("the filter's match in the Overseer's line is highlighted like a row's", () => {
  assert.deepEqual(listOverseerRow(on, asks, "release")?.ranges, [[20, 27]], "Asks you · Pick the release order");
  assert.equal(listOverseerRow(on, idle, "overseer")?.ranges, undefined, "a match on its name marks nothing in the line");
  assert.deepEqual(overseerLineRanges("Retry, then retry again", "retry"), [[0, 5], [12, 17]]);
});

test("selecting the row opens the Overseer's chat, or Home's pane for Start and a failed restart", () => {
  assert.deepEqual(cases.map(([s]) => [s, overseerRowTarget(s as never)]),
    [["start", "home"], ["error", "home"], ["running", "chat"], ["asks", "chat"], ["idle", "chat"]]);
});

test("the sidebar view hands HomeList the Overseer row", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "sidebar-view.tsx"), "utf8");
  const list = source.match(/<HomeList\b([\s\S]*?)\/>/)?.[1] ?? "";
  assert.match(list, /\boverseer=\{/, "HomeList gets the overseer prop");
  assert.match(list, /\bstackOverseer\b/, "stacked like the sidebar's other rows: title, then its line on up to two lines");
  assert.doesNotMatch(source, /__followOverseerMock/, "no review-only switch ships");
  assert.match(source, /\blistOverseerRow\(/, "from the shared row state, so it never drifts from Home's");
});
