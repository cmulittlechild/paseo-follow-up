import { z } from "zod";

/**
 * The Morning brief's sources (docs/morning-brief.md#sources): every source is found by the tools mcpproxy exposes,
 * never by a server's name (nothing-built-in-about-a-workplace). A **recipe** is data: the tools a server must have
 * (matched by name shape and input schema), what it adds to the brief and what it costs. Only tools mcpproxy lists as
 * read-only are ever matched or called (sources-are-read-only). Pure: discovery and the reads are
 * server/source-tools.ts and server/brief-sources.ts.
 */

// ---------- what mcpproxy says ----------

/** One upstream server, from `mcpproxy upstream list -o json` (only the fields the brief reads). */
export type Upstream = { name: string; enabled: boolean; connected: boolean; authenticated: boolean; oauth: boolean; quarantined: boolean; action: string | null; summary: string | null; tools: number };
/** One read-only tool, from `mcpproxy tools list --risk read -o json`: its server, bare name, description and inputs. */
export type ReadTool = { server: string; name: string; description: string; props: string[]; required: string[] };

const str = (v: unknown) => typeof v === "string" ? v : null;
const list = (text: string): unknown[] => {
  try { const j = JSON.parse(text.slice(Math.max(0, text.search(/[[{]/)))) as unknown; return Array.isArray(j) ? j : Object.values(j as object).find(Array.isArray) as unknown[] ?? []; }
  catch { return []; }
};

export function parseUpstreams(text: string): Upstream[] {
  const out: Upstream[] = [];
  for (const u of list(text)) {
    const o = u as Record<string, unknown> | null;
    const name = str(o?.name)?.trim();
    if (!o || !name) continue;
    const health = (o.health ?? {}) as Record<string, unknown>;
    out.push({
      name, enabled: o.enabled !== false, connected: o.connected === true, authenticated: o.authenticated === true, oauth: !!o.oauth, quarantined: o.quarantined === true,
      action: str(health.action), summary: str(health.summary)?.slice(0, 160) ?? null, tools: typeof o.tool_count === "number" ? o.tool_count : 0,
    });
  }
  return out;
}

/** Read tools only: a tool whose annotations say it isn't read-only is dropped even if the list had it. */
export function parseReadTools(text: string): ReadTool[] {
  const out: ReadTool[] = [];
  for (const t of list(text)) {
    const o = t as Record<string, unknown> | null;
    const server = str(o?.server_name)?.trim(); const raw = str(o?.name)?.trim();
    if (!o || !server || !raw) continue;
    if ((o.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === false) continue;
    // Some lists prefix the server ("server:tool" or "server__tool"); the brief keeps the bare name.
    const name = raw.startsWith(`${server}:`) ? raw.slice(server.length + 1) : raw.startsWith(`${server}__`) ? raw.slice(server.length + 2) : raw;
    const schema = (o.schema ?? o.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
    out.push({ server, name, description: (str(o.description) ?? "").slice(0, 1200), props: Object.keys(schema.properties ?? {}), required: Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [] });
  }
  return out;
}

// ---------- recipes ----------

type Matcher = {
  /** The tool's bare name. */
  name: RegExp;
  /** Never these names (a message search isn't a user search). */
  not?: RegExp;
  /** Every one of these inputs. */
  props?: string[];
  /** At least one of these inputs. */
  anyProps?: string[];
  /** The tool's description. */
  description?: RegExp;
  /** Among several that fit, the one whose name says it reaches further (private channels and DMs too). */
  prefer?: RegExp;
};
export const RECIPE_IDS = ["linear", "chat", "calendar", "mail"] as const;
export type RecipeId = typeof RECIPE_IDS[number];
export type Recipe = {
  id: RecipeId;
  label: string;
  /** What it adds to the brief, in the developer's words. */
  adds: string;
  /** What a morning costs. */
  cost: string;
  /** Mail is off until turned on (it reads the most personal source). */
  defaultOn: boolean;
  /** Why it starts off, for a recipe that does. */
  offWhy?: string;
  roles: Record<string, Matcher>;
  /** The roles a server must have to match. */
  required: string[];
};

/**
 * The recipes, most specific first: a server takes the first recipe it matches, so a chat server is never also mail.
 * Nothing here names a company, a server instance, a person or an id.
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: "linear", label: "Linear", adds: "Your issue queue, swept each workday morning", cost: "about 7 lookups a morning", defaultOn: true,
    roles: { list_issues: { name: /^list_issues$/ }, get_issue: { name: /^get_issue$/ }, get_user: { name: /^get_user$/ }, list_teams: { name: /^list_teams$/ } },
    required: ["list_issues", "get_issue"],
  },
  {
    id: "chat", label: "Chat", adds: "DMs and mentions in the chat window, and this week's plan link", cost: "2 lookups, plus 1 for the plan", defaultOn: true,
    roles: {
      messages: { name: /search/, not: /user|people|channel|file|emoji/, props: ["filters"], anyProps: ["keywords", "query", "natural_language_query"], prefer: /private|dm|all/ },
      channels: { name: /search_?channels|channels_?search/ },
      people: { name: /search_?users|users_?search|search_?people/ },
      thread: { name: /read_?thread/ },
    },
    required: ["messages", "channels"],
  },
  {
    id: "calendar", label: "Calendar", adds: "Your meetings", cost: "1 lookup", defaultOn: true,
    roles: { events: { name: /(list|search)[-_]?events|events[-_]?(list|search)/, anyProps: ["timeMin", "time_min", "start", "startTime", "start_time", "from", "after"] } },
    required: ["events"],
  },
  {
    id: "mail", label: "Mail", adds: "Unread mail addressed to you that asks something", cost: "1 lookup", defaultOn: false, offWhy: "Off by default: it reads your inbox.",
    roles: { messages: { name: /(search|list)[-_]?(e?mails?|messages|threads)/, anyProps: ["query", "q", "search"], description: /e-?mail|inbox/i } },
    required: ["messages"],
  },
];
export const recipe = (id: RecipeId): Recipe => RECIPES.find(r => r.id === id)!;

const fits = (t: ReadTool, m: Matcher) => m.name.test(t.name) && !(m.not?.test(t.name)) && (m.props ?? []).every(p => t.props.includes(p))
  && (!m.anyProps || m.anyProps.some(p => t.props.includes(p))) && (!m.description || m.description.test(t.description));

/** The recipe a server's read tools match, and the tool for each role it has. Null: no recipe fits. */
export function matchRecipe(tools: readonly ReadTool[]): { recipe: RecipeId; roles: Record<string, string> } | null {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of RECIPES) {
    const roles: Record<string, string> = {};
    for (const [role, m] of Object.entries(r.roles)) {
      const all = sorted.filter(x => fits(x, m));
      const t = (m.prefer && all.find(x => m.prefer!.test(x.name))) || all[0];
      if (t) roles[role] = t.name;
    }
    if (r.required.every(role => roles[role])) return { recipe: r.id, roles };
  }
  return null;
}

/** Every server's match, in the order mcpproxy lists servers. */
export type Matched = { server: string; recipe: RecipeId | null; roles: Record<string, string>; readTools: number };
export function matchServers(tools: readonly ReadTool[]): Matched[] {
  const by = new Map<string, ReadTool[]>();
  for (const t of tools) by.set(t.server, [...by.get(t.server) ?? [], t]);
  return [...by].map(([server, ts]) => { const m = matchRecipe(ts); return { server, recipe: m?.recipe ?? null, roles: m?.roles ?? {}, readTools: ts.length }; });
}

/** `server:tool` for a recipe's role: the first server that matches (and is allowed), else null. */
export function toolFor(matched: readonly Matched[], id: RecipeId, role: string, allowed: (server: string) => boolean = () => true): string | null {
  const m = matched.find(x => x.recipe === id && x.roles[role] && allowed(x.server));
  return m ? `${m.server}:${m.roles[role]}` : null;
}

/** The developer's own chat id, as a chat tool describes it ("Current logged in user's user_id is U…"). */
export function selfIdFrom(tools: readonly ReadTool[]): string | null {
  for (const t of tools) { const m = /user_id is ([A-Z][A-Z0-9]{6,})/.exec(t.description); if (m) return m[1]; }
  return null;
}

/** Only the inputs a tool takes: a recipe's call carries what that tool's schema has, nothing else. */
export function fitArgs(props: readonly string[], args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k, v]) => props.includes(k) && v !== undefined));
}

