import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonFileStore } from "./json-file-store";
import { imageSupport, imagesLeftOff } from "./image-support";
import type { ImageRef, ImageUpload } from "../shared/images";
import type { Actor } from "../shared/actor";
import { actorBy } from "../shared/actor";
import {
  ACTIONS_MAX, KIND_WORD, LIST_SHOWN, RECORDS_MAX, UNDO_WINDOW_MS, actionsFor, baseReason, branchFor, dispatchFileSchema, dispatchRecordSchema,
  effectiveActions, emptyDispatchFile, linearSource, parseSource, recentRecords, renderAction, resolveWhere, retryDelay, textHash, titleFor,
  undoable, validateAction, builtinAction, BUILTIN_IDS,
  type ActionAgent, type BuiltinId, type DispatchPlan, type ExistingWorkspace, type SourceRoute, type DispatchAction, type DispatchFile, type DispatchRecord, type DispatchSource, type Where, type WhereProject,
} from "../shared/dispatch";
import type { LinearIssue } from "../shared/linear-issues";
import { holderOf } from "../shared/issue-workspace";
export type { DispatchPlan, ExistingWorkspace, SourceRoute } from "../shared/dispatch";
import type { LinearList } from "./linear-issues";

/**
 * New's worker side (docs/dispatch.md): the dispatch store (`dispatch.json`), reading a source, the preview every
 * surface shows, and the dispatch itself: create the workspace, start the agent with the rendered instructions, and
 * undo within UNDO_WINDOW_MS.
 *
 * - `dispatch-needs-a-click-or-a-confirmed-plan`: `dispatch` runs only from the developer's click (the RPC from the
 *   app) or an agent's confirmed plan (AgentActions' `dispatch` tool: dry run, then confirm with the plan id).
 * - `a-failed-dispatch-leaves-nothing-behind`: an agent that can't start archives the workspace just created, and the
 *   record says what was left.
 * - `new-reads-nothing-while-closed`: nothing here runs on a timer except a queued dispatch's own retry.
 * - The reply never waits on Paseo: `dispatch` records and returns; the create runs after the reply.
 */
export class DispatchStore extends JsonFileStore<DispatchFile> {
  constructor(directory: string) {
    super({ path: join(directory, "dispatch.json"), schema: dispatchFileSchema as never, empty: emptyDispatchFile, collections: { records: { kind: "record", item: dispatchRecordSchema } } });
  }
}

export type DispatchProject = WhereProject & { path: string };
type WorkspaceHandle = { id: string; agents: { create(o: Record<string, unknown>): Promise<{ id: string }> } };
/** The slice of the plugin's Paseo API a dispatch uses. Typed loosely so tests can pass a fake. */
export type DispatchPaseo = {
  workspaces: {
    create(o: Record<string, unknown>): Promise<WorkspaceHandle>;
    archive(workspaceId: string): Promise<unknown>;
  };
};
/** `picked`: the resolved provider/model/mode/thinking, so the dialog's Agent chip opens on it; `isDefault`: New's default, no override. */
export type AgentChoice = { config: Record<string, unknown>; label: string; picked?: ActionAgent; isDefault?: boolean };
export type GithubItem = { title: string; body: string | null; state: string | null };

