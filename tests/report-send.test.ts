import test from "node:test";
import assert from "node:assert/strict";
import { NEW_AGENT, NEW_WORKSPACE, defaultChoice, pickerRows, reportWorkspaceTitle, type SendTargets } from "../shared/report-send";
import { newWorkspaceTarget, sendReport, type ReportSendDeps } from "../server/report-send";
import { AgentActions, AGENT_TOOLS, PLANNED_TOOLS, type AgentActionDeps } from "../server/agent-actions";
import { PARITY } from "../server/agent-parity";
import { actionTools } from "../server/mcp.mjs";
import type { DirectoryRows } from "../server/directory";
import type { State } from "../shared/model";

/**
 * Report an issue's Send to (2026-11-15). On a phone the picker showed about six agents; the rest, and "A new agent"
 * drawn after them, couldn't be reached (the scroll half is tests/sheet-scroll.test.ts). The developer also wants the
 * report to start in a new workspace. The "new" rows come first and stay pinned above the scrolling agents, the
 * default pick doesn't change, and an agent can do the same through report_send (dry run, then confirm).
 */
const agent = (id: string, workspace: string, main = true) => ({ id, title: main ? "Main" : "Helper", provider: "claude", status: "idle", workspaceId: `ws-${workspace}`, workspaceTitle: workspace, main });
const targets = (over: Partial<SendTargets> = {}): SendTargets => ({
  agents: ["Billing retries", "Saved views", "Audit log export", "Webhook signing", "Search ranking", "Invoice PDFs", "Rate limits", "Team invites"].map((w, i) => agent(`a${i}`, w)),
  defaultId: "a0", newAgentWorkspace: { id: "ws-Billing retries", title: "Billing retries" }, newWorkspace: { projectId: "p1", title: "example/app" }, ...over,
});

test("the new rows come first and are pinned above the scrolling agents, so a phone reaches them without scrolling", () => {
  const rows = pickerRows(targets());
  assert.deepEqual(rows.pinned.map(r => r.id), [NEW_WORKSPACE, NEW_AGENT]);
  assert.deepEqual(rows.pinned.map(r => r.lines), [
    ["A new workspace", "In example/app, with the default model"],
    ["A new agent in Billing retries", "Starts there, with the default model"],
  ]);
  assert.equal(rows.agents.length, 8, "every agent is in the scrolling list");
  assert.ok(!rows.agents.some(r => r.id === NEW_AGENT || r.id === NEW_WORKSPACE));
  assert.deepEqual(rows.agents[0].lines, ["Billing retries · main agent", "Claude Code · idle"]);
});

test("each new row shows only when it can start: no project, no new workspace; no workspace, no new agent", () => {
  assert.deepEqual(pickerRows(targets({ newWorkspace: null })).pinned.map(r => r.id), [NEW_AGENT]);
  assert.deepEqual(pickerRows(targets({ newAgentWorkspace: null })).pinned.map(r => r.id), [NEW_WORKSPACE]);
  // A server from before this change sends no newWorkspace at all.
  const { newWorkspace: _n, ...old } = targets();
  assert.deepEqual(pickerRows(old as SendTargets).pinned.map(r => r.id), [NEW_AGENT]);
});

test("the default pick is today's: the best agent, else a new agent; never a new workspace on its own", () => {
  assert.equal(defaultChoice(targets()), "a0");
  assert.equal(defaultChoice(targets({ agents: [], defaultId: null })), NEW_AGENT);
  assert.equal(defaultChoice(targets({ agents: [], defaultId: null, newAgentWorkspace: null })), null);
});

