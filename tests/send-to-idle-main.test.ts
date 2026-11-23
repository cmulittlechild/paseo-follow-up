import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueEngine } from "./support/queue";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { SessionGuard } from "../server/session-guard";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import type { Workspace } from "../shared/model";
import { batchView } from "../shared/status";
import { sendDecision } from "../shared/send-decision";
import { sendingOf } from "../shared/sending";
import { messageStrip, nextMessageInfo, repairRows } from "../shared/task-rows";
import { needsYou } from "../shared/attention";
import { violations } from "../shared/status-invariants";
import { clock, workspace, pr, snapshot } from "./fixtures";

// Q96 = A (2026-11-18): a repair goes to the main agent as soon as the main agent is free, whatever its subagents and
// the workspace's other agents are doing; a waiting repair says what it waits for, and can be sent now
// (invariant a-repair-goes-to-a-free-main-agent). Live: a repair batch sat "pending" for over two hours with Auto-send
// on, the main agent idle, and a subagent it started running one task after another; the card said nothing true.

async function gatewayFixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "follow-idle-main-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = clock; t.mock.method(Date, "now", () => now);
  const base = { workspaceId: "workspace", provider: "claude", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", labels: {}, lastUserMessageAt: "2026-01-01T09:59:00Z", pendingPermissions: [] };
  const main = { ...base, id: "main-agent", status: "idle", activeTurn: null } as unknown as Agent;
  const helper = { ...base, id: "helper-agent", title: "alice's helper", status: "running", activeTurn: { id: "helper-turn" } } as unknown as Agent;
  const agents: Agent[] = [main, helper];
  let providerSubagents = false;
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "workspace", name: "acme app", projectId: "project" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) }),
    listProviderSubagents: async () => ({ subagents: providerSubagents ? [{ status: "running" }] : [] }),
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon, new SessionGuard(directory, () => now), async () => false);
  return { gateway, main, helper, agents, providerSubagents: (on: boolean) => { providerSubagents = on; } };
}

test("a subagent at work leaves the idle main agent free for repairs, and the workspace still busy for Done", async t => {
  const f = await gatewayFixture(t);
  const w = workspace({ enable_auto_sends: true });
  const runtime = await f.gateway.observe(w, true);
  assert.equal(runtime.mainBusy, null, "the main agent is idle: a repair may go to it");
  assert.equal(runtime.backgroundBusy, true, "the workspace isn't quiet: Done and 'all work finished' still wait");
  assert.equal(runtime.busy, true);
});

test("the main agent's own provider subagents don't hold its repairs", async t => {
  const f = await gatewayFixture(t);
  f.agents.splice(1, 1); f.providerSubagents(true);
  const runtime = await f.gateway.observe(workspace({ enable_auto_sends: true }), true);
  assert.equal(runtime.mainBusy, null);
  assert.equal(runtime.backgroundBusy, false, "a repair's send doesn't even ask for them");
  const done = await f.gateway.observe(workspace({ completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } }));
  assert.equal(done.backgroundBusy, true, "Done still waits for them");
  assert.equal(done.mainBusy, null);
  const declared = await f.gateway.observe(workspace({ declaration: { summary: "Shipped", at: new Date(clock).toISOString() } }));
  assert.equal(declared.backgroundBusy, true, "a Done declaration waiting to be accepted waits for them too");
});

test("the main agent's own turn and, with Wait for background jobs on, its own background job hold a repair", async t => {
  const f = await gatewayFixture(t);
  (f.main as { status: string }).status = "running";
  assert.equal((await f.gateway.observe(workspace())).mainBusy, "turn");
  (f.main as { status: string }).status = "idle";
  (f.main as { backgroundWork?: { count: number } }).backgroundWork = { count: 1 };
  assert.equal((await f.gateway.observe(workspace())).mainBusy, "jobs", "Wait for background jobs is on unless saved off (unknown is not off)");
  f.gateway.waitForJobs = async () => false;
  assert.equal((await f.gateway.observe(workspace())).mainBusy, null, "with it off, a job the main agent left running doesn't hold a repair");
  assert.equal((await f.gateway.observe(workspace())).backgroundBusy, true, "but Done still waits for it");
});

