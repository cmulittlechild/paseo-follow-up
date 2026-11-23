// every-agent-field-takes-images (AGENTS.md invariant 97): every field that takes images has one Add image button,
// in the shared component (client/image-attach.tsx), opening the system file picker where the platform has one, the
// way Paseo's composer does on web (a hidden file input taking image types). A phone has no picker for plugin fields,
// so there is no button and no space. 2026-11-23, review of PR #302: nothing on a field said it took images.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] } }; act: (f: () => Promise<void> | void) => Promise<void> };
const attach = await import("../client/image-attach") as typeof import("../client/image-attach") & { AttachImageButton?: unknown; PICKER_ON?: boolean; pickImageFiles?: () => Promise<File[]> };
const colors = new Proxy({}, { get: () => "#888888" });
const theme = { colors } as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in document: records the input it makes, and lets the test pick files or cancel. */
function fakeDocument() {
  const made: { type: string; accept: string; multiple: boolean; clicked: boolean; removed: boolean; files: File[] | null; fire(t: string): void }[] = [];
  const doc = {
    body: { appendChild() {} },
    createElement(tag: string) {
      assert.equal(tag, "input");
      const listeners: Record<string, (() => void)[]> = {};
      const input = { type: "", accept: "", multiple: false, style: { display: "" }, files: null as File[] | null, clicked: false, removed: false,
        addEventListener(t: string, f: () => void) { (listeners[t] ??= []).push(f); },
        click() { input.clicked = true; }, remove() { input.removed = true; },
        fire(t: string) { for (const f of listeners[t] ?? []) f(); } };
      made.push(input);
      return input;
    },
  };
  return { doc, made };
}

test("Add image opens the system picker for images only, several at once, and hands back what was chosen", async () => {
  assert.equal(typeof attach.pickImageFiles, "function", "image-attach.tsx has the one picker");
  const { doc, made } = fakeDocument();
  const g = globalThis as { document?: unknown }; const prev = g.document; g.document = doc;
  try {
    const picked = attach.pickImageFiles!();
    const input = made[0]!;
    assert.equal(input.type, "file");
    assert.equal(input.accept, "image/png,image/jpeg,image/gif,image/webp", "the same types the caps take");
    assert.equal(input.multiple, true);
    assert.ok(input.clicked, "the picker opens at once");
    const file = { name: "chart.png", type: "image/png", size: 68 } as File;
    input.files = [file]; input.fire("change");
    assert.deepEqual(await picked, [file]);
    assert.ok(input.removed, "the input is gone once it answered");
    const cancelled = attach.pickImageFiles!();
    made[1]!.fire("cancel");
    assert.deepEqual(await cancelled, [], "a cancelled picker adds nothing");
  } finally { g.document = prev; }
});

test("on a phone there is no picker for a plugin field: no Add image button and no space", async () => {
  assert.equal(attach.PICKER_ON, false);
  assert.equal(typeof attach.AttachImageButton, "function");
  const model = { images: [], refusal: null, blocked: null, add: async () => {}, refuse: () => {}, remove: () => {}, clear: () => {}, uploads: () => undefined, target: null };
  let r!: ReturnType<typeof create>;
  await act(() => { r = create(createElement(attach.ImageField, { model, theme, compact: true }, createElement("TextInput", { accessibilityLabel: "Your answer" }))); });
  assert.equal(r.root.findAll(n => n.props.accessibilityLabel === "Add image").length, 0, "below a field");
  let inline!: ReturnType<typeof create>;
  await act(() => { inline = create(createElement(attach.AttachImageButton, { model, theme, compact: true })); });
  assert.equal(inline.root.findAll(n => typeof n.type === "string").length, 0, "among a field's controls");
});
