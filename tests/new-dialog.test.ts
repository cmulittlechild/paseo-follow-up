// New's dialog (client/new.tsx) under the strict native stand-in (client-renders-under-native-rules): the phone's list
// screen and preview, a dispatch in progress, created and failed; and new-reads-nothing-while-closed (a closed New
// makes no request). Fixtures are fictional (ACME, acme/web).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, unknown> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void>) => Promise<void> };
const { rpcCalls, rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[]; rpc: { reply: (name: string, input: unknown) => unknown } };
const { NewHost, NewDialog, DispatchRows, openNew, closeNew } = await import("../client/new");

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const phone = { compact: true } as never;

const issue = { id: "u-142", key: "ACME-142", title: "Retry failed charges", state: "In Progress", stateType: "started", priority: null, updatedAt: new Date().toISOString(), team: "ACME", teamName: null, url: null, assigneeIsMe: true, branchName: "alice/acme-142-retry", description: null };
const plan = {
  source: { kind: "linear", key: "ACME-142", title: "Retry failed charges", url: null, body: "Charges that fail are never retried.", team: "ACME", repo: null, number: null, branchHint: null, state: "In Progress", read: true },
  action: { id: "pr", name: "Create PR" }, actions: [{ id: "pr", name: "Create PR", icon: "git-pull-request", description: "" }, { id: "plan", name: "Plan as artifact", icon: "file-text", description: "" }, { id: "investigate", name: "Investigate", icon: "search", description: "" }],
  where: { projectId: "web", projectName: "acme/web", how: "learned", reason: "9 ACME workspaces started here", guess: false, candidates: [] },
  base: { name: "main", reason: "The repository's default branch" }, branch: "alice/acme-142-retry", title: "ACME-142 Retry failed charges", workspace: "worktree",
  agent: "Claude", agentPick: { picked: { provider: "claude", mode: "bypassPermissions" }, isDefault: true }, instructions: "Work on ACME-142.", hash: "h", existing: null, blockers: [],
};
const record = (over: Record<string, unknown>) => ({ id: "d1", at: new Date().toISOString(), by: "developer", source: { kind: "linear", key: "ACME-142", title: "Retry failed charges", url: null }, actionId: "pr", actionName: "Create PR", projectId: "web", projectName: "acme/web", workspace: "worktree", base: "main", branch: "acme-142", prNumber: null, title: "ACME-142 Retry failed charges", agentLabel: "Claude", agent: null, promptHash: "h", prompt: null, state: "queued", step: null, workspaceId: null, agentId: null, error: null, leftBehind: null, attempts: 0, nextTryAt: null, undoUntil: null, ...over });

let records: unknown[] = [];
let recordsFail = 0; let recordsHang = 0;
rpc.reply = (name: string) => {
  if (name === "follow.dispatch-records" && recordsHang > 0) { recordsHang--; return new Promise(() => {}); }
  if (name === "follow.dispatch-records" && recordsFail > 0) { recordsFail--; throw new Error("Follow-up is busy"); }
  if (name === "follow.dispatch-sources") return { linear: { status: "ok", issues: [issue], at: Date.now(), more: false }, routes: { "ACME-142": { project: "acme/web", guess: false, existing: null } }, recent: [] };
  if (name === "follow.dispatch-preview") return plan;
  if (name === "follow.dispatch") return { dispatchId: "d1", record: record({}), plan };
  if (name === "follow.dispatch-records") return { records };
  return {};
};

async function render(el: unknown) {
  let r: ReturnType<typeof create> | undefined; let error: unknown = null;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(el); }); await act(async () => { await new Promise(res => setTimeout(res, 20)); }); } catch (e) { error = e; } finally { console.error = orig; }
  return { r: r!, error };
}
const press = async (n: Node) => { await act(async () => { (n.props.onPress as () => void)(); await new Promise(res => setTimeout(res, 20)); }); };
const byLabel = (r: Awaited<ReturnType<typeof render>>["r"], label: string | RegExp) => r.root.findAll(n => typeof n.type === "string" && typeof n.props.accessibilityLabel === "string" && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel as string)));

