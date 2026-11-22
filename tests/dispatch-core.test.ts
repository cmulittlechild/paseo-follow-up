import test from "node:test";
import assert from "node:assert/strict";
import {
  BODY_MAX_BYTES, BUILTIN_ACTIONS, LEARN_MIN, actionsFor, branchFor, builtinAction, clipBytes, effectiveActions, firstSentence, freeBranch,
  parseSource, renderAction, resolveWhere, titleFor, unknownPlaceholders, utf8Length, validateAction, type WhereInput, type WhereProject,
} from "../shared/dispatch";
import { parseIssue, parseIssuePage, salvageArray, toLinearIssue } from "../shared/linear-issues";

// New's pure core (shared/dispatch.ts): an-action-is-data and new-never-switches-the-project-silently. Fixtures are
// fictional (ACME, acme/web, example/app).

test("an action renders its placeholders, drops lines left empty and tidies what an empty value leaves", () => {
  const text = renderAction({ instructions: "Work on {key} “{title}” ({url}).\nIn {repo}.\n\n{body}\n{team}" }, { key: "ACME-142", title: "Retry failed charges", url: null, repo: "acme/web", body: "", team: "" });
  assert.equal(text, "Work on ACME-142 “Retry failed charges”.\nIn acme/web.");
});

test("typed text has no key or url: the built-in Create PR still reads as a sentence", () => {
  const text = renderAction(builtinAction("pr"), { title: "Export invoices as CSV", key: "", url: null, repo: "example/app", base: "main", branch: "export-invoices-as-csv", body: "Export invoices as CSV for the finance team." });
  assert.match(text, /^Work on “Export invoices as CSV”\./);
  assert.doesNotMatch(text, /\(\)|“”|\{\w+\}|  /);
  assert.match(text, /from export-invoices-as-csv against main in example\/app/);
});

test("{body} is clipped to 4 KB at a character boundary", () => {
  const body = "é".repeat(5000);
  const text = renderAction({ instructions: "{body}" }, { body });
  assert.ok(utf8Length(text) <= BODY_MAX_BYTES);
  assert.ok(text.endsWith("…"));
  assert.equal(clipBytes("short", BODY_MAX_BYTES), "short");
});

test("the developer's note is added after the instructions", () => {
  assert.equal(renderAction({ instructions: "Read {key}." }, { key: "ACME-1" }, " Keep it small. "), "Read ACME-1.\n\nNote from the developer: Keep it small.");
});

test("an unknown placeholder is refused when saving, by name", () => {
  assert.deepEqual(unknownPlaceholders("{title} {assignee} {title} {priority}"), ["assignee", "priority"]);
  const r = validateAction({ ...builtinAction("pr"), id: "mine", instructions: "Do {title} for {assignee}" });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /\{assignee\}/);
  assert.equal(validateAction({ ...builtinAction("pr"), id: "mine", builtin: undefined }).ok, true);
});

test("every built-in is valid data and uses only known placeholders", () => {
  for (const a of BUILTIN_ACTIONS) { assert.equal(validateAction(a).ok, true, a.id); assert.deepEqual(unknownPlaceholders(a.instructions), [], a.id); }
  assert.deepEqual(actionsFor(BUILTIN_ACTIONS, "linear").map(a => a.id), ["pr", "plan", "investigate"]);
  assert.deepEqual(actionsFor(BUILTIN_ACTIONS, "pr").map(a => a.id), ["checkout"]);
});

test("a saved list keeps its order, and a built-in it lacks is appended", () => {
  const saved = [builtinAction("plan"), { ...builtinAction("pr"), hidden: true }];
  assert.deepEqual(effectiveActions(saved).map(a => a.id), ["plan", "pr", "investigate", "open", "checkout"]);
  assert.deepEqual(actionsFor(effectiveActions(saved), "text").map(a => a.id), ["plan", "investigate"]);
});

test("sources: a Linear key or URL, GitHub issue and PR links, other links and typed text", () => {
  assert.deepEqual([parseSource("acme-142").kind, parseSource("acme-142").key, parseSource("acme-142").team], ["linear", "ACME-142", "ACME"]);
  const issue = parseSource("https://github.com/example/app/issues/77");
  assert.deepEqual([issue.kind, issue.repo, issue.number], ["issue", "example/app", 77]);
  const pr = parseSource("https://github.com/example/app/pull/318");
  assert.deepEqual([pr.kind, pr.repo, pr.number], ["pr", "example/app", 318]);
  assert.equal(parseSource("https://docs.example.com/spec").kind, "link");
  const text = parseSource("Export invoices as CSV. The finance team asked for it.");
  assert.deepEqual([text.kind, text.title, text.read], ["text", "Export invoices as CSV", true]);
});

