import { setImmediate as yieldChunk } from "node:timers/promises";
import { constants } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Workspace } from "../shared/model";
import type { LinkedItem } from "../shared/linked";
import { rememberTitle, titleKey, type TitleIndex } from "../shared/local-titles";
import { receiptTitles } from "./local-titles";
import { JsonFileStore } from "./json-file-store";
import { transcriptFile, type AgentRecordLite, type TranscriptRoots } from "./transcript";

export const TITLE_SCAN_BYTES = 2 * 1024 * 1024;
/** Ordered replay still puts p90 beyond two hours; boost only while an unnamed backlog has unread bytes. */
export const TITLE_BACKLOG_BYTES = 4 * 1024 * 1024;
const pendingSchema = z.record(z.string(), z.object({ title: z.string().optional(), file_path: z.string().optional(), description: z.string().optional(), action: z.string().optional() }));
const cursorSchema = z.object({ offset: z.number().int().nonnegative(), inode: z.string(), size: z.number(), mtime: z.number(), dropping: z.boolean(), partial: z.string().default(""), pending: pendingSchema });
type Cursor = z.infer<typeof cursorSchema>;
const titleSchema = z.object({ title: z.string().max(120), rank: z.number(), path: z.string() });
const cacheSchema = z.object({ files: z.record(z.string(), cursorSchema), titles: z.record(z.string(), titleSchema) });
export class TranscriptTitleStore extends JsonFileStore<z.infer<typeof cacheSchema>> {
  constructor(directory: string) { super({ path: join(directory, "title-index.json"), schema: cacheSchema, empty: () => ({ files: {}, titles: {} }), collections: { files: { kind: "record", item: cursorSchema }, titles: { kind: "record", item: titleSchema } } }); }
}

/** One pass over local agent metadata, then resolve only agents whose workspace is tracked. Never list transcripts. */
export async function trackedTitleTranscripts(paseoHome: string, workspaces: readonly Workspace[], roots?: TranscriptRoots, priorityWorkspaces: ReadonlySet<string> = new Set()): Promise<string[]> {
  const tracked = new Set(workspaces.filter(w => w.enable_tracking).map(w => w.id));
  const knownIds = new Set(workspaces.filter(w => w.enable_tracking).flatMap(w => [w.mainAgentId, ...(w.contributorAgentIds ?? [])]));
  const records: { record: AgentRecordLite; priority: boolean }[] = [];
  const root = join(paseoHome, "agents");
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(join(root, dir.name)).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(root, dir.name, name), "utf8"));
        if (record.provider !== "claude" || !(tracked.has(record.workspaceId) || !record.workspaceId && knownIds.has(record.id))) continue;
        records.push({ priority: priorityWorkspaces.has(record.workspaceId), record: { id: record.id, provider: record.provider, cwd: record.cwd ?? "", persistence: record.persistence ? { sessionId: record.persistence.sessionId, nativeHandle: record.persistence.nativeHandle } : null } });
      } catch { /* unreadable metadata contributes no file */ }
    }
  }
  const paths = new Map<string, { priority: boolean; mtime: number }>();
  for (const { record, priority } of records) {
    const path = await transcriptFile(record, roots);
    if (!path) continue;
    const info = await stat(path).catch(() => null);
    if (info) paths.set(path, { priority: priority || paths.get(path)?.priority === true, mtime: info.mtimeMs });
  }
  return [...paths].sort(([a, x], [b, y]) => Number(y.priority) - Number(x.priority) || y.mtime - x.mtime || a.localeCompare(b)).map(([path]) => path);
}

/** A replaced, truncated, or edited-in-place file restarts; an append retains the prior byte offset and pending call. */
function cursorFor(saved: Cursor | undefined, info: { ino: number; size: number; mtimeMs: number }): Cursor {
  const inode = String(info.ino);
  const restart = !saved || saved.inode !== inode || info.size < saved.size || info.size === saved.size && info.mtimeMs !== saved.mtime;
  return restart ? { offset: 0, inode, size: info.size, mtime: info.mtimeMs, dropping: false, partial: "", pending: {} }
    : { ...saved, size: info.size, mtime: info.mtimeMs, pending: { ...saved.pending } };
}

export const TITLE_PARK_RECHECK_MS = 30 * 60_000;
const ARTIFACT_BYTES = Buffer.from("rtifact");
/** Reject ordinary transcript lines before UTF-8 decoding or JSON allocation. */
export function parseArtifactLine(line: Buffer): any {
  if (line.indexOf(ARTIFACT_BYTES) < 0) return null;
  try { return JSON.parse(line.toString("utf8")); } catch { return null; }
}
const unnamedKey = (workspaces: readonly Workspace[], items: Readonly<Record<string, { items: readonly LinkedItem[] }>>, known?: TitleIndex) => JSON.stringify([
  workspaces.map(w => [w.id, w.mainAgentId, w.contributorAgentIds]),
  workspaces.flatMap(w => (items[w.id]?.items ?? []).filter(i => i.kind === "artifact" && !i.title && !known?.has(titleKey(i.url ?? i.key))).map(i => [w.id, i.key])).sort(),
]);

