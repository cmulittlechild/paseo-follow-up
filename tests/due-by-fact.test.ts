import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dueByAgent, dueLabel, isStale, maintainTasks, nudgeLine, pickNudges, pruneBlocked, RECHECK_DAYS, taskDue, type DueEntry } from "../shared/task-due";
import { taskSchedule } from "../shared/task-trigger";
import { updateObligation } from "../server/obligations";
import { scopes } from "../server/scopes";
import { AgentHooks } from "../server/agent-hooks";
import { INVARIANTS } from "../shared/status-invariants";
import type { Obligation, State } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * 2026-11-22, live: 104 open tasks, half unchanged for over 5 days. 35 had every PR merged (22 deployed): post-deploy
 * checks that came due and never ran, because the tool text said tasks are manual unless the developer asked for
 * timing. Invariant due-by-fact: every open task knows what moves it, a due task is a capped nudge to its owner at the
 * turn's end (zero words when nothing is due), and nothing closes without the agent's evidence.
 */
const DAY = 86_400_000;
const NOW = clock;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (patch: Partial<Obligation> = {}): Obligation => ({ id: "t1", title: "Check alert emails in staging", status: "pending", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, ...patch });
const merged = (daysAgo: number, extra = {}) => pr({ snapshot: snapshot({ state: "MERGED", mergedAt: iso(NOW - daysAgo * DAY), mergeCommit: "m1", ...extra }) });

test("due-by-fact: what moves a task, and when it is due", () => {
  // No PRs: the re-check date.
  const later = taskDue(task({ recheckAt: iso(NOW + 2 * DAY) }), workspace(), NOW)!;
  assert.equal(later.due, false); assert.match(later.label, /^Re-check [A-Z][a-z]{2} \d+$/);
  const passed = taskDue(task({ recheckAt: iso(NOW - 1) }), workspace(), NOW)!;
  assert.equal(passed.due, true); assert.match(passed.label, /^Due since [A-Z][a-z]{2} \d+$/);
  assert.equal(taskDue(task({ recheckAt: "2025-12-20T00:00:00Z" }), workspace(), NOW)!.label, "Due since Dec 20, 2025", "a date in another year says the year");
  // PRs: merged (stage merged), deployed (anchor), a repository with no deploy target, closed unmerged, still open.
  const w = (p = merged(1)) => workspace({ prs: [p] });
  assert.equal(taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "merged" }), w(), NOW)!.label, "Due · #1 merged");
  assert.equal(taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "deployed" }), w({ ...merged(2), deploymentAnchor: { mergeCommit: "m1", at: iso(NOW - DAY) } }), NOW)!.label, "Due · #1 deployed");
  assert.equal(taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "deployed" }), w(), NOW)!.label, "Due · #1 merged (no deploy check)");
  assert.equal(taskDue(task({ afterPrs: ["example/app#1"] }), w(pr({ snapshot: snapshot({ state: "CLOSED" }) })), NOW)!.label, "Due · #1 closed unmerged");
  assert.deepEqual(taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "merged" }), w(pr()), NOW), { key: "", fact: "", dueAt: null, due: false, label: "After #1 merges" });
  // A later re-check holds a PR-made fact, with a new key so the nudge count starts again.
  const held = taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "merged", recheckAt: iso(NOW + DAY) }), w(), NOW)!;
  assert.equal(held.due, false); assert.match(held.label, /^#1 merged · re-check /); assert.notEqual(held.key, taskDue(task({ afterPrs: ["example/app#1"], dependencyStage: "merged" }), w(), NOW)!.key);
  // Left out: finished, blocked on the developer (Needs you), a developer-timed trigger (it is sent as a message).
  assert.equal(taskDue(task({ status: "done", recheckAt: iso(NOW - DAY) }), workspace(), NOW), null);
  assert.equal(taskDue(task({ status: "blocked", ask: "May I drop the old table?", recheckAt: iso(NOW - DAY) }), workspace(), NOW), null);
  assert.equal(taskDue(task({ enable_follow_up: true, trigger: { event: "now", delayDays: 0 }, recheckAt: iso(NOW - DAY) }), workspace(), NOW), null);
  // The row never says Manual: it says what moves the task.
  assert.equal(taskSchedule(task({ recheckAt: iso(NOW - 1) }), workspace(), NOW).label.startsWith("Due since "), true);
  assert.equal(taskSchedule(task({ afterPrs: ["example/app#1"], dependencyStage: "merged" }), w(pr()), NOW).label, "After #1 merges");
});

