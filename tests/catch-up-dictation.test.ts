// dictated-text-lands-in-the-field (AGENTS.md invariant 55). Tom, 2026-11-18 on 2.2.0: "add a microphone icon to the
// catch up mode to dictate my answer". The mic uses Paseo's own dictation (usePaseoDictation, a Paseo plugin API) when
// the host has it, and is absent otherwise. Dictated words land in the answer field's own words (invariant 53), at the
// caret, editable, and nothing is sent until Send. These render the real QuestionBody under the native stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, OTHER, type Question } from "../shared/questions";
import { hostDictationHook, insertDictated, micView, type HostDictation } from "../shared/dictation";
import { CATCH_UP_KEYS, catchUpKey, type KeyPress } from "../shared/catch-up";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { rpcCalls, dictationHost } = await import("./support/native/plugin-client.mjs" as string) as {
  rpcCalls: { name: string; input: Record<string, unknown> }[];
  dictationHost: { set(hook: unknown): void };
};

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const question: Question = questionSchema.parse({
  id: "Q5", title: "Which retry policy?", question: "How should failed charges retry?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop", recommended: "A",
  options: [{ letter: "A", label: "Retry once after a day" }, { letter: "B", label: "Retry hourly" }, { letter: "C", label: "Never retry" }],
});

/** A fake host: Paseo's hook shape, driven by the test. */
function fakeHost(init: Partial<Pick<HostDictation, "unavailable" | "status" | "error">> = {}) {
  const ctl = { status: init.status ?? "idle", unavailable: init.unavailable ?? null, error: init.error ?? null, volume: 0.4,
    calls: [] as string[], onText: (_: string) => {}, bump: () => {} };
  const hook = ({ onText }: { onText(text: string): void }): HostDictation => {
    const [, set] = useState(0);
    ctl.onText = onText; ctl.bump = () => set(x => x + 1);
    return { unavailable: ctl.unavailable, status: ctl.status, volume: ctl.volume, error: ctl.error,
      start: async () => { ctl.calls.push("start"); ctl.status = "listening"; ctl.bump(); },
      stop: async () => { ctl.calls.push("stop"); ctl.status = "transcribing"; ctl.bump(); },
      cancel: async () => { ctl.calls.push("cancel"); ctl.status = "idle"; } };
  };
  return { ctl, hook };
}

async function card(props: Record<string, unknown> = { dictate: true }) {
  const w = workspace({ questions: [question] });
  const client = new QueryClient();
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(QuestionBody, { workspace: w, question, theme, now: clock, compact: false, ...props }))); }); }
  finally { console.error = orig; }
  const all = (f: (n: Node) => boolean) => r.root.findAll(n => typeof n.type !== "string" && f(n));
  const labelled = (label: RegExp) => all(x => typeof x.props.onPress === "function" && label.test(String(x.props.accessibilityLabel ?? "")))[0];
  const press = async (label: RegExp) => { const n = labelled(label); assert.ok(n, `a control labelled ${label}`); await act(() => { n.props.onPress(); }); };
  const field = () => all(x => typeof x.props.onChangeText === "function")[0];
  const type = async (text: string) => { const n = field(); assert.ok(n, "the answer field"); await act(() => { n.props.onChangeText(text); }); };
  const caretAt = async (start: number, end = start) => { await act(() => { field().props.onSelectionChange?.({ nativeEvent: { selection: { start, end } } }); }); };
  const texts = () => all(x => typeof x.props.children === "string").map(x => x.props.children as string);
  return { press, type, caretAt, labelled, field, texts, act, unmount: () => r.unmount() };
}
const answers = () => rpcCalls.filter(c => c.name === "follow.answer-question").map(c => c.input);

test.afterEach(() => dictationHost.set(undefined));

