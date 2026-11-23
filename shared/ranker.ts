import { z } from "zod";
import { PRIORITY_SOURCES, priorityNote, prioritySourceSchema, type Priority } from "./priorities";
import type { WorkstreamRow } from "./overseer";
import { SCALE, truncated } from "./scale";
import { zoned, type Clock } from "./linear-queue";

/**
 * The ranker (1.4.0-beta.0, slice 3): one bounded model job that orders Tom's workstreams by what matters today and
 * says why in one line that names its source. Follow-up collects every input itself, read-only and without model
 * tools (Follow-up's own state, Linear, Slack, GitHub review requests and the CPO's weekly plan), hashes them, and
 * calls the model only when they changed. The result goes to the priorities store Home's Priority sort already reads.
 */

export const RANK_SOURCES = ["linear", "slack", "github", "planning", "calendar", "mail"] as const;
export type RankSource = typeof RANK_SOURCES[number];
export const RANK_SOURCE_LABEL: Record<RankSource, string> = { linear: "Linear", slack: "Chat", github: "GitHub", planning: "Plan", calendar: "Calendar", mail: "Mail" };
export type SourceHealth = "ok" | "failed" | "off";

/** `row`: the Home row it was read from. Not in the prompt or the stable inputs; the reply's priority keeps it. */
export type RankWorkstream = { id: string; row?: string; title: string; branch: string | null; group: string; ask: string | null; prs: string[]; keys: string[]; dormant: boolean };
/** `change`: what moved since the last workday's sweep ("raised Low → High", "new"), from the Morning brief's queue. */
export type RankIssue = { key: string; title: string; priority: string | null; status: string | null; due: string | null; project: string | null; milestone: string | null; url: string | null; change?: string | null };
export type RankMessage = { where: string; who: string | null; text: string; at: string | null };
export type RankReview = { repo: string; number: number; title: string; url: string | null; author: string | null };
export type RankPlanItem = { level: string; title: string; keys: string[] };
export type RankPlanning = { title: string | null; url: string | null; items: RankPlanItem[] };
/** What an Ask source found this morning (docs/morning-brief.md#ask): its server and validated items. */
export type RankAsked = { source: string; items: { title: string; why: string; url: string | null; due: string | null }[] };
/** A meeting today, from the calendar source (docs/morning-brief.md#sources). */
export type RankEvent = { title: string; start: string | null; url: string | null };
/** `calendar` and `mail`: only when those sources are on and connected (mail is off until turned on). */
export type RankInputs = { workstreams: RankWorkstream[]; linear: RankIssue[]; slack: RankMessage[]; github: RankReview[]; planning: RankPlanning | null; calendar?: RankEvent[]; mail?: RankMessage[]; chatHours?: number; asks?: RankAsked[] };

export const RANK_LIMITS = { workstreams: 150, issues: 60, messages: 40, reviews: 30, planItems: 60, events: 20, asked: 20, textChars: 220, titleChars: 120 };
const clip = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The ranker's view of a workstream. Follow-up's own priority is left out, so a ranking never feeds itself. */
export function rankWorkstream(w: WorkstreamRow): RankWorkstream {
  return {
    id: w.workspaceId, ...(w.key ? { row: w.key } : {}), title: clip(w.title, RANK_LIMITS.titleChars), branch: w.branch, group: w.group, ask: w.ask ? clip(w.ask, RANK_LIMITS.textChars) : null,
    prs: w.prs.map(p => `#${p.number} ${p.state.toLowerCase()}${p.checks ? ` checks ${p.checks}` : ""}`), keys: w.keys, dormant: w.dormant,
  };
}

