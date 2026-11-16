import { constants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Workspace } from "../shared/model";
import type { LinkedItem } from "../shared/linked";
import { titleKey, type TitleEvidence } from "../shared/local-titles";
import { artifactPublishUrl, receiptTitles } from "./local-titles";
import { JsonFileStore } from "./json-file-store";
import { agentRecord, transcriptFile, type TranscriptRoots } from "./transcript";

export const TITLE_SCAN_BYTES = 1024 * 1024;
export const TITLE_MISS_RETRY_MS = 7 * 24 * 3600_000;
const pendingSchema = z.record(z.string(), z.object({ title: z.string().optional(), file_path: z.string().optional(), description: z.string().optional(), action: z.string().optional() }));
const lookupSchema = z.object({
  paths: z.array(z.string()).max(40), file: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  dropping: z.boolean(), pending: pendingSchema, retryAt: z.number(), title: z.string().nullable(), rank: z.number(),
});
type Lookup = z.infer<typeof lookupSchema>;
const cacheSchema = z.object({ entries: z.record(z.string(), lookupSchema) });
const fresh = (paths: string[]): Lookup => ({ paths, file: 0, offset: 0, dropping: false, pending: {}, retryAt: 0, title: null, rank: 0 });
export class TranscriptTitleStore extends JsonFileStore<z.infer<typeof cacheSchema>> {
  constructor(directory: string) { super({ path: join(directory, "title-lookups.json"), schema: cacheSchema, empty: () => ({ entries: {} }), collections: { entries: { kind: "record", item: lookupSchema } } }); }
}

/** Only recorded local roots and an item's recorded publisher; discovery never reads another agent's timeline. */
export async function titleTranscriptPaths(paseoHome: string, w: Workspace, item: Pick<LinkedItem, "by">, roots?: TranscriptRoots): Promise<string[]> {
  const ids = [...new Set([w.mainAgentId, ...(w.contributorAgentIds ?? [])].filter((id): id is string => !!id))];
  // Include historical roots still recorded for this workspace, including archived sessions. This lists agent
  // metadata only; transcript content is read only after membership is established. No recursive transcript search.
  const root = join(paseoHome, "agents");
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(join(root, dir.name)).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(root, dir.name, name), "utf8"));
        if (record.workspaceId === w.id && record.provider === "claude" && typeof record.id === "string" && !ids.includes(record.id) && ids.length < 40) ids.push(record.id);
      } catch { /* unreadable agent metadata is not transcript evidence */ }
    }
  }
  if (item.by && !ids.includes(item.by) && ids.length < 40) ids.push(item.by);
  const paths: string[] = [];
  for (const id of ids) {
    const record = await agentRecord(paseoHome, id);
    if (!record || record.provider !== "claude") continue;
    const path = await transcriptFile(record, roots);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** One bounded byte window, retaining only Artifact call inputs needed to pair a later result. */
export async function scanTitleWindow(url: string, state: Lookup, budget = TITLE_SCAN_BYTES): Promise<{ state: Lookup; bytes: number; evidence: TitleEvidence | null }> {
  const next: Lookup = { ...state, paths: [...state.paths], pending: { ...state.pending } };
  let bytes = 0;
  while (next.file < next.paths.length && bytes < budget) {
    let handle;
    try {
      handle = await open(next.paths[next.file], constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) { next.file++; next.offset = 0; next.pending = {}; continue; }
      if (next.offset > stat.size) { next.offset = 0; next.pending = {}; next.dropping = false; }
      const buffer = Buffer.alloc(Math.min(budget - bytes, Math.max(0, stat.size - next.offset)));
      const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, next.offset) : { bytesRead: 0 };
      bytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      // An oversized line is skipped, never buffered beyond the pass's byte budget.
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        const line = chunk.subarray(start, end).toString("utf8");
        start = end + 1;
        if (next.dropping) { next.dropping = false; continue; }
        let row: any; try { row = JSON.parse(line); } catch { continue; }
        const content = row?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === "tool_use" && part.name === "Artifact" && typeof part.id === "string") {
            const input = part.input ?? {};
            if ((input.action ?? "publish") !== "publish" || input.asset === true) continue;
            if (Object.keys(next.pending).length >= 64) delete next.pending[Object.keys(next.pending)[0]];
            next.pending[part.id] = Object.fromEntries(["title", "file_path", "description", "action"].filter(k => typeof input[k] === "string").map(k => [k, input[k].slice(0, k === "file_path" ? 4096 : 1000)]));
          }
          if (part?.type !== "tool_result" || part.is_error || typeof part.tool_use_id !== "string") continue;
          const input = next.pending[part.tool_use_id];
          delete next.pending[part.tool_use_id];
          if (!input || titleKey(artifactPublishUrl(part.content) ?? "") !== titleKey(url)) continue;
          const titles = await receiptTitles([{ item: { type: "tool_call", name: "Artifact", status: "completed", detail: { input, output: part.content } } }]);
          const evidence = titles.get(titleKey(url)) ?? null;
          if (evidence) { next.offset += start; return { state: next, bytes, evidence }; }
        }
      }
      if (next.offset + bytesRead >= stat.size) { next.file++; next.offset = 0; next.pending = {}; next.dropping = false; }
      else if (start) next.offset += start;
      else { next.offset += bytesRead; next.dropping = true; }
    } catch { next.file++; next.offset = 0; next.pending = {}; next.dropping = false; }
    finally { await handle?.close().catch(() => undefined); }
  }
  return { state: next, bytes, evidence: null };
}

/** One URL per worker background tick. Progress and negative results survive worker reloads. No daemon dependency. */
export class TranscriptTitleLookup {
  private running = false;
  constructor(private d: { store: TranscriptTitleStore; paths(w: Workspace, item: LinkedItem): Promise<string[]>; now?: () => number; budget?: number }) {}
  async tick(workspaces: readonly Workspace[], items: Readonly<Record<string, { items: readonly LinkedItem[] }>>, found: (url: string, evidence: TitleEvidence) => Promise<void>): Promise<{ bytes: number; attempted: number }> {
    if (this.running) return { bytes: 0, attempted: 0 };
    this.running = true;
    try {
      const now = (this.d.now ?? Date.now)(), cache = await this.d.store.read();
      for (const w of workspaces) {
        if (!w.enable_tracking || w.archived) continue;
        for (const item of items[w.id]?.items ?? []) {
          if (item.kind !== "artifact" || item.title || !item.url) continue;
          const key = `${w.id}:${titleKey(item.url)}`, saved = cache.entries[key];
          if (saved?.retryAt && saved.retryAt > now) {
            if (saved.title) { await found(item.url, { title: saved.title, rank: saved.rank }); return { bytes: 0, attempted: 1 }; }
            continue;
          }
          const cursor = saved && saved.file < saved.paths.length ? saved : fresh(await this.d.paths(w, item));
          const result = await scanTitleWindow(item.url, cursor, this.d.budget);
          const done = result.state.file >= result.state.paths.length;
          const next = { ...result.state, retryAt: result.evidence || done ? now + TITLE_MISS_RETRY_MS : 0, title: result.evidence?.title ?? null, rank: result.evidence?.rank ?? 0 };
          await this.d.store.mutate(file => {
            file.entries[key] = next;
            const keys = Object.keys(file.entries);
            if (keys.length > 256) delete file.entries[keys.find(k => k !== key)!];
          });
          if (result.evidence) await found(item.url, result.evidence);
          return { bytes: result.bytes, attempted: 1 };
        }
      }
      return { bytes: 0, attempted: 0 };
    } finally { this.running = false; }
  }
}
