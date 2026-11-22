import { z } from "zod";
import { classifyLink, linearKey, teamOf } from "./linked";
import type { LinearIssue } from "./linear-issues";

/**
 * New (internally "dispatch"): start a workspace from a Linear issue, a link or a sentence (docs/dispatch.md).
 *
 * Everything here is pure, so the dialog's preview, an agent's dry run and the real dispatch compute the same thing:
 * - an action is data (`an-action-is-data`): a validated record whose instructions are a template; no action runs code,
 *   and `renderAction` is the one function that turns it into the agent's first message;
 * - `resolveWhere` picks the project and says why, and a guess is drawn as a guess
 *   (`new-never-switches-the-project-silently`);
 * - `titleFor` and `branchFor` name the workspace and its branch.
 */

// ---------- tunables (one constant each, so a decision is one edit) ----------

/** How long Undo (archive what the dispatch created) is offered. Q139: 10 minutes. */
export const UNDO_WINDOW_MS = 10 * 60_000;
/** A source's text in the instructions (`{body}`) is clipped to this many UTF-8 bytes. */
export const BODY_MAX_BYTES = 4096;
/** An action's instructions template. */
export const INSTRUCTIONS_MAX = 8192;
/** Dispatch records kept (the newest; the rest are dropped). */
export const RECORDS_MAX = 50;
/** Actions New keeps (built-ins included): a list the developer writes by hand. */
export const ACTIONS_MAX = 40;
/** What an action can apply to: an issue-like source and a PR. */
const APPLIES_MAX = 2;
/** A Paseo that can't be reached is tried again after these waits, then every last one (the message queue's rhythm). */
export const RETRY_MS = [15_000, 60_000, 300_000] as const;
/** Learned routing: a team's top project needs at least this many workspaces and this share of the team's. */
export const LEARN_MIN = 2;
export const LEARN_SHARE = 0.7;
export const TITLE_MAX = 60;
export const BRANCH_MAX = 50;
/** An agent's plan from `dispatch`'s dry run is good for this long. */
export const PLAN_TTL_MS = 10 * 60_000;
/** The Linear list New shows; the reader itself isn't capped (shared/linear-issues.ts). */
export const LIST_SHOWN = 25;

// ---------- actions ----------

export const ACTION_ICONS = ["git-pull-request", "file-text", "search", "folder-open", "git-branch", "sparkles", "bug", "wrench", "message-square", "play"] as const;
export const PLACEHOLDERS = ["title", "url", "key", "body", "kind", "team", "repo", "base", "branch"] as const;
export type Placeholder = typeof PLACEHOLDERS[number];
export const BUILTIN_IDS = ["pr", "plan", "investigate", "open", "checkout"] as const;
export type BuiltinId = typeof BUILTIN_IDS[number];
/** "issue": anything that isn't a pull request (a Linear issue, a GitHub issue, a link, typed text). */
export const APPLIES = ["issue", "pr"] as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lower-case letters, digits and dashes.");
export const actionAgentSchema = z.strictObject({
  provider: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  mode: z.string().trim().min(1).max(60).optional(),
  thinking: z.string().trim().min(1).max(60).optional(),
});
export type ActionAgent = z.infer<typeof actionAgentSchema>;
export const dispatchActionSchema = z.strictObject({
  id: slug,
  name: z.string().trim().min(1).max(24),
  icon: z.enum(ACTION_ICONS),
  description: z.string().trim().max(80),
  instructions: z.string().min(1).max(INSTRUCTIONS_MAX),
  /** null: New's default agent (Settings → Agents). */
  agent: actionAgentSchema.nullable(),
  workspace: z.enum(["worktree", "local"]),
  branch: z.enum(["source-or-title", "title"]),
  follow: z.strictObject({ goalFromSource: z.boolean(), specFromArtifact: z.boolean(), askWhenPlanReady: z.boolean() }),
  appliesTo: z.array(z.enum(APPLIES)).min(1).max(APPLIES_MAX),
  hidden: z.boolean(),
  builtin: z.enum(BUILTIN_IDS).optional(),
  /** Who last wrote it: "developer" or "agent:<id>"; absent for an untouched built-in. */
  by: z.string().max(220).optional(),
});
export type DispatchAction = z.infer<typeof dispatchActionSchema>;

