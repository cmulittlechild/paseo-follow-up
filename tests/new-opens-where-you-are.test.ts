// new-opens-where-you-are (client/new.tsx): New shows on the host the developer can see. Paseo 0.17 keeps a Home
// mounted behind when Home is opened again (New from a chat opens Home with `?new=…`; the sidebar's Follow-up then
// pushes a second Home and hides the first), and the first mounted host used to take every later New: the developer
// landed on Home and nothing opened. Under the strict native stand-in; each host's probe answers checkVisibility as
// Paseo's web DOM would. Fixtures are fictional (ACME).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, unknown> };
type Root = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown, o?: unknown) => Root; act: (f: () => Promise<void> | void) => Promise<void> };
const { rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpc: { reply: (name: string, input: unknown) => unknown } };
const newModule = await import("../client/new");
const { NewHost, openNew, closeNew, setNewFallback } = newModule;

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const desktop = { compact: false } as never;
rpc.reply = (name: string) => {
  if (name === "follow.dispatch-sources") return { linear: { status: "ok", issues: [], at: Date.now(), more: false }, routes: {}, recent: [] };
  if (name === "follow.dispatch-records") return { records: [] };
  return {};
};

const tick = (ms = 30) => act(async () => { await new Promise(res => setTimeout(res, ms)); });
/** A Home's host whose probe is on screen while `shown.on` (display:none in Paseo's web DOM otherwise). */
async function mountHost(shown: { on: boolean }, Host: unknown = NewHost, props: Record<string, unknown> = { theme, layout: desktop }): Promise<Root> {
  let r: Root | undefined;
  const orig = console.error; console.error = () => {};
  try {
    await act(async () => { r = create(createElement(Host, props), { createNodeMock: () => ({ checkVisibility: () => shown.on }) }); });
    await tick();
  } finally { console.error = orig; }
  return r!;
}
const dialogs = (r: Root) => r.root.findAll(n => typeof n.type === "string" && n.props.role === "dialog" && n.props["aria-label"] === "New").length;

test("a Home kept mounted behind never takes New: the Home on screen shows it", async () => {
  closeNew();
  const navigated: unknown[] = [];
  setNewFallback(r => navigated.push(r));
  const behind = { on: false }, front = { on: true };
  // The first Home (opened with ?new=1) is hidden behind; the second (the sidebar's Follow-up) is on screen.
  const first = await mountHost(behind);
  const second = await mountHost(front);
  await act(async () => { openNew(); }); await tick();
  assert.equal(dialogs(first), 0, "the hidden Home shows nothing");
  assert.equal(dialogs(second), 1, "the Home on screen shows New");
  assert.deepEqual(navigated, [], "a Home is on screen: no navigation");
  await act(async () => { closeNew(); });
  // Home's own + New and the key, again: still the visible one.
  await act(async () => { openNew(); }); await tick();
  assert.equal(dialogs(first) + dialogs(second), 1);
  assert.equal(dialogs(second), 1);
  await act(async () => { closeNew(); first.unmount(); second.unmount(); });
  setNewFallback(null);
});

test("with no Home on screen the request waits, navigates once, and the first Home on screen shows it", async () => {
  closeNew();
  const navigated: unknown[] = [];
  setNewFallback(r => navigated.push(r));
  const behind = { on: false };
  const hidden = await mountHost(behind);
  await act(async () => { openNew({}); }); await tick();
  assert.deepEqual(navigated, [{}], "only a hidden Home: open Home");
  assert.equal(dialogs(hidden), 0, "never on the hidden one");
  assert.ok(newModule.newRequestNow(), "the request is kept, not lost");
  // Home's `new` param effect: the request is already there and never navigates again.
  const front = { on: true };
  const shown = await mountHost(front);
  await act(async () => { openNew({}, { navigate: null }); }); await tick();
  assert.equal(navigated.length, 1, "Home's param never navigates again");
  assert.equal(dialogs(shown), 1);
  assert.equal(dialogs(hidden), 0);
  await act(async () => { closeNew(); hidden.unmount(); shown.unmount(); });
  setNewFallback(null);
});

