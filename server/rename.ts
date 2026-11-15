import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename as move, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { dailyBudget } from "../shared/about";
import type { RoleConfig } from "../shared/agent-settings";
import {
  checkName, normalizeSuggestion, renameIssueKeys, EMPTY_RENAME_FILE, freshEntries, lastRename, RENAME_DAILY_CAP, RENAME_SYSTEM, renameFileSchema, renamePrompt, renameReplySchema, undoRefusal,
  type RenameFile, type RenameInputs, type RenameResult, type RenameStatus,
} from "../shared/rename";
import { claudeRunner, claudeArgs, type AiJobs, type JobResult, type RunInput } from "./ai-jobs";

/** A one-line Haiku job: disable thinking for this subprocess only, without changing Summaries or CLI settings. */
export const renameRunner = (command = "claude", args: (input: RunInput) => string[] = claudeArgs) => claudeRunner(command, args, { MAX_THINKING_TOKENS: "0", CLAUDE_CODE_DISABLE_THINKING: "1" });

/**
 * Rename title with AI (docs/ai-roles.md#rename-title-with-ai). The suggestion is one small job on Summaries' model, built from
 * stored data only (state, the Summary record, linked items, the cached directory's agent titles), so it never reads
 * a chat or loads an agent. The rename itself is Paseo's own workspace title, and every rename is kept in
 * `rename.json` for 24 hours so it can be undone.
 */

/** Paseo's workspace title, read and written. The only daemon calls a rename makes (renameDaemon). */
export type WorkspaceTitles = {
  get(workspaceId: string): Promise<{ title: string | null; name: string } | null>;
  set(workspaceId: string, title: string | null): Promise<void>;
};

/**
 * The daemon side of WorkspaceTitles: workspace list reads paged until the exact id is found, and set_workspace_title. Nothing else is
 * reachable from here: no agent fetch, no timeline (rename-never-wakes-an-agent, tests/rename.test.ts).
 */
