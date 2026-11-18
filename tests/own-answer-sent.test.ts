// what-you-typed-is-what-gets-sent (AGENTS.md invariant 53). 2026-11-18, Tom on 2.2.0-beta.5, a workspace panel's
// Needs you: Something else picked, a sentence typed in Your answer, and Send failed with "Something else needs your
// answer in words."; Retry failed the same way, so the question couldn't be answered from any card. The agent tool
// with the same words was accepted. Root cause: answerDraft (shared/questions.ts) gave Something else's words no
// field (only a lettered pick's note had one), and QuestionBody sent `words: draft.note`, so an own answer always went
// out without its words, and Retry rebuilt the same empty payload. These render the real QuestionBody, the one answer
// flow every card draws (Home, the panel, the pill, phones, Catch up), and read what reached the RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, OTHER, type Question } from "../shared/questions";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { setPendingAnswer, failPendingAnswer, clearPendingAnswer } = await import("../client/pending-answers");
const { rpcCalls } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[] };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fictional question asked through needs_you: three options, A recommended, no stored Something-else option.
const question: Question = questionSchema.parse({
  id: "Q5", title: "Which retry policy?", question: "How should failed charges retry?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop", recommended: "A",
  options: [{ letter: "A", label: "Retry once after a day" }, { letter: "B", label: "Retry hourly" }, { letter: "C", label: "Never retry" }],
});
const typed = "Retry twice, then email the customer";

async function card(props: Record<string, unknown> = {}) {
  const w = workspace({ questions: [question] });
  const client = new QueryClient();
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(QuestionBody, { workspace: w, question, theme, now: clock, ...props }))); }); }
  finally { console.error = orig; }
  const find = (f: (n: Node) => boolean) => r.root.findAll(n => typeof n.type !== "string" && f(n))[0] ?? r.root.findAll(f)[0];
  const press = async (label: RegExp) => { const n = find(x => typeof x.props.onPress === "function" && label.test(String(x.props.accessibilityLabel ?? ""))); assert.ok(n, `a control labelled ${label}`); await act(() => { n.props.onPress(); }); };
  const type = async (text: string) => { const n = find(x => typeof x.props.onChangeText === "function"); assert.ok(n, "the answer field"); await act(() => { n.props.onChangeText(text); }); };
  const settle = () => act(async () => { await new Promise(res => setTimeout(res, 20)); });
  return { press, type, settle, unmount: () => r.unmount(), w };
}
const answers = () => rpcCalls.filter(c => c.name === "follow.answer-question").map(c => c.input);

test("Something else, typed words, Send: the words reach the agent", async () => {
  rpcCalls.length = 0;
  const c = await card();
  await c.press(/Something else/);
  await c.type(typed);
  await c.press(/^Send your Q5 answer/);
  await c.settle();
  assert.deepEqual(answers().map(i => [i.choice, i.words, i.action]), [[OTHER, typed, "send"]], "what was typed is what was sent");
  c.unmount();
});

test("Retry after a failed send sends the words in the box, never an empty payload", async () => {
  rpcCalls.length = 0;
  const w = workspace({ questions: [question] });
  setPendingAnswer(w.id, question.id, { choice: OTHER, words: typed });
  failPendingAnswer(w.id, question.id, "Something else needs your answer in words.");
  const c = await card();
  await c.press(/^Retry sending your Q5 answer/);
  await c.settle();
  assert.deepEqual(answers().map(i => [i.choice, i.words]), [[OTHER, typed]], "Retry sends the kept words");
  clearPendingAnswer(w.id, question.id);
  c.unmount();
});

test("a lettered pick with a note sends the note; a pick without one sends no words", async () => {
  rpcCalls.length = 0;
  const c = await card();
  await c.press(/^Retry once after a day|^A\b|Option A/);
  await c.press(/^Add a note/);
  await c.type("Only for card_declined");
  await c.press(/^Send your Q5 answer/);
  await c.settle();
  assert.deepEqual(answers().map(i => [i.choice, i.words]), [["A", "Only for card_declined"]]);
  c.unmount();
});
