import test from "node:test";
import assert from "node:assert/strict";
import { actionBar, ambiguousNote, failureRemedy, dispatchSteps, homeRecords, moveSelection, newKey, newRows, recordLine, routeText, rowSource, shortAge, targetLine } from "../shared/new-view";
import type { DispatchRecord, DispatchSources } from "../shared/dispatch";
import type { LinearIssue } from "../shared/linear-issues";

// New's dialog as pure data. Fixtures are fictional (ACME, acme/web, example/app).

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const issue = (key: string, title: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: `u-${key}`, key, title, state: "Todo", stateType: "unstarted", priority: null, updatedAt: "2026-11-20T10:00:00.000Z", team: key.split("-")[0],
  teamName: null, url: `https://linear.app/acme/issue/${key}`, assigneeIsMe: true, branchName: null, description: null, ...over,
}) as LinearIssue;
const sources: Pick<DispatchSources, "linear" | "routes"> = {
  linear: { status: "ok", at: NOW, more: false, issues: [issue("ACME-142", "Retry failed charges", { state: "In Progress", stateType: "started" }), issue("ACME-151", "Export the audit log as CSV"), issue("WEB-77", "Invoice PDF rounds VAT")] },
  routes: { "ACME-142": { project: "acme/web", guess: false, existing: null }, "ACME-151": { project: "acme/web", guess: false, existing: { workspaceId: "ws-1", title: "Audit export", state: "tracked" } }, "WEB-77": { project: null, guess: false, existing: null } },
};

test("an empty field lists the issues you could start, the first preselected; one with a workspace folds below", () => {
  const { rows, selected, empty } = newRows(sources, "", NOW);
  assert.equal(selected, "ACME-142");
  assert.equal(empty, null);
  assert.deepEqual(rows.map(r => r.kind === "issue" ? [r.key, r.icon, r.age, r.route.text, r.route.tone] : [r.id]), [
    ["ACME-142", "Contrast", "2h", "→ acme/web", "plain"],
    ["WEB-77", "Circle", "2h", "→ which project?", "warn"],
    ["taken"],
  ]);
  const open = newRows(sources, "", NOW, true);
  assert.deepEqual(open.rows.map(r => r.kind === "issue" ? [r.key, r.route.text, r.taken] : [r.id, r.kind === "fold" && r.title]), [
    ["ACME-142", "→ acme/web", false], ["WEB-77", "→ which project?", false], ["taken", "1 already has a workspace"], ["ACME-151", "Audit export · running", true],
  ]);
});

test("a pasted key that's in the list selects that row; any other paste is a Pasted row on top", () => {
  const listed = newRows(sources, "https://linear.app/acme/issue/ACME-151/export", NOW);
  assert.equal(listed.selected, "ACME-151");
  assert.deepEqual(listed.rows.map(r => r.id), ["ACME-151", "ACME-142", "WEB-77"], "a pasted link is never a suggestion: its row comes first, taken or not");
  assert.equal(listed.rows.find(r => r.id === "ACME-151")?.kind === "issue" && (listed.rows.find(r => r.id === "ACME-151") as { tag: string }).tag, "From your link");
  const gh = newRows(sources, "https://github.com/example/app/issues/77", NOW);
  assert.deepEqual([gh.selected, gh.rows[0].kind, rowSource(gh.rows[0])], ["pasted", "pasted", "https://github.com/example/app/issues/77"]);
});

test("words preselect the best matching issue, then Start from your words, and Search all of Linear last", () => {
  const typed = newRows(sources, "invoice", NOW);
  assert.deepEqual(typed.rows.map(r => r.id), ["WEB-77", "words", "search"]);
  assert.equal(typed.selected, "WEB-77");
  // A match a workspace already has folds, so words never preselect it.
  assert.deepEqual(newRows(sources, "export", NOW).rows.map(r => r.id), ["words", "taken", "search"]);
  const none = newRows(sources, "Rate-limit webhook retries per endpoint", NOW);
  assert.deepEqual(none.rows.map(r => r.id), ["words", "search"]);
  assert.equal(rowSource(none.rows[0]), "Rate-limit webhook retries per endpoint");
  assert.equal(rowSource(none.rows[1]), null);
  assert.equal(moveSelection(none.rows, "words", 1), "search");
  assert.equal(moveSelection(none.rows, "search", 1), "search");
  assert.equal(moveSelection(none.rows, "words", -1), "words");
});

