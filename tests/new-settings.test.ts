// Settings → New work (client/new-settings.tsx, shared/new-settings.ts): what each action row says, the learned-team
// offers, the category's line, and the screen under the strict native stand-in: opening it reads only New's own
// settings (no Linear, no timer), and every control sends the change the agent tools send. Fixtures are fictional
// (ACME, OPS, acme/web, example/app).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { BUILTIN_ACTIONS, effectiveActions, type DispatchAction } from "../shared/dispatch";
import { actionRows, isEdited, learnedTeams, newWorkSummary, teamKey, type SettingsView } from "../shared/new-settings";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  rules: [{ team: "ACME", projectId: "p-web", project: "acme/web" }], bases: [{ projectId: "p-web", project: "acme/web", base: "develop" }],
  noTeam: "last", lastProjectId: "p-web", learned: { OPS: { "p-app": 4, "p-web": 1 }, ACME: { "p-web": 9 }, WEB: { "p-app": 1 } },
  projects: [{ id: "p-web", name: "acme/web", repo: "acme/web", worktree: true }, { id: "p-app", name: "example/app", repo: "example/app", worktree: true }, { id: "p-notes", name: "notes", repo: null, worktree: false }],
  ...over,
});

test("action rows: ↵ and ⌥↵ follow New's own order, hidden and PR-only actions don't take a key", () => {
  const rows = actionRows(effectiveActions(null));
  assert.deepEqual(rows.map(r => [r.name, r.key]), [["Create PR", "↵"], ["Plan as artifact", "⌥↵"], ["Investigate", null], ["Just open", null], ["Check out PR", null]]);
  assert.equal(rows.find(r => r.id === "checkout")!.scope, "PRs only");
  assert.ok(rows.find(r => r.id === "open")!.hidden);
  assert.ok(rows[0].first && !rows[0].last && rows.at(-1)!.last);
  // Hiding Create PR moves ↵ to the next shown one.
  const hid = actionRows(effectiveActions(null).map(a => a.id === "pr" ? { ...a, hidden: true } : a));
  assert.deepEqual(hid.filter(r => r.key).map(r => [r.id, r.key]), [["plan", "↵"], ["investigate", "⌥↵"]]);
});

test("action rows: an edited built-in offers Reset, Show/Hide alone isn't an edit, an agent's action offers Delete", () => {
  const pr = BUILTIN_ACTIONS[0];
  assert.equal(isEdited({ ...pr, hidden: true, by: "developer" }), false, "hiding is not an edit");
  const edited: DispatchAction = { ...pr, instructions: pr.instructions + "\nRun the linter too.", by: "agent:a-1" };
  const custom: DispatchAction = { ...pr, id: "triage", name: "Triage", builtin: undefined, by: "agent:a-2" };
  delete (custom as { builtin?: unknown }).builtin;
  const rows = actionRows([edited, custom]);
  assert.deepEqual(rows.map(r => [r.origin, r.canReset, r.canDelete]), [["Edited", true, false], ["Added by an agent", false, true]]);
});

test("learned teams: only a clear history without a rule is offered, most starts first", () => {
  assert.deepEqual(learnedTeams(view()), [{ team: "OPS", projectId: "p-app", project: "example/app", count: 4 }]);
  assert.deepEqual(learnedTeams(view({ rules: [] })).map(l => l.team), ["ACME", "OPS"]);
  assert.equal(teamKey(" acme-1 "), "ACME1");
});

test("the category's line counts what's set", () => {
  assert.equal(newWorkSummary(effectiveActions(null), view()), "4 actions shown · 1 team rule · 1 base");
  assert.equal(newWorkSummary(null, view({ rules: [], bases: [] })), "No team rules");
  assert.equal(newWorkSummary(null, null), null);
});

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, unknown> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { rpcCalls, rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[]; rpc: { reply: (name: string, input: unknown) => unknown } };
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NewWorkCategory } = await import("../client/new-settings");
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

rpc.reply = (name: string) => {
  if (name === "follow.dispatch-actions") return { actions: effectiveActions(null), edited: false };
  if (name === "follow.set-dispatch-actions") return { actions: effectiveActions(null) };
  if (name === "follow.dispatch-settings" || name === "follow.set-dispatch-settings") return view();
  return {};
};
const byLabel = (r: ReturnType<typeof create>, label: string | RegExp) => r.root.findAll(n => typeof n.type === "string" && typeof n.props.accessibilityLabel === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel as string)));
const tick = () => act(async () => { await new Promise(res => setTimeout(res, 20)); });

