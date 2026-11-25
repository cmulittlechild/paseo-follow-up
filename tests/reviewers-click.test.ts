// a-click-on-add-reviewers-asks, a-clicked-row-holds-its-place (2026-11-24). Tom, about the Needs-you rows "Add
// reviewers to #N: <names>": "make it so when I click Add Reviewers it just does that, no popup, and make sure it allows
// me doing it for a lot of prs one after the other". Root cause, two parts: the row's button opened the PR sheet
// (actions.openPr(prKey, "reviewers")), where a second Add reviewers asked; and a clicked row left the list on the next
// read, so the rows under it moved up and the next click landed on the wrong one. These render the real NeedsYouList
// under the native stand-in and read what reached the RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { pr, snapshot, workspace, clock } from "./fixtures";
import { reviewersScope, reviewersWords } from "../shared/reviewers-click";
import { keepInPlace } from "../shared/keep-in-place";
import { setReviewerConfig, emptyReviewerConfig, type ReviewerConfig } from "../shared/reviewers";
import { INVARIANTS } from "../shared/status-invariants";
import type { Pr } from "../shared/model";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

const config: ReviewerConfig = { version: 1, repos: {}, defaults: [{ login: "ravi-k", name: "Ravi" }, { login: "mina-o", name: "Mina" }], migratedAt: null };
const waiting = (n: number, patch: Partial<Pr> = {}) => pr({ key: `example/app#${n}`, number: n, parent: null,
  snapshot: snapshot({ head: `head-${n}`, title: `PR ${n}`, reviewers: { complete: true, author: "sam-dev", requested: [], teams: [], reviewed: [] } }), ...patch });

test("reviewers-click: the click asks the names the row shows, minus the author; nobody set opens the picker", () => {
  const s = reviewersScope(waiting(240), config.defaults)!;
  assert.deepEqual([s.logins, s.names, s.a11y, s.doneA11y], [["ravi-k", "mina-o"], ["Ravi", "Mina"], "Ask Ravi and Mina to review pull request #240", "Requested Ravi and Mina on pull request #240"]);
  const own = waiting(241, { snapshot: snapshot({ reviewers: { complete: true, author: "ravi-k", requested: [], teams: [], reviewed: [] } }) });
  assert.deepEqual(reviewersScope(own, config.defaults)!.names, ["Mina"], "the author can't review their own PR");
  assert.equal(reviewersScope(waiting(242), []), null, "nobody set: nothing to name, so the sheet's picker");
  assert.equal(reviewersScope(own, [{ login: "ravi-k", name: "Ravi" }]), null, "only the author on the list: the picker");
});

test("reviewers-click: the button says Requesting…, then Requested; a refusal keeps Add reviewers with why", () => {
  const s = reviewersScope(waiting(240), config.defaults)!;
  assert.equal(reviewersWords(s, null).button, "Add reviewers");
  assert.equal(reviewersWords(s, null, true).button, "Requesting…");
  assert.deepEqual(reviewersWords(s, { state: "submitted", result: "Requested Ravi and Mina." }), { button: "Requested", line: null, tone: null, done: true }, "done keeps the row's height");
  assert.equal(reviewersWords(s, { state: "uncertain", result: "Check state." }).button, "Unconfirmed");
  const no = reviewersWords(s, { state: "error", result: "PR status changed." });
  assert.deepEqual([no.button, no.line, no.done], ["Add reviewers", "Not requested: PR status changed.", false]);
  assert.deepEqual([false, true].map(r => reviewersWords(s, null, r, true).button), ["Request", "Sending…"], "a phone keeps one short word, so the title keeps the names");
  assert.equal(reviewersWords(s, { state: "submitted", result: "" }, false, true).button, "Requested");
  for (const compact of [false, true]) for (const r of [false, true]) assert.doesNotMatch(reviewersWords(s, null, r, compact).button, /^Ask/, "never a bare Ask: an ask is the developer's question");
});

