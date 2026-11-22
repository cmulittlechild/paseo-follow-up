// armed-dismiss-shows-remove-and-keep (AGENTS.md invariant 59). 2026-11-22, Tom on 2.3.0-beta.4, about the armed x in
// Needs you: "the word dismiss can also mean to 'dismiss' the operation, a user can click the x on accident, then the
// word dismiss pops up and a clicks it to cancel it." Root cause: the armed x was one red "Dismiss" pill (client/dismiss.tsx,
// DismissX's armed branch) with no visible way back, so the only thing on screen read as the exit, and focus stayed on
// it, so a second Enter dismissed. Q123=A: a quiet "Keep" and a red "Remove". These drive the real DismissX under the
// strict native stand-in (invariant 51); the keyboard tests switch it to web and track focus through node mocks.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
type Root = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown, o?: unknown) => Root; act: (f: () => Promise<void> | void) => Promise<void> };
const { View, Platform } = await import("./support/native/react-native.mjs" as string) as { View: unknown; Platform: { OS: string } };
const dismiss = await import("../client/dismiss");
const { DismissX, disarmDismiss } = dismiss;
const colors = new Proxy({}, { get: () => "#d33c3c" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test.afterEach(() => act(() => { disarmDismiss(); }));

const isButton = (n: Node) => typeof n.type === "string" && n.type === "Pressable";

/**
 * One x on one card. `web` renders it as react-native-web does, with a stand-in focus: each button's node mock records
 * itself as focused, and `enter()` presses whatever has focus, as Enter on a focused button does.
 */
async function card({ web = false } = {}, t?: { after(f: () => void): void }) {
  const saved = Platform.OS;
  if (web) { Platform.OS = "web"; t?.after(() => { Platform.OS = saved; }); }
  let removed = 0;
  let focused: string | null = null;
  let r!: Root;
  await act(() => { r = create(createElement(View, null, createElement(DismissX, { theme, compact: false, label: "Remove Q1", onPress: () => { removed++; } })),
    { createNodeMock: (el: Node) => ({ focus: () => { focused = String(el.props.accessibilityLabel ?? ""); }, setAttribute() {}, contains: () => false }) }); });
  const button = (name: string) => r.root.findAll(n => isButton(n) && n.props.accessibilityLabel === name)[0];
  const x = () => r.root.findAll(n => isButton(n) && String(n.props.accessibilityLabel).startsWith("Remove Q1: "))[0];
  const words = () => r.root.findAll(n => n.type === "Text" && typeof n.props.children === "string").map(n => n.props.children as string);
  const press = (n: Node | undefined, e?: unknown) => act(() => { assert.ok(n, "no such button"); n.props.onPress(e); });
  // The x is focused first (Tab to it), then each Enter presses the focused button.
  // Focus on a button that's gone (unmounted) is focus lost: Enter does nothing.
  const enter = async () => { const n = focused === null ? undefined : focused.startsWith("Remove Q1: ") ? x() : button(focused); if (n) await press(n); };
  return { r, x, button, words, press, enter, removed: () => removed, focus: (label: string) => { focused = label; } };
}

test("armed, the x shows two buttons: a quiet Keep first, then Remove; no word Dismiss", async () => {
  const c = await card();
  await c.press(c.x());
  const labels = c.r.root.findAll(isButton).map(n => n.props.accessibilityLabel);
  assert.deepEqual(labels, ["Keep Q1", "Remove Q1"], "Keep first in reading order, both named for the item");
  assert.ok(c.words().includes("Keep") && c.words().includes("Remove"), "both words on screen");
  assert.ok(!c.words().some(w => /dismiss/i.test(w)), "the word Dismiss is gone from the armed state");
  assert.equal(c.removed(), 0);
  c.r.unmount();
});

test("Keep disarms without removing: the x is back", async () => {
  const c = await card();
  await c.press(c.x());
  await c.press(c.button("Keep Q1"));
  assert.equal(c.removed(), 0, "Keep removes nothing");
  assert.ok(c.x(), "the x is back");
  assert.equal(c.button("Keep Q1"), undefined, "and the pair is gone");
  c.r.unmount();
});

test("Remove removes", async () => {
  const c = await card();
  await c.press(c.x());
  await c.press(c.button("Remove Q1"));
  assert.equal(c.removed(), 1);
  c.r.unmount();
});

test("Enter twice from the x does not remove: arming moves focus to Keep, so the second Enter keeps", async t => {
  const c = await card({ web: true }, t);
  c.focus(c.x().props.accessibilityLabel);
  await c.enter();
  await c.enter();
  assert.equal(c.removed(), 0, "a double Enter must not remove (on main the pill kept focus, so the second Enter dismissed)");
  assert.ok(c.x(), "it's back to the x");
  c.r.unmount();
});

test("a double-click on the x doesn't remove: the second click (DOM detail 2) lands on Remove and is ignored", async () => {
  const c = await card();
  await c.press(c.x(), { nativeEvent: { detail: 1 } });
  await c.press(c.button("Remove Q1"), { nativeEvent: { detail: 2 } });
  assert.equal(c.removed(), 0, "the double-click's second click doesn't remove");
  assert.ok(c.button("Remove Q1"), "still armed");
  await c.press(c.button("Remove Q1"), { nativeEvent: { detail: 1 } });
  assert.equal(c.removed(), 1, "a deliberate click does");
  c.r.unmount();
});

test("the screen reader hears 'Remove, or Keep to cancel'", () => {
  assert.equal(dismiss.DISMISS_CONFIRM, "Remove, or Keep to cancel");
});

test("Tab between Keep and Remove keeps it armed; focus leaving the pair disarms", async () => {
  let inside = true;
  const saved = Platform.OS; Platform.OS = "web";
  try {
    let r!: Root;
    await act(() => { r = create(createElement(DismissX, { theme, compact: false, label: "Remove Q1", onPress: () => {} }), { createNodeMock: () => ({ focus() {}, setAttribute() {}, contains: () => inside }) }); });
    const b = (name: string) => r.root.findAll(n => isButton(n) && n.props.accessibilityLabel === name)[0];
    await act(() => { r.root.findAll(n => isButton(n))[0].props.onPress(); });
    await act(() => { b("Keep Q1").props.onBlur({ nativeEvent: { relatedTarget: "Remove" } }); });
    assert.ok(b("Remove Q1"), "Tab from Keep to Remove stays armed");
    inside = false;
    await act(() => { b("Remove Q1").props.onBlur({ nativeEvent: { relatedTarget: "the next card" } }); });
    assert.equal(b("Remove Q1"), undefined, "Tab past Remove disarms");
    r.unmount();
  } finally { Platform.OS = saved; }
});

test("Esc disarms and hands focus back to the x", async t => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, add: g.addEventListener, remove: g.removeEventListener };
  const on = new Map<string, Set<(e: unknown) => void>>();
  const target = { addEventListener: (k: string, f: (e: unknown) => void) => { if (!on.has(k)) on.set(k, new Set()); on.get(k)!.add(f); }, removeEventListener: (k: string, f: (e: unknown) => void) => { on.get(k)?.delete(f); } };
  g.document = target; g.addEventListener = target.addEventListener; g.removeEventListener = target.removeEventListener;
  t.after(() => { g.document = saved.document; g.addEventListener = saved.add; g.removeEventListener = saved.remove; });
  const c = await card({ web: true }, t);
  c.focus(c.x().props.accessibilityLabel);
  await c.enter();
  assert.ok(c.button("Keep Q1"), "armed");
  await act(() => { for (const f of [...(on.get("keydown") ?? [])]) f({ key: "Escape", preventDefault() {}, stopPropagation() {} }); });
  assert.ok(c.x(), "Esc disarms");
  await c.enter();
  assert.ok(c.button("Keep Q1"), "focus is on the x again: Enter arms it, rather than landing nowhere");
  assert.equal(c.removed(), 0);
  c.r.unmount();
});
