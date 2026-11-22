import { z } from "zod";
import { type Clock, BRIEF_SETTINGS_DEFAULT, QUEUE_STATE_TYPES, SINCE_MODES, WEEKDAYS, briefSettingsSchema, isZone, type BriefSettings } from "./linear-queue";

/**
 * Settings → Morning brief (docs/morning-brief.md#settings): the Linear queue's settings and this week's plan link,
 * stored host-scoped in `morning-brief.json` (never device-scoped: invariant 22). Pure: the store, the finder and the
 * one-time import are server/morning-brief.ts.
 *
 * The plan has three modes: **auto** ("Find it for me": the newest message from a person in some channels that links
 * a claude.ai artifact, over 14 days), **link** (pasted; it stays until changed, or until a newer one is found when
 * Find it for me is set up and "replace when newer" is on) and **off**. `FOLLOW_UP_PLAN_URL` overrides every mode
 * and shows read-only.
 */

export const PLAN_MODES = ["auto", "link", "off"] as const;
export type PlanMode = typeof PLAN_MODES[number];
/** How far back Find it for me looks. */
export const PLAN_FIND_DAYS = 14;
export const PLAN_CHANNELS_MAX = 5;

/** A chat person or channel: its id when known (from a picker or the import), else its name (searched by name). */
export const chatRefSchema = z.object({
  id: z.string().trim().regex(/^[A-Z0-9]{6,20}$/).nullable().default(null),
  name: z.string().trim().min(1).max(100),
});
export type ChatRef = z.infer<typeof chatRefSchema>;

export const planSettingsSchema = z.object({
  mode: z.enum(PLAN_MODES).default("off"),
  /** The pasted link (canonical: no share key), and when it was pasted. */
  link: z.string().max(300).nullable().default(null),
  linkAt: z.string().nullable().default(null),
  person: chatRefSchema.nullable().default(null),
  channels: z.array(chatRefSchema).max(PLAN_CHANNELS_MAX).default([]),
  /** With a pasted link and Find it for me set up: a link found after the paste replaces it. */
  replaceWhenNewer: z.boolean().default(false),
});
export type PlanSettings = z.infer<typeof planSettingsSchema>;

/** A link Find it for me found: where and when it was posted, and when Follow-up found it. */
export const foundPlanSchema = z.object({
  url: z.string().max(300),
  postedAt: z.string().max(40).nullable(),
  where: z.string().max(100).nullable(),
  foundAt: z.string(),
});
export type FoundPlan = z.infer<typeof foundPlanSchema>;

export const PLAN_CHECK_STATUSES = ["found", "not-found", "error", "unavailable"] as const;
export const morningBriefFileSchema = z.object({
  version: z.literal(1),
  queue: briefSettingsSchema,
  plan: planSettingsSchema,
  /** The newest link Find it for me found, and the one before it (last week's, kept while this week's isn't found). */
  found: foundPlanSchema.nullable(),
  previous: foundPlanSchema.nullable(),
  /** The last search: found, not found (nothing new in 14 days), failed, or no chat search to ask. */
  check: z.object({ at: z.string(), status: z.enum(PLAN_CHECK_STATUSES), error: z.string().max(300).nullable() }).nullable(),
  /** The day (in the brief's zone) Find it for me last ran on its own, with the morning sweep. */
  findDay: z.string().nullable(),
  /** When the one-time import from the morning-brief skill's registry ran (it runs once, found or not). */
  importedAt: z.string().nullable(),
  /**
   * Sources (shared/brief-sources.ts): the developer's switches by source id (a recipe's default otherwise), when
   * mcpproxy was last asked what it has, and each source's last read (ok, or its one-line error).
   */
  sources: z.object({
    on: z.record(z.string(), z.boolean()).default({}),
    checkedAt: z.string().nullable().default(null),
    reads: z.record(z.string(), z.object({ at: z.string(), ok: z.boolean(), error: z.string().max(300).nullable() })).default({}),
  }).default({ on: {}, checkedAt: null, reads: {} }),
});
export type MorningBriefFile = z.infer<typeof morningBriefFileSchema>;
export const emptyMorningBrief = (): MorningBriefFile => ({
  version: 1, queue: { ...BRIEF_SETTINGS_DEFAULT }, plan: planSettingsSchema.parse({}), found: null, previous: null, check: null, findDay: null, importedAt: null, sources: { on: {}, checkedAt: null, reads: {} },
});

