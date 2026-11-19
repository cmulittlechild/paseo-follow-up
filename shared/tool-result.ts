/**
 * The one reader of a tool call's result as Paseo hands it to plugins (`tool_call` item `detail.output`). Every
 * Follow-up reader of a tool result goes through `toolResult`, never `detail.output` directly
 * (`every-tool-result-reads-through-one-normalizer`, tests/tool-result.test.ts). Paseo sends one of:
 *
 * - Claude: `{ output: X, files? }` (Paseo's Claude provider, `buildToolOutput`): X is the parsed JSON of the result's
 *   text when it parses, else the text itself.
 * - Codex: the raw MCP result `{ content: [{ type: "text", text }], structuredContent?, isError?, _meta? }`. Paseo's own
 *   tools put a summary in front of the JSON in that text ("availableModes_count=3\n…\n\n{…}"); structuredContent
 *   holds the object.
 * - A plain string (other providers, shell output, transcripts) or the object itself.
 */
export type ToolResult = {
  /** The result as text: the string itself, the MCP text blocks joined, or the object as JSON. "" when there's none. */
  text: string;
  /** The result as data: structuredContent, else the parsed JSON (whole text, else its trailing JSON object), else the object itself. */
  value: unknown;
  /** `value` when it's a plain object. */
  object: Record<string, unknown> | null;
  /** An MCP error result (`isError: true`), at any wrapper depth. */
  isError: boolean;
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CLAUDE_WRAPPER_KEYS = new Set(["output", "files"]);
const MAX_DEPTH = 8;

/** JSON text, or text whose JSON value starts on its own line after a preamble ("key=value" lines, a sentence). */
function parseJson(text: string): unknown {
  const body = text.trim();
  if (!body) return undefined;
  try { return JSON.parse(body); } catch { /* not whole JSON */ }
  const at = body.search(/(?:^|\n)\s*[[{]/);
  if (at < 0) return undefined;
  const tail = body.slice(at).trim();
  try { return JSON.parse(tail); } catch { return undefined; }
}

const blockText = (blocks: unknown[]): string =>
  blocks.map(b => typeof b === "string" ? b : record(b) && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");

function read(output: unknown, depth: number): ToolResult {
  if (output === null || output === undefined) return { text: "", value: undefined, object: null, isError: false };
  if (typeof output === "string") {
    const value = parseJson(output);
    return { text: output, value, object: record(value) ? value : null, isError: false };
  }
  if (Array.isArray(output)) {
    // Bare content blocks.
    const text = blockText(output);
    const value = parseJson(text);
    return { text, value, object: record(value) ? value : null, isError: false };
  }
  if (!record(output)) return { text: String(output), value: output, object: null, isError: false };
  if (depth < MAX_DEPTH && "output" in output && Object.keys(output).every(k => CLAUDE_WRAPPER_KEYS.has(k))) return read(output.output, depth + 1);
  if (Array.isArray(output.content)) {
    const text = blockText(output.content);
    const isError = output.isError === true || output.is_error === true;
    const structured = record(output.structuredContent) ? output.structuredContent : undefined;
    const value = structured ?? parseJson(text);
    return { text, value, object: record(value) ? value : null, isError };
  }
  // The object itself (Claude's wrapper already peeled, or a provider that hands the result as data).
  const text = typeof output.text === "string" ? output.text : JSON.stringify(output, null, 2);
  return { text, value: output, object: output, isError: output.isError === true || output.is_error === true };
}

export function toolResult(output: unknown): ToolResult {
  return read(output, 0);
}