test("keep-in-place: a held row stays where it was after the next read drops it; untouched rows come and go", () => {
  const k = (s: string) => s;
  assert.deepEqual(keepInPlace(["a", "b", "c", "d"], ["a", "c", "d"], k, key => key === "b"), ["a", "b", "c", "d"]);
  assert.deepEqual(keepInPlace(["a", "b", "c", "d"], ["d"], k, key => key !== "d"), ["a", "b", "c", "d"], "five clicks in a row: every row holds");
  assert.deepEqual(keepInPlace(["a", "b", "c"], ["c"], k, key => key === "b"), ["b", "c"], "an untouched row that left stays gone");
  assert.deepEqual(keepInPlace(["a", "b"], ["x", "a", "b"], k, () => true), ["x", "a", "b"], "a new row still joins");
});

test("a-click-on-add-reviewers-asks: the invariant holds: a reviewers row's title names whom its click asks", async () => {
  const inv = INVARIANTS.find(i => i.id === "a-click-on-add-reviewers-asks")!;
  assert.ok(inv, "listed in INVARIANTS");
  setReviewerConfig(config);
  try {
    const w = workspace({ prs: [waiting(240)] });
    assert.equal(inv.check(w as never, clock), null);
    const { needsYou } = await import("../shared/attention");
    const item = needsYou(w as never, clock).find(i => i.kind === "reviewers");
    assert.ok(item && item.kind === "reviewers" && item.title === "Add reviewers to #240: Ravi and Mina");
  } finally { setReviewerConfig(emptyReviewerConfig()); }
});

