import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import { workspaceList } from "./support/workspace-list";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkName, lastRename, NAME_EXAMPLES, NAME_RULE, RENAME_DAILY_CAP, renamePrompt, undoRefusal, UNDO_WINDOW_MS, type RenameInputs, renameStatusSchema, normalizeSuggestion } from "../shared/rename";
import { RenameService, RenameStore, renameDaemon, type WorkspaceTitles, renameRunner } from "../server/rename";
import { AiJobs, type Runner } from "../server/ai-jobs";
import { resolveRole } from "../shared/agent-settings";
import { AgentActions } from "../server/agent-actions";
import { rowMenu, ROW_ACTIONS } from "../shared/row-menu";

const inputs = (over: Partial<RenameInputs> = {}): RenameInputs => ({ current: "feature-branch-12", branch: "dev/retry-backoff", goal: "Make the billing worker back off on retries", summary: "Fixes the retry storm in the billing worker.", spec: null, prs: ["Back off billing retries"], linked: [{ key: "ABC-1234", title: "Retry storm in billing" }], agents: ["Billing retries"], ...over });

test("checkName: a short, verb-first name passes and is normalised", () => {
  assert.deepEqual(checkName("  Fix retry backoff   in the billing worker. "), { ok: true, name: "Fix retry backoff in the billing worker" });
  for (const e of NAME_EXAMPLES) assert.equal(checkName(e, { keys: ["ABC-1234"] }).ok, true, e);
});

test("checkName: length, words, quotes and branch junk are refused with a reason", () => {
  const no = (s: string, opts = {}) => { const r = checkName(s, opts); assert.equal(r.ok, false, s); return r.ok ? "" : r.reason; };
  assert.match(no(""), /Give it a name/);
  assert.match(no("x".repeat(61)), /60 characters/);
  assert.match(no("One two three four five six seven eight nine"), /8 words/);
  assert.match(no('"Fix retries"'), /quotes/);
  assert.match(no("`Fix retries`"), /quotes/);
  assert.match(no("feat/retry-backoff"), /branch/);
  assert.match(no("fix: retry backoff"), /branch/);
  assert.match(no("retry-backoff-billing"), /branch/);
  assert.match(no("retry_backoff"), /branch/);
  assert.match(no("Fix retries", { current: "fix retries" }), /name it has now/);
  // An apostrophe inside a word is English, not a quote.
  assert.equal(checkName("Don't retry on 4xx in billing").ok, true);
});

