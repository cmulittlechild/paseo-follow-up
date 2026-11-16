import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { rm, trackPersistence } from "./support/store-temp-dir";

// Test the ordering, not an rm retry: every registered writer must settle before removal starts.
test("store cleanup drains every instance and nested directory, but leaves siblings alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-cleanup-"));
  const calls: string[] = [];
  const writer = (directory: string, name: string) => trackPersistence(directory, {
    async flush() { await access(root); calls.push(name); },
  });
  writer(root, "first"); writer(root, "reopened"); writer(join(root, "child"), "child");
  const sibling = writer(`${root}-sibling`, "sibling");
  await rm(root, { recursive: true, force: true });
  assert.deepEqual(calls, ["first", "reopened", "child"]);
  await assert.rejects(access(root), { code: "ENOENT" });
  // Remove the registration without trying to access a directory we already removed.
  sibling.flush = async () => { calls.push("sibling"); };
  await rm(`${root}-sibling`, { recursive: true, force: true });
  assert.equal(calls.at(-1), "sibling");
});

test("failed flush preserves the directory and stays registered for a later cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-cleanup-"));
  let fails = true, calls = 0;
  trackPersistence(root, { async flush() { calls++; if (fails) throw new Error("disk unavailable"); } });
  await assert.rejects(rm(root, { recursive: true, force: true }), /disk unavailable/);
  await access(root);
  fails = false;
  await rm(root, { recursive: true, force: true });
  assert.equal(calls, 2);
});

const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const visit = (node: ts.Node, fn: (node: ts.Node) => void) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };

// Discover the delayed writers from their public flush method, plus containers that construct one (Inbox).
// Resolve both static imports and await-import aliases, so renaming a store locally cannot bypass this guard.
test("invariant 39: tests construct delayed writers through the cleanup helper and never import raw rm", async () => {
  const classes = new Map<string, { module: string; creates: string[]; delayed: boolean }>();
  for (const file of await readdir("server")) {
    if (!file.endsWith(".ts")) continue;
    const ast = parse(file, await readFile(join("server", file), "utf8"));
    for (const node of ast.statements) if (ts.isClassDeclaration(node) && node.name) {
      const creates: string[] = [];
      visit(node, n => { if (ts.isNewExpression(n)) creates.push(n.expression.getText(ast)); });
      const delayed = node.members.some(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === "flush" &&
        !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword));
      classes.set(node.name.text, { module: `../server/${file.slice(0, -3)}`, creates, delayed });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const value of classes.values()) if (!value.delayed && value.creates.some(c => classes.get(c)?.delayed)) {
      value.delayed = true; changed = true;
    }
  }
  const problems: string[] = [];
  for (const file of await readdir("tests")) {
    if (!file.endsWith(".test.ts")) continue;
    const ast = parse(file, await readFile(join("tests", file), "utf8"));
    const bindings = new Map<string, { module: string; name: string }>();
    visit(ast, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const e of node.importClause.namedBindings.elements) bindings.set(e.name.text, { module: node.moduleSpecifier.text, name: (e.propertyName ?? e.name).text });
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        let init = node.initializer; if (ts.isAwaitExpression(init)) init = init.expression;
        if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(init.arguments[0])) {
          for (const e of node.name.elements) bindings.set(e.name.getText(ast), { module: init.arguments[0].text, name: (e.propertyName ?? e.name).getText(ast) });
        }
      }
    });
    const delayed = new Set([...bindings].filter(([, b]) => classes.get(b.name)?.delayed && classes.get(b.name)?.module === b.module).map(([name]) => name));
    if (!delayed.size) continue;
    for (const b of bindings.values()) if (b.module === "node:fs/promises" && b.name === "rm") problems.push(`${file}: import rm from ./support/store-temp-dir`);
    visit(ast, node => {
      if (!ts.isNewExpression(node) || !delayed.has(node.expression.getText(ast))) return;
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression.getText(ast) === "trackPersistence")) {
        problems.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}: use testStore or trackPersistence`);
      }
    });
  }
  assert.deepEqual(problems, []);
});
