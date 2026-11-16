// The message queue end to end on a real daemon (a-message-is-saved-before-sent-and-arrives-once, docs/workspaces.md
// "The message queue"): an answer reaches its agent exactly once while Paseo is unreachable, across a reload mid-send,
// behind a permission prompt and from a brief card, and every answer RPC replies fast while Paseo is slow.
//
// The worker runs inside the daemon, so Paseo is made "unreachable" or "slow" without killing it: the daemon starts
// with PASEO_DAEMON_URL pointing at a TCP proxy in this script, so only the plugin worker's own daemon connection
// (server/daemon.ts daemonOptions) goes through it. This script's client and the CLI talk to the daemon port directly.
// Proxy modes: pass; refuse (listener closed, sockets destroyed); delay (every worker→daemon frame held N s: a slow
// resume); hold (from the first frame matching a pattern: hold that frame, or forward it and hold the replies).
//
// Usage: node scripts/check-message-queue.mjs [--pack <paseo-follow-up.tgz>] [--out <dir>] [--cases a,b]
//        node scripts/check-message-queue.mjs --baseline --pack <main.tgz>   (reply-timing only, recorded, never asserted)
//        PLAYWRIGHT_CORE=<dir> CHROMIUM=<binary> node scripts/check-message-queue.mjs --renders   (delivery-state renders)
// Run it through ~/paseo-harness/tools/harness-slot. Writes <out>/message-queue.json (default
// docs/evidence/message-queue), or message-queue-main.json with --baseline; a queue run embeds the baseline's timing
// table when that file is there. A failed check fails the run (exit 1), except with --baseline.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync, readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { performance } from "node:perf_hooks";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon, waitUntil } from "./harness.mjs";
import { fakeGithub } from "./fake-github.mjs";
import { harnessEnv, harnessConfig, daemonCrashes } from "./harness-env.mjs";
import { createRequire } from "node:module";
import { openHome } from "./ui-home.mjs";
import { assertNoRealNames } from "./real-names.mjs";
await harness();
const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const baseline = process.argv.includes("--baseline");
// --renders: its own daemon (web UI on, FOLLOW_UP_QUEUE_TIME_SCALE so Retrying and Failed come within minutes).
const renders = process.argv.includes("--renders");
/** --renders --only message: only Needs you's row for a forward that didn't go out (needs the Overseer path). */
const rendersOnly = renders ? arg("--only", null) : null;
/** 0.25: the attempt deadline is 30 s (long enough to shoot Sending), Failed comes ~5 min after an unconfirmed send. */
const RENDER_TIME_SCALE = 0.25;
const ALL_CASES = ["unreachable-then-back", "back-within-20s", "reload-mid-send", "permission-prompt", "card-answer", "reply-timing", "busy-agent", "answer-plus-repair", "reply-timing-b"];
/**
 * Cases that run on the scaled clock (FOLLOW_UP_QUEUE_TIME_SCALE): only alone (`--cases forward-stuck`), since the scale
 * shrinks every attempt deadline and retry, which would change what the other cases see.
 */
const SCALED_CASES = ["forward-stuck"];
/** forward-stuck's scale: stuck after 30 s (MESSAGE_STUCK_MS × scale), an attempt deadline of 6 s, Failed in ~70 s. */
const STUCK_TIME_SCALE = 0.05;
/** Cases still to write (recorded in the JSON as todo); none left. */
const LATER_CASES = [];
const wanted = renders ? ["renders"] : baseline ? ["reply-timing", "reply-timing-b"] : (arg("--cases") ? arg("--cases").split(",") : ALL_CASES);
for (const c of wanted.filter(c => c !== "renders")) assert.ok([...ALL_CASES, ...SCALED_CASES].includes(c), `unknown case ${c}; known: ${[...ALL_CASES, ...SCALED_CASES].join(", ")}`);
const scaled = wanted.some(c => SCALED_CASES.includes(c));
assert.ok(!scaled || wanted.length === 1, `${SCALED_CASES.join(", ")} run alone (the scaled clock changes every other case)`);
/** Every answer RPC replies within this while Paseo is slow (an-ack-never-waits-on-paseo). */
const REPLY_BUDGET_MS = 300;
/** The slow resume the reply-timing case simulates: every worker→daemon frame waits this long. */
const RESUME_MS = 60_000;
const out = resolve(arg("--out", "docs/evidence/message-queue"));
const root = await fs.mkdtemp(join(tmpdir(), "follow-message-queue-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const fixture = join(root, "fixture");
await Promise.all([home, plugin, fixture, out].map(p => fs.mkdir(p, { recursive: true })));
const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(); const proxyPort = await freePort();
const url = `ws://127.0.0.1:${port}/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { script: "scripts/check-message-queue.mjs", baseline, pack: null, paseo: null, cases: {}, checks: [], timing: null, mainTiming: null, todo: LATER_CASES };
const check = (name, ok, detail = {}) => { report.checks.push({ name, ok: !!ok, ...detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`); return !!ok; };

// ---- the proxy between the worker and the daemon -----------------------------------------------------------------

/**
 * Client→daemon bytes are cut into WebSocket frames after the upgrade request (whose Sec-WebSocket-Extensions line is
 * dropped, so frames are never compressed and a pattern can be matched in them).
 */
class Proxy {
  constructor(listenPort, targetPort) { this.listenPort = listenPort; this.targetPort = targetPort; this.conns = new Set(); this.accepted = 0; this.policy = { kind: "pass" }; this.server = null; this.matched = 0; this.acceptedAt = []; this.resetAt = []; this.open = 0; this.maxOpenWhileReset = 0; }
  async listen() {
    if (this.server) return;
    this.server = createServer(socket => this.accept(socket));
    await new Promise((r, j) => { this.server.once("error", j); this.server.listen(this.listenPort, "127.0.0.1", r); });
  }
  accept(client) {
    if (this.policy.kind === "reset") {
      // Unreachable, counted: every connection attempt is accepted and reset at once (the worker sees a failed connect).
      this.resetAt.push(Date.now()); this.open++; this.maxOpenWhileReset = Math.max(this.maxOpenWhileReset, this.open);
      client.on("close", () => { this.open--; }); client.on("error", () => undefined); client.destroy(); return;
    }
    this.accepted++; this.acceptedAt.push(Date.now());
    const upstream = connect(this.targetPort, "127.0.0.1");
    const c = { client, upstream, handshake: true, head: Buffer.alloc(0), buf: Buffer.alloc(0), upHeld: false, downHeld: false, upQueue: [], downQueue: [], chain: Promise.resolve(), closed: false };
    this.conns.add(c);
    const end = () => {
      if (c.closed) return; c.closed = true; this.conns.delete(c);
      // hold with onClose "flush": what the worker wrote before closing still reaches the daemon (TCP would deliver it).
      if (c.upQueue.length && this.policy.onClose === "flush") for (const f of c.upQueue.splice(0)) upstream.write(f);
      upstream.end(); client.destroy();
    };
    client.on("data", chunk => this.up(c, chunk));
    upstream.on("data", chunk => { if (c.downHeld) c.downQueue.push(chunk); else client.write(chunk); });
    client.on("close", end); client.on("error", end);
    upstream.on("close", () => client.destroy()); upstream.on("error", () => client.destroy());
  }
  up(c, chunk) {
    if (c.handshake) {
      c.head = Buffer.concat([c.head, chunk]);
      const at = c.head.indexOf("\r\n\r\n");
      if (at < 0) return;
      const request = c.head.subarray(0, at).toString("latin1").split("\r\n").filter(l => !/^sec-websocket-extensions:/i.test(l)).join("\r\n");
      c.upstream.write(Buffer.from(`${request}\r\n\r\n`, "latin1"));
      c.handshake = false; chunk = c.head.subarray(at + 4); c.head = null;
      if (!chunk.length) return;
    }
    c.buf = Buffer.concat([c.buf, chunk]);
    for (;;) { const f = nextFrame(c.buf); if (!f) break; c.buf = c.buf.subarray(f.length); this.frame(c, c.buf.length ? f.bytes : f.bytes, f.text); }
  }
  frame(c, bytes, text) {
    const p = this.policy;
    if (c.upHeld) { c.upQueue.push(bytes); return; }
    if (p.kind === "delay") { const due = Date.now() + p.ms; c.chain = c.chain.then(async () => { await sleep(due - Date.now()); if (!c.closed) c.upstream.write(bytes); }); return; }
    if (p.kind === "kill" && text !== null && p.match.test(text)) { this.matched++; c.client.destroy(); c.upstream.destroy(); return; }
    if (p.kind === "hold" && text !== null && p.match.test(text)) {
      this.matched++;
      if (p.direction === "up") { c.upHeld = true; c.upQueue.push(bytes); return; }
      c.upstream.write(bytes); c.downHeld = true; return;
    }
    c.upstream.write(bytes);
  }
  async pass() {
    this.policy = { kind: "pass" };
    for (const c of this.conns) {
      c.upHeld = false; for (const f of c.upQueue.splice(0)) c.upstream.write(f);
      c.downHeld = false; for (const d of c.downQueue.splice(0)) c.client.write(d);
    }
    await this.listen();
  }
  async refuse() {
    this.policy = { kind: "refuse" };
    const server = this.server; this.server = null;
    if (server) await new Promise(r => { server.close(() => r()); for (const c of this.conns) { c.client.destroy(); c.upstream.destroy(); } });
    for (const c of this.conns) { c.client.destroy(); c.upstream.destroy(); }
  }
  /** Unreachable but counted: the listener stays, every connection is reset on accept (resetAt, maxOpenWhileReset). */
  async reset() {
    await this.listen(); this.policy = { kind: "reset" }; this.resetAt = []; this.maxOpenWhileReset = 0;
    for (const c of this.conns) { c.client.destroy(); c.upstream.destroy(); }
  }
  /** Every worker→daemon frame (not the upgrade) reaches the daemon `ms` later, in order: a slow resume. */
  async delay(ms) { await this.listen(); this.policy = { kind: "delay", ms }; }
  /** From the first frame matching `match`: "up" holds it (it never reached the daemon), "down" forwards it and holds every reply. */
  async hold(match, direction, onClose = "drop") { await this.listen(); this.matched = 0; this.policy = { kind: "hold", match, direction, onClose }; }
  /** A frame matching `match` drops its connection (the call fails, the next one reconnects); everything else passes. */
  async kill(match) { await this.listen(); this.matched = 0; this.policy = { kind: "kill", match }; }
  async close() { await this.refuse(); }
}
/** One complete client frame at the start of `buf` (masked, per RFC 6455), with its text unmasked when it is a data frame. */
function nextFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskAt = off; if (masked) off += 4;
  if (buf.length < off + len) return null;
  const bytes = Buffer.from(buf.subarray(0, off + len));
  let text = null;
  if (opcode === 1 || opcode === 2 || opcode === 0) {
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i % 4)];
    text = payload.toString("utf8");
  }
  return { bytes, text, length: off + len };
}

