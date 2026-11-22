import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  applySourcesChange, briefSources, matchServers, parseEvents, parseMail, parseReadTools, parseUpstreams, rangeArgs, sourcesLine, toolFor, upstreamHealth, type SourceRead,
} from "../shared/brief-sources";
import { SourceDirectory } from "../server/source-tools";
import { BriefSources } from "../server/brief-sources";
import { MorningBriefStore } from "../server/morning-brief";
import { liveRankSources } from "../server/ranker";
import { AiJobs } from "../server/ai-jobs";
import { FAKE_SELF_ID, FAKE_SERVERS, discoveryReply, fakeTools, fakeUpstreams, toolOf } from "./fixtures/mcpproxy-tools";

const wrap = (text: string) => `banner\n${JSON.stringify({ content: [{ text }], isError: false })}`;
const tools = () => parseReadTools(JSON.stringify(fakeTools({ mail: true })));

test("recipes match a server by its tools: chat, Linear, calendar and mail; a database has no recipe", () => {
  const m = matchServers(tools());
  const by = Object.fromEntries(m.map(x => [x.server, x.recipe]));
  assert.deepEqual(by, { [FAKE_SERVERS.issues]: "linear", [FAKE_SERVERS.chat]: "chat", [FAKE_SERVERS.calendar]: "calendar", [FAKE_SERVERS.db]: null, [FAKE_SERVERS.mail]: "mail" });
  // Of three message searches, the one that also reaches private channels and DMs.
  assert.equal(toolFor(m, "chat", "messages"), `${FAKE_SERVERS.chat}:search_public_and_private`);
  assert.equal(toolFor(m, "chat", "people"), `${FAKE_SERVERS.chat}:search_users`);
  assert.equal(toolFor(m, "linear", "get_issue"), `${FAKE_SERVERS.issues}:get_issue`);
  assert.equal(toolFor(m, "chat", "messages", s => s !== FAKE_SERVERS.chat), null, "a server the brief turned off isn't used");
});

test("nothing-built-in-about-a-workplace: renamed servers are found the same way", () => {
  const renamed = parseReadTools(JSON.stringify(fakeTools().map(t => ({ ...t, server_name: `x-${t.server_name.length}-${t.server_name.split("").reverse().join("")}` }))));
  const recipes = matchServers(renamed).map(m => m.recipe).filter(Boolean).sort();
  assert.deepEqual(recipes, ["calendar", "chat", "linear"]);
});

