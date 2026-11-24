import { z } from "zod";
import { type Clock, BRIEF_SETTINGS_DEFAULT, QUEUE_STATE_TYPES, SINCE_MODES, WEEKDAYS, briefSettingsSchema, isZone, type BriefSettings } from "./linear-queue";
import { ASK, askCallSchema, askItemSchema } from "./ask";
import { COMPASS, compassChangeSchema, compassSettingsSchema, emptyCompass, type CompassSettings, type CompassSource, type Place } from "./compass";
import { sourcesChangeSchema } from "./brief-sources";

/**
 * Settings → Compass (docs/morning-brief.md#settings, docs/compass.md): the brief's own settings (sweep time, since,
 * zone, workdays), the queue's, and this week's plan, stored host-scoped in `morning-brief.json` (never device-scoped:
 * invariant 22). Pure: the store, the one-time import and the one-time move are server/morning-brief.ts.
 *
 * The plan has three modes: **compass** (the newest claude.ai artifact a Compass source with "Posts the plan" shares,
 * found as Compass reads it), **link** (pasted; it stays until changed, or until a newer one arrives from Compass when
 * "replace when newer" is on) and **off**. `FOLLOW_UP_PLAN_URL` overrides every mode and shows read-only. Before
 * Compass, "auto" (Find it for me) searched one person's channels each morning; it reads as "compass", and its
 * person and channels move into a Compass source once (`moveToCompass`, one-place-for-priority-inputs).
 */

export const PLAN_MODES = ["compass", "link", "off"] as const;
export type PlanMode = typeof PLAN_MODES[number];
export const PLAN_CHANNELS_MAX = 5;

/** A chat person or channel: its id when known (from a picker or the import), else its name (searched by name). */
export const chatRefSchema = z.object({
  id: z.string().trim().regex(/^[A-Z0-9]{6,20}$/).nullable().default(null),
  name: z.string().trim().min(1).max(100),
});
export type ChatRef = z.infer<typeof chatRefSchema>;

export const planSettingsSchema = z.object({
  /** "auto" (Find it for me, before Compass) reads as "compass". */
  mode: z.preprocess(v => v === "auto" ? "compass" : v, z.enum(PLAN_MODES)).default("compass"),
  /** The pasted link (canonical: no share key), and when it was pasted. */
  link: z.string().max(300).nullable().default(null),
  linkAt: z.string().nullable().default(null),
  /**
   * Find it for me's person and channels, from before Compass. They move into a Compass source once (`moveToCompass`)
   * and are cleared; a name chat search couldn't find stays in `unmoved`, so nothing is lost (invariant 7).
   */
  person: chatRefSchema.nullable().default(null),
  channels: z.array(chatRefSchema).max(PLAN_CHANNELS_MAX).default([]),
  /** When the one-time move ran, and what it couldn't carry over (names, shown once in Settings). */
  movedAt: z.string().nullable().default(null),
  unmoved: z.array(z.string().max(100)).max(PLAN_CHANNELS_MAX + 1).default([]),
  /** With a pasted link: a plan Compass finds after the paste replaces it. */
  replaceWhenNewer: z.boolean().default(false),
});
export type PlanSettings = z.infer<typeof planSettingsSchema>;

/** A plan link Compass found: which source shared it, where and when, and when Follow-up found it. */
export const foundPlanSchema = z.object({
  url: z.string().max(300),
  postedAt: z.string().max(40).nullable(),
  where: z.string().max(100).nullable(),
  foundAt: z.string(),
  /** The Compass source whose message linked it (null: found by Find it for me, before Compass). */
  source: z.string().max(40).nullable().default(null),
});
export type FoundPlan = z.infer<typeof foundPlanSchema>;

export const morningBriefFileSchema = z.object({
  version: z.literal(1),
  queue: briefSettingsSchema,
  plan: planSettingsSchema,
  /** The newest plan Compass found, and the one before it (last week's, kept while this week's isn't found). */
  found: foundPlanSchema.nullable(),
  previous: foundPlanSchema.nullable(),
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
    /** Ask (shared/ask.ts): each server's plan of reads, reused for a week while its tools are the same. */
    plans: z.record(z.string(), z.object({ at: z.string(), hash: z.string(), calls: z.array(askCallSchema).max(ASK.calls) })).default({}),
    /** Ask: each source's last ask, a preview or a morning's: its items, the reads it ran, or why it failed. */
    asked: z.record(z.string(), z.object({ at: z.string(), preview: z.boolean(), items: z.array(askItemSchema).max(ASK.items), calls: z.array(askCallSchema).max(ASK.calls), error: z.string().max(300).nullable() })).default({}),
  }).default({ on: {}, checkedAt: null, reads: {}, plans: {}, asked: {} }),
  /** Compass (shared/compass.ts): the sources that set the developer's priorities, their reading notes, the glossary. */
  compass: compassSettingsSchema.default(emptyCompass),
});
export type MorningBriefFile = z.infer<typeof morningBriefFileSchema>;
export const emptyMorningBrief = (): MorningBriefFile => ({
  version: 1, queue: { ...BRIEF_SETTINGS_DEFAULT }, plan: planSettingsSchema.parse({}), found: null, previous: null, importedAt: null, sources: { on: {}, checkedAt: null, reads: {}, plans: {}, asked: {} }, compass: emptyCompass(),
});

