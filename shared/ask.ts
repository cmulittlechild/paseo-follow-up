import { z } from "zod";
import type { ReadTool } from "./brief-sources";

/**
 * Ask for unknown sources (docs/morning-brief.md#ask): a server mcpproxy has that no recipe fits can still feed the
 * brief, off until the developer turns it on per source, and only after a preview. A fast model (the Summary's role in
 * Settings → Agents: simple AI jobs run on fast models) sees the server's read-only tools and proposes at most
 * `ASK.calls` reads; each is validated against the read list and the tool's schema before Follow-up runs it through
 * `tool-read`; a second short call turns the replies into at most `ASK.items` items, validated too. The model never
 * runs anything itself, and an item's link is kept only when a reply carries it (ask-is-validated).
 */
export const ASK = {
  /** Reads a plan may make. */
  calls: 3,
  /** Items a morning keeps. */
  items: 5,
  /** A plan is reused this long (while the server's tools are the same), so most mornings are reads plus one call. */
  planMs: 7 * 86_400_000,
  /** Turning Ask on needs a preview (or a morning's ask) this recent. */
  previewMs: 24 * 3_600_000,
  callTimeoutMs: 20_000,
  /** One reply's share of the items prompt. */
  replyChars: 6_000,
  /** A tool's description and a parameter's, as the planner sees them. */
  toolChars: 300,
  paramChars: 100,
  /** Tools a planner sees (a server with more shows its first ones). */
  tools: 40,
  /** A string argument's length. */
  argChars: 500,
} as const;

export type AskCall = { tool: string; args: Record<string, unknown> };
export type AskItem = { title: string; why: string; url: string | null; due: string | null };

/** The planner's reply: the reads it proposes. More than ASK.calls are dropped after validation. */
export const askPlanReplySchema = z.object({
  calls: z.array(z.object({ tool: z.string().min(1).max(160), args: z.record(z.string(), z.unknown()).default({}) })).max(10),
});
/** The summary's reply: items, at most ASK.items kept. */
export const askItemsReplySchema = z.object({
  items: z.array(z.object({
    title: z.string().min(1).max(200),
    why: z.string().max(300).default(""),
    url: z.string().max(600).nullable().optional(),
    due: z.string().max(60).nullable().optional(),
  })).max(20),
});

export const askItemSchema = z.object({ title: z.string(), why: z.string(), url: z.string().nullable(), due: z.string().nullable() });
export const askCallSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });

const TYPE_OK: Record<string, (v: unknown) => boolean> = {
  string: v => typeof v === "string",
  number: v => typeof v === "number" && Number.isFinite(v),
  integer: v => typeof v === "number" && Number.isInteger(v),
  boolean: v => typeof v === "boolean",
  array: v => Array.isArray(v),
  object: v => !!v && typeof v === "object" && !Array.isArray(v),
};

/**
 * A proposed read, checked: the tool is one of this server's read tools, every argument is one its schema takes (of
 * its type, strings capped), and every required one is there. Refused otherwise, with why.
 */
export function validateCall(tools: readonly ReadTool[], call: { tool: string; args: Record<string, unknown> }): { ok: true; call: AskCall } | { ok: false; error: string } {
  const name = call.tool.includes(":") ? call.tool.slice(call.tool.indexOf(":") + 1) : call.tool;
  const tool = tools.find(t => t.name === name);
  if (!tool) return { ok: false, error: `${call.tool} isn't one of the server's read tools` };
  for (const [k, v] of Object.entries(call.args)) {
    if (!tool.props.includes(k)) return { ok: false, error: `${tool.name} takes no input ${k}` };
    const type = tool.params?.[k]?.type;
    if (type && TYPE_OK[type] && !TYPE_OK[type](v)) return { ok: false, error: `${tool.name}'s ${k} must be a ${type}` };
    if (typeof v === "string" && v.length > ASK.argChars) return { ok: false, error: `${tool.name}'s ${k} is too long` };
    if (v !== null && typeof v === "object" && JSON.stringify(v).length > ASK.argChars * 4) return { ok: false, error: `${tool.name}'s ${k} is too long` };
  }
  const missing = tool.required.find(r => !(r in call.args));
  if (missing) return { ok: false, error: `${tool.name} needs ${missing}` };
  return { ok: true, call: { tool: tool.name, args: call.args } };
}

