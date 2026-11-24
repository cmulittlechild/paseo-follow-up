import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { NoSourceError, type SourceDirectory } from "./source-tools";
import type { AiJobs } from "./ai-jobs";
import type { MorningBriefStore } from "./morning-brief";
import { artifactLinks, parseChatRefs } from "../shared/morning-brief";
import { isWorkday, zoned, type Clock } from "../shared/linear-queue";
import {
  COMPASS, EXTRACT_SYSTEM, ROLE_INFO, applyCompassChange, batchItems, compassFileSchema, emptyCompassFile, extractPrompt, extractReplySchema, guardedProvider,
  HAND_LABEL, HAND_SOURCE, applyNoteAction, noteLines, noteWho, tellText, type NoteAction,
  noteRole, parseConversation, placeKey, placeNote, presetsView, rankNotes, settleNotes, unguardedWhy, validateExtraction, whoFilter,
  type CompassChange, type CompassFile, type CompassItem, type CompassNote, type CompassSettings, type CompassSource, type Place, type PlaceIndex, type RankCompassNote, type RefuseCode,
} from "../shared/compass";

export class CompassStore extends JsonFileStore<CompassFile> {
  constructor(directory: string) {
    super({ path: join(directory, "compass.json"), schema: compassFileSchema as never, empty: emptyCompassFile });
  }
}

export type CompassDeps = {
  /** morning-brief.json: Compass's settings live beside the brief's (Settings → Morning brief, the Compass card). */
  settings: MorningBriefStore;
  store: CompassStore;
  tools: SourceDirectory;
  jobs: AiJobs;
  /** The Summaries role (Settings → Agents): the fast model extraction runs on, and the provider's display name. */
  role: () => Promise<{ provider: string; model: string | null; thinking: string | null; label: string }>;
  clock: () => Promise<Clock>;
  /** The sweep time (HH:MM): the morning read runs once a workday after it, with the sweep. */
  sweepAt: () => Promise<string>;
  /** Built once per read from state the worker holds: workspaces, issue keys → workspace, no reads of its own. */
  index: () => Promise<Omit<PlaceIndex, "glossary">>;
  /** The brief's Chat switch: which servers may be read (a chat source turned off isn't read). Throws when off. */
  allowed?: () => Promise<((server: string) => boolean) | undefined>;
  tight?: () => boolean;
  /**
   * Tell the agent (compass-reaches-an-agent-only-by-a-click): one queued message to the workspace's main agent
   * (invariant 36). Null when the workspace has no main agent to tell. The only way a note reaches an agent.
   */
  tell?: (workspaceId: string, text: string, by: string) => Promise<{ agentId: string } | null>;
  /**
   * A "Posts the plan" source shared a claude.ai artifact (plans come from Compass on arrival): the brief records it as
   * this week's plan and reads its title at once (MorningBrief.recordPlan). Resolves whether it was new.
   */
  onPlan?: (found: { url: string; postedAt: string; where: string; source: string }) => Promise<boolean>;
  /** Notes changed: AI priority's next tick runs once (Ranker.markDue) and the feeds push. */
  onChange?: () => void;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
};

/** One line for a failed read: a timeout, mcpproxy's first line, or the error's. Never the text read. */
function readError(e: unknown): string {
  const x = e as { killed?: unknown; signal?: unknown; message?: unknown };
  if (x?.killed || x?.signal === "SIGTERM") return "The chat tool didn't answer in time.";
  const m = typeof x?.message === "string" ? x.message.split("\n")[0] : String(e);
  return /^Command failed/i.test(m) ? "mcpproxy couldn't run the read." : m.slice(0, 200);
}