test("closed, New makes no request: a host with nothing open renders nothing and reads nothing", async () => {
  closeNew(); rpcCalls.length = 0;
  const { r, error } = await render(createElement(NewHost, { theme, layout: phone }));
  assert.equal(error, null);
  assert.equal(r.root.findAll(n => n.props.role === "dialog").length, 0);
  await act(async () => { await new Promise(res => setTimeout(res, 50)); });
  assert.deepEqual(rpcCalls, [], "no RPC while New is closed");
  r.unmount();
});

test("open on a phone: the list screen with its bar, then the preview, under the phone's rules; one list read and one preview", async t => {
  rpcCalls.length = 0;
  const { r, error } = await render(createElement(NewHost, { theme, layout: phone }));
  t.after(() => { closeNew(); r.unmount(); });
  await act(async () => { openNew(); await new Promise(res => setTimeout(res, 30)); });
  await act(async () => { await new Promise(res => setTimeout(res, 30)); });
  assert.equal(error, null, `crashed on a phone: ${(error as Error)?.message}`);
  assert.equal(r.root.findAll(n => n.props.role === "dialog" && typeof n.type === "string").length, 1);
  assert.deepEqual(rpcCalls.map(c => c.name), ["follow.dispatch-sources", "follow.dispatch-preview"]);
  assert.ok(byLabel(r, /^ACME-142 Retry failed charges/).length, "the issue row");
  assert.ok(byLabel(r, "Create PR").length, "the bar's primary");
  await press(byLabel(r, /^ACME-142 Retry failed charges/)[0]);
  assert.ok(byLabel(r, /^Project: acme\/web/).length, "the preview's Project chip");
  assert.ok(byLabel(r, /^Agent Claude · bypassPermissions/).length, "the agent and its mode are on screen before the click");
});

test("a dispatch on a phone: starting, created (Open workspace, Undo) and failed render under the phone's rules", async () => {
  for (const [state, over, expect] of [
    ["starting", { state: "starting", workspaceId: "ws-1" }, "Close"],
    ["created", { state: "created", workspaceId: "ws-1", agentId: "a-1", undoUntil: new Date(Date.now() + 600_000).toISOString() }, "Undo"],
    ["failed", { state: "failed", error: "Provider claude isn't available.", leftBehind: "The workspace was archived again; nothing is left behind." }, "Try again"],
  ] as const) {
    records = [record(over)];
    const { r, error } = await render(createElement(NewDialog, { request: {}, theme, layout: phone, onClose: () => {} }));
    assert.equal(error, null, `${state}: ${(error as Error)?.message}`);
    await press(byLabel(r, "Create PR")[0]);
    await act(async () => { await new Promise(res => setTimeout(res, 1100)); });
    assert.ok(byLabel(r, expect).length, `${state}: ${expect} is offered`);
    r.unmount();
  }
});

test("a failed, hung or unchanged record read doesn't end the polling: the dialog still reaches created", async () => {
  records = [record({ state: "creating" })]; recordsHang = 1; recordsFail = 1;
  const { r } = await render(createElement(NewDialog, { request: {}, theme, layout: phone, onClose: () => {} }));
  await press(byLabel(r, "Create PR")[0]);
  await act(async () => { await new Promise(res => setTimeout(res, 3200)); });
  assert.equal(byLabel(r, "Undo").length, 0, "still starting after a hung, a failed and an unchanged read");
  records = [record({ state: "created", workspaceId: "ws-1", agentId: "a-1", undoUntil: new Date(Date.now() + 600_000).toISOString() })];
  await act(async () => { await new Promise(res => setTimeout(res, 1200)); });
  assert.ok(byLabel(r, "Undo").length, "created once the record says so");
  r.unmount();
});

