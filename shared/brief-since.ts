import { WEEKDAYS, priorityName, zoned, type QueueChange, type RaisedNeed } from "./linear-queue";

/**
 * The Morning brief's "Since" block and queue screen, as words (docs/morning-brief.md#in-the-brief). Pure: the client
 * draws what these return from `follow.linear-queue`'s view.
 */

type Workspace = { workspaceId: string; title: string } | null;
export type SinceChange = QueueChange & { line: string; workspace: Workspace };

/** Lines the block shows; the rest are in the queue screen. */
export const SINCE_LINES = 5;
/** Keys named in the "left your queue" line before "+N more". */
const LEFT_NAMED = 3;

export type SinceLine = {
  id: string;
  icon: "Plus" | "ArrowUp" | "ArrowDown" | "Calendar" | "CircleDot" | "Check";
  /** Raised to Urgent or High, or new at Urgent or High: the icon is amber. */
  warn: boolean;
  /** Bold: the key and what happened ("ACME-142 raised Low → High"). */
  head: string;
  /** After the head, muted: "due Wed", "+3 new, Low". */
  meta: string | null;
  /** Second line: the title, and who has it ("no workspace yet" or "<workspace> has it"). */
  sub: string | null;
  /** The issue New starts from, when the line carries New's actions (Q9: urgent or raised, no workspace). */
  source: string | null;
  workspace: Workspace;
  url: string | null;
};

