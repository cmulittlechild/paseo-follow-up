import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fitArgs, matchServers, parseReadTools, parseUpstreams, recipe, selfIdFrom, toolFor, type Matched, type ReadTool, type RecipeId, type Upstream } from "../shared/brief-sources";

/**
 * Which mcpproxy server holds which source, found by the tools it exposes (shared/brief-sources.ts's recipes), never
 * by its name: nothing-built-in-about-a-workplace. Every outside read in Follow-up that goes through mcpproxy
 * (New's Linear reader, the Morning brief's sweep, the ranker's chat and calendar, the Summary's issue and thread
 * reads, Linked's team list) asks this for its tool, and calls it only through `mcpproxy call tool-read` with a tool
 * mcpproxy listed as read-only (sources-are-read-only).
 *
 * Discovery is one `mcpproxy tools list --risk read` call, made the first time a reader needs a tool and again when
 * asked (Settings → Morning brief opening, Check sources again, the morning run): never on its own timer. It heals
 * itself: a reader that finds no server for its recipe asks again first (at most once per `MISS_REDISCOVER_MS`), so an
 * upstream that was down or still connecting at the first discovery is found once it's back; a failed discovery is
 * remembered for `FAILED_DISCOVERY_MS`, so a down mcpproxy isn't asked on every read.
 */
/** The text of an `mcpproxy call … -o json` reply; a tool error throws its first line. */
export function mcpproxyText(stdout: string): string {
  const at = stdout.search(/\{\s*"content"\s*:/);
  if (at < 0) throw new Error("mcpproxy returned no result");
  const data = JSON.parse(stdout.slice(at)) as { content?: { text?: string }[]; isError?: boolean };
  const text = (data.content ?? []).map(b => b.text ?? "").join("\n");
  if (data.isError) throw new Error(text.slice(0, 200) || "mcpproxy tool error");
  const wrapped = /^\[map\[text:([\s\S]*) type:text\]\]$/.exec(text.trim());
  return wrapped ? wrapped[1] : text;
}

export type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
const exec = promisify(execFile);
/** The live run every reader defaults to, so they share one directory (one discovery). */
export const liveRun: Run = async (command, args, timeout) => (await exec(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;

/** The error a reader gets when no server has a recipe's tools. Its wording reads as "not set up" to the readers' checks. */
export class NoSourceError extends Error {
  constructor(id: RecipeId, role: string) { super(`${recipe(id).label} tools not found in mcpproxy (no read-only server has ${role}).`); this.name = "NoSourceError"; }
}

export type Discovery = { at: number; tools: ReadTool[]; matched: Matched[] };

/** A recipe no server has: discovery older than this is asked again before the reader gets NoSourceError. */
export const MISS_REDISCOVER_MS = 10 * 60_000;
/** A discovery that failed (mcpproxy down): its error is the answer for this long. */
export const FAILED_DISCOVERY_MS = 60_000;

export class SourceDirectory {
  private found: Discovery | null = null;
  private pending: Promise<Discovery> | null = null;
  private failed: { at: number; error: unknown } | null = null;
  /** Discovery calls made, for tests and the scale check. */
  discoveries = 0;
  constructor(private run: Run = liveRun, private now: () => number = Date.now) {}

  /**
   * The read tools and their recipes: cached; `fresh` asks mcpproxy again (`always`: even inside a failure's
   * `FAILED_DISCOVERY_MS`, for a developer's Check sources again). A failed discovery keeps the last good one for
   * readers that have it; without one, its error answers every read for `FAILED_DISCOVERY_MS`.
   */
  discover(fresh: boolean | "always" = false): Promise<Discovery> {
    if (this.found && !fresh) return Promise.resolve(this.found);
    if (fresh !== "always" && this.failed && this.now() - this.failed.at < FAILED_DISCOVERY_MS) {
      return this.found ? Promise.resolve(this.found) : Promise.reject(this.failed.error);
    }
    return this.pending ??= (async () => {
      this.discoveries++;
      try {
        const tools = parseReadTools(await this.run("mcpproxy", ["tools", "list", "--risk", "read", "-o", "json", "--log-level=error"], 30_000));
        this.found = { at: this.now(), tools, matched: matchServers(tools) };
        this.failed = null;
        return this.found;
      } catch (error) { this.failed = { at: this.now(), error }; throw error; }
    })().finally(() => { this.pending = null; });
  }

  /** What the last discovery found, without asking mcpproxy (null before the first). */
  cached(): Discovery | null { return this.found; }

  /** `mcpproxy upstream list`: each server's own state, for the Sources card's health. */
  async upstreams(): Promise<Upstream[]> {
    return parseUpstreams(await this.run("mcpproxy", ["upstream", "list", "-o", "json", "--log-level=error"], 30_000));
  }

  /** `server:tool` for a recipe's role, or null when no server has it. `allowed` narrows the servers (the brief's switches). */
  async tool(id: RecipeId, role: string, allowed?: (server: string) => boolean): Promise<string | null> {
    let d = await this.discover();
    // No server has it at all (not merely switched off): the first discovery may have run while its upstream was
    // down, so ask again, at most once per MISS_REDISCOVER_MS.
    if (!toolFor(d.matched, id, role) && this.now() - d.at >= MISS_REDISCOVER_MS) d = await this.discover(true).catch(() => d);
    return toolFor(d.matched, id, role, allowed);
  }
  /** The tool's inputs, so a call carries only what it takes. */
  async props(qualified: string): Promise<string[]> {
    const at = qualified.indexOf(":");
    const t = (await this.discover()).tools.find(x => x.server === qualified.slice(0, at) && x.name === qualified.slice(at + 1));
    return t?.props ?? [];
  }
  /** The developer's own chat id, from the chat server's tool descriptions. */
  async selfId(allowed?: (server: string) => boolean): Promise<string | null> {
    const d = await this.discover();
    const servers = new Set(d.matched.filter(m => m.recipe === "chat" && (!allowed || allowed(m.server))).map(m => m.server));
    return selfIdFrom(d.tools.filter(t => servers.has(t.server)));
  }

  /**
   * One read: the recipe's tool for `role`, with only the arguments its schema takes, through `tool-read`. Throws
   * NoSourceError when no (allowed) server has it.
   */
  async call(id: RecipeId, role: string, args: Record<string, unknown>, opts: { reason: string; timeoutMs: number; allowed?: (server: string) => boolean; fit?: boolean }): Promise<string> {
    const tool = await this.tool(id, role, opts.allowed);
    if (!tool) throw new NoSourceError(id, role);
    const json = opts.fit === false ? args : fitArgs(await this.props(tool), args);
    return mcpproxyText(await this.run("mcpproxy", ["call", "tool-read", `--tool-name=${tool}`, `--json_args=${JSON.stringify(json)}`, `--reason=Follow-up: ${opts.reason}`, "--log-level=error", "-o", "json"], opts.timeoutMs));
  }
}

/** One directory per `run` (the live one is shared by every reader in the worker, so discovery happens once). */
const directories = new WeakMap<Run, SourceDirectory>();
export function sourceDirectory(run: Run = liveRun): SourceDirectory {
  let d = directories.get(run);
  if (!d) { d = new SourceDirectory(run); directories.set(run, d); }
  return d;
}
