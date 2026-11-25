import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { GithubOff } from "../shared/github-setup";

/**
 * Whether GitHub is on for this host (invariant 110, `works-without-github`): the GitHub CLI installed, or an explicit
 * GH_TOKEN/GITHUB_TOKEN, and a token it can hand out. Every GitHub read (`githubApi`), write and agent tool asks here
 * first, so while GitHub is off nothing spawns gh, retries or logs on a timer.
 *
 * Cheap to ask: the answer is cached, and while GitHub is off it is checked again only when the host changed in a way
 * that could turn it on (a `gh` appeared on PATH, gh's hosts.yml was written by `gh auth login`, a token env var
 * appeared), looked at with a few stat calls at most every `LOOK_MS`. A token gh refuses later (`invalidate`) checks
 * once more. So installing gh and signing in is picked up without a restart.
 */
export const LOOK_MS = 30_000;

export type SetupState = { on: true; explicit: boolean } | { on: false; off: GithubOff };
type Run = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
type Deps = { env?: NodeJS.ProcessEnv; now?: () => number; run?: Run; stat?: (path: string) => { mtimeMs: number; size: number; isFile: boolean } | null };

const defaultStat = (path: string) => { try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() }; } catch { return null; } };
const defaultRun: Run = (bin, args, env) => new Promise((resolve, reject) => execFile(bin, args, { env, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

export class GithubSetup {
  private state: SetupState | null = null;
  private checking: Promise<SetupState> | null = null;
  private print = "";
  private lookedAt = -Infinity;
  private listeners = new Set<(state: SetupState) => void>();
  constructor(private deps: Deps = {}) {}
  private get env() { return this.deps.env ?? process.env; }
  private get now() { return (this.deps.now ?? Date.now)(); }
  private stat(path: string) { return (this.deps.stat ?? defaultStat)(path); }

  /** The gh binary token lookups run (never the ~/.local/bin wrapper): FOLLOW_UP_GH_BIN, /usr/bin/gh, else gh on PATH. Null when there is none. */
  binary(): string | null {
    const env = this.env;
    if (env.FOLLOW_UP_GH_BIN) return this.stat(env.FOLLOW_UP_GH_BIN)?.isFile ? env.FOLLOW_UP_GH_BIN : null;
    if (this.stat("/usr/bin/gh")?.isFile) return "/usr/bin/gh";
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && this.stat(join(dir, "gh"))?.isFile) return join(dir, "gh");
    return null;
  }
  private explicit() { return !!(this.env.GH_TOKEN || this.env.GITHUB_TOKEN); }
  /** What could turn GitHub on: the binary, gh's hosts.yml (written by gh auth login) and a token env var. */
  private fingerprint(): string {
    const env = this.env;
    const config = env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "gh");
    const hosts = this.stat(join(config, "hosts.yml"));
    return JSON.stringify([this.binary(), this.explicit(), hosts ? [hosts.mtimeMs, hosts.size] : null]);
  }
  private async probe(): Promise<SetupState> {
    if (this.explicit()) return { on: true, explicit: true };
    const bin = this.binary();
    if (!bin) return { on: false, off: "missing" };
    const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...env } = this.env;
    const token = await (this.deps.run ?? defaultRun)(bin, ["auth", "token"], { ...env, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent/gh-no-session-bus" }).then(s => s.trim(), () => "");
    return token ? { on: true, explicit: false } : { on: false, off: "signed-out" };
  }
  private set(next: SetupState) {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) for (const listener of this.listeners) { try { listener(next); } catch { /* a listener's own problem */ } }
  }
  /** Checks again now (setup's Check again, a token GitHub refused). */
  check(): Promise<SetupState> {
    this.checking ??= (async () => {
      this.print = this.fingerprint(); this.lookedAt = this.now;
      const next = await this.probe();
      this.set(next);
      return next;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  /**
   * The current answer, checked once on first use. While off, a look (stats only) at most every LOOK_MS; a changed
   * fingerprint checks again. Never spawns while nothing changed.
   */
  async current(): Promise<SetupState> {
    if (this.checking) return this.checking;
    if (!this.state) return this.check();
    if (!this.state.on && this.now - this.lookedAt >= LOOK_MS) {
      this.lookedAt = this.now;
      if (this.fingerprint() !== this.print) return this.check();
    }
    return this.state;
  }
  /** Why GitHub is off as last known, without waiting (null: on, or not checked yet; unknown is not off). */
  off(): GithubOff | null { return this.state && !this.state.on ? this.state.off : null; }
  /** Whether a write can run: on, and a gh binary to run it. Null when it can, else why not. */
  async writeOff(): Promise<GithubOff | null> {
    const state = await this.current();
    if (!state.on) return state.off;
    return this.binary() ? null : "missing";
  }
  /** A read found the token refused or gone: check again (once; a check in flight is shared). */
  invalidate(): void { if (this.state?.on && !this.state.explicit) void this.check(); }
  /** Called when the answer changes (the engine re-reads PRs at once when GitHub comes on). */
  onChange(listener: (state: SetupState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

let shared: GithubSetup | null = null;
/** The worker's one answer, shared by every GitHub path. */
export function githubSetup(): GithubSetup { return shared ??= new GithubSetup(); }
