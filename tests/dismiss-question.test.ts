// dismissing-a-question-sends-the-agent-nothing (AGENTS.md invariant 59). 2026-11-19, Tom: "Add an option to dismiss
// questions, sometimes a question is not relevant anymore ... the agent already knows I did that, I have no reason to
// waste tokens on telling him that again". A question could only be answered (Send, Put in chat, Copy): every way to
// clear it from Needs you put words in front of the agent, a turn and tokens for nothing. These run the server rule,
// the engine with a real message queue, the agent's re-ask and needs_you paths, the agent tool's guard, and the real
// QuestionBody under the native stand-in.
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
import { askQuestion, dismissQuestion, needsYouQuestions, syncTaskQuestions, undoDismiss } from "../server/questions";
import { closedLine, isDismissed, isOpen, questionSchema, type Question } from "../shared/questions";
import { needsYou } from "../shared/attention";
import { briefQuestionsEvent, RESOLVED } from "../shared/brief";
import { agentActor, DEVELOPER } from "../shared/actor";
import { catchUpKey } from "../shared/catch-up";
import { clock, workspace, pr } from "./fixtures";
import { testQueue } from "./support/queue";
import { testStore, rm } from "./support/store-temp-dir";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

const options = [{ letter: "A", label: "Retry for a day" }, { letter: "B", label: "Retry once" }];
const shape = { title: "Retry window", question: "How long should failed invoices retry?", options, recommend: "A" };
const asked = (w = workspace()) => { askQuestion(w, "main-agent", shape, "work-around", clock); return w; };

test("dismiss closes the question as dismissed by the developer, and it leaves Needs you at once", () => {
  const w = asked();
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question").length, 1);
  const q = dismissQuestion(w, "Q1", DEVELOPER, clock);
  assert.ok(!isOpen(q) && isDismissed(q));
  assert.equal(q.closed?.by, "developer");
  assert.equal(q.answer, null, "no answer is recorded, so nothing is waiting to be sent");
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question").length, 0, "the count drops");
  assert.equal(closedLine(q), "Removed by you", "distinct from an agent's Withdrawn");
  assert.throws(() => dismissQuestion(w, "Q1", DEVELOPER, clock), /already dismissed/);
});

test("undo restores the question exactly as it was", () => {
  const w = asked();
  const before = structuredClone(w.questions[0]);
  dismissQuestion(w, "Q1", DEVELOPER, clock);
  undoDismiss(w, "Q1");
  assert.deepEqual(w.questions[0], before);
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question").length, 1, "back in Needs you");
  assert.throws(() => undoDismiss(w, "Q1"), /isn't dismissed/);
});

test("an agent dismisses another agent's question for the developer, never its own (that is withdraw)", () => {
  const w = asked();
  assert.throws(() => dismissQuestion(w, "Q1", agentActor("main-agent"), clock), /your own question: use withdraw_question/);
  const q = dismissQuestion(w, "Q1", agentActor("helper", "Release captain"), clock);
  assert.equal(q.closed?.by, "agent:helper", "audited as the agent");
  assert.equal(closedLine(q), "Removed for you by an agent");
});

type Deliver = (recipients: string[], text: string) => Promise<string>;
async function fixture(t: { after(f: () => Promise<void>): void }, deliver: Deliver) {
  const root = await mkdtemp(join(tmpdir(), "follow-dismiss-"));
  const store = testStore(Store, root);
  await store.mutate(s => { s.workspaces.push(asked(workspace({ prs: [pr()] }))); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(clock).toISOString() }, error: null }])) };
  const q = await testQueue(root, { deliver: (target, text) => deliver(target.recipients, text), start: clock });
  const engine = new Engine(store, github as never, gateway, () => clock);
  engine.attachQueue(q.queue);
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await store.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return { engine, queue: q.queue, question: async () => (await store.snapshot()).workspaces[0].questions[0] };
}

test("nothing reaches the agent: no queue item, no send, through a full tick; Undo sends nothing either", async t => {
  const sent: string[] = [];
  const f = await fixture(t, async (recipients, text) => { sent.push(text); return recipients[0]; });
  const { question } = await f.engine.dismiss("workspace", "Q1", false);
  assert.ok(isDismissed(question));
  await f.engine.idle(); await f.engine.tick(); await f.engine.idle();
  assert.deepEqual(f.queue.list(), { items: [], recent: [] }, "nothing queued");
  assert.deepEqual(sent, [], "nothing sent");
  await f.engine.dismiss("workspace", "Q1", true);
  assert.ok(isOpen(await f.question()));
  await f.engine.idle(); await f.engine.tick(); await f.engine.idle();
  assert.deepEqual(sent, [], "reopening sends nothing too");
  // An answer after a dismissal elsewhere is moot, never a send.
  await f.engine.dismiss("workspace", "Q1", false);
  await assert.rejects(f.engine.answer("workspace", "Q1", "A", undefined, "send"), /^Error: Q1 was dismissed/);
  assert.deepEqual(sent, []);
});