/** A claude.ai artifact link without a query string or fragment, so no share key travels. */
export function canonicalArtifactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url.trim()); if (u.hostname !== "claude.ai" || !/^\/(code\/)?artifact\/[\w-]+$/.test(u.pathname)) return null; return `https://claude.ai${u.pathname}`; } catch { return null; }
}

/** Whether Find it for me has what it needs: a person and at least one channel. */
export const findReady = (p: PlanSettings) => !!p.person && p.channels.length > 0;
/** Whether a search runs: Find it for me, or a pasted link that a newer find may replace. */
export const searches = (p: PlanSettings) => findReady(p) && (p.mode === "auto" || (p.mode === "link" && p.replaceWhenNewer));

export type PlanSource = "env" | "link" | "found" | "previous" | "off" | "none";
/**
 * The plan link the brief and the ranker read, and where it comes from. The environment wins; Off reads nothing;
 * a pasted link stays unless a newer one was found and "replace when newer" is on; Find it for me reads this week's
 * find, else last week's (not found keeps last week's plan).
 */
export function effectivePlan(file: Pick<MorningBriefFile, "plan" | "found" | "previous">, env: string | null | undefined): { url: string | null; source: PlanSource } {
  const fromEnv = canonicalArtifactUrl(env);
  if (fromEnv) return { url: fromEnv, source: "env" };
  const p = file.plan;
  if (p.mode === "off") return { url: null, source: "off" };
  if (p.mode === "link") {
    const newer = searches(p) && file.found && (!p.linkAt || Date.parse(file.found.foundAt) > Date.parse(p.linkAt)) && file.found.url !== p.link;
    if (newer) return { url: file.found!.url, source: "found" };
    return p.link ? { url: p.link, source: "link" } : { url: null, source: "none" };
  }
  if (file.found) return { url: file.found.url, source: "found" };
  if (file.previous) return { url: file.previous.url, source: "previous" };
  return { url: null, source: "none" };
}

/** A found link replaces the stored one; the stored one becomes last week's when it differs. */
export function recordFound(file: Pick<MorningBriefFile, "found" | "previous">, next: FoundPlan): Pick<MorningBriefFile, "found" | "previous"> {
  if (file.found?.url === next.url) return { found: { ...next, foundAt: file.found.foundAt }, previous: file.previous };
  return { found: next, previous: file.found ?? file.previous };
}

// ---------- changes (the Settings screen and the agent tools send the same shapes) ----------

export const queueChangeSchema = z.strictObject({
  states: z.array(z.enum(QUEUE_STATE_TYPES)).min(1).max(4).optional(),
  sweepAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour.").optional(),
  timeZone: z.string().min(1).max(64).refine(isZone, "Use an IANA time zone, like Europe/Paris.").nullable().optional(),
  workdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).nullable().optional(),
  since: z.enum(SINCE_MODES).optional(),
  chatHours: briefSettingsSchema.shape.chatHours.removeDefault().optional(),
  calendarDays: briefSettingsSchema.shape.calendarDays.removeDefault().optional(),
});
export type QueueChange = z.infer<typeof queueChangeSchema>;
export function applyQueueChange(s: BriefSettings, c: QueueChange): BriefSettings {
  const next = { ...s };
  if (c.states) next.states = QUEUE_STATE_TYPES.filter(t => c.states!.includes(t));
  if (c.sweepAt) next.sweepAt = c.sweepAt;
  if (c.timeZone !== undefined) next.timeZone = c.timeZone;
  if (c.workdays !== undefined) next.workdays = c.workdays ? WEEKDAYS.filter(d => c.workdays!.includes(d)) : null;
  if (c.since) next.since = c.since;
  if (c.chatHours) next.chatHours = c.chatHours;
  if (c.calendarDays) next.calendarDays = c.calendarDays;
  return next;
}