const builtin = (a: Omit<DispatchAction, "builtin" | "by" | "agent" | "hidden" | "appliesTo" | "branch"> & Partial<Pick<DispatchAction, "hidden" | "appliesTo" | "branch">>): DispatchAction =>
  dispatchActionSchema.parse({ agent: null, hidden: false, appliesTo: ["issue"], branch: "source-or-title", ...a, builtin: a.id });

/** The built-in set, in order. The first visible one is ↵, the second ⌥↵. Nothing here names a team, repo or person. */
export const BUILTIN_ACTIONS: readonly DispatchAction[] = [
  builtin({ id: "pr", name: "Create PR", icon: "git-pull-request", description: "Build it and open a PR",
    instructions: "Work on {key} “{title}” ({url}).\nRead the issue and its comments first. Plan the change, build it, run the tests and open a PR from {branch} against {base} in {repo}; register it with Follow-up. Don't stop to ask unless something blocks you; record decisions as tasks.\n\n{body}",
    workspace: "worktree", follow: { goalFromSource: true, specFromArtifact: false, askWhenPlanReady: false } }),
  builtin({ id: "plan", name: "Plan as artifact", icon: "file-text", description: "A detailed plan to read before any code",
    instructions: "Plan a detailed solution for {key} “{title}” ({url}).\nRead the issue, its comments and the code it touches in {repo}. Publish the plan as an artifact: the problem, the approach, the risky parts, the steps and how you'll test it. Register it as the spec. Then ask the developer one question: build it as planned, or change something. Don't write code before they answer.\n\n{body}",
    workspace: "worktree", follow: { goalFromSource: true, specFromArtifact: true, askWhenPlanReady: true } }),
  builtin({ id: "investigate", name: "Investigate", icon: "search", description: "Find the cause; no code changes",
    instructions: "Investigate {key} “{title}” ({url}) in {repo}.\nFind the cause. Report what's wrong, where, and two ways to fix it. Don't change any code. End with one question for the developer: which fix.\n\n{body}",
    workspace: "worktree", follow: { goalFromSource: true, specFromArtifact: false, askWhenPlanReady: false } }),
  builtin({ id: "open", name: "Just open", icon: "folder-open", description: "The workspace and an agent with it loaded", hidden: true,
    instructions: "Read {key} “{title}” ({url}) and wait for the developer.\n\n{body}",
    workspace: "local", follow: { goalFromSource: false, specFromArtifact: false, askWhenPlanReady: false } }),
  builtin({ id: "checkout", name: "Check out PR", icon: "git-branch", description: "A worktree on the PR's branch", appliesTo: ["pr"],
    instructions: "You're on {branch}, checked out from {key} “{title}” ({url}) in {repo}.\nRead the PR, its description and its review threads, then wait for the developer.",
    workspace: "worktree", follow: { goalFromSource: false, specFromArtifact: false, askWhenPlanReady: false } }),
];
export const builtinAction = (id: BuiltinId) => BUILTIN_ACTIONS.find(a => a.id === id)!;

/**
 * The actions in effect: the saved list (null until someone edits one), with every built-in the saved list doesn't
 * have appended (a built-in added in a later version shows up), in order.
 */
export function effectiveActions(saved: readonly DispatchAction[] | null): DispatchAction[] {
  if (!saved) return [...BUILTIN_ACTIONS];
  const ids = new Set(saved.map(a => a.id));
  return [...saved, ...BUILTIN_ACTIONS.filter(a => !ids.has(a.id) && !(a.builtin && saved.some(s => s.builtin === a.builtin)))];
}
/** The actions a source offers, visible ones first in list order: the first is ↵, the second ⌥↵. */
export function actionsFor(actions: readonly DispatchAction[], kind: SourceKind): DispatchAction[] {
  const applies = kind === "pr" ? "pr" : "issue";
  return actions.filter(a => !a.hidden && a.appliesTo.includes(applies));
}