test("due-by-fact: every open task gets a re-check date, the agent can set its own, and finishing records when", () => {
  const w = workspace({ prs: [pr()] });
  const a = updateObligation(w, { title: "Watch the next nightly roll-up", status: "pending", now: NOW });
  assert.equal(a.recheckAt, iso(NOW + RECHECK_DAYS * DAY), "3 days by default");
  const b = updateObligation(w, { id: a.id, title: a.title, status: "pending", recheck: "2026-01-10", now: NOW });
  assert.equal(b.recheckAt, "2026-01-10T00:00:00.000Z"); assert.equal(b.revision, 1, "a new re-check is a change: it answers a nudge");
  updateObligation(w, { id: a.id, title: a.title, status: "pending", now: NOW + DAY });
  assert.equal(a.recheckAt, "2026-01-10T00:00:00.000Z", "an update keeps a re-check date still ahead");
  updateObligation(w, { id: a.id, title: a.title, status: "pending", now: Date.parse("2026-01-11T00:00:00Z") });
  assert.equal(a.recheckAt, "2026-01-14T00:00:00.000Z", "a passed one moves 3 days past the update");
  const c = updateObligation(w, { title: "Verify the export after deploy", status: "waiting", afterPrs: ["example/app#1"], now: NOW });
  assert.equal(c.recheckAt, undefined, "a task with PRs is moved by its PRs");
  assert.throws(() => updateObligation(w, { id: a.id, title: a.title, status: "pending", recheck: "next week", now: NOW }), /recheck is a date/);
  updateObligation(w, { id: a.id, title: a.title, status: "done", evidence: "Roll-up ran clean.", now: NOW + 2 * DAY });
  assert.equal(a.finishedAt, iso(NOW + 2 * DAY)); assert.equal(a.recheckAt, undefined);
  updateObligation(w, { id: a.id, title: a.title, status: "pending", now: NOW + 3 * DAY });
  assert.equal(a.finishedAt, undefined, "reopened");
});

test("due-by-fact: at most 3 a turn end, each at most twice and once a day; zero words when nothing is due", () => {
  const entry = (id: string, dueDaysAgo: number, revision = 0): DueEntry => ({ id, key: `recheck:${id}`, revision, dueAt: iso(NOW - dueDaysAgo * DAY), line: `line ${id}` });
  const entries = [entry("a", 1), entry("b", 4), entry("c", 3), entry("d", 2)];
  assert.deepEqual(pickNudges([{ ...entry("future", 0), dueAt: iso(NOW + DAY) }], {}, NOW).lines, [], "never one not due yet");
  const first = pickNudges(entries, {}, NOW);
  assert.deepEqual(first.lines, ["line b", "line c", "line d"], "oldest first, at most 3");
  assert.deepEqual(pickNudges([], {}, NOW).lines, [], "clean: nothing");
  const sameDay = pickNudges(entries, first.receipt, NOW + 3_600_000);
  assert.deepEqual(sameDay.lines, ["line a"], "once a day per task");
  const second = pickNudges(entries, sameDay.receipt, NOW + DAY + 1);
  assert.deepEqual(second.lines, ["line b", "line c", "line d"]);
  const third = pickNudges(entries, second.receipt, NOW + 3 * DAY);
  assert.deepEqual(third.lines, ["line a"], "b, c, d had their two; a has one left");
  assert.deepEqual(pickNudges(entries, third.receipt, NOW + 5 * DAY).lines, [], "two each, then stale: no third");
  const changed = pickNudges([entry("b", 4, 1)], third.receipt, NOW + 5 * DAY);
  assert.deepEqual(changed.lines, ["line b"], "the agent changed the task: a new count");
  assert.equal(changed.receipt.b.count, 1);
});