/** The plan: the valid calls, first ASK.calls of them, and why each refused one was refused. */
export function validatePlan(tools: readonly ReadTool[], reply: z.infer<typeof askPlanReplySchema>): { calls: AskCall[]; refused: string[] } {
  const calls: AskCall[] = []; const refused: string[] = [];
  for (const c of reply.calls) {
    const v = validateCall(tools, c);
    if (!v.ok) refused.push(v.error);
    else if (calls.length < ASK.calls && !calls.some(x => JSON.stringify(x) === JSON.stringify(v.call))) calls.push(v.call);
  }
  return { calls, refused };
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export const ASK_PLAN_SYSTEM = `You plan read-only lookups for a developer's morning brief. You get one server's read-only tools with their inputs. Pick at most ${ASK.calls} calls that best show what needs the developer today: asks waiting on them, things due today, and changes since the given time. Use only the tools and inputs listed; fill required inputs; prefer few calls. If no tool could answer, reply {"calls":[]}. Reply with JSON only: {"calls":[{"tool":"<tool name>","args":{...}}]}`;

/** What the planner sees: the server's read tools (names, descriptions, inputs with types), trimmed, and the window. */
export function askPlanPrompt(server: string, tools: readonly ReadTool[], since: string, now: string, timeZone: string): string {
  const lines = tools.slice(0, ASK.tools).map(t => {
    const params = t.props.map(p => `${p}${t.required.includes(p) ? "*" : ""}:${t.params?.[p]?.type ?? "any"}${t.params?.[p]?.description ? ` (${oneLine(t.params[p].description, ASK.paramChars)})` : ""}`);
    return `- ${t.name}: ${oneLine(t.description, ASK.toolChars) || "(no description)"}\n  inputs: ${params.join(", ") || "none"}`;
  });
  return `Server: ${server}\nNow: ${now} (${timeZone})\nChanges since: ${since}\nInputs marked * are required.\n\nTools:\n${lines.join("\n")}`;
}

export const ASK_ITEMS_SYSTEM = `You turn read-only lookup results into a developer's morning brief items. Keep only what needs the developer today: an ask waiting on them, something due today, or a change since the given time. At most ${ASK.items} items, most important first; none is fine. title: what it is (short). why: why it needs them today (one line). url: only a link that appears in the results, else null. due: an ISO date only if the results say it, else null. Use only facts in the results; never guess names, numbers or links. Reply with JSON only: {"items":[{"title":"...","why":"...","url":null,"due":null}]}`;

export function askItemsPrompt(server: string, results: readonly { call: AskCall; reply: string }[], since: string, now: string): string {
  const blocks = results.map((r, i) => `## Call ${i + 1}: ${r.call.tool} ${JSON.stringify(r.call.args)}\n${r.reply.slice(0, ASK.replyChars)}`);
  return `Server: ${server}\nNow: ${now}\nChanges since: ${since}\n\n${blocks.join("\n\n")}`;
}

/**
 * The items, checked: at most ASK.items, titles and reasons on one line and capped, a link only when it's http(s) and
 * a reply carries it verbatim (never one the model made up), a due date only when it reads as a date.
 */
export function validateItems(reply: z.infer<typeof askItemsReplySchema>, replies: readonly string[]): AskItem[] {
  const out: AskItem[] = [];
  for (const it of reply.items) {
    const title = oneLine(it.title, 160);
    if (!title || out.some(o => o.title === title)) continue;
    const url = it.url && /^https?:\/\/\S+$/.test(it.url.trim()) && replies.some(r => r.includes(it.url!.trim())) ? it.url.trim() : null;
    const due = it.due && /^\d{4}-\d{2}-\d{2}/.test(it.due) && !Number.isNaN(Date.parse(it.due)) ? it.due.slice(0, 25) : null;
    out.push({ title, why: oneLine(it.why ?? "", 240), url, due });
    if (out.length >= ASK.items) break;
  }
  return out;
}
