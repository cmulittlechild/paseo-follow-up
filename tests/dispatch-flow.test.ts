import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, testStore } from "./support/store-temp-dir";
import { DispatchService, DispatchStore, type DispatchDeps, type DispatchPaseo, type DispatchProject } from "../server/dispatch";
import { RETRY_MS, UNDO_WINDOW_MS } from "../shared/dispatch";
import type { LinearIssue } from "../shared/linear-issues";
import { AgentActions } from "../server/agent-actions";

// New's dispatch against a fake Paseo (never the live daemon): a-failed-dispatch-leaves-nothing-behind,
// dispatch-needs-a-click-or-a-confirmed-plan, a queued dispatch waits for Paseo, a restart never re-runs a create blind.
// Fixtures are fictional (ACME, acme/web, example/app).

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const issue: LinearIssue = {
  id: "u-142", key: "ACME-142", title: "Retry failed charges", state: "In Progress", stateType: "started", priority: { value: 2, name: "High" },
  updatedAt: "2026-11-20T09:00:00.000Z", team: "ACME", teamName: "Acme Web", url: "https://linear.app/acme/issue/ACME-142", assigneeIsMe: true,
  branchName: "alice/acme-142-retry-failed-charges", description: "Charges that fail are never retried.",
};
const projects: DispatchProject[] = [
  { id: "web", name: "web", repo: "acme/web", worktree: true, path: "/work/web" },
  { id: "app", name: "app", repo: "example/app", worktree: true, path: "/work/app" },
];

type Fake = {
  paseo: DispatchPaseo; creates: Record<string, unknown>[]; agents: Record<string, unknown>[]; archived: string[];
  failCreate: Error | null; failAgent: Error | null; failArchive: boolean;
};
function fakePaseo(): Fake {
  const f: Fake = {
    creates: [], agents: [], archived: [], failCreate: null, failAgent: null, failArchive: false,
    paseo: {
      workspaces: {
        create: async o => {
          if (f.failCreate) throw f.failCreate;
          f.creates.push(o);
          const id = `ws-${f.creates.length}`;
          return { id, agents: { create: async a => { if (f.failAgent) throw f.failAgent; f.agents.push(a); return { id: `agent-${f.agents.length}` }; } } };
        },
        archive: async id => { if (f.failArchive) throw new Error("refused"); f.archived.push(id); },
      },
    },
  };
  return f;
}

async function setup(t: TestContext, over: Partial<DispatchDeps> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = fakePaseo();
  const clock = { now: T0 };
  let up = true;
  const linearCalls: string[] = [];
  const deps: DispatchDeps = {
    store: testStore(DispatchStore, directory),
    linear: {
      list: async () => { linearCalls.push("list"); return { status: "ok", issues: [issue], at: clock.now, more: false }; },
      get: async key => { linearCalls.push(`get ${key}`); return key === issue.key ? issue : null; },
      search: async () => { linearCalls.push("search"); return { status: "ok", issues: [], at: clock.now, more: false }; },
    },
    projects: async () => projects,
    learned: async () => ({}),
    existing: async () => null,
    defaultBase: async () => "main",
    agent: async () => ({ config: { provider: "claude" }, label: "Claude" }),
    multiplicity: async () => true,
    paseo: async () => (up ? fake.paseo : null),
    now: () => clock.now,
    ...over,
  };
  const service = new DispatchService(deps);
  t.after(() => service.stop());
  return { service, fake, clock, deps, linearCalls, down: () => { up = false; }, upAgain: () => { up = true; } };
}

test("a dispatch records, replies, then creates the worktree and starts the agent with the rendered instructions", async t => {
  const { service, fake, clock } = await setup(t);
  const { record } = await service.dispatch({ source: "ACME-142", projectId: "web" });
  assert.equal(record.state, "queued");
  assert.equal(record.prompt, null, "a reply never carries the prompt");
  await service.settle();
  assert.equal(fake.creates.length, 1);
  assert.deepEqual(fake.creates[0], {
    title: "ACME-142 Retry failed charges",
    source: { kind: "worktree", projectId: "web", action: "branch-off", baseBranch: "main", branchName: "alice/acme-142-retry-failed-charges" },
  });
  assert.match(String(fake.agents[0].prompt), /ACME-142/);
  assert.match(String(fake.agents[0].prompt), /Charges that fail are never retried\./);
  const [done] = await service.records();
  assert.deepEqual([done.state, done.workspaceId, done.agentId, done.prompt], ["created", "ws-1", "agent-1", null]);
  assert.equal(done.undoUntil, new Date(clock.now + UNDO_WINDOW_MS).toISOString());
  // The pick for a team with no rule is saved: asked once per team.
  assert.deepEqual((await service.settings()).rules, [{ team: "ACME", projectId: "web", project: "web" }]);
});

test("an agent that can't start archives the workspace just created, and the record says nothing is left", async t => {
  const { service, fake } = await setup(t);
  fake.failAgent = new Error("Provider claude isn't available.");
  await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  assert.deepEqual(fake.archived, ["ws-1"]);
  const [r] = await service.records();
  assert.deepEqual([r.state, r.error, r.workspaceId], ["failed", "Provider claude isn't available.", null]);
  assert.match(r.leftBehind!, /archived again; nothing is left behind/);
});

