import { HAND_LABEL, HAND_SOURCE, effectiveStrength, noteWho, type CompassNote, type CompassSettings, type CompassSource } from "./compass";
import { dueWords } from "./brief-since";
import { isWorkday, priorityName, zoned, type Clock, type RaisedNeed } from "./linear-queue";

/**
 * "Nobody's on it" (invariant nobody-s-on-it-is-needs-you, amended 86): a raised Linear issue and an urgent Compass ask
 * about an issue with no workspace are the same thing, work that matters that nobody started. One row kind in Needs
 * you, one Start…, one Remove, one count. Everything else Compass says about an issue nobody started sorts first in
 * New's My issues with its reason. Pure: the worker computes both from state it already holds, and every surface reads
 * the answer.
 */

const DAY = 86_400_000;
const RANK = { high: 0, normal: 1, low: 2 } as const;

/** A Compass note about an issue nobody has started, as New, the brief and Needs you show it. */
export type Suggestion = {
  /** The note behind it (the soonest, strongest one on that issue); `dismiss_item {compass}` removes it by this id. */
  note: string;
  key: string;
  /** The issue's own title when the queue knows it, else what the note says. */
  title: string;
  url: string | null;
  /** "Dana: renewal call Thu": who said what, and its date. */
  reason: string;
  /** The source's label ("Dana · product"), for "· Compass" lines and why_suggested. */
  source: string;
  until: string | null;
  /** Urgent (routing): it goes to Needs you as a "Nobody's on it" row; else it sorts first in My issues. */
  urgent: boolean;
  at: string;
  /** New's `{why}`: the quote, who and when, and the date, as plain text (an-action-is-data). */
  why: string;
};

/** Workdays from today (0) to `until`, in the developer's zone; past is negative. */
export function workdaysUntil(until: string, now: number, clock: Clock): number {
  const today = zoned(now, clock.timeZone).day;
  if (until <= today) return until === today ? 0 : -1;
  let n = 0;
  for (let t = Date.parse(`${today}T12:00:00Z`) + DAY; ; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isWorkday(t, { ...clock, timeZone: "UTC" })) n++;
    if (d >= until || n > 60) return n;
  }
}

/** "Thu", "tomorrow", "Nov 30": a note's date as a line says it. */
const untilWord = (until: string, now: number, clock: Clock) => dueWords(until, now, clock.timeZone);

/** "Dana: renewal call Thu": who said what, with the date when the words don't already carry it. */
export function suggestionReason(n: Pick<CompassNote, "by" | "what" | "until">, now: number, clock: Clock): string {
  const date = n.until ? untilWord(n.until, now, clock) : null;
  const what = date && !n.what.toLowerCase().includes(date.toLowerCase()) ? `${n.what} ${date}` : n.what;
  return `${noteWho(n)}: ${what}`;
}

/** `{why}`: someone else's words, quoted, with who said them and when (never the model's paraphrase alone). */
export function whyText(n: Pick<CompassNote, "by" | "what" | "quote" | "until" | "at">, source: string): string {
  const who = typeof n.by === "object" ? n.by.name : source;
  const said = n.quote ? `${who} (${source}), ${n.at.slice(0, 16).replace("T", " ")} UTC: "${n.quote}"` : `${source}: ${n.what}`;
  return [`Why this matters, from Compass: ${said}`, n.until ? `Until ${n.until}.` : null].filter(Boolean).join("\n");
}

/**
 * Compass's suggestions: live notes about an issue (`match.issue`) that has no workspace (`taken`, invariant 95's one
 * predicate), not removed by the developer, one per issue (its soonest, then strongest note). Urgent when routing sends
 * suggestions to Needs you, the source has its Needs-you switch on, the effective strength reaches
 * `routing.urgentStrength`, and the note's date is within `routing.urgentWithinWorkdays` workdays. `off`: none at all.
 */