test("titles and branches", () => {
  assert.equal(titleFor({ kind: "linear", key: "ACME-142", title: "Retry failed charges", number: null }), "ACME-142 Retry failed charges");
  assert.equal(titleFor({ kind: "pr", key: "example/app#318", title: "Add CSV export", number: 318 }), "#318 Add CSV export");
  assert.ok(firstSentence("word ".repeat(40)).length <= 60);
  assert.equal(branchFor({ kind: "linear", key: "ACME-142", title: "Retry failed charges", branchHint: "alice/acme-142-retry-failed-charges", number: null }, "source-or-title"), "alice/acme-142-retry-failed-charges");
  assert.equal(branchFor({ kind: "linear", key: "ACME-142", title: "Retry failed charges", branchHint: "alice/acme-142-retry", number: null }, "title"), "acme-142-retry-failed-charges");
  assert.ok(branchFor({ kind: "text", key: null, title: "x ".repeat(80), branchHint: null, number: null }, "title").length <= 50);
  assert.equal(freeBranch("acme-142-retry", ["ACME-142-retry", "acme-142-retry-2"]), "acme-142-retry-3");
});

const P = (id: string, repo: string | null = null, worktree = true): WhereProject => ({ id, name: id, repo, worktree });
const where = (over: Partial<WhereInput>) => resolveWhere({ source: { kind: "linear", team: "ACME", repo: null }, projects: [P("web", "acme/web"), P("app", "example/app")], rules: {}, learned: {}, lastProjectId: null, noTeam: "last", ...over });

test("where it goes, in order, with its reason", () => {
  assert.equal(where({ picked: "app", rules: { ACME: "web" } }).how, "picked");
  const link = where({ source: { kind: "issue", team: null, repo: "Example/App" } });
  assert.deepEqual([link.how, link.projectId, link.reason], ["link", "app", "From the link"]);
  assert.deepEqual([where({ rules: { ACME: "web" } }).how, where({ rules: { ACME: "web" } }).projectId], ["rule", "web"]);
  const learned = where({ learned: { ACME: { web: 9, app: 1 } } });
  assert.deepEqual([learned.how, learned.projectId, learned.reason], ["learned", "web", "9 ACME workspaces started here"]);
  // Below the share or the minimum: ambiguous, never a silent pick.
  assert.equal(where({ learned: { ACME: { web: 6, app: 4 } } }).how, "ambiguous");
  assert.equal(where({ learned: { ACME: { web: LEARN_MIN - 1 } } }).how, "ambiguous");
  // A source with no team: the last used project, drawn as a guess.
  const guess = where({ source: { kind: "text", team: null, repo: null }, lastProjectId: "app" });
  assert.deepEqual([guess.how, guess.guess, guess.reason], ["last", true, "Guess: last used project"]);
  assert.equal(where({ source: { kind: "text", team: null, repo: null }, lastProjectId: "app", noTeam: "ask" }).how, "ambiguous");
  // A team with no rule is never guessed from the last project: it asks once (the pick is saved for the team).
  const ask = where({ lastProjectId: "app" });
  assert.equal(ask.how, "ambiguous");
  assert.deepEqual(ask.candidates.map(c => [c.id, c.lastUsed]), [["app", true], ["web", false]]);
  assert.equal(where({ projects: [P("web", "acme/web"), P("notes", null, false)] }).how, "only");
});

test("a rule or pick naming a vanished project asks again and says why", () => {
  const gone = where({ rules: { ACME: "old" } });
  assert.equal(gone.how, "ambiguous");
  assert.match(gone.reason, /isn't in Paseo any more/);
  assert.equal(where({ picked: "old" }).projectId, null);
});

test("Linear replies: a page, a cut-off page, one issue, and not found", () => {
  const issue = { id: "ACME-142", uuid: "u-1", title: "Retry failed charges", url: "https://linear.app/acme/issue/ACME-142", gitBranchName: "alice/acme-142-retry", status: "In Progress", statusType: "started", team: "Acme Web", updatedAt: "2026-11-20T10:00:00.000Z", priority: { value: 2, name: "High" } };
  const page = parseIssuePage(JSON.stringify({ issues: [issue, { ...issue, id: "ACME-9", statusType: "completed" }], hasNextPage: true, cursor: "c1" }), true);
  assert.equal(page.next, "c1");
  assert.deepEqual(page.issues.map(i => [i.key, i.id, i.team, i.teamName, i.assigneeIsMe, i.priority?.name]), [["ACME-142", "u-1", "ACME", "Acme Web", true, "High"], ["ACME-9", "u-1", "ACME", "Acme Web", true, "High"]]);
  const cut = `{"issues":[${JSON.stringify(issue)},{"id":"ACME-1","title":"cut`;
  assert.equal(parseIssuePage(cut).issues.length, 1);
  assert.equal(salvageArray(cut, "issues").length, 1);
  assert.equal(parseIssue(JSON.stringify({ ...issue, description: "Charges fail on retry." }))?.description, "Charges fail on retry.");
  assert.equal(parseIssue("Entity not found: Issue"), null);
  assert.equal(toLinearIssue({ id: "nope", title: "x" }), null);
});
