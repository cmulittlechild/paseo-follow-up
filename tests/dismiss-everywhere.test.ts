// dismissing-anything-in-needs-you-sends-the-agent-nothing (AGENTS.md invariant 59, widened). 2026-11-19, Tom, after
// trying 2.3.0-beta.1: "Maybe the dismiss button should be on all "Needs you" actions? Maybe it should be in a context
// menu, or a small x button, I want it to be really not intrusive". Only a question could be dismissed; an agent's
// Action brief, a merge or reviewers ask, a waiting send and the rest could only be acted on (Done messaged the agent)
// or signed off from elsewhere. These run every kind through the server rule, the engine with a real message queue,
// the inbox's brief path and needs_you's restated ask, the agent tool's guard, and the real row under the native
// stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { dismissItem, dismissedNeeds, undoDismissItem } from "../server/dismiss";
import { activeNeeds, allNeeds, needsYou, reviewersAskStands, type NeedItem } from "../shared/attention";
import { agentActor, DEVELOPER } from "../shared/actor";
import { briefStep, type Brief } from "../shared/brief";
import { DISMISSED_ASK_NOTE, newEntry, reduce, sameAsk } from "../shared/inbox";
import { emptyReviewerConfig, setReviewerConfig } from "../shared/reviewers";
import { RPC_TOOLS } from "../server/agent-parity";
import type { Batch, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";
import { testQueue } from "./support/queue";
import { testStore, rm } from "./support/store-temp-dir";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

const iso = (t = clock) => new Date(t).toISOString();
const batch = (patch: Partial<Batch> = {}): Batch => ({ id: "b1", tasks: [{ key: "conflict:example/app#1", kind: "conflict", target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint: "f1" }], state: "pending", createdAt: iso(clock - 60_000), sentAt: null, settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], ...patch });
const task = (fingerprint = "f1") => ({ key: "conflict:example/app#1", kind: "conflict" as const, target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint });
const approved = (head = "first-head") => pr({ snapshot: snapshot({ head, reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) });
const reviewers = { author: "agent-author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true };
const unreviewed = (head = "first-head") => pr({ snapshot: snapshot({ head, reviewers, checksPending: true }), registeredAgentId: "main-agent" });

/** Every workspace kind: a workspace that shows it, and a change that should bring it back. */
const KINDS: { kind: NeedItem["kind"]; make: () => Workspace; change: (w: Workspace) => void; setup?: () => () => void }[] = [
  { kind: "merge", make: () => workspace({ prs: [approved()] }), change: w => { w.prs = [approved("second-head")]; } },
  { kind: "reviewers", make: () => workspace({ prs: [unreviewed()] }), change: w => { w.prs = [unreviewed("second-head")]; },
    setup: () => { setReviewerConfig({ ...emptyReviewerConfig(), repos: { "example/app": [{ login: "ravi", name: "Ravi" }] } }); return () => setReviewerConfig(emptyReviewerConfig()); } },
  { kind: "send", make: () => workspace({ batches: [batch()] }), change: w => { w.batches = [batch({ tasks: [task("f2")] })]; } },
  { kind: "retry", make: () => workspace({ batches: [batch({ state: "blocked", result: "Needs credentials" })] }), change: w => { w.batches = [batch({ state: "blocked", result: "Needs credentials", attempts: 2 })]; } },
  { kind: "capped", make: () => workspace({ heldTasks: [{ task: task(), held: "capped" }] }), change: w => { w.heldTasks = [{ task: task("f2"), held: "capped" }]; } },
  { kind: "person", make: () => workspace({ heldTasks: [{ task: task(), held: "person" }] }), change: w => { w.heldTasks = [{ task: task("f2"), held: "person" }]; } },
  { kind: "decision", make: () => workspace({ obligations: [{ id: "d", title: "Pick a migration strategy", status: "blocked", afterPrs: [], evidence: "", ask: "Expand-contract or a window?", enable_follow_up: false, revision: 0 }] }),
    change: w => { w.obligations = [{ ...w.obligations[0], revision: 1, ask: "Expand-contract, or a window tonight?" }]; } },
  { kind: "hold", make: () => workspace({ hold: "You stopped the main agent." }), change: w => { w.hold = "Follow-up couldn't reach the main agent."; } },
  { kind: "check", make: () => workspace({ prActions: [{ id: "a", kind: "merge", prs: ["example/app#1"], heads: {}, createdAt: iso(), state: "uncertain", result: "Graphite did not confirm" }] }),
    change: w => { w.prActions = [{ ...w.prActions[0], result: "GitHub timed out" }]; } },
  { kind: "message", make: () => workspace({ undelivered: [{ id: "q1", agentId: "helper", agentTitle: null, state: "queued", reason: null, since: iso() }] }),
    change: w => { w.undelivered = [{ ...w.undelivered![0], state: "failed", reason: "Gone" }]; } },
  { kind: "answer", make: () => workspace({ questions: [{ id: "Q1", title: "Retry window", question: "How long?", options: [], recommend: null, big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: iso(), mode: "work-around", closed: null,
    answer: { choice: "other", words: "A day", at: iso(), by: "developer", delivery: { state: "copied", at: iso(), reason: null } } } as never] }),
    change: w => { w.questions = [{ ...w.questions[0], answer: { ...w.questions[0].answer!, delivery: { state: "in-chat", at: iso(), reason: null } } } as never]; } },
];

for (const k of KINDS) test(`${k.kind}: dismiss hides it and every count drops; undo restores it; a change brings it back`, t => {
  if (k.setup) t.after(k.setup());
  const w = k.make();
  const item = needsYou(w, clock).find(i => i.kind === k.kind);
  assert.ok(item, `the fixture shows a ${k.kind} item`);
  const before = needsYou(w, clock).length;
  const r = dismissItem(w, item.key, DEVELOPER, clock);
  assert.ok(r.name.length > 0);
  assert.ok(!needsYou(w, clock).some(i => i.key === item.key), "gone from Needs you");
  assert.equal(needsYou(w, clock).length, before - 1, "the count drops");
  assert.equal(activeNeeds(w, clock).length, before - 1, "every count reads the same list");
  assert.ok(allNeeds(w, clock).some(i => i.key === item.key), "still known underneath: nothing Follow-up holds is dropped");
  assert.equal(w.dismissed?.[0].by, "developer");
  assert.deepEqual(dismissedNeeds(w, clock).map(d => d.key), [item.key], "workspace_status shows it as dismissed by the developer");
  assert.throws(() => dismissItem(w, item.key, DEVELOPER, clock), /already dismissed/);
  undoDismissItem(w, item.key, DEVELOPER);
  assert.ok(needsYou(w, clock).some(i => i.key === item.key), "Undo brings it back");
  dismissItem(w, item.key, DEVELOPER, clock);
  k.change(w);
  assert.ok(needsYou(w, clock).some(i => i.kind === k.kind), "a real change is news: it comes back");
  assert.deepEqual(dismissedNeeds(w, clock), [], "and workspace_status no longer calls it dismissed");
});

test("a question key closes the question as dismissed (one path for every kind)", () => {
  const w = KINDS.find(k => k.kind === "answer")!.make();
  w.questions = [{ ...w.questions[0], answer: null }];
  dismissItem(w, "question:Q1", DEVELOPER, clock);
  assert.equal(w.questions[0].closed?.dismissed, true);
  assert.equal(w.dismissed, undefined, "a question's dismissal lives on the question");
  undoDismissItem(w, "question:Q1", DEVELOPER);
  assert.equal(w.questions[0].closed, null);
});

test("a gone item is moot, and an agent can't dismiss its own workspace's asks", () => {
  const w = workspace({ prs: [approved()] });
  assert.throws(() => dismissItem(w, "merge:example/app#9", DEVELOPER, clock), /already gone from Needs you/);
  assert.throws(() => dismissItem(w, "merge:example/app#1", agentActor("main-agent"), clock), /your own workspace/);
  dismissItem(w, "merge:example/app#1", agentActor("helper", "Release captain"), clock);
  assert.equal(w.dismissed?.[0].by, "agent:helper", "audited as the agent");
});

test("the agent row's Add reviewers flag drops with the dismissed reviewers ask (reviewers-ask-agrees)", t => {
  t.after(KINDS.find(k => k.kind === "reviewers")!.setup!());
  const w = workspace({ prs: [unreviewed()] });
  assert.equal(reviewersAskStands(w.prs[0], w), true);
  dismissItem(w, "reviewers:example/app#1", DEVELOPER, clock);
  assert.equal(reviewersAskStands(w.prs[0], w), false, "the inbox flag is withdrawn too (followUpEvents reads this)");
});

/** A workspace through the real engine and queue, with these keys dismissed first: what it sent and where it ended. */
async function run(t: { after(f: () => Promise<void>): void }, keys: string[]) {
  const root = await mkdtemp(join(tmpdir(), "follow-dismiss-all-"));
  const store = testStore(Store, root);
  await store.mutate(s => { s.workspaces.push(workspace({ prs: [approved()], batches: [batch()] })); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const sent: string[] = [];
  const gateway: Gateway = { observe: async () => runtime, send: async (_a, text) => { sent.push(String(text)); }, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: iso() }, error: null }])) };
  const q = await testQueue(root, { deliver: (target, text) => { sent.push(text); return Promise.resolve(target.recipients[0]); }, start: clock });
  const engine = new Engine(store, github as never, gateway, () => clock);
  engine.attachQueue(q.queue);
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const shown = needsYou((await store.snapshot()).workspaces[0], clock).map(i => i.key);
  for (const key of keys) await store.mutateWorkspace("workspace", w => { dismissItem(w, key, DEVELOPER, clock); });
  await engine.idle(); await engine.tick(); await engine.idle();
  const w = (await store.snapshot()).workspaces[0];
  return { shown, after: needsYou(w, clock).map(i => i.key), batches: w.batches, queue: q.queue.list(), sent };
}

