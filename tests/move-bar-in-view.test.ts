import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATCH_UP_KEYS, MOVE_OPENS } from "../shared/catch-up";

// 2026-11-17, Tom on 2.2.0-beta.3: "When pressing context ... you press it and nothing happens, you need to realize you
// need to scroll down." Root cause: More context's panel was appended to the card's scroll content, below the answers,
// while the phone's move bar sits in the dock, so the result of a move opened off screen. Desktop Later did the same
// below a long card. Invariant `a-move-bar-action-opens-in-view`: every move-bar action opens its result where the eye
// is (a sheet above the phone's bar, a popover on its desktop button, a focused field or row, or the chat).

const ROOT = join(import.meta.dirname, "..");
const PLACES = new Set(["sheet", "popover", "focus", "navigates"]);

test("a-move-bar-action-opens-in-view: every move that opens something says where, and none appends below the card", () => {
  const opening = new Set(CATCH_UP_KEYS.map(k => k.action).filter(a => ["more", "later", "note", "chat", "rail"].includes(a)));
  for (const a of opening) assert.ok(a in MOVE_OPENS, `${a} has a place in MOVE_OPENS`);
  for (const [a, p] of Object.entries(MOVE_OPENS)) {
    assert.ok(PLACES.has(p.desktop), `${a} on desktop opens in view (${p.desktop})`);
    if (p.phone !== null) assert.ok(PLACES.has(p.phone), `${a} on a phone opens in view (${p.phone})`);
  }
  assert.equal(MOVE_OPENS.more.phone, "sheet", "the reported case: More context on a phone");
  assert.equal(MOVE_OPENS.more.desktop, "popover");
  assert.deepEqual(MOVE_OPENS.later, MOVE_OPENS.more, "More context opens the way Later does");
});

test("the card draws More context and Later only through MoveResult: the dock's sheet or the button's popover", async () => {
  const screen = await readFile(join(ROOT, "client/catch-up.tsx"), "utf8");
  const content = screen.slice(screen.indexOf("<DockedPane compact={compact}"), screen.indexOf("</DockedPane>"));
  const children = content.slice(content.indexOf("</View>}>"));
  for (const block of ["moreBlock", "laterBlock", "laterRow"]) assert.ok(!children.includes(block), `${block} is never appended to the card's scroll content`);
  assert.match(content, /<MoveResult place="sheet"/, "phones: a sheet in the dock, above the bar");
  assert.match(screen, /popover\(moreBlock, "More context"/, "desktop: More context's popover on its button");
  assert.match(screen, /popover\(laterBlock, "Later"/, "desktop: Later's popover on its button");
  assert.match(screen, /sheet && !typingInContent/, "the sheet stays while its own ask box has focus, so it stays above the keyboard");
  const result = screen.slice(screen.indexOf("function MoveResult"));
  assert.match(result, /scrollIntoView\?\.\(\{ block: "nearest" \}\)/, "it scrolls into view the least distance");
  assert.match(result, /\[role="radio"\]/, "focus goes to its first choice: I don't get it");
});

test("Send to agent joins the move bar once the card has an answer, through the question's own Send", async () => {
  const screen = await readFile(join(ROOT, "client/catch-up.tsx"), "utf8");
  const questions = await readFile(join(ROOT, "client/questions.tsx"), "utf8");
  assert.match(screen, /onSendReady=\{setReady\}/, "the card listens to QuestionBody's sendable answer");
  assert.match(screen, /onPress=\{ready\.send\}/, "the bar's Send runs it");
  assert.ok(!/answerQuestionRpc|answerRpc/.test(screen), "Catch up never sends an answer its own way (one-answer-flow-for-every-question)");
  assert.match(questions, /onSendReady\?\.\(sendable \? \{ send: \(\) => quickRef\.current\("send"\)/, "QuestionBody hands over its own Send");
});