export type DispatchDeps = {
  store: DispatchStore;
  linear: { list(o?: { limit?: number; fresh?: boolean }): Promise<LinearList>; get(key: string): Promise<LinearIssue | null>; search(query: string): Promise<LinearList> };
  /** A GitHub issue or PR, read in process (server/github-api.ts); null when it can't be read. */
  github?: (kind: "issue" | "pr", repo: string, number: number) => Promise<GithubItem | null>;
  projects(): Promise<DispatchProject[]>;
  /** Team key → project id → tracked workspaces (archived included) with that team's issue linked. */
  learned(): Promise<Record<string, Record<string, number>>>;
  /** An unarchived workspace that already has this source (its linked key, or for a PR its owner). */
  existing(source: DispatchSource): Promise<ExistingWorkspace | null>;
  /**
   * Every queue key a live workspace already has, with that workspace (a-taken-issue-is-not-a-suggestion, the same
   * predicate as `existing`): one map per list read, never a lookup per issue.
   */
  taken?(): Promise<ReadonlyMap<string, ExistingWorkspace>>;
  /** The repository's default branch for a project, or null. */
  defaultBase(projectId: string): Promise<string | null>;
  /** The agent an action starts (the action's own, else New's default agent). */
  agent(action: DispatchAction): Promise<AgentChoice>;
  /** Whether this Paseo can start another directory workspace on a project's root (Just open in the checkout). */
  multiplicity(): Promise<boolean>;
  /** The Paseo API, or null while it can't be reached. */
  paseo(): Promise<DispatchPaseo | null>;
  /** A blocker for this caller (the Overseer's new-workspace gate), or null. */
  gate?(actor: Actor): Promise<string | null>;
  /** After the agent starts: link the source, set the goal. Best effort. */
  afterCreate?(record: DispatchRecord, source: DispatchSource, action: DispatchAction): Promise<void>;
  /** Pasted images on disk (server/image-store.ts). Absent (tests): images are refused. */
  images?: { save(uploads: ImageUpload[] | undefined): Promise<ImageRef[]>; read(refs: readonly ImageRef[]): Promise<{ data: string; mimeType: string }[]>; remove(refs: readonly ImageRef[]): Promise<void> };
  /** A record changed (Home's row, the dialog). */
  onChange?(): void;
  log?(line: string): void;
  now?(): number;
};

/** What the dialog, an agent's dry run and the dispatch itself work from. */
export type DispatchInput = {
  /** A Linear key or URL, a GitHub issue or PR link, another link, or the developer's words. */
  source: string;
  actionId?: string;
  projectId?: string;
  base?: string;
  branch?: string;
  title?: string;
  workspace?: "worktree" | "local";
  note?: string;
  agent?: ActionAgent;
  /** Pasted images: they go with the new agent's first message (agents.create). */
  images?: ImageUpload[];
};

/** The action with this dispatch's own agent pick laid over its own. */
const withAgent = (action: DispatchAction, pick: ActionAgent | null | undefined): DispatchAction => pick ? { ...action, agent: pick } : action;

const PASEO_DOWN = /ECONNREFUSED|ECONNRESET|EPIPE|not connected|disconnected|socket (hang up|closed)|websocket|connection (closed|lost|refused)|daemon (is )?(not running|unreachable)|timed? ?out/i;
/** A create that failed because Paseo couldn't be reached (retry later), not because Paseo refused it. */
export const paseoUnreachable = (error: unknown) => PASEO_DOWN.test(error instanceof Error ? error.message : String(error));
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);

export class DispatchService {
  private running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private d: DispatchDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private iso(ms = this.now()) { return new Date(ms).toISOString(); }

  // ---------- reads ----------

  async actions(): Promise<{ actions: DispatchAction[]; edited: boolean }> {
    const file = await this.d.store.read();
    return { actions: effectiveActions(file.actions), edited: file.actions !== null };
  }
  async settings() {
    const [file, projects] = await Promise.all([this.d.store.read(), this.d.projects().catch(() => [] as DispatchProject[])]);
    const name = (id: string) => projects.find(p => p.id === id)?.name ?? null;
    return {
      rules: Object.entries(file.rules).map(([team, projectId]) => ({ team, projectId, project: name(projectId) })),
      bases: Object.entries(file.bases).map(([projectId, base]) => ({ projectId, project: name(projectId), base })),
      noTeam: file.noTeam,
      lastProjectId: file.lastProjectId,
      learned: await this.d.learned().catch(() => ({})),
      projects: projects.map(p => ({ id: p.id, name: p.name, repo: p.repo, worktree: p.worktree })),
    };
  }
  /** What New lists when it opens: the developer's Linear issues (one shared read a minute) and the latest dispatches. */
  async sources(o: { fresh?: boolean; query?: string } = {}) {
    const [linear, file, projects, learned] = await Promise.all([
      o.query ? this.d.linear.search(o.query) : this.d.linear.list({ limit: LIST_SHOWN, fresh: o.fresh }), this.d.store.read(),
      this.d.projects().catch(() => [] as DispatchProject[]), this.d.learned().catch(() => ({})),
    ]);
    // Each row's "→ project" (or "→ which project?") and its live workspace, so the list says where ↵ would go.
    // a-taken-issue-is-not-a-suggestion: an issue a live workspace has is listed in `taken`, never offered as new work.
    const routes: Record<string, SourceRoute> = {};
    const taken = this.d.taken ? await this.d.taken().catch(() => null) : null;
    await Promise.all(linear.issues.map(async issue => {
      const source = linearSource(issue);
      const existing = taken ? holderOf(taken, issue.key) : await this.d.existing(source).catch(() => null);
      const where = resolveWhere({ source, projects, picked: null, rules: file.rules, learned, lastProjectId: file.lastProjectId, workspaceProjectId: existing?.projectId ?? null, noTeam: file.noTeam });
      routes[issue.key] = { project: where.projectName, guess: where.guess, existing: existing ? { workspaceId: existing.workspaceId, title: existing.title, state: existing.state } : null };
    }));
    return { linear, routes, taken: linear.issues.filter(i => routes[i.key]?.existing).map(i => i.key), recent: recentRecords(file.records, 3).map(r => this.view(r)) };
  }
  records(): Promise<DispatchRecord[]> { return this.d.store.read().then(f => recentRecords(f.records, RECORDS_MAX).map(r => this.view(r))); }
  private view(r: DispatchRecord): DispatchRecord { return { ...r, prompt: null }; }