export function suggestions(notes: readonly CompassNote[], settings: Pick<CompassSettings, "sources" | "routing" | "expiry">, ctx: {
  now: number; clock: Clock; taken: (key: string) => boolean; removed: ReadonlySet<string>;
  issue?: (key: string) => { title: string; url: string | null } | null;
}): Suggestion[] {
  if (settings.routing.suggestions === "off") return [];
  const sources = new Map<string, Pick<CompassSource, "label" | "enable_needs_you" | "enabled">>(settings.sources.map(s => [s.id, s]));
  const strong = (n: CompassNote) => { const s = effectiveStrength(n, ctx.now, settings.expiry); return settings.routing.urgentStrength === "high" ? s === "high" : s !== "low"; };
  const best = new Map<string, CompassNote>();
  for (const n of notes) {
    const key = n.match.issue?.toUpperCase();
    if (n.state !== "live" || !key || n.match.workspace || ctx.removed.has(n.id) || ctx.taken(key)) continue;
    if (n.source !== HAND_SOURCE && !sources.get(n.source)?.enabled) continue;
    const was = best.get(key);
    const order = (x: CompassNote) => [x.until ?? "9999", RANK[effectiveStrength(x, ctx.now, settings.expiry)]] as const;
    if (!was || order(n)[0] < order(was)[0] || (order(n)[0] === order(was)[0] && order(n)[1] < order(was)[1])) best.set(key, n);
  }
  const out: Suggestion[] = [];
  for (const [key, n] of best) {
    const src = sources.get(n.source);
    const label = n.source === HAND_SOURCE ? HAND_LABEL : src!.label;
    const soon = !!n.until && workdaysUntil(n.until, ctx.now, ctx.clock) <= settings.routing.urgentWithinWorkdays;
    const urgent = settings.routing.suggestions === "needs-you-and-new" && !!src?.enable_needs_you && strong(n) && soon;
    const known = ctx.issue?.(key) ?? null;
    out.push({ note: n.id, key, title: known?.title ?? n.what, url: known?.url ?? null, reason: suggestionReason(n, ctx.now, ctx.clock), source: label, until: n.until, urgent, at: n.at, why: whyText(n, label) });
  }
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.until ?? "9999").localeCompare(b.until ?? "9999") || b.at.localeCompare(a.at));
}

/** Where a "Nobody's on it" row's reason comes from: the queue's raise, or a Compass source. */
export type NobodyReason = { from: "queue" | "compass"; line: string; source: string; note: string | null };

/** One "Nobody's on it" row: an issue with no workspace that matters now, and every reason it does. */
export type NobodyNeed = {
  key: string; title: string; url: string | null;
  /** The issue's due date (the queue's), or the Compass note's date: "due Thu". */
  due: string | null;
  /** A raise to Urgent or High: "raised to Urgent" (with the queue's reason line "Raised Low → Urgent"). */
  raisedTo: number | null;
  at: string;
  /** The first reason heads the row; the rest ride its screen-reader label and why_suggested. */
  reasons: NobodyReason[];
};

export const QUEUE_SOURCE = "Linear queue";

/** The queue's raises and Compass's urgent asks as one list, one row per issue: raised first (newest first), then Compass's by date. */
export function nobodyNeeds(raised: readonly RaisedNeed[], urgent: readonly Suggestion[]): NobodyNeed[] {
  const out = new Map<string, NobodyNeed>();
  for (const r of [...raised].sort((a, b) => b.at.localeCompare(a.at))) {
    out.set(r.key.toUpperCase(), { key: r.key, title: r.title, url: r.url, due: r.due, raisedTo: r.priority, at: r.at,
      reasons: [{ from: "queue", line: `Raised ${priorityName(r.priorityBefore ?? 0)} → ${priorityName(r.priority)}`, source: QUEUE_SOURCE, note: null }] });
  }
  for (const s of urgent.filter(s => s.urgent)) {
    const reason: NobodyReason = { from: "compass", line: s.reason, source: s.source, note: s.note };
    const was = out.get(s.key);
    if (was) { was.reasons.push(reason); was.due ??= s.until; continue; }
    out.set(s.key, { key: s.key, title: s.title, url: s.url, due: s.until, raisedTo: null, at: s.at, reasons: [reason] });
  }
  return [...out.values()];
}

