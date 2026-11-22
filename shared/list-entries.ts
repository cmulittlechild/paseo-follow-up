import { GROUP_TITLE, quietFolds, type HomeGroupId, type HomeModel, type Workstream } from "./home";
import { rowHit, type OmniboxItem, type RowHit, type SearchHit, type WorkspaceItem } from "./search";

/**
 * What HomeList draws, in order: one entry per row, header, fold and line (client/home-list.tsx). Pure, so the keyboard
 * walk's order (walkOrder, shared/list-keys.ts) is testable: it is exactly the rows drawn.
 */
export const QUIET_PAGE = 20;
export const BRIEF_KEY = "brief";
export const OVERSEER_KEY = "overseer";
export type Entry =
  | { type: "brief"; key: string }
  | { type: "overseer"; key: string }
  | { type: "header"; key: string; group: HomeGroupId; title: string; count: number; open: boolean }
  | { type: "row"; key: string; s: Workstream; hit?: RowHit | null }
  | { type: "fold"; key: string; project: string; count: number; archivable: number; open: boolean }
  | { type: "more"; key: string; project: string; left: number }
  | { type: "result"; key: string; item: WorkspaceItem; index: number; s: Workstream; hit: RowHit; archived: boolean }
  | { type: "ask"; key: string; ask: string; index: number }
  | { type: "label"; key: string; text: string }
  | { type: "hold"; key: string; text: string }
  | { type: "empty"; key: string }
  | { type: "slot"; key: string };

/** A search hit on a workspace Follow-up has archived: a muted row with the Archive glyph, reading "Archived". */
/** The line under an open Older header (briefs-from-closed-agents). */
export const OLDER_NOTE = "Closed agents with nothing new for 3 days. A row comes back when its agent runs again.";

export function archivedRow(hit: SearchHit): Workstream {
  return { key: hit.key, agentId: null, workspaceId: hit.key.startsWith("ws:") ? hit.key.slice(3) : null, title: hit.title, agent: null, project: null, group: "quiet", tier: null,
    icon: "Archive", tone: "muted", line: "Archived", word: null, badges: [], pr: null, at: null, readyToArchive: false, sig: `archived:${hit.key}` } as unknown as Workstream;
}

export type ListEntriesInput = {
  model: HomeModel; closed: Set<string>; openProjects: Set<string>; pages: Record<string, number>; briefLine: string | null | undefined;
  results: OmniboxItem[] | null | undefined; hits: Map<string, SearchHit> | null; filter: HomeGroupId | null; overseer: boolean; touch: boolean; afterNeeds: boolean;
};
export function listEntries({ model, closed, openProjects, pages, briefLine, results, hits, filter, overseer, touch, afterNeeds }: ListEntriesInput): Entry[] {
  const out: Entry[] = [];
  if (results) {
    // Search ignores the sort and the groups: ranked by match, archived ones last under their own label.
    let archivedShown = false;
    results.forEach((item, index) => {
      if (item.ask !== undefined) {
        // The ask row closes the list; with no match it follows the "no match" line.
        if (index === 0) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
        out.push({ type: "ask", key: item.key, ask: item.ask, index });
        return;
      }
      if (item.hit.group === "archived" && !archivedShown) { archivedShown = true; out.push({ type: "label", key: "l:archived", text: "Archived" }); }
      const live = model.byKey.get(item.key);
      const s = live ?? archivedRow(item.hit);
      out.push({ type: "result", key: `r:${item.provider}:${item.key}`, item, index, s, hit: rowHit(item.hit, s), archived: !live });
    });
    if (!results.length) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
    return out;
  }
  if (briefLine !== undefined && !filter) out.push({ type: "brief", key: BRIEF_KEY });
  if (overseer && !filter) out.push({ type: "overseer", key: OVERSEER_KEY });
  for (const g of model.groups) {
    if (filter && g.id !== filter) continue;
    const open = !!filter || !!hits || !closed.has(g.id);
    // Phones with one group filtered: the chip above already says "N Needs you ×"; no header repeating it.
    if (!(touch && filter)) out.push({ type: "header", key: `h:${g.id}`, group: g.id, title: g.title, count: g.items.length, open });
    if (!open) { if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
    // One hold line per machine, once, at the top of Sending (the model has it only while Sending has rows).
    if (g.id === "sending" && model.hold) out.push({ type: "hold", key: "l:hold", text: model.hold });
    // briefs-from-closed-agents: Older says why its rows are there, since their ages alone can't.
    if (g.id === "older") out.push({ type: "label", key: "l:older", text: OLDER_NOTE });
    const hitOf = (s: Workstream) => { const h = hits?.get(s.key); return h ? rowHit(h, s) : null; };
    if (g.id !== "quiet") { for (const s of g.items) out.push({ type: "row", key: s.key, s, hit: hitOf(s) }); if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
    for (const f of quietFolds(g.items)) {
      const fopen = !!hits || openProjects.has(f.project);
      out.push({ type: "fold", key: `f:${f.project}`, project: f.project, count: f.items.length, archivable: f.archivable, open: fopen });
      if (!fopen) continue;
      const shown = (pages[f.project] ?? 1) * QUIET_PAGE;
      for (const s of f.items.slice(0, shown)) out.push({ type: "row", key: s.key, s, hit: hitOf(s) });
      if (f.items.length > shown) out.push({ type: "more", key: `m:${f.project}`, project: f.project, left: f.items.length - shown });
    }
  }
  // Phones: nothing followed yet says so and what fills the list, instead of a blank screen under the pinned rows.
  if (hits && !out.some(e => e.type === "row")) out.push({ type: "label", key: "l:none", text: "No workspace matches." });
  else if (touch && !filter && !hits && model.groups.every(g => !g.items.length)) out.push({ type: "empty", key: "l:nothing" });
  return out;
  if (filter && !out.length) out.push({ type: "label", key: "l:empty", text: `Nothing in ${GROUP_TITLE[filter as HomeGroupId]} right now.` });
  return out;
}
