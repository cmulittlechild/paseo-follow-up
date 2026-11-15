/** Workspace list fake: idPrefix/includeInternal are wire-only fields and never filter rows.
 * Keep pagination real so an id lookup cannot pass by inspecting only the first page.
 * Unmodelled filters throw rather than inventing daemon behaviour.
 */
export function workspaceList<T extends { id: string; background?: boolean }>(rows: T[]) {
  return async (options: { filter?: { idPrefix?: string; includeInternal?: boolean; includeBackground?: boolean }; includeBackground?: boolean; page?: { limit?: number; cursor?: string } } = {}) => {
    for (const key of Object.keys(options.filter ?? {})) {
      if (!["idPrefix", "includeInternal", "includeBackground"].includes(key)) throw new Error(`Unmodelled workspace filter: ${key}`);
    }
    const visible = rows.filter(row => options.includeBackground || options.filter?.includeBackground || !row.background);
    const start = Number(options.page?.cursor ?? 0);
    const end = start + (options.page?.limit ?? 200);
    return { entries: visible.slice(start, end), pageInfo: { hasMore: end < visible.length, nextCursor: end < visible.length ? String(end) : null } };
  };
}