test("checkName: a linked key goes inline after the verb and isn't counted; leading, alone or unlinked is refused", () => {
  const reason = (s: string, keys = ["ABC-1234"]) => (checkName(s, { keys }) as { reason?: string }).reason ?? "";
  assert.equal(checkName("Add ABC-1234 CSV export to the audit log page", { keys: ["ABC-1234"] }).ok, true, "8 words besides the key");
  assert.equal(checkName("Verify ABC-1234 vendor mismatch, check migrations", { keys: ["ABC-1234"] }).ok, true);
  assert.match(reason("ABC-1234"), /Start with a verb, then ABC-1234/);
  assert.match(reason("ABC-1234:"), /Start with a verb/);
  assert.match(reason("XYZ-9 fix retries"), /Start with a verb/);
  assert.match(reason("Fix XYZ-9 retries"), /isn't linked/);
  assert.match(reason("#142 retries"), /Start with a verb/);
});

// One rule, stated once and enforced: the helper under the field and the prompt carry NAME_RULE word for word, and a
// key-led name (the shape the rule forbids) is refused with that rule, so the model's one retry gets it verb-first.
test("one rule: NAME_RULE is what the dialog states, what the prompt says and what checkName enforces", async () => {
  assert.equal(NAME_RULE, "Start with a verb. Up to 8 words.");
  assert.ok(renamePrompt(inputs()).includes(`Rule: ${NAME_RULE}`));
  const dialog = await readFile(join(import.meta.dirname, "..", "client", "rename.tsx"), "utf8");
  assert.match(dialog, /\{NAME_RULE\}/, "the dialog's helper line is NAME_RULE itself");
  assert.doesNotMatch(dialog, /Start with a verb/, "and nowhere restated by hand");
  const ledByKey = checkName("ABC-1234: Retry soft card declines with backoff", { keys: ["ABC-1234"] });
  assert.equal(ledByKey.ok, false);
  assert.match((ledByKey as { reason: string }).reason, /^Start with a verb/);
  for (const e of NAME_EXAMPLES) assert.doesNotMatch(e, /^[A-Z][A-Z0-9]+-\d+/, `example leads with a key: ${e}`);
  const a = await setup(['{"name":"ABC-1234: Retry soft card declines with backoff"}', '{"name":"Retry ABC-1234 soft card declines with backoff"}']);
  assert.equal((await a.service.status("w1", true)).suggestion, "Retry ABC-1234 soft card declines with backoff");
  assert.equal(a.seen.length, 1, "a leading linked key is moved after the verb without another model call");
  await a.done();
});

test("renamePrompt: the rules, the examples, the material and the retry reason, bounded", () => {
  const p = renamePrompt(inputs({ prs: Array.from({ length: 40 }, (_, i) => `PR ${i} ${"x".repeat(300)}`) }), { name: "feat/x", reason: "Use words, not a branch name." });
  for (const e of NAME_EXAMPLES) assert.ok(p.includes(e));
  assert.ok(p.includes("ABC-1234"));
  assert.ok(p.includes("Fixes the retry storm"));
  assert.ok(p.includes('was rejected: Use words, not a branch name.'));
  assert.ok(p.length < 4000, `prompt is ${p.length} chars`);
  assert.ok(renamePrompt(inputs({ linked: [] })).includes("Don't add an issue key"));
});

/** A Paseo with workspace titles in memory. */
function fakeTitles(start: Record<string, { title: string | null; name: string }>) {
  const rows = structuredClone(start); const sets: [string, string | null][] = [];
  const titles: WorkspaceTitles = { get: async id => rows[id] ? { ...rows[id] } : null, set: async (id, title) => { sets.push([id, title]); rows[id].title = title; } };
  return { titles, rows, sets };
}

async function setup(replies: string[], o: { room?: string | null; now?: () => number; inputs?: Partial<RenameInputs>; log?: boolean; runner?: Runner } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rename-"));
  const seen: { model: string; prompt: string; thinking: string | null }[] = [];
  const runner: Runner = async input => { seen.push({ model: input.model, prompt: input.prompt, thinking: input.thinking }); if (o.runner) return o.runner(input); return { text: replies.shift() ?? '{"name":"Fix retry backoff in billing"}', costUsd: 0.0005, inputTokens: 400, outputTokens: 12 }; };
  const t = fakeTitles({ w1: { title: null, name: "dev-retry-backoff" } });
  const store = testStore(RenameStore, dir);
  const service = new RenameService({ store, jobs: new AiJobs({ runner, ...(o.log ? { logPath: join(dir, "ai-jobs.jsonl") } : {}) }), role: async () => resolveRole(null, "about"), titles: t.titles, inputs: async (_id, current) => inputs({ ...o.inputs, current }), room: async () => o.room ?? null, now: o.now, pause: async () => undefined });
  return { dir, service, seen, t, store, done: () => rm(dir, { recursive: true, force: true }) };
}

test("suggest: Summaries' model (haiku), repaired, one retry for an unusable reply, then an editable field", async () => {
  const a = await setup(['{"name":"feat/retry-backoff"}', '{"name":"Fix retry backoff in billing"}']);
  const s = await a.service.status("w1", true);
  assert.equal(s.suggestion, "Fix retry backoff in billing");
  assert.equal(s.current, "dev-retry-backoff");
  assert.deepEqual(a.seen.map(x => x.model), ["haiku", "haiku"]);
  assert.match(a.seen[1].prompt, /was rejected: Use words, not a branch name/);
  await a.done();
  const b = await setup(['{"name":"ABC-1234"}', '{"name":""}']);
  const empty = await b.service.status("w1", true);
  assert.equal(empty.suggestion, "");
  assert.match(empty.notice!, /Type a name/);
  await b.done();
});

test("suggest: a developer click survives a busy governor and the daily cap holds at 30", async () => {
  const a = await setup([], { room: "The VM is short on memory right now." });
  assert.ok((await a.service.status("w1", true)).suggestion);
  assert.equal(a.seen.length, 1);
  await a.done();
  const b = await setup([]);
  for (let i = 0; i < RENAME_DAILY_CAP; i++) await b.service.status("w1", true);
  const capped = await b.service.status("w1", true);
  assert.match(capped.notice!, /30 suggestions for today/);
  assert.equal(capped.suggestion, "");
  assert.equal(b.seen.length, RENAME_DAILY_CAP);
  await b.done();
});

// Invariant rename-is-always-undoable: every applied rename leaves a ledger entry whose Undo restores the exact name
// it replaced (a default name too), for 24 h, and never overwrites a rename made after it.
test("invariant rename-is-always-undoable: Undo restores the exact previous title, then nothing more", async () => {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const a = await setup([], { now: () => now });
  const r1 = await a.service.rename("w1", { title: "Fix retry backoff in billing" }, "developer");
  assert.deepEqual(r1, { workspaceId: "w1", title: "Fix retry backoff in billing", previous: "dev-retry-backoff", undone: false });
  const r2 = await a.service.rename("w1", { title: "Ship billing retry backoff" }, "agent:a1");
  assert.equal(r2.previous, "Fix retry backoff in billing");
  const ledger = JSON.parse(await readFile(join(a.dir, "rename.json"), "utf8"));
  assert.deepEqual(ledger.entries.map((e: { from: string | null; to: string; by: string }) => [e.from, e.to, e.by]), [[null, "Fix retry backoff in billing", "developer"], ["Fix retry backoff in billing", "Ship billing retry backoff", "agent:a1"]]);
  // Undo walks back one rename at a time, to the exact title (null: Paseo's default name).
  assert.equal((await a.service.rename("w1", { undo: true }, "developer")).title, "Fix retry backoff in billing");
  assert.equal((await a.service.rename("w1", { undo: true }, "developer")).title, "dev-retry-backoff");
  assert.deepEqual(a.t.sets.at(-1), ["w1", null]);
  await assert.rejects(a.service.rename("w1", { undo: true }, "developer"), /Nothing to undo/);
  await a.done();
});

test("invariant rename-is-always-undoable: never overwrites a later rename, expires after 24 h, pruned on write", async () => {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const a = await setup([], { now: () => now });
  await a.service.rename("w1", { title: "Fix retry backoff in billing" }, "developer");
  a.t.rows.w1.title = "Renamed by hand in Paseo";
  await assert.rejects(a.service.rename("w1", { undo: true }, "developer"), /renamed again since/);
  assert.equal(a.t.rows.w1.title, "Renamed by hand in Paseo");
  now += UNDO_WINDOW_MS + 1;
  assert.equal(lastRename(await a.store.read(), "w1", now), null);
  await a.service.rename("w1", { title: "Plan admin page for migrations" }, "developer");
  assert.equal((await a.store.read()).entries.length, 1, "the 24 h old entry was pruned on write");
  assert.equal(undoRefusal(null, "x"), "Nothing to undo: no rename in the last 24 hours.");
  // Edits run the same rules as suggestions.
  await assert.rejects(a.service.rename("w1", { title: "feat/x" }, "developer"), /branch/);
  await a.done();
});

// Invariant rename-never-wakes-an-agent: the only daemon calls a rename makes are workspace list reads
// and set_workspace_title. A fetch_agent or a timeline read throws here.
test("invariant rename-never-wakes-an-agent: renameDaemon reaches only the workspace title", async () => {
  const calls: string[] = [];
  const rows = [{ id: "w1", name: "dev-retry-backoff", title: null as string | null }, { id: "w10", name: "other", title: "Other" }];
  const client = new Proxy({}, { get: (_t, prop: string) => {
    if (prop === "then") return undefined;
    if (prop === "findWorkspace" || prop === "supportsBackgroundWorkspaces") return undefined; // older client exercises the list fallback
    if (prop === "fetchWorkspaces") return async (o: Parameters<ReturnType<typeof workspaceList>>[0]) => { calls.push("fetchWorkspaces"); return workspaceList(rows)(o); };
    if (prop === "setWorkspaceTitle") return async (id: string, title: string | null) => { calls.push(`setWorkspaceTitle:${id}`); rows.find(r => r.id === id)!.title = title; return { title }; };
    throw new Error(`rename called daemon.${prop}, which can wake an agent`);
  } });
  let dirty = 0;
  const titles = renameDaemon(async work => work(client as never), () => dirty++);
  assert.deepEqual(await titles.get("w1"), { title: null, name: "dev-retry-backoff" });
  const dir = await mkdtemp(join(tmpdir(), "rename-"));
  const runner: Runner = async () => ({ text: '{"name":"Fix retry backoff in billing"}', costUsd: null, inputTokens: null, outputTokens: null });
  const service = new RenameService({ store: testStore(RenameStore, dir), jobs: new AiJobs({ runner }), role: async () => resolveRole(null, "about"), titles, inputs: async (_id, current) => inputs({ current }), room: async () => null });
  const s = await service.status("w1", true);
  await service.rename("w1", { title: s.suggestion! }, "developer");
  await service.rename("w1", { undo: true }, "developer");
  assert.ok(calls.every(c => /^(fetchWorkspaces|setWorkspaceTitle:w1)$/.test(c)), calls.join(", "));
  assert.equal(dirty, 2, "the directory re-reads after each title change");
  await rm(dir, { recursive: true, force: true });
});

test("ai_rename: dry run shows from and to, confirm renames as the agent; undo plans the restore", async () => {
  const calls: [string, unknown, unknown][] = [];
  let last: { from: string; to: string; at: string } | null = null;
  const rpc = {
    validate: async (_m: string, i: unknown) => i,
    call: async (method: string, input: unknown, actor?: unknown) => {
      calls.push([method, input, actor]);
      if (method === "follow.rename-status") return { workspaceId: "w1", current: "dev-retry-backoff", suggestion: (input as { suggest?: boolean }).suggest ? "Fix retry backoff in billing" : null, keys: [], last };
      return { workspaceId: "w1", title: "Fix retry backoff in billing", previous: "dev-retry-backoff", undone: false };
    },
  };
  const agent = new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [] }), mutate: async () => undefined }, inbox: { noteAction: async () => undefined }, rpc } as never);
  const plan = await agent.run("a1", "ai_rename", { workspaceId: "w1" }) as { dryRun: boolean; planId: string; from: string; to: string };
  assert.deepEqual([plan.dryRun, plan.from, plan.to], [true, "dev-retry-backoff", "Fix retry backoff in billing"]);
  assert.equal(calls.filter(c => c[0] === "follow.rename-workspace").length, 0, "the dry run renames nothing");
  await agent.run("a1", "ai_rename", { confirm: true, planId: plan.planId });
  const done = calls.find(c => c[0] === "follow.rename-workspace")!;
  assert.deepEqual(done[1], { workspaceId: "w1", title: "Fix retry backoff in billing" });
  assert.equal((done[2] as { kind: string; agentId: string }).agentId, "a1");
  await assert.rejects(agent.run("a1", "ai_rename", { workspaceId: "w1", undo: true }), /Nothing to undo/);
  last = { from: "dev-retry-backoff", to: "Fix retry backoff in billing", at: new Date().toISOString() };
  const undo = await agent.run("a1", "ai_rename", { workspaceId: "w1", undo: true }) as { to: string };
  assert.equal(undo.to, "dev-retry-backoff");
});

