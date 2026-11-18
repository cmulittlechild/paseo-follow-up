// client-renders-under-native-rules (AGENTS.md invariant 51). 2026-11-18, Tom on 2.2.0-beta.4, in the Paseo
// phone app: tapping More context in Catch up crashed the whole app. Every render and test ran on react-native-web,
// which accepts what the phone's React Native rejects. These render the phone paths under a strict native stand-in
// (tests/support/native: no DOM, Platform android, a host view throws on text outside <Text> and on an
// accessibilityRole Android's view manager rejects), through react-test-renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
// Untyped on purpose: react-test-renderer ships no types, and the stand-in is plain JavaScript.
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: { type: unknown; props: Record<string, unknown> }) => boolean): { props: Record<string, unknown> }[] } }; act: (f: () => Promise<void>) => Promise<void> };
const { MoveResult, MorePanel, ContextAnswer, Finished, KeysSheet } = await import("../client/catch-up");
const { ANDROID_ROLES } = await import("./support/native/react-native.mjs" as string) as { ANDROID_ROLES: Set<string> };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(el: unknown) {
  let r: ReturnType<typeof create> | undefined; let error: unknown = null;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(el); }); } catch (e) { error = e; } finally { console.error = orig; }
  return { r, error };
}

test("the stand-in reads Android's own role list and rejects what Android rejects", () => {
  assert.ok(ANDROID_ROLES.has("button") && ANDROID_ROLES.has("radiogroup") && !ANDROID_ROLES.has("dialog"));
});

test("More context on a phone: the sheet (MoveResult) with its panel renders under the phone's rules", async () => {
  const { r, error } = await render(createElement(MoveResult, { place: "sheet", theme, label: "More context" },
    createElement(MorePanel, { theme, compact: true, onClose: () => {}, onAsk: async () => {} })));
  assert.equal(error, null, `crashed on a phone: ${(error as Error)?.message}`);
  const sheet = r!.root.findAll(n => n.props.accessibilityLabel === "More context" && typeof n.type === "string")[0];
  assert.ok(sheet, "the sheet is on screen");
  assert.equal(sheet.props.role, "dialog", "a dialog by the ARIA role, which Android parses leniently");
  assert.ok(r!.root.findAll(n => n.props.accessibilityLabel === "What do you want to know?").length, "the ask box");
});

test("Later on a phone: the same sheet renders its choices under the phone's rules", async () => {
  const { error } = await render(createElement(MoveResult, { place: "sheet", theme, label: "Later" },
    createElement("View", { accessibilityRole: "menu", accessibilityLabel: "Later" })));
  assert.equal(error, null, `crashed on a phone: ${(error as Error)?.message}`);
});

test("the rest of Catch up that a phone shows renders under the phone's rules: the end, every context answer", async () => {
  const stats = { done: 3, skipped: 2, later: 1, gone: 1, waiting: 1 };
  for (const [name, el] of [
    ["the end with cards left", createElement(Finished, { theme, compact: true, stats, empty: false, onHome: () => {}, onSkipped: () => {} })],
    ["all caught up", createElement(Finished, { theme, compact: true, stats: { done: 2, skipped: 0, later: 0, gone: 0, waiting: 0 }, empty: false, onHome: () => {}, onSkipped: () => {} })],
    ["nothing needs you", createElement(Finished, { theme, compact: true, stats: { done: 0, skipped: 0, later: 0, gone: 0, waiting: 0 }, empty: true, onHome: () => {}, onSkipped: () => {} })],
    ["the keys sheet", createElement(KeysSheet, { theme, onClose: () => {} })],
    ...(["asking", "answered", "chat", "failed"] as const).flatMap(state => (["agent", "overseer"] as const).map(target => [`a context ask, ${target}, ${state}`,
      createElement(ContextAnswer, { theme, compact: true, waiting: state === "asking", agent: "acme-agent", openChat: () => {}, openAgent: () => {},
        request: { id: "r1", workspaceId: "w1", agentId: "a1", cardKey: "agent:a1|Q1", card: "Q1 · Retry declined cards?", ask: "I don't get it. What is this about?", target, state, askedOf: "a1", askedAt: 1, answer: state === "answered" ? "**Retry** once after a day." : undefined, error: state === "failed" ? "The agent is gone." : undefined } as never })])),
  ] as const) {
    const { error } = await render(el as never);
    assert.equal(error, null, `${name} crashed on a phone: ${(error as Error)?.message}`);
  }
});
