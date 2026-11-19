/**
 * Tool results in the shapes Paseo really hands plugins (`tool_call` `detail.output`), captured from a live daemon's
 * timeline on 2026-11-19 (Paseo 0.16.2; 0.17.0-beta.1 builds them the same way) with every id and name made fictional.
 * Any test of a reader of tool results uses these, never an idealised shape (shared/tool-result.ts).
 */

/** Paseo's Claude provider (`buildToolOutput`): the result's text parsed as JSON when it parses, under `output`. */
export const claudeShape = (value: unknown, files?: unknown[]) => ({ output: value, ...(files ? { files } : {}) });

/** Paseo's own tools' model text (`formatStructuredContentForModel`): `<key>_count` / `<key>_ids` lines, then the JSON. */
function modelText(value: Record<string, unknown>): string {
  const summary: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (!Array.isArray(v)) continue;
    summary.push(`${key}_count=${v.length}`);
    const ids = v.map(x => x && typeof x === "object" ? (x as { id?: unknown }).id : null).filter((id): id is string => typeof id === "string" && !!id);
    if (ids.length === v.length && ids.length) summary.push(`${key}_ids=${ids.join(",")}`);
  }
  const json = JSON.stringify(value, null, 2);
  return summary.length ? `${summary.join("\n")}\n\n${json}` : json;
}

/** Codex: the raw MCP result, structuredContent beside the model text. */
export const codexShape = (value: Record<string, unknown>) => ({
  _meta: { "paseo/tool": "fixture" }, content: [{ type: "text", text: modelText(value) }], structuredContent: value,
});

/** A provider that hands the result's text as is. */
export const plainShape = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

export const SHAPES = { claude: claudeShape, codex: codexShape, plain: plainShape } as const;
/** The tool name each provider gives Paseo's MCP tools. */
export const toolName = (provider: keyof typeof SHAPES, tool: string) => provider === "codex" ? `paseo.${tool}` : `mcp__paseo__${tool}`;

/** create_agent's result (ids fictional). */
export const agentCreated = {
  agentId: "agent-acme-new", type: "claude", status: "running", cwd: "/home/user/acme/app", workspaceId: "wks_acme_app",
  currentModeId: "bypassPermissions",
  availableModes: [
    { id: "plan", label: "Plan Mode", description: "Analyze the codebase without executing tools or edits" },
    { id: "default", label: "Always Ask", description: "Prompts for permission the first time a tool is used" },
    { id: "bypassPermissions", label: "Bypass", description: "Skips permission prompts" },
  ],
  guidance: "Creation acknowledged.",
};

/** create_workspace's result (WorkspaceAutomationSummary; ids fictional). */
export const workspaceCreated = {
  workspaceId: "wks_acme_billing", projectId: "prj_acme", cwd: "/home/user/.paseo/worktrees/acme/billing-retry",
  isolation: "worktree", kind: "worktree", title: "billing-retry",
};