test("row menu: Rename title with AI on every row with a workspace, through ai_rename", () => {
  const items = (s: Parameters<typeof rowMenu>[0]["s"]) => rowMenu({ s, flagged: false }).flatMap(x => x.items).map(i => i.key);
  assert.ok(items({ key: "ws:w1", agentId: null, workspaceId: "w1", title: "W", agent: null }).includes("rename_ai"));
  assert.ok(!items({ key: "agent:a1", agentId: "a1", workspaceId: null, title: "A", agent: null }).includes("rename_ai"));
  assert.deepEqual(ROW_ACTIONS.rename_ai, { tool: "ai_rename" });
});

// The real daemon ignores idPrefix. Exercise both dialog/tool service paths beyond two page boundaries.
test("invariant an-id-lookup-never-trusts-an-ignored-filter: status and rename find a workspace past page one", async t => {
  const rows = Array.from({ length: 405 }, (_, i) => ({ id: `workspace-${i}`, name: `Workspace ${i}`, title: null as string | null }));
  const fetchWorkspaces = workspaceList(rows);
  assert.equal((await fetchWorkspaces({ filter: { idPrefix: "workspace-404" }, page: { limit: 5 } })).entries[0].id, "workspace-0");
  const requests: unknown[] = [];
  const titles = renameDaemon(async work => work({
    supportsBackgroundWorkspaces: () => true,
    fetchWorkspaces: async options => { requests.push(options); return fetchWorkspaces(options as never); },
    setWorkspaceTitle: async (id, title) => { rows.find(row => row.id === id)!.title = title; },
  }));
  const a = await setup([]);
  t.after(a.done);
  const service = new RenameService({ store: a.store, jobs: new AiJobs({ runner: async () => { throw new Error("no model needed"); } }), role: async () => resolveRole(null, "about"), titles, inputs: async (_id, current) => inputs({ current }), room: async () => null });
  await t.test("status", async () => { assert.equal((await service.status("workspace-404", false)).current, "Workspace 404"); });
  await t.test("rename", async () => { assert.equal((await service.rename("workspace-404", { title: "Fix retry backoff" }, "developer")).previous, "Workspace 404"); });
  assert.equal(rows[404].title, "Fix retry backoff");
  assert.deepEqual(requests.slice(0, 3), [undefined, "200", "400"].map(cursor => ({ filter: { includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } })));
  assert.equal(await titles.get("missing"), null);
  assert.deepEqual(await titles.get("workspace-40"), { title: null, name: "Workspace 40" });
});

