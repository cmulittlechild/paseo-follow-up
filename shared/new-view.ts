import { KIND_WORD, UNDO_WINDOW_MS, parseSource, undoable, type DispatchPlan, type DispatchRecord, type DispatchSources, type SourceKind, type SourceRoute } from "./dispatch";
import type { LinearIssue } from "./linear-issues";

/**
 * New's dialog, as pure data (client/new.tsx draws it; tests/new-view.test.ts pins it): the left list (My issues, a
 * pasted source, "Start from your words", "Search all of Linear"), which row is selected and what it sends to the
 * preview, the action bar (↵, ⌥↵, More, or Open it), the four steps of a dispatch in progress and the keys.
 * new-never-switches-the-project-silently: a row whose project is unknown says "which project?", never a guess.
 */

export type RowTone = "plain" | "warn" | "open";
export type NewRow =
  | { kind: "issue"; id: string; key: string; title: string; icon: string; state: string; age: string; route: { text: string; tone: RowTone }; tag: string | null }
  | { kind: "pasted"; id: "pasted"; key: string; title: string; icon: string; sourceKind: SourceKind; raw: string }
  | { kind: "words"; id: "words"; title: string; raw: string }
  | { kind: "search"; id: "search"; query: string };

/** Lucide names for Linear's state types: in progress is the half circle (Contrast). */
export function stateIcon(stateType: string | null): string {
  switch (stateType) {
    case "started": return "Contrast";
    case "unstarted": return "Circle";
    case "backlog": case "triage": return "CircleDashed";
    case "completed": return "CircleCheck";
    case "canceled": return "CircleX";
    default: return "Circle";
  }
}
const KIND_ICON: Record<SourceKind, string> = { linear: "Contrast", issue: "CircleDot", pr: "GitPullRequest", link: "Link", text: "Type" };
export const kindIcon = (kind: SourceKind) => KIND_ICON[kind];

/** Action icons are stored kebab-case (data, shared/dispatch.ts ACTION_ICONS); Lucide's names are Pascal-case. */
export const actionIcon = (icon: string) => icon.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");