test("the host's hook is detected by name; a Paseo without it has none", () => {
  const fn = () => ({});
  assert.equal(hostDictationHook({ usePaseoDictation: fn }), fn);
  assert.equal(hostDictationHook({}), null);
  assert.equal(hostDictationHook({ usePaseoDictation: "yes" }), null);
  assert.equal(hostDictationHook(null), null);
});

test("on a Paseo without dictation there is no mic, no hint and no space for one", async () => {
  const c = await card();
  await c.press(/Something else/);
  assert.equal(!!c.labelled(/Dictat/), false, "no mic");
  assert.ok(!c.texts().some(t => /dictat/i.test(t)), "no hint");
  assert.ok(c.field(), "the field is there as before");
  c.unmount();
});

test("a surface that doesn't ask for dictation has no mic even on a host with it", async () => {
  dictationHost.set(fakeHost().hook);
  const c = await card({});
  await c.press(/Something else/);
  assert.equal(!!c.labelled(/Dictat/), false);
  c.unmount();
});

test("tap to start, tap to stop: the words land in the answer field, and only Send sends them", async () => {
  rpcCalls.length = 0;
  const { ctl, hook } = fakeHost();
  dictationHost.set(hook);
  const c = await card();
  await c.press(/Something else/);
  await c.press(/^Dictate \(V\)$/);
  assert.deepEqual(ctl.calls, ["start"]);
  assert.ok(c.labelled(/^Stop dictating/), "listening shows Stop");
  assert.ok(c.texts().some(t => /^Listening ·/.test(t)), "and says it's listening");
  await c.press(/^Stop dictating/);
  assert.deepEqual(ctl.calls, ["start", "stop"]);
  assert.ok(c.texts().includes("Writing it down…"), "transcribing says so");
  await c.act(() => { ctl.status = "idle"; ctl.onText("retry twice then email the customer"); ctl.bump(); });
  assert.equal(c.field().props.value, "retry twice then email the customer", "the words are in the field");
  assert.deepEqual(answers(), [], "nothing was sent by dictation");
  await c.type(`${c.field().props.value}.`);
  await c.press(/^Send your Q5 answer/);
  await c.act(async () => { await new Promise(res => setTimeout(res, 20)); });
  assert.deepEqual(answers().map(i => [i.choice, i.words]), [[OTHER, "retry twice then email the customer."]], "what's in the field is what's sent");
  c.unmount();
});

test("dictated words go in at the caret, beside what was typed", async () => {
  const { ctl, hook } = fakeHost();
  dictationHost.set(hook);
  const c = await card();
  await c.press(/Something else/);
  await c.type("Retry twice.");
  await c.caretAt(0);
  await c.act(() => { ctl.onText("Only on weekdays:"); ctl.bump(); });
  assert.equal(c.field().props.value, "Only on weekdays: Retry twice.");
  c.unmount();
});

test("a note on a lettered pick takes the same mic, and the note is what's sent", async () => {
  rpcCalls.length = 0;
  const { ctl, hook } = fakeHost();
  dictationHost.set(hook);
  const c = await card();
  await c.press(/^Retry once after a day|^A\b|Option A/);
  await c.press(/^Add a note/);
  assert.ok(c.labelled(/^Dictate/), "the note field has the mic");
  await c.act(() => { ctl.onText("only for card_declined"); ctl.bump(); });
  await c.press(/^Send your Q5 answer/);
  await c.act(async () => { await new Promise(res => setTimeout(res, 20)); });
  assert.deepEqual(answers().map(i => [i.choice, i.words]), [["A", "only for card_declined"]]);
  c.unmount();
});