test("the workspace title is the kind and the report's first words, at most 60 characters, cut at a word", () => {
  assert.equal(reportWorkspaceTitle("bug", "Send to list won't scroll on my phone. Only six agents show."), "Bug: Send to list won't scroll on my phone");
  assert.equal(reportWorkspaceTitle("feature", "Start the report in a new workspace"), "Idea: Start the report in a new workspace");
  const long = reportWorkspaceTitle("feedback", "The Needs you card is great but the stack bar colours are hard to tell apart in dark mode at night");
  assert.ok(long.length <= 60, `${long.length}: ${long}`);
  assert.match(long, /^Feedback: The Needs you card is great but the stack bar\w*…$/);
  assert.ok(!/ …$/.test(long), "never a space before the ellipsis");
  assert.equal(reportWorkspaceTitle("bug", "  ", "Send repairs didn't work: GitHub HTTP 502"), "Bug: Send repairs didn't work: GitHub HTTP 502", "the error when nothing was typed");
  assert.equal(reportWorkspaceTitle("bug", "line one\nline two"), "Bug: line one");
  assert.equal(reportWorkspaceTitle("bug", ""), "Bug report");
  assert.equal(reportWorkspaceTitle("bug", "x".repeat(200)).length, 60, "one long word is cut hard");
});

const rows = (multi = true): DirectoryRows => ({
  agents: [],
  workspaces: [{ id: "ws-1", name: "Billing retries", projectId: "p1" }, { id: "ws-2", name: "Scratch", projectId: null }],
  projects: [{ projectId: "p1", projectKey: "k", projectDisplayName: "example/app", projectRootPath: "/home/user/app", projectKind: "git" }],
  ...(multi ? {} : {}),
});

test("the new workspace starts in the sheet's workspace's project; none without a project or without the host feature", () => {
  assert.deepEqual(newWorkspaceTarget(rows(), "ws-1", true), { projectId: "p1", title: "example/app" });
  assert.equal(newWorkspaceTarget(rows(), "ws-2", true), null, "a workspace with no project");
  assert.equal(newWorkspaceTarget(rows(), null, true), null);
  // A directory workspace shares its project's root with every other one there: Paseo allows that only with
  // features.workspaceMultiplicity, so without it the option is hidden (the reason lives here and in the docs).
  assert.equal(newWorkspaceTarget(rows(), "ws-1", false), null);
});

function sendDeps(over: Partial<ReportSendDeps> = {}) {
  const log: string[] = [];
  const deps: ReportSendDeps = {
    rows: async () => rows(), multiplicity: async () => true, provider: async () => ({ provider: "claude" }) as never,
    sendTo: async (agentId, prompt) => { log.push(`send ${agentId}: ${prompt.split("\n")[0]}`); },
    agentTitle: async () => "Billing retries · main",
    paseo: {
      workspaces: {
        create: async (o: { title?: string; source: unknown }) => { log.push(`workspace ${o.title} ${JSON.stringify(o.source)}`); return { id: "ws-new", archive: async () => ({}), agents: { create: async (a: { title?: string; prompt?: string }) => { log.push(`agent ${a.title}: ${a.prompt?.split("\n")[0]}`); return { id: "agent-new" }; } } }; },
        ref: (id: string) => ({ agents: { create: async (a: { title?: string }) => { log.push(`agent in ${id}: ${a.title}`); return { id: "agent-2" }; } } }),
      },
    } as never,
    ...over,
  };
  return { deps, log };
}

test("A new workspace: a directory workspace on the project's root with its projectId, then an agent there with the report", async () => {
  const { deps, log } = sendDeps();
  const out = await sendReport(deps, { kind: "bug", text: "Send to list won't scroll on my phone.", error: null, newWorkspaceProjectId: "p1" });
  assert.deepEqual(out, { agentId: "agent-new", title: "Bug: Send to list won't scroll on my phone", started: true, workspaceId: "ws-new" });
  assert.deepEqual(log, [
    `workspace Bug: Send to list won't scroll on my phone {"kind":"directory","path":"/home/user/app","projectId":"p1"}`,
    "agent Report a Follow-up bug: Report a bug about Follow-up for me: Send to list won't scroll on my phone.",
  ]);
});