test("due-by-fact: the hook's copy of pickNudges picks the same", async () => {
  process.env.FOLLOW_UP_HOOK_IMPORT = "1";
  const path = "../server/agent-hook.mjs";
  const hook = await import(path) as { pickNudges: typeof pickNudges };
  const entries: DueEntry[] = ["a", "b", "c", "d"].map((id, i) => ({ id, key: `k${id}`, revision: i, dueAt: iso(NOW - i * DAY), line: id }));
  for (const receipt of [{}, pickNudges(entries, {}, NOW).receipt, pickNudges(entries, pickNudges(entries, {}, NOW).receipt, NOW + 2 * DAY).receipt])
    for (const at of [NOW, NOW + DAY / 2, NOW + 2 * DAY, NOW + 9 * DAY]) assert.deepEqual(hook.pickNudges(entries, receipt, at), pickNudges(entries, receipt, at));
});

test("due-by-fact: two unanswered nudges make a task stale, still listed and never closed for the agent", () => {
  const w = workspace({ prs: [merged(3)], obligations: [task({ afterPrs: ["example/app#1"], dependencyStage: "merged", revision: 2 })] });
  const o = w.obligations[0];
  const d = taskDue(o, w, NOW)!;
  const receipt = { [o.id]: { key: d.key, revision: 2, count: 2, at: iso(NOW - DAY) } };
  assert.equal(maintainTasks(w, NOW, receipt, false), true); assert.equal(o.nudged, undefined, "a check changes nothing");
  maintainTasks(w, NOW, receipt, true);
  assert.equal(isStale(o, d), true); assert.equal(dueLabel(o, w, NOW), "Stale · #1 merged · nudged twice, no answer");
  assert.equal(o.status, "pending", "never done for the agent");
  assert.deepEqual(dueByAgent(w, NOW), {}, "a stale task isn't nudged a third time");
  o.revision = 3;
  assert.equal(isStale(o, d), false, "the agent touched it: no longer stale");
});