/** A claude.ai artifact link without a query string or fragment, so no share key travels. */
export function canonicalArtifactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url.trim()); if (u.hostname !== "claude.ai" || !/^\/(code\/)?artifact\/[\w-]+$/.test(u.pathname)) return null; return `https://claude.ai${u.pathname}`; } catch { return null; }
}

export type PlanSource = "env" | "link" | "found" | "previous" | "off" | "none";
/**
 * The plan link the brief and the ranker read, and where it comes from. The environment wins; Off reads nothing;
 * a pasted link stays unless Compass found a newer one and "replace when newer" is on; From Compass reads this
 * week's plan, else last week's (none this week keeps last week's).
 */
export function effectivePlan(file: Pick<MorningBriefFile, "plan" | "found" | "previous">, env: string | null | undefined): { url: string | null; source: PlanSource } {
  const fromEnv = canonicalArtifactUrl(env);
  if (fromEnv) return { url: fromEnv, source: "env" };
  const p = file.plan;
  if (p.mode === "off") return { url: null, source: "off" };
  if (p.mode === "link") {
    const newer = p.replaceWhenNewer && file.found && (!p.linkAt || Date.parse(file.found.foundAt) > Date.parse(p.linkAt)) && file.found.url !== p.link;
    if (newer) return { url: file.found!.url, source: "found" };
    return p.link ? { url: p.link, source: "link" } : { url: null, source: "none" };
  }
  if (file.found) return { url: file.found.url, source: "found" };
  if (file.previous) return { url: file.previous.url, source: "previous" };
  return { url: null, source: "none" };
}

/** Whether a source provides the plan: it is on and has the "Posts the plan" role. */
export const planSources = (c: Pick<CompassSettings, "sources">): CompassSource[] => c.sources.filter(s => s.enabled && s.roles.includes("plan"));

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
  /** Read the plan's sources now (Compass's Read now, for the sources that post the plan). */
  find: z.boolean().optional(),
});
/** Who posts the plan is a Compass source now; a change naming a person or channels is refused with this line. */
export const PLAN_WHO_MOVED = "Who posts the plan is a Compass source now: give a source the role \"Posts the plan\" (set_compass, or Settings → Compass).";
export type PlanChange = z.infer<typeof planChangeSchema>;

/**
 * `set_compass` (and Settings → Compass): one change for every priority input (one-place-for-priority-inputs). The
 * Compass sources' own fields, plus `plan` (this week's plan: From Compass, a link, off), `inputs` (the built-in and
 * mcpproxy inputs: on/off, Retry, check, an Ask preview) and `queue` (the Linear queue's states and the chat and
 * calendar windows). The brief's own fields (sweep time, since, zone, workdays) stay with `set_brief_settings`.
 */
export const compassSetSchema = compassChangeSchema.extend({
  plan: planChangeSchema.optional(),
  inputs: sourcesChangeSchema.optional(),
  queue: queueChangeSchema.pick({ states: true, chatHours: true, calendarDays: true }).optional(),
});
export type CompassSet = z.infer<typeof compassSetSchema>;

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
  if (c.person !== undefined || c.channels !== undefined) return { ok: false, error: PLAN_WHO_MOVED };
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
  // Its person and channels move into a Compass source on the next read (moveToCompass).
  if (person && channels.length) { plan.mode = "compass"; plan.person = person; plan.channels = channels; }
  else if (url) { plan.mode = "link"; plan.link = url; plan.linkAt = at; }
  else return null;
  const posted = str(d.selected_shared_at, 40);
  const found = url && plan.mode === "compass" ? { url, postedAt: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null, where: str(d.selected_shared_in), foundAt: at, source: null } : null;
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

/** Every claude.ai artifact link in a message's text, canonical (no share key), in order. */
export function artifactLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(ARTIFACT.source, "g"))) { const u = canonicalArtifactUrl(m[0]); if (u && !out.includes(u)) out.push(u); }
  return out;
}

// ---------- the one-time move: Find it for me becomes a Compass source ----------

/** A chat id as Compass keeps it (the chat tool's own id). */
const compassId = (id: string | null) => id && /^[A-Za-z0-9._:-]{2,40}$/.test(id) ? id : null;

