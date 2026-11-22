type Issue = { code?: unknown; path?: unknown; message?: unknown; maximum?: unknown; minimum?: unknown; origin?: unknown };
/** A zod error's issues, or those in its message (a JSON array with `code` and `path`) after it crossed an RPC as text. */
function schemaIssues(error: unknown): Issue[] | null {
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "ZodError" && Array.isArray((error as { issues?: unknown }).issues)) return (error as { issues: Issue[] }).issues;
  const raw = (error instanceof Error ? error.message : typeof error === "string" ? error : "").replace(/^Request failed:\s*/i, "").replace(/\s*requestType=\S+.*$/s, "").trim();
  if (!/^\[\s*\{/.test(raw) || !/"code"\s*:/.test(raw) || !/"path"\s*:/.test(raw)) return null;
  try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? parsed as Issue[] : null; } catch { return []; }
}
export const isSchemaError = (error: unknown): boolean => schemaIssues(error) !== null;
function issueText(i: Issue): string {
  const where = Array.isArray(i.path) && i.path.length ? i.path.map(String).join(".") : "the request";
  const list = i.origin === "array", str = i.origin === "string";
  if (i.code === "too_big" && typeof i.maximum === "number") return list ? `${where} has more than ${i.maximum} items` : str ? `${where} is longer than ${i.maximum} characters` : `${where} is above ${i.maximum}`;
  if (i.code === "too_small" && typeof i.minimum === "number") return list ? `${where} needs at least ${i.minimum} item${i.minimum === 1 ? "" : "s"}` : str ? `${where} is too short` : `${where} is below ${i.minimum}`;
  if (i.code === "invalid_type") return `${where} is missing or the wrong type`;
  return `${where} isn't valid`;
}
/**
 * A schema validator's issue list as one plain sentence (invariant pr-scale-lists-batch-not-throw): what didn't fit,
 * never the JSON. The full issues go to the plugin log (`plainError`), not onto a card, a pill or a tool result.
 */
export function schemaErrorText(error: unknown): string {
  const issues = schemaIssues(error) ?? [];
  const parts = [...new Set(issues.slice(0, 3).map(issueText))];
  return parts.length ? `Follow-up couldn't finish this: ${parts.join("; ")}${issues.length > 3 ? `; +${issues.length - 3} more` : ""}. The details are in the plugin log.` : "Follow-up couldn't finish this: some data didn't fit what it expects. The details are in the plugin log.";
}
/** The error to throw to a person or an agent: a schema error becomes one plain sentence (its issues logged); others pass. */
export function plainError(error: unknown, log: (detail: string) => void = d => console.error(d)): unknown {
  if (!isSchemaError(error)) return error;
  log(`[follow-up] schema error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
  return new Error(schemaErrorText(error));
}

/** RPC errors arrive as "Request failed: <reason> requestType=… code=…"; people only need the reason. */
export function errorText(error: unknown): string {
  if (isSchemaError(error)) return schemaErrorText(error);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^Request failed:\s*/i, "").replace(/\s*requestType=\S+.*$/s, "").trim() || "Something went wrong. Try again.";
}

/** A reason as one sentence with exactly one stop, so more text can follow it: "x." and "x" both become "x.". */
export function sentence(reason: string): string {
  const t = reason.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** The server's refusals for an action on a brief card that isn't the live, open brief (server/inbox.ts briefAction). */
export const STALE_BRIEF = {
  replaced: "This brief was replaced by a newer one. Read the newest card.",
  answered: "This brief was already answered or signed off.",
} as const;
// Q35 answered or withdrawn elsewhere (server/questions.ts developerAnswer, recordAnswer).
const MOOT = [/^This brief was (replaced by a newer one|already answered or signed off)\./, /^Q\d+ (is already (answered|withdrawn|dismissed)|was (withdrawn|dismissed))\b/,
  // Dismiss (server/dismiss.ts, Inbox.dismiss): the item left Needs you by itself, or another surface dismissed it first.
  /^\S+ is already (gone from Needs you|dismissed)\./, /^This agent's ask is already gone from Needs you\./];

/**
 * A refusal that means the action is moot, not failed: what it acts on was already answered, replaced or withdrawn
 * somewhere else. The surface reconciles to the resolved state (runAction's `reconcile`); it never offers Retry.
 */
export function isMoot(error: unknown): boolean {
  const t = errorText(error);
  return MOOT.some(r => r.test(t));
}

/** Which moot refusal it is, so a surface says it in its own words instead of echoing the server's. */
export function mootKind(error: unknown): "answered" | "withdrawn" | "replaced" | "dismissed" | null {
  const t = errorText(error);
  if (/^Q\d+ (is already dismissed|was dismissed)\b/.test(t)) return "dismissed";
  if (/^This brief was replaced by a newer one\./.test(t)) return "replaced";
  if (/^Q\d+ (is already withdrawn|was withdrawn)\b/.test(t)) return "withdrawn";
  return isMoot(error) ? "answered" : null;
}

/** The note a surface shows when an answer turned out moot: what happened, and that nothing was sent. */
export function mootNote(error: unknown, typed = false): string {
  const kept = typed ? "Your answer wasn't sent." : "Your pick wasn't sent.";
  switch (mootKind(error)) {
    case "withdrawn": return `The agent withdrew this question. ${kept}`;
    case "dismissed": return `This question was removed. ${kept}`;
    case "replaced": return `A newer card replaced this one. ${kept}`;
    default: return `Already answered elsewhere. ${kept}`;
  }
}
