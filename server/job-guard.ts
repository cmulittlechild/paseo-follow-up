/**
 * The one guard on every Claude job (sources-are-read-only): an AI job that reads outside content can only read.
 *
 * A job's prompt carries text someone else wrote (a plan artifact, a Slack thread, an issue). A prompt telling the model
 * "read only" is not a guard: the text can say otherwise. So each `claude -p` job runs with a PreToolUse hook, passed
 * with `--settings` (still loaded under `--setting-sources ""`), that refuses every tool call outside the job's grant
 * before Claude Code runs it, whatever `--allowedTools` says. A refused call doesn't fail the job: the model is told
 * no and carries on, so a plan reader whose plan says "publish this" still reads the plan. Claude Code reports each
 * refusal in the reply's `permission_denials`; the job log keeps the tool and action names only (refusedCalls).
 *
 * Codex jobs need no hook: `codex exec` runs in a read-only sandbox without the shell tool (ai-jobs.ts codexArgs).
 */

/** The tool calls a job may make: a tool name, the `action` values it may take (absent: any), and inputs it may never carry. */
export type ToolGrant = Record<string, { actions?: readonly string[]; forbid?: readonly string[] }>;

/** The plan reader (and Settings' title read): the Artifact tool's read, and never a read that saves files outside its folder. */
export const ARTIFACT_READ: ToolGrant = { Artifact: { actions: ["read"], forbid: ["out_dir"] } };

/** The environment variable that carries the job's grant to the hook. */
export const GRANT_ENV = "FOLLOW_UP_JOB_TOOLS";

/**
 * The hook, run by Node with `-e`: Claude Code's PreToolUse input on stdin, a deny decision on stdout, or nothing to let
 * the call through to the job's own `--allowedTools`. Anything it can't read is refused (fail closed). No single quotes:
 * the command line quotes it with them.
 */
export const GUARD_SCRIPT = `
let raw = "";
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  let refuse = true;
  try {
    const call = JSON.parse(raw);
    const grant = JSON.parse(process.env.${GRANT_ENV} || "{}");
    const rule = typeof call.tool_name === "string" && Object.prototype.hasOwnProperty.call(grant, call.tool_name) ? grant[call.tool_name] : null;
    const input = call.tool_input && typeof call.tool_input === "object" ? call.tool_input : {};
    refuse = !rule || (Array.isArray(rule.actions) && !rule.actions.includes(input.action)) || (rule.forbid || []).some(key => key in input);
  } catch (error) { refuse = true; }
  if (!refuse) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "Follow-up jobs can only read. This call was refused; answer from what you have read." } }));
});
`;

if (GUARD_SCRIPT.includes("'")) throw new Error("GUARD_SCRIPT must not contain a single quote.");

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The Node that runs Follow-up, as a command another process can start (Paseo's desktop app is Electron: see agent-mcp.ts). */
export function nodeRuntime(runtime = { execPath: process.execPath, electron: process.versions.electron, appImage: process.env.APPIMAGE }): { command: string; env: Record<string, string> } {
  return { command: runtime.electron ? runtime.appImage ?? runtime.execPath : runtime.execPath, env: runtime.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

/** The `--settings` argument and environment that put the guard on one `claude -p` job. */
export function guardFor(grant: ToolGrant, runtime = nodeRuntime()): { args: string[]; env: Record<string, string> } {
  const command = `${shellQuote(runtime.command)} -e ${shellQuote(GUARD_SCRIPT)}`;
  const settings = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] }] } };
  return { args: ["--settings", JSON.stringify(settings)], env: { ...runtime.env, [GRANT_ENV]: JSON.stringify(grant) } };
}

/** The refused calls in a `claude -p` reply, as "Tool.action" names only (never their inputs). */
export function refusedCalls(denials: unknown): string[] {
  if (!Array.isArray(denials)) return [];
  const name = (v: unknown) => typeof v === "string" && /^[A-Za-z][\w-]{0,40}$/.test(v) ? v : null;
  return denials.slice(0, 20).map(d => {
    const tool = name(d?.tool_name) ?? "other";
    const action = d?.tool_input && typeof d.tool_input === "object" ? d.tool_input.action : undefined;
    return action === undefined ? tool : `${tool}.${name(action) ?? "other"}`;
  });
}
