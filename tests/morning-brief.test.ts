import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, testStore } from "./support/store-temp-dir";
import { MorningBrief, MorningBriefStore, mcpproxyChat, type ChatSearch } from "../server/morning-brief";
import { RPC_TOOLS } from "../server/agent-parity";
import { briefSince, type QueueFile } from "../shared/linear-queue";
import {
  applyPlanChange, briefSummary, effectivePlan, emptyMorningBrief, findArtifactLink, importFromRegistry, parseChatRefs, planCard, planSettingsSchema, type PlanView,
} from "../shared/morning-brief";

// Settings → Morning brief: the plan link (modes, Find it for me, not found, the one-time import) and the queue's
// settings. Fixtures are fictional (alice, #planning, #roadmap, made-up ids and artifact links).

// Tuesday 2026-11-24, 09:30 in Jerusalem (07:30Z).
const TUE = Date.parse("2026-11-24T07:30:00.000Z");
const H = 3_600_000;
const ART = "https://claude.ai/artifact/0a1b2c3d-week-plan";
const ART2 = "https://claude.ai/artifact/9f8e7d6c-week-plan";

/** The morning-brief skill's registry, same shape, fictional values. */
const REGISTRY = JSON.stringify({ sources: [{ id: "weekly-plan", label: "Weekly plan", url: `${ART}?share=KEY123`, reader: "claude_artifact",
  discovery: { server: "chat", author_id: "UALICE0001", author_name: "alice", channels: [{ id: "CPLAN00001", label: "#planning" }, { id: "CROAD00001", label: "roadmap" }],
    selected_message_ts: "1.2", selected_message_url: "https://chat.example/x", selected_shared_at: "2026-11-23T09:12:00Z", selected_shared_in: "planning", checked_at: "2026-11-23T09:15:00Z", status: "ok", detail: "found" } }] });

/** A search reply as the chat tool gives it: JSON with a markdown `results` string, newest first. */
const reply = (entries: { text: string; at: string; where?: string }[]) => JSON.stringify({ results: entries.map((e, i) => `${i + 1}. **#${e.where ?? "planning"}** alice: ${e.text} ${e.at}`).join("\n"), pagination_info: "" });

function fakeChat(o: { messages?: (filters: string) => string | Error } = {}) {
  const calls: string[] = [];
  const chat: ChatSearch & { calls: string[] } = {
    calls,
    async messages({ filters }) { calls.push(filters); const r = o.messages?.(filters) ?? reply([]); if (r instanceof Error) throw r; return r; },
    async people(q) { calls.push(`people ${q}`); return JSON.stringify({ results: "1. **alice** (UALICE0001)\n2. **alicia** (UALICIA001)" }); },
    async channels(q) { calls.push(`channels ${q}`); return JSON.stringify({ results: "- #planning (CPLAN00001)\n- #plans-archive (CPLAN00002)" }); },
  };
  return chat;
}

