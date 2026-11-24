// compass-without-the-overseer (AGENTS.md invariant 109, asked for): every Compass read, extraction, match and
// suggestion runs as Follow-up's own job, with the Overseer off or never started. The Overseer sees Compass only
// through its digest block (built when its digest is, only when a note is live) and the compass_* tools, never a source.
// Fictional people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { digestLines } from "../shared/nobody";
import { digestFile } from "../shared/overseer";
import { compassSettingsSchema, type CompassNote } from "../shared/compass";

type Hook = { overseerDigest: (file: unknown, seen: unknown, now?: number) => { text: string } };
const hook = () =>
  // @ts-expect-error plain JS hook, generated into hook-source.ts
  import("../server/agent-hook.mjs") as Promise<Hook>;

const NOW = Date.parse("2026-11-24T09:00:00Z");
const EXPIRY = compassSettingsSchema.parse({}).expiry;
const note = (over: Partial<CompassNote>): CompassNote => ({
  id: "n-1", source: "s-dana1", place: "conversation:U0000DANA", role: "priorities", by: { id: "U0000DANA", name: "Dana" }, at: "2026-11-24T08:00:00.000Z", link: null,
  quote: "invoice export is really important", what: "invoice export", keys: [], kind: "workspace", strength: "high", until: "2026-11-26", untilWords: "Thursday",
  state: "live", endedAt: null, supersededBy: null, match: { workspace: "ws-inv", score: 1, how: "title" }, restatedAt: "2026-11-24T08:00:00.000Z", ...over,
});

test("the digest block: live notes soonest first, who · until · what · where · id, capped with N more; nothing without a live note", () => {
  const titles = new Map([["ws-inv", "Invoice export for acme"]]);
  const lines = digestLines([
    note({ id: "n-late", until: null, what: "SSO for acme", match: { issue: "ACME-40", score: 1, how: "key" } }),
    note({ id: "n-soon" }),
    note({ id: "n-unplaced", until: "2026-11-30", what: "the board deck", match: { score: 0, how: "none" } }),
    note({ id: "n-gone", state: "retracted" }),
  ], { expiry: EXPIRY }, titles, NOW);
  assert.deepEqual(lines, [
    'Dana · until 2026-11-26 · invoice export · workspace "Invoice export for acme" · n-soon',
    "Dana · until 2026-11-30 · the board deck · unplaced · n-unplaced",
    "Dana · no date · SSO for acme · ACME-40, no workspace · n-late",
  ]);
  assert.deepEqual(digestLines([note({ state: "expired" })], { expiry: EXPIRY }, titles, NOW), [], "no live note: no block");
  const many = digestLines(Array.from({ length: 15 }, (_, i) => note({ id: `n-${i}` })), { expiry: EXPIRY }, titles, NOW, 12);
  assert.equal(many.length, 13);
  assert.equal(many[12], "3 more (compass lists them)");
  assert.ok(many.join("\n").length < 2_000, "about 300-400 tokens");
});

test("the digest file carries the block and its hash moves with it; the hook prints it to the Overseer", async () => {
  const { overseerDigest } = await hook();
  const plain = digestFile("agent-overseer", [], NOW);
  const withCompass = digestFile("agent-overseer", [], NOW, ["This week's plan: Week of Nov 23, 14 items, 3 without an issue", "Dana · until 2026-11-26 · invoice export · unplaced · n-1"]);
  assert.equal(plain.compass, undefined);
  assert.notEqual(plain.hash, withCompass.hash, "a new note is a change the Overseer sees");
  const out = overseerDigest(withCompass, null, NOW).text;
  assert.match(out, /Compass \(the developer's priority sources, as notes/);
  assert.match(out, /- This week's plan: Week of Nov 23/);
  assert.match(out, /- Dana · until 2026-11-26 · invoice export · unplaced · n-1/);
  assert.doesNotMatch(overseerDigest(plain, null, NOW).text, /Compass/, "no block without notes");
});

test("Compass runs without the Overseer, and the Overseer never reads a source", async () => {
  // The Compass worker takes no Overseer dependency: its reads, extraction, matching and suggestions are its own.
  const compass = await readFile(new URL("../server/compass.ts", import.meta.url), "utf8");
  const nobody = await readFile(new URL("../shared/nobody.ts", import.meta.url), "utf8");
  for (const src of [compass, nobody]) assert.doesNotMatch(src, /from "\.\/overseer"|from "\.\.\/server\/overseer"|from "\.\/overseer"/, "Compass imports nothing of the Overseer");
  // The Overseer's side holds only the digest hook: no source tools, no reader, no compass.json path.
  const overseer = await readFile(new URL("../server/overseer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(overseer, /SourceDirectory|source-tools|compass\.json|readConversation/);
  assert.match(overseer, /compass\?: \(\) => Promise<string\[\]>/, "one read-only hook: the block's lines");
  // The worker builds the block from Compass's own notes, only when the digest is built.
  const worker = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(worker, /compass: async \(\) => \{\n\s+const notes = await compass\?\.digest\(\) \?\? \[\];/);
});
