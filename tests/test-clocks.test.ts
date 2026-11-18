import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Invariant 52 (a-pinned-clock-reaches-every-instance): a test that pins a class's clock pins it on every instance of
// that class it builds. One left on the default real clock compares the pinned dates with today, and fails once a
// window (CONTEXT_KEEP_MS, a snooze, a stale lock) runs out, on whatever day that is.

const root = join(import.meta.dirname, "..");

/** Splits a call's or a parameter list's text at its top-level commas. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  const last = text.slice(start);
  if (last.trim()) parts.push(last);
  return parts;
}

/** The text inside the parentheses that open at `open`. */
function inside(text: string, open: number): string {
  let depth = 0, quote = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every server class whose constructor takes a clock that defaults to the real one, with that parameter's index. */
export function clockedClasses(sources: Record<string, string>): Map<string, number> {
  const found = new Map<string, number>();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/class (\w+)[^{]*\{/g)) {
      const at = text.indexOf("constructor(", m.index);
      const next = text.indexOf("\nexport class ", m.index + 1);
      if (at < 0 || (next >= 0 && at > next)) continue;
      const params = topLevel(inside(text, at + "constructor".length));
      const index = params.findIndex(p => /\bnow\b.*=\s*Date\.now\b/s.test(p));
      if (index >= 0) found.set(m[1], index);
    }
  }
  return found;
}

type Build = { line: number; clocked: boolean };

/** Every `new X(...)` and `testStore(X, ...)` of a clocked class in `text[from, to)`: does it pass a clock? */
export function builds(text: string, classes: Map<string, number>, from = 0, to = text.length): Map<string, Build[]> {
  const out = new Map<string, Build[]>();
  for (const m of text.matchAll(/\bnew (\w+)\(|\btestStore\((\w+),/g)) {
    if (m.index < from || m.index >= to) continue;
    const name = m[1] ?? m[2];
    const index = classes.get(name);
    if (index === undefined) continue;
    const open = m[1] ? m.index + m[0].length - 1 : m.index + "testStore".length;
    const args = topLevel(inside(text, open)).slice(m[1] ? 0 : 1);
    const clock = args[index]?.trim();
    const line = text.slice(0, m.index).split("\n").length;
    // `// real-clock: <why>` on the line is a test choosing the real clock on purpose (a default it checks).
    const chosen = /\/\/ real-clock: \S/.test(text.split("\n")[line - 1]);
    out.set(name, [...(out.get(name) ?? []), { line, clocked: chosen || (!!clock && clock !== "undefined") }]);
  }
  return out;
}

/** A file's top-level statements (a line that starts unindented opens one), with the name a function one declares. */
function statements(text: string): { from: number; to: number; name?: string; test: boolean }[] {
  const starts = [...text.matchAll(/^(?=\S)(?!\}|\)|\]|\/\/|\*|\/\*)/gm)].map(m => m.index);
  return starts.map((from, i) => {
    const to = starts[i + 1] ?? text.length;
    const head = text.slice(from, Math.min(to, from + 200));
    const name = head.match(/^(?:export )?(?:async )?function\*? (\w+)|^(?:export )?const (\w+) = (?:async )?(?:\(|function)/)?.slice(1).find(Boolean);
    return { from, to, name, test: /^test(?:\.\w+)?\(/.test(head) };
  });
}

/**
 * Instances left on the real clock in a test that pins the clock of another instance of the same class: the test's
 * own body plus the file's top-level functions it calls (a fixture), since a test's instances share its dates.
 */
export function mixedClocks(files: Record<string, string>, classes: Map<string, number>): string[] {
  const found = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const all = statements(text);
    for (const t of all.filter(s => s.test)) {
      const body = text.slice(t.from, t.to);
      const scope = [t, ...all.filter(s => s.name && s !== t && new RegExp(`\\b${s.name}\\(`).test(body))];
      const byClass = new Map<string, Build[]>();
      for (const s of scope) for (const [name, list] of builds(text, classes, s.from, s.to)) byClass.set(name, [...(byClass.get(name) ?? []), ...list]);
      for (const [name, list] of byClass) {
        if (!list.some(b => b.clocked)) continue;
        for (const b of list) if (!b.clocked) found.add(`${file}:${b.line} new ${name} on the real clock`);
      }
    }
  }
  return [...found].sort();
}

const read = (dir: string, match: RegExp) => Object.fromEntries(readdirSync(join(root, dir)).filter(f => match.test(f)).map(f => [`${dir}/${f}`, readFileSync(join(root, dir, f), "utf8")]));

test("a-pinned-clock-reaches-every-instance: the detector sees a reopened store left on the real clock", () => {
  const classes = clockedClasses({ "server/x.ts": "export class Box {\n  constructor(readonly directory: string, private now: () => number = Date.now) {}\n}\nexport class Bare {\n  constructor(private a = 1) {}\n}" });
  assert.deepEqual([...classes], [["Box", 1]]);
  // The bug's shape: the fixture pins the clock, the test reopens the store on the real one.
  const reopened = "async function fixture() {\n  return new Box(dir, () => now);\n}\n\ntest(\"survives a restart\", async () => {\n  const store = await fixture();\n  const again = new Box(dir);\n  const other = testStore(Box, dir);\n  new Bare();\n});\n";
  assert.deepEqual(mixedClocks({ "t.ts": reopened }, classes), ["t.ts:7 new Box on the real clock", "t.ts:8 new Box on the real clock"]);
  // Separate tests keep separate clocks: one pinned, one on the real clock, nothing shared.
  const separate = "test(\"pinned\", () => {\n  new Box(dir, () => 1);\n});\ntest(\"real\", () => {\n  new Box(dir);\n});\n";
  assert.deepEqual(mixedClocks({ "t.ts": separate }, classes), []);
  // A test that names its clock on every instance, the real one included, is consistent.
  const named = "test(\"x\", () => {\n  new Box(f(dir, 1), () => Date.parse('2026-01-01'));\n  new Box(dir, clock);\n  new Box(dir, Date.now);\n});\n";
  assert.deepEqual(mixedClocks({ "t.ts": named }, classes), []);
  assert.deepEqual(mixedClocks({ "t.ts": "test(\"z\", () => {\n  new Box(dir, () => 1);\n  new Box(); // real-clock: checks the defaults\n});\n" }, classes), [], "a test may choose the real clock, saying why");
  assert.deepEqual(mixedClocks({ "t.ts": "test(\"y\", () => {\n  new Box(dir, () => 1);\n  new Box(dir, undefined);\n});\n" }, classes), ["t.ts:3 new Box on the real clock"], "undefined is the real clock");
});

test("a-pinned-clock-reaches-every-instance: every test that pins a class's clock pins it on every instance", () => {
  const classes = clockedClasses(read("server", /\.ts$/));
  assert.ok(classes.has("ContextRequests"), "the scan finds the clocked server classes");
  assert.deepEqual(mixedClocks(read("tests", /\.ts$/), classes), []);
});