test("no Linear: the list is empty and words still work", () => {
  const missing = { linear: { status: "missing" as const, issues: [] as [], at: NOW, error: "Linear isn't connected.", more: false as const }, routes: {} };
  assert.deepEqual(newRows(missing, "", NOW), { rows: [], selected: null, empty: null });
  assert.equal(newRows(null, "Fix the login page", NOW).selected, "words");
});

const where = (how: "rule" | "ambiguous") => ({ projectId: how === "rule" ? "web" : null, projectName: how === "rule" ? "acme/web" : null, how, reason: "", guess: false, candidates: [] });
const actions = [{ id: "pr", name: "Create PR", icon: "git-pull-request", description: "" }, { id: "plan", name: "Plan as artifact", icon: "file-text", description: "" }, { id: "investigate", name: "Investigate", icon: "search", description: "" }];

test("the bar: ↵ is always the first action, ⌥↵ the second, the rest under More; ambiguous blocks every action", () => {
  const bar = actionBar({ actions, where: where("rule"), blockers: [], existing: null });
  assert.equal(bar.kind, "actions");
  if (bar.kind !== "actions") return;
  assert.deepEqual([bar.primary?.name, bar.primary?.key, bar.primary?.icon, bar.second?.key, bar.more.map(m => m.id), bar.disabled], ["Create PR", "↵", "GitPullRequest", "⌥↵", ["investigate"], null]);
  const blocked = actionBar({ actions, where: where("ambiguous"), blockers: ["Pick a project."], existing: null });
  assert.equal(blocked.kind === "actions" && blocked.disabled, "Pick a project first; the actions start there.");
  const open = actionBar({ actions, where: where("rule"), blockers: [], existing: { workspaceId: "ws-1", title: "Audit export", state: "tracked" } });
  assert.deepEqual([open.kind, open.kind === "existing" && open.others.every(b => b.key === null)], ["existing", true]);
});

test("the phone bar names what the primary starts", () => {
  assert.equal(targetLine({ source: { kind: "linear", key: "ACME-142", title: "Retry" } as never, where: where("rule"), base: { name: "main", reason: "" }, agent: "Opus 5.5 bypass" }), "ACME-142 · acme/web from main · Opus 5.5 bypass");
});

const record = (over: Partial<DispatchRecord>): DispatchRecord => ({
  id: "d1", at: "2026-11-20T11:59:00.000Z", by: "developer", source: { kind: "linear", key: "ACME-142", title: "Retry failed charges", url: null },
  actionId: "pr", actionName: "Create PR", projectId: "web", projectName: "acme/web", workspace: "worktree", base: "main", branch: "acme-142", prNumber: null,
  title: "ACME-142 Retry failed charges", agentLabel: "Claude", agent: null, promptHash: "x", prompt: null, state: "queued", step: null, workspaceId: null, agentId: null,
  error: null, leftBehind: null, attempts: 0, nextTryAt: null, undoUntil: null, ...over,
});

test("the four steps, and a failure marks the step that failed", () => {
  assert.deepEqual(dispatchSteps(record({ state: "starting", workspaceId: "ws-1" })).map(s => s.state), ["done", "active", "waiting", "waiting"]);
  assert.deepEqual(dispatchSteps(record({ state: "created", workspaceId: "ws-1" })).map(s => s.state), ["done", "done", "done", "done"]);
  assert.deepEqual(dispatchSteps(record({ state: "failed", leftBehind: "Nothing was created." })).map(s => s.state), ["failed", "skipped", "skipped", "skipped"]);
  assert.deepEqual(dispatchSteps(record({ state: "failed", leftBehind: "The workspace was archived again; nothing is left behind." })).map(s => s.state), ["done", "failed", "skipped", "skipped"]);
  assert.equal(dispatchSteps(record({ prNumber: 318 }))[0].label, "Check out #318");
});