test("renameDaemon prefers findWorkspace, preserving client background lookup and method binding", async () => {
  const client = {
    row: { id: "hidden", name: "Background workspace", title: "  " },
    findWorkspace: async function (id: string) { assert.equal(this, client); return id === this.row.id ? this.row : null; },
    fetchWorkspaces: async () => { throw new Error("use the client's id lookup"); },
    setWorkspaceTitle: async () => undefined,
  };
  const titles = renameDaemon(async work => work(client));
  assert.deepEqual(await titles.get("hidden"), { title: null, name: "Background workspace" });
  assert.equal(await titles.get("missing"), null);
});

test("renameDaemon fallback finds background workspaces and stops at the matching page", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: `w${i}`, name: `Workspace ${i}`, background: true }));
  let calls = 0;
  const titles = renameDaemon(async work => work({
    supportsBackgroundWorkspaces: () => true,
    fetchWorkspaces: async options => { calls++; return workspaceList(rows)(options as never); },
    setWorkspaceTitle: async () => undefined,
  }));
  assert.deepEqual(await titles.get("w200"), { name: "Workspace 200", title: null });
  assert.equal(calls, 2);
});

test("renameDaemon fallback omits background options when support is absent or false", async t => {
  for (const support of [undefined, () => false]) await t.test(support ? "unsupported host" : "older client", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `w${i}`, name: `Workspace ${i}` }));
    const requests: unknown[] = [];
    const titles = renameDaemon(async work => work({
      supportsBackgroundWorkspaces: support,
      fetchWorkspaces: async options => {
        requests.push(options);
        const request = options as Parameters<ReturnType<typeof workspaceList>>[0];
        assert.equal(request?.filter?.includeBackground, undefined, "unsupported background options make the real client throw");
        assert.equal(request?.includeBackground, undefined);
        return workspaceList(rows)(request);
      },
      setWorkspaceTitle: async () => undefined,
    }));
    assert.deepEqual(await titles.get("w200"), { name: "Workspace 200", title: null });
    assert.deepEqual(requests, [undefined, "200"].map(cursor => ({ filter: {}, page: { limit: 200, ...(cursor ? { cursor } : {}) } })));
  });
});