type WorkspaceTitleRow = { id: string; name: string; title?: string | null };
type TitleDaemon = {
  supportsBackgroundWorkspaces?(): boolean;
  findWorkspace?(workspaceId: string): Promise<WorkspaceTitleRow | null>;
  fetchWorkspaces(options?: unknown): Promise<{ entries: WorkspaceTitleRow[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>;
  setWorkspaceTitle(workspaceId: string, title: string | null): Promise<unknown>;
};
export function renameDaemon(connect: <T>(work: (client: TitleDaemon) => Promise<T>) => Promise<T>, onChange?: () => void): WorkspaceTitles {
  return {
    get: id => connect(async client => {
      // idPrefix is accepted on the wire but ignored by the server. Never treat a list as an id lookup.
      let row: WorkspaceTitleRow | null = null;
      if (typeof client.findWorkspace === "function") row = await client.findWorkspace(id);
      else {
        const filter = client.supportsBackgroundWorkspaces?.() === true ? { includeBackground: true } : {};
        let cursor: string | undefined;
        do {
          const page = await client.fetchWorkspaces({ filter, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
          row = page.entries.find(e => e.id === id) ?? null;
          if (row) break;
          cursor = page.pageInfo.nextCursor ?? undefined;
        } while (cursor);
      }
      return row ? { title: typeof row.title === "string" && row.title.trim() ? row.title : null, name: row.name } : null;
    }),
    set: async (id, title) => { await connect(client => client.setWorkspaceTitle(id, title)); onChange?.(); },
  };
}

export class RenameStore extends JsonFileStore<RenameFile> {
  constructor(directory: string) {
    super({ path: join(directory, "rename.json"), schema: renameFileSchema as never, empty: () => structuredClone(EMPTY_RENAME_FILE), move });
  }
}

export type RenameDeps = {
  store: RenameStore;
  jobs: Pick<AiJobs, "run">;
  /** Summaries' agent (Settings → Agents): provider and model. */
  role(): Promise<RoleConfig>;
  titles: WorkspaceTitles;
  /** Stored data for the prompt; null for a workspace Follow-up can't see. */
  inputs(workspaceId: string, current: string): Promise<RenameInputs | null>;
  /** The governor: null when there's room for an on-demand job, else why not. */
  room(): Promise<string | null>;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
};

export class RenameService {
  constructor(private d: RenameDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  private async current(workspaceId: string) {
    const t = await this.d.titles.get(workspaceId);
    if (!t) throw new Error("Paseo doesn't know that workspace. Refresh and try again.");
    return { ...t, shown: t.title ?? t.name };
  }

  /** The dialog's state: the name now, linked keys, the undoable rename; with `suggest`, one model suggestion. */
  async status(workspaceId: string, suggest: boolean): Promise<RenameStatus> {
    const cur = await this.current(workspaceId);
    const inputs = await this.d.inputs(workspaceId, cur.shown);
    const keys = renameIssueKeys(inputs?.linked ?? []).slice(0, 20);
    const last = lastRename(await this.d.store.read(), workspaceId, this.now());
    const result = suggest ? await this.suggest(inputs ?? empty(cur.shown), keys, cur.shown) : null;
    return { workspaceId, current: cur.shown, suggestion: result?.name ?? null, ...(result?.notice ? { notice: result.notice } : {}), keys, last: last ? { from: last.from ?? cur.name, to: last.to, at: last.at } : null };
  }

  private async suggest(inputs: RenameInputs, keys: string[], current: string): Promise<{ name: string; notice?: string }> {
    // A developer click is on demand. Pressure can defer it briefly, never refuse it as background work.
    if (await this.d.room().catch(() => null)) await (this.d.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250);
    const role = await this.d.role();
    let rejected: { name: string; reason: string } | null = null;
    let best = "", bestScore = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const allowed = await this.d.store.mutate(file => { const b = dailyBudget(file.daily, this.now(), RENAME_DAILY_CAP); if (b.allowed) file.daily = b.next; return b.allowed; });
      if (!allowed) return { name: best, notice: `Rename title with AI has made its ${RENAME_DAILY_CAP} suggestions for today. Type a name instead.` };
      const r: JobResult<{ name: string }> = await this.d.jobs.run({ name: "rename", prompt: renamePrompt(inputs, rejected), schema: renameReplySchema, system: RENAME_SYSTEM,
        provider: role.provider, model: role.model ?? undefined, thinking: null, ...(role.provider === "claude" ? { runner: renameRunner() } : {}), timeoutMs: 45_000, maxPromptChars: 8000, maxOutputChars: 8000,
        diagnose: reply => { const checked = checkName(reply.name, { keys, current }); return checked.ok ? null : checked.rule; } });
      if (!r.ok) {
        if (r.reason === "invalid-json" || r.reason === "invalid-shape" || r.reason === "too-large") { rejected = { name: "", reason: "Reply with the one JSON object asked for." }; continue; }
        if (best) return { name: best };
        throw new Error(`Couldn't suggest a name: ${r.error}`);
      }
      const candidate = normalizeSuggestion(r.value.name, keys);
      const check = checkName(candidate, { keys, current });
      if (check.ok) return { name: check.name };
      // Preserve the best model candidate for editing when a fresh name still needs human judgment.
      const score = !candidate ? 0 : check.rule === "unchanged" ? 2 : 1;
      if (score > bestScore) { best = candidate; bestScore = score; }
      rejected = { name: candidate, reason: check.reason };
    }
    return { name: best, ...(!best ? { notice: "Type a name, or suggest another." } : {}) };
  }

  /** Renames (the dialog's Rename, ai_rename's confirm) or undoes the newest rename. Recorded for 24 h either way. */
  async rename(workspaceId: string, input: { title?: string; undo?: boolean }, by: string): Promise<RenameResult> {
    const cur = await this.current(workspaceId);
    const now = this.now();
    if (input.undo) {
      const entry = lastRename(await this.d.store.read(), workspaceId, now);
      const refusal = undoRefusal(entry, cur.title);
      if (refusal) throw new Error(refusal);
      await this.d.titles.set(workspaceId, entry!.from);
      await this.d.store.mutate(file => { file.entries = freshEntries(file.entries, now).filter(e => !(e.workspaceId === workspaceId && e.at === entry!.at && e.to === entry!.to)); });
      return { workspaceId, title: entry!.from ?? cur.name, previous: entry!.to, undone: true };
    }
    if (input.title === undefined) throw new Error("Give the new name, or undo.");
    const keys = renameIssueKeys((await this.d.inputs(workspaceId, cur.shown))?.linked ?? []);
    const check = checkName(input.title, { keys, current: cur.shown });
    if (!check.ok) throw new Error(check.reason);
    await this.d.titles.set(workspaceId, check.name);
    // Recorded after the title is set, so an entry always names a rename that happened; pruned past 24 h on write.
    await this.d.store.mutate(file => { file.entries = [...freshEntries(file.entries, now), { workspaceId, from: cur.title, to: check.name, at: new Date(now).toISOString(), by }].slice(-500); });
    return { workspaceId, title: check.name, previous: cur.shown, undone: false };
  }
}

const empty = (current: string): RenameInputs => ({ current, branch: null, goal: null, summary: null, spec: null, prs: [], linked: [], agents: [] });