async function engineFixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-idle-main-engine-"));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; let state: Runtime = { busy: false, reason: null, archived: false };
  const sends: string[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery", contextPath: "/fixture/recovery.json" }), observe: async () => state, send: async (_w, _b, text) => { sends.push(text); }, label: async () => {} };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(now).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  await queueEngine(engine, gateway, root);
  const get = async () => (await store.snapshot()).workspaces[0];
  return { engine, sends, get, store, now: () => now, advance: (ms: number) => { now += ms; }, runtime: (s: Runtime) => { state = s; } };
}
const conflicted = (patch: Partial<Workspace> = {}) => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })], ...patch });
const subagentAtWork: Runtime = { busy: true, backgroundBusy: true, mainBusy: null, reason: null, archived: false, mainLoaded: true, mainRecent: true };

test("Auto sends a repair to an idle main agent while its subagent works", async t => {
  const f = await engineFixture(t, conflicted());
  f.runtime(subagentAtWork);
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, `the repair went to the main agent; the line said "${batchView(await f.get(), f.now())?.line}"`);
  assert.equal((await f.get()).batches[0].state, "sent");
});

test("the developer's Send goes to an idle main agent while its subagent works", async t => {
  const f = await engineFixture(t, conflicted({ enable_auto_sends: false }));
  f.runtime(subagentAtWork);
  await f.engine.tick();
  const w = await f.get();
  await f.engine.sendPending(w.id, w.batches[0].id);
  assert.equal(f.sends.length, 1);
});

test("a repair still waits for the main agent's own turn, then goes at its end", async t => {
  const f = await engineFixture(t, conflicted());
  f.runtime({ ...subagentAtWork, mainBusy: "turn" });
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 0);
  assert.match(batchView(await f.get(), f.now())!.line, /the main agent's turn ends/);
  f.runtime(subagentAtWork); await f.engine.tick();
  assert.equal(f.sends.length, 1, "the main agent is free: it goes, the subagent still at work");
});

// Every surface that shows a waiting repair says why, in the same words, and offers Send now where the server takes it.
const queued = (patch: Partial<Workspace>) => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })],
  batches: [{ id: "batch", tasks: [{ kind: "obligation", key: "conflict:example/app#1", target: "example/app#1", fingerprint: "f", title: "Resolve merge conflicts on example/app#1" } as never], state: "pending", createdAt: new Date(clock - 120_000).toISOString(), sentAt: null, settledAt: null, messageId: "m", attempts: 0, result: "", recipientAgentId: null } as never],
  mainBusy: null, ...patch });