test("re-ask: asking a dismissed question again returns it, no new card; supersedes asks again on purpose", () => {
  const w = asked(); dismissQuestion(w, "Q1", DEVELOPER, clock);
  const again = askQuestion(w, "main-agent", shape, "work-around", clock);
  assert.equal(again.outcome, "dismissed");
  assert.equal(again.question.id, "Q1");
  assert.match(again.instruction, /dismissed Q1 .*don't raise it again/);
  assert.equal(w.questions.length, 1, "no second card");
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question").length, 0);
  const other = askQuestion(w, "main-agent", { ...shape, title: "Alert channel", question: "Which channel gets billing alerts?" }, "work-around", clock);
  assert.equal(other.outcome, "asked", "a different question is asked as usual");
  const changed = askQuestion(w, "main-agent", { ...shape, options: [...options, { letter: "C", label: "Never retry" }] }, "work-around", clock, { supersedes: "Q1" });
  assert.equal(changed.outcome, "superseded");
  assert.ok(isDismissed(w.questions[0]), "the dismissed one stays dismissed");
});

test("needs_you: pointing at a dismissed question says so; restating it as a decision leaves it off the card", () => {
  const w = asked(); dismissQuestion(w, "Q1", DEVELOPER, clock);
  assert.throws(() => needsYouQuestions(w, "main-agent", { questions: ["Q1"] }, "work-around", clock, null), /dismissed Q1.*don't raise it again/);
  const r = needsYouQuestions(w, "main-agent", { decisions: [{ question: shape.question, options: options.map(o => ({ label: o.label })), recommend: 0 }] }, "work-around", clock, null);
  assert.deepEqual([r.questionIds, r.dismissed], [[], ["Q1"]]);
  assert.equal(w.questions.length, 1);
});

test("a blocked task's question, dismissed, isn't asked again for that block; the task stays the agent's", () => {
  const w = workspace({ obligations: [{ id: "rollout", title: "Choose the rollout cohort", status: "blocked", ask: "Which cohort first?", afterPrs: [], enable_follow_up: true, evidence: "", revision: 1 } as never] });
  syncTaskQuestions(w, clock);
  dismissQuestion(w, "Q1", DEVELOPER, clock);
  assert.equal(syncTaskQuestions(w, clock), false, "no new card for the same block");
  assert.equal(w.obligations[0].status, "blocked", "task state is the agent's: untouched");
});

test("a brief whose questions were dismissed closes as dismissed, not as withdrawn", () => {
  const w = asked(); dismissQuestion(w, "Q1", DEVELOPER, clock);
  const event = briefQuestionsEvent({ state: "open", questionIds: ["Q1"] } as never, w.questions);
  assert.equal(event?.dismissed, true);
  assert.equal(RESOLVED.dismissed, "You dismissed this question");
});

test("Catch up: ⇧D dismisses; D alone still picks option D", () => {
  const at = { typing: false, inMore: false, moreOpen: false, inRail: false };
  const key = (k: string, shift: boolean) => catchUpKey({ key: k, meta: false, ctrl: false, alt: false, shift, mac: true }, at);
  assert.deepEqual(key("D", true), { action: "dismiss" });
  assert.deepEqual(key("d", false), { action: "pick", arg: "D" });
});

// The real card, under the phone's rules (invariant 51): Dismiss is a quiet link after More context, sends only the
// dismiss request, and a dismissed card says so.
register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { setContextSource } = await import("../client/more-context");
const { rpcCalls } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[] };
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const question: Question = questionSchema.parse({ id: "Q1", ...shape, askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around", recommend: "A" });

async function card(q: Question, props: Record<string, unknown> = {}) {
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(QuestionBody, { workspace: workspace({ questions: [q] }), question: q, theme, compact: true, now: clock, ...props }))); }); }
  finally { console.error = orig; }
  const labelled = (re: RegExp) => r.root.findAll(n => typeof n.props.onPress === "function" && re.test(String(n.props.accessibilityLabel ?? "")));
  const texts = () => r.root.findAll(n => typeof n.props.children === "string" || Array.isArray(n.props.children)).map(n => [n.props.children].flat().filter(x => typeof x === "string").join("")).join("\n");
  return { labelled, texts, unmount: () => r.unmount() };
}

test("the card: Dismiss is the card's x (no link in the quiet row), sends only the dismiss, and moves on like an answer", async () => {
  await act(() => { const none: never[] = []; setContextSource({ context: () => none, subscribe: () => () => {}, askContext: async () => { throw new Error("no"); } }); });
  rpcCalls.length = 0;
  let moved = 0;
  const c = await card(question, { onAnswered: () => { moved++; } });
  assert.equal(c.labelled(/^Remove Q1: it no longer needs you, and the agent isn't messaged$/).length > 0, true, "one x, labelled with what it does");
  assert.doesNotMatch(c.texts(), /^Dismiss$/m, "the quiet row's old Dismiss link is gone");
  // Two clicks in place (dismiss-takes-two-clicks-in-place): the first arms the x, the second dismisses.
  await act(async () => { c.labelled(/^Remove Q1/)[0].props.onPress(); await new Promise(res => setTimeout(res, 20)); });
  await act(async () => { c.labelled(/^Remove Q1$/)[0].props.onPress(); await new Promise(res => setTimeout(res, 20)); });
  assert.deepEqual(rpcCalls.map(x => [x.name, x.input]), [["follow.dismiss", { workspaceId: "workspace", key: "question:Q1" }]], "nothing but the dismiss: no answer, no message");
  assert.equal(moved, 1, "the surface moves on (Catch up settles the card, the pill steps)");
  c.unmount();
  await act(() => { setContextSource(null); });
});

test("the card in Catch up has Dismiss too, and a dismissed card says Removed, not Withdrawn", async () => {
  const inCatchUp = await card(question, { moreContext: false });
  assert.ok(inCatchUp.labelled(/^Remove Q1/).length > 0);
  inCatchUp.unmount();
  const w = workspace({ questions: [structuredClone(question)] });
  const closed = dismissQuestion(w, "Q1", DEVELOPER, clock);
  const done = await card(closed);
  assert.match(done.texts(), /Removed by you .*The agent wasn't messaged\./);
  assert.doesNotMatch(done.texts(), /Withdrawn/);
  assert.equal(done.labelled(/^Remove Q1/).length, 0, "nothing to dismiss on a closed card");
  done.unmount();
});
