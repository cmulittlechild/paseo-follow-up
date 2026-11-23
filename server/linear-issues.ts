import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mcpproxyText } from "./about";
import { ISSUE_FIELDS, LEFT_FIELDS, LIST_FIELDS, PAGE_SIZE, QUEUE_FIELDS, openIssues, parseIssue, parseIssuePage, parseViewerId, type LinearIssue } from "../shared/linear-issues";

const exec = promisify(execFile);
export type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
const runFile: Run = async (command, args, timeout) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;

/** How long a list read is reused, shared by every reader (concurrent-readers-share-one-request). */
export const LIST_TTL_MS = 60_000;
/** One mcpproxy call's bound. */
export const CALL_TIMEOUT_MS = 8_000;
/** One sweep call's bound: the sweep runs in the background, so a slow Linear gets longer than New's open does. */
export const SWEEP_CALL_TIMEOUT_MS = 20_000;
/** Pages one list read may walk (PAGE_SIZE each): a bound on a runaway cursor, not a cap New chose. */
export const PAGES_MAX = 40;
/** Pages read per PAGE_SIZE open issues wanted, at most (closed issues in between take room). */
export const OPEN_PAGES_PER_LIMIT = 3;

import type { LinearList } from "../shared/linear-issues";
export type { LinearList };

/** "Linear isn't connected": mcpproxy isn't installed, or it has no Linear server or tool. Anything else is a read error. */
export function linearMissing(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; stderr?: unknown };
  if (e?.code === "ENOENT") return true;
  const text = `${typeof e?.message === "string" ? e.message : ""} ${typeof e?.stderr === "string" ? e.stderr : ""}`;
  return /(unknown|no such|not found)[^.\n]{0,40}(server|tool)|server[^.\n]{0,20}not (found|connected|configured)|tool[^.\n]{0,20}not found/i.test(text);
}

/**
 * Linear issues for New (and, later, the Morning brief's sweep): read through mcpproxy like the Summary, never on a
 * timer. `list` is the developer's open issues (assigned to them), every page up to `limit`, cached LIST_TTL_MS and
 * shared by concurrent callers; nothing runs until someone asks (`new-reads-nothing-while-closed`). `get` is one issue
 * with its description, for a paste.
 */
export class LinearIssues {
  private cached: { at: number; value: Promise<LinearList>; limit: number } | null = null;
  /** mcpproxy calls made, for tests and the scale check. */
  calls = 0;
  constructor(private run: Run = runFile, private now: () => number = Date.now) {}

  private async call(tool: string, args: unknown, reason: string, timeoutMs = CALL_TIMEOUT_MS): Promise<string> {
    this.calls++;
    return mcpproxyText(await this.run("mcpproxy", ["call", "tool-read", `--tool-name=linear:${tool}`, `--json_args=${JSON.stringify(args)}`, `--reason=Follow-up: ${reason}`, "--log-level=error", "-o", "json"], timeoutMs));
  }

  /**
   * One page of the Morning brief's sweep: the developer's issues in one state type, with the brief's fields. `whole`
   * false: the reply was cut off (mcpproxy truncates near 20 k characters), so the walk can't trust its end.
   */
  async queuePage(state: string, cursor: string | null, limit = PAGE_SIZE): Promise<ReturnType<typeof parseIssuePage>> {
    // By creation time, never update time: an issue updated mid-walk (raised, the very event the brief is for) would
    // jump to a page already read and be missed. Creation order doesn't move.
    const text = await this.call("list_issues", { assignee: "me", state, orderBy: "createdAt", limit, fields: QUEUE_FIELDS, ...(cursor ? { cursor } : {}) }, "the Morning brief's sweep of your Linear queue", SWEEP_CALL_TIMEOUT_MS);
    return parseIssuePage(text, true);
  }
  /** Why an issue left the queue: its state and assignee now. Null when Linear says it doesn't exist. */
  async leftIssue(key: string): Promise<LinearIssue | null> {
    return parseIssue(await this.call("get_issue", { id: key, fields: LEFT_FIELDS }, "why an issue left your Linear queue", SWEEP_CALL_TIMEOUT_MS));
  }

  /** The developer's Linear user id (`get_user {query: "me"}`, read-only); the sweep caches it in linear-queue.json. */
  async viewerId(): Promise<string | null> {
    return parseViewerId(await this.call("get_user", { query: "me" }, "who you are in Linear, to tell your issues from others'", SWEEP_CALL_TIMEOUT_MS));
  }

  /** The developer's open issues, newest update first. `fresh` skips the cache (Retry). */
  list(o: { limit?: number; fresh?: boolean } = {}): Promise<LinearList> {
    const limit = o.limit ?? PAGE_SIZE;
    const c = this.cached;
    if (c && !o.fresh && c.limit >= limit && this.now() - c.at < LIST_TTL_MS) return c.value;
    const at = this.now();
    const value = this.readList(limit, at);
    this.cached = { at, value, limit };
    // A failure is reused only while it's in flight: the next open tries again.
    void value.then(v => { if (v.status !== "ok" && this.cached?.value === value) this.cached = null; });
    return value;
  }
  private async readList(limit: number, at: number): Promise<LinearList> {
    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    try {
      // Done and cancelled issues are skipped, so a page may add fewer open ones than it read: walk on until `limit`
      // open issues, at most OPEN_PAGES_PER_LIMIT pages per page wanted (and PAGES_MAX in all).
      const pages = Math.min(PAGES_MAX, Math.ceil(limit / PAGE_SIZE) * OPEN_PAGES_PER_LIMIT);
      for (let page = 0; page < pages && openIssues(issues).length < limit; page++) {
        const r = parseIssuePage(await this.call("list_issues", { assignee: "me", orderBy: "updatedAt", limit: PAGE_SIZE, fields: LIST_FIELDS, ...(cursor ? { cursor } : {}) }, "your Linear issues for New"), true);
        if (!r.readable && page === 0) throw new Error("Linear's reply couldn't be read.");
        issues.push(...r.issues);
        cursor = r.next;
        if (!cursor) break;
      }
      return { status: "ok", issues: openIssues(issues).slice(0, limit), at, more: !!cursor };
    } catch (error) {
      return { status: linearMissing(error) ? "missing" : "error", issues: [], at, error: readError(error), more: false };
    }
  }
  /** Search all of Linear for the developer's words (an explicit press, never on typing). */
  async search(query: string, limit = PAGE_SIZE): Promise<LinearList> {
    const at = this.now();
    try {
      const r = parseIssuePage(await this.call("list_issues", { query: query.slice(0, 200), orderBy: "updatedAt", limit: Math.min(limit, PAGE_SIZE), fields: LIST_FIELDS }, "search Linear for New"), null);
      return { status: "ok", issues: r.issues, at, more: !!r.next };
    } catch (error) {
      return { status: linearMissing(error) ? "missing" : "error", issues: [], at, error: readError(error), more: false };
    }
  }
  /** One issue with its description; null when Linear says there's no such issue. Throws when it couldn't be read. */
  async get(key: string): Promise<LinearIssue | null> {
    return parseIssue(await this.call("get_issue", { id: key, fields: ISSUE_FIELDS }, "the issue pasted into New"));
  }
}

/** A read error in one line, never a path, token or stack. */
export function readError(error: unknown): string {
  const e = error as { killed?: unknown; signal?: unknown; message?: unknown };
  if (e?.killed || e?.signal === "SIGTERM") return "Linear didn't answer in time.";
  const message = typeof e?.message === "string" ? e.message.split("\n")[0] : String(error);
  return /^Command failed/i.test(message) ? "Linear couldn't be read." : message.slice(0, 200);
}