/** One shared, append-only receipt index. No per-URL scans, timeline reads or daemon dependencies. */
export class TranscriptTitleLookup {
  private running = false;
  private paths: string[] = [];
  private scopeKey = "";
  private pathsAt = -Infinity;
  private parked: { key: string; at: number } | null = null;
  constructor(private d: { store: TranscriptTitleStore; paths(workspaces: readonly Workspace[], priorityWorkspaces: ReadonlySet<string>): Promise<string[]>; now?: () => number; budget?: number; parseLine?: typeof parseArtifactLine; statFile?: typeof stat }) {}
  async tick(workspaces: readonly Workspace[], items: Readonly<Record<string, { items: readonly LinkedItem[] }>>, found: (titles: TitleIndex) => Promise<void>): Promise<{ bytes: number; attempted: number }> {
    if (this.running) return { bytes: 0, attempted: 0 };
    const tracked = workspaces.filter(w => w.enable_tracking);
    if (!tracked.some(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title))) return { bytes: 0, attempted: 0 };
    const now = (this.d.now ?? Date.now)(), key = unnamedKey(tracked, items);
    if (this.parked && this.parked.key === key && now - this.parked.at < TITLE_PARK_RECHECK_MS) return { bytes: 0, attempted: 0 };
    if (this.parked) { this.parked = null; this.pathsAt = -Infinity; }
    this.running = true;
    try {
      const cache = await this.d.store.read();
      const known: TitleIndex = new Map(Object.entries(cache.titles).map(([url, evidence]) => [url, evidence]));
      await found(known);
      // The callback can fill the caller's records; a hit needs no filesystem discovery or scan.
      if (!tracked.some(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title && !known.has(titleKey(i.url ?? i.key))))) return { bytes: 0, attempted: 0 };
      const priorityWorkspaces = new Set(tracked.filter(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title && !known.has(titleKey(i.url ?? i.key)))).map(w => w.id));
      const scopeKey = JSON.stringify([tracked.map(w => [w.id, w.mainAgentId, w.contributorAgentIds]), [...priorityWorkspaces]]);
      if (scopeKey !== this.scopeKey || now - this.pathsAt >= 5 * 60_000) {
        this.paths = await this.d.paths(tracked, priorityWorkspaces); this.scopeKey = scopeKey; this.pathsAt = now;
      }
      const budget = this.d.budget ?? TITLE_BACKLOG_BYTES;
      let bytes = 0, attempted = 0;
      const caughtUp = new Set<string>();
      const updates = new Map<string, Cursor>(), learned: TitleIndex = new Map(), locations = new Map<string, string>();
      for (const path of this.paths.flatMap(path => Array.from({ length: Math.ceil(budget / (1024 * 1024)) }, () => path))) {
        if (bytes >= budget) break;
        if (caughtUp.has(path)) continue;
        let handle;
        try {
          const info = await (this.d.statFile ?? stat)(path);
          if (!info.isFile()) { caughtUp.add(path); continue; }
          const cursor = cursorFor(updates.get(path) ?? cache.files[path], info);
          if (cursor.offset >= info.size) { caughtUp.add(path); continue; }
          handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
          const actual = await handle.stat();
          if (!actual.isFile()) continue;
          const current = cursorFor(updates.get(path) ?? cache.files[path], actual);
          const buffer = Buffer.alloc(Math.min(1024 * 1024, budget - bytes, Math.max(0, actual.size - current.offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, current.offset);
          bytes += bytesRead; attempted++;
          const chunk = Buffer.concat([Buffer.from(current.partial, "base64"), buffer.subarray(0, bytesRead)]);
          current.partial = "";
          let start = 0;
          for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
            const line = chunk.subarray(start, end); start = end + 1;
            if (current.dropping) { current.dropping = false; continue; }
            const row = (this.d.parseLine ?? parseArtifactLine)(line);
            const content = row?.message?.content;
            if (!Array.isArray(content)) continue;
            for (const part of content) {
              if (part?.type === "tool_use" && part.name === "Artifact" && typeof part.id === "string") {
                const input = part.input ?? {};
                if ((input.action ?? "publish") !== "publish" || input.asset === true) continue;
                if (Object.keys(current.pending).length >= 64) delete current.pending[Object.keys(current.pending)[0]];
                current.pending[part.id] = Object.fromEntries(["title", "file_path", "description", "action"].filter(k => typeof input[k] === "string").map(k => [k, input[k].slice(0, k === "file_path" ? 4096 : 1000)]));
              }
              if (part?.type !== "tool_result" || part.is_error || typeof part.tool_use_id !== "string") continue;
              const input = current.pending[part.tool_use_id]; delete current.pending[part.tool_use_id];
              if (!input) continue;
              for (const [url, evidence] of await receiptTitles([{ item: { type: "tool_call", name: "Artifact", status: "completed", detail: { input, output: part.content } } }])) {
                const previous = learned.get(url);
                rememberTitle(learned, url, evidence);
                if (!previous || previous.rank < evidence.rank) locations.set(url, path);
              }
            }
          }
          current.offset += bytesRead;
          const suffix = chunk.subarray(start);
          if (suffix.length > 256 * 1024) current.dropping = true;
          else if (!current.dropping) current.partial = suffix.toString("base64");
          updates.set(path, current);
          if (current.offset >= actual.size) caughtUp.add(path);
          await yieldChunk();
        } catch { caughtUp.add(path); /* a missing file is retried on the next slow recheck */ }
        finally { await handle?.close().catch(() => undefined); }
      }
      if (updates.size || learned.size) await this.d.store.mutate(file => {
        for (const [path, cursor] of updates) file.files[path] = cursor;
        for (const [url, evidence] of learned) if (!file.titles[url] || file.titles[url].rank < evidence.rank) file.titles[url] = { ...evidence, path: locations.get(url)! };
      });
      for (const [url, evidence] of learned) rememberTitle(known, url, evidence);
      if (learned.size) await found(known);
      if (this.paths.every(path => caughtUp.has(path))) this.parked = { key: unnamedKey(tracked, items, known), at: now };
      return { bytes, attempted };
    } finally { this.running = false; }
  }
}
