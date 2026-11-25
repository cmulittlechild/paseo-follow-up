import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeServer, hangingHost, type Registered } from "./support/hanging-host";
import { seed } from "./support/seed";
import { FIXTURE } from "./support/sample-input";
import { OVERSEER_LABEL } from "../shared/overseer";

/**
 * Invariant (an-agent-on-any-provider-gets-follow-up): a developer whose agents all run on a provider other than
 * Claude Code and Codex (OpenCode here; Paseo 0.17 also runs Pi, Copilot, Cursor, Kimi, Kiro and any ACP agent) gets
 * Follow-up's core: its main agents get the tools and needs_you, the Overseer gets its routing tools, and every
 * helper left on its default runs on a provider the developer has. The real worker (contribute() from
 * index.server.ts) runs in a temp PASEO_HOME where Paseo lists only OpenCode and the claude and codex commands are
 * missing: nothing may try either.
 *
 * Before: tools, needs_you and the Overseer's tools attached only to Claude and Codex sessions, and every helper
 * defaulted to Claude whether or not it was installed.
 */

type Before = (input: { request: Record<string, unknown> }, context: { paseo: unknown }) => Promise<Record<string, unknown> | void>;

test("an-agent-on-any-provider-gets-follow-up: the worker with only OpenCode: tools, needs_you, the Overseer and the helpers all work", { timeout: 120_000 }, async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  // No Claude and no Codex: each command exists only to record that something tried it, and fails like a missing one.
  const tried = join(host.root, "tried");
  for (const tool of ["claude", "codex"]) {
    const bin = join(host.root, "bin", tool);
    await writeFile(bin, `#!/bin/sh\necho ${tool} >> '${tried}'\nexit 127\n`); await chmod(bin, 0o755);
  }
  await seed(host.directory);

  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const befores = new Map<string, Before>();
  (server as { before: unknown }).before = (name: string, handler: Before) => { befores.set(name, handler); return () => undefined; };
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());

  const agent = (id: string, labels: Record<string, string> = {}) => ({ id, workspaceId: FIXTURE.workspaceId, labels, parentAgentId: null, provider: "opencode" });
  const paseo = {
    agents: { ref: (id: string) => ({ refresh: async () => ({ agent: agent(id) }) }) },
    providers: {
      snapshot: async () => ({ entries: [{ provider: "opencode", status: "ready", label: "OpenCode", models: [
        { id: "small-fast", label: "Small Fast", description: "Fast and cheap for quick tasks", isDefault: false },
        { id: "coder", label: "Coder", isDefault: true },
        { id: "frontier", label: "Frontier", description: "Most capable model for complex reasoning", isDefault: false },
      ] }] }),
      waitForReady: async () => ({ entries: [] }),
    },
  };
  const run = (name: string, input: unknown) => { const h = handlers.get(name) as Registered; return h.input.parseAsync(input).then(i => h.run(i, { paseo })); };

  // Helpers: none was picked, Claude isn't here, so each runs on OpenCode, sized to the job.
  const view = await run("follow.agent-settings", { catalog: true }) as { roles: { role: string; provider: string; model: string | null; same: boolean }[] };
  const roles = Object.fromEntries(view.roles.map(r => [r.role, r]));
  assert.deepEqual([roles.about!.provider, roles.ranker!.provider, roles.overseer!.provider], ["opencode", "opencode", "opencode"], "no helper defaults to a provider the developer lacks");
  assert.equal(roles.about!.model, "small-fast"); assert.equal(roles.overseer!.model, "frontier");
  assert.equal(roles.recovery!.same, true, "recovery still copies the main agent, whatever it runs on");

  // The tracked main agent on OpenCode: the tools, and needs_you while the inbox is on.
  const open = befores.get("agent.session_open")!;
  assert.ok(open, "the worker hooks session open");
  const request = (agentId: string, labels: Record<string, string> = {}) => ({ agentId, provider: "opencode", cwd: "/fixture", workspaceId: FIXTURE.workspaceId, reason: "create", purpose: "interactive", env: {}, title: null, labels, tools: [], mcpServers: {} });
  const main = await open({ request: request(FIXTURE.agentId) }, { paseo }) as { tools: { name: string }[]; env: Record<string, string> };
  const names = main.tools.map(tool => tool.name);
  for (const tool of ["follow_workspace_status", "follow_sync_workspace", "follow_ask_question", "follow_needs_you", "follow_update_obligation"])
    assert.ok(names.includes(tool), `the main agent on OpenCode gets ${tool}`);
  assert.equal(main.env.FOLLOW_UP_BRIEF, "opencode");
  assert.equal(main.env.FOLLOW_UP_TOOLS, "native");

  // The Overseer on OpenCode gets its routing tools.
  const overseer = await open({ request: request("overseer-agent", { [OVERSEER_LABEL]: "1" }) }, { paseo }) as { tools: { name: string }[] };
  assert.ok(overseer.tools.some(tool => tool.name === "follow_send_to_agent"), "the Overseer on OpenCode routes");

  assert.equal(await readFile(tried, "utf8").catch(() => ""), "", "nothing tried Claude or Codex");
  await rm(tried, { force: true });
});