/**
 * Find it for me's person and channels as a Compass source that posts the plan and sets priorities, read in those
 * channels and the person's DM (design §2: "the one-time move"). The same person already a source gains the plan role
 * and the places it lacks, so nothing is listed twice. `resolve` gives a chat id for a name the old settings kept
 * without one (the chat search, server-side); a ref still without one stays in `unmoved`, by name, shown once in
 * Settings. Past the caps (sources, places) the rest stays in `unmoved` too. Pure: nothing here reads.
 */
export function moveToCompass(plan: PlanSettings, compass: CompassSettings, ctx: { now: number; newId: () => string; resolve?: Map<string, string> }): { plan: PlanSettings; compass: CompassSettings; moved: boolean } {
  const at = new Date(ctx.now).toISOString();
  const cleared = { ...plan, person: null, channels: [], movedAt: at };
  if (!plan.person && !plan.channels.length) return { plan: { ...plan, movedAt: at }, compass, moved: false };
  const idOf = (r: ChatRef, kind: "@" | "#") => compassId(r.id) ?? compassId(ctx.resolve?.get(`${kind}${r.name.toLowerCase()}`) ?? null);
  const unmoved: string[] = [];
  const personId = plan.person ? idOf(plan.person, "@") : null;
  if (!plan.person || !personId) {
    // No one to read: the channels alone would read everyone (a later release), so the whole thing waits, by name.
    return { plan: { ...cleared, unmoved: [...(plan.person ? [`@${plan.person.name}`] : []), ...plan.channels.map(c => `#${c.name}`)].slice(0, PLAN_CHANNELS_MAX + 1) }, compass, moved: false };
  }
  const person = { id: personId, name: plan.person.name };
  const places: Place[] = [{ kind: "conversation", sub: "dm", id: personId, name: person.name }];
  for (const ch of plan.channels) {
    const id = idOf(ch, "#");
    if (!id) { unmoved.push(`#${ch.name}`); continue; }
    places.push({ kind: "conversation", sub: "channel", id, name: ch.name });
  }
  const key = (p: Place) => `${p.kind}:${p.id}`;
  const sources = compass.sources.map(x => ({ ...x }));
  const same = sources.find(x => x.who.kind === "person" && x.who.person.id === personId);
  if (same) {
    const have = new Set(same.places.map(key));
    const add = places.filter(p => !have.has(key(p)));
    const room = COMPASS.places - same.places.length;
    unmoved.push(...add.slice(Math.max(room, 0)).map(p => p.kind === "conversation" && p.sub !== "dm" ? `#${p.name}` : `@${person.name}`));
    same.places = [...same.places, ...add.slice(0, Math.max(room, 0))];
    if (!same.roles.includes("plan")) same.roles = [...same.roles, "plan"];
    same.enabled = true;
  } else if (sources.length >= COMPASS.sources) {
    return { plan: { ...cleared, unmoved: [`@${person.name}`, ...plan.channels.map(c => `#${c.name}`)].slice(0, PLAN_CHANNELS_MAX + 1) }, compass, moved: false };
  } else {
    unmoved.push(...places.slice(COMPASS.places).map(p => `#${p.name}`));
    sources.push({
      id: ctx.newId(), label: `${person.name} · plan`.slice(0, COMPASS.labelChars), who: { kind: "person", person }, places: places.slice(0, COMPASS.places),
      roles: ["priorities", "plan"], instructions: "", enable_needs_you: true, enabled: true, addedBy: "developer", addedAt: at,
    });
  }
  return { plan: { ...cleared, unmoved: unmoved.slice(0, PLAN_CHANNELS_MAX + 1) }, compass: { ...compass, sources }, moved: true };
}

// ---------- plan items, matched ----------

/** A plan's items matched to issues and workspaces: an item's first key is its issue; one with no key has none. */
export function matchPlan(items: readonly { level?: string; title: string; keys?: readonly string[] }[], workspaceOf: (key: string) => string | null): { items: { title: string; issue: string | null; workspace: string | null }[]; withoutIssue: number } {
  const out = items.map(i => { const issue = i.keys?.[0]?.toUpperCase() ?? null; return { title: i.title, issue, workspace: issue ? workspaceOf(issue) : null }; });
  return { items: out, withoutIssue: out.filter(i => !i.issue).length };
}

// ---------- what Settings and the agent tools read ----------