/** "now", "5m", "2h", "3d", "4w": the list's age column. */
export function shortAge(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/** A row's "→ project": the project ↵ would use, "which project?" when New would ask, or the live workspace that has it. */
export function routeText(route: SourceRoute | undefined): { text: string; tone: RowTone } {
  if (route?.existing) return { text: `${route.existing.title} · ${route.existing.state === "tracked" ? "running" : "open"}`, tone: "open" };
  if (!route?.project) return { text: "→ which project?", tone: "warn" };
  return { text: `→ ${route.project}`, tone: "plain" };
}

function issueRow(issue: LinearIssue, routes: Record<string, SourceRoute>, now: number, tag: string | null = null): NewRow {
  return { kind: "issue", id: issue.key, key: issue.key, title: issue.title, icon: stateIcon(issue.stateType), state: issue.state ?? "", age: shortAge(issue.updatedAt, now), route: routeText(routes[issue.key]), tag };
}

/** Every word of the query in the key or title (case-insensitive). */
export function matchesQuery(issue: Pick<LinearIssue, "key" | "title">, query: string): boolean {
  const hay = `${issue.key} ${issue.title}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

/**
 * The left list and its default selection for what's in the field.
 * - Empty: My issues, the first preselected (the right pane is never empty while Linear is there).
 * - A Linear key or link that is in the list: that row, tagged "From your link" (no duplicate row).
 * - Any other link or key: a Pasted row on top, selected, then My issues.
 * - Words: the issues they match (the best preselected), "Start from your words" second (so ↵ on a half-typed word never
 *   starts a PR on that word unless nothing matches), then "Search all of Linear for “…”" last.
 */
export function newRows(sources: Pick<DispatchSources, "linear" | "routes"> | null, query: string, now: number): { rows: NewRow[]; selected: string | null } {
  const issues = sources?.linear.issues ?? [];
  const routes = sources?.routes ?? {};
  const q = query.trim();
  // With nothing typed, the first issue that can start (no live workspace of its own) is preselected.
  if (!q) { const rows = issues.map(i => issueRow(i, routes, now)); return { rows, selected: (issues.find(i => !routes[i.key]?.existing) ?? issues[0])?.key ?? null }; }
  const parsed = parseSource(q);
  if (parsed.kind !== "text") {
    const listed = parsed.kind === "linear" ? issues.find(i => i.key === parsed.key) : undefined;
    if (listed) return { rows: issues.map(i => issueRow(i, routes, now, i === listed ? "From your link" : null)), selected: listed.key };
    const pasted: NewRow = { kind: "pasted", id: "pasted", key: parsed.key ?? q, title: parsed.kind === "link" ? q : parsed.key ?? q, icon: kindIcon(parsed.kind), sourceKind: parsed.kind, raw: q };
    return { rows: [pasted, ...issues.map(i => issueRow(i, routes, now))], selected: "pasted" };
  }
  const matches = issues.filter(i => matchesQuery(i, q)).map(i => issueRow(i, routes, now));
  const words: NewRow = { kind: "words", id: "words", title: parsed.title, raw: q };
  const search: NewRow = { kind: "search", id: "search", query: q };
  const rows = matches.length ? [matches[0], words, ...matches.slice(1), search] : [words, search];
  return { rows, selected: rows[0].id };
}

/** What a row sends to the preview (`source`); null for the search row, which runs a search instead. */
export function rowSource(row: NewRow | null | undefined): string | null {
  if (!row) return null;
  switch (row.kind) {
    case "issue": return row.key;
    case "pasted": case "words": return row.raw;
    default: return null;
  }
}

/** ↑/↓ over the rows (the search row is a row too: ↵ on it searches). */
export function moveSelection(rows: readonly NewRow[], selected: string | null, delta: 1 | -1): string | null {
  if (!rows.length) return null;
  const at = rows.findIndex(r => r.id === selected);
  const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta));
  return rows[next].id;
}

// ---------- the action bar ----------

export type BarButton = { id: string; name: string; icon: string; key: "↵" | "⌥↵" | null };
export type Bar =
  | { kind: "actions"; primary: BarButton | null; second: BarButton | null; more: BarButton[]; disabled: string | null }
  /**
   * The source already has a live workspace: Open it is the one filled button (↵); starting another uses the same
   * outlined actions (two, then More) under the same gate as ever: an unresolved project or a blocker disables them.
   */
  | { kind: "existing"; workspaceId: string; title: string; others: BarButton[]; more: BarButton[]; disabled: string | null };

/**
 * The bar for a plan. Its order never changes (the first action is always ↵, the second ⌥↵, the rest under More); an
 * ambiguous project or any blocker disables every action and says why in one line.
 */
export function actionBar(plan: Pick<DispatchPlan, "actions" | "where" | "blockers" | "existing"> | null): Bar {
  const buttons = (plan?.actions ?? []).map((a, i): BarButton => ({ id: a.id, name: a.name, icon: actionIcon(a.icon), key: i === 0 ? "↵" : i === 1 ? "⌥↵" : null }));
  const disabled = !plan ? "Reading…" : plan.where.how === "ambiguous" ? "Pick a project first; the actions start there." : plan.blockers[0] ?? null;
  if (plan?.existing) {
    const others = buttons.map(b => ({ ...b, key: null }));
    return { kind: "existing", workspaceId: plan.existing.workspaceId, title: plan.existing.title, others: others.slice(0, 2), more: others.slice(2), disabled };
  }
  return { kind: "actions", primary: buttons[0] ?? null, second: buttons[1] ?? null, more: buttons.slice(2), disabled };
}

/** The phone bar's line naming what the primary starts: "ACME-142 · acme/web from main · Opus 5.5 bypass". */
export function targetLine(plan: Pick<DispatchPlan, "source" | "where" | "base" | "agent"> & { agentPick?: DispatchPlan["agentPick"] } | null): string {
  if (!plan) return "";
  const what = plan.source.key ?? plan.source.title;
  const where = plan.where.projectName ? `${plan.where.projectName}${plan.base ? ` from ${plan.base.name}` : ""}` : "which project?";
  // The agent and its mode: what starts, and with which permissions, is on screen before the click.
  const mode = plan.agentPick?.picked?.mode;
  return [what, where, plan.agent ? `${plan.agent}${mode ? ` ${mode}` : ""}` : ""].filter(Boolean).join(" · ");
}

/** The source card's first line: "Linear · ACME-142", "GitHub issue · example/app#77", "Your words". */
export function sourceLine(source: Pick<DispatchPlan["source"], "kind" | "key">): string {
  if (source.kind === "text") return "Your words";
  if (source.kind === "linear") return `Linear · ${source.key}`;
  if (source.kind === "link") return "Link";
  return `${source.kind === "pr" ? "Pull request" : "GitHub issue"} · ${source.key}`;
}

// ---------- a dispatch in progress, created or failed ----------

export type StepState = "done" | "active" | "waiting" | "failed" | "skipped";
export type Step = { label: string; state: StepState };

/**
 * The four steps the dialog and Home's row show: the workspace, the agent, its instructions, the link back to the
 * source. A failure marks the step that failed; what it left behind is the record's own line.
 */
export function dispatchSteps(r: Pick<DispatchRecord, "state" | "workspace" | "base" | "prNumber" | "agentLabel" | "source" | "workspaceId" | "leftBehind" | "projectName">): Step[] {
  const first = r.workspace === "local" ? `Open ${r.projectName}` : r.prNumber ? `Check out #${r.prNumber}` : `Create the worktree from ${r.base ?? "main"}`;
  const labels = [first, `Start ${r.agentLabel || "the agent"}`, "Send the instructions", r.source.kind === "text" ? "Track the workspace" : `Link ${r.source.key ?? "the source"}`];
  const at = (n: number): Step[] => labels.map((label, i) => ({ label, state: i < n ? "done" : i === n ? "active" : "waiting" }));
  switch (r.state) {
    case "queued": return labels.map((label, i) => ({ label, state: i === 0 ? "active" : "waiting" }));
    case "creating": return at(0);
    case "starting": return at(1);
    case "created": return labels.map(label => ({ label, state: "done" }));
    case "failed": {
      // The agent step failed when a workspace had been made (archived again or left); else the workspace step.
      const n = r.workspaceId || /archived/.test(r.leftBehind ?? "") ? 1 : 0;
      return labels.map((label, i) => ({ label, state: i < n ? "done" : i === n ? "failed" : "skipped" }));
    }
    default: return labels.map(label => ({ label, state: "skipped" }));
  }
}

/**
 * What fixes a failed dispatch: the agent step failed (a workspace had been made) → change the agent; a new worktree
 * failed → change its base. Anything else (a checkout, the project folder, Paseo down) has no field to change: Try
 * again is the remedy.
 */
export function failureRemedy(r: Pick<DispatchRecord, "state" | "workspace" | "prNumber" | "workspaceId" | "leftBehind">): { field: "agent" | "base"; label: string } | null {
  if (r.state !== "failed") return null;
  if (r.workspaceId || /archived/.test(r.leftBehind ?? "")) return { field: "agent", label: "Change agent" };
  if (r.workspace === "worktree" && !r.prNumber) return { field: "base", label: "Change base" };
  return null;
}

/** Home's row and the toast for a record: its one line, and whether Undo is still offered. */
export function recordLine(r: DispatchRecord, now: number): { title: string; line: string; tone: "busy" | "done" | "failed" | "quiet"; undo: boolean; minutesLeft: number } {
  const undo = undoable(r, now);
  const minutesLeft = undo ? Math.min(UNDO_WINDOW_MS / 60_000, Math.max(1, Math.ceil((Date.parse(r.undoUntil!) - now) / 60_000))) : 0;
  const where = `${r.actionName} · ${r.projectName}`;
  switch (r.state) {
    case "queued": return { title: r.title, line: r.error ? `${where} · waiting for Paseo` : `${where} · starting`, tone: "busy", undo: false, minutesLeft };
    case "creating": case "starting": return { title: r.title, line: `${where} · ${r.step ?? "starting"}`, tone: "busy", undo: false, minutesLeft };
    case "created": return { title: r.title, line: undo ? `${where} · started · Undo for ${minutesLeft} min` : `${where} · started`, tone: "done", undo, minutesLeft };
    case "failed": return { title: r.title, line: `Didn't start: ${r.error ?? "unknown error"} · ${where}`, tone: "failed", undo: false, minutesLeft };
    case "undone": return { title: r.title, line: `${where} · undone, archived`, tone: "quiet", undo: false, minutesLeft };
    default: return { title: r.title, line: `${where} · cancelled`, tone: "quiet", undo: false, minutesLeft };
  }
}

/** Records Home shows: in progress, failed in the last hour, or still undoable. Newest first, at most 3. */
export function homeRecords(records: readonly DispatchRecord[], now: number): DispatchRecord[] {
  return records.filter(r => r.state === "queued" || r.state === "creating" || r.state === "starting"
    || (r.state === "failed" && now - Date.parse(r.at) < 60 * 60_000)
    || undoable(r, now)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
}
export const UNDO_MINUTES = UNDO_WINDOW_MS / 60_000;

// ---------- keys (desktop web) ----------

export type NewKey = "up" | "down" | "primary" | "second" | "search" | "instructions" | "close" | "open" | "undo";
type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean; isComposing?: boolean };

/**
 * New's keys. ↵ starts the first action (⌥↵ the second, ⇧↵ searches all of Linear), ↑↓ move the list from the field,
 * ⌘I shows the instructions, Esc closes; once created, ⌘↵ opens the workspace and ⌘Z undoes. Inside the note or an
 * edit field (`editing`) only Esc and ⌘-chords count, so Enter types and arrows move the caret.
 */
export function newKey(e: KeyLike, mac: boolean, o: { editing: boolean; created: boolean }): NewKey | null {
  if (e.isComposing) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (e.key === "Escape") return "close";
  if (o.created) {
    if (mod && e.key === "Enter") return "open";
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) return "undo";
    return null;
  }
  if (mod && e.key.toLowerCase() === "i") return "instructions";
  if (o.editing || e.repeat && e.key === "Enter") return null;
  if (e.key === "ArrowDown" && !mod) return "down";
  if (e.key === "ArrowUp" && !mod) return "up";
  if (e.key === "Enter" && !mod && !e.metaKey && !e.ctrlKey) return e.altKey ? "second" : e.shiftKey ? "search" : "primary";
  return null;
}

/** The KIND_WORD for a source, for screen-reader labels. */
export const kindWord = (kind: SourceKind) => KIND_WORD[kind];

/**
 * The "which project" note: a heading, then the reason without the heading's question (resolveWhere's reasons start
 * with it, for agents reading a dry run), then where a team's pick is saved, said once.
 */
export function ambiguousNote(team: string | null | undefined, reason: string | null | undefined): { ask: string; note: string } {
  const ask = team ? `Which project for ${team}?` : "Which project?";
  let said = (reason ?? "").trim();
  for (const q of [ask, "Which project?"]) if (said.startsWith(q)) said = said.slice(q.length).trim();
  if (!team) return { ask, note: said };
  const where = "Change it in Settings → New work.";
  return { ask, note: /saved for /.test(said) ? `${said} ${where}` : [said, `Your pick is saved for ${team}.`, where].filter(Boolean).join(" ") };
}