test("nothing reaches any agent, and Dismiss changes nothing Follow-up does: the same tick as without it", async t => {
  const control = await run(t, []);
  const dismissed = await run(t, ["send:b1", "merge:example/app#1"]);
  assert.deepEqual(control.shown, ["send:b1", "merge:example/app#1"], "the fixture asks for both");
  assert.deepEqual(dismissed.after, [], "both left Needs you");
  assert.deepEqual(dismissed.batches, control.batches, "the repairs are exactly where they'd be: Dismiss never drops or holds work");
  assert.deepEqual(dismissed.queue, control.queue, "nothing queued that wouldn't be");
  assert.deepEqual(dismissed.sent, control.sent, "nothing sent that wouldn't be");
  assert.deepEqual(dismissed.sent, []);
});

// The agent's turn-end brief: a sign-off that remembers the ask.
const brief = (ask: string): Brief => ({ id: "brief:t1", kind: "action", source: "agent", state: "open", ask, at: iso(), flagged: true } as never);
test("brief: Dismiss signs the row off as dismissed, remembers the ask, and the card says Dismissed", () => {
  const flagged = reduce(newEntry("helper"), { type: "turn_end", outcome: "completed", detail: "Rotate the staging key" }, iso());
  const e = reduce({ ...flagged, brief: brief("Rotate the staging key in the vault") }, { type: "sign_off", dismissed: true }, iso());
  assert.equal(e.needs, null, "leaves Needs you");
  assert.deepEqual(e.dismissedAsk, { ask: "Rotate the staging key in the vault", kind: "action", at: iso() });
  const card = briefStep(brief("Rotate the staging key in the vault"), { type: "sign_off", dismissed: true }, iso()).brief!;
  assert.equal(card.outcome, "Dismissed");
  assert.equal(reduce(e, { type: "undo" }, iso()).dismissedAsk, null, "Undo forgets it");
  assert.equal(reduce(e, { type: "message", from: "tom" }, iso()).dismissedAsk, null, "so does the developer's next message");
  assert.equal(reduce(flagged, { type: "sign_off" }, iso()).dismissedAsk ?? null, null, "a plain Sign off remembers nothing");
});