/**
 * The row as words, shaped like Home's rows: the key as title, "Nobody's on it" as its word, then "title · due Thu" (or
 * "· raised to Urgent"), and the reason with its source ("Dana: renewal call Thu · Compass", "Raised Low → Urgent ·
 * Linear queue"). `label` says it all at once for a screen reader, every reason included.
 */
export function nobodyRow(n: NobodyNeed, now: number, timeZone: string): { title: string; word: string; line: string; reason: string; compass: boolean; label: string } {
  const line = [n.title, n.due ? `due ${dueWords(n.due, now, timeZone)}` : n.raisedTo ? `raised to ${priorityName(n.raisedTo)}` : null].filter(Boolean).join(" · ");
  const first = n.reasons[0]!;
  const reason = `${first.line} · ${first.from === "compass" ? "Compass" : first.source}`;
  const all = n.reasons.map(r => `${r.line}, from ${r.from === "compass" ? `Compass, ${r.source}` : r.source}`).join("; ");
  return { title: n.key, word: "Nobody's on it", line, reason, compass: first.from === "compass", label: `${n.key}, nobody's on it. ${line}. ${all}.` };
}

// ---------- the brief's one Since block: what Compass heard ----------

/** One Compass line in the brief's Since block, shaped like the queue's (shared/brief-since.ts SinceLine). */
export type CompassSinceLine = {
  id: string;
  kind: "heard" | "needs" | "suggestion" | "dropped" | "unplaced" | "failed";
  /** Bold: "Dana on Invoice export", "ACME-18 · in Needs you", "Dana dropped Okta SSO". */
  head: string;
  /** Muted, after the head: "until Tue", "+2 more". */
  meta: string | null;
  /** Second line: the quote (clipped), or the reason. */
  sub: string | null;
  /** A suggestion's issue: the line carries Start… (only when it isn't in Needs you: one issue, one set of actions). */
  source: string | null;
  workspace: { workspaceId: string; title: string } | null;
  url: string | null;
};

export type CompassSince = {
  /** Who Compass heard from since, first said first: "Dana", for "Since Friday · Dana, your Linear queue". */
  from: string[];
  lines: CompassSinceLine[];
  /** How many people's notes are new since: Home's brief row says "1 from Dana". */
  heard: number;
};

/** Lines per kind, so the block stays one glance (the queue screen and Settings hold the rest). */
const HEARD_MAX = 3, SUGGEST_MAX = 2;
const clip = (s: string | null, n: number) => !s ? null : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/**
 * Compass's part of the one Since block (design §8), in the order the developer should look: workspaces Compass heard
 * about (at most 3), what went to Needs you (named once, "in Needs you", no second set of actions: invariant 86's
 * rule), other suggestions (at most 2, with Start…), notes dropped, "N notes aren't on any workspace", and a failed
 * read. `since` is the brief's own stored point; null: nothing since (a first open says nothing).
 */
