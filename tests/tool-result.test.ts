import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { toolResult } from "../shared/tool-result";
import { createdCard } from "../shared/created";
import { createMomentLedger, followTimelineItem } from "../shared/chat";
import { artifactPublishUrl, receiptTitles } from "../server/local-titles";
import { titleKey } from "../shared/local-titles";
import { SHAPES, agentCreated, claudeShape, codexShape, toolName, workspaceCreated } from "./fixtures/paseo-tool-results";

/**
 * A created card parses every result shape Paseo sends (`created-card-parses-every-result-shape`), and so does every
 * other reader of a tool result (`every-tool-result-reads-through-one-normalizer`). 2026-11-19: the created card,
 * the Done card and question rows on Claude, and artifact receipts all read an idealised shape Paseo never sends.
 */

const PROVIDERS = Object.keys(SHAPES) as (keyof typeof SHAPES)[];
const shape = (provider: keyof typeof SHAPES, value: Record<string, unknown>) => SHAPES[provider](value);
const call = (name: string, input: Record<string, unknown>, output: unknown, status: "completed" | "running" | "failed" = "completed", error: unknown = null) =>
  ({ type: "tool_call" as const, callId: "c1", name, status, error, detail: { type: "unknown", input, output } });

test("toolResult reads the same object out of every shape Paseo sends", () => {
  for (const provider of PROVIDERS) {
    const r = toolResult(shape(provider, agentCreated));
    assert.deepEqual(r.object, agentCreated, provider);
    assert.equal(r.isError, false, provider);
    assert.ok(r.text.includes("agent-acme-new"), provider);
  }
  // Claude when the text didn't parse: Paseo keeps the prefixed model text as the string.
  const prefixed = codexShape(agentCreated).content[0].text;
  assert.ok(prefixed.startsWith("availableModes_count=3\navailableModes_ids=plan,default,bypassPermissions\n\n{"));
  assert.deepEqual(toolResult(claudeShape(prefixed)).object, agentCreated);
  assert.deepEqual(toolResult({ content: [{ type: "text", text: prefixed }] }).object, agentCreated);
  // Text stays text; an MCP error result is an error at any depth.
  assert.equal(toolResult(claudeShape("Published page at https://claude.ai/artifact/abc", [{ path: "x" }])).text, "Published page at https://claude.ai/artifact/abc");
  assert.equal(toolResult(claudeShape("plain words")).object, null);
  assert.equal(toolResult({ isError: true, content: [{ type: "text", text: "Workspace not found" }] }).isError, true);
  assert.equal(toolResult(undefined).text, "");
});

test("a completed create_agent is a created card in every shape Paseo sends", () => {
  for (const provider of PROVIDERS) {
    const card = createdCard(call(toolName(provider, "create_agent"), { title: "Acme fix", provider: "claude/claude-opus-5-5" }, shape(provider, agentCreated)));
    assert.equal(card?.phase, "created", provider);
    assert.equal(card?.id, "agent-acme-new", provider);
    assert.equal(card?.workspaceId, "wks_acme_app", provider);
  }
});

test("a completed create_workspace is a created card in every shape Paseo sends", () => {
  for (const provider of PROVIDERS) {
    const card = createdCard(call(toolName(provider, "create_workspace"), { isolation: "worktree", path: "/home/user/acme/billing" }, shape(provider, workspaceCreated)));
    assert.equal(card?.phase, "created", provider);
    assert.equal(card?.id, "wks_acme_billing", provider);
    assert.equal(card?.title, "billing-retry", provider);
  }
});

test("an MCP error result in Codex's envelope is a failed card with its words", () => {
  const card = createdCard(call("paseo.create_agent", { title: "x" }, { content: [{ type: "text", text: "Provider not available" }], isError: true }));
  assert.equal(card?.phase, "failed"); assert.equal(card?.error, "Provider not available");
  const failed = createdCard(call("mcp__paseo__create_agent", { title: "x" }, null, "failed", { type: "tool_result", content: "MCP error -32602: provider must be provider/model", is_error: true }));
  assert.equal(failed?.error, "MCP error -32602: provider must be provider/model");
});

test("the Done card and a question's row read Follow-up's reply in every shape Paseo sends", () => {
  const done = { workspaceId: "wks_acme_app", completion: { summary: "Billing retries shipped" }, blockers: [] };
  const asked = { workspaceId: "wks_acme_app", question: { id: "Q7", title: "Ship the retry change?" }, instruction: "End your turn." };
  for (const provider of PROVIDERS) {
    const row = followTimelineItem(call(toolName(provider, "follow_declare_done"), { summary: "Shipped" }, shape(provider, done)), createMomentLedger());
    assert.deepEqual(row?.done, { summary: "Billing retries shipped" }, provider);
    const q = followTimelineItem(call(toolName(provider, "follow_ask_question"), { title: "Ship the retry change?" }, shape(provider, asked)), createMomentLedger());
    assert.equal(q?.line, "Q7 · Ship the retry change? · asked", provider);
  }
});

test("an Artifact publish receipt names its artifact in Claude's shape", async () => {
  const url = "https://claude.ai/code/artifact/0b8a1c2d-acme";
  const output = claudeShape(`Published /home/user/acme/report.html at ${url} (private)`, [{ path: "report.html" }]);
  assert.equal(artifactPublishUrl(output), url);
  const titles = await receiptTitles([{ item: call("Artifact", { file_path: "/home/user/acme/report.html", title: "Acme report" }, output) }], async () => null);
  assert.equal(titles.get(titleKey(url))?.title, "Acme report");
});

test("no source reads a tool result except through toolResult", async () => {
  const offenders: string[] = [];
  for (const dir of ["client", "shared", "server"]) {
    for (const file of await readdir(dir, { recursive: true })) {
      if (!/\.(ts|tsx|mjs)$/.test(file) || /-source\.ts$/.test(file) || file === "tool-result.ts") continue;
      const lines = (await readFile(join(dir, file), "utf8")).split("\n");
      lines.forEach((line, i) => {
        // Reading into detail.output (a field, isError, content) instead of handing it to the normaliser.
        if (/detail\??\.output\??(?:\.|\[)|(?<!toolResult)\(detail\??\.output\)\.|(?:object|record)\(detail\??\.output\)/.test(line)) offenders.push(`${dir}/${file}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], "read tool results with toolResult (shared/tool-result.ts)");
});
