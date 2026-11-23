import { z } from "zod";
import { linearKey, teamOf } from "./linked";

/**
 * One Linear issue as every Follow-up surface reads it (New's list, a pasted key, later the Morning brief's sweep).
 * Parsed from `linear:list_issues` / `linear:get_issue` replies (mcpproxy), never built from anything else.
 *
 * `id` is Linear's uuid when the reply carries one, else the key. `team` is the team key (the key's prefix: what rules
 * and learned routing are keyed by); `teamName` is Linear's display name. `assigneeIsMe` is true for a list read with
 * `assignee: "me"`, null when the read can't tell.
 */
export const linearIssueSchema = z.object({
  id: z.string().min(1).max(200),
  key: z.string().min(1).max(30),
  title: z.string().max(500),
  state: z.string().max(100).nullable(),
  stateType: z.string().max(40).nullable(),
  priority: z.object({ value: z.number().int().min(0).max(4), name: z.string().max(40) }).nullable(),
  updatedAt: z.string().max(40).nullable(),
  team: z.string().max(30),
  teamName: z.string().max(200).nullable(),
  url: z.string().max(2000).nullable(),
  assigneeIsMe: z.boolean().nullable(),
  branchName: z.string().max(200).nullable(),
  /** Only a single-issue read asks for the description (a list doesn't: mcpproxy caps a reply near 20 k characters). */
  description: z.string().nullable(),
  /** The Morning brief's sweep asks for these too (QUEUE_FIELDS); New's list doesn't. */
  due: z.string().max(40).nullable().default(null),
  project: z.string().max(200).nullable().default(null),
  milestone: z.string().max(200).nullable().default(null),
  /** The assignee's display name, when the read asked for it (a lookup of an issue that left the queue). */
  assignee: z.string().max(200).nullable().default(null),
  /** The assignee's Linear user id, when the read asked for it: compared with the viewer's to tell "still mine". */
  assigneeId: z.string().max(100).nullable().default(null),
  /** When the issue was opened, and who opened it (display name, Linear user id): the sweep asks (QUEUE_FIELDS). */
  createdAt: z.string().max(40).nullable().default(null),
  creator: z.string().max(200).nullable().default(null),
  creatorId: z.string().max(100).nullable().default(null),
});
export type LinearIssue = z.infer<typeof linearIssueSchema>;

/** Fields a list read asks for: small enough that a page of 25 stays under mcpproxy's reply cap. */
export const LIST_FIELDS = ["id", "uuid", "title", "url", "gitBranchName", "status", "statusType", "team", "updatedAt", "priority"] as const;
/** Fields a single-issue read asks for. */
export const ISSUE_FIELDS = [...LIST_FIELDS, "description", "assignee"] as const;
/** Fields the Morning brief's sweep asks for: New's, plus what the brief and the ranker show (due, project, milestone, who opened it and when). */
export const QUEUE_FIELDS = ["id", "uuid", "title", "url", "status", "statusType", "team", "updatedAt", "priority", "dueDate", "project", "projectMilestone", "createdAt", "createdBy", "createdById"] as const;
/**
 * Fields the sweep's lookup of an issue that left the queue asks for: enough to say why, and (the queue's fields plus
 * `assigneeId`) to put it back when it never left: still the developer's, in a queue state, missed by the walk.
 */
export const LEFT_FIELDS = [...QUEUE_FIELDS, "assignee", "assigneeId"] as const;
/** Issues per list_issues page (60 at once came back cut off; server/ranker.ts). Not a cap on how many are read. */
/** One read of the developer's list: the issues, or why there are none ("missing": Linear isn't connected). */
export type LinearList = { status: "ok"; issues: LinearIssue[]; at: number; more: boolean } | { status: "missing" | "error"; issues: []; at: number; error: string; more: false };
export const PAGE_SIZE = 25;
/** Open work: what New lists before anything is typed. */
export const OPEN_STATE_TYPES = ["started", "unstarted"] as const;

const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const clip = (v: string | null, n: number) => v === null ? null : v.slice(0, n);
const idOf = (v: unknown): string | null => typeof v === "object" && v ? str((v as { id?: unknown }).id) : null;
const named = (v: unknown): string | null => typeof v === "object" && v ? str((v as { name?: unknown }).name) : str(v);