/** A time range in whatever inputs the tool takes: timeMin/timeMax, start/end, from/to, after/before. */
export function rangeArgs(props: readonly string[], start: string, end: string, timeZone: string | null): Record<string, unknown> {
  const pick = (names: string[]) => names.find(n => props.includes(n));
  const lo = pick(["timeMin", "time_min", "start", "startTime", "start_time", "from", "after"]);
  const hi = pick(["timeMax", "time_max", "end", "endTime", "end_time", "to", "before"]);
  const zone = pick(["timeZone", "time_zone", "timezone", "tz"]);
  return { ...(lo ? { [lo]: start } : {}), ...(hi ? { [hi]: end } : {}), ...(zone && timeZone ? { [zone]: timeZone } : {}) };
}

// ---------- parsing what a calendar or mail tool returns ----------

export type BriefEvent = { title: string; start: string | null; url: string | null };
export type BriefMail = { from: string | null; subject: string; at: string | null; url: string | null };

/** Every object in a JSON reply (the reply is often JSON inside a text block, or JSON inside a string field). */
function objects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || out.length > 400) return;
    if (typeof v === "string" && /^\s*[[{]/.test(v)) { try { walk(JSON.parse(v), depth + 1); } catch { /* text */ } return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === "object") { out.push(v as Record<string, unknown>); for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  try { walk(JSON.parse(text), 0); } catch { /* not JSON */ }
  return out;
}
const firstStr = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) { const v = o[k]; if (typeof v === "string" && v.trim()) return v.trim(); } return null; };
const when = (v: unknown): string | null => typeof v === "string" ? v : v && typeof v === "object" ? firstStr(v as Record<string, unknown>, ["dateTime", "date_time", "date"]) : null;
const httpUrl = (s: string | null) => s && /^https?:\/\//.test(s) ? s.slice(0, 500) : null;

