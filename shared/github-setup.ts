/**
 * GitHub is an optional integration (invariant 110, `works-without-github`). Follow-up reads PRs, checks and reviews
 * through the GitHub CLI's sign-in; without it everything that isn't about GitHub works as before, and each GitHub
 * surface says in one line what's missing and how to turn it on. One set of words for every surface and agent tool.
 */
export const GITHUB_OFF = ["missing", "signed-out"] as const;
/** Why GitHub is off on the host: the CLI isn't installed, or it is and nobody is signed in. */
export type GithubOff = typeof GITHUB_OFF[number];
export const GITHUB_CLI_URL = "https://cli.github.com";
export const GITHUB_LOGIN_COMMAND = "gh auth login";

/** What turning it on takes, in one sentence. */
export function githubOnSteps(off: GithubOff): string {
  return off === "missing"
    ? `Install the GitHub CLI (${GITHUB_CLI_URL}) on the computer running Paseo and run ${GITHUB_LOGIN_COMMAND}.`
    : `Run ${GITHUB_LOGIN_COMMAND} on the computer running Paseo.`;
}
const STATE: Record<GithubOff, string> = { missing: "The GitHub CLI isn't installed", "signed-out": "The GitHub CLI isn't signed in" };

/**
 * The one line a GitHub surface or agent tool answers with while GitHub is off: `<what> needs GitHub. <state>: <steps>
 * Follow-up picks it up on its own.` `what` is the feature, sentence-cased ("Merging", "Waiting for checks"); null for a read
 * with no feature name ("GitHub isn't connected.").
 */
export function githubOffText(off: GithubOff, what: string | null): string {
  return `${what ? `${what} needs GitHub.` : "GitHub isn't connected."} ${STATE[off]}: ${githubOnSteps(off)} Follow-up picks it up on its own, no restart.`;
}

/** What the GitHub integration adds, for setup and the Pull requests card. */
export const GITHUB_ADDS = "PR status, review threads and failed checks as repairs, merge, reviewers, Wait for checks, deploy checks and PR stats";

/** The Pull requests card's line while GitHub is off (the same slot as the budget's line, githubWaitLine). */
export function githubOffLine(off: GithubOff | null | undefined): { title: string; detail: string; label: string; command: string; url: string | null } | null {
  if (!off) return null;
  const title = off === "missing" ? "GitHub not connected · PR status is off" : "GitHub signed out · PR status is off";
  // The card links to the install page itself (url), so its words carry no raw address.
  const steps = off === "missing" ? `Install the GitHub CLI on the computer running Paseo, then run ${GITHUB_LOGIN_COMMAND}.` : githubOnSteps(off);
  const detail = `${steps} Follow-up picks it up on its own.`;
  return { title, detail, label: `${title}. ${detail}`, command: GITHUB_LOGIN_COMMAND, url: off === "missing" ? GITHUB_CLI_URL : null };
}

/** Thrown by every GitHub read or write while GitHub is off; its message is githubOffText's. */
export class GithubOffError extends Error {
  constructor(readonly off: GithubOff, what: string | null = null) { super(githubOffText(off, what)); this.name = "GithubOffError"; }
}
export const isGithubOff = (error: unknown): error is GithubOffError => error instanceof GithubOffError || (!!error && typeof error === "object" && (error as { name?: unknown }).name === "GithubOffError");
