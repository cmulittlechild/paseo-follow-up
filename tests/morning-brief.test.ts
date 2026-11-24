import { FAKE_SERVERS, discoveryReply, toolOf } from "./fixtures/mcpproxy-tools";
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
  PLAN_WHO_MOVED, applyPlanChange, artifactLinks, briefSummary, effectivePlan, emptyMorningBrief, findArtifactLink, importFromRegistry, morningBriefFileSchema, parseChatRefs, planCard, planSettingsSchema, type PlanView,
} from "../shared/morning-brief";

// Settings → Compass: this week's plan (From Compass, a link, off; the one-time import; a plan arriving from Compass)
// and the brief's settings. Fixtures are fictional (alice, #planning, #roadmap, made-up ids and artifact links).

// Tuesday 2026-11-24, 09:30 in Jerusalem (07:30Z).
const TUE = Date.parse("2026-11-24T07:30:00.000Z");
const H = 3_600_000;
const ART = "https://claude.ai/artifact/0a1b2c3d-week-plan";
const ART2 = "https://claude.ai/artifact/9f8e7d6c-week-plan";

/** The morning-brief skill's registry, same shape, fictional values. */
const REGISTRY = JSON.stringify({ sources: [{ id: "weekly-plan", label: "Weekly plan", url: `${ART}?share=KEY123`, reader: "claude_artifact",
  discovery: { server: "chat", author_id: "UALICE0001", author_name: "alice", channels: [{ id: "CPLAN00001", label: "#planning" }, { id: "CROAD00001", label: "roadmap" }],
    selected_message_ts: "1.2", selected_message_url: "https://chat.example/x", selected_shared_at: "2026-11-23T09:12:00Z", selected_shared_in: "planning", checked_at: "2026-11-23T09:15:00Z", status: "ok", detail: "found" } }] });