  /** The source as read: a Linear issue from the open list's cache or one get_issue, a GitHub item in process. */
  async readSource(raw: string): Promise<DispatchSource> {
    const source = parseSource(raw);
    if (source.kind === "linear" && source.key) {
      // The list carries no description: a pasted key is read once (one get_issue), with it.
      const issue = await this.d.linear.get(source.key).catch(() => undefined);
      if (issue) return linearSource(issue);
      if (issue === null) return { ...source, read: false, state: "Not found in Linear" };
      // Linear couldn't be read: the open list's row (already cached by the dialog) still gives the title.
      const listed = (await this.d.linear.list({ limit: LIST_SHOWN }).catch(() => null))?.issues.find(i => i.key === source.key);
      return listed ? { ...linearSource(listed), read: false } : source;
    }
    if ((source.kind === "issue" || source.kind === "pr") && source.repo && source.number && this.d.github) {
      const item = await this.d.github(source.kind, source.repo, source.number).catch(() => null);
      if (item) return { ...source, title: item.title || source.title, body: item.body ?? "", state: item.state, read: true };
    }
    return source;
  }

  /** The preview: everything a dispatch would do with these inputs, and what blocks it. Reads only. */
  async preview(input: DispatchInput, actor: Actor = { kind: "developer" }): Promise<DispatchPlan> {
    const raw = input.source.trim();
    const [source, file, projects] = await Promise.all([raw ? this.readSource(raw) : Promise.resolve(parseSource("")), this.d.store.read(), this.d.projects().catch(() => [] as DispatchProject[])]);
    const blockers: string[] = [];
    if (!raw) blockers.push("Give a source: a Linear key or link, a GitHub issue or PR link, or a sentence.");
    const offered = actionsFor(effectiveActions(file.actions), source.kind);
    const action = input.actionId ? effectiveActions(file.actions).find(a => a.id === input.actionId) ?? null : offered[0] ?? null;
    if (input.actionId && !action) blockers.push(`No action "${input.actionId}". dispatch_actions lists them.`);
    else if (action && !action.appliesTo.includes(source.kind === "pr" ? "pr" : "issue")) blockers.push(`${action.name} isn't offered for a ${KIND_WORD[source.kind]}.`);
    else if (!action) blockers.push("No action is shown. Turn one on in Settings → New work.");
    const existing = await this.d.existing(source).catch(() => null);
    const where = resolveWhere({ source, projects, picked: input.projectId ?? null, rules: file.rules, learned: await this.d.learned().catch(() => ({})), lastProjectId: file.lastProjectId, workspaceProjectId: existing?.projectId ?? null, noTeam: file.noTeam });
    if (!where.projectId) blockers.push(`${where.reason}${where.candidates.length ? ` Projects: ${where.candidates.slice(0, 8).map(c => `${c.name} (${c.id})`).join(", ")}.` : ""}`);
    const project = where.projectId ? projects.find(p => p.id === where.projectId) ?? null : null;
    const pr = source.kind === "pr";
    const workspace = pr ? "worktree" : input.workspace ?? action?.workspace ?? "worktree";
    if (workspace === "local" && !await this.d.multiplicity().catch(() => false)) blockers.push("This Paseo can't start another workspace in the project folder. Use a worktree.");
    if (workspace === "worktree" && project && !project.worktree) blockers.push(`${project.name} isn't a Git repository, so it can't take a worktree. Use the project folder.`);
    const savedBase = project ? file.bases[project.id] : undefined;
    const detected = project && !input.base && !savedBase ? await this.d.defaultBase(project.id).catch(() => null) : null;
    const base = workspace === "worktree" && !pr ? { name: input.base?.trim() || savedBase || detected || "main", reason: input.base ? "Your pick" : baseReason(!!savedBase, !!detected) } : null;
    const branch = workspace === "worktree" && !pr && action ? input.branch?.trim() || branchFor(source, action.branch) : null;
    const title = input.title?.trim() || titleFor(source);
    const repo = source.repo ?? project?.repo ?? project?.name ?? "";
    const instructions = action ? renderAction(action, {
      title: source.title !== source.key ? source.title : "", url: source.url, key: source.key ?? "", body: source.body, kind: KIND_WORD[source.kind],
      team: source.team, repo, base: base?.name ?? "", branch: branch ?? (pr ? `the PR's branch` : ""),
    }, input.note) : "";
    const gate = await this.d.gate?.(actor).catch(() => null);
    if (gate) blockers.push(gate);
    const agent: AgentChoice = action ? await this.d.agent(withAgent(action, input.agent)).catch(() => ({ label: "New's default agent", config: {} })) : { label: "", config: {} };
    return {
      source, action: action ? { id: action.id, name: action.name } : null,
      actions: offered.map(a => ({ id: a.id, name: a.name, icon: a.icon, description: a.description })),
      where, base, branch, title, workspace, agent: agent.label,
      agentPick: { picked: agent.picked ?? null, isDefault: !input.agent && !action?.agent && agent.isDefault !== false }, instructions, hash: textHash(instructions),
      existing: existing ? { workspaceId: existing.workspaceId, title: existing.title, state: existing.state } : null, blockers,
    };
  }