async function setup(t: TestContext, o: { registry?: string | null; chat?: ChatSearch | null; env?: string | null; readPlan?: (url: string) => Promise<{ title: string | null; items: unknown[] }> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "morning-brief-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = join(directory, "sources.json");
  if (o.registry !== null) await writeFile(registry, o.registry ?? REGISTRY);
  const time = { now: TUE };
  const logs: string[] = [];
  const store = testStore(MorningBriefStore, directory);
  const brief = new MorningBrief({ store, chat: o.chat === undefined ? fakeChat() : o.chat, env: () => o.env ?? null, deviceZone: () => "Asia/Jerusalem", registry, now: () => time.now, readPlan: o.readPlan, log: l => logs.push(l) });
  return { brief, store, time, logs, registry };
}

test("the one-time import: the skill registry's discovery becomes Find it for me and its link the first find, once, values never logged", async t => {
  const { brief, logs, time } = await setup(t);
  const plan = await brief.planView();
  assert.equal(plan.mode, "auto");
  assert.deepEqual(plan.person, { id: "UALICE0001", name: "alice" });
  assert.deepEqual(plan.channels, [{ id: "CPLAN00001", name: "planning" }, { id: "CROAD00001", name: "roadmap" }]);
  assert.equal(plan.url, ART, "the link without its share key");
  assert.equal(plan.source, "found");
  assert.equal(plan.found?.where, "planning");
  assert.ok(plan.importedAt);
  assert.equal(logs.length, 1);
  for (const value of ["alice", "UALICE0001", "planning", "0a1b2c3d", "KEY123"]) assert.ok(!logs.join("\n").includes(value), `the log names no value (${value})`);
  // Once: turning it off sticks across reads.
  await brief.setPlan({ mode: "off" });
  time.now += H;
  assert.equal((await brief.planView()).mode, "off", "the import never runs twice");
});

test("the import: a missing or unusable registry imports nothing; a setting made before the import is never replaced", async t => {
  const none = await setup(t, { registry: null });
  assert.equal((await none.brief.planView()).mode, "off");
  assert.ok((await none.brief.planView()).importedAt, "it still counts as run");
  assert.equal(importFromRegistry("{not json", TUE), null);
  assert.equal(importFromRegistry(JSON.stringify({ sources: [{ reader: "other", url: ART }] }), TUE), null);
  const linkOnly = importFromRegistry(JSON.stringify({ sources: [{ reader: "claude_artifact", url: ART }] }), TUE)!;
  assert.equal(linkOnly.plan.mode, "link", "no discovery block: the link alone, pasted");
  // A file that already has a choice (an older install that set it) keeps it.
  const kept = await setup(t);
  await kept.store.mutate(f => { f.plan = { ...planSettingsSchema.parse({}), mode: "link", link: ART2, linkAt: new Date(TUE).toISOString() }; });
  assert.equal((await kept.brief.planView()).url, ART2);
});

test("effectivePlan: the environment wins; Off reads nothing; a pasted link stays unless a newer find replaces it; not found keeps last week's", () => {
  const f = emptyMorningBrief();
  const at = (h: number) => new Date(TUE + h * H).toISOString();
  const found = { url: ART2, postedAt: at(-1), where: "planning", foundAt: at(1) };
  const auto = { ...f, plan: { ...f.plan, mode: "auto" as const, person: { id: null, name: "alice" }, channels: [{ id: null, name: "planning" }] } };
  assert.deepEqual(effectivePlan({ ...auto, found }, `${ART}?share=x`), { url: ART, source: "env" });
  assert.deepEqual(effectivePlan({ ...auto, plan: { ...auto.plan, mode: "off" }, found }, null), { url: null, source: "off" });
  assert.deepEqual(effectivePlan({ ...auto, found }, null), { url: ART2, source: "found" });
  assert.deepEqual(effectivePlan({ ...auto, found: null, previous: found }, null), { url: ART2, source: "previous" }, "not found: last week's");
  const link = { ...auto, plan: { ...auto.plan, mode: "link" as const, link: ART, linkAt: at(0) } };
  assert.deepEqual(effectivePlan({ ...link, found }, null), { url: ART, source: "link" }, "replace-when-newer off: the paste stays");
  const replace = { ...link, plan: { ...link.plan, replaceWhenNewer: true } };
  assert.deepEqual(effectivePlan({ ...replace, found }, null), { url: ART2, source: "found" }, "a find after the paste replaces it");
  assert.deepEqual(effectivePlan({ ...replace, found: { ...found, foundAt: at(-2) } }, null), { url: ART, source: "link" }, "an older find doesn't");
});

test("Find it for me: one search for the person in the channels over 14 days; the newest artifact link, canonical; not found keeps last week's", async t => {
  let answer: string | Error = reply([{ text: `Plan for the week ${ART2}?share=SECRET`, at: "2026-11-23 09:12:00" }, { text: `Last week ${ART}`, at: "2026-11-16 09:00:00" }]);
  const chat = fakeChat({ messages: () => answer });
  const { brief, time } = await setup(t, { chat });
  // The imported find was ART; this week's search finds ART2.
  const check = await brief.find();
  assert.equal(check?.status, "found");
  assert.equal(chat.calls.at(-1), "from:<@UALICE0001> in:<#CPLAN00001> in:<#CROAD00001> has:link after:2026-11-10", "ids from the import, 14 days back");
  let plan = await brief.planView();
  assert.equal(plan.url, ART2, "no share key kept");
  assert.equal(plan.previous?.url, ART, "the old one is last week's");
  assert.equal(plan.found?.postedAt, "2026-11-23T09:12:00.000Z");
  // Next week nothing new: the stored find stays; then a failure says so and keeps it too.
  time.now += 7 * 24 * H;
  answer = reply([]);
  assert.equal((await brief.find())?.status, "not-found");
  plan = await brief.planView();
  assert.equal(plan.url, ART2, "not found keeps the plan it has");
  answer = new Error("Command failed: mcpproxy call tool-read");
  const failed = await brief.find();
  assert.equal(failed?.status, "error"); assert.equal(failed?.error, "mcpproxy couldn't run the chat search.");
  // A name with no id searches by name.
  await brief.setPlan({ person: { name: "@bob" }, channels: [{ name: "#roadmap" }] });
  assert.match(chat.calls.at(-1)!, /^from:bob in:#roadmap has:link after:/, "changing who or where searches right away");
});

test("plan changes: a pasted link must be a claude.ai artifact and becomes Use a link; a new person clears what was found for the old one", async t => {
  assert.deepEqual(applyPlanChange(planSettingsSchema.parse({}), { link: "https://example.com/plan" }, TUE), { ok: false, error: "That isn't a claude.ai artifact link (https://claude.ai/artifact/…)." });
  assert.equal(applyPlanChange(planSettingsSchema.parse({}), { mode: "link" }, TUE).ok, false, "Use a link needs a link");
  const pasted = applyPlanChange(planSettingsSchema.parse({}), { link: `${ART}#frag` }, TUE);
  assert.ok(pasted.ok && pasted.plan.mode === "link" && pasted.plan.link === ART);
  const { brief } = await setup(t);
  await assert.rejects(brief.setPlan({ link: "https://example.com/x" }), /isn't a claude.ai artifact/);
  await brief.setPlan({ person: { name: "carol" } });
  const plan = await brief.planView();
  assert.equal(plan.found, null, "what was found for alice isn't carol's");
});

test("the-brief-has-one-timer: Find it for me looks again once a workday after the sweep time, from the worker's loop", async t => {
  const chat = fakeChat({ messages: () => reply([{ text: ART2, at: "2026-11-24 08:00:00" }]) });
  const { brief, time } = await setup(t, { chat });
  time.now = Date.parse("2026-11-24T03:00:00Z"); // 05:00 local: before 07:00
  await brief.tick(); assert.equal(chat.calls.length, 0);
  time.now = Date.parse("2026-11-24T05:30:00Z"); // 07:30 local
  await brief.tick(); assert.equal(chat.calls.length, 1);
  time.now += H; await brief.tick(); assert.equal(chat.calls.length, 1, "once a day");
  time.now = Date.parse("2026-11-27T06:00:00Z"); // Friday: not a workday in this zone
  await brief.tick(); assert.equal(chat.calls.length, 1);
  await brief.setPlan({ mode: "off" });
  time.now = Date.parse("2026-11-29T06:00:00Z"); // Sunday
  await brief.tick(); assert.equal(chat.calls.length, 1, "Off searches nothing");
});

test("the queue's settings: states keep Linear's order, an invalid zone is refused, and since=workday ignores the last read", async t => {
  const { brief } = await setup(t);
  const view = await brief.setQueue({ states: ["started", "triage"], sweepAt: "06:30", since: "workday", workdays: ["Mon", "Sun", "Tue"] });
  assert.deepEqual(view.queue.states, ["triage", "started"]);
  assert.deepEqual(view.queue.workdays, ["Sun", "Mon", "Tue"]);
  assert.equal(view.clock.zoneFrom, "device");
  assert.equal((await brief.setQueue({ timeZone: "America/New_York" })).clock.zoneFrom, "setting");
  assert.equal((await brief.clock()).timeZone, "America/New_York", "the brief's clock follows the setting");
  const tool = RPC_TOOLS.find(x => x.name === "set_brief_settings")!;
  assert.equal(tool.input.safeParse({ timeZone: "Mars/Olympus" }).success, false);
  const file = { sweeps: [{ at: "2026-11-23T05:00:00.000Z", complete: true, pages: 1, issues: {} }], log: [], seen: { at: "2026-11-24T06:00:00.000Z", prior: "2026-11-23T20:00:00.000Z" } } as unknown as QueueFile;
  const clock = await brief.clock();
  assert.equal(briefSince(file, TUE, clock, "read"), "2026-11-23T20:00:00.000Z");
  assert.equal(briefSince(file, TUE, clock, "workday"), "2026-11-23T05:00:00.000Z");
});

test("set_brief_plan's dry run reads the link's title first; the pickers search the chat source", async t => {
  const reads: string[] = [];
  const { brief } = await setup(t, { readPlan: async url => { reads.push(url); return { title: "Week of Nov 23", items: [1, 2, 3] }; } });
  assert.deepEqual(await brief.preview(`${ART2}?share=k`), { url: ART2, title: "Week of Nov 23", items: 3 });
  assert.deepEqual(reads, [ART2]);
  assert.equal("error" in await brief.preview("https://example.com"), true);
  const tool = RPC_TOOLS.find(x => x.name === "set_brief_plan")!;
  assert.equal(tool.kind, "planned");
  assert.deepEqual(tool.before?.input?.({ link: ART2 }), { link: ART2 }, "the dry run reads brief_plan with the link");
  assert.deepEqual((await brief.searchChat("people", "ali")).results, [{ id: "UALICE0001", name: "alice" }, { id: "UALICIA001", name: "alicia" }]);
  assert.deepEqual((await brief.searchChat("channels", "plan")).results.map(r => r.name), ["planning", "plans-archive"]);
  const off = await setup(t, { chat: null });
  assert.match((await off.brief.searchChat("people", "x")).error ?? "", /No chat search/);
});

test("chat replies: the link and channel are read from markdown or plain text; ids and names from people and channel results", () => {
  assert.deepEqual(findArtifactLink(`1. #roadmap carol: see ${ART}?a=1 2026-11-20 10:00:00\n2. #planning alice: ${ART2} 2026-11-19 09:00:00`), { url: ART, postedAt: "2026-11-20T10:00:00.000Z", where: "roadmap" });
  assert.equal(findArtifactLink("1. #planning alice: no link here"), null);
  assert.equal(findArtifactLink("https://claude.ai.example.com/artifact/x"), null, "only claude.ai");
  assert.deepEqual(parseChatRefs("## Results\n- **Name:** bob\n  **ID:** UBOB000001\n\n- **Name:** carol\n  **ID:** UCAROL0001", "people"), [{ id: "UBOB000001", name: "bob" }, { id: "UCAROL0001", name: "carol" }]);
});

test("the mcpproxy chat search calls only read-only tools", async () => {
  const args: string[][] = [];
  const chat = mcpproxyChat(async (_c, a) => { args.push(a); return JSON.stringify({ content: [{ text: "{}" }], isError: false }); });
  await chat.messages({ filters: "from:alice", limit: 20 }); await chat.people("al"); await chat.channels("pl");
  assert.ok(args.every(a => a[0] === "call" && a[1] === "tool-read"), "tool-read only");
});

test("the plan card: found, pasted, not found (amber, keeps last week's, a paste field), off and the environment", () => {
  const base: PlanView = { mode: "auto", link: null, linkAt: null, person: { id: null, name: "alice" }, channels: [{ id: null, name: "planning" }], replaceWhenNewer: false, url: ART, source: "found", env: null,
    found: { url: ART, postedAt: "2026-11-23T07:12:00.000Z", where: "planning", foundAt: "2026-11-23T07:15:00.000Z" }, previous: null, check: { at: "x", status: "found", error: null },
    read: { url: ART, at: "2026-11-23T07:15:00.000Z", title: "Week of Nov 23", items: 18 }, canFind: true, findDays: 14, importedAt: null };
  const ok = planCard(base, TUE, "Asia/Jerusalem")!;
  assert.equal(ok.tone, "ok"); assert.equal(ok.title, "Week of Nov 23");
  assert.equal(ok.line, "Found in #planning, Mon 09:12 · claude.ai artifact · read Mon 09:15, 18 items");
  const missing = planCard({ ...base, found: null, previous: base.found, check: { at: "x", status: "not-found", error: null } }, TUE, "Asia/Jerusalem")!;
  assert.equal(missing.tone, "warn"); assert.equal(missing.title, "No plan this week yet");
  assert.equal(missing.line, "Nothing from @alice in #planning since Nov 10 links an artifact. The brief uses last week's until one shows up.");
  assert.deepEqual(missing.tone === "warn" && missing.inUse, { line: "In use: last week's, posted Mon 09:12", url: ART }, "names the plan the brief reads now, with its link");
  assert.ok(missing.tone === "warn" && missing.paste);
  const pasted = planCard({ ...base, mode: "link", link: ART, linkAt: "2026-11-24T07:20:00.000Z", source: "link" }, TUE, "Asia/Jerusalem")!;
  assert.equal(pasted.line, "Pasted Tue 09:20 · read Mon 09:15, 18 items");
  assert.equal(planCard({ ...base, mode: "link", link: ART, linkAt: "2026-11-24T07:20:00.000Z", source: "link", replaceWhenNewer: true }, TUE, "Asia/Jerusalem")!.line, "Pasted Tue 09:20 · read Mon 09:15, 18 items · replaced if a newer one is found in #planning");
  const failed = planCard({ ...base, found: null, previous: base.found, check: { at: "x", status: "error", error: "mcpproxy couldn't run the chat search." } }, TUE, "Asia/Jerusalem")!;
  assert.ok(failed.tone === "error" && failed.paste && failed.retry, "a failed search still offers the paste field");
  assert.equal(failed.line, "mcpproxy couldn't run the chat search. The brief uses last week's until this works.");
  assert.equal(planCard({ ...base, mode: "off", source: "off", url: null }, TUE, "Asia/Jerusalem")?.tone, "quiet");
  assert.match(planCard({ ...base, source: "env" }, TUE, "Asia/Jerusalem")!.line, /^Set by the environment/);
  // The line under the tab is built from the same card, so it never says "found" while the card says otherwise.
  const summary = (plan: PlanView) => briefSummary({ queue: { states: ["triage"], sweepAt: "07:00", timeZone: null, workdays: null, since: "read" }, clock: { timeZone: "Asia/Jerusalem", workdays: ["Mon"], zoneFrom: "host" }, plan }, TUE);
  assert.equal(summary(base), "Sweeps 07:00 on workdays · this week's plan found");
  assert.equal(summary({ ...base, found: null, previous: base.found, check: { at: "x", status: "not-found", error: null } }), "Sweeps 07:00 on workdays · using last week's plan");
  assert.equal(summary({ ...base, found: null, previous: base.found, check: { at: "x", status: "error", error: "x" } }), "Sweeps 07:00 on workdays · plan search failed, using last week's");
  assert.equal(summary({ ...base, found: null, url: null, check: null }), "Sweeps 07:00 on workdays · looking for the plan");
  assert.equal(summary({ ...base, canFind: false }), "Sweeps 07:00 on workdays · no chat search connected");
});