/** The cursor a page reply carries for the next page ("cursor: `…`", or JSON next_cursor). */
const nextCursor = (reply: string) => /next_cursor"?\s*[:=]\s*"([^"]+)"/.exec(reply)?.[1] ?? /cursor[^`\n]{0,40}`([^`]{4,200})`/.exec(reply)?.[1] ?? null;

export type CompassView = {
  settings: CompassSettings;
  readers: { conversation: boolean; history: boolean };
  presets: ReturnType<typeof presetsView>;
  /** Null: Compass reads. Else the one line why it doesn't (the Summaries provider has no guard). */
  blocked: string | null;
  places: Record<string, { status: string; readAt: string | null; at: string | null; error: string | null }>;
  notes: CompassNote[];
  /** The titles of the workspaces the live notes went to, so a note names where it went. */
  workspaces: Record<string, string>;
  unplaced: number;
  lastRead: CompassFile["lastRead"];
  today: { extractions: number; cap: number };
  running: boolean;
};

/**
 * Compass (docs/compass.md): reads the places its sources name, by cursor in time order (compass-reads-only-what-was-named),
 * turns what the source's people said into notes on the Summaries role's fast model with no tools (compass-text-is-data),
 * validates every note against what was said (a-compass-note-quotes-its-source), places it, and keeps it until it ends
 * (a-compass-note-ends). Once a workday after the sweep time from the worker's 15 s loop (the-brief-has-one-timer), on
 * Read now, and over the last week when a place is added.
 */
export class Compass {
  private reading: Promise<CompassFile["lastRead"]> | null = null;
  constructor(private d: CompassDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private newId(prefix: string) { return this.d.newId?.() ?? `${prefix}${randomBytes(5).toString("hex")}`; }

  async settings(): Promise<CompassSettings> { return (await this.d.settings.read()).compass; }

  /** Which readers a connected tool has, from what discovery last found (Settings answers at once; unknown counts as there). */
  async readers(fresh = false): Promise<{ conversation: boolean; history: boolean }> {
    const found = fresh ? await this.d.tools.discover().catch(() => null) : this.d.tools.cached();
    if (!found) return { conversation: true, history: true };
    const chat = found.matched.filter(m => m.recipe === "chat");
    return { conversation: chat.some(m => m.roles.messages || m.roles.history), history: chat.some(m => m.roles.history) };
  }

  /** Null when Compass may read: the Summaries role runs on a provider Follow-up can guard (Claude, Codex). */
  async blocked(): Promise<string | null> {
    const r = await this.d.role();
    return guardedProvider(r.provider) ? null : unguardedWhy(r.label);
  }

  async view(opts: { workspace?: string } = {}): Promise<CompassView> {
    const [settings, file, readers, blocked] = await Promise.all([this.settings(), this.d.store.read(), this.readers(), this.blocked()]);
    const today = zoned(this.now(), (await this.d.clock()).timeZone).day;
    const live = file.notes.filter(n => n.state === "live" && (!opts.workspace || n.match.workspace === opts.workspace));
    const placed = new Set(live.flatMap(n => n.match.workspace ? [n.match.workspace] : []));
    const workspaces = placed.size ? Object.fromEntries((await this.d.index().catch(() => ({ workspaces: [] as { id: string; title: string }[] }))).workspaces.filter(w => placed.has(w.id)).map(w => [w.id, w.title])) : {};
    return {
      settings, readers, presets: presetsView(readers), blocked,
      places: Object.fromEntries(Object.entries(file.cursors).map(([k, c]) => [k, { status: c.status, readAt: c.readAt, at: c.at, error: c.error }])),
      notes: live, workspaces, unplaced: live.filter(n => !n.match.workspace).length, lastRead: file.lastRead,
      today: { extractions: file.day?.date === today ? file.day.extractions : 0, cap: COMPASS.extractionsPerDay }, running: !!this.reading,
    };
  }

  /**
   * Change the settings (Settings and a confirmed set_compass send the same change). A source added or given new places
   * is read at once over the last week, in the background, so it is useful right away.
   */
  async set(change: CompassChange, by: string, opts: { workspaceExists?: (id: string) => boolean } = {}): Promise<CompassView> {
    const before = await this.settings();
    const readers = await this.readers();
    const r = applyCompassChange(before, change, { now: this.now(), newId: () => this.newId("s-"), by, readers, workspaceExists: opts.workspaceExists });
    if (!r.ok) throw new Error(r.error);
    await this.d.settings.mutate(f => { f.compass = r.settings; });
    if (change.remove) await this.d.store.mutate(f => { f.notes = f.notes.map(n => n.source === change.remove && n.state === "live" ? { ...n, state: "unpinned", endedAt: new Date(this.now()).toISOString() } : n); });
    const was = before.sources.find(s => s.id === r.touched);
    const now = r.settings.sources.find(s => s.id === r.touched);
    const fresh = now && now.enabled && now.places.some(p => !was?.places.some(q => placeKey(q) === placeKey(p)));
    if (fresh) void this.read("added", { source: now!.id }).catch(() => undefined);
    if (change.remove || change.glossary) this.d.onChange?.();
    return this.view();
  }

  /** The morning read: once a workday after the sweep time, with the sweep (never on its own timer). */
  async tick(): Promise<void> {
    if (this.reading || this.d.tight?.()) return;
    const settings = await this.settings();
    if (!settings.sources.some(s => s.enabled && s.roles.some(r => ROLE_INFO[r].extracts))) return;
    const clock = await this.d.clock();
    const now = this.now();
    const z = zoned(now, clock.timeZone);
    const file = await this.d.store.read();
    if (!isWorkday(now, clock) || file.readDay === z.day) return;
    const [h, m] = (await this.d.sweepAt()).split(":").map(Number);
    if (z.hour * 60 + z.minute < h * 60 + m) return;
    await this.d.store.mutate(f => { f.readDay = z.day; });
    await this.read("morning");
  }

  /** Read now (Settings' Read now, read_compass): every enabled source, or one. Joins a read already going. */
  read(trigger: "morning" | "manual" | "agent" | "added", opts: { source?: string; plans?: boolean } = {}): Promise<CompassFile["lastRead"]> {
    return this.reading ??= this.readOnce(trigger, opts).finally(() => { this.reading = null; });
  }
  /** Read now, waiting at most `ms`; then `running` (read_compass). */
  async readWithin(trigger: "manual" | "agent", ms = COMPASS.waitMs): Promise<{ running: true } | { running: false; lastRead: CompassFile["lastRead"] }> {
    const p = this.read(trigger);
    const timeout = new Promise<"t">(resolve => { const t = setTimeout(() => resolve("t"), ms); t.unref?.(); });
    const r = await Promise.race([p, timeout]);
    return r === "t" ? { running: true } : { running: false, lastRead: r };
  }

  private async readOnce(trigger: string, opts: { source?: string; plans?: boolean }): Promise<CompassFile["lastRead"]> {
    const at = new Date(this.now()).toISOString();
    const settings = await this.settings();
    const sources = settings.sources.filter(s => s.enabled && (!opts.source || s.id === opts.source) && (!opts.plans || s.roles.includes("plan")) && noteRole(s.roles));
    const blocked = await this.blocked();
    const finish = async (ok: boolean, notes: number, error: string | null) => {
      const lastRead = { at, trigger, ok, notes, error };
      await this.d.store.mutate(f => { f.lastRead = lastRead; });
      return lastRead;
    };
    // No guard on this provider: nothing is read at all, so no one's words reach a model that has tools.
    if (blocked) return finish(false, 0, blocked);
    if (!sources.length) return finish(true, 0, null);
    const index = { ...await this.d.index(), glossary: settings.glossary };
    let made = 0; const errors: string[] = [];
    for (const source of sources) {
      for (const place of source.places) {
        try { made += await this.readPlace(source, place, settings, index); }
        catch (e) { errors.push(`${source.label}: ${readError(e)}`); }
      }
    }
    if (made) this.d.onChange?.();
    return finish(!errors.length, made, errors[0] ?? null);
  }

  /** One place: read since its cursor, keep the source's words, extract, validate, place, settle. Returns notes made. */
  private async readPlace(source: CompassSource, place: Place, settings: CompassSettings, index: PlaceIndex): Promise<number> {
    const key = placeKey(place);
    const now = this.now();
    const readAt = new Date(now).toISOString();
    const file = await this.d.store.read();
    const cursor = file.cursors[key];
    const since = cursor?.at ? Date.parse(cursor.at) : now - COMPASS.firstReadDays * 86_400_000;
    const setCursor = (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) =>
      this.d.store.mutate(f => { f.cursors[key] = { at: f.cursors[key]?.at ?? cursor?.at ?? null, readAt, error: null, ...patch }; });
    if (place.kind !== "conversation") { await setCursor({ status: "failed", error: "No reader for this kind of place in this release." }); return 0; }

    const clock = await this.d.clock();
    const today = zoned(now, clock.timeZone).day;
    const used = file.day?.date === today ? file.day.extractions : 0;
    if (used >= COMPASS.extractionsPerDay) { await setCursor({ status: "paused", error: `Paused until tomorrow: ${COMPASS.extractionsPerDay} reads today.` }); return 0; }

    let read: { messages: ReturnType<typeof parseConversation>; slow: boolean; partial: boolean };
    try { read = await this.readConversation(place, since); }
    catch (e) {
      // A read that can't reach the cursor keeps it, and the next read covers the gap.
      await setCursor({ status: "failed", error: e instanceof NoSourceError ? "No connected chat tool can read this conversation." : readError(e) });
      throw e;
    }
    const self = await this.d.tools.selfId(await this.d.allowed?.()).catch(() => null);
    const whose = whoFilter(source.who, self);
    const items: CompassItem[] = [];
    let newest = since;
    // Oldest first, one item per message (a page overlap reads a message twice).
    const seen = new Set<string>();
    for (const m of [...read.messages].sort((a, b) => a.at.localeCompare(b.at))) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const t = Date.parse(m.at);
      if (!(t > since)) continue;
      newest = Math.max(newest, t);
      const kind = whose(m.by);
      if (kind) items.push({ id: `m${items.length + 1}`, by: m.by, at: m.at, link: m.link, text: m.text, ...(kind === "context" ? { context: true } : {}) });
    }
    // Plans come from Compass on arrival: the newest claude.ai artifact the source's people shared here.
    if (source.roles.includes("plan") && this.d.onPlan) {
      const posted = items.filter(i => !i.context).flatMap(i => artifactLinks(i.text).map(url => ({ url, at: i.at }))).sort((a, b) => b.at.localeCompare(a.at))[0];
      const where = place.sub === "dm" ? "their DM" : `#${place.name}`;
      if (posted) await this.d.onPlan({ url: posted.url, postedAt: posted.at, where, source: source.id }).catch(() => false);
    }
    const status = read.slow ? "slow-path" as const : "ok" as const;
    const partialNote = read.partial ? `More than ${COMPASS.pagesMax * COMPASS.pageSize} messages since the last read; the newest were read.` : null;
    if (!items.some(i => !i.context)) {
      await setCursor({ status, at: new Date(newest).toISOString(), error: partialNote });
      return 0;
    }
    const role = await this.d.role();
    const open = file.notes.filter(n => n.state === "live" && n.source === source.id);
    let made = 0; let extractions = used; let rest = items; let cursorAt = since;
    const refused: RefuseCode[] = [];
    while (rest.some(i => !i.context)) {
      if (extractions >= COMPASS.extractionsPerDay) break;
      const { batch } = batchItems(rest);
      const r = await this.d.jobs.run({
        name: "compass-extract", outside: true, system: EXTRACT_SYSTEM, schema: extractReplySchema, provider: role.provider, model: role.model ?? undefined, thinking: role.thinking,
        prompt: extractPrompt({ source, global: settings.instructions, items: batch, open, now, clock }), maxPromptChars: 24_000, maxOutputChars: 8_000, timeoutMs: 90_000,
      });
      extractions++;
      await this.d.store.mutate(f => { f.day = { date: today, extractions }; });
      if (!r.ok) { await setCursor({ status: "failed", at: cursorAt ? new Date(cursorAt).toISOString() : null, error: `The model couldn't read it (${r.reason}).` }); return made; }
      const v = validateExtraction(r.value, { source, items: batch, open, glossary: settings.glossary, instructions: settings.instructions, clock, now, newId: () => this.newId("n-") });
      refused.push(...v.refused);
      const fresh = v.notes.map(n => { const note = { ...n, place: key }; return { ...note, match: placeNote(note, index) }; });
      made += fresh.length;
      await this.d.store.mutate(f => {
        f.notes = settleNotes(f.notes as CompassNote[], { now, expiry: settings.expiry, fresh, retracts: v.retracts, updates: v.updates });
        if (v.refused.length) f.refused = [...f.refused, ...v.refused.map(code => ({ at: readAt, code }))].slice(-50);
      });
      cursorAt = Math.max(cursorAt, ...batch.map(i => Date.parse(i.at)));
      const done = new Set(batch.map(i => i.id));
      rest = rest.filter(i => !done.has(i.id));
    }
    if (refused.length) this.d.log?.(`[follow-up] compass: refused ${refused.length} note(s): ${[...new Set(refused)].join(", ")}`);
    const all = !rest.some(i => !i.context);
    await setCursor({ status: all ? status : "paused", at: new Date(all ? newest : cursorAt).toISOString(), error: all ? partialNote : `Paused until tomorrow: ${COMPASS.extractionsPerDay} reads today.` });
    return made;
  }

  /**
   * A conversation since `since`, in time order, never a relevance search: the chat tool's history read (a conversation
   * id and an oldest time), newest page first until it passes the cursor, at most `pagesMax` pages; without one, the
   * message search sorted by time, one day at a time (the slower path, said so on the place).
   */
  private async readConversation(place: Extract<Place, { kind: "conversation" }>, since: number): Promise<{ messages: ReturnType<typeof parseConversation>; slow: boolean; partial: boolean }> {
    const allowed = await this.d.allowed?.();
    const opts = { reason: "read the developer's Compass", timeoutMs: 30_000, allowed };
    const history = await this.d.tools.tool("chat", "history", allowed);
    const oldest = (since / 1000).toFixed(6);
    if (history) {
      const out: ReturnType<typeof parseConversation> = [];
      let page: string | null = null; let partial = false;
      for (let i = 0; i < COMPASS.pagesMax; i++) {
        const reply = await this.d.tools.call("chat", "history", { channel_id: place.id, channel: place.id, conversation_id: place.id, oldest, limit: COMPASS.pageSize, response_format: "detailed", ...(page ? { cursor: page } : {}) }, opts);
        const got = parseConversation(reply);
        out.push(...got);
        page = nextCursor(reply);
        if (!page || !got.length || got.some(m => Date.parse(m.at) <= since)) break;
        if (i === COMPASS.pagesMax - 1) partial = true;
      }
      return { messages: out, slow: false, partial };
    }
    const out: ReturnType<typeof parseConversation> = [];
    const where = place.sub === "dm" ? `in:<@${place.id}>` : `in:<#${place.id}>`;
    for (let day = Math.floor(since / 86_400_000) * 86_400_000; day <= this.now(); day += 86_400_000) {
      const after = new Date(day - 86_400_000).toISOString().slice(0, 10); const before = new Date(day + 86_400_000).toISOString().slice(0, 10);
      const reply = await this.d.tools.call("chat", "messages", { keywords: [], query: "", natural_language_query: "", filters: `${where} after:${after} before:${before}`, sort: "timestamp", sort_dir: "asc", limit: 50, include_context: false, response_format: "detailed" }, opts);
      out.push(...parseConversation(reply));
    }
    return { messages: out, slow: true, partial: false };
  }

  /**
   * compass_find: people and conversations from the chat tool's own search, the only way an agent learns a place id. A
   * person comes with their DM as a place (the conversation tools take a person's id for a DM).
   */
  async find(kind: "people" | "channels", query: string): Promise<{ results: { id: string; name: string; place: Place | null }[]; error: string | null }> {
    const allowed = await this.d.allowed?.().catch(() => undefined);
    const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 4);
    try {
      const reply = await this.d.tools.call("chat", kind, { keywords: words, query: query.trim(), natural_language_query: "", limit: 10, response_format: "detailed", ...(kind === "channels" ? { channel_types: "public_channel,private_channel" } : {}) }, { reason: "set up the developer's Compass", timeoutMs: 20_000, allowed });
      const results = parseChatRefs(reply, kind).flatMap(r => r.id ? [{ id: r.id, name: r.name, place: { kind: "conversation" as const, sub: kind === "people" ? "dm" as const : "channel" as const, id: r.id, name: r.name } }] : []);
      return { results, error: null };
    } catch (e) { return { results: [], error: e instanceof NoSourceError ? "No chat search is connected." : readError(e) }; }
  }

  /**
   * One note, by hand (Why it matters' menu, a confirmed compass_note): pin, edit, unpin, or tell its workspace's main
   * agent. A tell changes no note; it is the only path from a note to an agent.
   */
  async note(a: NoteAction, by: string, opts: { workspaceExists?: (id: string) => boolean } = {}): Promise<{ view: CompassView; told: { agentId: string } | null }> {
    const file = await this.d.store.read();
    const r = applyNoteAction(file.notes as CompassNote[], a, { now: this.now(), by: by === "developer" ? "developer" : by, newId: () => this.newId("n-"), workspaceExists: opts.workspaceExists ?? (() => true) });
    if (!r.ok) throw new Error(r.error);
    let told: { agentId: string } | null = null;
    if (a.action === "tell") {
      const workspace = r.note.match.workspace;
      if (!workspace) throw new Error("This note isn't on a workspace. Move it onto one first.");
      if (!this.d.tell) throw new Error("Follow-up can't send messages here.");
      const settings = await this.settings();
      const source = settings.sources.find(s => s.id === r.note.source) ?? null;
      const place = source?.places.find(p => placeKey(p) === r.note.place) ?? null;
      const where = place?.kind === "conversation" ? (place.sub === "dm" ? "a DM" : `#${place.name}`) : place?.name ?? null;
      told = await this.d.tell(workspace, tellText(r.note, source, where), by);
      if (!told) throw new Error("This workspace has no main agent to tell.");
    } else {
      await this.d.store.mutate(f => { f.notes = r.notes; });
      this.d.onChange?.();
    }
    return { view: await this.view(a.workspace || r.note.match.workspace ? { workspace: (a.workspace ?? r.note.match.workspace)! } : {}), told };
  }

  /** Each workspace's first live note as one line ("Dana: …"), for Home rows and Catch up. Reads compass.json only. */
  async lines(): Promise<Record<string, string>> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    if (!file.notes.length) return {};
    return noteLines(file.notes as CompassNote[], this.now(), settings.expiry);
  }

  /**
   * why_suggested: for a workspace, an issue or a note, the live notes behind it, who said them, where, the source
   * and role, and how each was matched. Compass notes reorder AI priority; none adds a Needs-you row yet.
   */
  async why(input: { workspace?: string; issue?: string; note?: string }): Promise<{ notes: unknown[]; needsYou: { suggested: false; why: string } }> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    const label = new Map([...settings.sources.map(s => [s.id, s.label] as const), [HAND_SOURCE, HAND_LABEL] as const]);
    const key = input.issue?.toUpperCase();
    const notes = (file.notes as CompassNote[]).filter(n => n.state === "live" && (input.note ? n.id === input.note
      : input.workspace ? n.match.workspace === input.workspace : key ? n.keys.some(k => k.toUpperCase() === key) || n.match.issue?.toUpperCase() === key : true));
    return {
      notes: notes.map(n => ({ id: n.id, what: n.what, quote: n.quote, who: noteWho(n), at: n.at, source: label.get(n.source) ?? "a removed source", role: n.role, strength: n.strength, until: n.until,
        matched: { how: n.match.how, score: Math.round(n.match.score * 100) / 100, workspace: n.match.workspace ?? null, issue: n.match.issue ?? null } })),
      needsYou: { suggested: false, why: "Compass notes reorder AI priority. They don't add Needs-you rows yet." },
    };
  }

  /** What AI priority reads: live notes, settled for time first (an ended note never reaches the ranker). */
  async forRanker(): Promise<RankCompassNote[]> {
    const settings = await this.settings();
    if (!settings.sources.length) return [];
    const file = await this.d.store.read();
    const now = this.now();
    const settled = settleNotes(file.notes as CompassNote[], { now, expiry: settings.expiry });
    if (settled.some((n, i) => n !== file.notes[i]) || settled.length !== file.notes.length) await this.d.store.mutate(f => { f.notes = settled; });
    return rankNotes(settled, settings.sources, now, settings.expiry);
  }
}