test("a kept request shows once its Home comes on screen, and an open dialog stays where it is", async () => {
  closeNew();
  setNewFallback(() => {});
  const a = { on: false };
  const homeA = await mountHost(a);
  await act(async () => { openNew(); }); await tick();
  assert.equal(dialogs(homeA), 0);
  // Paseo brings the kept Home forward: no mount, only visibility. The open request follows within a few frames.
  a.on = true; await tick(400);
  assert.equal(dialogs(homeA), 1, "shown once its Home is on screen");
  // A second Home mounting on screen never moves an open dialog (it would lose what the developer typed).
  const homeB = await mountHost({ on: true });
  assert.equal(dialogs(homeA), 1);
  assert.equal(dialogs(homeB), 0);
  await act(async () => { closeNew(); homeA.unmount(); homeB.unmount(); });
  setNewFallback(null);
});

test("pickHost: keep the showing host while on screen, else the newest on screen, never a hidden one", async () => {
  const { pickHost: pickNewHost } = await import("../client/host-slot");
  assert.equal(pickNewHost([{ id: 1, visible: false }, { id: 2, visible: true }], null), 2);
  assert.equal(pickNewHost([{ id: 1, visible: true }, { id: 2, visible: true }], null), 2);
  assert.equal(pickNewHost([{ id: 1, visible: true }, { id: 2, visible: true }], 1), 1);
  assert.equal(pickNewHost([{ id: 1, visible: false }, { id: 2, visible: true }], 1), 2);
  assert.equal(pickNewHost([{ id: 1, visible: false }], null), null);
  assert.equal(pickNewHost([], null), null);
});

// The class: every request one of several surfaces shows goes through client/host-slot.tsx, never "the first mounted".
test("a slot's request shows on the host on screen; New, Report and Rename all use the slot", async () => {
  const { createHostSlot } = await import("../client/host-slot");
  const slot = createHostSlot<{ what: string }>();
  const Probe = () => { const { request, probe } = slot.useHost(); return createElement("View", null, probe, request ? createElement("Text", { testID: "shown" }, request.what) : null); };
  const hidden = await mountHost({ on: false }, Probe, {});
  const shown = await mountHost({ on: true }, Probe, {});
  const later = await mountHost({ on: false }, Probe, {});
  const has = (r: Root) => r.root.findAll(n => n.props?.testID === "shown").length;
  await act(async () => { slot.open({ what: "report" }); }); await tick();
  assert.deepEqual([has(hidden), has(shown), has(later)], [0, 1, 0]);
  await act(async () => { slot.close(); hidden.unmount(); shown.unmount(); later.unmount(); });

  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../client/", import.meta.url);
  // Toasts lead from the first host on purpose: on web the leader draws into a layer on document.body, so its own
  // place on screen doesn't matter, and phones keep no hidden screen.
  const EXEMPT = new Set(["toasts.tsx"]);
  for (const f of readdirSync(dir).filter(f => /\.tsx?$/.test(f) && !EXEMPT.has(f))) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /hosts\[0\]/, `${f} picks the first mounted host; use createHostSlot (client/host-slot.tsx)`);
  }
  for (const f of ["new.tsx", "report-issue.tsx", "rename.tsx"]) assert.match(readFileSync(new URL(f, dir), "utf8"), /createHostSlot</, `${f} opens through the host slot`);
});

// Phone render, 2026-11-23: New left open in a Home the developer navigated away from kept the request, so the next
// New key press closed it (the toggle) and nothing opened. A shown request whose host leaves the screen is dropped,
// and the key closes New only while it's on screen.
test("a shown New left behind is dropped, and the key closes only what's on screen", async () => {
  closeNew();
  setNewFallback(() => {});
  const home = { on: true };
  const r = await mountHost(home);
  await act(async () => { openNew(); }); await tick();
  assert.equal(dialogs(r), 1);
  assert.equal(newModule.newShowing(), true, "on screen: the key closes it");
  home.on = false; await tick(300);
  assert.equal(newModule.newShowing(), false, "off screen: the key opens New where the developer is");
  await tick(1300);
  assert.equal(newModule.newRequestNow(), null, "left behind for good: dropped, never reappearing later");
  home.on = true; await tick(400);
  assert.equal(dialogs(r), 0, "coming back to that Home shows nothing on its own");
  // A request never shown still waits (the navigation to Home takes longer than the grace).
  home.on = false; await act(async () => { openNew(); }); await tick(1600);
  assert.ok(newModule.newRequestNow(), "never shown: kept");
  home.on = true; await tick(400);
  assert.equal(dialogs(r), 1);
  await act(async () => { closeNew(); r.unmount(); });
  setNewFallback(null);
});
