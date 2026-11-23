import { rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { briefAnswers } from "../shared/brief";
import type { Ledger, Sources } from "../server/inbox-classifier";
import { Overseer, type OverseerPaseo } from "../server/overseer";
import type { State } from "../shared/model";

// The Overseer's start gate end to end (invariant the-overseer-starts-what-the-developer-asked): the developer's
// latest message, read from the Overseer's own timeline, decides which keys start_workspace may start.

const NOW = Date.parse("2026-11-23T09:00:00.000Z");
const sources = (ledger: Ledger): Sources => ({ ledger: async () => ledger, defer: async () => false, session: async () => false, schedule: async () => false });

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "start-gate-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger: Ledger = [];
  const agents: Record<string, { workspaceId: string }> = {};
  let tail: unknown[] = [];
  let n = 0;
  const paseo: OverseerPaseo = {
    workspaces: {
      async create() { const id = `w${++n}`; return { id, agents: { async create() { const aid = `a${n}`; agents[aid] = { workspaceId: id }; return { id: aid }; } } }; },
      ref: () => ({ refresh: async () => ({ archivedAt: null }) }),
    },
    agents: { ref: (id: string) => ({
      refresh: async () => agents[id] ? { agent: { id, workspaceId: agents[id].workspaceId, status: "idle", archivedAt: null, title: "Overseer", activeTurn: null } } : null,
      send: async () => undefined,
      timeline: { refetch: async () => ({ entries: tail.map((item, i) => ({ seqStart: i, item })) }) },
    }) },
    projects: { list: async () => ({ entries: [{ projectId: "p", projectName: "acme-app" }] }) },
  } as unknown as OverseerPaseo;
  const inbox = {
    async list() { return { rows: [] }; }, async brief() { return null; },
    async noteDelivery(agentId: string, messageId: string | null, by?: "developer") { ledger.push({ agentId, messageId, at: new Date(NOW).toISOString(), ...(by ? { by } : {}) }); },
  };
  const state = { version: 1, workspaces: [] } as unknown as State;
  const overseer = new Overseer({ directory: dir, store: { snapshot: async () => state }, inbox, priorities: { read: async () => [] }, enabled: async () => true, provider: "demo/claude", now: () => NOW,
    tight: async () => false, workspaces: async () => [], sources: sources(ledger) } as never);
  await overseer.start(paseo);
  const ov = (await overseer.state()).agentId!;
  /** The developer typed `text` (after the Overseer said `said`, if given). */
  const typed = (text: string, said?: string) => { tail = [...(said ? [{ type: "user_message", text: "what needs me?" }, { type: "assistant_message", text: said }] : []), { type: "user_message", text }]; };
  /** The Overseer put up a needs_you card, and the developer typed `text` instead of clicking. */
  const typedAfterCard = (text: string, card: Record<string, unknown>) => { tail = [{ type: "user_message", text: "anything new?" }, { type: "tool_call", name: "mcp__follow-up__needs_you", detail: card }, { type: "assistant_message", text: "Asked you on the card." }, { type: "user_message", text }]; };
  /** The developer clicked the Overseer's card: the answer is in the ledger as theirs. */
  const clicked = (text: string) => { ledger.push({ agentId: ov, messageId: `answer-${ledger.length}`, at: new Date(NOW).toISOString(), by: "developer" }); tail = [{ type: "user_message", text, messageId: `answer-${ledger.length - 1}` }]; };
  const start = async (key: string) => await overseer.act(paseo, ov, "start_workspace", { task: `${key} fix it`, project: "acme-app", linear_key: key }) as { planId: string | null; blockers: string[] };
  return { typed, typedAfterCard, clicked, start, overseer, paseo, ov, gate: (key: string | null) => overseer.newWorkspaceGate(paseo, key) };
}

const card = (picks: Record<string, string>) => briefAnswers("Start workspaces for ACME-12 and ACME-14?", [
  { id: "D1", question: "Start a new workspace for ACME-12?", options: [{ letter: "A", label: "New workspace" }, { letter: "B", label: "Skip" }] },
  { id: "D2", question: "Start a new workspace for ACME-14?", options: [{ letter: "A", label: "New workspace" }, { letter: "B", label: "Skip" }] },
], picks);

test("a plural chat request starts every key it names", async t => {
  const f = await fixture(t);
  f.typed("Can you create workspaces for these: ACME-12 ACME-14");
  assert.ok((await f.start("ACME-12")).planId, "ACME-12");
  assert.ok((await f.start("ACME-14")).planId, "ACME-14");
  const other = await f.start("ACME-99");
  assert.equal(other.planId, null, "a key the developer didn't name");
  assert.match(other.blockers.join(" "), /ACME-99/);
});