test("needs_you: restating a dismissed ask isn't news (sameAsk); a different ask is", () => {
  assert.ok(sameAsk("Rotate the staging key in the vault.", "rotate the  staging key in the vault"));
  assert.ok(!sameAsk("Rotate the staging key in the vault", "Rotate the production key"));
  assert.match(DISMISSED_ASK_NOTE, /dismissed this ask.*wasn't flagged again and nothing was sent/);
});

test("dismiss_item: planned, maps to follow.dismiss, never your own brief", () => {
  const tool = RPC_TOOLS.find(t => t.name === "dismiss_item")!;
  assert.equal(tool.rpc, "follow.dismiss");
  assert.equal(tool.kind, "planned");
  assert.deepEqual(tool.toRpc!({ workspaceId: "workspace", key: "merge:example/app#1" }), { workspaceId: "workspace", key: "merge:example/app#1" });
  assert.deepEqual(tool.toRpc!({ agentId: "helper", undo: true }), { agentId: "helper", undo: true });
  assert.match(tool.guard!({ agentId: "me" }, "me")!, /your own brief/);
  assert.equal(tool.guard!({ agentId: "helper" }, "me"), null);
});

// The real row, under the phone's rules (invariant 51): every kind has the x, and it sends only the dismiss.
register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { NeedsYouList } = await import("../client/needs-you");
const { rpcCalls } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[] };
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("the row: every kind draws the x top right, and it sends only follow.dismiss, then moves on", async () => {
  for (const k of KINDS.filter(k => !k.setup)) {
    const w = k.make();
    const items = needsYou(w, clock);
    let moved = 0;
    let r!: ReturnType<typeof create>;
    const orig = console.error; console.error = () => {};
    try { await act(() => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NeedsYouList, { workspace: w, theme, compact: true, now: clock, actions: { after: () => { moved++; } } }))); }); }
    finally { console.error = orig; }
    const xs = r.root.findAll(n => typeof n.props.onPress === "function" && /^Remove .*: it no longer needs you, and the agent isn't messaged$/.test(String(n.props.accessibilityLabel ?? "")));
    const labels = [...new Set(xs.map(n => n.props.accessibilityLabel))];
    assert.equal(labels.length, items.length, `${k.kind}: one x per row`);
    rpcCalls.length = 0;
    // Two clicks in place (dismiss-takes-two-clicks-in-place): the first arms the x and sends nothing.
    const name = String(xs[0].props.accessibilityLabel).split(": ")[0];
    await act(async () => { xs[0].props.onPress(); await new Promise(res => setTimeout(res, 20)); });
    assert.equal(rpcCalls.length, 0, `${k.kind}: one click sends nothing`);
    const armed = r.root.findAll(n => typeof n.props.onPress === "function" && n.props.accessibilityLabel === name);
    assert.ok(armed.length > 0, `${k.kind}: armed, Remove is named for the item`);
    await act(async () => { armed[0].props.onPress(); await new Promise(res => setTimeout(res, 20)); });
    assert.deepEqual(rpcCalls.map(x => [x.name, x.input]), [["follow.dismiss", { workspaceId: "workspace", key: items[0].key }]], `${k.kind}: nothing but the dismiss`);
    assert.equal(moved, 1, `${k.kind}: the surface moves on (Catch up settles the card)`);
    r.unmount();
  }
});