const WAITS: [string, Partial<Workspace>, RegExp, "send-now" | "needs-you" | "resume"][] = [
  ["the main agent's turn", { runtimeBusy: true, mainBusy: "turn" }, /sends when the main agent's turn ends/, "send-now"],
  ["the main agent's background job", { backgroundBusy: true, mainBusy: "jobs" }, /main agent's background job ends.*Wait for background jobs/, "send-now"],
  ["a permission", { runtimeReason: "Main agent is waiting for a permission or answer", mainBusy: "permission" }, /main agent's permission prompt is answered/, "send-now"],
  ["Session Guard", { runtimeReason: "Waiting for Session Guard to resume this workspace", mainBusy: "guard" }, /Session Guard resumes the main agent/, "send-now"],
  ["compacting", { runtimeBusy: true, mainBusy: "compacting", runtimeReason: "Smart Session is compacting the main agent" }, /compacting the main agent/, "send-now"],
  ["Auto-send off", { enable_auto_sends: false }, /auto-send is off/i, "needs-you"],
  ["a hold", { hold: "You stopped the agent" }, /paused until you resume/, "resume"],
];

test("a waiting repair says what it waits for on every surface, and can be sent now", () => {
  for (const [name, patch, words, action] of WAITS) {
    const w = queued(patch);
    const d = sendDecision(w, clock);
    assert.equal(d.send, false, name);
    assert.match(d.reason, words, `${name}: the decision says "${d.reason}"`);
    assert.match(batchView(w, clock)!.line, words, `${name}: panel and Home line`);
    assert.match(nextMessageInfo(w, clock)!.reason, words, `${name}: workspace_status`);
    const items = needsYou(w, clock);
    if (action === "send-now") {
      assert.equal(d.waitingOn, "agent", name);
      assert.equal(d.canSendNow, true, `${name}: Send now is offered (it goes the moment the main agent is free)`);
      const row = sendingOf(w, clock)!;
      assert.match(row.why, words, `${name}: Home's Sending row`); assert.equal(row.canSendNow, true, `${name}: Home's Send now`);
      const strip = messageStrip(w, clock)!;
      assert.match(strip.reason, words, `${name}: the Tasks strip`); assert.equal(strip.sendNow, true, `${name}: the strip's Send now`);
    } else if (action === "needs-you") {
      const send = items.find(i => i.kind === "send");
      assert.ok(send, `${name}: Needs you carries the Send`); assert.match(send!.title, words, `${name}: and says why`);
    } else {
      assert.ok(items.some(i => i.kind === "hold"), `${name}: Needs you carries Resume`);
    }
    assert.deepEqual(violations(w, clock).map(v => v.id), [], name);
  }
});

test("a subagent at work never shows as the main agent's wait", () => {
  const w = queued({ runtimeBusy: true, backgroundBusy: true, mainBusy: null });
  const d = sendDecision(w, clock);
  assert.equal(d.send, true, `the decision waits: "${d.reason}"`);
  assert.doesNotMatch(batchView(w, clock)!.line, /turn ends|background/);
});

// With #249's rules (a-batch-item-leaves-once-nothing-applies, a-human-only-outcome-is-a-human-item): a free main agent
// beside a working subagent still never gets a person's task, and a stuck batch still settles once nothing applies.
test("a person's task is never sent to a free main agent, and a moot stuck batch settles, while a subagent works", async t => {
  const f = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ reviewDecision: "CHANGES_REQUESTED" }) })] }));
  f.runtime(subagentAtWork);
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, "the review repair went to the free main agent");
  const sent = (await f.get()).batches.find(b => b.state === "sent")!;
  await f.engine.acknowledge("main-agent", sent.id, "blocked", "Only the reviewer can clear the stale review.", undefined, true);
  for (let i = 0; i < 5; i++) { f.advance(120_000); await f.engine.tick(); }
  let w = await f.get();
  assert.equal(f.sends.length, 1, "a person's task isn't sent again, though the main agent is free");
  assert.deepEqual(w.heldTasks?.map(h => h.held), ["person"]);
  assert.ok(needsYou(w, f.now()).some(i => i.kind === "person"));
  assert.equal(repairRows(w).open[0]?.text, "Needs you · waits on a person, not the agent");
  assert.deepEqual(violations(w, f.now()).map(v => v.id), []);

  // A plain blocked batch (not human-only) on a second PR settles once that PR merges, the subagent still at work.
  await f.store.mutate(s => { s.workspaces[0].prs.push(pr({ key: "example/app#2", number: 2, snapshot: snapshot({ conflict: true }) })); });
  f.advance(61_000); await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  const second = (await f.get()).batches.find(b => b.state === "sent")!;
  assert.ok(second, "the conflict repair went out");
  await f.engine.acknowledge("main-agent", second.id, "blocked", "Can't rebase yet.");
  await f.store.mutate(s => { s.workspaces[0].prs[1].snapshot = snapshot({ state: "MERGED" }); });
  f.advance(61_000); await f.engine.tick();
  w = await f.get();
  // The agent's answer keeps its outcome (invariant 104); moving on takes it out of Needs you and the queue.
  assert.equal(w.batches.find(b => b.id === second.id)?.movedOn?.why, "gone", "the moot blocked batch settled");
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "retry"));
});