test("the screen on a phone: reads New's own settings only, and Hide, Move and Add rule send the agent tools' changes", async () => {
  rpcCalls.length = 0;
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try {
    await act(async () => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NewWorkCategory, { theme, compact: true }))); });
    await tick();
  } finally { console.error = orig; }
  assert.deepEqual([...new Set(rpcCalls.map(c => c.name))].sort(), ["follow.dispatch-actions", "follow.dispatch-settings"], "opening reads New's settings, never Linear");
  rpcCalls.length = 0;
  const show = byLabel(r, "Show Plan as artifact in New")[0];
  await act(async () => { (show.props.onValueChange as ((v: boolean) => void) | undefined)?.(false) ?? (show.props.onPress as () => void)(); }); await tick();
  assert.deepEqual(rpcCalls.at(-1), { name: "follow.set-dispatch-actions", input: { change: { op: "hide", id: "plan", hidden: true } } });
  await act(async () => { (byLabel(r, "Move Investigate up")[0].props.onPress as () => void)(); }); await tick();
  assert.deepEqual(rpcCalls.at(-1), { name: "follow.set-dispatch-actions", input: { change: { op: "move", id: "investigate", to: 1 } } });
  assert.equal(byLabel(r, "Move Create PR up")[0].props.disabled, true, "the first can't move up");
  // The learned team's offer makes the rule in one click.
  const make = r.root.findAll(n => n.props.actionLabel === "Make it a rule")[0];
  assert.ok(make, "OPS's history is offered as a rule");
  await act(async () => { (make.props.onPress as () => void)(); }); await tick();
  assert.deepEqual(rpcCalls.at(-1), { name: "follow.set-dispatch-settings", input: { rules: { OPS: "p-app" } } });
  // A name is never cut: Add a rule's project is its own row, never a select squeezed inside another row beside the key.
  const its = r.root.findAll(n => n.props.label === "Its project")[0];
  assert.ok(its, "Add a rule has its own project row");
  for (let p = (its as unknown as { parent: Node | null }).parent; p; p = (p as unknown as { parent: Node | null }).parent) assert.notEqual(p.props.label, "Add a rule", "the project select isn't nested in the key's row");
  assert.ok(r.root.findAll(n => n.props.actionLabel === "Add rule").length, "Add is a row's action, aligned with the fields");
  // A base for a project without a git repository isn't offered.
  assert.equal(byLabel(r, "Base for notes").length, 0);
  assert.equal(byLabel(r, "Base for acme/web").length, 1);
  r.unmount();
});

test("removing a rule and resetting every action each ask in place first; nothing is sent on the first press", async () => {
  rpc.reply = (name: string) => {
    if (name === "follow.dispatch-actions") return { actions: effectiveActions(null), edited: true };
    if (name === "follow.set-dispatch-actions") return { actions: effectiveActions(null) };
    if (name === "follow.dispatch-settings" || name === "follow.set-dispatch-settings") return view();
    return {};
  };
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NewWorkCategory, { theme, compact: true }))); }); await tick(); } finally { console.error = orig; }
  const press = async (n: Node) => { await act(async () => { (n.props.onPress as () => void)(); }); await tick(); };
  rpcCalls.length = 0;
  await press(byLabel(r, "Remove ACME's rule")[0]);
  assert.deepEqual(rpcCalls, [], "the first press only asks");
  await press(r.root.findAll(n => n.props.title === "Remove ACME's rule" && typeof n.props.onPress === "function")[0]);
  assert.deepEqual(rpcCalls.at(-1), { name: "follow.set-dispatch-settings", input: { rules: { ACME: null } } });
  rpcCalls.length = 0;
  await press(r.root.findAll(n => n.props.title === "Reset all to built-in" && typeof n.props.onPress === "function")[0]);
  assert.deepEqual(rpcCalls, [], "Reset all asks first");
  await press(r.root.findAll(n => n.props.title === "Reset all" && typeof n.props.onPress === "function")[0]);
  assert.deepEqual(rpcCalls.at(-1), { name: "follow.set-dispatch-actions", input: { change: { op: "reset-all" } } });
  r.unmount();
});
