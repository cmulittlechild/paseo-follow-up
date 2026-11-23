import { MIN_N, type Period } from "./pr-stats";
import { statsWaitWords, type PrStatsOutput } from "./pr-stats-settings";

/**
 * The PR stats page's words and orders (docs/pr-stats.md#the-page), pure so tests read them without a renderer. The
 * page is the leaderboard: one row per person, sortable by every column, opened first (Tom's first question).
 */
export type Person = NonNullable<PrStatsOutput["model"]>["people"][number];
export type Summary = Person["wait"];
export const COLUMNS = [
  { key: "opened", label: "Opened", long: "PRs opened" },
  { key: "merged", label: "Merged", long: "PRs merged" },
  { key: "wait", label: "Wait for a first review", long: "Median wait for a first review" },
  { key: "reviews", label: "Reviews given", long: "Reviews given" },
  { key: "turnaround", label: "Review turnaround", long: "Median review turnaround" },
] as const;
export type SortKey = typeof COLUMNS[number]["key"];
export const DEFAULT_SORT: SortKey = "opened";
export const PERIOD_LABELS: Record<Period, string> = { week: "This week", "last-week": "Last week", "30d": "30 days", "90d": "90 days" };
export const isSortKey = (v: unknown): v is SortKey => COLUMNS.some(c => c.key === v);