export function compassSince(notes: readonly CompassNote[], input: {
  settings: Pick<CompassSettings, "sources" | "expiry">; since: string | null; now: number; clock: Clock;
  suggestions: readonly Suggestion[]; titles: ReadonlyMap<string, string>;
  lastRead: { at: string; ok: boolean; error: string | null } | null;
}): CompassSince {
  const out: CompassSinceLine[] = [];
  const after = (t: string | null | undefined) => !!t && !!input.since && t > input.since;
  const fresh = notes.filter(n => n.state === "live" && n.source !== HAND_SOURCE && after(n.at)).sort((a, b) => a.at.localeCompare(b.at));
  const from = [...new Set(fresh.map(n => noteWho(n)))];
  const when = (u: string | null) => u ? `until ${untilWord(u, input.now, input.clock)}` : null;
  const onWorkspace = fresh.filter(n => n.match.workspace);
  const byWs = new Map<string, CompassNote[]>();
  for (const n of onWorkspace) byWs.set(n.match.workspace!, [...byWs.get(n.match.workspace!) ?? [], n]);
  for (const [ws, list] of [...byWs].slice(0, HEARD_MAX)) {
    const n = list[list.length - 1]!;
    const title = input.titles.get(ws) ?? "a workspace";
    out.push({ id: `c:heard:${ws}`, kind: "heard", head: `${noteWho(n)} on ${title}`, meta: [when(n.until), list.length > 1 ? `+${list.length - 1} more` : null].filter(Boolean).join(" · ") || null,
      sub: clip(n.quote ? `“${n.quote}”` : n.what, 140), source: null, workspace: { workspaceId: ws, title }, url: n.link });
  }
  const freshSuggest = input.suggestions.filter(s => after(s.at));
  for (const s of freshSuggest.filter(s => s.urgent)) out.push({ id: `c:needs:${s.key}`, kind: "needs", head: `${s.key} · in Needs you`, meta: null, sub: `${s.title} · ${s.reason}`, source: null, workspace: null, url: s.url });
  for (const s of freshSuggest.filter(s => !s.urgent).slice(0, SUGGEST_MAX)) out.push({ id: `c:suggest:${s.key}`, kind: "suggestion", head: `${s.key} · nobody's on it`, meta: when(s.until), sub: `${s.title} · ${s.reason}`, source: s.key, workspace: null, url: s.url });
  for (const n of notes.filter(n => n.state === "retracted" && after(n.endedAt))) out.push({ id: `c:dropped:${n.id}`, kind: "dropped", head: `${noteWho(n)} dropped ${n.what}`, meta: null, sub: null, source: null, workspace: null, url: n.link });
  const unplaced = notes.filter(n => n.state === "live" && !n.match.workspace && !n.match.issue).length;
  if (unplaced) out.push({ id: "c:unplaced", kind: "unplaced", head: unplaced === 1 ? "1 note isn't on any workspace" : `${unplaced} notes aren't on any workspace`, meta: null, sub: "Pin it to a workspace in Settings → Compass, or start one from its words.", source: null, workspace: null, url: null });
  if (input.lastRead && !input.lastRead.ok && input.lastRead.error) out.push({ id: "c:failed", kind: "failed", head: "Compass couldn't read", meta: null, sub: input.lastRead.error, source: null, workspace: null, url: null });
  return { from, lines: out, heard: from.length };
}

/** "1 from Dana", "3 from Dana and Lee": Home's brief row when Compass heard anything since. */
export function heardWords(s: Pick<CompassSince, "from" | "lines">): string | null {
  const n = s.lines.filter(l => l.kind === "heard" || l.kind === "needs" || l.kind === "suggestion").length;
  if (!n || !s.from.length) return null;
  const names = s.from.length > 2 ? `${s.from[0]} and ${s.from.length - 1} others` : s.from.join(" and ");
  return `${n} from ${names}`;
}

// ---------- the Overseer's digest block (compass-without-the-overseer) ----------

/**
 * The Overseer's Compass block: up to `COMPASS.digestNotes` live notes, soonest first, each as
 * `who · until · what · workspace or unplaced · note id`, then "N more". About 300-400 tokens, only when a note is live.
 */
export function digestLines(notes: readonly CompassNote[], settings: Pick<CompassSettings, "expiry">, titles: ReadonlyMap<string, string>, now: number, max = 12): string[] {
  const live = notes.filter(n => n.state === "live")
    .sort((a, b) => (a.until ?? "9999").localeCompare(b.until ?? "9999") || RANK[effectiveStrength(a, now, settings.expiry)] - RANK[effectiveStrength(b, now, settings.expiry)] || b.at.localeCompare(a.at));
  if (!live.length) return [];
  const where = (n: CompassNote) => n.match.workspace ? `workspace "${titles.get(n.match.workspace) ?? n.match.workspace}"` : n.match.issue ? `${n.match.issue}, no workspace` : "unplaced";
  const lines = live.slice(0, max).map(n => [noteWho(n), n.until ? `until ${n.until}` : "no date", n.what, where(n), n.id].join(" · "));
  return live.length > max ? [...lines, `${live.length - max} more (compass lists them)`] : lines;
}
