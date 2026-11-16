import { DEVELOPER, type Actor } from "../shared/actor";
import type { Workspace } from "../shared/model";
import { MAX_ARTIFACTS, validSpecUrl, type Artifact } from "../shared/spec";

import { fillWorkspaceTitles, localTitles, receiptTitle, titleKey, type TitleIndex } from "../shared/local-titles";
import { artifactPublishUrl } from "./local-titles";

type Entry = { item: unknown; timestamp?: string };

/**
 * Claude artifacts this session published, from completed Artifact tool receipts only. Reads, lists,
 * quickstarts and asset uploads also mention artifact links and never count; neither do links in chat.
 */
export function publishedArtifacts(entries: readonly Entry[], agentId: string, titles?: TitleIndex): Artifact[] {
  const found = new Map<string, Artifact>();
  for (const entry of entries) {
    const v = entry.item as { type?: string; name?: string; status?: string; error?: unknown; detail?: { type?: string; input?: unknown; output?: unknown } } | null;
    if (!v || v.type !== "tool_call" || v.name !== "Artifact" || v.status !== "completed" || v.error) continue;
    const input = (v.detail?.input && typeof v.detail.input === "object" ? v.detail.input : {}) as Record<string, unknown>;
    if ((input.action ?? "publish") !== "publish" || input.asset === true) continue;
    const url = artifactPublishUrl(v.detail?.output);
    if (!url) continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const previous = found.get(url);
    found.set(url, {
      url: url, title: titles?.get(titleKey(url))?.title ?? receiptTitle(input)?.title ?? previous?.title ?? null, by: agentId,
      ...(titles?.get(titleKey(url)) ? { titleRank: titles.get(titleKey(url))!.rank } : {}),
      firstAt: previous?.firstAt ?? at, lastAt: at ?? previous?.lastAt ?? null, publishes: (previous?.publishes ?? 0) + 1,
    });
  }
  return [...found.values()];
}

const later = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");

/** Keeps the workspace's artifact list current. Newer scans replace what they cover; others stay. */
export function mergeArtifacts(w: Workspace, scanned: Artifact[], now = Date.now()): boolean {
  const byUrl = new Map<string, Artifact>();
  for (let a of scanned) {
    const previous = w.artifacts.find(old => titleKey(old.url) === titleKey(a.url));
    if (previous?.title && (!a.title || (previous.titleRank ?? 1) > (a.titleRank ?? 1))) a = { ...a, title: previous.title, ...(previous.titleRank ? { titleRank: previous.titleRank } : {}) };
    const seen = byUrl.get(a.url);
    byUrl.set(a.url, seen ? { ...seen, publishes: seen.publishes + a.publishes, title: seen.title ?? a.title, firstAt: [seen.firstAt, a.firstAt].filter(Boolean).sort()[0] ?? null, lastAt: [seen.lastAt, a.lastAt].sort(later).at(-1) ?? null, by: a.by === w.mainAgentId ? a.by : seen.by } : a);
  }
  const next = [...byUrl.values(), ...w.artifacts.filter(a => !byUrl.has(a.url))]
    .sort((a, b) => later(b.lastAt, a.lastAt)).slice(0, MAX_ARTIFACTS);
  const changed = JSON.stringify(next) !== JSON.stringify(w.artifacts);
  w.artifacts = next;
  const enriched = fillWorkspaceTitles(w, localTitles([w]));
  return chooseDetectedSpec(w, now) || changed || enriched;
}

/**
 * When neither the developer nor the main agent chose a spec, the main agent's most republished
 * artifact is the spec (a spec gets updated; one-off pages don't), newest first on ties.
 */
export function chooseDetectedSpec(w: Workspace, now = Date.now()): boolean {
  if (w.spec && w.spec.source !== "detected") return false;
  const ranked = [...w.artifacts].sort((a, b) =>
    Number(b.by === w.mainAgentId) - Number(a.by === w.mainAgentId) || b.publishes - a.publishes || later(b.lastAt, a.lastAt));
  const best = ranked[0];
  if (!best) return false;
  if (w.spec?.url === best.url && w.spec.title === best.title) return false;
  w.spec = { url: best.url, title: best.title, source: "detected", by: best.by, at: best.lastAt ?? new Date(now).toISOString() };
  return true;
}

/** set_spec from the main agent. A link the developer set or removed stays theirs. */
export function agentSetSpec(w: Workspace, agentId: string, url: string, title: string | undefined, now: number): { applied: boolean; message: string } {
  if (w.mainAgentId !== agentId) throw new Error("Only this workspace's main agent can set the spec link.");
  const valid = validSpecUrl(url);
  if (!valid) throw new Error("Use the spec's full https:// link, such as the Claude artifact URL from your publish result.");
  if (w.spec?.source === "developer") return { applied: false, message: w.spec.url ? "The developer chose this workspace's spec link in Follow-up, so it stays. Nothing to do." : "The developer removed the spec link in Follow-up, so it stays off. Nothing to do." };
  w.spec = { url: valid, title: title?.trim().slice(0, 120) || w.artifacts.find(a => a.url === valid)?.title || null, source: "agent", by: agentId, at: new Date(now).toISOString() };
  return { applied: true, message: "Spec link saved. It shows in Follow-up's header. Keep republishing to the same URL; call set_spec again only if the link changes." };
}

/** The developer sets, removes, or hands the link back to agents and detection. */
export function developerSetSpec(w: Workspace, input: { action: "set"; url: string; title?: string | null } | { action: "remove" } | { action: "reset" }, now: number, actor: Actor = DEVELOPER): void {
  // set_workspace_spec by another agent is that agent's choice, not "Set by you".
  const source = actor.kind === "agent" ? "agent" as const : "developer" as const;
  const by = actor.kind === "agent" ? actor.agentId : null;
  const at = new Date(now).toISOString();
  if (input.action === "set") {
    const url = validSpecUrl(input.url);
    if (!url) throw new Error("Enter a full https:// link.");
    w.spec = { url, title: input.title?.trim().slice(0, 120) || w.artifacts.find(a => a.url === url)?.title || null, source, by, at };
  } else if (input.action === "remove") {
    w.spec = { url: null, title: null, source, by, at };
  } else {
    w.spec = null;
    chooseDetectedSpec(w, now);
  }
}