/** Placeholder names used in a template that New doesn't know. */
export function unknownPlaceholders(template: string): string[] {
  const names = [...template.matchAll(/\{([^{}\s]{1,40})\}/g)].map(m => m[1]);
  return [...new Set(names.filter(n => !(PLACEHOLDERS as readonly string[]).includes(n)))];
}
/** A saved action is refused with the names of its unknown placeholders. */
export function validateAction(raw: unknown): { ok: true; action: DispatchAction } | { ok: false; reason: string } {
  const parsed = dispatchActionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map(i => `${i.path.join(".") || "action"}: ${i.message}`).join("; ") };
  const unknown = unknownPlaceholders(parsed.data.instructions);
  if (unknown.length) return { ok: false, reason: `Unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.map(u => `{${u}}`).join(", ")}. Use ${PLACEHOLDERS.map(p => `{${p}}`).join(" ")}.` };
  return { ok: true, action: parsed.data };
}

/** `text` cut to at most `max` UTF-8 bytes at a character boundary, with "…" when cut. */
export function clipBytes(text: string, max: number): string {
  if (utf8Length(text) <= max) return text;
  let out = "", used = 0;
  for (const ch of text) { const n = utf8Length(ch); if (used + n > max - 3) break; out += ch; used += n; }
  return `${out}…`;
}
/** UTF-8 byte length without Buffer (shared code also runs in the phone app). */
export function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}

export type RenderValues = Partial<Record<Placeholder, string | null>>;
/**
 * The agent's first message: the action's template with each placeholder filled (`{body}` clipped to BODY_MAX_BYTES),
 * plus the developer's note. An empty placeholder renders as nothing; a line that held only empty placeholders is
 * dropped, and what an empty value leaves behind (`()`, `“”`, doubled spaces) is tidied. Unknown placeholders are left
 * as written (saving refuses them, `validateAction`). One function for the preview, the dry run and the dispatch.
 */
export function renderAction(action: Pick<DispatchAction, "instructions">, values: RenderValues, note?: string | null): string {
  const value = (name: string): string | null => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return null;
    const v = values[name as Placeholder]?.trim() ?? "";
    return name === "body" ? clipBytes(v, BODY_MAX_BYTES) : v;
  };
  const lines: string[] = [];
  for (const line of action.instructions.split("\n")) {
    const names = [...line.matchAll(/\{([^{}\s]{1,40})\}/g)].map(m => m[1]);
    const rendered = line.replace(/\{([^{}\s]{1,40})\}/g, (whole, name: string) => value(name) ?? whole);
    const onlyPlaceholders = names.length > 0 && !line.replace(/\{([^{}\s]{1,40})\}/g, "").trim();
    if (onlyPlaceholders && !rendered.trim()) continue;
    lines.push(rendered.replace(/\(\s*\)|“\s*”|"\s*"/g, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:])/g, "$1").trimEnd());
  }
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const n = note?.trim();
  if (n) text += `\n\nNote from the developer: ${n}`;
  return text;
}
/** A short stable hash of the rendered instructions: an agent's confirm refuses a plan whose text changed since. */
export function textHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------- sources ----------

export const SOURCE_KINDS = ["linear", "issue", "pr", "link", "text"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
/** What a dispatch starts from. `team` is a Linear team key; `repo` is owner/name when the source names it. */
export const dispatchSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  key: z.string().max(300).nullable(),
  title: z.string().max(500),
  url: z.string().max(2000).nullable(),
  body: z.string().max(BODY_MAX_BYTES * 2),
  team: z.string().max(30).nullable(),
  repo: z.string().max(201).nullable(),
  number: z.number().int().positive().nullable(),
  /** Linear's own branch name for the issue (it already carries the user prefix and the key). */
  branchHint: z.string().max(200).nullable(),
  state: z.string().max(100).nullable(),
  /** False when the source couldn't be read (Linear down): the agent gets the key and link and reads it itself. */
  read: z.boolean(),
});
export type DispatchSource = z.infer<typeof dispatchSourceSchema>;
export const KIND_WORD: Record<SourceKind, string> = { linear: "Linear issue", issue: "GitHub issue", pr: "pull request", link: "link", text: "your words" };