test("A new workspace refuses up front when the project is gone or the host can't share a root", async () => {
  await assert.rejects(sendReport(sendDeps().deps, { kind: "bug", text: "x", newWorkspaceProjectId: "p9" }), /project isn't available/);
  await assert.rejects(sendReport(sendDeps({ multiplicity: async () => false }).deps, { kind: "bug", text: "x", newWorkspaceProjectId: "p1" }), /can't start another workspace/);
});

test("A new workspace whose agent can't start is archived again, so a retry never piles up empty workspaces", async () => {
  const archived: string[] = [];
  const { deps } = sendDeps({ paseo: { workspaces: {
    create: async () => ({ id: "ws-new", archive: async () => { archived.push("ws-new"); return {}; }, agents: { create: async () => { throw new Error("Provider 'claude' is disabled"); } } }),
    ref: () => { throw new Error("unused"); },
  } } as never });
  await assert.rejects(sendReport(deps, { kind: "bug", text: "x", newWorkspaceProjectId: "p1" }), /Provider 'claude' is disabled/);
  assert.deepEqual(archived, ["ws-new"]);
});

test("the agent and new-agent paths are unchanged", async () => {
  const a = sendDeps();
  assert.deepEqual(await sendReport(a.deps, { kind: "bug", text: "x", agentId: "a0" }), { agentId: "a0", title: "Billing retries · main", started: false });
  const b = sendDeps();
  assert.deepEqual(await sendReport(b.deps, { kind: "feature", text: "x", newAgentWorkspaceId: "ws-1" }), { agentId: "agent-2", title: "Follow-up feature request", started: true });
  await assert.rejects(sendReport(b.deps, { kind: "bug", text: "x" }), /Pick an agent/);
});

test("agent parity: report_send hands a report to an agent or a new workspace, planned like the sheet's Send", async () => {
  assert.ok((AGENT_TOOLS as readonly string[]).includes("report_send"));
  assert.ok(PLANNED_TOOLS.includes("report_send" as never));
  const tuple = (actionTools as unknown as [string, string, string, Record<string, unknown>, string[]][]).find(t => t[0] === "report_send");
  assert.ok(tuple && "newWorkspaceProjectId" in tuple[3], "the bridge takes the new-workspace target");
  const entry = PARITY["follow.report-issue-send"];
  assert.ok("tools" in entry && entry.tools.includes("report_send"));

  const calls: { method: string; input: unknown }[] = [];
  const agent = new AgentActions({
    store: { snapshot: async () => ({ version: 1, workspaces: [] }) as unknown as State, mutate: async () => undefined },
    prActions: {} as AgentActionDeps["prActions"], engine: {} as AgentActionDeps["engine"],
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async () => undefined },
    rpc: { validate: async (_m: string, input: unknown) => input, call: async (method: string, input: unknown) => { calls.push({ method, input }); return { method }; } },
  } as unknown as AgentActionDeps);
  const plan = await agent.run("overseer", "report_send", { kind: "bug", text: "Picker won't scroll", newWorkspaceProjectId: "p1" }) as { dryRun: boolean; planId: string; change: unknown; before: unknown };
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.change, { kind: "bug", text: "Picker won't scroll", newWorkspaceProjectId: "p1" });
  assert.deepEqual(calls.map(c => c.method), ["follow.report-issue-targets"], "the dry run only reads where it could go");
  await agent.run("overseer", "report_send", { confirm: true, planId: plan.planId });
  assert.deepEqual(calls.at(-1), { method: "follow.report-issue-send", input: { kind: "bug", text: "Picker won't scroll", newWorkspaceProjectId: "p1" } });
  await assert.rejects(agent.run("overseer", "report_send", { kind: "bug", text: "x" }), /one target/);
  await assert.rejects(agent.run("overseer", "report_send", { kind: "bug", text: "x", agentId: "a0", newWorkspaceProjectId: "p1" }), /one target/);
  await assert.rejects(agent.run("overseer", "report_send", { kind: "bug", text: "x", agentId: "overseer" }), /report_issue/);
});
