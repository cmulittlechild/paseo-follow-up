import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, testStore } from "./support/store-temp-dir";
import { LinearIssues } from "../server/linear-issues";
import { FAKE_SERVERS, discoveryReply, toolOf } from "./fixtures/mcpproxy-tools";
import { LinearQueue, LinearQueueStore, type QueueReader } from "../server/linear-queue";
import { RPC_TOOLS } from "../server/agent-parity";
import { toLinearIssue, type LinearIssue } from "../shared/linear-issues";
import {
  QUEUE, changeLine, changesSince, clockFor, defaultWorkdays, diffSweeps, leftCause, markSeen, missedRead, morningDue, workdaySince, zoned,
  type Clock, type QueueIssue, type Sweep,
} from "../shared/linear-queue";

// The Morning brief's Linear queue: the-queue-is-whole, a-change-is-against-what-you-last-saw, the-brief-has-one-timer.
// Fixtures are fictional (ACME-*, alice, bob, carol).

const SUN_THU: Clock = { timeZone: "Asia/Jerusalem", workdays: defaultWorkdays("Asia/Jerusalem") };
const MON_FRI: Clock = { timeZone: "America/New_York", workdays: defaultWorkdays("America/New_York") };
// Tuesday 2026-11-10, 09:30 in Jerusalem.
const TUE = Date.parse("2026-11-10T07:30:00.000Z");
const H = 3_600_000;

type Raw = { key: string; title?: string; priority?: number; state?: string; stateType?: string; due?: string | null; assignee?: string | null; assigneeId?: string | null };
const raw = (r: Raw) => ({ id: r.key, title: r.title ?? `Issue ${r.key}`, priority: { value: r.priority ?? 4, name: "x" }, status: r.state ?? "Todo", statusType: r.stateType ?? "unstarted",
  dueDate: r.due ?? null, team: { name: "Acme" }, url: `https://linear.app/acme/issue/${r.key}`, updatedAt: "2026-11-09T10:00:00.000Z", ...(r.assignee !== undefined ? { assignee: r.assignee ? { name: r.assignee } : null } : {}), ...(r.assigneeId !== undefined ? { assigneeId: r.assigneeId } : {}) });
const issue = (r: Raw): LinearIssue => toLinearIssue(raw(r), true)!;

/** A fake reader: the developer's issues per state type, paged; `left` answers get_issue for issues that left. */
function fakeReader(o: { issues: Raw[]; pageSize?: number; failWith?: () => Error | null; left?: Record<string, Raw | null>; cutOff?: (state: string, limit: number) => boolean }) {
  const calls: string[] = [];
  const reader: QueueReader & { calls: string[]; set(issues: Raw[]): void } = {
    calls,
    set(issues) { o.issues = issues; },
    async queuePage(state, cursor, limit = 25) {
      calls.push(`page ${state} ${cursor ?? "-"} ${limit}`);
      const err = o.failWith?.(); if (err) throw err;
      const mine = o.issues.filter(i => (i.stateType ?? "unstarted") === state);
      const size = Math.min(limit, o.pageSize ?? 25);
      const start = cursor ? Number(cursor) : 0;
      const page = mine.slice(start, start + size).map(issue);
      const next = start + size < mine.length ? String(start + size) : null;
      if (o.cutOff?.(state, limit)) return { issues: page.slice(0, 2), next: null, readable: true, whole: false };
      return { issues: page, next, readable: true, whole: true };
    },
    async leftIssue(key) {
      calls.push(`left ${key}`);
      const r = o.left?.[key];
      return r === undefined ? null : r === null ? null : issue(r);
    },
    async viewerId() { calls.push("viewer"); return "user-alice"; },
  };
  return reader;
}

