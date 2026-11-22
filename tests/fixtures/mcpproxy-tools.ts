/**
 * A fictional mcpproxy for tests: its servers and read-only tools, in the shapes `mcpproxy upstream list -o json` and
 * `mcpproxy tools list --risk read -o json` print (field names confirmed against a live host; every value invented).
 * Server names are arbitrary on purpose: Follow-up finds each source by its tools, never by a name.
 */
const tool = (server_name: string, name: string, props: string[], description = "") => ({
  server_name, name, description, annotations: { readOnlyHint: true }, schema: { type: "object", properties: Object.fromEntries(props.map(p => [p, { type: "string" }])), required: [] },
  approval_status: "approved", tier: "read",
});
export const FAKE_SERVERS = { issues: "acme-issues", chat: "acme-chat", calendar: "acme-cal", db: "acme-db", mail: "acme-mail" } as const;
export const FAKE_SELF_ID = "UALICE0001";
export function fakeTools(opts: { mail?: boolean } = {}) {
  const s = FAKE_SERVERS;
  return [
    tool(s.issues, "list_issues", ["assignee", "state", "orderBy", "limit", "fields", "cursor", "query"]),
    tool(s.issues, "get_issue", ["id", "fields"]),
    tool(s.issues, "get_user", ["query"]),
    tool(s.issues, "list_teams", []),
    tool(s.chat, "search_messages", ["keywords", "filters", "natural_language_query", "sort", "sort_dir", "limit", "include_context", "response_format"], `Search messages. Current logged in user's user_id is ${FAKE_SELF_ID}.`),
    tool(s.chat, "search_public", ["keywords", "filters", "limit"]),
    tool(s.chat, "search_public_and_private", ["keywords", "filters", "natural_language_query", "sort", "sort_dir", "limit", "include_context", "response_format"]),
    tool(s.chat, "search_channels", ["keywords", "natural_language_query", "limit", "channel_types", "response_format"]),
    tool(s.chat, "search_users", ["keywords", "natural_language_query", "limit", "response_format"]),
    tool(s.chat, "read_thread", ["channel_id", "message_ts", "limit"]),
    tool(s.calendar, "list-events", ["timeMin", "timeMax", "timeZone"], "List the user's events in a time range."),
    tool(s.db, "list_tables", ["schema"]),
    ...(opts.mail ? [tool(s.mail, "search_emails", ["query", "limit"], "Search the user's email inbox.")] : []),
  ];
}
export function fakeUpstreams(over: Partial<Record<keyof typeof FAKE_SERVERS, Record<string, unknown>>> = {}) {
  return (Object.keys(FAKE_SERVERS) as (keyof typeof FAKE_SERVERS)[]).map(k => ({
    name: FAKE_SERVERS[k], enabled: true, connected: true, authenticated: true, oauth: null, quarantined: false, tool_count: 4, status: "ready",
    health: { level: "healthy", status: "ready", summary: "Connected", action: null, usable: true, admin_state: "enabled" }, ...over[k],
  }));
}
/** The discovery calls' replies, or null for any other call (a tool-read the test answers itself). */
export function discoveryReply(args: readonly string[], opts: { mail?: boolean; upstreams?: unknown[] } = {}): string | null {
  if (args[0] === "tools" && args[1] === "list") return JSON.stringify(fakeTools(opts));
  if (args[0] === "upstream" && args[1] === "list") return JSON.stringify(opts.upstreams ?? fakeUpstreams());
  return null;
}
/** A tool-read's `--tool-name`, split: the server and the bare tool. */
export function toolOf(args: readonly string[]): { server: string; tool: string } {
  const q = args.find(x => x.startsWith("--tool-name="))!.slice(12);
  const at = q.indexOf(":");
  return { server: q.slice(0, at), tool: q.slice(at + 1) };
}
