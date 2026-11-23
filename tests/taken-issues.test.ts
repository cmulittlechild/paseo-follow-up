import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, testStore } from "./support/store-temp-dir";
import { DispatchService, DispatchStore } from "../server/dispatch";
import { holderOf, issueWorkspaces, keysIn, type IssueWorkspaceInput } from "../shared/issue-workspace";
import { newRows } from "../shared/new-view";
import { raisedNeeds } from "../shared/linear-queue";
import type { DispatchSources } from "../shared/dispatch";
import type { LinearIssue } from "../shared/linear-issues";

// a-taken-issue-is-not-a-suggestion (invariant 95). 2026-11-23, on 2.4.0-beta.3: New's My issues offered, as work to
// start, issues a planning workspace had made and linked and that other workspaces already had PRs open for, because
// "has a workspace" counted only links, and New listed every issue anyway. Fixtures are fictional (ACME, acme/web).

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const issue = (key: string, title: string): LinearIssue => ({
  id: `u-${key}`, key, title, state: "In Review", stateType: "started", priority: null, updatedAt: "2026-11-23T10:00:00.000Z", team: "ACME",
  teamName: null, url: `https://linear.app/acme/issue/${key}`, assigneeIsMe: true, branchName: null, description: null,
}) as LinearIssue;
const pr = (headBranch: string, title = "Work") => ({ snapshot: { headBranch, title } });

// A planning workspace links ACME-12 and ACME-13; another workspace tracks a PR whose branch names ACME-13; ACME-14 is
// free; ACME-123 is named only as a prefix-alike, by an archived workspace.
const input: IssueWorkspaceInput = {
  workspaces: [
    { id: "plan", title: "Q4 planning", archived: false, enable_tracking: true, activityAt: "2026-11-23T11:00:00.000Z", prs: [] },
    { id: "retry", title: "Retry failed charges", archived: false, enable_tracking: true, activityAt: "2026-11-22T09:00:00.000Z", prs: [pr("alice/acme-13-retry-charges")] },
    { id: "old", title: "Old attempt", archived: true, enable_tracking: true, activityAt: "2026-11-23T11:30:00.000Z", prs: [pr("acme-14-old")] },
  ],
  links: [["plan", ["ACME-12", "ACME-13"]], ["old", ["ACME-14"]]],
};

test("one predicate: a link or a tracked PR's branch or title names the key, the PR's workspace wins, archived ones never count", () => {
  const map = issueWorkspaces(input);
  assert.equal(holderOf(map, "ACME-12")?.workspaceId, "plan");
  assert.deepEqual(holderOf(map, "ACME-13"), { workspaceId: "retry", title: "Retry failed charges", state: "tracked", via: "pr" }, "the PR's workspace over the planning one that only links it");
  assert.equal(holderOf(map, "ACME-14"), null, "an archived workspace has nothing");
  assert.equal(holderOf(map, "acme-13")?.workspaceId, "retry", "keys are case-insensitive");
});

test("a key matches only as a whole token", () => {
  assert.deepEqual(keysIn("alice/acme-123-retry"), ["ACME-123"]);
  assert.deepEqual(keysIn("ACME-12: Retry, and WEB-7"), ["ACME-12", "WEB-7"]);
  assert.ok(!keysIn("acme-123-retry").includes("ACME-12"));
  assert.ok(!keysIn("xacme-12").includes("ACME-12"));
  const map = issueWorkspaces({ workspaces: [{ id: "w", title: "W", archived: false, prs: [pr("acme-123-x")] }], links: [] });
  assert.equal(holderOf(map, "ACME-12"), null);
  assert.equal(holderOf(map, "ACME-123")?.workspaceId, "w");
});

test("between two holders of the same kind, the most recently active wins", () => {
  const map = issueWorkspaces({ workspaces: [
    { id: "a", title: "A", archived: false, activityAt: "2026-11-20T00:00:00.000Z", prs: [pr("acme-5-a")] },
    { id: "b", title: "B", archived: false, activityAt: "2026-11-22T00:00:00.000Z", prs: [pr("acme-5-b")] },
  ], links: [] });
  assert.equal(holderOf(map, "ACME-5")?.workspaceId, "b");
});

test("New suggests only the free issue; the taken ones fold, naming their workspace, and agents read the same split", async t => {
  const directory = await mkdtemp(join(tmpdir(), "taken-issues-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const map = issueWorkspaces(input);
  let lookups = 0;
  const service = new DispatchService({
    store: testStore(DispatchStore, directory),
    linear: { list: async () => ({ status: "ok", at: NOW, more: false, issues: [issue("ACME-12", "Plan the retries"), issue("ACME-13", "Retry failed charges"), issue("ACME-14", "Export the audit log")] }), get: async () => null, search: async () => ({ status: "ok", at: NOW, more: false, issues: [] }) },
    projects: async () => [{ id: "web", name: "web", repo: "acme/web", worktree: true, path: "/work/web" }],
    learned: async () => ({}),
    existing: async () => { lookups++; return null; },
    taken: async () => new Map([...map].map(([k, h]) => [k, { ...h, projectId: "web" }])),
    defaultBase: async () => "main",
    agent: async () => ({ config: {}, label: "Claude" }),
    multiplicity: async () => true,
    paseo: async () => null,
    now: () => NOW,
  });
  t.after(() => service.stop());
  const sources = await service.sources() as DispatchSources;
  assert.equal(lookups, 0, "one map per list read, never a lookup per issue");
  assert.deepEqual(sources.taken, ["ACME-12", "ACME-13"]);
  assert.equal(sources.routes["ACME-13"].existing?.workspaceId, "retry");
  const { rows, selected } = newRows(sources, "", NOW);
  assert.deepEqual(rows.map(r => r.id), ["ACME-14", "taken"]);
  assert.equal(selected, "ACME-14");
  const open = newRows(sources, "", NOW, true).rows.filter(r => r.kind === "issue" && r.taken);
  assert.deepEqual(open.map(r => r.kind === "issue" && [r.key, r.route.text]), [["ACME-12", "Q4 planning · running"], ["ACME-13", "Retry failed charges · running"]]);
});

test("all taken: the list says so in one line, never a blank pane", () => {
  const sources = { linear: { status: "ok" as const, at: NOW, more: false, issues: [issue("ACME-12", "Plan")] }, routes: { "ACME-12": { project: "web", guess: false, existing: { workspaceId: "plan", title: "Q4 planning", state: "tracked" } } } };
  const { rows, selected, empty } = newRows(sources, "", NOW);
  assert.equal(empty, "Nothing new to start.", "the fold right under it says how many");
  assert.deepEqual(rows.map(r => r.id), ["taken"]);
  assert.equal(selected, null);
});

test("every surface reads the one predicate: dispatch's existing, New's list, the queue's raised issues", async () => {
  const server = await readFile(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
  assert.match(server, /return holderOf\(await takenIssues\(\), source\.key\);/, "dispatch's existing (paste and preview)");
  assert.match(server, /taken: takenIssues,/, "New's list");
  assert.match(server, /workspaces: issueHolders,/, "the queue: raised issues, the brief's Since block, the queue screen");
  assert.doesNotMatch(server, /i\.kind === "linear" && i\.key === /, "no surface matches a linked key its own way");
  // raisedNeeds reads the queue's map, so a PR-named issue is no raised Needs-you item either.
  assert.match(await readFile(join(import.meta.dirname, "..", "server", "linear-queue.ts"), "utf8"), /raisedNeeds\(file, key => workspaces\.has\(key\)\)/);
  assert.equal(typeof raisedNeeds, "function");
});