const DAY = 86_400_000;
const WEEKDAY_NAME: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/** "Since 09:12" (today), "Since yesterday", "Since Friday" (this week), "Since Nov 12"; null: no point yet. */
export function sinceWords(since: string | null, now: number, timeZone: string): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  const a = zoned(t, timeZone), b = zoned(now, timeZone);
  if (a.day === b.day) return `Since ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
  if (zoned(now - DAY, timeZone).day === a.day) return "Since yesterday";
  if (now - t < 6 * DAY) return `Since ${WEEKDAY_NAME[a.weekday]}`;
  return `Since ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}`;
}

/** A due date (YYYY-MM-DD) as the brief says it: "today", "tomorrow", "Wed" within the week, else "Nov 30". */
export function dueWords(due: string, now: number, timeZone: string): string {
  const today = zoned(now, timeZone).day;
  if (due === today) return "today";
  if (due === zoned(now + DAY, timeZone).day) return "tomorrow";
  const t = Date.parse(`${due}T12:00:00Z`);
  if (Number.isNaN(t)) return due;
  const days = Math.round((t - Date.parse(`${today}T12:00:00Z`)) / DAY);
  if (days > 1 && days < 7) return WEEKDAYS[new Date(t).getUTCDay()]!;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const urgentOrHigh = (p: number) => p === 1 || p === 2;
const lowish = (p: number) => p === 4 || p === 0;

function changeLine(c: SinceChange, now: number, timeZone: string): SinceLine {
  const k = c.kinds;
  const due = c.due ? `due ${dueWords(c.due, now, timeZone)}` : null;
  const has = c.workspace ? `${c.workspace.title} has it` : "no workspace yet";
  let icon: SinceLine["icon"] = "CircleDot", head = `${c.key}`, meta: string | null = null;
  if (k.includes("raised")) { icon = "ArrowUp"; head = `${c.key} raised ${priorityName(c.priorityBefore ?? 0)} → ${priorityName(c.priority)}`; meta = due; }
  else if (k.includes("new")) { icon = "Plus"; head = `${c.key} new, ${priorityName(c.priority)}`; meta = due; }
  else if (k.includes("due")) { icon = "Calendar"; head = c.due ? `${c.key} due ${c.dueBefore ? "moved to" : "set to"} ${dueWords(c.due, now, timeZone)}` : `${c.key} due date removed`; }
  else if (k.includes("lowered")) { icon = "ArrowDown"; head = `${c.key} lowered ${priorityName(c.priorityBefore ?? 0)} → ${priorityName(c.priority)}`; meta = due; }
  else if (k.includes("state")) { icon = "CircleDot"; head = `${c.key} ${c.stateBefore ?? "?"} → ${c.state ?? "?"}`; }
  // A second kind rides along in the meta ("raised … · due moved to Thu").
  if (k.includes("due") && icon !== "Calendar" && c.due && c.dueBefore) meta = `due moved to ${dueWords(c.due, now, timeZone)}`;
  const actionable = !c.workspace && urgentOrHigh(c.priority) && (k.includes("raised") || k.includes("new"));
  return {
    id: c.key, icon, warn: urgentOrHigh(c.priority) && (k.includes("raised") || k.includes("new")), head, meta,
    sub: `${c.title} · ${has}`, source: actionable ? c.key : null, workspace: c.workspace, url: c.url,
  };
}

function leftWords(c: SinceChange): string {
  const l = c.left;
  if (!l) return `${c.key} left`;
  if (l.cause === "reassigned") return `${c.key} reassigned${l.to ? ` to ${l.to}` : ""}`;
  if (l.cause === "moved") return `${c.key} moved to ${l.state ?? "another state"}`;
  if (l.cause === "unknown" || l.cause === "gone") return `${c.key} left`;
  return `${c.key} ${l.cause}`;
}

export type SinceBlock = {
  /** "Since Friday · your Linear queue". */
  title: string;
  lines: SinceLine[];
  /** Changes not drawn (the queue screen's Changed filter has them). */
  more: number;
  /** "47 issues by priority". */
  link: string;
  /** Nothing changed: one muted line instead of lines. */
  empty: string | null;
};

/**
 * The block: at most SINCE_LINES lines, most urgent first across kinds (changesSince's order). New Low and No-priority
 * issues fold into one "+N new, Low" line, and issues that left share one line. An issue in `raised` is a Needs-you item
 * with its own Start… (Q8), so its line here carries no actions: one set of actions per issue on screen.
 */
export function sinceBlock(view: { since: string | null; changes: readonly SinceChange[]; counts: { all: number } }, now: number, timeZone: string, raised: ReadonlySet<string> = new Set()): SinceBlock {
  const words = sinceWords(view.since, now, timeZone);
  const title = words ? `${words} · your Linear queue` : "Your Linear queue";
  const link = `${view.counts.all} issue${view.counts.all === 1 ? "" : "s"} by priority`;
  const staying = view.changes.filter(c => !c.kinds.includes("left"));
  const left = view.changes.filter(c => c.kinds.includes("left"));
  const folded = staying.filter(c => c.kinds.length === 1 && c.kinds[0] === "new" && lowish(c.priority));
  const shown = staying.filter(c => !folded.includes(c));
  const lines: SinceLine[] = [];
  const room = SINCE_LINES - (left.length ? 1 : 0);
  for (const c of shown.slice(0, room)) { const l = changeLine(c, now, timeZone); lines.push(raised.has(c.key) ? { ...l, source: null } : l); }
  let drawn = lines.length;
  if (folded.length) {
    const fold = `+${folded.length} new, ${folded.every(c => c.priority === 0) ? "No priority" : "Low"}`;
    // Its own line: riding on another line's meta ("ACME-163 lowered … · +3 new, Low") read as one issue's doing.
    if (lines.length >= room) { lines.pop(); drawn--; }
    lines.push({ id: "new-low", icon: "Plus", warn: false, head: fold, meta: null, sub: null, source: null, workspace: null, url: null });
  }
  if (left.length) {
    const named = left.slice(0, LEFT_NAMED).map(leftWords).join(", ");
    lines.push({ id: "left", icon: "Check", warn: false, head: `${left.length} left your queue`, meta: `${named}${left.length > LEFT_NAMED ? `, +${left.length - LEFT_NAMED} more` : ""}`, sub: null, source: null, workspace: null, url: null });
  }
  const more = Math.max(0, shown.length - drawn);
  return { title, lines, more, link, empty: view.changes.length ? null : `Nothing moved in your queue ${words ? words.replace(/^Since/, "since") : "yet"}.` };
}

/** One queue row's second line: "Todo · due Wed" (no due when the row's change chip already says the due moved). */
export function queueRowMeta(i: { state: string | null; due: string | null }, now: number, timeZone: string, change?: Pick<QueueChange, "kinds"> | null): string {
  const dueChip = !!change && !change.kinds.some(k => k === "raised" || k === "lowered" || k === "new") && change.kinds.includes("due");
  return [i.state, i.due && !dueChip ? `due ${dueWords(i.due, now, timeZone)}` : null].filter(Boolean).join(" · ");
}

/** A queue row's change chip, short: "Low → High" with its arrow, "New", "Due moved to Thu". */
export function changeChip(c: Pick<QueueChange, "kinds" | "priority" | "priorityBefore" | "due" | "dueBefore"> | null, now: number, timeZone: string): { icon: string | null; text: string; warn: boolean } | null {
  if (!c) return null;
  if (c.kinds.includes("raised")) return { icon: "ArrowUp", text: `${priorityName(c.priorityBefore ?? 0)} → ${priorityName(c.priority)}`, warn: urgentOrHigh(c.priority) };
  if (c.kinds.includes("lowered")) return { icon: "ArrowDown", text: `${priorityName(c.priorityBefore ?? 0)} → ${priorityName(c.priority)}`, warn: false };
  if (c.kinds.includes("new")) return { icon: "Plus", text: "New", warn: false };
  if (c.kinds.includes("due")) return { icon: "Calendar", text: c.due ? `Due ${c.dueBefore ? "moved to" : "set to"} ${dueWords(c.due, now, timeZone)}` : "Due date removed", warn: false };
  if (c.kinds.includes("state")) return { icon: "CircleDot", text: "State changed", warn: false };
  return null;
}

/**
 * Decision Q8's Needs-you row, shaped like Home's rows: the key as title, "Raised" as its word, then "Low → High ·
 * Retry failed charges… · no workspace yet"; `label` says it all at once for a screen reader.
 */
export function raisedRow(r: RaisedNeed, now: number, timeZone: string): { title: string; word: string; line: string; label: string } {
  const change = `${priorityName(r.priorityBefore ?? 0)} → ${priorityName(r.priority)}`;
  const line = [change, r.title, r.due ? `due ${dueWords(r.due, now, timeZone)}` : null, "no workspace yet"].filter(Boolean).join(" · ");
  return { title: r.key, word: "Raised", line, label: `${r.key} raised ${change}. ${line.slice(change.length + 3)}` };
}
