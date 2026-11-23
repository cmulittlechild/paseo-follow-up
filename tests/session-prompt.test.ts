import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as bridge from "../server/mcp.mjs";
import { SYSTEM_PROMPT_ENV, atLeast, promptParts, withSystemPrompt, type PromptDeps } from "../server/session-prompt";

// Paseo 0.17: the static session text moves from the SessionStart hook to appendSystemPrompt (server/session-prompt.ts).
// Who gets which text must not change (invariant 9 included): for every role, the text the hook adds on an older host
// is exactly what the system prompt plus the hook add on 0.17, each part once.

const ROLES: Record<string, { env: Record<string, string>; scope?: object; background?: boolean }> = {
  "tracked main, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_WAIT: "1" }, scope: { role: "main", workspaceId: "w1" } },
  "tracked main, stdio": { env: { FOLLOW_UP_TOOLS: "stdio", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_BACKGROUND_WORK: "1" }, scope: { role: "main", workspaceId: "w1" } },
  "contributor, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_WAIT: "1" }, scope: { role: "contributor", workspaceId: "w1" } },
  "untracked root, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_BACKGROUND_WORK: "1" } },
  "Overseer, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_OVERSEER: "1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_WAIT: "1" } },
  "subagent or untracked, Wait only": { env: { FOLLOW_UP_WAIT: "1" } },
  "recovery": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_RECOVERY: "1", FOLLOW_UP_WAIT: "1" }, scope: { role: "recovery", workspaceId: "w1" } },
  "background helper": { env: {}, background: true },
};

async function home(t: { after: (f: () => Promise<void>) => void }, role: (typeof ROLES)[string]) {
  const root = await mkdtemp(join(tmpdir(), "session-prompt-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "scopes.json"), JSON.stringify({ agents: role.scope ? { a1: role.scope } : {} }));
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  await writeFile(join(directory, "background-agents.json"), JSON.stringify({ agents: role.background ? ["a1"] : [] }));
  let session = 0;
  return (env: Record<string, string>) => new Promise<string>((ok, bad) => {
    const blank = Object.fromEntries(["HOOK_IMPORT", "RECOVERY", "TOOLS", "PROVIDER", "ROOT", "BRIEF", "OVERSEER", "WAIT", "BACKGROUND_WORK", "SYSTEM_PROMPT"].map(k => [`FOLLOW_UP_${k}`, ""]));
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, ...blank, PASEO_AGENT_ID: "a1", FOLLOW_UP_PROVIDER: "claude", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad);
    child.once("exit", () => ok(out.trim() ? JSON.parse(out.trim()).hookSpecificOutput.additionalContext as string : ""));
    child.stdin.end(JSON.stringify({ session_id: `s${++session}`, hook_event_name: "SessionStart" }));
  });
}
const paragraphs = (text: string) => text.split("\n\n").map(p => p.trim()).filter(Boolean);
const deps = (host: boolean, codex = true): PromptDeps => ({ hostSupports: async () => host, providerSupports: async p => p === "claude" || codex, bridge: async () => bridge });
const open = (env: Record<string, string>, provider = "claude") => ({ agentId: "a1", provider, purpose: "interactive", env: { ...env } });

for (const [name, role] of Object.entries(ROLES)) {
  test(`${name}: the same text on both paths, each part once`, async t => {
    const fire = await home(t, role);
    const before = paragraphs(await fire(role.env));
    // Paseo 0.17: what the worker hands the provider, then what the hook still adds.
    const opened = await withSystemPrompt(open(role.env), deps(true), { background: role.background });
    const prompt = paragraphs((opened.appendSystemPrompt ?? []).join("\n\n"));
    const after = paragraphs(await fire(opened.env));
    assert.deepEqual([...prompt, ...after].sort(), [...before].sort(), "the system prompt plus the hook add what the hook alone did");
    for (const p of prompt) assert.equal(after.includes(p), false, `said twice: ${p.slice(0, 60)}`);
    // An older host or a provider that can't take it: nothing moves.
    const old = await withSystemPrompt(open(role.env), deps(false), { background: role.background });
    assert.equal(old.appendSystemPrompt, undefined); assert.equal(old.env[SYSTEM_PROMPT_ENV], undefined);
    const codexOld = await withSystemPrompt(open(role.env, "codex"), deps(true, false), { background: role.background });
    assert.equal(codexOld.appendSystemPrompt, undefined, "Codex before 0.121 keeps the hook path");
  });
}

test("who gets which text: the Overseer's role only to the Overseer, nothing to recovery or a background helper", async () => {
  const has = async (role: string, text: string) => ((await withSystemPrompt(open(ROLES[role]!.env), deps(true), { background: ROLES[role]!.background })).appendSystemPrompt ?? []).join("\n").includes(text);
  const overseerText = bridge.overseerInstruction.slice(0, 40);
  assert.equal(await has("Overseer, native", overseerText), true);
  for (const role of Object.keys(ROLES).filter(r => !r.startsWith("Overseer"))) assert.equal(await has(role, overseerText), false, role);
  assert.equal(await has("tracked main, native", "follow_needs_you"), true, "a native main agent's needs_you text, with native names");
  assert.deepEqual(promptParts(ROLES["recovery"]!.env), []);
  assert.equal((await withSystemPrompt(open(ROLES["tracked main, native"]!.env), deps(true), { background: true })).appendSystemPrompt, undefined, "invariant 9");
  assert.equal((await withSystemPrompt({ ...open(ROLES["tracked main, native"]!.env), purpose: "history" }, deps(true))).appendSystemPrompt, undefined, "history opens get nothing");
  assert.equal((await withSystemPrompt(open(ROLES["tracked main, native"]!.env, "opencode"), deps(true))).appendSystemPrompt, undefined, "other providers keep the hook");
  assert.equal(atLeast([0, 121, 0], [0, 121, 0]), true); assert.equal(atLeast([0, 120, 9], [0, 121, 0]), false); assert.equal(atLeast(null, [0, 121, 0]), false);
});

test("another plugin's appendSystemPrompt is kept", async () => {
  const opened = await withSystemPrompt({ ...open(ROLES["tracked main, native"]!.env), appendSystemPrompt: ["other plugin"] }, deps(true));
  assert.equal(opened.appendSystemPrompt![0], "other plugin"); assert.equal(opened.appendSystemPrompt!.length, 2);
});
