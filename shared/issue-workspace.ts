/**
 * Which workspace already has an issue (invariant a-taken-issue-is-not-a-suggestion): one predicate for every surface
 * that offers to start work from an issue (New's list and its preselection, the dispatch preview and tool, Needs you's
 * raised issues, the brief's Since block). A live (unarchived) workspace has an issue when it links it, or when it
 * tracks a PR whose branch or title names its key. Built once per read as one key → workspace map from state already
 * in hand: no read of its own, no per-issue scan of every PR.
 */

export type IssueHolder = {
  workspaceId: string;
  title: string;
  /** "tracked": Follow-up follows it; "untracked": a live workspace it doesn't. */
  state: "tracked" | "untracked";
  /** How it has the issue: a tracked PR names it (where the work is), or only a link. */
  via: "pr" | "link";
};

export type IssueWorkspaceInput = {
  workspaces: readonly {
    id: string; title: string; archived: boolean; enable_tracking?: boolean;
    /** When it last did something (newest wins a tie between holders of the same kind). */
    activityAt?: string | null;
    prs: readonly { snapshot?: { title?: string; headBranch?: string } | null }[];
  }[];
  /** Workspace id → the Linear keys it links. */
  links: Iterable<readonly [string, readonly string[]]>;
};

/** An issue key's one spelling: Linear keys are case-insensitive (`acme-12` in a branch is ACME-12). */
export const issueKey = (key: string) => key.toUpperCase();

/**
 * Every issue key a branch or PR title names, as a whole token: `acme-12-retry` and "ACME-12: Retry" name ACME-12, and
 * `acme-123` never names ACME-12. A key is letters (then letters or digits), a dash, digits.
 */
export function keysIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![0-9])/g)) out.add(issueKey(m[1]));
  return [...out];
}

/**
 * Key → the workspace that has it. Several have it: one tracking a PR that names it (that's where the work is) over one
 * that only links it, then the most recently active, then the first listed.
 */
export function issueWorkspaces(input: IssueWorkspaceInput): Map<string, IssueHolder> {
  const live = new Map(input.workspaces.filter(w => !w.archived).map(w => [w.id, w]));
  const best = new Map<string, { holder: IssueHolder; at: string }>();
  const offer = (key: string, w: IssueWorkspaceInput["workspaces"][number], via: IssueHolder["via"]) => {
    const at = w.activityAt ?? "";
    const was = best.get(key);
    if (was && (was.holder.via === "pr" && via === "link" || was.holder.via === via && was.at >= at)) return;
    best.set(key, { holder: { workspaceId: w.id, title: w.title, state: w.enable_tracking ? "tracked" : "untracked", via }, at });
  };
  for (const w of live.values()) for (const pr of w.prs) for (const key of new Set([...keysIn(pr.snapshot?.headBranch), ...keysIn(pr.snapshot?.title)])) offer(key, w, "pr");
  for (const [id, keys] of input.links) {
    const w = live.get(id);
    if (w) for (const key of keys) offer(issueKey(key), w, "link");
  }
  return new Map([...best].map(([key, v]) => [key, v.holder]));
}

/** The holder of one key, from a map `issueWorkspaces` built. */
export const holderOf = <T>(map: ReadonlyMap<string, T>, key: string | null | undefined): T | null => key ? map.get(issueKey(key)) ?? null : null;