/** A duration in the page's words: "45m", "3h 10m", "1d 2h". Seconds in. */
export function durationWords(s: number): string {
  const m = Math.max(0, Math.round(s / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
/** A median cell: "-" below MIN_N PRs (never a bar), else the median with p75 and n for the hover. */
export function medianCell(x: Summary): { text: string; hover: string; value: number | null } {
  if (x.median === null || x.n < MIN_N) return { text: "-", hover: `n = ${x.n}: a median needs ${MIN_N} or more`, value: null };
  return { text: durationWords(x.median), hover: `median ${durationWords(x.median)} · p75 ${x.p75 === null ? "-" : durationWords(x.p75)} · n = ${x.n}`, value: x.median };
}
/** A column's number for sorting and bars; null sorts last (a "-" median). */
export function cellValue(p: Person, key: SortKey): number | null {
  switch (key) {
    case "opened": return p.opened;
    case "merged": return p.merged;
    case "reviews": return p.reviews;
    case "wait": return medianCell(p.wait).value;
    case "turnaround": return medianCell(p.turnaround).value;
  }
}
/** Rows in the column's order, largest first (the longest wait first for "whose PRs wait longest"); ties by login. */
export function sortPeople(people: readonly Person[], key: SortKey): Person[] {
  return [...people].sort((a, b) => {
    const x = cellValue(a, key), y = cellValue(b, key);
    if (x === null && y === null) return a.login.localeCompare(b.login);
    if (x === null) return 1; if (y === null) return -1;
    return y - x || a.login.localeCompare(b.login);
  });
}
/** Each column's largest value: a bar's full length. */
export function columnMax(people: readonly Person[]): Record<SortKey, number> {
  const max = (key: SortKey) => Math.max(0, ...people.map(p => cellValue(p, key) ?? 0));
  return { opened: max("opened"), merged: max("merged"), wait: max("wait"), reviews: max("reviews"), turnaround: max("turnaround") };
}
const day = (s: number, timeZone: string, o: Intl.DateTimeFormatOptions) => { try { return new Date(s * 1000).toLocaleDateString("en-US", { ...o, timeZone }); } catch { return new Date(s * 1000).toISOString().slice(0, 10); } };
/** What the period covers, in the zone: "Sun, Jan 11 – now" (the week's real first day), "Jan 4 – Jan 10". */
export function rangeWords(out: Pick<PrStatsOutput, "period" | "range" | "timeZone">): string {
  const from = day(out.range.start, out.timeZone, { weekday: "short", month: "short", day: "numeric" });
  if (out.period === "week") return `${from} – now`;
  if (out.period === "last-week") return `${from} – ${day(out.range.end - 1, out.timeZone, { weekday: "short", month: "short", day: "numeric" })}`;
  return `${day(out.range.start, out.timeZone, { month: "short", day: "numeric" })} – now`;
}
const ago = (seconds: number) => { const m = Math.round(seconds / 60); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
/**
 * The sync line under the header: honest coverage while the first read runs ("so far"), why it waits, a refusal, or
 * when it was last read. Tone: danger for a refusal, warning while GitHub's limit or the share holds it, else muted.
 */
export function syncLine(out: Pick<PrStatsOutput, "sync" | "timeZone">, now: number): { text: string; tone: "danger" | "warning" | "muted"; soFar: boolean } | null {
  const s = out.sync; if (!s) return null;
  const soFar = !s.coversPeriod;
  const read = s.lastSyncAt ? `Updated ${ago(now - s.lastSyncAt)}` : "Not read yet";
  const back = s.coveredTo ? ` back to ${day(s.coveredTo, out.timeZone, { month: "short", day: "numeric" })}` : "";
  // Said from the period's side: once the period is read, an unfinished backfill is only older history.
  const reading = s.backfillDone ? null : s.coversPeriod ? `This period is read · still reading older PRs${back ? ` (${back.trim()})` : ""}`
    : `Partly read${back ? `: from${back.replace(" back to", "")}` : ""}`;
  const wait = statsWaitWords(s);
  if (s.error) return { text: `${wait} Showing the last good read${s.lastSyncAt ? `, from ${ago(now - s.lastSyncAt)}` : ""}.`, tone: "danger", soFar };
  if (wait) return { text: [reading, wait].filter(Boolean).join(" · "), tone: s.waiting?.reason === "governor" || s.coversPeriod ? "muted" : "warning", soFar };
  return { text: reading ?? read, tone: "muted", soFar };
}
/** The team line's facts, in order: what the period holds for everyone (no person named). */
export function teamFacts(model: NonNullable<PrStatsOutput["model"]>): { value: string; label: string; hover?: string }[] {
  const t = model.team; const wait = medianCell(t.wait);
  return [
    { value: t.opened.toLocaleString("en-US"), label: "opened", ...(t.openedStacks && t.openedStacks < t.opened ? { hover: `in ${t.openedStacks} stacks` } : {}) },
    { value: t.merged.toLocaleString("en-US"), label: "merged" },
    { value: wait.text, label: "median wait for a first review", hover: wait.hover },
    { value: t.reviews.toLocaleString("en-US"), label: t.reviews === 1 ? "review given" : "reviews given" },
  ];
}
/** A phone row's second line: everything but the sorted column, and no "-" medians (the person's screen has those with their n). */
export function personLine(p: Person, sort: SortKey): string {
  const w = medianCell(p.wait), r = medianCell(p.turnaround);
  const parts: [SortKey, string | null][] = [
    ["opened", `${p.opened} opened`], ["merged", `${p.merged} merged`], ["wait", w.text === "-" ? null : `waited ${w.text}`],
    ["reviews", `${p.reviews} review${p.reviews === 1 ? "" : "s"}`], ["turnaround", r.text === "-" ? null : `turnaround ${r.text}`],
  ];
  // Each "value label" pair keeps together (no-break spaces) so a duration never splits across lines.
  return parts.filter(([k, v]) => k !== sort && v !== null).map(([, v]) => v!.replace(/ /g, "\u00a0")).join(" · ");
}

export function personWords(p: Person): string {
  const w = medianCell(p.wait), r = medianCell(p.turnaround);
  return `${p.opened} opened · ${p.merged} merged · waited ${w.text === "-" ? `- (n ${p.wait.n})` : w.text} · ${p.reviews} review${p.reviews === 1 ? "" : "s"} · turnaround ${r.text === "-" ? `- (n ${p.turnaround.n})` : r.text}`;
}