/** The first sentence of typed text, at most TITLE_MAX characters, cut at a word. No AI. */
export function firstSentence(text: string, max = TITLE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = (/^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat).replace(/[.!?]+$/, "");
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:-]+$/, "")}…`;
}

/** What was pasted or typed, before any read: a Linear key or URL, a GitHub issue or PR, another link, or text. */
export function parseSource(raw: string): DispatchSource {
  const text = raw.trim();
  const base = { url: null, body: "", team: null, repo: null, number: null, branchHint: null, state: null, read: false };
  const c = /\s/.test(text) ? null : classifyLink(text);
  if (c?.kind === "linear") {
    const key = linearKey(c.key) ?? c.key;
    return { ...base, kind: "linear", key, title: key, url: c.url, team: teamOf(key) };
  }
  if (c?.kind === "pr" || c?.kind === "issue") {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(c.key);
    return { ...base, kind: c.kind, key: c.key, title: c.key, url: c.url, repo: m?.[1].toLowerCase() ?? null, number: m ? Number(m[2]) : null };
  }
  if (c) return { ...base, kind: "link", key: c.key, title: c.url ?? c.key, url: c.url };
  if (/^https?:\/\/\S+$/i.test(text)) return { ...base, kind: "link", key: text, title: text, url: text };
  return { ...base, kind: "text", key: null, title: firstSentence(text) || "New work", body: text, read: true };
}
/** A Linear issue read as a source. */
export function linearSource(issue: LinearIssue): DispatchSource {
  return { kind: "linear", key: issue.key, title: issue.title, url: issue.url, body: issue.description ?? "", team: issue.team, repo: null, number: null, branchHint: issue.branchName, state: issue.state, read: true };
}

// ---------- title and branch ----------

/** `<KEY> <title>` (a typed source has no key), at most TITLE_MAX characters cut at a word: Home and the sidebar read the same. */
export function titleFor(source: Pick<DispatchSource, "kind" | "key" | "title" | "number">): string {
  const prefix = source.kind === "linear" ? source.key : source.kind === "pr" || source.kind === "issue" ? (source.number ? `#${source.number}` : null) : null;
  const title = source.title.trim() && source.title !== source.key ? source.title.trim() : "";
  const whole = [prefix, title].filter(Boolean).join(" ") || source.key || "New work";
  return whole.length <= TITLE_MAX ? whole : firstSentence(whole, TITLE_MAX);
}
/** Lower-case words joined by dashes, at most BRANCH_MAX characters. */
export function slugify(text: string, max = BRANCH_MAX): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}
/**
 * The branch: Linear's own branch name when the action allows it and Linear gave one, else `<key>-<title slug>`;
 * at most BRANCH_MAX characters. A name already taken gets `-2`, `-3`… (`taken` holds the repo's branch names).
 */
export function branchFor(source: Pick<DispatchSource, "kind" | "key" | "title" | "branchHint" | "number">, rule: DispatchAction["branch"], taken: Iterable<string> = []): string {
  const hint = rule === "source-or-title" && source.branchHint && /^[\w./-]{1,200}$/.test(source.branchHint) ? source.branchHint.slice(0, 200) : null;
  const key = source.kind === "linear" ? source.key : source.kind === "issue" && source.number ? `issue-${source.number}` : null;
  const words = source.title && source.title !== source.key ? source.title : "";
  const name = hint ?? (slugify([key, words].filter(Boolean).join(" ")) || "new-work");
  return freeBranch(name, taken);
}
export function freeBranch(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(t => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) { const next = `${name.slice(0, BRANCH_MAX - String(n).length - 1)}-${n}`; if (!used.has(next.toLowerCase())) return next; }
  return `${name.slice(0, BRANCH_MAX - 9)}-${Date.now().toString(36).slice(-8)}`;
}

// ---------- where it goes ----------

export type WhereProject = { id: string; name: string; repo: string | null; worktree: boolean };
export const WHERE_HOW = ["picked", "link", "rule", "learned", "last", "only", "ambiguous"] as const;
export type WhereHow = typeof WHERE_HOW[number];
export type Where = {
  projectId: string | null;
  projectName: string | null;
  how: WhereHow;
  /** Shown under the project: "From the link", "9 ACME workspaces started here", "Guess: last used project". */
  reason: string;
  /** Drawn as a guess (dashed), one tap to change. */
  guess: boolean;
  /** For "which project?": the candidates, last used first. */
  candidates: { id: string; name: string; lastUsed: boolean }[];
};
export type WhereInput = {
  source: Pick<DispatchSource, "kind" | "team" | "repo">;
  projects: readonly WhereProject[];
  /** The developer's or an agent's explicit choice for this dispatch. */
  picked?: string | null;
  /** Team key → project id (Settings → New work, or saved by a pick in the ambiguous picker). */
  rules: Readonly<Record<string, string>>;
  /** Team key → project id → workspaces with that team's issue linked. */
  learned: Readonly<Record<string, Readonly<Record<string, number>>>>;
  lastProjectId: string | null;
  /** A source with no team: "last" uses the last project (as a guess), "ask" always asks. */
  noTeam: "last" | "ask";
};

