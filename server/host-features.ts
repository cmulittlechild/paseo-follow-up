import { compareVersions, parseVersion } from "../shared/version";
/**
 * What the Paseo host says it can do, from the daemon's server_info `features` (the daemon client keeps the last one
 * it got while connecting: `getLastServerInfoMessage()`). Paseo 0.16 advertises `agentBackgroundWork`: it tracks an
 * agent's background shell jobs, shows them with Stop, and wakes the agent when one finishes. Follow-up retires Wait
 * there (docs/wait.md). Paseo 0.15 doesn't advertise it.
 *
 * The answer can't change without a daemon restart, which restarts this worker too, so the first real answer is
 * kept. A failed or empty read answers false (Wait stays as on 0.15) and is asked again next time.
 */
export type ServerInfo = { features?: Record<string, unknown> | null; version?: unknown } | null | undefined;

export function hostFeature(feature: string, read: () => Promise<ServerInfo>): () => Promise<boolean> {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    let info: ServerInfo;
    try { info = await read(); } catch { return false; }
    if (!info) return false;
    return known = info.features?.[feature] === true;
  };
}

/**
 * Whether the host's version is at least `min` (a release: a prerelease of `min` answers false), for what server_info
 * names no feature for. Paseo 0.17.1 draws plugin badges on sidebar workspace rows (`addWorkspaceRowBadgeItem`) and
 * says so only by its version. Kept like `hostFeature`: an unknown version answers false and is asked again.
 */
export function hostAtLeast(min: string, read: () => Promise<ServerInfo>): () => Promise<boolean> {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    let info: ServerInfo;
    try { info = await read(); } catch { return false; }
    const version = typeof info?.version === "string" ? info.version : "";
    if (!parseVersion(version)) return false;
    return known = compareVersions(version, min) >= 0;
  };
}
/** The first Paseo that draws plugin workspace-row badges. */
export const ROW_BADGES_SINCE = "0.17.1";