/** Today's meetings from a calendar reply: JSON events with a title and a start, else markdown/text lines. At most 20. */
export function parseEvents(text: string): BriefEvent[] {
  const seen = new Set<string>(); const out: BriefEvent[] = [];
  for (const o of objects(text)) {
    const title = firstStr(o, ["title", "summary", "subject", "name"]);
    const start = when(o.start ?? o.startTime ?? o.start_time ?? o.startDate);
    if (!title || !start) continue;
    const k = `${title}|${start}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ title: title.slice(0, 160), start: start.slice(0, 40), url: httpUrl(firstStr(o, ["htmlLink", "url", "link", "meetingUrl", "hangoutLink"])) });
  }
  if (!out.length) {
    // Text form: "- 10:00–10:30 Standup" or "10:00 Standup".
    for (const m of text.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?(\d{1,2}:\d{2})(?:\s*[-–]\s*\d{1,2}:\d{2})?(?:\*\*)?\s*[:·-]?\s*(.{2,160})$/gm)) out.push({ title: m[2].trim(), start: m[1], url: null });
  }
  return out.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")).slice(0, 20);
}

/** Unread mail from a mail reply: JSON messages with a subject. At most 20. */
export function parseMail(text: string): BriefMail[] {
  const seen = new Set<string>(); const out: BriefMail[] = [];
  for (const o of objects(text)) {
    const subject = firstStr(o, ["subject", "title"]);
    if (!subject) continue;
    const from = firstStr(o, ["from", "sender", "fromName", "from_name"]) ?? (o.from && typeof o.from === "object" ? firstStr(o.from as Record<string, unknown>, ["name", "email", "address"]) : null);
    const at = firstStr(o, ["date", "receivedAt", "received_at", "internalDate", "sentAt"]);
    const k = `${from}|${subject}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ from: from?.slice(0, 80) ?? null, subject: subject.slice(0, 200), at: at?.slice(0, 40) ?? null, url: httpUrl(firstStr(o, ["url", "link", "webLink"])) });
  }
  return out.slice(0, 20);
}

// ---------- the sources the brief shows ----------