async function setup(t: TestContext, reader: QueueReader, opts: { clock?: Clock; tight?: () => boolean; workspaces?: Map<string, { workspaceId: string; title: string }> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "linear-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const time = { now: TUE };
  const store = testStore(LinearQueueStore, directory);
  const queue = new LinearQueue({ store, linear: reader, clock: async () => opts.clock ?? SUN_THU, now: () => time.now, tight: opts.tight, workspaces: async () => opts.workspaces ?? new Map() });
  return { queue, store, time, directory };
}

test("the-queue-is-whole: a sweep reads every page of every queue state, through the real reader, with mcpproxy cutting replies at 20 k", async t => {
  // Long titles: 25 to a page is over mcpproxy's cap, 10 fits. The cut page is read again smaller, so nothing drops.
  const titles = (n: number) => `${"Retry failed charges with exponential backoff ".repeat(10)}#${n}`.slice(0, 490);
  const all = Array.from({ length: 63 }, (_, n) => ({ ...raw({ key: `ACME-${n + 1}`, title: titles(n), priority: (n % 4) + 1, stateType: n < 50 ? "unstarted" : "started" }), project: { name: `Billing and invoices ${"q".repeat(300)}` }, labels: "l".repeat(400) }));
  const calls: { state: string; limit: number; cursor: string | null }[] = [];
  const wrap = (text: string) => `banner\n${JSON.stringify({ content: [{ text: `[map[text:${text} type:text]]` }], isError: false })}`;
  const run = async (_c: string, args: string[]) => {
    const found = discoveryReply(args); if (found) return found;
    const a = JSON.parse(args.find(x => x.startsWith("--json_args="))!.slice(12));
    assert.equal(args.includes("tool-read"), true, "only read-only calls");
    assert.equal(toolOf(args).server, FAKE_SERVERS.issues, "the server with Linear's tools, found by its tools");
    calls.push({ state: a.state, limit: a.limit, cursor: a.cursor ?? null });
    const mine = all.filter(i => i.statusType === a.state);
    const start = a.cursor ? Number(a.cursor) : 0;
    const page = mine.slice(start, start + a.limit);
    const json = JSON.stringify({ issues: page, hasNextPage: start + a.limit < mine.length, cursor: String(start + a.limit) });
    return wrap(json.length > 20_000 ? `${json.slice(0, 20_000)}\n\n... [truncated: response exceeded 20000 characters]` : json);
  };
  const { queue } = await setup(t, new LinearIssues(run, () => TUE));
  const r = await queue.sweep("manual");
  assert.equal(r.ok, true); assert.equal(r.complete, true, r.error ?? "");
  assert.equal(r.total, 63, "every issue, none lost to a cut reply");
  const view = await queue.view({});
  assert.equal(view.counts.all, 63);
  assert.equal(view.groups[0].issues[0].project?.length, 200, "an over-long field is clipped, never a dropped issue");
  assert.deepEqual(view.groups.map(g => [g.name, g.count]), [["Urgent", 16], ["High", 16], ["Medium", 16], ["Low", 15]], "grouped by Linear priority");
  assert.ok(calls.some(c => c.limit === 10), "a cut page was read again with 10");
  assert.deepEqual([...new Set(calls.map(c => c.state))], ["triage", "backlog", "unstarted", "started"], "every queue state");
});

test("the-queue-is-whole: a page still cut off at the smallest size, or the page bound, makes the sweep partial; a partial sweep never replaces a complete one", async t => {
  const issues: Raw[] = Array.from({ length: 30 }, (_, n) => ({ key: `ACME-${n + 1}` }));
  let cut = false;
  const reader = fakeReader({ issues, cutOff: () => cut });
  const { queue, time } = await setup(t, reader);
  assert.equal((await queue.sweep("manual")).complete, true);
  const whole = (await queue.read()).sweeps[0];
  cut = true;
  time.now += H;
  reader.set([...issues, { key: "ACME-99", priority: 1 }]);
  const partial = await queue.sweep("manual");
  assert.equal(partial.ok, true); assert.equal(partial.complete, false);
  assert.match(partial.error ?? "", /partial/);
  assert.ok(reader.calls.some(c => / 5$/.test(c)), "re-read with 10, then 5, before giving up");
  const file = await queue.read();
  assert.equal(file.sweeps[0], whole, "the complete snapshot still shows");
  assert.equal(file.log.length, 0, "a partial sweep is diffed against nothing");
  const view = await queue.view({});
  assert.equal(view.status.stale, true, "and the status says the snapshot is older than the last attempt");
  assert.equal(view.status.last?.complete, false);

  // The page bound: more pages than QUEUE.pagesMax.
  const huge: Raw[] = Array.from({ length: QUEUE.pagesMax + 5 }, (_, n) => ({ key: `ACME-${n + 1000}` }));
  const bounded = fakeReader({ issues: huge, pageSize: 1 });
  const b = await setup(t, bounded);
  const r = await b.queue.sweep("morning");
  assert.equal(r.complete, false); assert.equal(r.pages, QUEUE.pagesMax);
  assert.match(r.error ?? "", new RegExp(`${QUEUE.pagesMax * 25}\\+ issues`));
  assert.equal((await b.queue.read()).sweeps.length, 1, "with no complete sweep yet, the partial one shows (flagged)");
  assert.equal((await b.queue.read()).sweeps[0].complete, false);
});

test("the-queue-is-whole: a failed sweep keeps the last complete snapshot and says which one shows", async t => {
  let fail: Error | null = null;
  const reader = fakeReader({ issues: [{ key: "ACME-1" }], failWith: () => fail });
  const { queue, time } = await setup(t, reader);
  await queue.sweep("morning");
  time.now += H;
  fail = new Error("Command failed: mcpproxy call tool-read");
  const r = await queue.sweep("manual");
  assert.equal(r.ok, false); assert.equal(r.error, "Linear couldn't be read.", "one line, no command or path");
  const view = await queue.view({});
  assert.equal(view.counts.all, 1, "yesterday's queue still listed");
  assert.equal(view.status.stale, true);
  assert.equal(view.status.sweptAt, new Date(TUE).toISOString());
  fail = Object.assign(new Error("spawn mcpproxy ENOENT"), { code: "ENOENT" });
  assert.equal((await queue.sweep("manual")).error, "Linear isn't connected.");
});

const sweep = (at: number, issues: Raw[], complete = true): Sweep => ({ at: new Date(at).toISOString(), complete, pages: 1,
  issues: Object.fromEntries(issues.map(r => { const i = issue(r); const q: QueueIssue = { key: i.key, title: i.title, priority: i.priority!.value, state: i.state, stateType: i.stateType, due: i.due, team: i.team, project: null, milestone: null, url: i.url, updatedAt: i.updatedAt }; return [q.key, q]; })) });

test("the-queue-is-whole: an issue raised while the sweep walks the pages is neither left nor new, through the real reader", async t => {
  // Linear as list_issues orders it: 30 of the developer's issues, newest update (or creation) first. Midway through
  // the second sweep's walk, ACME-3 (on page 2: newest first) is raised Low → High, which bumps its updatedAt.
  const created = (n: number) => new Date(TUE - (100 - n) * H).toISOString();
  const live = Array.from({ length: 30 }, (_, n) => ({ ...raw({ key: `ACME-${n + 1}`, priority: 4 }), assigneeId: "user-alice", createdAt: created(n), updatedAt: created(n) }));
  let raiseAfterFirstPage = false;
  const wrap = (text: string) => `banner\n${JSON.stringify({ content: [{ text }], isError: false })}`;
  const run = async (_c: string, args: string[]) => {
    const found = discoveryReply(args); if (found) return found;
    const { tool } = toolOf(args);
    const a = JSON.parse(args.find(x => x.startsWith("--json_args="))!.slice(12));
    assert.equal(args.includes("tool-read"), true, "only read-only calls");
    if (tool === "get_user") return wrap(JSON.stringify({ id: "user-alice", name: "alice" }));
    if (tool === "get_issue") return wrap(JSON.stringify(live.find(i => i.id === a.id)));
    const mine = live.filter(i => i.statusType === a.state).sort((x, y) => (y[a.orderBy as "updatedAt"] as string).localeCompare(x[a.orderBy as "updatedAt"] as string));
    const start = a.cursor ? Number(a.cursor) : 0;
    const page = mine.slice(start, start + a.limit);
    if (raiseAfterFirstPage && start === 0 && mine.length) {
      raiseAfterFirstPage = false;
      Object.assign(live[2], { priority: { value: 2, name: "High" }, updatedAt: new Date(TUE + 2 * H).toISOString() });
    }
    return wrap(JSON.stringify({ issues: page, hasNextPage: start + a.limit < mine.length, cursor: String(start + a.limit) }));
  };
  const { queue, time } = await setup(t, new LinearIssues(run, () => TUE));
  assert.equal((await queue.sweep("morning")).total, 30);
  time.now += 3 * H; raiseAfterFirstPage = true;
  const r = await queue.sweep("manual");
  assert.equal(r.complete, true); assert.equal(r.total, 30, "the raised issue is still in the queue");
  time.now += 3 * H;
  await queue.sweep("manual");
  const lines = changesSince((await queue.read()).log, null).map(c => `${c.key} ${changeLine(c)}`);
  assert.deepEqual(lines, ["ACME-3 raised Low → High"], "a missed read is never a change: no 'left', no 'new', just the raise");
});

test("the-queue-is-whole: a lookup that finds the issue still the developer's puts it back with no log; someone else's reads as reassigned", async t => {
  const issues: Raw[] = [{ key: "ACME-1" }, { key: "ACME-2" }, { key: "ACME-3" }];
  const reader = fakeReader({ issues, left: {
    "ACME-2": { key: "ACME-2", priority: 2, assigneeId: "user-alice" },
    "ACME-3": { key: "ACME-3", assignee: "bob", assigneeId: "user-bob" },
  } });
  const { queue, time } = await setup(t, reader);
  await queue.sweep("morning");
  // The walk misses ACME-2 and ACME-3 (as a page that moved would).
  reader.set([{ key: "ACME-1" }]);
  time.now += H;
  const r = await queue.sweep("manual");
  assert.equal(r.total, 2, "ACME-2 is back in the snapshot from its lookup");
  const file = await queue.read();
  assert.equal(file.sweeps[0].issues["ACME-2"].priority, 2, "with the lookup's facts");
  assert.equal(file.viewer, "user-alice", "the viewer's id is cached");
  const lines = changesSince(file.log, null).map(c => `${c.key} ${changeLine(c)}`);
  assert.deepEqual(lines, ["ACME-2 raised Low → High", "ACME-3 left: reassigned to bob"]);
  time.now += H;
  await queue.sweep("manual");
  assert.equal(reader.calls.filter(c => c === "viewer").length, 1, "get_user is read once, then cached");
  assert.equal(missedRead(issue({ key: "ACME-9", assigneeId: "user-alice" }), null, ["unstarted"]), false, "an unknown viewer is never 'mine'");
  assert.equal(missedRead(issue({ key: "ACME-9", assigneeId: "user-alice", stateType: "completed" }), "user-alice", ["unstarted"]), false, "done is a leave");
});

test("the diff grid: raised, lowered, new, due moved, state, and moved out by each cause; most urgent first across kinds", () => {
  const prev = sweep(TUE - 24 * H, [
    { key: "ACME-142", priority: 4 }, { key: "ACME-163", priority: 3 }, { key: "ACME-151", due: "2026-11-12" }, { key: "ACME-160", state: "Todo" },
    { key: "ACME-120" }, { key: "ACME-121" }, { key: "ACME-131" }, { key: "ACME-132" }, { key: "ACME-133" }, { key: "ACME-170" },
  ]);
  const next = sweep(TUE, [
    { key: "ACME-142", priority: 2 }, { key: "ACME-163", priority: 4 }, { key: "ACME-151", due: "2026-11-13" }, { key: "ACME-160", state: "In Progress", stateType: "unstarted" },
    { key: "ACME-170" }, { key: "ACME-177", priority: 1, due: "2026-11-11" }, { key: "ACME-178", priority: 4 },
  ]);
  const left = {
    "ACME-120": leftCause(issue({ key: "ACME-120", stateType: "completed", state: "Done" }), ["unstarted", "started"]),
    "ACME-121": leftCause(issue({ key: "ACME-121", stateType: "canceled", state: "Canceled" }), ["unstarted", "started"]),
    "ACME-131": leftCause(issue({ key: "ACME-131", assignee: "bob" }), ["unstarted", "started"]),
    "ACME-132": leftCause(issue({ key: "ACME-132", stateType: "backlog", state: "Backlog" }), ["unstarted", "started"]),
    "ACME-133": leftCause(null, ["unstarted", "started"]),
  };
  const log = diffSweeps(prev, next, left);
  assert.equal(log.find(e => e.key === "ACME-170"), undefined, "an unchanged issue isn't logged");
  const changes = changesSince(log, null);
  const by = new Map(changes.map(c => [c.key, c]));
  assert.deepEqual(by.get("ACME-142")!.kinds, ["raised"]); assert.equal(changeLine(by.get("ACME-142")!), "raised Low → High");
  assert.deepEqual(by.get("ACME-163")!.kinds, ["lowered"]); assert.equal(changeLine(by.get("ACME-163")!), "lowered Medium → Low");
  assert.equal(changeLine(by.get("ACME-151")!), "due moved to 2026-11-13");
  assert.equal(changeLine(by.get("ACME-160")!), "Todo → In Progress");
  assert.deepEqual(by.get("ACME-177")!.kinds, ["new"]);
  assert.deepEqual(["ACME-120", "ACME-121", "ACME-131", "ACME-132", "ACME-133"].map(k => changeLine(by.get(k)!)),
    ["left: done", "left: canceled", "left: reassigned to bob", "left: moved to Backlog", "left: gone"]);
  assert.equal(changes[0].key, "ACME-177", "a new Urgent issue due tomorrow first, above the Low → High raise");
  assert.equal(changes[1].key, "ACME-142");
  assert.ok(changes.slice(-5).every(c => c.kinds.includes("left")), "issues that left come last");
  // A partial sweep on either side is diffed against nothing.
  assert.deepEqual(diffSweeps(prev, { ...next, complete: false }), []);
});

test("a-change-is-against-what-you-last-saw: changes fold over every sweep since; a raise taken back says nothing", () => {
  const s0 = sweep(TUE - 48 * H, [{ key: "ACME-1", priority: 4 }, { key: "ACME-2", priority: 3 }]);
  const s1 = sweep(TUE - 24 * H, [{ key: "ACME-1", priority: 3 }, { key: "ACME-2", priority: 1 }, { key: "ACME-3" }]);
  const s2 = sweep(TUE, [{ key: "ACME-1", priority: 2 }, { key: "ACME-2", priority: 3 }]);
  const log = [...diffSweeps(s0, s1), ...diffSweeps(s1, s2)];
  const all = changesSince(log, null);
  assert.equal(changeLine(all.find(c => c.key === "ACME-1")!), "raised Low → High", "Low → Medium → High is one raise");
  assert.equal(all.find(c => c.key === "ACME-2"), undefined, "Medium → Urgent → Medium: nothing to say");
  assert.equal(all.find(c => c.key === "ACME-3"), undefined, "new, then gone again: nothing to say");
  const sinceYesterday = changesSince(log, s1.at);
  assert.equal(changeLine(sinceYesterday.find(c => c.key === "ACME-1")!), "raised Medium → High", "only what moved after the point");
});

test("a-change-is-against-what-you-last-saw: Monday since Friday, and the day boundary is the developer's zone's", async t => {
  // Mon–Fri developer in New York. Friday 18:00 sweep, Monday 07:00 sweep; never opened the brief.
  const fri = Date.parse("2026-11-13T23:00:00.000Z"); // Fri 18:00 New York
  const mon = Date.parse("2026-11-16T12:00:00.000Z"); // Mon 07:00 New York
  const file = { sweeps: [sweep(mon, []), sweep(fri, [])], log: [{ at: new Date(mon).toISOString(), key: "ACME-142", title: "x", url: null, before: { priority: 4, due: null, state: "Todo" }, after: { priority: 2, due: null, state: "Todo" }, left: null }] };
  assert.equal(workdaySince(file, mon + 2 * H, MON_FRI), new Date(fri).toISOString(), "since Friday's sweep");
  // 23:30 UTC on Sunday is already Monday 01:30 in Jerusalem: a sweep then is "today" there, not the last workday's.
  const sunLate = Date.parse("2026-11-15T23:30:00.000Z");
  assert.equal(zoned(sunLate, "Asia/Jerusalem").day, "2026-11-16");
  assert.equal(zoned(sunLate, "UTC").day, "2026-11-15");
  const f2 = { sweeps: [sweep(sunLate, []), sweep(sunLate - 24 * H, [])], log: [] };
  assert.equal(workdaySince(f2, sunLate + H, SUN_THU), new Date(sunLate - 24 * H).toISOString());
  assert.equal(workdaySince(f2, sunLate + 10 * 60_000, { timeZone: "UTC", workdays: ["Mon"] }), new Date(sunLate - 24 * H).toISOString());
  // The brief's view uses it when there's no read yet.
  const reader = fakeReader({ issues: [{ key: "ACME-142", priority: 4 }] });
  const { queue, time } = await setup(t, reader, { clock: MON_FRI });
  time.now = fri; await queue.sweep("morning");
  reader.set([{ key: "ACME-142", priority: 2 }]);
  time.now = mon; await queue.sweep("morning");
  time.now = mon + 2 * H;
  const view = await queue.view({});
  assert.equal(view.since, new Date(fri).toISOString());
  assert.deepEqual(view.changes.map(c => c.line), ["raised Low → High"]);
});

test("a-change-is-against-what-you-last-saw: the developer's open marks the read; a session keeps its since; an agent's read never moves it", async t => {
  assert.deepEqual(markSeen(null, TUE), { at: new Date(TUE).toISOString(), prior: null });
  const s1 = markSeen(null, TUE);
  assert.deepEqual(markSeen(s1, TUE + H), { at: new Date(TUE + H).toISOString(), prior: null }, "an hour later: the same session");
  assert.deepEqual(markSeen(markSeen(s1, TUE + H), TUE + 6 * H), { at: new Date(TUE + 6 * H).toISOString(), prior: new Date(TUE + H).toISOString() }, "a new session: since the last open");

  const reader = fakeReader({ issues: [{ key: "ACME-1", priority: 4 }] });
  const { queue, time } = await setup(t, reader);
  await queue.sweep("morning");
  await queue.open();
  const seen = (await queue.read()).seen;
  time.now += 30 * H;
  reader.set([{ key: "ACME-1", priority: 1 }]);
  await queue.sweep("morning");
  await queue.view({ filter: "changed" }); // an agent's linear_queue
  assert.deepEqual((await queue.read()).seen, seen, "an agent's read moves nothing");
  const opened = await queue.open();
  assert.equal(opened.since, seen!.at, "since the developer last read the brief");
  assert.deepEqual(opened.changes.map(c => c.line), ["raised Low → Urgent"]);
  time.now += H;
  assert.deepEqual((await queue.open()).changes.map(c => c.line), ["raised Low → Urgent"], "still there while they read");
  // The tool can't pass open: its input has no such field.
  const tool = RPC_TOOLS.find(t => t.name === "linear_queue")!;
  assert.equal(tool.input.safeParse({ open: true }).success, false);
  assert.equal(tool.input.safeParse({ filter: "no-workspace", limit: 5 }).success, true);
});

test("the-brief-has-one-timer: the morning sweep runs once a workday after the sweep time, waits for the governor, and nothing else runs on a schedule", async t => {
  const file = { morningDay: null };
  const at = (iso: string) => Date.parse(iso);
  assert.equal(morningDue(file, at("2026-11-10T04:59:00Z"), SUN_THU, "07:00"), false, "06:59 Tuesday in Jerusalem");
  assert.equal(morningDue(file, at("2026-11-10T05:00:00Z"), SUN_THU, "07:00"), true, "07:00");
  assert.equal(morningDue({ morningDay: "2026-11-10" }, at("2026-11-10T09:00:00Z"), SUN_THU, "07:00"), false, "once a day");
  assert.equal(morningDue(file, at("2026-11-13T09:00:00Z"), SUN_THU, "07:00"), false, "Friday is the weekend there");
  assert.equal(morningDue(file, at("2026-11-13T14:00:00Z"), MON_FRI, "07:00"), true, "and a workday in New York");

  let tight = true;
  const reader = fakeReader({ issues: [{ key: "ACME-1" }] });
  const { queue, time } = await setup(t, reader, { tight: () => tight });
  time.now = at("2026-11-10T04:00:00Z");
  assert.equal(await queue.tick(), null, "before 07:00: nothing");
  time.now = at("2026-11-10T06:00:00Z");
  assert.equal(await queue.tick(), null, "the governor is tight: it waits");
  assert.equal(reader.calls.length, 0);
  tight = false;
  const r = await queue.tick();
  assert.equal(r?.trigger, "morning"); assert.equal(r?.complete, true);
  await queue.open();
  assert.equal(queue.isRunning(), false, "opening the brief on a fresh snapshot: no sweep");
  const reads = reader.calls.length;
  for (let i = 0; i < 40; i++) { time.now += 15 * 60_000; assert.equal(await queue.tick(), null); }
  assert.equal(reader.calls.length, reads, "ten hours of ticks read nothing more");

  // Opening the brief sweeps on a snapshot older than 6 h, in the background.
  await queue.open();
  assert.equal(queue.isRunning(), true, "older than 6 h: one sweep, behind the reply");
});

test("the ranker reads the snapshot: top issues by priority plus every changed one; a fresh install sweeps once first", async t => {
  const many: Raw[] = Array.from({ length: 60 }, (_, n) => ({ key: `ACME-${n + 1}`, priority: n < 45 ? 3 : 4 }));
  const reader = fakeReader({ issues: many });
  const { queue, time } = await setup(t, reader);
  const first = await queue.forRanker();
  assert.equal(first.length, QUEUE.rankerTop, "no snapshot: one sweep, then the top 40");
  assert.ok(reader.calls.length > 0);
  time.now += 24 * H;
  reader.set(many.map(r => r.key === "ACME-60" ? { ...r, priority: 2 } : r));
  await queue.sweep("morning");
  time.now += H;
  const next = await queue.forRanker();
  assert.equal(next[0].key, "ACME-60", "the raised one, most urgent first");
  assert.equal(next[0].change, "raised Low → High");
  const calls = reader.calls.length;
  await queue.forRanker();
  assert.equal(reader.calls.length, calls, "with a snapshot, the ranker reads no Linear");
});

test("the queue view: each issue's workspace or none, filters, and counts that add up", async t => {
  const reader = fakeReader({ issues: [{ key: "ACME-1", priority: 1 }, { key: "ACME-2", priority: 2 }, { key: "ACME-3", priority: 0 }] });
  const { queue } = await setup(t, reader, { workspaces: new Map([["ACME-2", { workspaceId: "w2", title: "Audit log export" }]]) });
  await queue.sweep("morning");
  const all = await queue.view({});
  assert.deepEqual(all.groups.map(g => g.name), ["Urgent", "High", "No priority"], "No priority last");
  assert.equal(all.groups[1].issues[0].workspace?.title, "Audit log export");
  assert.deepEqual(all.counts, { all: 3, noWorkspace: 2, changed: 0 });
  const none = await queue.view({ filter: "no-workspace", limit: 1 });
  assert.deepEqual(none.groups.flatMap(g => g.issues.map(i => i.key)), ["ACME-1"]);
  assert.equal(none.more, 1);
  assert.equal(none.groups.reduce((n, g) => n + g.count, 0), 2, "group counts add up to the filter's total");
  assert.equal(clockFor({ timeZone: null, workdays: null }, null, "Asia/Jerusalem").workdays.join(), "Sun,Mon,Tue,Wed,Thu");
});