  // ---------- the dispatch ----------

  /**
   * Start one: record it and reply; the workspace and agent are created after the reply. `expectHash` (an agent's
   * confirmed plan) refuses a dispatch whose instructions changed since the dry run. A pick of a project for a team
   * that had none is saved as the team's rule (asked once per team).
   */
  async dispatch(input: DispatchInput & { expectHash?: string }, actor: Actor = { kind: "developer" }): Promise<{ dispatchId: string; record: DispatchRecord; plan: DispatchPlan }> {
    const plan = await this.preview(input, actor);
    if (plan.blockers.length) throw new Error(plan.blockers.join(" "));
    if (input.expectHash && input.expectHash !== plan.hash) throw new Error("What this would send changed since the dry run. Run the dry run again.");
    const file = await this.d.store.read();
    const action = effectiveActions(file.actions).find(a => a.id === plan.action!.id)!;
    const id = randomUUID();
    if (input.images?.length && !this.d.images) throw new Error("This host can't keep pasted images.");
    const images = input.images?.length ? await this.d.images!.save(input.images) : [];
    const record: DispatchRecord = dispatchRecordSchema.parse({
      id, at: this.iso(), by: actorBy(actor), source: { kind: plan.source.kind, key: plan.source.key, title: plan.source.title.slice(0, 500), url: plan.source.url },
      actionId: action.id, actionName: action.name, projectId: plan.where.projectId!, projectName: plan.where.projectName!, workspace: plan.workspace,
      base: plan.base?.name ?? null, branch: plan.branch, prNumber: plan.source.kind === "pr" ? plan.source.number : null, title: plan.title, agentLabel: plan.agent, agent: input.agent ?? null,
      promptHash: plan.hash, prompt: plan.instructions, images, state: "queued", step: "Waiting to start", workspaceId: null, agentId: null, error: null, leftBehind: null,
      attempts: 0, nextTryAt: null, undoUntil: null,
    });
    const dropped: ImageRef[] = [];
    await this.d.store.mutate(f => {
      f.records[id] = record;
      f.lastProjectId = record.projectId;
      const team = plan.source.team;
      if (team && plan.where.how === "picked" && !f.rules[team]) f.rules[team] = record.projectId;
      const keep = new Set(recentRecords(f.records, RECORDS_MAX).map(r => r.id));
      for (const key of Object.keys(f.records)) if (!keep.has(key)) { dropped.push(...f.records[key]!.images ?? []); delete f.records[key]; }
    }).catch(async error => { await this.d.images?.remove(images); throw error; });
    if (dropped.length) await this.d.images?.remove(dropped);
    this.d.onChange?.();
    this.kick(id, plan.source, action);
    return { dispatchId: id, record: this.view(record), plan };
  }