// ---- the daemon ------------------------------------------------------------------------------------------------

const proxy = new Proxy(proxyPort, port);
let daemon; let client; let failed = false; let github = null;
const bin = join(root, "bin");
/** Fixture `gh`: GraphQL reads answer every requested example/app PR as open and conflicting; everything else `[]`. */
const FAKE_GH = `#!/usr/bin/env node
if (process.env.GH_REPO !== "example/app") throw new Error("Missing repository authentication context");
if (process.argv[3] !== "graphql") { console.log("[]"); process.exit(0); }
const query = process.argv.find(a => a.startsWith("query=")) || "";
const repository = { defaultBranchRef: { name: "main" } };
for (const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)) {
  const n = Number(m[2]);
  repository[m[1]] = { number: n, title: "Export change " + n, url: "https://github.com/example/app/pull/" + n, state: "OPEN", headRefName: "export-" + n, headRefOid: "fixture-head-" + n, baseRefName: "main", isDraft: false, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "APPROVED", baseRef: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [] } };
}
console.log(JSON.stringify({ data: { repository } }));
`; let browser = null;
const queuePath = join(home, "plugin-data/follow-up/queue.json");
const readQueue = async () => JSON.parse(await fs.readFile(queuePath, "utf8").catch(() => '{"items":[],"recent":[]}'));
const promptText = r => r.input?.type === "message" ? (r.input.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n") : "";
/** What the fixture provider was actually prompted with: a resend Paseo would hide from the timeline still shows here. */
const receipts = async (agentId, prefix) => (await fs.readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.agentId === agentId && promptText(r).startsWith(prefix));
const timelineRows = async (agentId, prefix) => (await client.fetchAgentTimeline(agentId, { projection: "canonical", limit: 200 })).entries.map(e => e.item).filter(i => i.type === "user_message" && String(i.text ?? "").startsWith(prefix)).length;
const copies = async (agentId, prefix) => ({ provider: (await receipts(agentId, prefix)).length, timeline: await timelineRows(agentId, prefix) });
const rpc = (method, input = {}) => client.invokePluginRpc("follow-up", method, input);
async function timed(method, input) {
  const start = performance.now();
  const reply = await Promise.race([rpc(method, input).then(v => ({ ok: true, v }), e => ({ ok: false, error: e instanceof Error ? e.message : String(e) })), sleep(RESUME_MS + 15_000).then(() => ({ ok: false, error: "no reply within the resume + 15 s" }))]);
  return { ms: Math.round(performance.now() - start), ...reply };
}
const cfg = { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" };
let api;
/** A followed workspace with one fixture agent that has had a turn (so it is loaded and its chat is readable). */
async function workspace(title, { track = true } = {}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dir = join(root, "ws", slug); await fs.mkdir(dir, { recursive: true });
  const w = await api.workspaces.create({ title, source: { kind: "directory", path: dir } });
  const agent = await w.agents.create({ config: cfg, title: `${title} main` });
  await client.sendMessage(agent.id, `Fixture: start ${slug}`, { messageId: `start-${slug}` });
  await waitUntil(`${title}: the first turn`, async () => (await receipts(agent.id, "Fixture: start")).length && (await client.fetchAgent(agent.id))?.agent?.status === "idle", { baseMs: 30_000 });
  if (track) await waitUntil(`${title} is followed`, async () => { try { await rpc("follow.refresh", {}); await rpc("follow.activate", { workspaceId: w.id }); return true; } catch { return false; } }, { baseMs: 60_000, everyMs: 500 });
  return { workspaceId: w.id, agentId: agent.id };
}
async function ask(agentId, title) {
  const r = await rpc("follow.ask-question", { agentId, title, question: `${title}: which way should the export go?`, options: [{ letter: "A", label: "Keep the CSV export" }, { letter: "B", label: "Switch to JSON lines" }], recommend: "A" });
  return r.question.id;
}
/**
 * A brief card: the agent calls needs_you during a turn (a fixture-scripts.json step, as the agent) and the brief is
 * built when that turn ends. The workspace isn't followed, so its decision stays a card instead of becoming a question.
 */
async function briefCard(agentId, ask) {
  const prompt = `Fixture: brief ${agentId}`;
  const scriptsPath = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsPath, "utf8").catch(() => "{}"));
  scripts[prompt] = [{ rpc: "follow.needs-you", input: { ask, kind: "decision", decisions: [{ question: "Which export format?", options: [{ label: "CSV" }, { label: "JSON lines" }], recommend: 0 }] } }, { item: { type: "assistant_message", text: "Which export format should the report use?" } }];
  await fs.writeFile(scriptsPath, JSON.stringify(scripts));
  await client.sendMessage(agentId, prompt, { messageId: `brief-${agentId}` });
  const brief = await waitUntil(`the brief card for ${agentId}`, async () => { const b = (await rpc("follow.inbox-brief", { agentId })).brief; return b?.state === "open" && b.decisions?.length ? b : null; }, { baseMs: 30_000, everyMs: 500 });
  return { briefId: brief.id, decisionId: brief.decisions[0].id };
}
const delivery = async (workspaceId, questionId) => (await rpc("follow.get", { workspaceId })).workspace?.questions.find(q => q.id === questionId)?.answer?.delivery ?? null;
const answerPrefix = q => `Follow-up answer ${q} (`;
const queueItem = async predicate => { const q = await readQueue(); return q.items.find(predicate) ?? null; };
const settledItem = async predicate => { const q = await readQueue(); return !q.items.some(predicate) && q.recent.find(predicate) || null; };
const isAnswer = (workspaceId, questionId) => i => i.kind === "answer" && i.ref.workspaceId === workspaceId && i.ref.questionId === questionId;
/** Exactly one copy, and still one a few seconds later (a late duplicate would land in that window). */
async function exactlyOnce(name, agentId, prefix, extra = {}) {
  await sleep(5_000);
  const n = await copies(agentId, prefix);
  return check(name, n.provider === 1 && n.timeline === 1, { ...extra, copies: n });
}