/** One issue object from a reply, or null when it has no key-shaped identifier or no title. */
export function toLinearIssue(raw: unknown, assigneeIsMe: boolean | null = null): LinearIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const i = raw as Record<string, unknown>;
  const key = linearKey(str(i.identifier) ?? str(i.id) ?? "");
  const title = str(i.title);
  if (!key || !title) return null;
  const p = i.priority as { value?: unknown; name?: unknown } | number | null | undefined;
  const value = typeof p === "number" ? p : typeof p?.value === "number" ? p.value : null;
  const priority = value !== null && Number.isInteger(value) && value >= 0 && value <= 4 ? { value, name: clip((typeof p === "object" && p ? str(p.name) : null) ?? PRIORITY_NAMES[value], 40)! } : null;
  const uuid = str(i.uuid);
  return linearIssueSchema.parse({
    id: uuid ?? key, key, title: title.slice(0, 500),
    state: clip(named(i.status) ?? named(i.state), 100), stateType: clip(str(i.statusType), 40),
    priority, updatedAt: clip(str(i.updatedAt), 40), team: teamOf(key), teamName: clip(named(i.team), 200),
    url: clip(str(i.url), 2000), assigneeIsMe, branchName: clip(str(i.gitBranchName), 200),
    description: typeof i.description === "string" ? i.description : null,
    // Clipped, never refused: an issue a schema bound would drop is an issue missing from the queue (the-queue-is-whole).
    due: str(i.dueDate)?.slice(0, 40) ?? null, project: clip(named(i.project), 200), milestone: clip(named(i.projectMilestone), 200), assignee: clip(named(i.assignee), 200),
    assigneeId: clip(str(i.assigneeId) ?? idOf(i.assignee), 100),
    createdAt: clip(str(i.createdAt), 40), creator: clip(named(i.createdBy) ?? named(i.creator), 200),
    creatorId: clip(str(i.createdById) ?? idOf(i.createdBy) ?? idOf(i.creator), 100),
  });
}
export const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

/**
 * The complete objects of a JSON array that was cut off (mcpproxy truncates replies near 20 k characters and appends
 * a note, which leaves invalid JSON): every whole `{…}` element after `"key":[`, up to the cut.
 */
export function salvageArray(text: string, key: string): unknown[] {
  const at = text.indexOf(`"${key}":[`);
  if (at < 0) return [];
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = at + key.length + 4; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}") { if (--depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
    else if (ch === "]" && depth === 0) break;
  }
  return out;
}

/**
 * A `list_issues` page: `{issues, hasNextPage, cursor}`. A truncated reply keeps its whole issues and ends the walk;
 * `whole` is false then, so a reader that must see every page (the Morning brief's sweep) knows it didn't.
 */
export function parseIssuePage(text: string, assigneeIsMe: boolean | null = null): { issues: LinearIssue[]; next: string | null; readable: boolean; whole: boolean } {
  let j: { issues?: unknown[]; hasNextPage?: unknown; cursor?: unknown } | null = null;
  try { j = JSON.parse(text); } catch { /* truncated: salvage below */ }
  const raw = Array.isArray(j?.issues) ? j!.issues : salvageArray(text, "issues");
  const issues = raw.flatMap(r => { try { const x = toLinearIssue(r, assigneeIsMe); return x ? [x] : []; } catch { return []; } });
  return { issues, next: j && j.hasNextPage === true && typeof j.cursor === "string" ? j.cursor : null, readable: Array.isArray(j?.issues) || raw.length > 0, whole: Array.isArray(j?.issues) };
}

/** A `get_issue` reply: the issue, null when Linear says it doesn't exist; throws when the reply can't be read. */
export function parseIssue(text: string): LinearIssue | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch {
    if (/not found|no issue|could not find|entity not found/i.test(text)) return null;
    throw new Error("Linear returned an unreadable issue.");
  }
  const raw = (j && typeof j === "object" && "issue" in (j as object)) ? (j as { issue: unknown }).issue : j;
  return toLinearIssue(raw);
}

/** The viewer's Linear user id from `get_user {query: "me"}` (its top-level `id`), or null when the reply has none. */
export function parseViewerId(text: string): string | null {
  try {
    const j = JSON.parse(text) as { id?: unknown; user?: { id?: unknown } };
    return clip(str(j?.id) ?? str(j?.user?.id), 100);
  } catch { return null; }
}

/** Open (started or unstarted) issues first, then by update time, newest first. */
export function openIssues(issues: readonly LinearIssue[]): LinearIssue[] {
  return issues.filter(i => !i.stateType || (OPEN_STATE_TYPES as readonly string[]).includes(i.stateType))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