/**
 * The project a source goes to, and why, in this order: the developer's pick; the repository a GitHub link names; the
 * team's rule; what the team's past workspaces learned (LEARN_MIN and LEARN_SHARE); for a source with no team, the
 * last used project as a guess; the only project; otherwise ambiguous, with the candidates. A rule or pick naming a
 * project that is gone makes it ambiguous and says so; nothing ever switches silently.
 */
export function resolveWhere(input: WhereInput): Where {
  const byId = new Map(input.projects.map(p => [p.id, p]));
  const candidates = () => {
    const list = input.projects.map(p => ({ id: p.id, name: p.name, lastUsed: p.id === input.lastProjectId }));
    return [...list.filter(c => c.lastUsed), ...list.filter(c => !c.lastUsed)];
  };
  const at = (p: WhereProject, how: WhereHow, reason: string, guess = false): Where => ({ projectId: p.id, projectName: p.name, how, reason, guess, candidates: [] });
  const ambiguous = (reason: string): Where => ({ projectId: null, projectName: null, how: "ambiguous", reason, guess: false, candidates: candidates() });
  if (input.picked) {
    const p = byId.get(input.picked);
    return p ? at(p, "picked", "Your pick") : ambiguous("That project isn't in Paseo any more. Pick another.");
  }
  const { source } = input;
  if (source.repo) {
    const p = input.projects.find(x => x.repo?.toLowerCase() === source.repo!.toLowerCase());
    if (p) return at(p, "link", "From the link");
  }
  const team = source.team;
  if (team) {
    const rule = input.rules[team];
    if (rule) {
      const p = byId.get(rule);
      if (p) return at(p, "rule", `Your rule for ${team}`);
      return ambiguous(`The project saved for ${team} isn't in Paseo any more. Pick one; it's saved for ${team}.`);
    }
    const counts = Object.entries(input.learned[team] ?? {}).filter(([id]) => byId.has(id));
    const total = counts.reduce((n, [, c]) => n + c, 0);
    const [topId, top] = counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
    if (topId && top >= LEARN_MIN && top / total >= LEARN_SHARE) return at(byId.get(topId)!, "learned", `${top} ${team} workspace${top === 1 ? "" : "s"} started here`);
  } else if (input.noTeam === "last" && input.lastProjectId && byId.has(input.lastProjectId)) {
    return at(byId.get(input.lastProjectId)!, "last", "Guess: last used project", true);
  }
  const worktrees = input.projects.filter(p => p.worktree);
  if (worktrees.length === 1) return at(worktrees[0], "only", "Your only project");
  if (!input.projects.length) return ambiguous("No Paseo project yet. Add one in Paseo first.");
  return ambiguous(team ? `Which project for ${team}? Your pick is saved for ${team}.` : "Which project?");
}

/** The base branch's reason line. */
export const baseReason = (saved: boolean, detected: boolean) => saved ? "Saved for this project" : detected ? "The repository's default branch" : "Default";

// ---------- records and the file ----------