/** What the plan read last saw (the ranker's cached read): its title, item count and how many have no issue, when. */
export type PlanRead = { url: string; at: string; title: string | null; items: number; withoutIssue?: number };
export type PlanView = {
  mode: PlanMode;
  link: string | null; linkAt: string | null;
  replaceWhenNewer: boolean;
  /** The link the brief and the ranker read, and where it comes from. */
  url: string | null; source: PlanSource;
  /** FOLLOW_UP_PLAN_URL, when set: it wins, and Settings shows it read-only. */
  env: string | null;
  found: FoundPlan | null; previous: FoundPlan | null;
  read: PlanRead | null;
  /** The Compass sources that post the plan (id, label), and the label of the one the plan in use came from. */
  sources: { id: string; label: string }[];
  /** Names the one-time move couldn't carry into Compass (no chat id found), to add by hand. */
  unmoved: string[];
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
  | { tone: "quiet"; title: string; line: string };

const names = (v: Pick<PlanView, "sources">) => v.sources.map(x => x.label).join(", ");
/** "14 items, 3 without an issue". */
export const itemsLine = (r: Pick<PlanRead, "items" | "withoutIssue">) =>
  `${r.items} ${r.items === 1 ? "item" : "items"}${r.withoutIssue ? `, ${r.withoutIssue} without an issue` : ""}`;

/**
 * The plan card: what the brief reads and how Follow-up got it. A plan in use is a neutral card with a check (§7: one
 * primary per screen); none this week is amber, keeps last week's and offers a paste field.
 */
export function planCard(v: Pick<PlanView, "mode" | "url" | "source" | "found" | "previous" | "read" | "sources" | "link" | "linkAt" | "replaceWhenNewer">, now: number, timeZone: string, reading = false): PlanCard | null {
  const when = (iso: string | null) => shortWhen(iso, now, timeZone);
  const readLine = v.read ? `read ${when(v.read.at) ?? ""}, ${itemsLine(v.read)}`.replace(" ,", ",") : reading ? "reading its title…" : "not read yet";
  const title = v.read?.title || "This week's plan";
  const from = (f: FoundPlan | null) => [v.sources.find(x => x.id === f?.source)?.label ?? null, f?.where ?? null].filter(Boolean).join(" in ");
  if (v.source === "env") return { tone: "ok", title, line: `Set by the environment (FOLLOW_UP_PLAN_URL) · ${readLine}`, url: v.url!, actions: ["open"] };
  if (v.mode === "off") return { tone: "quiet", title: "No plan", line: "The brief and AI priority read no weekly plan." };
  if (v.mode === "link") {
    if (!v.url) return null;
    if (v.source === "found") return { tone: "ok", title, line: `A newer one from ${from(v.found) || "Compass"}${when(v.found?.postedAt ?? null) ? `, ${when(v.found!.postedAt)}` : ""} · ${readLine}`, url: v.url, actions: ["open", "another"] };
    const rest = v.replaceWhenNewer && v.sources.length ? ` · replaced by a newer one from ${names(v)}` : "";
    return { tone: "ok", title, line: `Pasted ${when(v.linkAt) ?? ""} · ${readLine}${rest}`.replace("Pasted  ·", "Pasted ·"), url: v.url, actions: ["open"] };
  }
  // From Compass.
  if (!v.sources.length) return { tone: "quiet", title: "No source posts the plan", line: "Give a source the role Posts the plan, like your product lead's DM. The newest claude.ai artifact they share becomes this week's plan." };
  const kept = v.found ?? v.previous;
  if (!v.found && v.previous) return { tone: "warn", title: "No plan this week yet", line: `Nothing new from ${names(v)} links an artifact. The brief uses last week's until one shows up.`, paste: true, inUse: { line: `In use: last week's, posted ${when(v.previous.postedAt) ?? "earlier"}`, url: v.previous.url } };
  if (!kept || !v.url) return { tone: "quiet", title: "Waiting for a plan", line: `The newest claude.ai artifact ${names(v)} shares becomes this week's plan, as Compass reads it.` };
  const where = from(v.found);
  return { tone: "ok", title, line: `${where ? `From ${where}` : "From Compass"}${when(v.found!.postedAt) ? `, ${when(v.found!.postedAt)}` : ""} · ${readLine}`, url: v.url, actions: ["open", "another"] };
}

/**
 * Settings → Compass's line under the tab: the plan and the sweep. Built from the same card the screen shows, so the
 * line never says "found" while the card says otherwise.
 */
export function briefSummary(v: BriefSettingsView, now = Date.now(), sources?: { tone: "muted" | "warn"; text: string }): string {
  const card = planCard(v.plan, now, v.clock.timeZone);
  const plan = v.plan.source === "env" ? "plan set by the environment" : v.plan.mode === "off" ? "no plan"
    : v.plan.mode === "link" ? (v.plan.source === "found" ? "a newer plan from Compass" : "plan from a link")
    : !card || card.tone === "quiet" ? (card?.title.startsWith("No source") ? "no source posts the plan" : "waiting for the plan")
    : card.tone === "ok" ? "this week's plan in" : "using last week's plan";
  // A source that failed or needs a sign-in leads the line (the source list says which).
  return `${sources?.tone === "warn" ? `${sources.text} · ` : ""}Sweeps ${v.queue.sweepAt} on workdays · ${plan}`;
}