test("noHooksLine names what other providers miss, and nothing when every provider has hooks", async () => {
  const { noHooksLine } = await import("../shared/provider-support");
  const p = (id: string, label: string, available = true) => ({ id, label, available });
  assert.equal(noHooksLine([p("claude", "Claude"), p("codex", "Codex")]), null);
  assert.equal(noHooksLine([p("claude", "Claude"), p("opencode", "OpenCode", false)]), null, "an unavailable provider isn't the developer's");
  const both = noHooksLine([p("opencode", "OpenCode"), p("pi", "Pi")])!;
  assert.match(both, /^Your agents on OpenCode and Pi get Follow-up's tools, and Follow-up still tracks their PRs and sends them repairs\. Turn-end reminders .* need Claude Code or Codex, whose hooks run them\.$/);
  assert.doesNotMatch(both, /instructions/, "OpenCode and Pi do get the instructions: nothing says otherwise");
  assert.match(noHooksLine([p("copilot", "Copilot")])!, / On Copilot they don't get Follow-up's instructions: Paseo doesn't pass a plugin's instructions to ACP agents yet\./);
  // A generic ACP agent carries the developer's own id: the worker marks it from Paseo's config (acp), never by id.
  assert.match(noHooksLine([{ ...p("acme-acp", "Acme ACP"), acp: true }])!, / On Acme ACP they don't get Follow-up's instructions: /);
});

test("isAcp follows Paseo's config: a provider that extends acp, directly or through another, is ACP", async () => {
  const { isAcp } = await import("../shared/provider-support");
  const config = { agents: { providers: { "acme-acp": { extends: "acp" }, "acme-2": { extends: "acme-acp" }, "acme-oc": { extends: "opencode" }, loop: { extends: "loop" } } } };
  assert.equal(isAcp("kiro"), true);
  assert.equal(isAcp("acme-acp"), false, "without the config an unknown id isn't assumed ACP");
  assert.equal(isAcp("acme-acp", config), true);
  assert.equal(isAcp("acme-2", config), true);
  assert.equal(isAcp("acme-oc", config), false);
  assert.equal(isAcp("loop", config), false, "a cycle ends");
});

test("runnableRole: only a role left on an unavailable default moves, and only to what Paseo has", async () => {
  const { runnableRole } = await import("../shared/job-rows");
  const { resolveRole } = await import("../shared/agent-settings");
  const cat = (providers: { id: string; available: boolean; reason?: string | null; models?: { id: string; label: string; isDefault: boolean; thinking: [] }[] }[], error: string | null = null) =>
    ({ providers: providers.map(p => ({ label: p.id, reason: p.available ? null : "Not installed", models: [], modes: [], defaultMode: null, ...p })), error, fetchedAt: null });
  const about = resolveRole(null, "about");
  const opencode = { id: "opencode", available: true, models: [{ id: "mini-fast", label: "Mini", isDefault: false, thinking: [] as [] }] };
  assert.equal(runnableRole(about, undefined, cat([{ id: "claude", available: true }, opencode])), about, "Claude here: the default stands");
  assert.deepEqual([runnableRole(about, undefined, cat([opencode])).provider, runnableRole(about, undefined, cat([opencode])).model], ["opencode", "mini-fast"]);
  assert.equal(runnableRole(about, undefined, null), about, "no catalog: unknown is not off");
  assert.equal(runnableRole(about, undefined, cat([], "offline")), about, "a failed read keeps the default");
  assert.equal(runnableRole(about, undefined, cat([opencode, { id: "claude", available: false, reason: "Still loading" }])), about, "still loading keeps the default");
  const picked = resolveRole({ version: 1, roles: { about: { provider: "claude" } } }, "about");
  assert.equal(runnableRole(picked, { provider: "claude" }, cat([opencode])), picked, "a picked provider is never moved");
  const recovery = resolveRole(null, "recovery");
  assert.equal(runnableRole(recovery, undefined, cat([opencode])), recovery, "recovery copies the main agent");
});