test("nothing-built-in-about-a-workplace: no mcpproxy server name in the worker's code; every read goes through the source directory", async () => {
  const files = [...(await readdir("server")).filter(f => f.endsWith(".ts") && !f.endsWith("-source.ts")).map(f => join("server", f)), ...(await readdir("shared")).filter(f => f.endsWith(".ts")).map(f => join("shared", f)), "index.server.ts"];
  for (const f of files) {
    const src = await readFile(f, "utf8");
    // A qualified tool name written into code ("server:tool" passed to tool-read, or --server=<name>).
    assert.doesNotMatch(src, /--tool-name=[a-z]/, `${f} names a tool's server`);
    assert.doesNotMatch(src, /--server=[a-z]/, `${f} names an mcpproxy server`);
    assert.doesNotMatch(src, /"[a-z][\w-]*:(?:list|get|search|read|slack)_\w+"/, `${f} hard-codes a server:tool name`);
    // sources-are-read-only: the one place that runs mcpproxy calls is the source directory, and it calls tool-read.
    if (f !== "server/source-tools.ts") assert.doesNotMatch(src, /run\(\s*"mcpproxy"/, `${f} runs mcpproxy itself; go through server/source-tools.ts`);
  }
  const directory = await readFile("server/source-tools.ts", "utf8");
  assert.deepEqual([...directory.matchAll(/"call", "([\w-]+)"/g)].map(m => m[1]), ["tool-read"], "only tool-read");
});

test("sources-are-read-only: a tool whose annotations say it writes is never matched, and every call is tool-read", async () => {
  const listed = [...fakeTools(), { server_name: "acme-chat", name: "post_message_search", description: "", annotations: { readOnlyHint: false }, schema: { properties: { filters: {}, keywords: {} } } }];
  assert.equal(parseReadTools(JSON.stringify(listed)).some(t => t.name === "post_message_search"), false);
  const calls: string[][] = [];
  const dir = new SourceDirectory(async (_c, args) => { const d = discoveryReply(args); if (d) return d; calls.push(args); return wrap("{}"); });
  await dir.call("chat", "messages", { filters: "is:dm", keywords: [], extra_input: 1 }, { reason: "test", timeoutMs: 1000 });
  assert.deepEqual(calls.map(a => a.slice(0, 2)), [["call", "tool-read"]]);
  const json = JSON.parse(calls[0].find(a => a.startsWith("--json_args="))!.slice(12));
  assert.equal("extra_input" in json, false, "only the inputs the tool's schema has");
  assert.equal(dir.discoveries, 1);
  await dir.call("linear", "get_issue", { id: "ACME-1" }, { reason: "test", timeoutMs: 1000, fit: false });
  assert.equal(dir.discoveries, 1, "discovery is cached until asked again");
  await assert.rejects(dir.call("mail", "messages", {}, { reason: "test", timeoutMs: 1000 }), /Mail tools not found in mcpproxy/);
});

test("health: turned off, quarantined, waiting for a sign-in, not connected, a failed read, off in the brief", () => {
  const ups = parseUpstreams(JSON.stringify(fakeUpstreams({ chat: { connected: false, oauth: {}, authenticated: false }, calendar: { enabled: false }, mail: { connected: false, health: { summary: "dial timeout" } } })));
  assert.equal(upstreamHealth(ups.find(u => u.name === FAKE_SERVERS.chat)).health, "sign-in");
  assert.equal(upstreamHealth(ups.find(u => u.name === FAKE_SERVERS.calendar)).health, "off");
  assert.deepEqual(upstreamHealth(ups.find(u => u.name === FAKE_SERVERS.mail)), { health: "failed", detail: "Not connected: dial timeout" });
  assert.equal(upstreamHealth({ ...ups[0], quarantined: true }).health, "failed");
  const reads: Record<string, SourceRead> = { [`mcp:${FAKE_SERVERS.issues}`]: { at: "2026-11-24T07:00:00Z", ok: false, error: "Linear didn't answer in time." } };
  const rows = briefSources({ upstreams: parseUpstreams(JSON.stringify(fakeUpstreams())), matched: matchServers(tools()), on: { [`mcp:${FAKE_SERVERS.calendar}`]: false }, reads, github: { accounts: 2 } });
  const row = (id: string) => rows.find(r => r.id === id)!;
  assert.deepEqual([row(`mcp:${FAKE_SERVERS.issues}`).health, row(`mcp:${FAKE_SERVERS.issues}`).detail], ["failed", "Linear didn't answer in time."]);
  assert.deepEqual([row(`mcp:${FAKE_SERVERS.calendar}`).health, row(`mcp:${FAKE_SERVERS.calendar}`).detail], ["off", "Off in the brief."]);
  assert.deepEqual([row(`mcp:${FAKE_SERVERS.mail}`).on, row(`mcp:${FAKE_SERVERS.mail}`).detail], [false, "Off by default: it reads your inbox."], "mail is off by default");
  assert.equal(row(`mcp:${FAKE_SERVERS.db}`).kind, "unknown"); assert.equal(row(`mcp:${FAKE_SERVERS.db}`).canToggle, false);
  assert.equal(row("gh").adds, "Review requests on your 2 gh accounts");
  assert.equal(row("paseo").canToggle, false);
  assert.deepEqual(sourcesLine(rows), { tone: "warn", text: "Linear failed" });
  assert.deepEqual(sourcesLine(rows.map(r => ({ ...r, health: r.health === "failed" ? "ok" as const : r.health }))), { tone: "muted", text: "4 sources read" });
});

test("changes: unknown ids, Paseo and sources with no recipe are refused", () => {
  const rows = briefSources({ upstreams: [], matched: matchServers(tools()), on: {}, reads: {}, github: { accounts: 1 } });
  assert.deepEqual(applySourcesChange({}, rows, { on: { [`mcp:${FAKE_SERVERS.mail}`]: true, gh: false } }), { ok: true, on: { [`mcp:${FAKE_SERVERS.mail}`]: true, gh: false } });
  assert.match((applySourcesChange({}, rows, { on: { paseo: false } }) as { error: string }).error, /always read/);
  assert.match((applySourcesChange({}, rows, { on: { [`mcp:${FAKE_SERVERS.db}`]: true } }) as { error: string }).error, /no recipe/);
  assert.match((applySourcesChange({}, rows, { on: { "mcp:nope": true } }) as { error: string }).error, /No source/);
});

test("calendar and mail replies parse tolerantly; a time range fits whatever inputs the tool takes", () => {
  const json = JSON.stringify({ events: [{ summary: "Planning", start: { dateTime: "2026-11-24T10:00:00+02:00" }, htmlLink: "https://calendar.example.com/e/1" }, { title: "1:1 with bob", startTime: "2026-11-24T09:00:00Z" }, { title: "no start" }] });
  assert.deepEqual(parseEvents(json).map(e => e.title), ["1:1 with bob", "Planning"]);
  assert.deepEqual(parseEvents(JSON.stringify({ text: json }))[1].url, "https://calendar.example.com/e/1", "JSON inside a string field");
  assert.deepEqual(parseEvents("- 09:30–10:00 Standup\n- 14:00 Design review"), [{ title: "Standup", start: "09:30", url: null }, { title: "Design review", start: "14:00", url: null }]);
  assert.deepEqual(parseMail(JSON.stringify({ messages: [{ subject: "Can you review the rollout plan?", from: { name: "carol" }, date: "2026-11-24" }] })), [{ from: "carol", subject: "Can you review the rollout plan?", at: "2026-11-24", url: null }]);
  assert.deepEqual(rangeArgs(["timeMin", "timeMax", "timeZone"], "a", "b", "Europe/Paris"), { timeMin: "a", timeMax: "b", timeZone: "Europe/Paris" });
  assert.deepEqual(rangeArgs(["start", "end"], "a", "b", "Europe/Paris"), { start: "a", end: "b" });
});

test("the ranker's chat, calendar and mail reads: the discovered servers, the self id from the tool's description, the brief's switches", async () => {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  const run = async (_c: string, args: string[]) => {
    const d = discoveryReply(args, { mail: true }); if (d) return d;
    const { server, tool } = toolOf(args);
    calls.push({ server, tool, args: JSON.parse(args.find(a => a.startsWith("--json_args="))!.slice(12)) });
    if (tool === "list-events") return wrap(JSON.stringify({ events: [{ title: "Planning", start: "2026-11-24T10:00:00Z" }] }));
    if (tool === "search_emails") return wrap(JSON.stringify({ messages: [{ subject: "Quick question", from: "dave" }] }));
    return wrap("1. DM with alice - alice: can you look at ACME-142? 2026-11-24 08:00:00 UTC");
  };
  const src = liveRankSources(new AiJobs(), { run, tools: new SourceDirectory(run), gate: async id => ({ on: true }) });
  const chat = await src.slack(Date.parse("2026-11-22T00:00:00Z"));
  assert.ok(chat.length >= 1);
  assert.deepEqual(calls.filter(c => c.server === FAKE_SERVERS.chat).map(c => c.args.keywords), [undefined, [`<@${FAKE_SELF_ID}>`]], "DMs, then mentions of the id the tool describes");
  assert.deepEqual(await src.calendar!({ start: "2026-11-24T00:00:00Z", end: "2026-11-25T00:00:00Z", timeZone: "UTC" }), [{ title: "Planning", start: "2026-11-24T10:00:00Z", url: null }]);
  assert.deepEqual(calls.find(c => c.tool === "list-events")!.args, { timeMin: "2026-11-24T00:00:00Z", timeMax: "2026-11-25T00:00:00Z", timeZone: "UTC" });
  assert.deepEqual((await src.mail!(Date.now() - 86_400_000)).map(m => m.text), ["Quick question"]);
  // Off in the brief: the read says so (the ranker shows it as off, not failed), and makes no call.
  const before = calls.length;
  const off = liveRankSources(new AiJobs(), { run, tools: new SourceDirectory(run), gate: async id => ({ on: id !== "calendar" }) });
  await assert.rejects(off.calendar!({ start: "a", end: "b", timeZone: "UTC" }), /off in the brief/);
  assert.equal(calls.length, before);
});

test("BriefSources: the card answers at once and asks mcpproxy after; switches, Retry and the morning check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-sources-"));
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const run = async (_c: string, args: string[]) => { await gate; const d = discoveryReply(args); if (d) return d; return wrap("{}"); };
  const store = new MorningBriefStore(dir);
  let probed = 0; let now = Date.parse("2026-11-24T05:00:00Z");
  const sources = new BriefSources({
    store, tools: new SourceDirectory(run), deviceZone: () => "UTC", now: () => now,
    ranker: async () => ({ lastRunAt: "2026-11-24T04:00:00Z", health: { slack: "failed", github: "ok" }, errors: { slack: "mcpproxy couldn't run the chat search." } }),
    sweep: async () => ({ at: "2026-11-24T04:30:00Z", ok: true, error: null }),
    githubAccounts: async () => ["alice"],
    probe: async id => { probed++; if (id === "chat") throw new Error("still down"); },
  });
  const first = await sources.view({ check: true });
  assert.equal(first.checking, true, "answered before mcpproxy did");
  release(); await sources.settled();
  const v = await sources.view();
  const chat = v.sources.find(r => r.server === FAKE_SERVERS.chat)!;
  assert.deepEqual([chat.health, chat.detail], ["failed", "mcpproxy couldn't run the chat search."], "the ranker's last read of the chat source");
  assert.equal(v.sources.find(r => r.server === FAKE_SERVERS.issues)!.health, "ok", "the sweep's last read");
  // Off: the ranker's gate says so.
  await sources.set({ on: { [chat.id]: false } });
  assert.deepEqual((await sources.gate("chat")).on, false);
  await sources.set({ on: { [chat.id]: true } });
  // Retry: one probe, its line kept until the next read.
  now += 60_000;
  const r = await sources.set({ retry: chat.id });
  assert.deepEqual(r.retrying, [chat.id]);
  await sources.settled();
  assert.equal(probed, 1);
  assert.equal((await sources.view()).sources.find(x => x.id === chat.id)!.detail, "still down");
  await assert.rejects(sources.set({ on: { paseo: false } }), /always read/);
  // The morning check: once a workday, after the sweep time (07:00 by default), never before.
  const checked = (await store.read()).sources.checkedAt;
  await sources.tick();
  assert.equal((await store.read()).sources.checkedAt, checked, "before 07:00: no check");
  now = Date.parse("2026-11-24T07:05:00Z");
  await sources.tick(); await sources.settled();
  const morning = (await store.read()).sources.checkedAt;
  assert.notEqual(morning, checked);
  now += 3_600_000; await sources.tick();
  assert.equal((await store.read()).sources.checkedAt, morning, "once a day");
});