test("due-by-fact: scopes.json lists each agent's due tasks; the worker's pass stamps old tasks and prunes finished ones", () => {
  const w = workspace({ contributorAgentIds: ["helper"], prs: [merged(1)], obligations: [
    task({ id: "mine", afterPrs: ["example/app#1"], dependencyStage: "merged" }),
    task({ id: "helped", workingAgentId: "helper", recheckAt: iso(NOW + DAY) }),
    task({ id: "clean", afterPrs: ["example/app#1"], status: "done", evidence: "ok", finishedAt: iso(NOW - 31 * DAY) }),
  ] });
  const entries = scopes({ version: 1, workspaces: [w] } as unknown as State, undefined, NOW);
  assert.deepEqual(entries["main-agent"].due?.map(e => e.id), ["mine", "helped"]);
  assert.deepEqual(entries.helper.due?.map(e => e.id), ["helped"], "the contributor working on it, and the main agent");
  assert.equal(entries["main-agent"].due![0].line, nudgeLine(w.obligations[0], taskDue(w.obligations[0], w, NOW)!));
  assert.match(entries["main-agent"].due![0].line, /^Task mine "Check alert emails in staging": #1 merged\. Do it and close it with evidence, or keep it with recheck="YYYY-MM-DD" and why\.$/);
  const clean = workspace({ obligations: [task({ status: "done", evidence: "ok" })] });
  assert.equal(scopes({ version: 1, workspaces: [clean] } as unknown as State, undefined, NOW)["main-agent"].due, undefined, "zero words when clean");
  // The pass: an old open task gets its re-check, an old finished one its finishedAt, and one over 30 days leaves.
  const legacy = workspace({ declaration: { at: iso(NOW) } as never, obligations: [task({ id: "open" }), task({ id: "fin", status: "waived", evidence: "x" }), w.obligations[2]] });
  maintainTasks(legacy, NOW, null, true);
  assert.equal(legacy.obligations.find(o => o.id === "open")!.recheckAt, iso(NOW + 3 * DAY));
  assert.equal(legacy.obligations.find(o => o.id === "fin")!.finishedAt, iso(NOW));
  assert.deepEqual(legacy.obligations.map(o => o.id), ["open", "fin"]);
  assert.equal(maintainTasks(legacy, NOW, null, false), false, "settled");
  // Still read: every task finished and the workspace not declared done (the completion batch lists every task), or
  // an open question names it.
  const undeclared = workspace({ obligations: [w.obligations[2]] });
  assert.equal(pruneBlocked(undeclared, "clean"), true); maintainTasks(undeclared, NOW, null, true); assert.equal(undeclared.obligations.length, 1);
  const asked = workspace({ declaration: { at: iso(NOW) } as never, obligations: [task({ id: "open" }), w.obligations[2]], questions: [{ id: "Q1", taskId: "clean", question: "?", answer: null, closed: null } as never] });
  assert.equal(pruneBlocked(asked, "clean"), true);
});

test("due-by-fact: the status invariant catches a due task that doesn't say so", () => {
  const inv = INVARIANTS.find(i => i.id === "due-by-fact")!;
  const w = workspace({ prs: [merged(1)], obligations: [task({ afterPrs: ["example/app#1"], dependencyStage: "merged" })] });
  assert.equal(inv.check(w, NOW), null);
  assert.equal(inv.check(workspace({ obligations: [task({ recheckAt: iso(NOW + DAY) })] }), NOW), null);
});

test("due-by-fact: the Stop hook names due tasks once per turn and says nothing when none is due", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-due-"));
  try {
    const hooks = new AgentHooks(directory, "/fixture/client.js", [join(directory, "claude/settings.json"), join(directory, "codex/hooks.json")]);
    await mkdir(join(directory, "claude"));
    await hooks.start();
    const w = workspace({ prs: [merged(1)], obligations: [task({ afterPrs: ["example/app#1"], dependencyStage: "merged" })] });
    const write = (state: State, now = NOW) => writeFile(join(directory, "scopes.json"), JSON.stringify({ version: 1, agents: scopes(state, undefined, now) }));
    const run = async (event: Record<string, unknown>) => {
      const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, PASEO_AGENT_ID: w.mainAgentId, FOLLOW_UP_RECOVERY: "", FOLLOW_UP_HOOK_IMPORT: "" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", c => { output += c; });
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); child.stdin.end(JSON.stringify({ session_id: "s", ...event })); });
      return output ? JSON.parse(output) : null;
    };
    const turn = async () => {
      await run({ hook_event_name: "UserPromptSubmit", prompt: "go" });
      await mkdir(join(directory, "hook-state"), { recursive: true });
      await writeFile(join(directory, "hook-state", `sync-${w.mainAgentId}.json`), JSON.stringify({ workspaceId: w.id, at: Date.now() + 60_000 }));
      return run({ hook_event_name: "Stop" });
    };
    await write({ version: 1, workspaces: [workspace({ obligations: [] })] } as unknown as State);
    assert.equal(await turn(), null, "nothing due: zero words");
    // The real clock: scopes' due time is a day before now.
    await write({ version: 1, workspaces: [w] } as unknown as State, Date.now());
    const blocked = await turn();
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /^Follow-up: these tasks are due\./);
    assert.match(blocked.reason, /- Task t1 "Check alert emails in staging": #1 merged\./);
    assert.doesNotMatch(blocked.reason, /bookkeeping/, "synced: only the due line");
    const receipt = JSON.parse(await readFile(join(directory, "hook-state", `task-nudges-${w.id}.json`), "utf8"));
    assert.equal(receipt.t1.count, 1);
    assert.equal(await turn(), null, "named once a day at most");
    await hooks.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