let prNumber = 100;
/** Registers a fresh example/app PR (conflicting on the fake GitHub) and waits for its repair batch to be pending. */
async function pendingRepair(w) {
  const number = ++prNumber;
  await rpc("follow.register-pr", { agentId: w.agentId, repo: "example/app", number, stack: `Export ${number}` });
  await rpc("follow.refresh", { workspaceId: w.workspaceId }).catch(() => undefined);
  const batch = await waitUntil(`a pending repair for example/app#${number}`, async () => (await rpc("follow.get", { workspaceId: w.workspaceId })).workspace?.batches.find(b => b.state === "pending" && b.tasks.some(t => t.kind === "conflict")) ?? null, { baseMs: 90_000, everyMs: 1000 });
  return { number, batchId: batch.id };
}
const batchOf = async (w, batchId) => (await rpc("follow.get", { workspaceId: w.workspaceId })).workspace?.batches.find(b => b.id === batchId) ?? null;
const batchPrefix = batchId => `Follow-up batch ${batchId}`;
/** Every prompt the fixture got, for an agent (text only). */
const allPrompts = async agentId => (await fs.readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.agentId === agentId).map(promptText);
/** Parks the agent in a running turn until `release()` (a fixture-scripts gate step). */
async function busyTurn(agentId, gate) {
  const prompt = `Fixture: busy ${gate}`;
  const scriptsPath = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsPath, "utf8").catch(() => "{}"));
  scripts[prompt] = [{ item: { type: "assistant_message", text: "Working through the export change." } }, { gate }];
  await fs.writeFile(scriptsPath, JSON.stringify(scripts));
  await client.sendMessage(agentId, prompt, { messageId: `busy-${gate}` });
  await waitUntil("the agent is mid-turn", async () => existsSync(join(home, `fixture-gated-${gate}`)) && (await client.fetchAgent(agentId))?.agent?.status === "running", { baseMs: 20_000 });
  return { release: () => fs.writeFile(join(home, `fixture-gate-${gate}`), "") };
}
/** Makes `agentId` Follow-up's Overseer (overseer.json), so follow.overseer-act runs its send_to_agent as it. */
async function seedOverseer(agentId, workspaceId) {
  await fs.writeFile(join(home, "plugin-data/follow-up/overseer.json"), JSON.stringify({ version: 1, agentId, workspaceId, startedAt: new Date().toISOString(), generation: 1, error: null }));
}
const forward = (overseerId, agentId, text) => rpc("follow.overseer-act", { agentId: overseerId, tool: "send_to_agent", args: { agentId, text } });
const messageItems = async agentId => { const q = await readQueue(); return { items: q.items.filter(i => i.kind === "message" && i.ref.agentId === agentId), recent: q.recent.filter(i => i.kind === "message" && i.ref.agentId === agentId) }; };
const undelivered = async workspaceId => (await rpc("follow.get", { workspaceId })).workspace?.undelivered ?? [];

