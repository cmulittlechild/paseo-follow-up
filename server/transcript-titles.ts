import { setImmediate as yieldChunk } from "node:timers/promises";
import { constants } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Workspace } from "../shared/model";
import type { LinkedItem } from "../shared/linked";
import { rememberTitle, titleKey, type TitleIndex } from "../shared/local-titles";
import { artifactPublishUrl, receiptTitles } from "./local-titles";
import { JsonFileStore } from "./json-file-store";
import { transcriptFile, type AgentRecordLite, type TranscriptRoots } from "./transcript";

export const TITLE_SCAN_BYTES = 2 * 1024 * 1024;
/** Ordered replay still puts p90 beyond two hours; boost only while an unnamed backlog has unread bytes. */
export const TITLE_BACKLOG_BYTES = 4 * 1024 * 1024;
const pendingSchema = z.record(z.string(), z.object({ title: z.string().optional(), file_path: z.string().optional(), description: z.string().optional(), action: z.string().optional() }));
const cursorSchema = z.object({ offset: z.number().int().nonnegative(), inode: z.string(), size: z.number(), mtime: z.number(), dropping: z.boolean(), partial: z.string().default(""), backward: z.number().nonnegative().default(0), reversePartial: z.string().default(""), reverseDropping: z.boolean().default(false), results: z.record(z.string(), z.string()).default({}), pending: pendingSchema });
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
function cursorFor(saved: Cursor | undefined, info: { ino: number; size: number; mtimeMs: number }, reverse = false): Cursor {
  const inode = String(info.ino);
  const restart = !saved || saved.inode !== inode || info.size < saved.size || info.size === saved.size && info.mtimeMs !== saved.mtime;
  return restart ? { offset: reverse ? info.size : 0, inode, size: info.size, mtime: info.mtimeMs, dropping: false, partial: "", backward: reverse ? info.size : 0, reversePartial: "", reverseDropping: false, results: {}, pending: {} }
    : { ...saved, size: info.size, mtime: info.mtimeMs, pending: { ...saved.pending }, results: { ...saved.results } };
}