  private kick(id: string, source: DispatchSource | null, action: DispatchAction | null) {
    if (this.stopped || this.running.has(id)) return;
    const run = this.run(id, source, action).catch(error => this.d.log?.(`dispatch ${id}: ${errorLine(error)}`)).finally(() => { this.running.delete(id); this.schedule(); });
    this.running.set(id, run);
  }
  /** Waits for the dispatches in flight (tests, stop). */
  async settle(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }

  /** Image ids a record still needs (its prompt not sent yet): the worker's start sweeps the rest. */
  async imageIds(): Promise<string[]> {
    return Object.values((await this.d.store.read()).records).filter(r => r.prompt).flatMap(r => (r.images ?? []).map(i => i.id));
  }
  private async patch(id: string, change: Partial<DispatchRecord>): Promise<DispatchRecord | null> {
    let done: ImageRef[] = [];
    const next = await this.d.store.mutate(f => {
      const r = f.records[id];
      if (!r) return null;
      // The prompt is gone (sent, or the dispatch failed): its images go with it.
      if (change.prompt === null && r.images?.length) { done = r.images; change = { ...change, images: [] }; }
      for (const [k, v] of Object.entries(change)) if ((r as Record<string, unknown>)[k] !== v) (r as Record<string, unknown>)[k] = v;
      return { ...r };
    });
    if (done.length) await this.d.images?.remove(done);
    this.d.onChange?.();
    return next;
  }

  private async run(id: string, source: DispatchSource | null, action: DispatchAction | null): Promise<void> {
    const r = (await this.d.store.read()).records[id];
    if (!r || r.state !== "queued" || !r.prompt) return;
    const paseo = await this.d.paseo().catch(() => null);
    if (!paseo) { await this.retryLater(r, "Paseo can't be reached."); return; }
    const project = (await this.d.projects().catch(() => [] as DispatchProject[])).find(p => p.id === r.projectId);
    if (!project) { await this.patch(id, { state: "failed", step: "Finding the project", error: `${r.projectName} isn't in Paseo any more.`, leftBehind: "Nothing was created.", prompt: null }); return; }
    const local = r.workspace === "local";
    await this.patch(id, { state: "creating", step: local ? `Opening ${project.name}` : r.prNumber ? `Checking out #${r.prNumber}` : `Creating the worktree from ${r.base}`, attempts: r.attempts + 1, nextTryAt: null, error: null });
    let workspace: WorkspaceHandle;
    try {
      const sourceSpec = local ? { kind: "directory", path: project.path, projectId: project.id }
        : r.prNumber ? { kind: "worktree", projectId: project.id, action: "checkout", githubPrNumber: r.prNumber, checkoutSource: { kind: "change_request", forge: "github", number: r.prNumber } }
        : { kind: "worktree", projectId: project.id, action: "branch-off", baseBranch: r.base, branchName: r.branch };
      workspace = await paseo.workspaces.create({ title: r.title, source: sourceSpec });
    } catch (error) {
      if (paseoUnreachable(error)) { await this.retryLater({ ...r, attempts: r.attempts + 1 }, "Paseo can't be reached."); return; }
      await this.patch(id, { state: "failed", error: errorLine(error), leftBehind: "Nothing was created.", prompt: null });
      return;
    }
    await this.patch(id, { state: "starting", step: `Starting ${r.agentLabel || "the agent"}`, workspaceId: workspace.id });
    const fileNow = await this.d.store.read();
    const act = action ?? effectiveActions(fileNow.actions).find(a => a.id === r.actionId) ?? null;
    let agentId: string;
    try {
      const choice = act ? await this.d.agent(withAgent(act, r.agent)) : { config: {}, label: r.agentLabel };
      // The pasted images go with the new agent's first message.
      const images = r.images?.length && this.d.images ? await this.d.images.read(r.images) : [];
      // An agent that can't take images starts with the words and a line saying so (the dialog said it before Start).
      const support = images.length ? imageSupport({ provider: String((choice.config as { provider?: unknown }).provider ?? "") || null }) : null;
      const prompt = support && !support.ok ? r.prompt + imagesLeftOff(images.length, support) : r.prompt;
      agentId = (await workspace.agents.create({ config: choice.config, title: r.title, prompt, ...(images.length && support?.ok ? { images } : {}) })).id;
    } catch (error) {
      // a-failed-dispatch-leaves-nothing-behind: the workspace just created goes again, as Report an issue's Send does.
      const archived = await paseo.workspaces.archive(workspace.id).then(() => true, () => false);
      await this.patch(id, { state: "failed", error: errorLine(error), leftBehind: archived ? "The workspace was archived again; nothing is left behind." : "The workspace couldn't be archived; archive it from Paseo's sidebar.", workspaceId: archived ? null : workspace.id, prompt: null });
      return;
    }
    const done = await this.patch(id, { state: "created", step: null, agentId, prompt: null, undoUntil: this.iso(this.now() + UNDO_WINDOW_MS) });
    if (done && act) await this.d.afterCreate?.(done, source ?? { kind: r.source.kind, key: r.source.key, title: r.source.title, url: r.source.url, body: "", team: null, repo: null, number: r.prNumber, branchHint: null, state: null, read: false }, act).catch(error => this.d.log?.(`dispatch ${id} after create: ${errorLine(error)}`));
  }