/** Stable across runs: sorted, no timestamps that move by themselves. Equal text means the model would see the same thing. */
export function stableInputs(inputs: RankInputs): string {
  const stable = {
    w: [...inputs.workstreams].sort((a, b) => a.id.localeCompare(b.id)).map(w => [w.id, w.title, w.branch, w.group, w.ask, w.prs, w.keys, w.dormant]),
    l: [...inputs.linear].sort((a, b) => a.key.localeCompare(b.key)).map(i => [i.key, i.title, i.priority, i.status, i.due, i.project, i.milestone, i.change ?? null]),
    s: inputs.slack.map(m => [m.where, m.who, m.text]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    g: [...inputs.github].sort((a, b) => `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`)).map(r => [r.repo, r.number, r.title]),
    p: inputs.planning ? inputs.planning.items.map(i => [i.level, i.title, i.keys]) : null,
    // Only when read, so a brief without them hashes as it did before they existed.
    ...(inputs.calendar?.length ? { c: inputs.calendar.map(e => [e.start, e.title]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
    ...(inputs.mail?.length ? { m: inputs.mail.map(m => [m.who, m.text]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
    ...(inputs.asks?.length ? { a: [...inputs.asks].sort((x, y) => x.source.localeCompare(y.source)).map(a => [a.source, a.items.map(i => [i.title, i.why, i.due])]) } : {}),
  };
  return JSON.stringify(stable);
}

/**
 * Added for models other than Claude: Codex left reasons empty below its top five. The rules are the same; this
 * restates the one it broke, at the end where it carries most weight.
 */
export const RANK_STRICT = `\nCheck before replying: every object in "priorities" has a "reason" of at least three words. An empty reason, "", "-" or "n/a" is invalid. Reply with the JSON only.`;

export const RANK_SYSTEM = `You rank a developer's workstreams (Paseo workspaces) by what matters most today. Reply with one JSON object only, no prose or code fence:
{"priorities":[{"workspace":"<workspace id>","score":0-100,"reason":"<one line, at most 60 characters, never empty>","sources":[{"kind":"linear|slack|github|planning|calendar|mail|other|paseo","label":"<short>","url":"<only a url given in the material>"}]}]}
Rules:
- Rank only workspace ids from WORKSTREAMS. Give every non-resting workstream a score; leave resting ones out unless an input names them.
- The reason is the concrete fact, at most 60 characters, fact first: "ACME-1312 · Urgent · due today", "This week's Okta milestone", "Dana asked twice, demo tomorrow", "Review requested by Avi". Never start it with the source's name ("Slack:", "Plan:", "Linear:"): the list shows the source beside it. Never "important" or "high priority" alone.
- Every ranked workstream has a non-empty reason. When no outside input (Linear, Slack, GitHub, plan) names it, the reason is its strongest Paseo fact (its open ask, PR state or checks, "agent stopped") with sources [{"kind":"paseo","label":"Paseo"}]. Never filler like "no outside signal".
- Direct asks to the developer weigh at least as much as this week's plan milestones: a Slack DM or mention waiting on them, a GitHub review requested from them, a workstream waiting on their decision (group needs with an open ask). Never rank a plan item above a direct ask of similar urgency; a direct ask from a person with a deadline ranks above any plan item.
- Stability: PREVIOUS RANKING lists each workstream's last score. Keep a workstream within 10 points of it unless something about that workstream changed (a new Slack line, issue state, review request, PR or ask). Don't reshuffle what didn't change.
- Spread the scores: a clear outside signal (urgent or due Linear issue, a person asking in Slack, a review request, this week's plan) scores above one without. A workstream waiting on the developer (group needs) with a real ask scores higher than the same work without one.
- LINEAR is the developer's queue, most urgent first, with what changed since the last workday. A change is news: an issue raised to Urgent or High, or new and Urgent, means someone expects action, so the workstream that has it scores up ("ACME-142 raised to High since Fri").
- CALENDAR and MAIL, when present: a meeting today about a workstream (its key, PR or topic) or mail asking the developer something is a near-term signal, weighed like a Slack ask.
- Use only facts in the material. Never invent a key, a person, a date or a url.`;

/** The material for one run, bounded: each list is cut to its limit before the prompt is built, never after. */
export function rankPrompt(inputs: RankInputs, today: string, maxChars: number, previous: readonly { id: string; score: number }[] = [], timeZone = "UTC"): string {
  const L = RANK_LIMITS;
  const sections: [string, string[]][] = [
    ["WORKSTREAMS (id · title · group · branch · PRs · keys · open ask)", inputs.workstreams.slice(0, L.workstreams).map(w =>
      [w.id, w.title, w.dormant ? "resting" : w.group, w.branch ?? "-", w.prs.join(", ") || "-", w.keys.join(" ") || "-", w.ask ?? "-"].join(" · "))],
    ["LINEAR (the developer's queue: key · priority · status · due · project / milestone · title · url · change since the last workday)", inputs.linear.slice(0, L.issues).map(i =>
      [i.key, i.priority ?? "-", i.status ?? "-", i.due ?? "-", [i.project, i.milestone].filter(Boolean).join(" / ") || "-", clip(i.title, L.titleChars), i.url ?? "-", i.change || "-"].join(" · "))],
    [`SLACK (DMs and mentions, last ${inputs.chatHours ?? 48} h: where · who · text · when)`, inputs.slack.slice(0, L.messages).map(m => [m.where, m.who ?? "-", clip(m.text, L.textChars), m.at ?? "-"].join(" · "))],
    ["GITHUB (review requested from the developer: repo#number · title · author · url)", inputs.github.slice(0, L.reviews).map(r => [`${r.repo}#${r.number}`, clip(r.title, L.titleChars), r.author ?? "-", r.url ?? "-"].join(" · "))],
    ["PLAN (the CPO's weekly plan: level · title · keys)", (inputs.planning?.items ?? []).slice(0, L.planItems).map(i => [i.level, clip(i.title, L.titleChars), i.keys.join(" ") || "-"].join(" · "))],
    ...(inputs.calendar?.length ? [["CALENDAR (the developer's meetings today: start · title · url)", inputs.calendar.slice(0, L.events).map(e => [e.start ?? "-", clip(e.title, L.titleChars), e.url ?? "-"].join(" · "))] as [string, string[]]] : []),
    ...(inputs.mail?.length ? [["MAIL (unread mail to the developer: who · subject · when)", inputs.mail.slice(0, L.messages).map(m => [m.who ?? "-", clip(m.text, L.textChars), m.at ?? "-"].join(" · "))] as [string, string[]]] : []),
    ...(inputs.asks?.length ? [["OTHER SOURCES (asked this morning: source · title · why · due · url)", inputs.asks.flatMap(a => a.items.map(i => [a.source, clip(i.title, L.titleChars), clip(i.why, L.textChars), i.due ?? "-", i.url ?? "-"].join(" · "))).slice(0, L.asked)] as [string, string[]]] : []),
    ...(previous.length ? [["PREVIOUS RANKING (id · score)", previous.filter(p => inputs.workstreams.some(w => w.id === p.id)).map(p => `${p.id} · ${p.score}`)] as [string, string[]]] : []),
  ];
  const head = `Today is ${today} (${timeZone}).\n`;
  let body = sections.map(([title, lines]) => `${title}:\n${lines.length ? lines.join("\n") : "(none)"}`).join("\n\n");
  // Still too long: drop resting workstreams first, then the tail of each list.
  if (head.length + body.length > maxChars) {
    const lean = { ...inputs, workstreams: inputs.workstreams.filter(w => !w.dormant), slack: inputs.slack.slice(0, 20), linear: inputs.linear.slice(0, 30), planning: inputs.planning && { ...inputs.planning, items: inputs.planning.items.slice(0, 30) } };
    if (lean.workstreams.length < inputs.workstreams.length || lean.slack.length < inputs.slack.length || lean.linear.length < inputs.linear.length) return rankPrompt(lean, today, maxChars, previous, timeZone);
    body = body.slice(0, Math.max(0, maxChars - head.length - 1));
  }
  return head + body;
}

const sourceOut = z.object({ kind: z.enum(PRIORITY_SOURCES), label: z.string().trim().min(1).max(60), url: z.string().url().max(2000).optional().catch(undefined) });
export const rankReplySchema = z.object({
  priorities: truncated(z.object({ workspace: z.string().trim().min(1).max(200), score: z.number().min(0).max(100), reason: z.string().trim().max(300).catch(""), sources: z.array(sourceOut).max(5).catch([]).default([]) }), SCALE.workspaces),
  notStarted: z.array(z.object({ key: z.string().trim().min(1).max(30), title: z.string().trim().min(1).max(200), url: z.string().url().max(2000).optional().catch(undefined), reason: z.string().trim().max(300).catch("") })).max(20).catch([]).default([]),
});
export type RankReply = z.infer<typeof rankReplySchema>;
/** Ranked workspaces whose reason is missing or a placeholder: the ranker asks once more, naming them. */
export function emptyReasons(reply: RankReply, inputs: RankInputs): string[] {
  const known = new Set(inputs.workstreams.map(w => w.id));
  return reply.priorities.filter(p => known.has(p.workspace) && !meaningful(p.reason)).map(p => p.workspace);
}
const meaningful = (reason: string) => { const r = reason.replace(SOURCE_PREFIX, "").trim(); return r.length >= 3 && !/^(-+|n\/?a|none|tbd|\.+)$/i.test(r); };
export const REASON_SYSTEM = `You write the one-line reason for workstreams that were already ranked. Reply with one JSON object only, no prose or code fence:
{"reasons":[{"workspace":"<workspace id>","reason":"<one line, at most 60 characters, never empty>","sources":[{"kind":"linear|slack|github|planning|calendar|mail|other|paseo","label":"<short>","url":"<only a url given in the material>"}]}]}
Rules:
- One entry for every workspace id in WORKSTREAMS, and no others.
- The reason is the concrete fact, fact first: "ACME-1312 · Urgent · due today", "Dana asked twice, demo tomorrow", "Review requested by Avi". Never start it with the source's name.
- When no outside input names it, use its strongest Paseo fact (its open ask, PR state or checks, "agent stopped") with sources [{"kind":"paseo","label":"Paseo"}].
- Use only facts in the material. An empty reason is invalid.`;
export const reasonReplySchema = z.object({
  reasons: truncated(z.object({ workspace: z.string().trim().min(1).max(200), reason: z.string().trim().max(300).catch(""), sources: z.array(sourceOut).max(5).catch([]).default([]) }), SCALE.workspaces),
});
export type ReasonReply = z.infer<typeof reasonReplySchema>;

/**
 * The cheap retry's material: only the workspaces that came back without a reason, and only the outside inputs
 * that can be about them (their Linear keys, their PRs' review requests, plan items with their keys, the Slack lines).
 */
export function reasonInputs(inputs: RankInputs, ids: readonly string[]): RankInputs {
  const want = new Set(ids);
  const workstreams = inputs.workstreams.filter(w => want.has(w.id));
  const keys = new Set(workstreams.flatMap(w => w.keys.map(k => k.toUpperCase())));
  const prs = new Set(workstreams.flatMap(w => w.prs.map(p => p.split(" ")[0])));
  return {
    workstreams,
    linear: inputs.linear.filter(i => keys.has(i.key.toUpperCase())),
    slack: inputs.slack,
    github: inputs.github.filter(r => prs.has(`#${r.number}`)),
    planning: inputs.planning && { ...inputs.planning, items: inputs.planning.items.filter(i => i.keys.some(k => keys.has(k.toUpperCase()))) },
  };
}
/** The first reply with the retry's reasons filled in where it had none; scores and order stay the model's first answer. */
export function fillReasons(reply: RankReply, more: ReasonReply): RankReply {
  const by = new Map(more.reasons.filter(r => meaningful(r.reason)).map(r => [r.workspace, r]));
  return { ...reply, priorities: reply.priorities.map(p => meaningful(p.reason) || !by.has(p.workspace) ? p : { ...p, reason: by.get(p.workspace)!.reason, sources: by.get(p.workspace)!.sources }) };
}
/** Still empty after the retry: the workspace's own strongest fact, so no row is left without one. */
export function paseoReason(w: RankWorkstream): string {
  if (w.ask) return clip(w.ask, 60);
  const failing = w.prs.find(p => /checks failed/.test(p));
  if (failing) return clip(failing.replace(/ open/, ""), 60);
  const open = w.prs.filter(p => / open/.test(p));
  if (open.length) return open.length === 1 ? `${open[0].split(" ")[0]} open` : `${open.length} PRs open`;
  return w.group === "running" ? "Agent working" : "Recent activity in Paseo";
}

/** "Slack: ", "Plan: "…: the source chip already says it. */
const SOURCE_PREFIX = /^(slack|plan|planning|linear|github|paseo)\s*[:·-]\s*/i;
export type NotStarted = { key: string; title: string; url: string | null; reason: string };

/**
 * The reply as priorities Home can show: known workspace ids only, one per workspace (the first), reasons cut to one
 * line, urls only when the material had them. Blocking asks need no floor: Home lists Needs you first whatever the score.
 */
export function toPriorities(reply: RankReply, inputs: RankInputs, at: string): { priorities: Priority[]; notStarted: NotStarted[]; dropped: string[] } {
  const by = new Map(inputs.workstreams.map(w => [w.id, w]));
  const urls = new Set<string>([...inputs.linear.map(i => i.url), ...inputs.github.map(r => r.url), inputs.planning?.url ?? null].filter((u): u is string => !!u));
  const seen = new Set<string>(); const dropped: string[] = [];
  const priorities: Priority[] = [];
  for (const p of reply.priorities) {
    const w = by.get(p.workspace);
    if (!w) { dropped.push(p.workspace); continue; }
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const sources = p.sources.map(s => ({ kind: s.kind, label: clip(s.label, 60), ...(s.url && urls.has(s.url) ? { url: s.url } : {}) })).filter(s => prioritySourceSchema.safeParse(s).success);
    const given = clip(p.reason.split(/\r?\n/)[0].replace(SOURCE_PREFIX, ""), 140);
    // Every ranked row has a reason: the model's, or (after the retry still failed) the workspace's own fact.
    const reason = meaningful(given) ? given : paseoReason(w);
    priorities.push({ workspaceId: w.id, score: Math.round(Math.min(100, p.score)), reason, sources: reason === given ? sources : [{ kind: "paseo", label: "Paseo" }], at, by: "ranker", ...(w.row ? { row: w.row } : {}) });
  }
  priorities.sort((a, b) => b.score - a.score || a.workspaceId.localeCompare(b.workspaceId));
  return { priorities, notStarted: notStartedFrom(inputs), dropped };
}

/**
 * Issues someone expects action on that no workstream has: Urgent, or raised to High or Urgent since the last workday,
 * with no workstream naming the key. Read from the queue, not asked of the model (the brief draws them with New's
 * actions). Most urgent first, at most 10.
 */
export function notStartedFrom(inputs: Pick<RankInputs, "workstreams" | "linear">): NotStarted[] {
  const covered = new Set(inputs.workstreams.flatMap(w => w.keys.map(k => k.toUpperCase())));
  const raised = (i: RankIssue) => /(^|, )raised [^,]*→ (Urgent|High)(,|$)/.test(i.change ?? "");
  return inputs.linear.filter(i => !covered.has(i.key.toUpperCase()) && (i.priority === "Urgent" || raised(i))).slice(0, 10)
    .map(i => ({ key: i.key, title: i.title, url: i.url, reason: [i.priority, i.change, i.due ? `due ${i.due}` : null].filter(Boolean).join(" · ") }));
}

// ---------- when it runs ----------

/**
 * The automatic runs: the developer's workdays, 08:00–20:00, in their zone (the brief's clock: its setting, else the
 * device's zone, else the host's; workdays from the zone's usual week). "Re-rank now" works any time.
 */
export function inRankWindow(now: number, clock: Clock): boolean {
  const z = zoned(now, clock.timeZone);
  return clock.workdays.includes(z.weekday) && z.hour >= 8 && z.hour < 20;
}

/** "Linear ok · Slack failed · Plan off": what the last run could read, for the sort header. */
export function healthLine(health: Partial<Record<RankSource, SourceHealth>>): string {
  return RANK_SOURCES.filter(s => health[s] && health[s] !== "ok").map(s => `${RANK_SOURCE_LABEL[s]} ${health[s] === "off" ? "off" : "unavailable"}`).join(" · ");
}

/** The longest footer a failed run's reason may take. */
const FOOTER_MAX = 80;

/**
 * The sort menu's footer (Home and the sidebar view): only when the ranking last ran, "Ranked 1h ago". It never says
 * what a run cost; agents read that from `rank_status`. Never ran: "Not ranked yet" (nothing when the ranker is off, the
 * Priority row's hint already says "By urgency"). A run in flight keeps the standing ranking's age (the menu item says
 * "Ranking…"), or "Ranking now" before the first one. A failed last run adds its short reason, which the developer can
 * act on. Null: no footer.
 */
export function rankFooter(input: { rankedAt: string | null; now: number; rank: { enabled: boolean; running: boolean; error: string | null } | null }): string | null {
  const { rankedAt, now, rank } = input;
  const age = rankedAt ? priorityNote(rankedAt, now) : null;
  if (!rank?.enabled) return age;
  const reason = rank.error?.trim().replace(/\.$/, "");
  const parts = [age ?? (rank.running ? "Ranking now" : reason ? null : "Not ranked yet"), !rank.running && reason ? `Last run failed: ${reason}` : null].filter(Boolean).join(" · ");
  return parts.length > FOOTER_MAX ? `${parts.slice(0, FOOTER_MAX - 1).trimEnd()}…` : parts;
}

// ---------- stability ----------

/** Most a workspace's score may move in one run when nothing about it changed. */
export const STEADY_CAP = 10;

/**
 * Everything the ranker sees about one workspace: its own row, the Linear issues with its keys, review requests for
 * its PRs, plan items with its keys, and Slack lines naming a key, a PR or its branch. Equal means "nothing changed
 * for it", so its score may only drift by STEADY_CAP.
 */
export function workspaceInputs(w: RankWorkstream, inputs: RankInputs): string {
  const keys = new Set(w.keys.map(k => k.toUpperCase()));
  const prs = new Set(w.prs.map(p => p.split(" ")[0]));
  const words = [...keys, ...prs, ...(w.branch ? [w.branch.toLowerCase()] : [])];
  return JSON.stringify([
    [w.title, w.group, w.ask, w.prs, w.keys, w.dormant],
    inputs.linear.filter(i => keys.has(i.key.toUpperCase())).map(i => [i.key, i.priority, i.status, i.due, i.milestone, i.change ?? null]).sort(),
    inputs.github.filter(r => prs.has(`#${r.number}`)).map(r => r.number).sort(),
    (inputs.planning?.items ?? []).filter(i => i.keys.some(k => keys.has(k.toUpperCase()))).map(i => i.title).sort(),
    inputs.slack.filter(m => words.some(x => m.text.toUpperCase().includes(x.toUpperCase()))).map(m => [m.who, m.text]).sort(),
  ]);
}

/** New scores, held within STEADY_CAP of the previous ones for workspaces whose own inputs didn't change. */
export function damped<T extends { workspaceId: string; score: number }>(items: readonly T[], previous: ReadonlyMap<string, { score: number; fp: string }>, fps: ReadonlyMap<string, string>): T[] {
  return items.map(p => {
    const prev = previous.get(p.workspaceId);
    if (!prev || prev.fp !== fps.get(p.workspaceId)) return p;
    return { ...p, score: Math.max(prev.score - STEADY_CAP, Math.min(prev.score + STEADY_CAP, p.score)) };
  }).sort((a, b) => b.score - a.score || a.workspaceId.localeCompare(b.workspaceId));
}
