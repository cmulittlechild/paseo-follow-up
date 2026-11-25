// Invariant 113 (row-badges-replace-sidebar-labels), the client half: on a Paseo with workspace-row badges Follow-up
// registers exactly one item (Done, its own Show-menu toggle) fed by the live store it already has; on an older
// Paseo nothing registers, so the worker's Done label is the only Done on the row.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";

register("./support/native/hooks.mjs", import.meta.url);
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: { type: unknown; props: Record<string, unknown> }) => boolean): { props: Record<string, unknown> }[] }; update(el: unknown): void; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { contributeRowBadges } = await import("../client/row-badges");
const { listEntry } = await import("../shared/list");
const { clock, workspace, pr, snapshot } = await import("./fixtures");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const done = workspace({ id: "w-done", prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } });
const open = workspace({ id: "w-open" });

function liveStore(rows: ReturnType<typeof workspace>[]) {
  let map = new Map(rows.map(w => [w.id, listEntry(w)]));
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get: (id: string) => map.get(id),
    set(rows: ReturnType<typeof workspace>[]) { map = new Map(rows.map(w => [w.id, listEntry(w)])); for (const l of listeners) l(); },
  };
}

test("an older Paseo gets no row badge item", () => {
  const remove = contributeRowBadges({} as never, liveStore([]) as never);
  assert.equal(typeof remove, "function");
  remove();
});

test("a Paseo with row badges gets one Done item that shows only on Done rows", async t => {
  const items: { id: string; title: string; icon: string; Component: (p: { workspaceId: string }) => unknown }[] = [];
  let removed = 0;
  const store = liveStore([done, open]);
  const remove = contributeRowBadges({ addWorkspaceRowBadgeItem: (c: never) => { items.push(c); return () => { removed++; }; } } as never, store as never);
  assert.deepEqual(items.map(({ id, title, icon }) => ({ id, title, icon })), [{ id: "done", title: "Follow-up: Done", icon: "CircleCheck" }]);
  const Done = items[0].Component as never;
  const badges = (r: ReturnType<typeof create>) => r.root.findAll(n => typeof n.type === "string" && n.props.testID === "row-badge").map(n => n.props.accessibilityLabel);
  let a!: ReturnType<typeof create>, b!: ReturnType<typeof create>, c!: ReturnType<typeof create>;
  t.after(() => act(() => { for (const r of [a, b, c]) r?.unmount(); }));
  await act(() => { a = create(createElement(Done, { workspaceId: "w-done" })); b = create(createElement(Done, { workspaceId: "w-open" })); c = create(createElement(Done, { workspaceId: "not-followed" })); });
  assert.deepEqual(badges(a), ["Follow-up: Done"]);
  assert.deepEqual(badges(b), []);
  assert.deepEqual(badges(c), []);
  // The store's next push (the worker's feed) moves the badge with no read of its own.
  await act(() => { store.set([{ ...done, completion: null }, { ...open, prs: done.prs, completion: done.completion }]); });
  assert.deepEqual(badges(a), []);
  assert.deepEqual(badges(b), ["Follow-up: Done"]);
  remove();
  assert.equal(removed, 1);
});
