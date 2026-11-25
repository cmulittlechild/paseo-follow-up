import test from "node:test";
import assert from "node:assert/strict";
import { BRANCH_MAX, BUILTIN_ACTIONS, branchFor, freeBranch, linearSource, parseSource, renderAction, titleFor, type DispatchSource } from "../shared/dispatch";

/**
 * Invariant 117, a-prompt-says-each-thing-once: whatever the source (typed words, a Linear issue, a GitHub issue or PR,
 * a link), no action's first message carries the same text twice, and a derived branch name ends on a word.
 * 2026-11-25, the developer's first real dispatch from typed words: `Work on “<the words>”.`, the PR line, then the
 * same words again as their own paragraph; and the branch ended `…-now-impro`.
 */
const values = (source: DispatchSource) => ({
  title: source.title !== source.key ? source.title : "", url: source.url, key: source.key ?? "", body: source.body,
  words: source.kind === "text" ? source.body : "", kind: "x", team: source.team, repo: "acme/app", base: "main", branch: "feat-x", why: "",
});
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/…$/, "").trim().toLowerCase();
/** Every sentence-sized run of the source's text, checked once against the prompt. */
function repeats(prompt: string, texts: string[]): string[] {
  const flat = norm(prompt);
  return texts.map(norm).filter(t => t.length >= 12).filter(t => flat.split(t).length > 2);
}
const WORDS = [
  "The billing export drops rows when the account has more than one currency, fix it now and improve the error",
  "Make the invoice page faster.",
  "Add retries to webhook delivery. They fail on a 502 from the edge and nobody notices until a customer writes in.",
  "x".repeat(70),
];
const SOURCES: DispatchSource[] = [
  ...WORDS.map(parseSource),
  linearSource({ key: "ACME-12", title: "Invoice totals are off by one cent", url: "https://linear.app/acme/issue/ACME-12", description: "Invoice totals are off by one cent\n\nSeen on the March invoices.", team: "ACME", branchName: null, state: "Todo" } as never),
  { ...parseSource("https://github.com/acme/app/issues/7"), title: "Search is slow on big projects", body: "Search is slow on big projects", read: true },
  parseSource("https://github.com/acme/app/pull/9"),
  parseSource("https://docs.example.com/spec/billing"),
];

test("no built-in, for any source, says the same text twice", () => {
  for (const source of SOURCES) for (const action of BUILTIN_ACTIONS) {
    const prompt = renderAction(action, values(source));
    const twice = repeats(prompt, [source.title, source.body, ...source.body.split(/(?<=[.!?])\s+/)]);
    assert.deepEqual(twice, [], `${action.id} from ${source.kind} "${source.title.slice(0, 30)}": ${JSON.stringify(prompt)}`);
  }
});

test("typed words lead with the words once, and the action's line still reads", () => {
  const source = parseSource(WORDS[1]);
  const prompt = renderAction(BUILTIN_ACTIONS.find(a => a.id === "pr")!, values(source));
  assert.equal(prompt.split("Make the invoice page faster").length, 2, prompt);
  assert.match(prompt, /^Work on the task below\./, "the first line points at the words instead of repeating them");
  assert.match(prompt, /open a PR from feat-x against main in acme\/app/);
});

test("a Linear title the description repeats isn't dropped from the first line's key", () => {
  const source = SOURCES[WORDS.length];
  const prompt = renderAction(BUILTIN_ACTIONS.find(a => a.id === "pr")!, { ...values(source), body: source.body, words: source.body });
  assert.match(prompt, /^Work on ACME-12 \(https:\/\/linear\.app/, prompt);
  assert.equal(prompt.split("Invoice totals are off by one cent").length, 2, prompt);
});

test("a derived branch ends on a word, also when a suffix makes room", () => {
  for (const words of WORDS) {
    const source = parseSource(words);
    const branch = branchFor(source, "title");
    assert.ok(branch.length <= BRANCH_MAX, branch);
    const slugWords = words.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
    for (const part of branch.split("-")) assert.ok(slugWords.includes(part) || /^x+$/.test(part), `${branch}: "${part}" is a cut word`);
    const taken = freeBranch(branch, [branch]);
    for (const part of taken.split("-").slice(0, -1)) assert.ok(slugWords.includes(part) || /^x+$/.test(part), `${taken}: "${part}" is a cut word`);
  }
  assert.ok(titleFor(parseSource(WORDS[0])).endsWith("…"));
});