test("every Add reviewers that names its people asks in one click; the sheet only when nobody is set", async () => {
  const read = (f: string) => readFile(join(import.meta.dirname, "../client", f), "utf8");
  const ny = await read("needs-you.tsx");
  assert.match(ny, /case "reviewers": return reviewerControl\(item\.prKey, \{ theme, compact, after: actions\.after, fallback:/, "Needs you (panel, Home, pill, Catch up)");
  assert.doesNotMatch(ny, /case "reviewers": return actions\.openPr/);
  const brief = await read("brief.tsx");
  assert.match(brief, /m\.kind === "add_reviewers" \? asks\.view\(m\.prKey\)/, "a brief's add-reviewers move");
  const button = await read("reviewers-button.tsx");
  assert.doesNotMatch(button, /useMutation\(/, "no single mutation: each PR keeps its own pending state");
});

// --- The real list, five rows clicked one after another ---
register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; update(el: unknown): void; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { rpcCalls, rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[]; rpc: { reply: (name: string, input: unknown) => unknown } };
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

for (const [compact, surface] of [[false, "list"], [true, "list"], [false, "block"], [true, "block"]] as const) test(`needs-you: five Add reviewers clicked in a row each ask at once, none opens the sheet, and the rows hold their places (${surface}, ${compact ? "phone" : "desktop"})`, async () => {
  const { NeedsYouList, NeedsYouBlock } = await import("../client/needs-you");
  const { resetReviewerClicks } = await import("../client/reviewers-button");
  resetReviewerClicks();
  setReviewerConfig(config);
  const numbers = [240, 241, 242, 243, 244];
  // Each request stays open until the test lets it go, so all five are in flight together.
  const release: (() => void)[] = [];
  const prior = rpc.reply;
  rpc.reply = (name, input) => name === "follow.request-reviewers" ? new Promise(res => release.push(() => res({ state: "submitted", result: "Requested Ravi and Mina." })))
    : name === "follow.reviewer-settings" ? { config, noReview: [] } : prior(name, input);
  rpcCalls.length = 0;
  const opened: string[] = [];
  const client = new QueryClient();
  const tree = (w: unknown) => createElement(QueryClientProvider, { client }, createElement(surface === "list" ? NeedsYouList : NeedsYouBlock, { workspace: w, theme, compact, now: clock, actions: { openPr: (k: string) => opened.push(k) } }));
  const all = workspace({ prs: numbers.map(n => waiting(n)) });
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try {
    await act(() => { r = create(tree(all)); });
    const buttons = () => r.root.findAll(n => typeof n.props.onPress === "function" && /^(Ask Ravi and Mina to review|Requested Ravi and Mina on) pull request #\d+$/.test(String(n.props.accessibilityLabel ?? "")))
      .filter((n, i, a) => a.findIndex(m => m.props.accessibilityLabel === n.props.accessibilityLabel) === i);
    const order = () => buttons().map(n => Number(/#(\d+)/.exec(n.props.accessibilityLabel)![1]));
    assert.deepEqual(order(), numbers);
    for (const [i, n] of numbers.entries()) {
      const b = buttons().find(x => x.props.accessibilityLabel.endsWith(`#${n}`))!;
      assert.equal(b.props.disabled, false, `#${n} is clickable while ${i} others are in flight`);
      await act(() => { b.props.onPress(); });
      // The server records the request, so the next read drops that row; the list keeps it where it was.
      const left = workspace({ prs: numbers.map(m => waiting(m)), prActions: numbers.slice(0, i + 1).map(m => ({ id: `a-${m}`, kind: "request_reviewers", reviewers: ["ravi-k", "mina-o"], prs: [`example/app#${m}`], heads: {}, createdAt: new Date(clock).toISOString(), state: "sending", result: "" })) as never });
      await act(() => { r.update(tree(left)); });
      assert.deepEqual(order(), numbers, `after clicking #${n}, every row is where it was`);
    }
    const asked = rpcCalls.filter(c => c.name === "follow.request-reviewers");
    assert.deepEqual(asked.map(c => c.input.prKey), numbers.map(n => `example/app#${n}`), "one request per click, in click order");
    assert.ok(asked.every(c => c.input.reviewers === undefined), "the saved list: the people the row names");
    assert.deepEqual(opened, [], "no sheet");
    await act(async () => { for (const f of release) f(); await new Promise(res => setTimeout(res, 20)); });
    assert.ok(buttons().every(b => b.props.disabled === true && /^Requested Ravi and Mina on /.test(b.props.accessibilityLabel)), "each row says Requested, in place");
    assert.deepEqual(order(), numbers);
    r.unmount();
  } finally { console.error = orig; rpc.reply = prior; setReviewerConfig(emptyReviewerConfig()); }
});

test("needs-you: a reviewers row with nobody to ask opens the sheet's picker", async () => {
  const { NeedsYouList } = await import("../client/needs-you");
  (await import("../client/reviewers-button")).resetReviewerClicks();
  const authorOnly: ReviewerConfig = { ...config, defaults: [{ login: "sam-dev", name: "Sam" }] };
  setReviewerConfig(authorOnly);
  const prior = rpc.reply;
  rpc.reply = (name, input) => name === "follow.reviewer-settings" ? { config: authorOnly, noReview: [] } : prior(name, input);
  rpcCalls.length = 0;
  const opened: string[] = [];
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try {
    await act(() => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NeedsYouList, { workspace: workspace({ prs: [waiting(250)] }), theme, compact: false, now: clock, actions: { openPr: (k: string, intent: string) => opened.push(`${k} ${intent}`) } }))); });
    const pick = r.root.findAll(n => typeof n.props.onPress === "function" && n.props.accessibilityLabel === "Pick reviewers for this PR")[0];
    assert.ok(pick, "Add reviewers… opens the picker");
    await act(() => { pick.props.onPress(); });
    assert.deepEqual(opened, ["example/app#250 reviewers"]);
    assert.equal(rpcCalls.filter(c => c.name === "follow.request-reviewers").length, 0);
    r.unmount();
  } finally { console.error = orig; rpc.reply = prior; setReviewerConfig(emptyReviewerConfig()); }
});