test("a multi-line request with the keys on their own lines", async t => {
  const f = await fixture(t);
  f.typed("Can you create workspaces for these:\nACME-12\nACME-14\n");
  assert.ok((await f.start("ACME-12")).planId);
  assert.ok((await f.start("ACME-14")).planId);
});

test("a two-decision card answered New workspace twice starts both", async t => {
  const f = await fixture(t);
  f.clicked(card({ D1: "A", D2: "A" }));
  assert.ok((await f.start("ACME-12")).planId);
  assert.ok((await f.start("ACME-14")).planId);
});

test("a mixed card starts only the New workspace decision and names the skipped key", async t => {
  const f = await fixture(t);
  f.clicked(card({ D1: "A", D2: "B" }));
  assert.ok((await f.start("ACME-12")).planId);
  const skipped = await f.start("ACME-14");
  assert.equal(skipped.planId, null);
  assert.match(skipped.blockers.join(" "), /ACME-14/);
});

test("questions and refusals never approve", async t => {
  const f = await fixture(t);
  for (const text of ["which open workspaces need me?", "don't start a workspace yet", "how many agents are running?", "is there an open workspace for ACME-12?"]) {
    f.typed(text);
    const r = await f.start("ACME-12");
    assert.equal(r.planId, null, text);
  }
});

test("a bare yes approves what the Overseer proposed, nothing else", async t => {
  const f = await fixture(t);
  f.typed("yes", "Nobody owns ACME-12 yet. Want me to start a workspace for it?");
  assert.ok((await f.start("ACME-12")).planId);
  assert.equal((await f.start("ACME-14")).planId, null);
  f.typed("go ahead", "ACME-12 and ACME-14 have no workspace. Start one for each?");
  assert.ok((await f.start("ACME-12")).planId);
  assert.ok((await f.start("ACME-14")).planId);
});

test("the refusal says a chat request counts and suggests one plain ask", async t => {
  const f = await fixture(t);
  f.typed("how many agents are running?");
  const refusal = (await f.start("ACME-12")).blockers.join(" ");
  assert.doesNotMatch(refusal, /only (approval|an answer|a click) (from|on) (its|your)( own)? card|card only/i, "never says only the card counts");
  assert.match(refusal, /request in chat/);
  assert.match(refusal, /"Start a workspace for ACME-12\?"/);
  assert.equal(await f.gate("ACME-12"), refusal, "dispatch's caller blocker says the same");
});

test("a typed yes to the Overseer's card approves the keys on that card", async t => {
  const f = await fixture(t);
  f.typedAfterCard("yes, do both", { kind: "decision", ask: "Start workspaces?", decisions: [{ question: "Start a new workspace for ACME-12?" }, { question: "Start a new workspace for ACME-14?" }] });
  assert.ok((await f.start("ACME-12")).planId);
  assert.ok((await f.start("ACME-14")).planId);
  assert.equal((await f.start("ACME-99")).planId, null);
});

test("the Overseer's dispatch carries the developer's own words, never its summary of the issue", async t => {
  const f = await fixture(t);
  const inputs: Record<string, unknown>[] = [];
  f.overseer.dispatcher = {
    preview: async input => { inputs.push(input); return { blockers: [], hash: "h", title: "t", branch: "b", base: { name: "main" }, where: { projectName: "acme-app", projectId: "p" }, instructions: "Work on it." }; },
    dispatch: async () => ({ dispatchId: "d", record: { title: "t", branch: "b", projectName: "acme-app" } }),
    projects: async () => [{ id: "p", name: "acme-app" }],
  };
  const paraphrase = "ACME-12: the export endpoint times out on large accounts; the issue says to stream rows and add a progress bar.";
  f.typed("Can you create workspaces for these:\nACME-12\nACME-14");
  await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: paraphrase, linear_key: "ACME-12" });
  assert.deepEqual(inputs.at(-1), { source: "ACME-12", actionId: "pr" }, "nothing left of the developer's words: no note");
  f.typed("start ACME-12, keep the old endpoint working");
  await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: paraphrase, linear_key: "ACME-12" });
  assert.deepEqual(inputs.at(-1), { source: "ACME-12", note: "keep the old endpoint working", actionId: "pr" });
  f.clicked(briefAnswers("Start workspaces?", [{ id: "D1", question: "Start a new workspace for ACME-12?", options: [{ letter: "A", label: "New workspace" }] }], { D1: "A" }, { D1: "only the backend part" }));
  await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: paraphrase, linear_key: "ACME-12" });
  assert.deepEqual(inputs.at(-1), { source: "ACME-12", note: "only the backend part", actionId: "pr" }, "a card's note on that decision");
  // Work with no issue has no other home: its task text is the source.
  f.typed("open a workspace for the flaky login test");
  await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: "Fix the flaky login test" });
  assert.deepEqual(inputs.at(-1), { source: "Fix the flaky login test", actionId: "pr" });
});