  private async retryLater(r: DispatchRecord, why: string) {
    const attempts = Math.max(r.attempts, 1);
    await this.patch(r.id, { state: "queued", step: "Waiting for Paseo", error: why, attempts, nextTryAt: this.iso(this.now() + retryDelay(attempts)) });
  }

  /** One timer for the earliest queued retry; none while nothing is queued (nothing runs while New is idle). */
  private schedule() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.stopped) return;
    void this.d.store.read().then(file => {
      const due = Object.values(file.records).filter(r => r.state === "queued" && r.nextTryAt && !this.running.has(r.id)).map(r => Date.parse(r.nextTryAt!)).sort((a, b) => a - b)[0];
      if (due === undefined || this.stopped) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.retryDue(); }, Math.max(0, due - this.now()));
      this.timer.unref?.();
    });
  }
  /** Runs every queued dispatch whose retry is due (the timer, the worker's start, a reconnect). */
  async retryDue(): Promise<void> {
    const file = await this.d.store.read();
    for (const r of Object.values(file.records)) if (r.state === "queued" && (!r.nextTryAt || Date.parse(r.nextTryAt) <= this.now())) this.kick(r.id, null, null);
    this.schedule();
  }
  /**
   * At the worker's start: a dispatch that was creating or starting when the worker stopped can't be known to have
   * finished, so it is failed with what to check (never re-run blind: that could create a second workspace). Queued
   * ones are retried.
   */
  async start(): Promise<void> {
    await this.d.store.mutate(f => {
      for (const r of Object.values(f.records)) if (r.state === "creating" || r.state === "starting") {
        f.records[r.id] = { ...r, state: "failed", error: "Follow-up restarted while this was starting.", leftBehind: r.workspaceId ? "Check Paseo's sidebar: the workspace may be there without its agent." : "Check Paseo's sidebar before starting it again.", prompt: null, images: [] };
      }
    });
    await this.retryDue();
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Cancel a dispatch still waiting for Paseo. */
  async cancel(dispatchId: string): Promise<DispatchRecord> {
    const r = (await this.d.store.read()).records[dispatchId];
    if (!r) throw new Error("No such dispatch. It may be older than the last 50.");
    if (r.state !== "queued") throw new Error(r.state === "creating" || r.state === "starting" ? "It's already starting; use Undo once it's created." : "Only a dispatch waiting for Paseo can be cancelled.");
    return (await this.patch(dispatchId, { state: "cancelled", step: null, nextTryAt: null, prompt: null }))!;
  }
  /**
   * Undo: cancel a dispatch still waiting for Paseo, or archive the workspace a dispatch created, within UNDO_WINDOW_MS (the developer's click or an agent's confirmed
   * plan; Paseo can bring an archived workspace back from its History).
   */
  async undo(dispatchId: string): Promise<DispatchRecord> {
    const r = (await this.d.store.read()).records[dispatchId];
    if (!r) throw new Error("No such dispatch. It may be older than the last 50.");
    // Still waiting for Paseo: nothing exists yet, so Undo is a cancel.
    if (r.state === "queued") return this.cancel(dispatchId);
    if (!undoable(r, this.now())) throw new Error(r.state === "undone" ? "Already undone." : r.state !== "created" ? "Only a created workspace can be undone." : "Undo is offered for 10 minutes after the start; archive it from Paseo's sidebar instead.");
    const paseo = await this.d.paseo();
    if (!paseo) throw new Error("Paseo can't be reached. Try again in a moment.");
    await paseo.workspaces.archive(r.workspaceId!);
    return (await this.patch(dispatchId, { state: "undone", undoUntil: null }))!;
  }

  // ---------- settings ----------

  /**
   * Change the actions: add, edit, move, hide or show, reset a built-in, delete one of yours. Each written action is
   * validated (placeholders included) before anything is saved.
   */
  async setActions(change: ActionChange, actor: Actor = { kind: "developer" }): Promise<{ actions: DispatchAction[] }> {
    const by = actorBy(actor);
    const next = await this.d.store.mutate(f => {
      const list = effectiveActions(f.actions).map(a => ({ ...a }));
      const at = (id: string) => { const i = list.findIndex(a => a.id === id); if (i < 0) throw new Error(`No action "${id}". dispatch_actions lists them.`); return i; };
      switch (change.op) {
        case "upsert": {
          const v = validateAction({ ...change.action, by });
          if (!v.ok) throw new Error(v.reason);
          const i = list.findIndex(a => a.id === v.action.id);
          const prior = i >= 0 ? list[i] : null;
          const action = { ...v.action, ...(prior?.builtin ? { builtin: prior.builtin } : { builtin: undefined }) };
          if (!action.builtin) delete action.builtin;
          if (i >= 0) list[i] = action; else { if (list.length >= ACTIONS_MAX) throw new Error(`${ACTIONS_MAX} actions at most. Delete one first.`); list.push(action); }
          break;
        }
        case "move": { const i = at(change.id); const [a] = list.splice(i, 1); list.splice(Math.max(0, Math.min(list.length, change.to)), 0, a); break; }
        case "hide": { const i = at(change.id); list[i] = { ...list[i], hidden: change.hidden, by }; break; }
        case "reset": {
          const i = at(change.id);
          const id = list[i].builtin;
          if (!id) throw new Error("Only a built-in action can be reset.");
          list[i] = { ...builtinAction(id) };
          break;
        }
        case "delete": {
          const i = at(change.id);
          if (list[i].builtin) throw new Error("A built-in action can be hidden, not deleted.");
          list.splice(i, 1);
          break;
        }
        case "reset-all": { f.actions = null; return effectiveActions(null); }
      }
      f.actions = list;
      return list;
    });
    this.d.onChange?.();
    return { actions: next };
  }
  /** Rules (team → project), bases (project → branch) and the no-team rule. null removes one. */
  async setSettings(change: SettingsChange): Promise<Awaited<ReturnType<DispatchService["settings"]>>> {
    const projects = await this.d.projects().catch(() => [] as DispatchProject[]);
    const known = (id: string) => { if (projects.length && !projects.some(p => p.id === id)) throw new Error(`No project ${id}. dispatch_settings lists them.`); };
    for (const projectId of Object.values(change.rules ?? {})) if (projectId) known(projectId);
    for (const projectId of Object.keys(change.bases ?? {})) known(projectId);
    await this.d.store.mutate(f => {
      for (const [team, projectId] of Object.entries(change.rules ?? {})) { if (projectId) f.rules[team.toUpperCase()] = projectId; else delete f.rules[team.toUpperCase()]; }
      for (const [projectId, base] of Object.entries(change.bases ?? {})) { if (base) f.bases[projectId] = base; else delete f.bases[projectId]; }
      if (change.noTeam) f.noTeam = change.noTeam;
    });
    this.d.onChange?.();
    return this.settings();
  }
}

export type ActionChange =
  | { op: "upsert"; action: Omit<DispatchAction, "by"> }
  | { op: "move"; id: string; to: number }
  | { op: "hide"; id: string; hidden: boolean }
  | { op: "reset"; id: string }
  | { op: "delete"; id: string }
  | { op: "reset-all" };
export type SettingsChange = { rules?: Record<string, string | null>; bases?: Record<string, string | null>; noTeam?: "last" | "ask" };
export const isBuiltinId = (id: string): id is BuiltinId => (BUILTIN_IDS as readonly string[]).includes(id);
