import { classifyLink, type LinkedFile, type LinkRef } from "./linked";
import type { Workspace } from "./model";

export type TitleEvidence = { title: string; rank: number };
export type TitleIndex = Map<string, TitleEvidence>;
export const shortTitle = (value: unknown): string | null => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) || null : null;
export const titleKey = (url: string): string => classifyLink(url, true)?.key ?? url;
export function rememberTitle(index: TitleIndex, url: string, evidence: TitleEvidence | null): void {
  const key = titleKey(url);
  if (evidence && (!index.has(key) || index.get(key)!.rank < evidence.rank)) index.set(key, evidence);
}

/** One ordering for every local artifact receipt: explicit name, HTML title, description, filename. */
export function receiptTitle(input: Record<string, unknown>, html: string | null = null): TitleEvidence | null {
  const title = shortTitle(input.title);
  if (title) return { title, rank: 4 };
  const htmlTitle = shortTitle(html?.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/&#(x[\da-f]+|\d+);/gi, (all, n: string) => {
    const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n]!));
  if (htmlTitle) return { title: htmlTitle, rank: 3 };
  const description = shortTitle(input.description);
  if (description) return { title: description, rank: 2 };
  const base = typeof input.file_path === "string" ? input.file_path.split(/[\\/]/).pop()?.replace(/\.(?:html?|md)$/i, "").replace(/[-_]+/g, " ").trim() : null;
  return base && !/^(?:index|page|artifact)$/i.test(base) ? { title: (base[0].toUpperCase() + base.slice(1)).slice(0, 120), rank: 1 } : null;
}

/** Titles already seen anywhere on this host. Explicit linked/spec names outrank inferred receipt names. */
export function localTitles(workspaces: readonly Pick<Workspace, "enable_tracking" | "artifacts" | "spec">[], file?: LinkedFile, refs: readonly LinkRef[] = []): TitleIndex {
  const index: TitleIndex = new Map();
  for (const w of workspaces) if (w.enable_tracking) {
    for (const a of w.artifacts) if (a.title) rememberTitle(index, a.url, { title: a.title, rank: a.titleRank ?? 1 });
    if (w.spec?.url && w.spec.title) rememberTitle(index, w.spec.url, { title: w.spec.title, rank: w.spec.source === "detected" ? 1 : 5 });
  }
  for (const ws of Object.values(file?.workspaces ?? {})) for (const i of ws.items) if ((i.kind === "artifact" || i.kind === "doc") && i.title) rememberTitle(index, i.url ?? i.key, { title: i.title, rank: i.origin === "manual" || i.origin === "registered" ? 5 : 1 });
  for (const ref of refs) if (ref.title) rememberTitle(index, ref.raw, { title: ref.title, rank: ref.titleRank ?? 4 });
  return index;
}

/** Fill blanks only: a developer/agent's chosen title is durable. Safe to repeat at startup and after sightings. */
export function fillLinkedTitles(file: LinkedFile, titles: TitleIndex): number {
  let filled = 0;
  for (const ws of Object.values(file.workspaces)) for (const item of ws.items) if (!item.title && (item.kind === "artifact" || item.kind === "doc")) {
    const title = titles.get(titleKey(item.url ?? item.key))?.title;
    if (title) { item.title = title; filled++; }
  }
  return filled;
}
export function fillWorkspaceTitles(w: Pick<Workspace, "artifacts" | "spec">, titles: TitleIndex): boolean {
  let changed = false;
  for (const a of w.artifacts) {
    const known = titles.get(titleKey(a.url));
    if (known && (!a.title || known.rank > (a.titleRank ?? 1))) { a.title = known.title; a.titleRank = known.rank; changed = true; }
  }
  if (w.spec?.url && !w.spec.title) {
    const title = titles.get(titleKey(w.spec.url))?.title;
    if (title) { w.spec.title = title; changed = true; }
  }
  return changed;
}

/** Preflight against frozen snapshots: do not copy an unchanged workspace just to ask whether it needs a title. */
export function workspaceNeedsTitles(w: Pick<Workspace, "artifacts" | "spec">, titles: TitleIndex): boolean {
  return !!(w.spec?.url && !w.spec.title && titles.has(titleKey(w.spec.url))) || w.artifacts.some(a => {
    const known = titles.get(titleKey(a.url));
    return !!known && (!a.title || known.rank > (a.titleRank ?? 1));
  });
}