const cases = {

  /**
   * Renders every delivery state on the three surfaces that show it: the question dialog's answer block, the chat brief
   * card after its answer, and Home's Needs you row for a Failed answer. Light and dark, desktop and phone; no
   * horizontal overflow at 390. One item per surface goes Sending → Retrying → Failed: its send is held at the proxy
   * past the (scaled) attempt deadline, then every worker timeline read drops its connection, so each arrival check is
   * unknown until the ladder ends in Failed.
   */
  async renders() {
    const r = report.cases.renders = { timeScale: RENDER_TIME_SCALE, shots: [], states: {} };
    const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE ?? "", "package.json"))("playwright-core");
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
    const origin = `http://127.0.0.1:${port}`;
    const serverId = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
    const DESKTOP = { width: 1280, height: 900 }; const PHONE = { width: 390, height: 844 };
    const COMBOS = [["desktop", DESKTOP, "light"], ["desktop", DESKTOP, "dark"], ["phone", PHONE, "light"], ["phone", PHONE, "dark"]];
    const shotDir = out;
    // Home opens on Getting started until setup is done or skipped.
    await rpc("follow.set-onboarding", { action: "skip" });
    // The words each state shows (shared/queue.ts deliveryStatus), on the dialog and on the card.
    const WORDS = { sending: /Sending to the agent/, queued: /Queued: Paseo unreachable/, retrying: /reads the agent's chat before sending again/, failed: /Check the agent's chat, then Retry/ };
    // One followed workspace per question state, one unfollowed agent per card state (needs_you's decision stays a card there).
    const Q = {}; const C = {};
    const QTEXT = {
      inflight: ["Cache eviction policy", "Which eviction policy should the cache use?", ["Least recently used", "Time to live"]],
      queued: ["Log retention period", "How long should request logs be kept?", ["Fourteen days", "Ninety days"]],
      notsent: ["Default page size", "What page size should the listing use by default?", ["Twenty five", "One hundred"]],
      sent: ["Timezone for reports", "Which timezone should weekly reports use?", ["UTC", "The team's local time"]],
    };
    for (const [key, [title, question, labels]] of Object.entries(rendersOnly === "message" ? {} : QTEXT)) {
      const w = await workspace(`Delivery ${key}`);
      const res = await rpc("follow.ask-question", { agentId: w.agentId, title, question, options: labels.map((label, i) => ({ letter: "AB"[i], label })), recommend: "A" });
      Q[key] = { ...w, title: `Delivery ${key}`, qid: res.question.id, qtitle: title, prompt: `Fixture: start delivery-${key}` };
      const cw = await workspace(`Card ${key}`, { track: false });
      C[key] = { ...cw, title: `Card ${key}`, ask: `Pick the ${key} export format`, prompt: `Fixture: start card-${key}`, ...(await briefCard(cw.agentId, `Pick the ${key} export format`)) };
    }
    const answerQ = key => rpc("follow.answer-question", { workspaceId: Q[key].workspaceId, questionId: Q[key].qid, choice: "A", action: "send" });
    const answerC = key => rpc("follow.brief-action", { agentId: C[key].agentId, briefId: C[key].briefId, decisionId: C[key].decisionId, choice: "A", answerId: `harness-render-${key}-01` });
    const qState = async key => (await delivery(Q[key].workspaceId, Q[key].qid))?.state ?? null;
    // The card's state from its queue item (the agent's next turn replaces the brief, so the inbox can't tell), worded as
    // the card's mirror (shared/queue.ts deliveryOf).
    const cState = async key => {
      const q = await readQueue(); const mine = i => i.kind === "brief" && i.ref.answerId === `harness-render-${key}-01`;
      const i = q.items.find(mine) ?? q.recent.find(mine);
      if (!i) return null;
      return i.state === "queued" ? (i.nextAt === null && !i.reason ? "sending" : "queued") : i.state === "uncertain" ? "retrying" : i.state;
    };

    const openChat = async (page, t) => {
      await page.goto(origin);
      await page.getByText("Follow-up", { exact: true }).first().waitFor({ timeout: 30_000 });
      await page.getByText("Skip setup", { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
      await page.getByText(t.title, { exact: true }).first().click({ timeout: 30_000 });
      // The agent's tab (its first prompt may be scrolled out of a long chat, which renders only what's near the end).
      await page.getByText(`${t.title} main`, { exact: true }).first().waitFor({ timeout: 30_000 });
    };
    const SURFACES = {
      async dialog(page, key, words) {
        await openChat(page, Q[key]);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByRole("tab", { name: /^Questions/ }).first().click();
        await page.getByRole("button", { name: new RegExp(`^${Q[key].qid}, ${Q[key].qtitle}`) }).first().click();
        await page.getByText(QTEXT[key][1]).last().waitFor();
        if (words) await page.getByText(words).filter({ visible: true }).first().waitFor();
        await page.getByText(words ?? QTEXT[key][1]).filter({ visible: true }).last().scrollIntoViewIfNeeded().catch(() => {});
      },
      async card(page, key, words) {
        await openChat(page, C[key]);
        // Once the agent replied, the answered card sits inside that turn's collapsed details.
        const ask = page.getByText(C[key].ask).filter({ visible: true }).first();
        if (!await ask.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
          await page.getByText("View turn details").filter({ visible: true }).last().click();
          await ask.waitFor();
        }
        if (words) await page.getByText(words).filter({ visible: true }).first().waitFor();
        await page.getByText(words ?? C[key].ask).filter({ visible: true }).last().scrollIntoViewIfNeeded().catch(() => {});
      },
      // A forward that didn't go out (Workspace.undelivered): its row says so, with Retry and Cancel.
      async message(page, key, words) {
        await openHome(page, { origin, serverId });
        const row = page.getByText(words).filter({ visible: true }).first();
        if (!await row.isVisible().catch(() => false)) await page.getByText(M.title, { exact: true }).filter({ visible: true }).first().click().catch(() => {});
        await row.waitFor();
        await page.getByText(M.title, { exact: true }).filter({ visible: true }).last().click().catch(() => {});
        await page.getByText("Cancel", { exact: true }).filter({ visible: true }).first().waitFor();
        await page.getByText(words).filter({ visible: true }).last().scrollIntoViewIfNeeded().catch(() => {});
      },
      async needsyou(page, key) {
        await openHome(page, { origin, serverId });
        const row = page.getByText(`Your ${Q[key].qid} answer may not have reached the agent`).filter({ visible: true }).first();
        if (!await row.isVisible().catch(() => false)) await page.getByText(Q[key].title, { exact: true }).filter({ visible: true }).first().click().catch(() => {});
        await row.waitFor();
        // Open the row: its detail carries the item's Retry and Open agent.
        await page.getByText(Q[key].title, { exact: true }).filter({ visible: true }).last().click().catch(() => {});
        await page.getByText("Open agent").filter({ visible: true }).first().waitFor();
        await page.getByText(`Your ${Q[key].qid} answer may not have reached the agent`).filter({ visible: true }).last().scrollIntoViewIfNeeded().catch(() => {});
      },
    };
    async function shot(surface, state, key, words, [form, viewport, theme]) {
      const name = `mq-${surface}-${state}-${form}-${theme}`;
      const context = await browser.newContext({ viewport: DESKTOP, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage(); page.setDefaultTimeout(30_000);
      try {
        // Phones open at desktop width (Paseo's sidebar is a drawer there), then narrow.
        await SURFACES[surface](page, key, words);
        if (form === "phone") {
          await page.setViewportSize(viewport);
          await page.waitForTimeout(800);
          const anchor = words ?? (surface === "dialog" ? QTEXT[key][1] : surface === "card" ? C[key].ask : "Open agent");
          const shown = () => page.getByText(anchor).filter({ visible: true }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
          // Narrowing can fold the answered card's turn details again.
          if (!await shown() && surface === "card") await page.getByText("View turn details").filter({ visible: true }).last().click().catch(() => {});
          await page.getByText(anchor).filter({ visible: true }).first().waitFor();
          await page.getByText(anchor).filter({ visible: true }).first().scrollIntoViewIfNeeded().catch(() => {});
        }
        await page.mouse.move(1, viewport.height - 1);
        await page.waitForTimeout(400);
        const text = await page.evaluate(() => document.body.innerText);
        assertNoRealNames(text, name);
        const overflow = await page.evaluate(() => ({ scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth }));
        const path = join(shotDir, `${name}.png`);
        await page.screenshot({ path, animations: "disabled", caret: "hide" });
        const entry = { name, surface, state, form, theme, file: `docs/evidence/message-queue/${name}.png`, overflow };
        r.shots.push(entry);
        if (form === "phone") check(`render ${name}: no horizontal overflow at 390`, overflow.scrollWidth <= overflow.innerWidth, overflow);
        else check(`render ${name}`, true);
      } catch (error) {
        await fs.mkdir(join(shotDir, "failed"), { recursive: true }).catch(() => {}); await page.screenshot({ path: join(shotDir, "failed", `${name}.png`) }).catch(() => {});
        check(`render ${name}`, false, { error: (error instanceof Error ? error.message : String(error)).split("\n")[0] });
      } finally { await context.close(); }
    }
    const shootAll = async (surface, state, key, words) => { for (const combo of COMBOS) await shot(surface, state, key, words, combo); };
    const wait = (what, fn, ms = 60_000) => waitUntil(what, fn, { baseMs: ms, everyMs: 500 });

    // Needs you's message row: a forward that never left (Paseo unreachable) past MESSAGE_STUCK_MS × scale.
    const M = { title: "Stuck forward" };
    if (rendersOnly === "message") {
      const w = await workspace(M.title);
      const o = await workspace("Overseer stand-in", { track: false });
      await seedOverseer(o.agentId, o.workspaceId);
      await proxy.refuse();
      await forward(o.agentId, w.agentId, "Please rerun the export with the new filter.");
      const stuck = await wait("the stuck forward shows on the workspace", async () => (await undelivered(w.workspaceId)).find(m => m.agentId === w.agentId) ?? null, 400_000).catch(() => null);
      r.states.message = stuck && { state: stuck.state, agentTitle: stuck.agentTitle };
      check("renders: the forward reads as didn't go out", !!stuck, r.states.message ?? {});
      const words = `A message to ${M.title} main didn't go out`;
      await shootAll("message", "stuck", "message", words);
      await proxy.pass();
      r.pngs = r.shots.map(s => s.file);
      return;
    }

    // Sent and Not sent (Paseo reachable).
    await answerQ("sent"); await answerC("sent");
    await wait("the sent answers land", async () => await qState("sent") === "sent" && await cState("sent") === "sent");
    await answerQ("notsent");
    await rpc("follow.set-follow-settings", { workspace: { workspaceId: Q.notsent.workspaceId, follow: false } });
    await answerC("notsent");
    await client.archiveAgent(C.notsent.agentId).catch(error => { r.states.cardNotSent = `couldn't archive: ${error.message}`; });
    // Unfollowed, the workspace reads as nothing (follow.get), so the queue item tells when it was cancelled.
    const notsentItem = async () => { const q = await readQueue(); return q.recent.find(i => i.kind === "answer" && i.ref.workspaceId === Q.notsent.workspaceId) ?? null; };
    await wait("the question's answer is cancelled", async () => (await notsentItem())?.state === "cancelled");
    r.states.notsentReason = (await notsentItem())?.reason ?? null;
    // Following again keeps the cancelled answer (resolved once), and puts the question back on the panel.
    await rpc("follow.set-follow-settings", { workspace: { workspaceId: Q.notsent.workspaceId, follow: true } });
    await rpc("follow.activate", { workspaceId: Q.notsent.workspaceId }).catch(() => undefined);
    await wait("the followed-again question reads Not sent", async () => await qState("notsent") === "cancelled", 30_000).catch(() => undefined);
    const cardCancelled = await wait("the card's answer is cancelled", async () => await cState("notsent") === "cancelled", 30_000).then(() => true, () => false);
    r.states.sent = { question: await qState("sent"), card: await cState("sent") };
    r.states.notsent = { question: await qState("notsent"), card: await cState("notsent") };
    check("renders: Not sent reached on the question", r.states.notsent.question === "cancelled", r.states.notsent);
    await shootAll("dialog", "sent", "sent", /Sent to/); await shootAll("card", "sent", "sent", null);
    await shootAll("dialog", "notsent", "notsent", /stopped following/);
    // A card's answer is cancelled only when its agent is archived, and an archived agent has no chat tab to open:
    // recorded, not shot.
    r.states.cardNotSent = cardCancelled ? "cancelled (the agent is archived, so its chat card can't be opened to shoot)" : `not reached: ${r.states.notsent.card}`;
    check("renders: Not sent reached on the card (state only)", cardCancelled, { card: r.states.notsent.card });

    // Sending: the send is held at the proxy; the attempt deadline (120 s × scale) bounds the window.
    await proxy.hold(/"send_agent_message_request"/, "up", "drop");
    await answerQ("inflight"); await answerC("inflight");
    await wait("both sends are out and unanswered", async () => await qState("inflight") === "sending" && await cState("inflight") === "sending", 20_000);
    const sendingAt = Date.now();
    // All eight at once: the card reads its "Sending…" label (it has no detail line while sending).
    await Promise.all(COMBOS.flatMap(combo => [shot("dialog", "sending", "inflight", WORDS.sending, combo), shot("card", "sending", "inflight", /^Sending…$/, combo)]));
    r.states.sendingShotSeconds = Math.round((Date.now() - sendingAt) / 1000);
    check("renders: the Sending shots finished inside the attempt deadline", Date.now() - sendingAt < 120_000 * RENDER_TIME_SCALE, { seconds: r.states.sendingShotSeconds });
    await wait("the unconfirmed sends read Retrying", async () => await qState("inflight") === "retrying" && await cState("inflight") === "retrying", 90_000);

    // Queued: Paseo unreachable (the held sends are dropped with their connection; they never reached the agent).
    await proxy.refuse();
    await answerQ("queued"); await answerC("queued");
    await wait("the new answers wait as Queued", async () => await qState("queued") === "queued" && await cState("queued") === "queued", 30_000);
    await shootAll("dialog", "queued", "queued", WORDS.queued); await shootAll("card", "queued", "queued", WORDS.queued);

    // Retrying, then Failed: Paseo is back, but every worker timeline read drops, so no arrival check can tell.
    await proxy.kill(/"fetch_agent_timeline_request"/);
    await shootAll("dialog", "retrying", "inflight", WORDS.retrying); await shootAll("card", "retrying", "inflight", WORDS.retrying);
    await wait("the unconfirmed answers end Failed", async () => await qState("inflight") === "failed" && await cState("inflight") === "failed", 600_000);
    r.states.failed = { question: await qState("inflight"), card: await cState("inflight"), timelineReadsDropped: proxy.matched };
    await shootAll("dialog", "failed", "inflight", WORDS.failed); await shootAll("card", "failed", "inflight", WORDS.failed);
    await shootAll("needsyou", "failed", "inflight", null);
    await proxy.pass();
    r.pngs = r.shots.map(s => s.file);
  },
  async "unreachable-then-back"() {
    const r = report.cases["unreachable-then-back"] = {};
    const { workspaceId, agentId } = await workspace("Unreachable export");
    const qid = await ask(agentId, "Export format while away");
    await proxy.reset();
    const answered = Date.now();
    await rpc("follow.answer-question", { workspaceId, questionId: qid, choice: "A", action: "send" });
    await sleep(21_000);
    const item = await queueItem(isAnswer(workspaceId, qid));
    const d = await delivery(workspaceId, qid);
    r.whileRefused = { item: item && { state: item.state, reason: item.reason, attempts: item.attempts, nextAt: item.nextAt }, delivery: d, secondsSinceAnswer: Math.round((Date.now() - answered) / 1000) };
    // It waits on the outage probe (one connect-only try every 15 s), not the never-left ladder: attempts and nextAt are recorded.
    r.whileRefused.connectAttempts = proxy.resetAt.length; r.whileRefused.maxConcurrent = proxy.maxOpenWhileReset;
    check("unreachable: the item waits as queued, Paseo unreachable", item?.state === "queued" && item.reason === "Paseo unreachable", r.whileRefused);
    check("unreachable: the question reads queued", d?.state === "queued", { delivery: d });
    check("unreachable: the probe tries one connection at a time, about one per 15 s", proxy.maxOpenWhileReset <= 1 && proxy.resetAt.length <= 4, { attempts: proxy.resetAt.length, maxConcurrent: proxy.maxOpenWhileReset, secondsDown: r.whileRefused.secondsSinceAnswer });
    check("unreachable: nothing reached the agent", (await copies(agentId, answerPrefix(qid))).provider === 0);
    await proxy.pass();
    const back = Date.now();
    await waitUntil("the answer arrives after the daemon is back", async () => (await receipts(agentId, answerPrefix(qid))).length > 0, { baseMs: 60_000 });
    r.arrivedSecondsAfterBack = Math.round((Date.now() - back) / 100) / 10;
    r.workerConnectsAfterBack = proxy.acceptedAt.filter(t => t >= back).map(t => Math.round((t - back) / 100) / 10);
    // "At once when the daemon connection reopens": timed from the worker's first connection after the daemon is back.
    // Nothing else makes the worker reconnect here (no other daemon traffic), so that first connection is the queue's
    // own retry (up to NEVER_LEFT_MS later); r.reconnectSecondsAfterBack records how long that took.
    const reopened = proxy.acceptedAt.find(t => t >= back);
    r.reconnectSecondsAfterBack = reopened ? Math.round((reopened - back) / 100) / 10 : null;
    r.arrivedSecondsAfterReconnect = reopened ? Math.round((Date.now() - reopened) / 100) / 10 : null;
    check("unreachable: arrives within 15 s of the worker's connection reopening", r.arrivedSecondsAfterReconnect !== null && r.arrivedSecondsAfterReconnect <= 15, { secondsAfterReconnect: r.arrivedSecondsAfterReconnect, reconnectSecondsAfterBack: r.reconnectSecondsAfterBack, secondsAfterBack: r.arrivedSecondsAfterBack });
    await exactlyOnce("unreachable: exactly once", agentId, answerPrefix(qid));
    r.settled = await waitUntil("the item settles as sent", () => settledItem(isAnswer(workspaceId, qid)), { baseMs: 15_000 }).catch(() => null);
    check("unreachable: the item settles as sent", r.settled?.state === "sent", { settled: r.settled && { state: r.settled.state, to: r.settled.to } });
  },

  async "reload-mid-send"() {
    const r = report.cases["reload-mid-send"] = {};
    // landed: the send reached the daemon but its reply never came back (the arrival check must stop a second copy).
    // lost: the send never reached the daemon (the arrival check finds nothing, so it is sent again, once).
    for (const variant of ["landed", "lost"]) {
      const v = r[variant] = {};
      const { workspaceId, agentId } = await workspace(`Reload ${variant}`);
      const qid = await ask(agentId, `Reload ${variant} format`);
      await proxy.hold(/"send_agent_message_request"/, variant === "landed" ? "down" : "up", "drop");
      await rpc("follow.answer-question", { workspaceId, questionId: qid, choice: "B", action: "send" });
      await waitUntil(`${variant}: the send is out and unanswered`, async () => proxy.matched > 0 && (await queueItem(isAnswer(workspaceId, qid)))?.state === "sending", { baseMs: 20_000 });
      if (variant === "landed") await waitUntil("landed: the agent has it before the reload", async () => (await receipts(agentId, answerPrefix(qid))).length > 0, { baseMs: 20_000 });
      v.beforeReload = { ...(await copies(agentId, answerPrefix(qid))), state: (await queueItem(isAnswer(workspaceId, qid)))?.state };
      await cli("plugin", "reload", "follow-up");
      await proxy.pass();
      v.settled = await waitUntil(`${variant}: the item settles after the reload`, () => settledItem(isAnswer(workspaceId, qid)), { baseMs: 60_000 }).catch(() => null);
      check(`reload ${variant}: settles as sent`, v.settled?.state === "sent", { beforeReload: v.beforeReload, settled: v.settled && { state: v.settled.state, reason: v.settled.reason } });
      await exactlyOnce(`reload ${variant}: exactly once`, agentId, answerPrefix(qid));
    }
  },

  async "permission-prompt"() {
    const r = report.cases["permission-prompt"] = {};
    const { workspaceId, agentId } = await workspace("Permission export");
    await client.sendMessage(agentId, "Fixture: permission tool Bash", { messageId: "permission-export" });
    const pending = await waitUntil("the agent sits on a permission prompt", async () => (await client.fetchAgent(agentId))?.agent?.pendingPermissions?.[0], { baseMs: 20_000 });
    const qid = await ask(agentId, "Export format behind a prompt");
    await rpc("follow.answer-question", { workspaceId, questionId: qid, choice: "A", action: "send" });
    const d = await waitUntil("the answer waits behind the prompt", async () => { const x = await delivery(workspaceId, qid); return x?.state === "queued" && x.reason ? x : null; }, { baseMs: 20_000 }).catch(() => null);
    r.deferred = d;
    check("permission: queued with a permission reason", d?.state === "queued" && /permission/i.test(d.reason ?? ""), { delivery: d });
    check("permission: nothing sent while the prompt is open", (await copies(agentId, answerPrefix(qid))).provider === 0);
    await client.respondToPermission(agentId, pending.id, { behavior: "allow" });
    const answeredAt = Date.now();
    await waitUntil("the answer arrives once the prompt is answered", async () => (await receipts(agentId, answerPrefix(qid))).length > 0, { baseMs: 90_000 });
    r.arrivedSecondsAfterPermission = Math.round((Date.now() - answeredAt) / 100) / 10;
    await exactlyOnce("permission: exactly once", agentId, answerPrefix(qid), { seconds: r.arrivedSecondsAfterPermission });
  },

  async "card-answer"() {
    const r = report.cases["card-answer"] = {};
    const { agentId } = await workspace("Brief export", { track: false });
    const { briefId, decisionId } = await briefCard(agentId, "Pick the export format for the report");
    const answerId = "harness-card-answer-0001";
    await rpc("follow.brief-action", { agentId, briefId, decisionId, choice: "A", answerId });
    // A double click (inside the quiet window): the same answerId returns the recorded answer.
    const twice = await rpc("follow.brief-action", { agentId, briefId, decisionId, choice: "A", answerId }).then(v => ({ ok: true, state: v.brief.state, answerId: v.brief.answerId }), e => ({ ok: false, error: e.message }));
    r.doubleClick = twice;
    check("card: a double click returns the recorded answer", twice.ok && twice.answerId === answerId, twice);
    const prefix = `Follow-up answer ${decisionId} (`;
    await waitUntil("the card's answer arrives", async () => (await receipts(agentId, prefix)).length > 0, { baseMs: 30_000 });
    await exactlyOnce("card: exactly once", agentId, prefix);
    // A late Retry after it arrived: the agent's next turn may have replaced the card (refused as replaced) or not
    // (the recorded answer comes back). Either way nothing is sent again.
    const late = await rpc("follow.brief-action", { agentId, briefId, decisionId, choice: "A", answerId }).then(v => ({ ok: true, state: v.brief.state, delivery: v.brief.delivery ?? null }), e => ({ ok: false, error: e.message }));
    r.lateRetry = late;
    await exactlyOnce("card: the same answerId again sends nothing", agentId, prefix, { late });
  },


  async "back-within-20s"() {
    // The outage probe: with nothing else touching the daemon, an answer that waits as "Paseo unreachable" goes out within
    // 20 s (real time, scale 1) of Paseo coming back.
    const r = report.cases["back-within-20s"] = { timeScale: 1 };
    const { workspaceId, agentId } = await workspace("Probe export");
    const qid = await ask(agentId, "Export format after an outage");
    await proxy.reset();
    const down = Date.now();
    await rpc("follow.answer-question", { workspaceId, questionId: qid, choice: "A", action: "send" });
    await waitUntil("the answer waits as Paseo unreachable", async () => { const i = await queueItem(isAnswer(workspaceId, qid)); return i?.state === "queued" && i.reason === "Paseo unreachable"; }, { baseMs: 30_000 });
    // Long enough for a few probes.
    await sleep(40_000);
    r.outage = { seconds: Math.round((Date.now() - down) / 1000), connectAttempts: proxy.resetAt.length, gaps: proxy.resetAt.slice(1).map((t, i) => Math.round((t - proxy.resetAt[i]) / 100) / 10), maxConcurrent: proxy.maxOpenWhileReset, item: await queueItem(isAnswer(workspaceId, qid)).then(i => i && { state: i.state, reason: i.reason, attempts: i.attempts, nextAt: i.nextAt }) };
    check("probe: about one connect per 15 s during the outage, never two at once", proxy.maxOpenWhileReset <= 1 && r.outage.connectAttempts >= 2 && r.outage.connectAttempts <= Math.ceil(r.outage.seconds / 15) + 1, r.outage);
    check("probe: nothing reached the agent during the outage", (await copies(agentId, answerPrefix(qid))).provider === 0);
    await proxy.pass();
    const back = Date.now();
    await waitUntil("the answer arrives after Paseo is back", async () => (await receipts(agentId, answerPrefix(qid))).length > 0, { baseMs: 60_000 }).catch(() => undefined);
    r.arrivedSecondsAfterBack = (await receipts(agentId, answerPrefix(qid))).length ? Math.round((Date.now() - back) / 100) / 10 : null;
    check("probe: delivered within 20 s of Paseo coming back (no other activity)", r.arrivedSecondsAfterBack !== null && r.arrivedSecondsAfterBack <= 20, { seconds: r.arrivedSecondsAfterBack });
    await exactlyOnce("probe: exactly once", agentId, answerPrefix(qid));
  },

  async "busy-agent"() {
    const r = report.cases["busy-agent"] = {};
    const w = await workspace("Busy export");
    await rpc("follow.control", { workspaceId: w.workspaceId, enable_auto_sends: false });
    const qid = await ask(w.agentId, "Export format while busy");
    const { batchId } = await pendingRepair(w);
    const turn = await busyTurn(w.agentId, "busy-export");
    await rpc("follow.send", { workspaceId: w.workspaceId, batchId });
    await rpc("follow.answer-question", { workspaceId: w.workspaceId, questionId: qid, choice: "A", action: "send" });
    await waitUntil("the answer steers into the running turn", async () => (await receipts(w.agentId, answerPrefix(qid))).length > 0, { baseMs: 30_000 });
    const waiting = await waitUntil("the batch line says why it waits", async () => { const b = await batchOf(w, batchId); return b?.refusal?.reason ? b : null; }, { baseMs: 30_000 }).catch(() => null);
    r.whileBusy = { batchState: waiting?.state, reason: waiting?.refusal?.reason ?? null, agentStatus: (await client.fetchAgent(w.agentId))?.agent?.status, prompts: (await allPrompts(w.agentId)).map(t => t.split("\n")[0]) };
    check("busy: the answer went alone (no repair in it)", (await allPrompts(w.agentId)).filter(t => t.includes(answerPrefix(qid))).every(t => !t.includes(batchPrefix(batchId))), r.whileBusy);
    check("busy: the repair waits while the turn runs", (await receipts(w.agentId, batchPrefix(batchId))).length === 0 && (await allPrompts(w.agentId)).every(t => !t.includes(batchPrefix(batchId))), r.whileBusy);
    check("busy: the batch line shows the wait reason", /turn to end/.test(r.whileBusy.reason ?? ""), { reason: r.whileBusy.reason });
    await turn.release();
    const ended = Date.now();
    const repairItem = async () => { const q = await readQueue(); const i = [...q.items, ...q.recent].find(i => i.kind === "repair" && i.ref.batchId === batchId); return i && { state: i.state, attempts: i.attempts, nextAt: i.nextAt, reason: i.reason }; };
    r.repairItemAtRelease = await repairItem();
    const went = await waitUntil("the repair goes once the turn ends", async () => (await allPrompts(w.agentId)).some(t => t.includes(batchPrefix(batchId))), { baseMs: 90_000, everyMs: 1000 }).then(() => true, () => false);
    if (!went) {
      r.stuck = { repairItem: await repairItem(), batch: await batchOf(w, batchId).then(b => b && { state: b.state, refusal: b.refusal ?? null }), agent: (await client.fetchAgent(w.agentId))?.agent?.status };
      check("busy: the repair goes after the turn ends", false, r.stuck);
      return;
    }
    r.repairSecondsAfterTurnEnd = Math.round((Date.now() - ended) / 100) / 10;
    await sleep(5_000);
    const repairs = (await allPrompts(w.agentId)).filter(t => t.includes(batchPrefix(batchId))).length;
    const answers = (await allPrompts(w.agentId)).filter(t => t.includes(answerPrefix(qid))).length;
    r.after = { repairs, answers, batch: (await batchOf(w, batchId))?.state };
    check("busy: the repair goes once after the turn ends, the answer once", repairs === 1 && answers === 1, { ...r.after, seconds: r.repairSecondsAfterTurnEnd });
  },

  async "answer-plus-repair"() {
    const r = report.cases["answer-plus-repair"] = {};
    const w = await workspace("Ride-along export");
    // Auto is on (first tracking turns it on); the repair waits out its settle window, and the answer takes it along.
    // A fresh install holds every auto-send until setup is done ("sends once setup finishes"), so skip setup first.
    await rpc("follow.set-onboarding", { action: "skip" });
    const qid = await ask(w.agentId, "Export format with a repair due");
    const { batchId } = await pendingRepair(w);
    const before = (await rpc("follow.get", { workspaceId: w.workspaceId })).workspace;
    r.autoOn = before?.enable_auto_sends;
    // What sendDecision reads, for when the repair doesn't ride along.
    const why = x => ({ sendWait: x?.sendWait ?? null, dormant: x?.dormant ?? null, runtimeReason: x?.runtimeReason ?? null, runtimeBusy: x?.runtimeBusy ?? null, backgroundBusy: x?.backgroundBusy ?? null, hold: x?.hold ?? null, batch: (b => b && { state: b.state, createdAt: b.createdAt, refusal: b.refusal ?? null })(x?.batches.find(b => b.id === batchId)), prs: x?.prs.map(p => ({ key: p.key, error: p.error ?? null, complete: p.snapshot?.complete ?? null })) });
    r.beforeAnswer = why(before);
    await rpc("follow.answer-question", { workspaceId: w.workspaceId, questionId: qid, choice: "B", action: "send" });
    await waitUntil("the envelope arrives", async () => (await allPrompts(w.agentId)).some(t => t.includes(answerPrefix(qid))), { baseMs: 30_000 });
    await sleep(5_000);
    const prompts = (await allPrompts(w.agentId)).filter(t => t.includes(answerPrefix(qid)) || t.includes(batchPrefix(batchId)));
    const both = prompts.filter(t => t.includes(answerPrefix(qid)) && t.includes(batchPrefix(batchId)));
    const one = both[0] ?? "";
    const parts = one.split(/\n---\n/).map(x => x.trim());
    r.messages = prompts.length; r.parts = parts.map(p => p.split("\n")[0]);
    r.batch = (await batchOf(w, batchId))?.state; r.answer = (await delivery(w.workspaceId, qid))?.state;
    r.afterAnswer = why((await rpc("follow.get", { workspaceId: w.workspaceId })).workspace);
    check("ride-along: Auto is on", r.autoOn === true);
    check("ride-along: exactly one message holds both parts", prompts.length === 1 && both.length === 1, { messages: prompts.length, firstLines: r.parts });
    check("ride-along: answer first, then the batch, split by ---", parts.length === 2 && parts[0].startsWith(answerPrefix(qid)) && parts[1].startsWith(batchPrefix(batchId)), { parts: r.parts });
    check("ride-along: the batch is sent and the answer is sent", r.batch === "sent" && r.answer === "sent", { batch: r.batch, answer: r.answer, beforeAnswer: r.beforeAnswer, afterAnswer: r.afterAnswer });
    check("ride-along: the timeline shows it once", (await timelineRows(w.agentId, answerPrefix(qid))) === 1);
  },

  async "reply-timing-b"() {
    const r = report.cases["reply-timing-b"] = {};
    const w = await workspace("Timing repairs");
    await rpc("follow.control", { workspaceId: w.workspaceId, enable_auto_sends: false });
    const { batchId } = await pendingRepair(w);
    const o = await workspace("Overseer stand-in", { track: false });
    await seedOverseer(o.agentId, o.workspaceId);
    // Two forwards that never left (Paseo unreachable): Retry and Cancel act on them while Paseo is slow.
    await proxy.refuse();
    await forward(o.agentId, w.agentId, "Please also export the archive table.").catch(e => { r.forwardError = e.message; });
    await forward(o.agentId, w.agentId, "And keep the old column names.").catch(e => { r.forwardError = e.message; });
    let queued = [];
    if (baseline) await sleep(20_000);
    else queued = (await waitUntil("two forwards wait as queued", async () => { const m = await messageItems(w.agentId); return m.items.filter(i => i.state === "queued" && i.attempts > 0).length >= 2 ? m.items : null; }, { baseMs: 30_000 })).map(i => i.id);
    await proxy.delay(RESUME_MS);
    const rows = [];
    const time = async (action, method, input) => { const t = await timed(method, input); rows.push({ action, method, ms: t.ms, ok: t.ok, ...(t.ok ? {} : { error: t.error }) }); console.log(`  ${action}: ${t.ms} ms${t.ok ? "" : ` (${t.error})`}`); return t; };
    await time("send (manual Send of a repair batch)", "follow.send", { workspaceId: w.workspaceId, batchId });
    await time("queue-action retry", "follow.queue-action", { itemId: queued[0] ?? "message:none", action: "retry" });
    await time("queue-action cancel", "follow.queue-action", { itemId: queued[1] ?? "message:none", action: "cancel" });
    await time("Overseer forward (send_to_agent)", "follow.overseer-act", { agentId: o.agentId, tool: "send_to_agent", args: { agentId: w.agentId, text: "One more: the totals row." } });
    await time("report handed to an agent (report-issue-send)", "follow.report-issue-send", { kind: "bug", text: "The export drops the totals row on the last page.", agentId: w.agentId });
    r.rows = rows; report.timing = [...(report.timing ?? []), ...rows];
    if (!baseline) for (const row of rows) check(`timing: ${row.action} replies within ${REPLY_BUDGET_MS} ms while Paseo is slow`, row.ok && row.ms < REPLY_BUDGET_MS, { ms: row.ms, error: row.error });
    await proxy.pass();
    if (!baseline) {
      await waitUntil("the batch, the retried and new forwards and the report arrive", async () => { const p = await allPrompts(w.agentId); return p.some(t => t.includes(batchPrefix(batchId))) && p.some(t => t.includes("archive table")) && p.some(t => t.includes("totals row.")) && p.some(t => t.includes("totals row on the last page")); }, { baseMs: 150_000, everyMs: 1000 });
      await sleep(5_000);
      const p = await allPrompts(w.agentId);
      const count = needle => p.filter(t => t.includes(needle)).length;
      r.copies = { batch: count(batchPrefix(batchId)), retried: count("archive table"), cancelled: count("old column names"), forward: count("totals row."), report: count("totals row on the last page") };
      check("timing b: each arrives once, the cancelled forward never", r.copies.batch === 1 && r.copies.retried === 1 && r.copies.cancelled === 0 && r.copies.forward === 1 && r.copies.report === 1, r.copies);
    }
  },

  async "forward-stuck"() {
    const r = report.cases["forward-stuck"] = { timeScale: STUCK_TIME_SCALE };
    const w = await workspace("Stuck forward");
    const o = await workspace("Overseer stand-in", { track: false });
    await seedOverseer(o.agentId, o.workspaceId);
    const title = `A message to ${"Stuck forward main"} didn't go out`;
    // Never left: Paseo unreachable past MESSAGE_STUCK_MS (scaled).
    await proxy.refuse();
    await forward(o.agentId, w.agentId, "Please rerun the export with the new filter.");
    const queued = await waitUntil("the stuck forward shows on the workspace", async () => (await undelivered(w.workspaceId)).find(m => m.agentId === w.agentId && m.state === "queued") ?? null, { baseMs: 120_000, everyMs: 1000 }).catch(() => null);
    r.neverLeft = queued;
    check("stuck (never left): the workspace shows the message that didn't go out", !!queued && queued.agentTitle === "Stuck forward main", { entry: queued, title });
    if (queued) {
      await rpc("follow.queue-action", { itemId: queued.id, action: "cancel" });
      const cleared = await waitUntil("cancel clears it", async () => !(await undelivered(w.workspaceId)).some(m => m.id === queued.id), { baseMs: 20_000 }).then(() => true, () => false);
      check("stuck (never left): Cancel clears it", cleared);
    }
    await proxy.pass();
    await sleep(3_000);
    check("stuck (never left): the cancelled forward never reached the agent", (await allPrompts(w.agentId)).every(t => !t.includes("new filter")));
    // Failed: the send is held past the (scaled) deadline, then every timeline read drops, so no arrival check can tell.
    await proxy.hold(/"send_agent_message_request"/, "up", "drop");
    await forward(o.agentId, w.agentId, "Please also check the totals.");
    await waitUntil("the forward is out and unanswered", async () => (await messageItems(w.agentId)).items.some(i => i.state === "sending"), { baseMs: 20_000 });
    await waitUntil("it reads uncertain past the deadline", async () => (await messageItems(w.agentId)).items.some(i => i.state === "uncertain"), { baseMs: 30_000 });
    await proxy.refuse();
    await proxy.kill(/"fetch_agent_timeline_request"/);
    const failedEntry = await waitUntil("the forward ends Failed on the workspace", async () => (await undelivered(w.workspaceId)).find(m => m.state === "failed") ?? null, { baseMs: 180_000, everyMs: 1000 }).catch(() => null);
    r.failed = failedEntry;
    check("stuck (failed): the workspace shows it as failed", !!failedEntry, { entry: failedEntry });
    if (failedEntry) {
      await rpc("follow.queue-action", { itemId: failedEntry.id, action: "cancel" });
      check("stuck (failed): Cancel clears it", await waitUntil("cancel clears it", async () => !(await undelivered(w.workspaceId)).some(m => m.id === failedEntry.id), { baseMs: 20_000 }).then(() => true, () => false));
    }
    await proxy.pass();
  },

  async "reply-timing"() {
    const r = report.cases["reply-timing"] = {};
    const { workspaceId, agentId } = await workspace("Timing export");
    const qid = await ask(agentId, "Export format while slow");
    // A distinct question (the dedupe would fold a near-copy into Q1).
    const q2 = (await rpc("follow.ask-question", { agentId, title: "Retention window for old builds", question: "How long should old build artifacts be kept?", options: [{ letter: "A", label: "Seven days" }, { letter: "B", label: "Thirty days" }], recommend: "B" })).question.id;
    assert.notEqual(q2, qid, "the second question is its own");
    const x = await workspace("Timing card", { track: false });
    const y = await workspace("Timing retry card", { track: false });
    const cx = await briefCard(x.agentId, "Pick the export format"); const cy = await briefCard(y.agentId, "Pick the export format");
    // A card whose send never left (Paseo unreachable): its Retry is what the slow window times.
    await proxy.refuse();
    const retryId = "harness-timing-retry-0001";
    await rpc("follow.brief-action", { agentId: y.agentId, ...cy, choice: "A", answerId: retryId });
    // And an answer that waits as Queued, so its Try now (resend) is what the slow window times.
    await rpc("follow.answer-question", { workspaceId, questionId: q2, choice: "B", action: "send" });
    if (baseline) await sleep(20_000);
    else {
      await waitUntil("the retry card waits as queued", async () => (await queueItem(i => i.kind === "brief" && i.ref.answerId === retryId))?.state === "queued", { baseMs: 30_000 });
      await waitUntil("the second answer waits as queued", async () => (await queueItem(isAnswer(workspaceId, q2)))?.state === "queued" && (await delivery(workspaceId, q2))?.state === "queued", { baseMs: 30_000 });
    }
    r.beforeSlow = { q2: await delivery(workspaceId, q2) };
    // A 60 s resume: every worker→daemon frame reaches the daemon a minute late.
    await proxy.delay(RESUME_MS);
    const rows = [];
    const time = async (action, method, input) => { const t = await timed(method, input); rows.push({ action, method, ms: t.ms, ok: t.ok, ...(t.ok ? {} : { error: t.error }) }); console.log(`  ${action}: ${t.ms} ms${t.ok ? "" : ` (${t.error})`}`); return t; };
    await time("answer-question send", "follow.answer-question", { workspaceId, questionId: qid, choice: "A", action: "send" });
    await time("answer-question resend (Try now on a queued answer)", "follow.answer-question", { workspaceId, questionId: q2, choice: "B", action: "resend" });
    await time("brief-action", "follow.brief-action", { agentId: x.agentId, ...cx, choice: "B", answerId: "harness-timing-card-0001" });
    await time("brief-action Retry on a queued card", "follow.brief-action", { agentId: y.agentId, ...cy, choice: "A", answerId: retryId });
    r.rows = rows; r.budgetMs = REPLY_BUDGET_MS; r.resumeMs = RESUME_MS;
    report.timing = [...(report.timing ?? []), ...rows];
    if (!baseline) for (const row of rows) check(`timing: ${row.action} replies within ${REPLY_BUDGET_MS} ms while Paseo is slow`, row.ok && row.ms < REPLY_BUDGET_MS, { ms: row.ms, error: row.error });
    await proxy.pass();
    if (!baseline) {
      // Once Paseo is back everything goes out, once.
      await waitUntil("the timed answers arrive", async () => (await receipts(agentId, answerPrefix(qid))).length && (await receipts(x.agentId, `Follow-up answer ${cx.decisionId} (`)).length && (await receipts(y.agentId, `Follow-up answer ${cy.decisionId} (`)).length, { baseMs: 150_000, everyMs: 1000 });
      await waitUntil("the tried-now answer arrives", async () => (await receipts(agentId, answerPrefix(q2))).length, { baseMs: 90_000, everyMs: 1000 });
      await exactlyOnce("timing: the answer arrives once after the slow window", agentId, answerPrefix(qid));
      await exactlyOnce("timing: the tried-now answer arrives once", agentId, answerPrefix(q2));
      await exactlyOnce("timing: the card arrives once", x.agentId, `Follow-up answer ${cx.decisionId} (`);
      await exactlyOnce("timing: the retried card arrives once", y.agentId, `Follow-up answer ${cy.decisionId} (`);
    }
  },
};

let cli;
try {
  await proxy.listen();
  await fs.writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, webUi: renders })));
  const pack = arg("--pack") ? resolve(arg("--pack")) : join(root, JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 120000 })).stdout)[0].filename);
  report.pack = { file: pack.split("/").pop(), version: null };
  await exec("tar", ["-xzf", pack, "--strip-components=1", "-C", plugin]);
  report.pack.version = JSON.parse(await fs.readFile(join(plugin, "package.json"), "utf8")).version;
  await fs.writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await fs.writeFile(join(fixture, "index.server.ts"), await fs.readFile("scripts/fixture-provider.ts", "utf8"));
  // A fake GitHub where every example/app PR is open and conflicting, so a registered PR makes a repair batch.
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(join(bin, "gh"), FAKE_GH); await fs.chmod(join(bin, "gh"), 0o700);
  github = await fakeGithub({ dir: root, gh: join(bin, "gh") });
  // The daemon (and so the plugin worker it starts) reaches Paseo through the proxy; the CLI and this script don't.
  const daemonEnv = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: `ws://127.0.0.1:${proxyPort}/ws`, PASEO_RELAY_ENABLED: "false", ...(renders ? { PASEO_WEB_UI_ENABLED: "true", FOLLOW_UP_QUEUE_TIME_SCALE: String(RENDER_TIME_SCALE) } : {}), ...(scaled ? { FOLLOW_UP_QUEUE_TIME_SCALE: String(STUCK_TIME_SCALE) } : {}), PATH: `${bin}:${process.env.PATH}`, ...github.env }, strip: github.strip });
  const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" } });
  cli = async (...args) => { try { return JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 180000, maxBuffer: 1 << 20 })).stdout || "null"); } catch (e) { throw new Error(`paseo ${args.join(" ")} failed: ${String(e.stdout ?? "").slice(-1500)} ${String(e.stderr ?? "").slice(-1500)} ${e.killed ? "(timed out)" : ""}`); } };
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env: daemonEnv, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  await waitUntil("the isolated daemon starts", async () => { assert.equal(daemon.exitCode, null, "isolated daemon exited"); return cli("workspace", "ls").then(() => true, () => false); }, { baseMs: 30_000 });
  report.paseo = (await exec("paseo", ["--version"], { env })).stdout.trim();
  await cli("plugin", "install", fixture); await cli("plugin", "install", plugin);
  client = new DaemonClient({ url, clientId: "follow-message-queue", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  api = createPaseoApi(client);
  await waitUntil("Follow-up answers RPCs", () => rpc("follow.refresh", {}).then(() => true, () => false), { baseMs: 60_000, everyMs: 500 });
  // The trick only proves anything if the worker's own connection really goes through the proxy.
  await waitUntil("the worker connects through the proxy", () => proxy.accepted > 0, { baseMs: 30_000 }).catch(() => null);
  check("the worker's daemon connection goes through the proxy", proxy.accepted > 0, { connections: proxy.accepted });
  for (const name of wanted) {
    console.log(`== ${name}`);
    await proxy.pass();
    try { await cases[name](); }
    catch (error) { check(`${name}: ran to the end`, false, { error: error instanceof Error ? error.message : String(error) }); }
  }
  const log = await fs.readFile(join(root, "daemon.log"), "utf8").catch(() => "");
  const crashes = daemonCrashes(log);
  check("no worker crash in the daemon log", !crashes.length, crashes.length ? { crashes: crashes.slice(0, 3) } : {});
} catch (error) {
  check("run", false, { error: error instanceof Error ? error.stack ?? error.message : String(error) });
} finally {
  await client?.close().catch(() => {});
  await github?.close().catch(() => {});
  await proxy.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await sleep(1500); if (daemon.exitCode === null) daemon.kill("SIGKILL"); }
  await browser?.close().catch(() => {});
  const mainFile = join(out, "message-queue-main.json");
  if (!baseline && existsSync(mainFile)) { try { const main = JSON.parse(readFileSync(mainFile, "utf8")); report.mainTiming = { pack: main.pack, rows: main.timing }; } catch { /* a broken baseline file is left out */ } }
  if (report.timing) report.timingTable = (report.timing ?? []).map(row => ({ action: row.action, queueMs: baseline ? null : row.ms, queueOk: baseline ? null : row.ok, mainMs: baseline ? row.ms : report.mainTiming?.rows?.find(m => m.action === row.action)?.ms ?? null, mainError: baseline ? row.error ?? null : report.mainTiming?.rows?.find(m => m.action === row.action)?.error ?? null }));
  failed = report.checks.some(c => !c.ok);
  report.result = baseline ? "recorded" : failed ? "fail" : "pass";
  const file = renders ? (rendersOnly ? `message-queue-renders-${rendersOnly}.json` : "message-queue-renders.json") : scaled ? "message-queue-stuck.json" : baseline ? "message-queue-main.json" : "message-queue.json";
  await fs.writeFile(join(out, file), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.result.toUpperCase()}: ${report.checks.filter(c => c.ok).length}/${report.checks.length} checks; wrote ${join(out, file)}`);
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(failed && !baseline ? 1 : 0);
