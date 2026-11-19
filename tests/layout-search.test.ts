import test from "node:test";
import assert from "node:assert/strict";
import { search, indexDocs, byRank, type SearchDoc } from "../shared/search";
const doc = (key: string, title: string, field: "name" | "branch" = "name"): SearchDoc => ({ key, title, group: "quiet", at: null, fields: [{ field, text: title }] });
const index = indexDocs([doc("smart", "Smart Session"), doc("invoice", "Invoice exports"), doc("hebrew", "שלום")]);

test("Hebrew-layout smart session finds Smart Session with real title highlights", () => {
  const hits = search(index, "דצשרא דקדדןםמ");
  assert.deepEqual(hits.map(h => h.key), ["smart"]);
  assert.deepEqual(hits[0].titleRanges, [[0, 5], [6, 13]]);
});
test("English-layout Hebrew title and mixed digits/unmapped input", () => {
  assert.deepEqual(search(index, "akuo").map(h => h.key), ["hebrew"]);
  assert.deepEqual(search(indexDocs([doc("mixed", "Smart Session 42 🙂")]), "דצשרא דקדדןםמ 42 🙂").map(h => h.key), ["mixed"]);
  assert.deepEqual(search(index, ""), []);
});
test("direct query outranks converted title even when direct match is in a branch", () => {
  const hits = search(indexDocs([doc("converted", "Smart Session"), doc("direct", "דצשרא דקדדןםמ", "branch")]), "דצשרא דקדדןםמ");
  assert.deepEqual(hits.map(h => h.key), ["direct", "converted"]);
  assert.ok(byRank(hits[0], hits[1]) < 0);
});
test("mapping round trips standard Israeli keys and leaves unmapped text", async () => {
  const { swapLayout } = await import("../shared/layout-swap");
  assert.equal(swapLayout("smart session", "hebrew"), "דצשרא דקדדןםמ");
  assert.equal(swapLayout("דצשרא דקדדןםמ", "english"), "smart session");
  assert.equal(swapLayout("SMART 42 🙂-é", "hebrew"), "דצשרא 42 🙂-é");
  const keys = "qwertyuiopasdfghjkl;'zxcvbnm,./";
  assert.equal(swapLayout(swapLayout(keys, "hebrew"), "english"), keys);
  assert.equal(swapLayout("", "english"), "");
});

test("physical keys reconstruct Hebrew and Russian; paste, selection, composition reset; backspace stays aligned", async () => {
  const { LayoutCapture } = await import("../shared/layout-swap");
  for (const text of ["דצשרא", "ыьфке", "سمرات"]) {
    const c = new LayoutCapture(); let value = "", physical: string | null = null;
    for (const [i, key] of [...text].entries()) {
      c.key({ key, code: `Key${"SMART"[i]}` }, value, value.length, value.length);
      value += key; physical = c.change(value);
    }
    assert.equal(physical, "smart");
    c.key({ key: "Backspace", code: "Backspace" }, value, value.length, value.length);
    value = value.slice(0, -1); assert.equal(c.change(value), "smar");
    assert.equal(c.change("pasted text"), null);
    c.key({ key: "ד", code: "KeyS" }, "pasted text", 11, 11);
    assert.equal(c.change("pasted textד"), null, "typing after paste cannot resurrect stale keys");
    c.change("");
    c.key({ key: "ד", code: "KeyS" }, "", 0, 0); assert.equal(c.change("ד"), "s");
    c.key({ key: "צ", code: "KeyM" }, "ד", 0, 1); assert.equal(c.change("צ"), null);
    c.change("");
    c.key({ key: "ד", code: "KeyS", isComposing: true }, "", 0, 0); assert.equal(c.change("ד"), null);
    c.reset(); assert.equal(c.change("IME"), null);
  }
});
test("physical conversion supports an untabled layout and table fallback supports Russian", () => {
  assert.deepEqual(search(index, "سمرات", 0, 60, "smart").map(h => h.key), ["smart"]);
  assert.deepEqual(search(index, "ыьфке ыуыышщт").map(h => h.key), ["smart"]);
  assert.deepEqual(search(indexDocs([doc("ru", "привет")]), "ghbdtn").map(h => h.key), ["ru"]);
});
test("conversion explanation is quiet when direct hits suffice", async () => {
  const { layoutHint } = await import("../shared/search");
  assert.equal(layoutHint(search(index, "דצשרא דקדדןםמ")), "smart session");
  assert.equal(layoutHint(search(index, "smart session")), null);
  const hits = search(indexDocs([doc("a", "דצשרא"), doc("b", "Smart")]), "דצשרא");
  assert.equal(layoutHint(hits), null);
});


test("macOS geresh and Android Hebrew Q/W punctuation variants", async () => {
  const { swapLayout } = await import("../shared/layout-swap");
  assert.equal(swapLayout("׳קנ", "english"), "web");
  const i = indexDocs([doc("keys", "Qwerty work"), doc("mobile", "'-קראט -םרל")]);
  assert.equal(search(i, "'-קראט -םרל").find(h => h.key === "keys")?.title, "Qwerty work");
  assert.ok(search(i, "qwerty work").some(h => h.key === "mobile"));
});