test("invariant a-rename-suggestion-is-always-editable: repair a long, quoted or unlinked-key reply without re-asking", async t => {
  const replies = ["Fix retries and show clear errors for each failed job", '"Fix billing retries."', "Fix XYZ-99 billing retries"];
  const a = await setup(replies.map(name => JSON.stringify({ name })));
  t.after(a.done);
  for (const expected of ["Fix retries and show clear errors for each", "Fix billing retries", "Fix billing retries"]) {
    const status = renameStatusSchema.parse(await a.service.status("w1", true));
    assert.equal(status.suggestion, expected);
    assert.equal(checkName(status.suggestion!, { current: status.current, keys: status.keys }).ok, true);
  }
  assert.equal(a.seen.length, replies.length, "repairable rules cost one job per click");
});

test("rename status exposes only issue keys, filtering long artifact URLs before the wire limit", async t => {
  const linked = [
    ...Array.from({ length: 25 }, (_, i) => ({ key: `https://example.com/artifacts/${"details-".repeat(8)}${i}`, title: "Release notes" })),
    { key: "ABC-1234", title: "Retry behavior" },
  ];
  const a = await setup([], { inputs: { linked } });
  t.after(a.done);
  for (const suggest of [false, true]) {
    const status = renameStatusSchema.parse(await a.service.status("w1", suggest));
    assert.deepEqual(status.keys, ["ABC-1234"]);
  }
});