function fakeChat() {
  const calls: string[] = [];
  const chat: ChatSearch & { calls: string[] } = {
    calls,
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
  let n = 0;
  const brief = new MorningBrief({ store, chat: o.chat === undefined ? fakeChat() : o.chat, env: () => o.env ?? null, deviceZone: () => "Asia/Jerusalem", registry, now: () => time.now, readPlan: o.readPlan, log: l => logs.push(l), newId: () => `s-moved${++n}` });
  return { brief, store, time, logs, registry };
}

test("the one-time import, then the move: the registry's person and channels become a Compass source that posts the plan, its link the first plan; values never logged", async t => {
  const { brief, logs, time, store } = await setup(t);
  const plan = await brief.planView();
  assert.equal(plan.mode, "compass");
  assert.equal(plan.url, ART, "the link without its share key");
  assert.equal(plan.source, "found");
  assert.equal(plan.found?.where, "planning");
  assert.ok(plan.importedAt);
  const file = await store.read();
  assert.equal(file.plan.person, null, "moved, so cleared");
  assert.deepEqual(file.plan.channels, []);
  assert.ok(file.plan.movedAt);
  assert.deepEqual(file.compass.sources.map(s => ({ who: s.who, roles: s.roles, places: s.places.map(p => p.kind === "conversation" ? `${p.sub}:${p.id}` : p.id) })), [
    { who: { kind: "person", person: { id: "UALICE0001", name: "alice" } }, roles: ["priorities", "plan"], places: ["dm:UALICE0001", "channel:CPLAN00001", "channel:CROAD00001"] },
  ]);
  assert.deepEqual(plan.sources, [{ id: "s-moved1", label: "alice · plan" }], "the plan card names the source that posts it");
  assert.equal(logs.length, 2, "one line for the import, one for the move");
  for (const value of ["alice", "UALICE0001", "planning", "0a1b2c3d", "KEY123"]) assert.ok(!logs.join("\n").includes(value), `the log names no value (${value})`);
  // Once: turning it off sticks across reads, and the move never runs twice.
  await brief.setPlan({ mode: "off" });
  time.now += H;
  assert.equal((await brief.planView()).mode, "off", "the import never runs twice");
  assert.equal((await store.read()).compass.sources.length, 1);
});

test("the import: a missing or unusable registry imports nothing; a setting made before the import is never replaced; Find it for me's file reads as From Compass", async t => {
  const none = await setup(t, { registry: null });
  assert.equal((await none.brief.planView()).mode, "compass", "a new install's plan comes from Compass");
  assert.ok((await none.brief.planView()).importedAt, "it still counts as run");
  assert.equal(importFromRegistry("{not json", TUE), null);
  assert.equal(importFromRegistry(JSON.stringify({ sources: [{ reader: "other", url: ART }] }), TUE), null);
  const linkOnly = importFromRegistry(JSON.stringify({ sources: [{ reader: "claude_artifact", url: ART }] }), TUE)!;
  assert.equal(linkOnly.plan.mode, "link", "no discovery block: the link alone, pasted");
  // A file that already has a choice (an older install that set it) keeps it.
  const kept = await setup(t);
  await kept.store.mutate(f => { f.plan = { ...planSettingsSchema.parse({}), mode: "link", link: ART2, linkAt: new Date(TUE).toISOString() }; });
  assert.equal((await kept.brief.planView()).url, ART2);
  // 2.4's file: mode "auto", a check and a findDay.
  const old = morningBriefFileSchema.parse({ ...emptyMorningBrief(), plan: { mode: "auto", link: null, linkAt: null, person: null, channels: [], replaceWhenNewer: false }, check: { at: "x", status: "found", error: null }, findDay: "2026-11-23" });
  assert.equal(old.plan.mode, "compass");
});

test("effectivePlan: the environment wins; Off reads nothing; a pasted link stays unless a newer plan from Compass replaces it; none this week keeps last week's", () => {
  const f = emptyMorningBrief();
  const at = (h: number) => new Date(TUE + h * H).toISOString();
  const found = { url: ART2, postedAt: at(-1), where: "#planning", foundAt: at(1), source: "s-a1b2c3" };
  const compass = { ...f, plan: { ...f.plan, mode: "compass" as const } };
  assert.deepEqual(effectivePlan({ ...compass, found }, `${ART}?share=x`), { url: ART, source: "env" });
  assert.deepEqual(effectivePlan({ ...compass, plan: { ...compass.plan, mode: "off" }, found }, null), { url: null, source: "off" });
  assert.deepEqual(effectivePlan({ ...compass, found }, null), { url: ART2, source: "found" });
  assert.deepEqual(effectivePlan({ ...compass, found: null, previous: found }, null), { url: ART2, source: "previous" }, "none this week: last week's");
  const link = { ...compass, plan: { ...compass.plan, mode: "link" as const, link: ART, linkAt: at(0) } };
  assert.deepEqual(effectivePlan({ ...link, found }, null), { url: ART, source: "link" }, "replace-when-newer off: the paste stays");
  const replace = { ...link, plan: { ...link.plan, replaceWhenNewer: true } };
  assert.deepEqual(effectivePlan({ ...replace, found }, null), { url: ART2, source: "found" }, "a plan after the paste replaces it");
  assert.deepEqual(effectivePlan({ ...replace, found: { ...found, foundAt: at(-2) } }, null), { url: ART, source: "link" }, "an older one doesn't");
});

test("plans come from Compass on arrival: a newer artifact becomes this week's and its title is read at once; the same or an older one changes nothing", async t => {
  const reads: string[] = [];
  const { brief, time } = await setup(t, { readPlan: async url => { reads.push(url); return { title: "Week of Nov 30", items: [] }; } });
  await brief.planView();
  assert.equal(await brief.recordPlan({ url: ART2, postedAt: "2026-11-24T06:00:00.000Z", where: "#planning", source: "s-moved1" }), true);
  let plan = await brief.planView();
  assert.equal(plan.url, ART2); assert.equal(plan.found?.source, "s-moved1");
  assert.equal(plan.previous?.url, ART, "the imported one is last week's");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(reads, [ART2], "read at once, not the next morning");
  time.now += H;
  assert.equal(await brief.recordPlan({ url: ART2, postedAt: "2026-11-24T06:00:00.000Z", where: "#planning", source: "s-moved1" }), false, "the same link again");
  assert.equal(await brief.recordPlan({ url: "https://claude.ai/artifact/old-one", postedAt: "2026-11-20T06:00:00.000Z", where: "#planning", source: "s-moved1" }), false, "an older one, met by a week's read");
  plan = await brief.planView();
  assert.equal(plan.url, ART2);
  assert.deepEqual(reads, [ART2]);
});

test("plan changes: a pasted link must be a claude.ai artifact and becomes Use a link; who posts it is a Compass source now", async t => {
  assert.deepEqual(applyPlanChange(planSettingsSchema.parse({}), { link: "https://example.com/plan" }, TUE), { ok: false, error: "That isn't a claude.ai artifact link (https://claude.ai/artifact/…)." });
  assert.equal(applyPlanChange(planSettingsSchema.parse({}), { mode: "link" }, TUE).ok, false, "Use a link needs a link");
  const pasted = applyPlanChange(planSettingsSchema.parse({}), { link: `${ART}#frag` }, TUE);
  assert.ok(pasted.ok && pasted.plan.mode === "link" && pasted.plan.link === ART);
  const { brief } = await setup(t);
  await assert.rejects(brief.setPlan({ link: "https://example.com/x" }), /isn't a claude.ai artifact/);
  await assert.rejects(brief.setPlan({ person: { name: "carol" } }), new RegExp(PLAN_WHO_MOVED.slice(0, 30)));
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

test("set_brief_plan's dry run reads the link's title first", async t => {
  const reads: string[] = [];
  const { brief } = await setup(t, { readPlan: async url => { reads.push(url); return { title: "Week of Nov 23", items: [1, 2, 3] }; } });
  assert.deepEqual(await brief.preview(`${ART2}?share=k`), { url: ART2, title: "Week of Nov 23", items: 3 });
  assert.deepEqual(reads, [ART2]);
  assert.equal("error" in await brief.preview("https://example.com"), true);
  const tool = RPC_TOOLS.find(x => x.name === "set_brief_plan")!;
  assert.equal(tool.kind, "planned");
  assert.deepEqual(tool.before?.input?.({ link: ART2 }), { link: ART2 }, "the dry run reads brief_plan with the link");
});

test("chat replies: the link and channel are read from markdown or plain text; ids and names from people and channel results", () => {
  assert.deepEqual(findArtifactLink(`1. #roadmap carol: see ${ART}?a=1 2026-11-20 10:00:00\n2. #planning alice: ${ART2} 2026-11-19 09:00:00`), { url: ART, postedAt: "2026-11-20T10:00:00.000Z", where: "roadmap" });
  assert.equal(findArtifactLink("1. #planning alice: no link here"), null);
  assert.equal(findArtifactLink("https://claude.ai.example.com/artifact/x"), null, "only claude.ai");
  assert.deepEqual(artifactLinks(`see <${ART}?share=K|the plan> and ${ART2}, again ${ART}`), [ART, ART2], "every link once, canonical, even inside a chat link's brackets");
  assert.deepEqual(parseChatRefs("## Results\n- **Name:** bob\n  **ID:** UBOB000001\n\n- **Name:** carol\n  **ID:** UCAROL0001", "people"), [{ id: "UBOB000001", name: "bob" }, { id: "UCAROL0001", name: "carol" }]);
});

test("the mcpproxy chat search calls only read-only tools", async () => {
  const args: string[][] = [];
  const chat = mcpproxyChat(async (_c, a) => { const found = discoveryReply(a); if (found) return found; args.push(a); return JSON.stringify({ content: [{ text: "{}" }], isError: false }); });
  await chat.people("al"); await chat.channels("pl");
  assert.ok(args.every(a => a[0] === "call" && a[1] === "tool-read"), "tool-read only");
  // Whichever server has the chat recipe's tools, found by their shape; each call carries only its tool's inputs.
  assert.deepEqual(args.map(a => toolOf(a)), [{ server: FAKE_SERVERS.chat, tool: "search_users" }, { server: FAKE_SERVERS.chat, tool: "search_channels" }]);
  const people = JSON.parse(args[0].find(x => x.startsWith("--json_args="))!.slice(12));
  assert.equal("query" in people, false, "an input the tool doesn't take is left out");
  assert.deepEqual(people.keywords, ["al"]);
});

test("the plan card: from Compass, pasted, none this week (amber, keeps last week's, a paste field), no source, off and the environment", () => {
  const found = { url: ART, postedAt: "2026-11-23T07:12:00.000Z", where: "#planning", foundAt: "2026-11-23T07:15:00.000Z", source: "s-dana01" };
  const base: PlanView = { mode: "compass", link: null, linkAt: null, replaceWhenNewer: false, url: ART, source: "found", env: null, found, previous: null,
    read: { url: ART, at: "2026-11-23T07:15:00.000Z", title: "Week of Nov 23", items: 18, withoutIssue: 3 }, sources: [{ id: "s-dana01", label: "Dana · product" }], unmoved: [], importedAt: null };
  const ok = planCard(base, TUE, "Asia/Jerusalem")!;
  assert.equal(ok.tone, "ok"); assert.equal(ok.title, "Week of Nov 23");
  assert.equal(ok.line, "From Dana · product in #planning, Mon 09:12 · read Mon 09:15, 18 items, 3 without an issue");
  const missing = planCard({ ...base, found: null, previous: found }, TUE, "Asia/Jerusalem")!;
  assert.equal(missing.tone, "warn"); assert.equal(missing.title, "No plan this week yet");
  assert.equal(missing.line, "Nothing new from Dana · product links an artifact. The brief uses last week's until one shows up.");
  assert.deepEqual(missing.tone === "warn" && missing.inUse, { line: "In use: last week's, posted Mon 09:12", url: ART }, "names the plan the brief reads now, with its link");
  assert.ok(missing.tone === "warn" && missing.paste);
  assert.equal(planCard({ ...base, sources: [], found: null, url: null, source: "none" }, TUE, "Asia/Jerusalem")!.title, "No source posts the plan");
  assert.equal(planCard({ ...base, found: null, url: null, source: "none", read: null }, TUE, "Asia/Jerusalem")!.title, "Waiting for a plan");
  const pasted = planCard({ ...base, mode: "link", link: ART, linkAt: "2026-11-24T07:20:00.000Z", source: "link" }, TUE, "Asia/Jerusalem")!;
  assert.equal(pasted.line, "Pasted Tue 09:20 · read Mon 09:15, 18 items, 3 without an issue");
  assert.equal(planCard({ ...base, mode: "link", link: ART, linkAt: "2026-11-24T07:20:00.000Z", source: "link", replaceWhenNewer: true }, TUE, "Asia/Jerusalem")!.line, "Pasted Tue 09:20 · read Mon 09:15, 18 items, 3 without an issue · replaced by a newer one from Dana · product");
  assert.equal(planCard({ ...base, mode: "off", source: "off", url: null }, TUE, "Asia/Jerusalem")?.tone, "quiet");
  assert.match(planCard({ ...base, source: "env" }, TUE, "Asia/Jerusalem")!.line, /^Set by the environment/);
  // The line under the tab is built from the same card, so it never says "in" while the card says otherwise.
  const summary = (plan: PlanView) => briefSummary({ queue: { states: ["triage"], sweepAt: "07:00", timeZone: null, workdays: null, since: "read", chatHours: 48, calendarDays: 1 }, clock: { timeZone: "Asia/Jerusalem", workdays: ["Mon"], zoneFrom: "host" }, plan }, TUE);
  assert.equal(summary(base), "Sweeps 07:00 on workdays · this week's plan in");
  assert.equal(summary({ ...base, found: null, previous: found }), "Sweeps 07:00 on workdays · using last week's plan");
  assert.equal(summary({ ...base, found: null, url: null }), "Sweeps 07:00 on workdays · waiting for the plan");
  assert.equal(summary({ ...base, sources: [], found: null, url: null }), "Sweeps 07:00 on workdays · no source posts the plan");
});
