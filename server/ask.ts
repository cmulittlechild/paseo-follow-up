import { createHash } from "node:crypto";
import {
  ASK, ASK_ITEMS_SYSTEM, ASK_PLAN_SYSTEM, askItemsPrompt, askItemsReplySchema, askPlanPrompt, askPlanReplySchema, validateCall, validateItems, validatePlan,
  type AskCall, type AskItem,
} from "../shared/ask";
import type { ReadTool } from "../shared/brief-sources";
import type { AiJobs } from "./ai-jobs";
import type { SourceDirectory } from "./source-tools";

/** Changes when the server's read tools change, so a cached plan is dropped then. */
export const toolsHash = (tools: readonly ReadTool[]) =>
  createHash("sha256").update(JSON.stringify(tools.map(t => [t.name, t.props, t.required, t.params ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex").slice(0, 16);

export type AskPlan = { at: string; hash: string; calls: AskCall[] };
export type AskResult = { at: string; items: AskItem[]; calls: AskCall[]; error: string | null; plan: AskPlan | null };
export type AskDeps = {
  tools: SourceDirectory;
  jobs: AiJobs;
  /** The model Ask runs on: the Summary's role (Settings → Agents), a fast one by default. */
  role: () => Promise<{ provider: string; model: string | null; thinking: string | null }>;
};

const oneLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].replace(/\s+/g, " ").slice(0, 200);

/**
 * One Ask of one server (docs/morning-brief.md#ask): reuse its plan while it's under a week old and the tools are the
 * same, else ask the model for one; check every call (validateCall) and run the valid ones through `tool-read`
 * (SourceDirectory.callTool, ASK.callTimeoutMs each); then one short call turns the replies into items, checked too.
 * Never throws: a failure is the result's one-line `error`.
 */
export async function askSource(d: AskDeps, server: string, opts: { since: number; now: number; timeZone: string; plan: AskPlan | null }): Promise<AskResult> {
  const at = new Date(opts.now).toISOString();
  const fail = (error: string, plan: AskPlan | null = null, calls: AskCall[] = []): AskResult => ({ at, items: [], calls, error, plan });
  try {
    const tools = await d.tools.serverTools(server);
    if (!tools.length) return fail("mcpproxy lists no read-only tools for it now.");
    const hash = toolsHash(tools);
    const role = await d.role();
    const job = { provider: role.provider, model: role.model ?? undefined, thinking: role.thinking } as const;
    const since = new Date(opts.since).toISOString();
    let plan = opts.plan && opts.plan.hash === hash && opts.now - Date.parse(opts.plan.at) < ASK.planMs ? opts.plan : null;
    if (!plan) {
      const r = await d.jobs.run({ name: "ask-plan", prompt: askPlanPrompt(server, tools, since, at, opts.timeZone), system: ASK_PLAN_SYSTEM, schema: askPlanReplySchema, ...job, maxPromptChars: 24_000, maxOutputChars: 4_000, timeoutMs: 90_000 });
      if (!r.ok) return fail(`The model couldn't plan the reads (${r.reason}).`);
      const v = validatePlan(tools, r.value);
      if (!v.calls.length && v.refused.length) return fail(`The model's reads were refused: ${v.refused[0]}.`);
      plan = { at, hash, calls: v.calls };
    }
    // A cached plan is checked again against the tools as they are now.
    const calls = plan.calls.flatMap(c => { const v = validateCall(tools, c); return v.ok ? [v.call] : []; });
    if (!calls.length) return { at, items: [], calls: [], error: null, plan };
    const results = await Promise.all(calls.map(async call => {
      try { return { call, reply: await d.tools.callTool(server, call.tool, call.args, { reason: "morning brief ask", timeoutMs: ASK.callTimeoutMs }), error: null }; }
      catch (e) { return { call, reply: "", error: oneLine(e) }; }
    }));
    const ok = results.filter(r => !r.error);
    if (!ok.length) return fail(`mcpproxy couldn't run its reads: ${results[0].error}`, plan, calls);
    const r = await d.jobs.run({ name: "ask-items", prompt: askItemsPrompt(server, ok, since, at), system: ASK_ITEMS_SYSTEM, schema: askItemsReplySchema, ...job, maxPromptChars: 24_000, maxOutputChars: 6_000, timeoutMs: 90_000 });
    if (!r.ok) return fail(`The model couldn't read the replies (${r.reason}).`, plan, calls);
    return { at, items: validateItems(r.value, ok.map(x => x.reply)), calls, error: null, plan };
  } catch (e) { return fail(oneLine(e)); }
}
