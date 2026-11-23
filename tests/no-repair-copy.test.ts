import { sendButton, sendItems } from "../shared/send-words";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One word for one thing (Q141, 2026-11-23, reversing Q49/Q51's "the word is tasks"): "tasks" is only the agent's
 * to-do list (the "Agent's tasks" card); what Follow-up finds on a PR and sends the agent (a conflict, review feedback,
 * a failing check, a restack) is a "repair" on every surface the developer reads. Only the copy is scanned: a comment,
 * an internal identifier or an invariant's `why` (history, never shown) doesn't count. The message an agent receives
 * keeps its own wording (server/tasks.ts).
 */
const ROOTS = ["client", "shared"];
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
});
/** The source without comments: block comments, and line comments that start a line or follow whitespace (not a URL's //). */
const uncommented = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, "$1");
/** Every string literal (a template's \${…} code left out) and JSX text run, with the invariants' `why:` history left out. */
export function copyStrings(src: string): string[] {
  const code = uncommented(src).replace(/\bwhy:\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, "why: 0");
  const literals = [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(m => m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " "));
  const jsx = [...code.matchAll(/>([^<>{}=;()]*[A-Za-z][^<>{}=;()]*)</g)].map(m => m[1]);
  return [...literals, ...jsx];
}
const identifier = (s: string) => /^[\w:.\-/]*$/.test(s.trim());

/** Copy that counts or names what Follow-up queues and sends: "Send 2 tasks", "2 tasks queued", "Send tasks automatically". */
const SEND_AS_TASKS = /\b(send|sent|retry|auto-send)\s+(\d+\s+)?tasks?\b|\btasks?\s+(queued|ready|sent|wait for you|couldn't be sent)\b|\btasks it sent\b|\bqueued tasks\b|\bsend tasks automatically\b|\bsends tasks automatically\b|\bas a task to the agent\b|\bbecome tasks\b|\btask sent to the agent\b|"1 task"/i;

test("no developer-facing copy calls a repair a task: tasks are only the agent's to-do list (Q141, invariant 16)", () => {
  const hits = ROOTS.flatMap(files).flatMap(f => {
    const src = readFileSync(f, "utf8");
    return [...copyStrings(src), ...uncommented(src).split("\n").filter(l => /"1 task"/.test(l))].filter(s => SEND_AS_TASKS.test(s)).map(s => `${f}: ${s.trim().slice(0, 120)}`);
  });
  assert.deepEqual(hits, []);
});

test("a message's count says repairs for repairs and tasks for the agent's own tasks", () => {
  assert.equal(sendItems([{ kind: "review" }, { kind: "checks" }]), "2 repairs");
  assert.equal(sendItems([{ kind: "conflict" }]), "1 repair");
  assert.equal(sendItems([{ kind: "obligation" }]), "1 task");
  assert.equal(sendItems([{ kind: "restack" }, { kind: "review" }, { kind: "obligation" }]), "2 repairs and 1 task");
  assert.equal(sendButton("2 repairs"), "Send 2 repairs");
  assert.equal(sendButton("2 repairs and 1 task"), "Send message", "a button never carries a conjunction; its label keeps the count");
});

test("the copy scan reads string literals and JSX text, and ignores identifiers, comments and invariant history", () => {
  const src = [
    `const a = "Repairs go here.";`,
    `const kind = "repairs"; // repairs are tasks`,
    `/* Send repairs */ const b = <Text>Send 2 repairs</Text>;`,
    `const inv = { id: "x", why: "the panel said \\"4 repairs queued\\"" };`,
    "const line = `${plural(repairs.length, \"task\")} queued`;",
  ].join("\n");
  assert.deepEqual(copyStrings(src).filter(s => /\brepairs?\b/i.test(s) && !identifier(s)), ["Repairs go here.", "Send 2 repairs"]);
});