export const SOURCE_HEALTH = ["ok", "sign-in", "failed", "off"] as const;
export type SourceHealthState = typeof SOURCE_HEALTH[number];
export const SOURCE_KINDS = ["recipe", "builtin", "unknown", "skipped"] as const;
/** The built-in sources: GitHub (every `gh` account) and Paseo itself (Follow-up's own state, always on). */
export const GITHUB_SOURCE = "gh";
export const PASEO_SOURCE = "paseo";
export const sourceId = (server: string) => `mcp:${server}`;

export const briefSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  recipe: z.enum(RECIPE_IDS).nullable(),
  label: z.string(),
  /** The mcpproxy server, for mcpproxy sources. */
  server: z.string().nullable(),
  adds: z.string(),
  cost: z.string().nullable(),
  on: z.boolean(),
  /** Whether the developer (or an agent) can turn it on or off. Paseo can't; a source with no recipe can't yet. */
  canToggle: z.boolean(),
  health: z.enum(SOURCE_HEALTH),
  /** One short line: why it isn't ok, or what it read. */
  detail: z.string().nullable(),
  /** A command that fixes it (a sign-in), shown to copy. */
  command: z.string().nullable(),
  /** When the brief last read it (ok or not). */
  readAt: z.string().nullable(),
  readTools: z.number().int(),
});
export type BriefSource = z.infer<typeof briefSourceSchema>;

/** What the last read of a source said, kept by the reader (the ranker, the sweep, a Retry). */
export type SourceRead = { at: string; ok: boolean; error: string | null };

/** An upstream's own health: turned off, quarantined, waiting for a sign-in, not connected, or fine. */
export function upstreamHealth(u: Upstream | undefined): { health: SourceHealthState; detail: string | null; command?: string } {
  if (!u) return { health: "failed", detail: "mcpproxy no longer lists it." };
  if (!u.enabled) return { health: "off", detail: "Turned off in mcpproxy." };
  if (u.quarantined) return { health: "failed", detail: "Quarantined in mcpproxy: approve it there first." };
  if (/login|auth/i.test(u.action ?? "") || (u.oauth && !u.authenticated && !u.connected)) return { health: "sign-in", detail: "Needs a sign-in in mcpproxy, or connect it on claude.ai.", command: "mcpproxy auth login" };
  if (!u.connected) return { health: "failed", detail: u.summary ? `Not connected: ${u.summary}` : "Not connected." };
  return { health: "ok", detail: null };
}

/**
 * The Sources card's rows: every mcpproxy server (a recipe's source, one with no recipe yet, or one with no read tools)
 * plus GitHub and Paseo. `on` holds the developer's choices; a recipe's default applies otherwise. A source that is on
 * and whose upstream is fine shows its last read: failed with the read's one line, else ok.
 */
