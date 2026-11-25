import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import type { State } from "../shared/model";
import { clock } from "./fixtures";

/**
 * Invariant 118, `an-agent-s-first-session-gets-its-tools`: Paseo opens a new agent's first session (the session_open
 * hook) while it is still creating the agent, before the agent is in its own list. Discovery at session open couldn't
 * find the agent however long it re-listed (tracking-waits-for-a-new-agent's retries only delayed creation), so a
 * brand-new main agent in a default-tracked workspace got the CLI bridge and no follow_* tools until its next session.
 * Discovery at session open now counts the opening agent itself, from the session_open request.
 * The real host's side: scripts/check-install.mjs asserts the first session's MCP servers.
 */
const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, workspaceId: string, labels: Record<string, string> = {}): Agent => ({ id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: iso(clock), status: "idle", activeTurn: null, labels, lastUserMessageAt: iso(clock), pendingPermissions: [] } as unknown as Agent);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-first-session-")); t.after(() => rm(dir, { recursive: true, force: true }));
  // Paseo lists the workspace (created first) but not the agent whose session is opening.
  const agents: Agent[] = [agent("a-parent", "w-other")];
  const workspaces = [{ id: "w-other", name: "Other", projectId: "project" }, { id: "w-new", name: "New task", projectId: "project" }];
  const counts = { fetch_agents: 0 };
  const client = {
    fetchAgents: async () => { counts.fetch_agents++; return { entries: agents.map(a => ({ agent: structuredClone(a) })), pageInfo: { hasMore: false, nextCursor: null } }; },
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }),
    fetchAgent: async (id: string) => { const a = agents.find(a => a.id === id); return a ? { agent: structuredClone(a) } : null; },
    fetchAgentTimeline: async () => ({ entries: [], startCursor: null, endCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false }),
    listProviderSubagents: async () => ({ subagents: [] }),
  } as unknown as Daemon;
  const connect = (async work => work(client)) as typeof withDaemon;
  const gateway = new PaseoGateway(connect, new SessionGuard(dir), async () => false, HistoryCache.at(dir), () => clock);
  const state = { version: 1, workspaces: [], projectDefaults: { project: true } } as unknown as State;
  return { gateway, state, counts };
}

test("an-agent-s-first-session-gets-its-tools: discovery at session open counts the opening agent Paseo doesn't list yet", async t => {
  const f = await fixture(t);
  const started = Date.now();
  const rows = await f.gateway.discover(f.state, "w-new", undefined, { id: "a-new", workspaceId: "w-new", provider: "claude", cwd: "/fixture", title: "New task", labels: {} });
  assert.deepEqual(rows.map(r => [r.id, r.mainAgentId]), [["w-new", "a-new"]], "the opening agent is the new workspace's main agent");
  // No re-listing waits for an agent that can't be listed before its session_open returns.
  assert.ok(Date.now() - started < 200, `session open waited ${Date.now() - started} ms`);
  assert.ok(f.counts.fetch_agents <= 2, `agent listings: ${f.counts.fetch_agents}`);
});

test("an-agent-s-first-session-gets-its-tools: a cross-workspace launch is a root; a same-workspace child is not", async t => {
  const f = await fixture(t);
  const launched = await f.gateway.discover(f.state, "w-new", undefined, { id: "a-new", workspaceId: "w-new", provider: "claude", cwd: "/fixture", labels: { "paseo.parent-agent-id": "a-parent" } });
  assert.deepEqual(launched.map(r => r.mainAgentId), ["a-new"]);
  const f2 = await fixture(t);
  const child = await f2.gateway.discover(f2.state, "w-other", undefined, { id: "a-child", workspaceId: "w-other", provider: "claude", cwd: "/fixture", labels: { "paseo.parent-agent-id": "a-parent" } });
  assert.deepEqual(child.map(r => r.mainAgentId), ["a-parent"], "a same-workspace child never becomes the main agent");
});

test("an-agent-s-first-session-gets-its-tools: session open never hands a first session the bridge alone", async () => {
  const source = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  const start = source.indexOf('server.before("agent.session_open"');
  const open = source.slice(start, source.indexOf('server.on("agent.turn_ended"', start));
  assert.match(open, /gateway\.discover\(saved, request\.workspaceId, undefined, opening\)/, "session open passes the opening agent to discovery");
  // Every return that hands out the bridge also attaches the tools.
  for (const line of open.split("\n").filter(l => /return\b/.test(l) && l.includes("FOLLOW_UP_CLI")))
    assert.match(line, /withTools\(/, `bridge without tools: ${line.trim()}`);
});