test("unavailable says why in one line when pressed; it never just does nothing", async () => {
  const { ctl, hook } = fakeHost({ unavailable: { reason: "disconnected", message: null } });
  dictationHost.set(hook);
  const c = await card();
  await c.press(/Something else/);
  assert.ok(!c.texts().some(t => /^Can't dictate/.test(t)), "quiet until asked");
  await c.press(/^Dictation isn't available/);
  assert.deepEqual(ctl.calls, [], "nothing started");
  assert.ok(c.texts().includes("Can't dictate: the host is offline"));
  c.unmount();
});

test("a failed start (microphone permission denied) says so under the field", async () => {
  const { hook } = fakeHost({ error: "Permission denied." });
  dictationHost.set(hook);
  const c = await card();
  await c.press(/Something else/);
  assert.ok(c.texts().includes("Couldn't dictate: microphone access is blocked. Allow it for Paseo in your settings"));
  c.unmount();
});

test("leaving the card while listening cancels the recording", async () => {
  const { ctl, hook } = fakeHost();
  dictationHost.set(hook);
  const c = await card();
  await c.press(/Something else/);
  await c.press(/^Dictate/);
  await c.act(() => c.unmount());
  assert.deepEqual(ctl.calls, ["start", "cancel"]);
});

test("the mic's states: idle, listening, transcribing, unavailable, failed", () => {
  const base = { unavailable: null, error: null } as const;
  assert.deepEqual(micView({ ...base, status: "idle" }), { state: "idle", icon: "Mic", label: "Dictate", line: null, tone: "danger", disabled: false });
  assert.equal(micView({ ...base, status: "idle" }, { key: true }).label, "Dictate (V)");
  assert.equal(micView({ ...base, status: "listening" }).state, "listening");
  assert.equal(micView({ ...base, status: "listening" }).tone, "live");
  assert.equal(micView({ ...base, status: "listening" }, { key: true }).line, "Listening · Stop (V) adds it to your answer");
  assert.equal(micView({ ...base, status: "idle", error: "Network error." }).line, "Couldn't dictate: network error");
  assert.equal(micView({ ...base, status: "transcribing" }).disabled, true);
  assert.equal(micView({ unavailable: { reason: "not_ready", message: "Speech-to-text model is downloading." }, status: "idle", error: null }, { explain: true }).line,
    "Can't dictate: speech-to-text model is downloading");
  assert.equal(micView({ unavailable: { reason: "not_ready", message: null }, status: "idle", error: null }, { explain: true }).line,
    "Can't dictate: set up speech-to-text in Paseo's settings");
  // A recording already under way keeps its Stop even if the host drops readiness meanwhile.
  assert.equal(micView({ unavailable: { reason: "disconnected", message: null }, status: "listening", error: null }).state, "listening");
});

test("insertDictated: at the caret, over a selection, one space apart, within the limit", () => {
  assert.deepEqual(insertDictated("", "  hello  world "), { words: "hello world", caret: 11 });
  assert.deepEqual(insertDictated("Retry twice.", "and email", { start: 11, end: 11 }), { words: "Retry twice and email.", caret: 21 });
  assert.deepEqual(insertDictated("Retry twice.", "Only weekdays:", { start: 0, end: 0 }), { words: "Only weekdays: Retry twice.", caret: 14 });
  assert.deepEqual(insertDictated("Retry hourly please", "daily", { start: 6, end: 12 }), { words: "Retry daily please", caret: 11 });
  assert.equal(insertDictated("abc", "defgh", null, 6).words, "abc de");
  assert.deepEqual(insertDictated("full", "more", null, 4), { words: "full", caret: 4 });
  assert.deepEqual(insertDictated("kept", "   "), { words: "kept", caret: 4 });
});

test("V is Catch up's dictation key, listed only where the host has dictation", () => {
  const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, meta: false, ctrl: false, alt: false, shift: false, mac: true, ...extra });
  const idle = { typing: false, inMore: false, moreOpen: false, inRail: false };
  assert.deepEqual(catchUpKey(press("v"), idle), { action: "dictate" });
  assert.equal(catchUpKey(press("v"), { ...idle, typing: true }), null, "in a field V is a letter");
  assert.equal(catchUpKey(press("d", { meta: true }), idle), null, "⌘D stays Paseo's");
  assert.equal(CATCH_UP_KEYS.find(k => k.action === "dictate")?.needs, "dictation");
});
