import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as uiApi from "@getpaseo/plugin/client/ui";
import { useCallback, useSyncExternalStore, type ComponentType } from "react";
import { DONE_BADGE, doneBadge, type RowBadge } from "../shared/row-badges";
import { subscribeClock } from "./home-data";
import type { LiveStore } from "./live";

/**
 * Paseo 0.17.1's sidebar workspace-row badges (shared/row-badges.ts). Each row reads the live store Home, the pill and
 * the header dots already share (the worker's feed on 0.16+), so a badge adds no poll and no request. Each row
 * re-renders only when its own answer changes. Hiding one is the Show menu's toggle (the item's title).
 */
type RowBadgeItemProps = { workspaceId: string };
type RowBadgeHost = { addWorkspaceRowBadgeItem(c: { id: string; title: string; icon: string; Component: ComponentType<RowBadgeItemProps> }): (() => void) | void };

/** Whether this host draws workspace-row badges (Paseo 0.17.1 and later). */
export function supportsRowBadges(client: PluginClientContext): boolean {
  return typeof (client as unknown as Partial<RowBadgeHost>).addWorkspaceRowBadgeItem === "function"
    && typeof (uiApi as unknown as { WorkspaceRowBadge?: unknown }).WorkspaceRowBadge !== "undefined";
}

/** Registers Follow-up's row badges on a host that has them; on older hosts nothing registers (the worker keeps the Done label). */
export function contributeRowBadges(client: PluginClientContext, store: LiveStore): () => void {
  if (!supportsRowBadges(client)) return () => undefined;
  const Badge = (uiApi as unknown as { WorkspaceRowBadge: ComponentType<RowBadge> }).WorkspaceRowBadge;
  // The store and the shared minute clock (Done can clear when a deploy window ends), as one subscription.
  const subscribe = (listener: () => void) => { const a = store.subscribe(listener), b = subscribeClock(listener); return () => { a(); b(); }; };

  function DoneRowBadge({ workspaceId }: RowBadgeItemProps) {
    const done = useSyncExternalStore(subscribe, useCallback(() => !!doneBadge(store.get(workspaceId), Date.now()), [workspaceId]));
    const badge = done ? doneBadge(store.get(workspaceId), Date.now()) : null;
    return badge ? <Badge {...badge} /> : null;
  }

  const remove = (client as unknown as RowBadgeHost).addWorkspaceRowBadgeItem({ ...DONE_BADGE, Component: DoneRowBadge });
  return () => { if (typeof remove === "function") remove(); };
}
