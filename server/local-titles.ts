import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isClaudeArtifact } from "../shared/spec";
import { toolResult } from "../shared/tool-result";
import { receiptTitle, rememberTitle, shortTitle, type TitleIndex } from "../shared/local-titles";

export const TITLE_READ_BYTES = 8192;
/** Bounded async local read. Missing/deleted/inaccessible files and directories are ordinary misses. */
export async function readTitleHtml(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return null;
      const buffer = Buffer.alloc(TITLE_READ_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch { return null; }
}
/** A tool result's text, in every shape Paseo sends (shared/tool-result.ts). */
export const resultText = (output: unknown): string => toolResult(output).text;
export function artifactPublishUrl(output: unknown): string | null {
  const url = /^(?:Published \S.*? at|Created a new Artifact at) (https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)(?=[\s(.,]|$)/.exec(resultText(output).trimStart())?.[1];
  return url && isClaudeArtifact(url) ? url : null;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** The projected unknown-tool detail preserves input and output, including MCP text blocks. Never fetch URLs. */
export async function receiptTitles(entries: readonly { item: unknown }[], readHtml = readTitleHtml): Promise<TitleIndex> {
  const titles: TitleIndex = new Map();
  for (const entry of entries) {
    const v = object(entry.item), detail = object(v.detail), input = object(detail.input);
    const result = toolResult(detail.output);
    if (v.type !== "tool_call" || v.status !== "completed" || v.error || result.isError) continue;
    const output = result.text;
    if (v.name === "Artifact") {
      const action = input.action ?? "publish";
      if (input.asset === true || !["publish", "read"].includes(String(action))) continue;
      const url = action === "read" ? input.url : artifactPublishUrl(detail.output);
      if (typeof url !== "string" || !isClaudeArtifact(url)) continue;
      let html: string | null = null;
      if (!shortTitle(input.title) && action === "publish" && typeof input.file_path === "string") html = await readHtml(input.file_path).catch(() => null);
      // Read returns raw HTML or a title-labelled summary; structured read.result is preserved by Paseo too.
      const read = object(result.object?.read);
      if (action === "read") html = typeof read.result === "string" ? read.result : output;
      const named = action === "read" ? shortTitle(result.object?.title) ?? shortTitle(/^(?:Title|Artifact title):\s*(.+)$/im.exec(output)?.[1]) : null;
      rememberTitle(titles, url, receiptTitle(named ? { ...input, title: named } : input, html));
    }
    if (v.name === "mcp__claude_ai_Claude_Docs__batch") {
      // Each successful create result carries its URL; pair by operation index rather than guessing from prose.
      const parsed = result.value;
      const operations = Array.isArray(input.batch) ? input.batch : Array.isArray(input.operations) ? input.operations : [];
      const results = Array.isArray(parsed) ? parsed : object(parsed).results ?? object(parsed).batch;
      if (!Array.isArray(results)) continue;
      for (let i = 0; i < operations.length; i++) {
        const op = object(operations[i]), create = object(object(op.container).create);
        const title = shortTitle(create.name ?? (op.verb === "create" && op.object === "container" ? object(op.payload).name : null) ?? (op.type === "container.create" || op.method === "container.create" ? object(op.params).name ?? op.name : null));
        const result = object(results[i]), data = object(result.result ?? result.container ?? result);
        const url = data.url ?? data.web_url;
        if (title && typeof url === "string" && /^https:\/\/claude\.ai\//.test(url) && !result.error) rememberTitle(titles, url, { title, rank: 4 });
      }
    }
  }
  return titles;
}