test("Home's dispatch rows render under the phone's rules and offer Undo only inside the window", async () => {
  const { r, error } = await render(createElement(DispatchRows, { theme, compact: true, records: [record({ id: "a", state: "created", workspaceId: "ws-1", undoUntil: new Date(Date.now() + 300_000).toISOString() }), record({ id: "b", state: "creating" })] }));
  assert.equal(error, null);
  assert.equal(byLabel(r, /^Undo /).length, 1);
  r.unmount();
});

test("on a phone an action's name is never cut: the alternates' rows wrap and no button is squeezed below its name", async () => {
  const { ActionRow } = await import("../client/action-row");
  const btn = (id: string, name: string) => ({ id, name, icon: "file-text", key: null });
  const bars = [
    { kind: "existing", workspaceId: "ws-1", title: "ACME-142 Retry failed charges", others: [btn("plan", "Plan as artifact"), btn("investigate", "Investigate")], more: [btn("open", "Just open")], disabled: null },
    { kind: "actions", primary: btn("pr", "Create PR"), second: btn("plan", "Plan as artifact"), more: [btn("investigate", "Investigate")], disabled: null },
  ];
  for (const bar of bars) {
    const { r, error } = await render(createElement(ActionRow, { bar, c: colors, compact: true, onAction: () => {}, onOpen: () => {} }));
    assert.equal(error, null, `${bar.kind}: ${(error as Error)?.message}`);
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[typeof s === "function" ? s({}) : s].flat(Infinity).filter(Boolean));
    for (const b of r.root.findAll(n => n.props.accessibilityRole === "button")) assert.notEqual(flat(b.props.style).flexBasis, 0, `${bar.kind}: ${b.props.accessibilityLabel} isn't squeezed to a share of the row`);
    const rows = r.root.findAll(n => typeof n.type === "string" && flat(n.props.style).flexDirection === "row" && (n as unknown as { findAll(f: (m: Node) => boolean): Node[] }).findAll(m => m.props.accessibilityRole === "button").length > 1);
    assert.ok(rows.length, `${bar.kind}: a row holds the alternates`);
    for (const row of rows) assert.equal(flat(row.props.style).flexWrap, "wrap", `${bar.kind}: the alternates' row wraps`);
    r.unmount();
  }
});

test("typing never blanks the preview: the last one stays until the next arrives, and nothing re-mounts per keystroke", async t => {
  rpcCalls.length = 0;
  const desktop = { compact: false } as never;
  const { r, error } = await render(createElement(NewDialog, { request: { token: 1, source: null }, theme, layout: desktop, onClose: () => undefined }));
  t.after(() => r.unmount());
  assert.equal(error, null);
  const field = () => r.root.findAll(n => typeof n.type === "string" && n.props.accessibilityLabel === "Task" && typeof n.props.onChangeText === "function")[0];
  const type = async (text: string, wait: number) => { await act(async () => { (field().props.onChangeText as (v: string) => void)(text); await new Promise(res => setTimeout(res, wait)); }); };
  await type("Make the invoice page faster", 300); await act(async () => { await new Promise(res => setTimeout(res, 300)); });
  assert.ok(byLabel(r, /^Project: acme\/web/).length, "the first preview is up");
  const words = " for accounts with many invoices";
  let blank = 0;
  for (let i = 1; i <= words.length; i += 4) {
    await type("Make the invoice page faster" + words.slice(0, i), 15);
    if (!byLabel(r, /^Project: acme\/web/).length || byLabel(r, "Reading the source").length) blank++;
  }
  assert.equal(blank, 0, "every keystroke kept the preview on screen");
  await act(async () => { await new Promise(res => setTimeout(res, 400)); });
  const previews = rpcCalls.filter(c => c.name === "follow.dispatch-preview").length;
  assert.ok(previews <= 3, `typing asks for the preview once it settles, not per keystroke (${previews})`);
});