test("Home shows dispatches in progress, recent failures and undoable ones, with Undo's minutes", () => {
  const created = record({ id: "c", state: "created", workspaceId: "ws-1", undoUntil: new Date(NOW + 4.5 * 60_000).toISOString() });
  const old = record({ id: "o", state: "created", workspaceId: "ws-2", undoUntil: new Date(NOW - 1).toISOString() });
  const failedLong = record({ id: "f", state: "failed", at: "2026-11-20T09:00:00.000Z", error: "x" });
  assert.deepEqual(homeRecords([created, old, failedLong, record({ id: "q" })], NOW).map(r => r.id).sort(), ["c", "q"]);
  assert.deepEqual([recordLine(created, NOW).undo, recordLine(created, NOW).minutesLeft, recordLine(created, NOW).line], [true, 5, "Create PR · acme/web · started · Undo for 5 min"]);
  // A server clock a little ahead never offers more than the window.
  assert.equal(recordLine(record({ id: "f", state: "created", workspaceId: "ws-3", undoUntil: new Date(NOW + 10 * 60_000 + 40).toISOString() }), NOW).minutesLeft, 10);
});

test("keys: ↵ primary, ⌥↵ second, ⇧↵ search, arrows, ⌘I; a field keeps Enter; created takes ⌘↵ and ⌘Z", () => {
  const k = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, o = { editing: false, created: false }) =>
    newKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m }, true, o);
  assert.deepEqual([k("Enter"), k("Enter", { altKey: true }), k("Enter", { shiftKey: true }), k("ArrowDown"), k("i", { metaKey: true }), k("Escape")], ["primary", "second", "search", "down", "instructions", "close"]);
  assert.equal(k("Enter", {}, { editing: true, created: false }), null);
  assert.equal(k("Enter", { metaKey: true }, { editing: false, created: true }), "open");
  assert.equal(k("z", { metaKey: true }, { editing: false, created: true }), "undo");
  assert.equal(k("Enter", {}, { editing: false, created: true }), null);
  assert.equal(newKey({ key: "i", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, false, { editing: false, created: false }), "instructions");
});

test("ages and routes", () => {
  assert.deepEqual([shortAge("2026-11-20T11:59:40.000Z", NOW), shortAge("2026-11-20T11:55:00.000Z", NOW), shortAge("2026-11-17T12:00:00.000Z", NOW), shortAge(null, NOW)], ["now", "5m", "3d", ""]);
  assert.equal(routeText(undefined).tone, "warn");
});

test("the which-project note never says the heading or the saved line twice", () => {
  assert.deepEqual(ambiguousNote(null, "Which project?"), { ask: "Which project?", note: "" });
  assert.deepEqual(ambiguousNote("OPS", "Which project for OPS? Your pick is saved for OPS."), { ask: "Which project for OPS?", note: "Your pick is saved for OPS. Change it in Settings → New work." });
  assert.deepEqual(ambiguousNote("OPS", "The project saved for OPS isn't in Paseo any more. Pick one; it's saved for OPS."), { ask: "Which project for OPS?", note: "The project saved for OPS isn't in Paseo any more. Pick one; it's saved for OPS. Change it in Settings → New work." });
  assert.deepEqual(ambiguousNote("OPS", null), { ask: "Which project for OPS?", note: "Your pick is saved for OPS. Change it in Settings → New work." });
});

test("a failure offers the field that fixes it: the agent after a workspace was made, the base for a new worktree", () => {
  const f = { state: "failed", workspace: "worktree", prNumber: null, workspaceId: null, leftBehind: "Nothing was created." } as const;
  assert.deepEqual(failureRemedy(f), { field: "base", label: "Change base" });
  assert.deepEqual(failureRemedy({ ...f, leftBehind: "The workspace was archived again; nothing is left behind." }), { field: "agent", label: "Change agent" });
  assert.equal(failureRemedy({ ...f, prNumber: 170 }), null);
  assert.equal(failureRemedy({ ...f, workspace: "local" }), null);
  assert.equal(failureRemedy({ ...f, state: "created" }), null);
});