test("suggestion normalization repairs punctuation, linked-key placement and character limits on word boundaries", () => {
  for (const [raw, expected] of [
    ['“Fix retries!!!”', "Fix retries"],
    ["`Fix retries`", "Fix retries"],
    ["ABC-1234: Fix retries", "Fix ABC-1234 retries"],
    ["XYZ-99: Fix retries", "Fix retries"],
    ["Investigate configurable notification preferences across multiple environments", "Investigate configurable notification preferences across"],
    ["Don't retry failed payments", "Don't retry failed payments"],
    ["Add support for C++", "Add support for C++"],
    ["Add support for C#", "Add support for C#"],
  ]) {
    assert.equal(normalizeSuggestion(raw, ["ABC-1234"]), expected);
    assert.equal(checkName(expected, { keys: ["ABC-1234"] }).ok, true);
  }
});

test("an unusable retry remains editable and a real provider failure is still an error", async t => {
  const a = await setup(['{"name":"feat/retries"}', '{"name":"feat/retries"}']);
  t.after(a.done);
  const status = renameStatusSchema.parse(await a.service.status("w1", true));
  assert.equal(status.suggestion, "feat/retries");
  assert.equal(checkName(status.suggestion!).ok, false, "the dialog shows the rule hint; Rename remains guarded");
  await assert.rejects(a.service.rename("w1", { title: status.suggestion! }, "developer"), /branch name/);
  const b = await setup([], { runner: async () => { throw new Error("provider unavailable"); } });
  t.after(b.done);
  await assert.rejects(b.service.status("w1", true), /Couldn't suggest a name: provider unavailable/);
});

test("rejected reply diagnostics log only rule codes, never private reply text or issue keys", async t => {
  const replies = ["Fix retries and show clear errors for each failed job", '"Fix billing retries."', "Fix XYZ-99 billing retries"];
  const a = await setup(replies.map(name => JSON.stringify({ name })), { log: true });
  t.after(a.done);
  for (const _ of replies) await a.service.status("w1", true);
  const raw = await readFile(join(a.dir, "ai-jobs.jsonl"), "utf8");
  const entries = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => e.validationReason), ["words", "quotes", "unlinked-key"]);
  assert.ok(entries.every(e => e.ok));
  for (const reply of replies) assert.ok(!raw.includes(reply));
  assert.ok(!raw.includes("XYZ-99"));
  assert.deepEqual(a.seen.map(r => r.thinking), [null, null, null]);
});

test("the Haiku subprocess has thinking explicitly disabled without changing the parent environment", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rename-runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "model.cjs");
  await writeFile(script, `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({result:JSON.stringify({budget:process.env.MAX_THINKING_TOKENS,disabled:process.env.CLAUDE_CODE_DISABLE_THINKING}),usage:{}})));`);
  const previous = { budget: process.env.MAX_THINKING_TOKENS, disabled: process.env.CLAUDE_CODE_DISABLE_THINKING };
  const output = await renameRunner(process.execPath, () => [script])({ prompt: "fixture", system: "fixture", provider: "claude", model: "haiku", thinking: null, signal: new AbortController().signal, timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(output.text), { budget: "0", disabled: "1" });
  assert.deepEqual({ budget: process.env.MAX_THINKING_TOKENS, disabled: process.env.CLAUDE_CODE_DISABLE_THINKING }, previous);
});