export const DISPATCH_STATES = ["queued", "creating", "starting", "created", "failed", "undone", "cancelled"] as const;
export type DispatchState = typeof DISPATCH_STATES[number];
/** One dispatch, from the click to the agent's first message (dispatch.json). Home's row and the dialog read it. */
export const dispatchRecordSchema = z.object({
  id: z.string().min(1).max(80),
  at: z.string().max(40),
  /** "developer" or "agent:<id>". */
  by: z.string().max(220),
  source: dispatchSourceSchema.pick({ kind: true, key: true, title: true, url: true }),
  actionId: z.string().max(40),
  actionName: z.string().max(24),
  projectId: z.string().max(200),
  projectName: z.string().max(200),
  workspace: z.enum(["worktree", "local"]),
  base: z.string().max(200).nullable(),
  branch: z.string().max(200).nullable(),
  prNumber: z.number().int().positive().nullable(),
  title: z.string().max(200),
  agentLabel: z.string().max(200),
  promptHash: z.string().max(16),
  /** The agent's first message, kept only until it is sent (a queued dispatch resends it after a restart). */
  prompt: z.string().max(INSTRUCTIONS_MAX + BODY_MAX_BYTES * 2 + 4096).nullable(),
  state: z.enum(DISPATCH_STATES),
  /** The step in progress or that failed, in the developer's words. */
  step: z.string().max(200).nullable(),
  workspaceId: z.string().max(200).nullable(),
  agentId: z.string().max(200).nullable(),
  error: z.string().max(500).nullable(),
  /** What a failure left: "Nothing was created." or "The workspace was archived again." (a-failed-dispatch-leaves-nothing-behind). */
  leftBehind: z.string().max(200).nullable(),
  attempts: z.number().int().min(0),
  nextTryAt: z.string().max(40).nullable(),
  undoUntil: z.string().max(40).nullable(),
});
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>;

export const dispatchFileSchema = z.object({
  version: z.literal(1),
  /** null: the built-ins, untouched. */
  actions: z.array(dispatchActionSchema).max(ACTIONS_MAX).nullable(),
  /** Linear team key → project id. */
  rules: z.record(z.string().max(30), z.string().max(200)),
  /** Project id → base branch. */
  bases: z.record(z.string().max(200), z.string().max(200)),
  noTeam: z.enum(["last", "ask"]),
  lastProjectId: z.string().max(200).nullable(),
  records: z.record(z.string().max(80), dispatchRecordSchema),
});
export type DispatchFile = z.infer<typeof dispatchFileSchema>;
export const emptyDispatchFile = (): DispatchFile => ({ version: 1, actions: null, rules: {}, bases: {}, noTeam: "last", lastProjectId: null, records: {} });

/** Whether Undo is still offered for a record at `now`. */
export const undoable = (r: Pick<DispatchRecord, "state" | "undoUntil" | "workspaceId">, now: number) =>
  r.state === "created" && !!r.workspaceId && !!r.undoUntil && Date.parse(r.undoUntil) > now;
/** The newest records first, at most `n`. */
export const recentRecords = (records: Readonly<Record<string, DispatchRecord>>, n = 3) =>
  Object.values(records).sort((a, b) => b.at.localeCompare(a.at)).slice(0, n);

/** The waits before each retry of a dispatch Paseo couldn't take; then every last one. */
export const retryDelay = (attempts: number) => RETRY_MS[Math.min(Math.max(attempts - 1, 0), RETRY_MS.length - 1)];

// ---------- RPC inputs (shared/contracts.ts, the agent tools) ----------

/** One dispatch's inputs: a source and what the developer changed in the dialog (everything else is resolved). */
export const dispatchInputSchema = z.strictObject({
  source: z.string().max(20_000),
  actionId: z.string().trim().min(1).max(40).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  base: z.string().trim().min(1).max(200).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  workspace: z.enum(["worktree", "local"]).optional(),
  note: z.string().max(4000).optional(),
});
export const actionChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("upsert"), action: dispatchActionSchema.omit({ by: true, builtin: true }) }),
  z.strictObject({ op: z.literal("move"), id: z.string().min(1).max(40), to: z.number().int().min(0).max(100) }),
  z.strictObject({ op: z.literal("hide"), id: z.string().min(1).max(40), hidden: z.boolean() }),
  z.strictObject({ op: z.literal("reset"), id: z.string().min(1).max(40) }),
  z.strictObject({ op: z.literal("delete"), id: z.string().min(1).max(40) }),
  z.strictObject({ op: z.literal("reset-all") }),
]);
export const settingsChangeSchema = z.strictObject({
  rules: z.record(z.string().trim().min(1).max(30), z.string().max(200).nullable()).optional(),
  bases: z.record(z.string().min(1).max(200), z.string().max(200).nullable()).optional(),
  noTeam: z.enum(["last", "ask"]).optional(),
});