export function briefSources(input: {
  upstreams: readonly Upstream[]; matched: readonly Matched[]; on: Readonly<Record<string, boolean>>;
  reads: Readonly<Record<string, SourceRead | undefined>>; github: { accounts: number | null };
}): BriefSource[] {
  const rows: BriefSource[] = [];
  const matchedBy = new Map(input.matched.map(m => [m.server, m]));
  const names = [...new Set([...input.upstreams.map(u => u.name), ...input.matched.map(m => m.server)])];
  for (const server of names) {
    const id = sourceId(server);
    const u = input.upstreams.find(x => x.name === server);
    const m = matchedBy.get(server);
    const r = m?.recipe ? recipe(m.recipe) : null;
    const read = input.reads[id];
    const up = upstreamHealth(u);
    if (r) {
      const on = input.on[id] ?? r.defaultOn;
      const health = !on ? "off" : up.health !== "ok" ? up.health : read && !read.ok ? "failed" : "ok";
      const detail = !on ? (input.on[id] === false ? "Off in the brief." : r.offWhy ?? "Off until you turn it on.") : up.health !== "ok" ? up.detail : read && !read.ok ? read.error : null;
      rows.push({ id, kind: "recipe", recipe: r.id, label: r.label, server, adds: r.adds, cost: r.cost, on, canToggle: true, health, detail, command: on && up.health === "sign-in" ? up.command ?? null : null, readAt: read?.at ?? null, readTools: m!.readTools });
    } else {
      const readTools = m?.readTools ?? 0;
      rows.push({
        id, kind: readTools ? "unknown" : "skipped", recipe: null, label: server, server,
        adds: readTools ? "Not a kind of source the brief can read yet." : "Only has tools that change things, so the brief stays away.",
        cost: null, on: false, canToggle: false, health: up.health === "ok" ? "off" : up.health, detail: up.health === "ok" ? null : up.detail, command: null, readAt: null, readTools,
      });
    }
  }
  const gh = input.reads[GITHUB_SOURCE];
  const ghOn = input.on[GITHUB_SOURCE] ?? true;
  rows.push({
    id: GITHUB_SOURCE, kind: "builtin", recipe: null, label: "GitHub", server: null,
    adds: (input.github.accounts ?? 0) > 1 ? `Review requests on your ${input.github.accounts} gh accounts` : "Review requests for you", cost: (input.github.accounts ?? 0) > 1 ? "1 lookup per account" : "1 lookup",
    on: ghOn, canToggle: true,
    // accounts null: gh didn't answer in time; the last read decides.
    health: !ghOn ? "off" : input.github.accounts === 0 ? "sign-in" : gh && !gh.ok ? "failed" : "ok",
    detail: !ghOn ? "Off in the brief." : input.github.accounts === 0 ? "Needs a sign-in to the GitHub CLI." : gh && !gh.ok ? gh.error : null,
    command: ghOn && input.github.accounts === 0 ? "gh auth login" : null,
    readAt: gh?.at ?? null, readTools: 0,
  });
  rows.push({ id: PASEO_SOURCE, kind: "builtin", recipe: null, label: "Paseo", server: null, adds: "Your workspaces, their asks and PRs", cost: "no outside calls", on: true, canToggle: false, health: "ok", detail: null, command: null, readAt: null, readTools: 0 });
  return rows;
}

/** The brief's one Sources sentence: muted "5 sources read" until something fails, then what failed. */
export function sourcesLine(rows: readonly BriefSource[]): { tone: "muted" | "warn"; text: string } {
  const used = rows.filter(r => r.on && r.kind !== "unknown" && r.kind !== "skipped");
  const bad = used.filter(r => r.health === "failed" || r.health === "sign-in");
  if (!bad.length) return { tone: "muted", text: `${used.length} source${used.length === 1 ? "" : "s"} read` };
  return { tone: "warn", text: bad.map(r => `${r.label} ${r.health === "sign-in" ? "needs a sign-in" : "failed"}`).join(" · ") };
}

// ---------- changes ----------

export const sourcesChangeSchema = z.strictObject({
  /** Turn sources on or off by id (`mcp:<server>`, `gh`). */
  on: z.record(z.string().min(1).max(120), z.boolean()).optional(),
  /** Read one source again now (its Retry): one read, the result kept as its health. */
  retry: z.string().min(1).max(120).optional(),
  /** Check sources again: ask mcpproxy what it has now. */
  check: z.boolean().optional(),
});
export type SourcesChange = z.infer<typeof sourcesChangeSchema>;

/** A change, checked against the sources there are: unknown ids, Paseo and sources with no recipe are refused. */
export function applySourcesChange(on: Readonly<Record<string, boolean>>, rows: readonly BriefSource[], change: SourcesChange): { ok: true; on: Record<string, boolean> } | { ok: false; error: string } {
  const next = { ...on };
  for (const [id, value] of Object.entries(change.on ?? {})) {
    const row = rows.find(r => r.id === id);
    if (!row) return { ok: false, error: `No source ${id}. brief_sources lists them.` };
    if (!row.canToggle) return { ok: false, error: row.kind === "builtin" ? `${row.label} is always read.` : `${row.label} has no recipe yet, so the brief can't read it.` };
    next[id] = value;
  }
  if (change.retry && !rows.some(r => r.id === change.retry)) return { ok: false, error: `No source ${change.retry}. brief_sources lists them.` };
  return { ok: true, on: next };
}

/** `checking`: mcpproxy is being asked now; `retrying`: sources being read again now (the card polls until both clear). */
export type SourcesView = { sources: BriefSource[]; checkedAt: string | null; error: string | null; line: ReturnType<typeof sourcesLine>; checking: boolean; retrying: string[] };