test("an archive that fails too says where the workspace is", async t => {
  const { service, fake } = await setup(t);
  fake.failAgent = new Error("no agent");
  fake.failArchive = true;
  await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  const [r] = await service.records();
  assert.equal(r.workspaceId, "ws-1");
  assert.match(r.leftBehind!, /archive it from Paseo's sidebar/);
});

test("a workspace Paseo refuses leaves nothing and isn't retried", async t => {
  const { service, fake } = await setup(t);
  fake.failCreate = new Error("Branch name is invalid.");
  await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  const [r] = await service.records();
  assert.deepEqual([r.state, r.leftBehind, r.nextTryAt], ["failed", "Nothing was created.", null]);
  assert.equal(fake.agents.length, 0);
});

test("Paseo down: the dispatch waits, retries on its schedule, and starts once Paseo is back", async t => {
  const { service, fake, clock, down, upAgain } = await setup(t);
  down();
  await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  let [r] = await service.records();
  assert.deepEqual([r.state, r.step, r.attempts], ["queued", "Waiting for Paseo", 1]);
  assert.equal(r.nextTryAt, new Date(T0 + RETRY_MS[0]).toISOString());
  // Not due yet: nothing runs.
  await service.retryDue();
  await service.settle();
  assert.equal(fake.creates.length, 0);
  // Due, still down, then a create that can't connect: it stays queued with a longer wait.
  clock.now += RETRY_MS[0];
  upAgain();
  fake.failCreate = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6767"), { code: "ECONNREFUSED" });
  await service.retryDue();
  await service.settle();
  [r] = await service.records();
  assert.deepEqual([r.state, r.attempts], ["queued", 2]);
  assert.equal(r.nextTryAt, new Date(clock.now + RETRY_MS[1]).toISOString());
  clock.now += RETRY_MS[1];
  fake.failCreate = null;
  await service.retryDue();
  await service.settle();
  [r] = await service.records();
  assert.equal(r.state, "created");
  assert.equal(fake.creates.length, 1);
  assert.match(String(fake.agents[0].prompt), /ACME-142/, "the prompt survives the wait");
});

test("a queued dispatch can be cancelled; a created one can't", async t => {
  const { service, fake, down } = await setup(t);
  down();
  const { dispatchId } = await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  assert.equal((await service.cancel(dispatchId)).state, "cancelled");
  await service.retryDue();
  await service.settle();
  assert.equal(fake.creates.length, 0);
  await assert.rejects(service.cancel(dispatchId), /Only a dispatch waiting for Paseo/);
});

test("Undo archives within 10 minutes, and not after", async t => {
  const { service, fake, clock } = await setup(t);
  const first = await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  assert.equal((await service.undo(first.dispatchId)).state, "undone");
  assert.deepEqual(fake.archived, ["ws-1"]);
  await assert.rejects(service.undo(first.dispatchId), /Already undone/);
  const second = await service.dispatch({ source: "Export invoices as CSV", projectId: "app" });
  await service.settle();
  clock.now += UNDO_WINDOW_MS + 1;
  await assert.rejects(service.undo(second.dispatchId), /10 minutes/);
  assert.deepEqual(fake.archived, ["ws-1"]);
});

test("a restart mid-create fails the dispatch with what to check, and never creates again", async t => {
  const { service, fake, deps } = await setup(t);
  const one = await service.dispatch({ source: "ACME-142", projectId: "web" });
  await service.settle();
  await deps.store.mutate(f => { f.records[one.dispatchId] = { ...f.records[one.dispatchId], state: "starting", workspaceId: "ws-1", prompt: "x" }; });
  const restarted = new DispatchService(deps);
  t.after(() => restarted.stop());
  await restarted.start();
  await restarted.settle();
  const [r] = await restarted.records();
  assert.equal(r.state, "failed");
  assert.match(r.error!, /restarted/);
  assert.match(r.leftBehind!, /Paseo's sidebar/);
  assert.equal(fake.creates.length, 1);
});

test("a PR link checks out the PR, as Send to Paseo does", async t => {
  const { service, fake } = await setup(t, { github: async () => ({ title: "Add CSV export", body: "Adds it.", state: "open" }) });
  const plan = await service.preview({ source: "https://github.com/example/app/pull/318" });
  assert.deepEqual([plan.action?.id, plan.where.projectId, plan.where.how, plan.branch, plan.base], ["checkout", "app", "link", null, null]);
  await service.dispatch({ source: "https://github.com/example/app/pull/318" });
  await service.settle();
  assert.deepEqual(fake.creates[0].source, { kind: "worktree", projectId: "app", action: "checkout", githubPrNumber: 318, checkoutSource: { kind: "change_request", forge: "github", number: 318 } });
  assert.equal(fake.creates[0].title, "#318 Add CSV export");
});

test("Just open uses the project folder", async t => {
  const { service, fake } = await setup(t);
  await service.dispatch({ source: "ACME-142", projectId: "web", actionId: "open" });
  await service.settle();
  assert.deepEqual(fake.creates[0].source, { kind: "directory", path: "/work/web", projectId: "web" });
});

test("nothing is created without a dispatch: preview and sources read only, and a blocked or changed dispatch creates nothing", async t => {
  const { service, fake, linearCalls } = await setup(t);
  const sources = await service.sources();
  assert.equal(sources.linear.status, "ok");
  const plan = await service.preview({ source: "ACME-142" });
  assert.equal(plan.where.how, "ambiguous");
  assert.ok(plan.blockers.some(b => /web \(web\)/.test(b)), "a blocker names the projects to pick from");
  await assert.rejects(service.dispatch({ source: "ACME-142" }), /Projects:/);
  const picked = await service.preview({ source: "ACME-142", projectId: "web" });
  assert.deepEqual(picked.blockers, []);
  await assert.rejects(service.dispatch({ source: "ACME-142", projectId: "web", note: "changed since", expectHash: picked.hash }), /changed since the dry run/);
  await service.settle();
  assert.deepEqual([fake.creates.length, (await service.records()).length], [0, 0]);
  assert.deepEqual(linearCalls, ["list", "get ACME-142", "get ACME-142", "get ACME-142", "get ACME-142"]);
});

test("the Overseer's gate blocks its dispatch with the gate's reason", async t => {
  const { service, fake } = await setup(t, { gate: async actor => actor.kind === "agent" ? "Ask the developer first." : null });
  await assert.rejects(service.dispatch({ source: "ACME-142", projectId: "web" }, { kind: "agent", agentId: "overseer-1", title: null }), /Ask the developer first/);
  await service.settle();
  assert.equal(fake.creates.length, 0);
});

test("actions: a written action is validated; a built-in hides but isn't deleted; reset-all restores", async t => {
  const { service } = await setup(t);
  await assert.rejects(service.setActions({ op: "upsert", action: { id: "triage", name: "Triage", icon: "search", description: "", instructions: "Triage {assignee}", agent: null, workspace: "worktree", branch: "title", follow: { goalFromSource: true, specFromArtifact: false, askWhenPlanReady: false }, appliesTo: ["issue"], hidden: false } }), /\{assignee\}/);
  const { actions } = await service.setActions({ op: "upsert", action: { id: "triage", name: "Triage", icon: "search", description: "", instructions: "Triage {key}", agent: null, workspace: "worktree", branch: "title", follow: { goalFromSource: true, specFromArtifact: false, askWhenPlanReady: false }, appliesTo: ["issue"], hidden: false } });
  assert.equal(actions.at(-1)?.id, "triage");
  await assert.rejects(service.setActions({ op: "delete", id: "pr" }), /hidden, not deleted/);
  await service.setActions({ op: "move", id: "triage", to: 0 });
  assert.equal((await service.preview({ source: "ACME-142", projectId: "web" })).action?.id, "triage");
  await service.setActions({ op: "reset-all" });
  assert.equal((await service.actions()).edited, false);
});

test("the dispatch tool: the dry run creates nothing, confirm starts exactly that, and a changed action refuses the plan", async t => {
  const { service, fake } = await setup(t);
  const rpc = {
    validate: async (_m: string, i: unknown) => i,
    call: async (method: string, input: any, actor?: any) => {
      if (method === "follow.dispatch-preview") return service.preview(input, actor);
      if (method === "follow.dispatch") return service.dispatch(input, actor);
      throw new Error(`unexpected ${method}`);
    },
  };
  const agent = new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [] }), mutate: async () => undefined }, inbox: { noteAction: async () => undefined }, rpc } as never);
  const ambiguous = await agent.run("a1", "dispatch", { source: "ACME-142" }) as { planId: string | null; candidates: unknown[] };
  assert.equal(ambiguous.planId, null);
  assert.equal(ambiguous.candidates.length, 2);
  const plan = await agent.run("a1", "dispatch", { source: "ACME-142", projectId: "web" }) as { planId: string; instructions: string; project: string };
  assert.ok(plan.planId);
  assert.equal(plan.project, "web");
  await service.settle();
  assert.equal(fake.creates.length, 0, "the dry run creates nothing");
  const out = await agent.run("a1", "dispatch", { confirm: true, planId: plan.planId }) as { record: { by: string } };
  assert.equal(out.record.by, "agent:a1");
  await service.settle();
  assert.equal(fake.creates.length, 1);
  await assert.rejects(agent.run("a1", "dispatch", { confirm: true, planId: plan.planId }), /expired|used|plan/i);
  // The action changes between the dry run and the confirm: the confirm is refused.
  const second = await agent.run("a1", "dispatch", { source: "ACME-142", projectId: "web" }) as { planId: string };
  const pr = (await service.actions()).actions.find(a => a.id === "pr")!;
  await service.setActions({ op: "upsert", action: { ...pr, instructions: `${pr.instructions}\nAlso add tests.` } });
  await assert.rejects(agent.run("a1", "dispatch", { confirm: true, planId: second.planId }), /changed since the dry run/);
  await service.settle();
  assert.equal(fake.creates.length, 1);
});
