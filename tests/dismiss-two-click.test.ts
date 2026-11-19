// dismiss-takes-two-clicks-in-place (AGENTS.md invariant 59). 2026-11-19, Tom on 2.3.0-beta.2, about the small x that
// dismisses anything in Needs you: "This is a destructive action, so maybe we should have a confirmation pop-up?",
// then Q113=B: "Two clicks, in place: the first click turns the x into a small red 'Dismiss' button on the card; a
// second click confirms; clicking elsewhere or Esc cancels. No pop-up, no accidental dismiss. Undo stays." One click
// dismissed at once on main. These drive the real DismissX under the strict native stand-in (invariant 51), with a
// stand-in document for the web-only cancels (a click elsewhere, Esc).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
type Root = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown, o?: unknown) => Root; act: (f: () => Promise<void> | void) => Promise<void> };
const { View } = await import("./support/native/react-native.mjs" as string) as { View: unknown };
const { DismissX, disarmDismiss, DISMISS_ARM_MS, DISMISS_CONFIRM } = await import("../client/dismiss");
const colors = new Proxy({}, { get: () => "#d33c3c" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Two x's (two cards), each counting its dismissals. */
async function two(options?: unknown) {
  const pressed = { a: 0, b: 0 };
  let r!: Root;
  await act(() => { r = create(createElement(View, null,
    createElement(DismissX, { theme, compact: true, label: "Dismiss Q1", onPress: () => { pressed.a++; } }),
    createElement(DismissX, { theme, compact: true, label: "Dismiss #12 is approved", onPress: () => { pressed.b++; } })), options); });
  const x = (name: "a" | "b") => r.root.findAll(n => typeof n.type === "string" && n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith(name === "a" ? "Dismiss Q1" : "Dismiss #12"))[0];
  const armed = (name: "a" | "b") => String(x(name).props.accessibilityLabel).endsWith(DISMISS_CONFIRM);
  const press = (name: "a" | "b") => act(() => { x(name).props.onPress(); });
  return { r, pressed, x, armed, press };
}

/** A stand-in document and window: the web cancels listen there. */
function fakeWeb(t: { after(f: () => void): void }) {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, add: g.addEventListener, remove: g.removeEventListener };
  const on = new Map<string, Set<(e: unknown) => void>>();
  const target = { addEventListener: (k: string, f: (e: unknown) => void) => { if (!on.has(k)) on.set(k, new Set()); on.get(k)!.add(f); }, removeEventListener: (k: string, f: (e: unknown) => void) => { on.get(k)?.delete(f); } };
  g.document = target; g.addEventListener = target.addEventListener; g.removeEventListener = target.removeEventListener;
  t.after(() => { g.document = saved.document; g.addEventListener = saved.add; g.removeEventListener = saved.remove; });
  return (type: string, e: Record<string, unknown>) => act(() => { for (const f of [...(on.get(type) ?? [])]) f(e); });
}

test.afterEach(() => act(() => { disarmDismiss(); }));

test("one click doesn't dismiss: it arms the x (a red Dismiss pill, announced); the second click dismisses", async () => {
  const { r, pressed, x, armed, press } = await two();
  await press("a");
  assert.equal(pressed.a, 0, "the first click dismisses nothing");
  assert.ok(armed("a"), "it arms: screen readers hear 'Press again to dismiss'");
  assert.ok(String(x("a").props.accessibilityLabel).startsWith("Dismiss Q1"), "still found as Dismiss (Catch up's Shift+D clicks it again to confirm)");
  assert.ok(r.root.findAll(n => n.type === "Text" && n.props.children === "Dismiss").length === 1, "the armed x shows the word Dismiss");
  await press("a");
  assert.equal(pressed.a, 1, "the second click dismisses");
  assert.ok(!armed("a"), "and it's back to the x");
  await act(() => { r.unmount(); });
});

test("the armed pill lays out exactly as the x did: nothing beside it moves", async () => {
  const { r, x, press } = await two();
  const footprint = (s: Record<string, number>) => s.width + (s.marginLeft ?? s.margin) + (s.marginRight ?? s.margin);
  const before = x("a").props.style({ pressed: false });
  await press("a");
  const after = x("a").props.style({ pressed: false });
  assert.ok(after.width > before.width, "it grows (leftward)");
  assert.equal(footprint(after), footprint(before), "its layout width is the x's");
  assert.equal(after.height, before.height, "and its height, so the 40 px phone hit area stays");
  await act(() => { r.unmount(); });
});

test("only one x is armed at a time: arming another disarms the first", async () => {
  const { r, pressed, armed, press } = await two();
  await press("a");
  await press("b");
  assert.ok(!armed("a") && armed("b"));
  assert.deepEqual(pressed, { a: 0, b: 0 }, "neither dismissed");
  await press("a");
  assert.ok(armed("a") && !armed("b"));
  assert.deepEqual(pressed, { a: 0, b: 0 });
  await act(() => { r.unmount(); });
});

test("it disarms quietly after DISMISS_ARM_MS untouched, so a later click arms again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { r, pressed, armed, press } = await two();
  await press("a");
  await act(() => { t.mock.timers.tick(DISMISS_ARM_MS - 100); });
  assert.ok(armed("a"), "still armed just before the timeout");
  await act(() => { t.mock.timers.tick(200); });
  assert.ok(!armed("a"), "disarmed");
  await press("a");
  assert.equal(pressed.a, 0, "a click after the timeout arms again; it doesn't dismiss");
  await act(() => { r.unmount(); });
});

test("a click or tap elsewhere disarms; a click on the pill itself doesn't", async t => {
  const fire = fakeWeb(t);
  const { r, pressed, armed, press } = await two({ createNodeMock: () => ({ contains: (target: unknown) => target === "the pill" }) });
  await press("a");
  await fire("pointerdown", { target: "the pill" });
  assert.ok(armed("a"), "pressing the pill itself keeps it armed for its click");
  await fire("pointerdown", { target: "the card's title" });
  assert.ok(!armed("a"), "a click anywhere else disarms");
  assert.equal(pressed.a, 0);
  await act(() => { r.unmount(); });
});

test("Esc disarms, and is taken: nothing else handles that Esc", async t => {
  const fire = fakeWeb(t);
  const { r, pressed, armed, press } = await two();
  await press("a");
  let stopped = 0;
  await fire("keydown", { key: "Escape", preventDefault: () => { stopped++; }, stopPropagation: () => { stopped++; } });
  assert.ok(!armed("a"));
  assert.equal(stopped, 2, "default prevented and propagation stopped");
  assert.equal(pressed.a, 0);
  await act(() => { r.unmount(); });
});

test("focus leaving the armed x disarms it", async () => {
  const { r, pressed, x, armed, press } = await two();
  await press("a");
  await act(() => { x("a").props.onBlur(); });
  assert.ok(!armed("a"));
  assert.equal(pressed.a, 0);
  await act(() => { r.unmount(); });
});