const refInput = z.strictObject({ id: z.string().trim().regex(/^[A-Z0-9]{6,20}$/).nullable().optional(), name: z.string().trim().min(1).max(100) });
export const planChangeSchema = z.strictObject({
  mode: z.enum(PLAN_MODES).optional(),
  link: z.string().trim().max(2000).nullable().optional(),
  person: refInput.nullable().optional(),
  channels: z.array(refInput).max(PLAN_CHANNELS_MAX).optional(),
  replaceWhenNewer: z.boolean().optional(),
  /** Search now (Find it for me's "Look again"). */
  find: z.boolean().optional(),
});
export type PlanChange = z.infer<typeof planChangeSchema>;

/** The plan settings after a change, or why the change is refused. A pasted link must be a claude.ai artifact. */
export function applyPlanChange(p: PlanSettings, c: PlanChange, now: number): { ok: true; plan: PlanSettings } | { ok: false; error: string } {
  const next: PlanSettings = { ...p, channels: [...p.channels] };
  if (c.link !== undefined) {
    if (c.link === null || c.link === "") { next.link = null; next.linkAt = null; }
    else {
      const url = canonicalArtifactUrl(c.link);
      if (!url) return { ok: false, error: "That isn't a claude.ai artifact link (https://claude.ai/artifact/…)." };
      if (url !== p.link) { next.link = url; next.linkAt = new Date(now).toISOString(); }
    }
  }
  if (c.person !== undefined) next.person = c.person ? { id: c.person.id ?? null, name: c.person.name.replace(/^@/, "") } : null;
  if (c.channels) {
    const seen = new Set<string>();
    next.channels = c.channels.map(ch => ({ id: ch.id ?? null, name: ch.name.replace(/^#/, "") })).filter(ch => { const k = ch.id ?? ch.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (c.replaceWhenNewer !== undefined) next.replaceWhenNewer = c.replaceWhenNewer;
  if (c.mode) next.mode = c.mode;
  // Pasting a link is choosing it.
  else if (c.link && next.link) next.mode = "link";
  if (next.mode === "link" && !next.link) return { ok: false, error: "Paste the plan's link first." };
  return { ok: true, plan: next };
}

// ---------- the one-time import from the morning-brief skill's registry ----------

/**
 * The plan settings the morning-brief skill's registry implies (its `sources[]` entry read by `claude_artifact`): its
 * discovery block (the author and channels it searches) becomes Find it for me, and its verified link the first find.
 * Values are read, never logged; the file is never copied or edited. Null: nothing usable in it.
 */
export function importFromRegistry(json: string, now: number): { plan: PlanSettings; found: FoundPlan | null } | null {
  let j: unknown;
  try { j = JSON.parse(json); } catch { return null; }
  const sources = (j as { sources?: unknown })?.sources;
  if (!Array.isArray(sources)) return null;
  const src = sources.find(s => s && typeof s === "object" && (s as { reader?: unknown }).reader === "claude_artifact") as Record<string, unknown> | undefined;
  if (!src) return null;
  const d = (src.discovery && typeof src.discovery === "object" ? src.discovery : {}) as Record<string, unknown>;
  const str = (v: unknown, n = 100) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
  const id = (v: unknown) => { const s = str(v, 20); return s && /^[A-Z0-9]{6,20}$/.test(s) ? s : null; };
  const personName = str(d.author_name);
  const person = personName ? { id: id(d.author_id), name: personName.replace(/^@/, "") } : null;
  const channels = (Array.isArray(d.channels) ? d.channels : []).flatMap(c => {
    const name = str((c as { label?: unknown; name?: unknown })?.label ?? (c as { name?: unknown })?.name);
    return name ? [{ id: id((c as { id?: unknown }).id), name: name.replace(/^#/, "") }] : [];
  }).slice(0, PLAN_CHANNELS_MAX);
  const url = canonicalArtifactUrl(str(src.url, 2000));
  const at = new Date(now).toISOString();
  const plan = planSettingsSchema.parse({});
  if (person && channels.length) { plan.mode = "auto"; plan.person = person; plan.channels = channels; }
  else if (url) { plan.mode = "link"; plan.link = url; plan.linkAt = at; }
  else return null;
  const posted = str(d.selected_shared_at, 40);
  const found = url && plan.mode === "auto" ? { url, postedAt: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null, where: str(d.selected_shared_in), foundAt: at } : null;
  return { plan, found };
}

// ---------- chat replies (search results come back as text, sometimes inside {"results": "..."}) ----------

function replyText(text: string): string {
  try { const j = JSON.parse(text) as { results?: unknown }; if (typeof j?.results === "string") return j.results; } catch { /* plain text */ }
  return text;
}
const ARTIFACT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+(?:[?#][^\s)>\]|]*)?/;
const WHEN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/;

/**
 * The newest message in a search reply (sorted newest first) that links a claude.ai artifact: the link (canonical),
 * when it was posted and in which channel, when the reply says. Null: none links one.
 */
export function findArtifactLink(text: string): { url: string; postedAt: string | null; where: string | null } | null {
  const body = replyText(text);
  const entries = body.split(/\n(?=\s*(?:\d+\.|#{1,4}\s|[-*]\s))/);
  for (const e of entries) {
    const m = ARTIFACT.exec(e);
    const url = m && canonicalArtifactUrl(m[0]);
    if (!url) continue;
    const w = WHEN.exec(e);
    const at = w ? Date.parse(`${w[1]}T${w[2]}:00Z`) : NaN;
    const where = /(?:^|\s)#([\w][\w.-]{0,79})/.exec(e)?.[1] ?? null;
    return { url, postedAt: Number.isNaN(at) ? null : new Date(at).toISOString(), where };
  }
  return null;
}

/** People or channels from a chat search reply: id and name, at most 10. Ids look like U…/W… (people) and C…/G… (channels). */
export function parseChatRefs(text: string, kind: "people" | "channels"): ChatRef[] {
  const body = replyText(text);
  const idRe = kind === "people" ? /\b([UW][A-Z0-9]{7,19})\b/ : /\b([CG][A-Z0-9]{7,19})\b/;
  const out: ChatRef[] = []; const seen = new Set<string>();
  for (const block of body.split(/\n(?=\s*(?:\d+\.|#{1,4}\s|[-*]\s))|\n{2,}/)) {
    const id = idRe.exec(block)?.[1];
    if (!id || seen.has(id)) continue;
    const labelled = /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:Name|Real name|Display name|Channel)(?:\*\*)?\s*:\s*(?:\*\*)?#?([^\n*]+)/i.exec(block)?.[1];
    const hashed = kind === "channels" ? /#([\w][\w.-]{0,79})/.exec(block)?.[1] : undefined;
    const bold = /\*\*([^*\n]{1,100})\*\*/.exec(block)?.[1];
    const first = block.replace(idRe, "").replace(/^[\s\d.#*-]+/, "").split(/[\n(|]/)[0];
    const name = (labelled ?? hashed ?? bold ?? first ?? "").replace(/^[#@]/, "").replace(/[*_`]/g, "").trim().slice(0, 100);
    if (!name) continue;
    seen.add(id); out.push({ id, name });
    if (out.length >= 10) break;
  }
  return out;
}

/** "@alice in #planning, #roadmap": the same handles the pickers' chips show. */
export function findWhere(p: Pick<PlanSettings, "person" | "channels">): string {
  return `${p.person ? `@${p.person.name}` : "someone"} in ${p.channels.map(c => `#${c.name}`).join(", ") || "a channel"}`;
}

// ---------- what Settings and the agent tools read ----------

/** What the plan read last saw (the ranker's cached read): its title and item count, when. */
export type PlanRead = { url: string; at: string; title: string | null; items: number };
export type PlanView = {
  mode: MorningBriefFile["plan"]["mode"];
  link: string | null; linkAt: string | null;
  person: ChatRef | null; channels: ChatRef[];
  replaceWhenNewer: boolean;
  /** The link the brief and the ranker read, and where it comes from. */
  url: string | null; source: PlanSource;
  /** FOLLOW_UP_PLAN_URL, when set: it wins, and Settings shows it read-only. */
  env: string | null;
  found: FoundPlan | null; previous: FoundPlan | null;
  check: MorningBriefFile["check"];
  read: PlanRead | null;
  /** Whether there is a chat search to find it with. */
  canFind: boolean;
  findDays: number;
  importedAt: string | null;
};
export type BriefSettingsView = {
  queue: BriefSettings;
  /** The zone and week the brief runs on now, and where the zone comes from. */
  clock: Clock & { zoneFrom: "setting" | "device" | "host" };
  plan: PlanView;
};

export const briefPlanInputSchema = z.strictObject({ link: z.string().trim().min(1).max(2000).optional() });
/** `brief_plan` with a link: that link's title, read first (the dry run of `set_brief_plan`). */
export type PlanPreview = { url: string; title: string | null; items: number } | { url: string | null; error: string };

// ---------- what the Settings screen says (pure, so the copy is testable) ----------

const STATE_LABELS: Record<typeof QUEUE_STATE_TYPES[number], string> = { triage: "Triage", backlog: "Backlog", unstarted: "Todo", started: "In Progress" };
export const queueStateLabel = (s: typeof QUEUE_STATE_TYPES[number]) => STATE_LABELS[s];

/** "Mon 09:12" within the week, else "Nov 16", in the brief's zone. */
export function shortWhen(iso: string | null, now: number, timeZone: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const opts: Intl.DateTimeFormatOptions = now - t < 6 * 86_400_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { month: "short", day: "numeric" };
  try { return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(t).replace(",", ""); } catch { return null; }
}

export type PlanCard =
  | { tone: "ok"; title: string; line: string; url: string; actions: ("open" | "another")[] }
  | { tone: "warn"; title: string; line: string; paste: boolean; inUse: { line: string; url: string } | null }
  | { tone: "error"; title: string; line: string; retry: boolean; paste: boolean; inUse: { line: string; url: string } | null }
  | { tone: "quiet"; title: string; line: string };

/**
 * The plan card under the mode: what the brief reads and how Follow-up got it. Found and pasted links are a neutral
 * card with a check (§7: one primary per screen); not found is amber, keeps last week's and offers a paste field.
 */
export function planCard(v: Pick<PlanView, "mode" | "url" | "source" | "found" | "previous" | "check" | "read" | "person" | "channels" | "canFind" | "findDays" | "link" | "linkAt" | "replaceWhenNewer">, now: number, timeZone: string, reading = false): PlanCard | null {
  const when = (iso: string | null) => shortWhen(iso, now, timeZone);
  const readLine = v.read ? `read ${when(v.read.at) ?? ""}, ${v.read.items} ${v.read.items === 1 ? "item" : "items"}`.replace(" ,", ",") : reading ? "reading its title…" : "not read yet";
  const title = v.read?.title || "This week's plan";
  if (v.source === "env") return { tone: "ok", title, line: `Set by the environment (FOLLOW_UP_PLAN_URL) · ${readLine}`, url: v.url!, actions: ["open"] };
  if (v.mode === "off") return { tone: "quiet", title: "No plan", line: "The brief and AI priority read no weekly plan." };
  if (v.mode === "link") {
    if (!v.url) return null;
    if (v.source === "found") return { tone: "ok", title, line: `A newer one, found in ${v.found?.where ? `#${v.found.where}` : findWhere(v)}${when(v.found?.postedAt ?? null) ? `, ${when(v.found!.postedAt)}` : ""} · ${readLine}`, url: v.url, actions: ["open", "another"] };
    const rest = v.replaceWhenNewer && findReady(v as PlanSettings) ? ` · replaced if a newer one is found in ${v.channels.map(c => `#${c.name}`).join(", ")}` : "";
    return { tone: "ok", title, line: `Pasted ${when(v.linkAt) ?? ""} · ${readLine}${rest}`.replace("Pasted  ·", "Pasted ·"), url: v.url, actions: ["open"] };
  }
  // Find it for me.
  if (!v.person || !v.channels.length) return { tone: "quiet", title: "Pick who posts it and where", line: `Follow-up looks for the newest message from them that links a claude.ai artifact, over ${v.findDays} days.` };
  // What the brief reads while this week's isn't found: last week's link, or nothing.
  const kept = v.found ?? v.previous;
  const inUse = kept ? { line: `In use: last week's, posted ${when(kept.postedAt) ?? "earlier"}`, url: kept.url } : null;
  const fallback = kept ? "The brief uses last week's until this works." : "The brief reads no plan until this works.";
  if (!v.canFind) return { tone: "error", title: "No chat search connected", line: "Find it for me searches your chat through mcpproxy. Paste the link instead.", retry: false, paste: true, inUse };
  if (v.check?.status === "error") return { tone: "error", title: "Couldn't search", line: `${v.check.error ?? "The chat search failed."} ${fallback}`, retry: true, paste: true, inUse };
  if (v.check?.status === "not-found" || (!v.found && v.previous)) {
    const since = new Date(now - v.findDays * 86_400_000).toISOString();
    return { tone: "warn", title: kept ? "No plan this week yet" : "No plan found", line: `Nothing from ${findWhere(v)} since ${when(since)} links an artifact.${kept ? " The brief uses last week's until one shows up." : ""}`, paste: true, inUse };
  }
  if (!v.found || !v.url) return { tone: "quiet", title: "Looking…", line: `Searching ${findWhere(v)} for the newest artifact link.` };
  const where = v.found.where ? `#${v.found.where}` : v.channels.map(c => `#${c.name}`).join(", ");
  return { tone: "ok", title, line: `Found in ${where}${when(v.found.postedAt) ? `, ${when(v.found.postedAt)}` : ""} · claude.ai artifact · ${readLine}`, url: v.url, actions: ["open", "another"] };
}

/**
 * Settings → Morning brief's line under the tab: the plan and the sweep. Built from the same card the screen shows, so
 * the line never says "found" while the card says not found or failed.
 */
export function briefSummary(v: BriefSettingsView, now = Date.now()): string {
  const card = planCard(v.plan, now, v.clock.timeZone);
  const plan = v.plan.source === "env" ? "plan set by the environment" : v.plan.mode === "off" ? "no plan"
    : v.plan.mode === "link" ? (v.plan.source === "found" ? "a newer plan found" : "plan from a link")
    : !card || card.tone === "quiet" ? (card?.title.startsWith("Pick") ? "pick where the plan is posted" : "looking for the plan")
    : card.tone === "ok" ? "this week's plan found" : card.tone === "warn" ? (card.inUse ? "using last week's plan" : "no plan found") : !card.retry ? "no chat search connected" : card.inUse ? "plan search failed, using last week's" : "plan search failed";
  return `Sweeps ${v.queue.sweepAt} on workdays · ${plan}`;
}