/** One shared, append-only receipt index. No per-URL scans, timeline reads or daemon dependencies. */
export class TranscriptTitleLookup {
  private running = false;
  private paths: string[] = [];
  private scopeKey = "";
  private pathsAt = -Infinity;
  constructor(private d: { store: TranscriptTitleStore; paths(workspaces: readonly Workspace[], priorityWorkspaces: ReadonlySet<string>): Promise<string[]>; now?: () => number; budget?: number; direction?: "forward" | "backward" }) {}
  async tick(workspaces: readonly Workspace[], items: Readonly<Record<string, { items: readonly LinkedItem[] }>>, found: (titles: TitleIndex) => Promise<void>): Promise<{ bytes: number; attempted: number }> {
    if (this.running) return { bytes: 0, attempted: 0 };
    const tracked = workspaces.filter(w => w.enable_tracking);
    if (!tracked.some(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title))) return { bytes: 0, attempted: 0 };
    this.running = true;
    try {
      const cache = await this.d.store.read();
      const known: TitleIndex = new Map(Object.entries(cache.titles).map(([url, evidence]) => [url, evidence]));
      await found(known);
      // The callback can fill the caller's records; a hit needs no filesystem discovery or scan.
      if (!tracked.some(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title && !known.has(titleKey(i.url ?? i.key))))) return { bytes: 0, attempted: 0 };
      const priorityWorkspaces = new Set(tracked.filter(w => items[w.id]?.items.some(i => i.kind === "artifact" && !i.title && !known.has(titleKey(i.url ?? i.key)))).map(w => w.id));
      const now = (this.d.now ?? Date.now)(), scopeKey = JSON.stringify([tracked.map(w => [w.id, w.mainAgentId, w.contributorAgentIds]), [...priorityWorkspaces]]);
      if (scopeKey !== this.scopeKey || now - this.pathsAt >= 5 * 60_000) {
        this.paths = await this.d.paths(tracked, priorityWorkspaces); this.scopeKey = scopeKey; this.pathsAt = now;
      }
      const budget = this.d.budget ?? TITLE_BACKLOG_BYTES;
      let bytes = 0, attempted = 0;
      const updates = new Map<string, Cursor>(), learned: TitleIndex = new Map(), locations = new Map<string, string>();
      for (const path of this.paths.flatMap(path => Array.from({ length: Math.ceil(budget / (1024 * 1024)) }, () => path))) {
        if (bytes >= budget) break;
        let handle;
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          const cursor = cursorFor(updates.get(path) ?? cache.files[path], info, this.d.direction === "backward");
          if (cursor.offset >= info.size && cursor.backward === 0) continue;
          handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
          const actual = await handle.stat();
          if (!actual.isFile()) continue;
          const current = cursorFor(updates.get(path) ?? cache.files[path], actual, this.d.direction === "backward");
          const reverse = current.offset >= actual.size && current.backward > 0;
          const length = Math.min(1024 * 1024, budget - bytes, reverse ? current.backward : Math.max(0, actual.size - current.offset));
          const position = reverse ? current.backward - length : current.offset;
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          bytes += bytesRead; attempted++;
          const consume = async (line: string) => {
            let row: any; try { row = JSON.parse(line); } catch { return; }
            const content = row?.message?.content;
            if (!Array.isArray(content)) return;
            const complete = async (input: z.infer<typeof pendingSchema>[string], url: string) => {
              for (const [key, evidence] of await receiptTitles([{ item: { type: "tool_call", name: "Artifact", status: "completed", detail: { input, output: `Published page at ${url}` } } }])) {
                const previous = learned.get(key); rememberTitle(learned, key, evidence);
                if (!previous || previous.rank < evidence.rank) locations.set(key, path);
              }
            };
            for (const part of content) {
              if (part?.type === "tool_use" && part.name === "Artifact" && typeof part.id === "string") {
                const raw = part.input ?? {};
                if ((raw.action ?? "publish") !== "publish" || raw.asset === true) continue;
                const input = Object.fromEntries(["title", "file_path", "description", "action"].filter(k => typeof raw[k] === "string").map(k => [k, raw[k].slice(0, k === "file_path" ? 4096 : 1000)]));
                if (current.results[part.id]) { await complete(input, current.results[part.id]); delete current.results[part.id]; }
                else {
                  if (Object.keys(current.pending).length >= 64) delete current.pending[Object.keys(current.pending)[0]];
                  current.pending[part.id] = input;
                }
              }
              if (part?.type !== "tool_result" || part.is_error || typeof part.tool_use_id !== "string") continue;
              const url = artifactPublishUrl(part.content); if (!url) continue;
              const input = current.pending[part.tool_use_id]; delete current.pending[part.tool_use_id];
              if (input) await complete(input, url);
              else {
                if (Object.keys(current.results).length >= 64) delete current.results[Object.keys(current.results)[0]];
                current.results[part.tool_use_id] = url;
              }
            }
          };
          if (reverse) {
            let chunk = Buffer.concat([buffer.subarray(0, bytesRead), Buffer.from(current.reversePartial, "base64")]);
            current.reversePartial = "";
            if (current.reverseDropping) {
              const boundary = chunk.lastIndexOf(10);
              if (boundary >= 0) { chunk = chunk.subarray(0, boundary); current.reverseDropping = false; }
              else chunk = Buffer.alloc(0);
            }
            let end = chunk.length;
            for (let boundary = chunk.lastIndexOf(10, Math.max(0, end - 1)); boundary >= 0 && end > 0; boundary = chunk.lastIndexOf(10, Math.max(0, end - 1))) {
              if (boundary < end) await consume(chunk.subarray(boundary + 1, end).toString("utf8"));
              end = boundary;
            }
            if (position === 0) { if (!current.reverseDropping) await consume(chunk.subarray(0, end).toString("utf8")); }
            else if (end > 256 * 1024) current.reverseDropping = true;
            else if (!current.reverseDropping) current.reversePartial = chunk.subarray(0, end).toString("base64");
            current.backward = position;
          } else {
            const chunk = Buffer.concat([Buffer.from(current.partial, "base64"), buffer.subarray(0, bytesRead)]);
            current.partial = ""; let start = 0;
            for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
              const line = chunk.subarray(start, end).toString("utf8"); start = end + 1;
              if (current.dropping) { current.dropping = false; continue; }
              await consume(line);
            }
            current.offset += bytesRead;
            const suffix = chunk.subarray(start);
            if (suffix.length > 256 * 1024) current.dropping = true;
            else if (!current.dropping) current.partial = suffix.toString("base64");
          }
          updates.set(path, current);
          await yieldChunk();
        } catch { /* a missing file is a miss, never a worker failure */ }
        finally { await handle?.close().catch(() => undefined); }
      }
      if (updates.size || learned.size) await this.d.store.mutate(file => {
        for (const [path, cursor] of updates) file.files[path] = cursor;
        for (const [url, evidence] of learned) if (!file.titles[url] || file.titles[url].rank < evidence.rank) file.titles[url] = { ...evidence, path: locations.get(url)! };
      });
      for (const [url, evidence] of learned) rememberTitle(known, url, evidence);
      if (learned.size) await found(known);
      return { bytes, attempted };
    } finally { this.running = false; }
  }
}
