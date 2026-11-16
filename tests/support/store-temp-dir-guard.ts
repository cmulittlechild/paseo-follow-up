import { posix } from "node:path";
import ts from "typescript";

const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const visit = (node: ts.Node, fn: (node: ts.Node) => void) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
type Binding = { module: string; name: string };
const key = (module: string, name: string) => `${module}#${name}`;
function bindings(ast: ts.SourceFile): Map<string, Binding> {
  const found = new Map<string, Binding>();
  visit(ast, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const e of node.importClause.namedBindings.elements) found.set(e.name.text, { module: node.moduleSpecifier.text, name: (e.propertyName ?? e.name).text });
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      let init = node.initializer; if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(init.arguments[0])) {
        for (const e of node.name.elements) found.set(e.name.getText(ast), { module: init.arguments[0].text, name: (e.propertyName ?? e.name).getText(ast) });
      }
    }
  });
  return found;
}

/** Discover public flush/mutate queues, inherited queues, and containers that construct them. */
export function discoverStores(sources: ReadonlyMap<string, string>): ReadonlySet<string> {
  const classes = new Map<string, { dependencies: string[]; queued: boolean }>();
  for (const [module, source] of sources) {
    const ast = parse(module, source), imports = bindings(ast);
    const reference = (name: string) => {
      const imported = imports.get(name);
      return imported ? key(posix.normalize(posix.join(posix.dirname(module), imported.module)), imported.name) : key(module, name);
    };
    for (const node of ast.statements) if (ts.isClassDeclaration(node) && node.name) {
      const dependencies: string[] = [];
      visit(node, n => { if (ts.isNewExpression(n)) dependencies.push(reference(n.expression.getText(ast))); });
      for (const clause of node.heritageClauses ?? []) if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const base of clause.types) dependencies.push(reference(base.expression.getText(ast)));
      }
      const queued = node.members.some(m => ts.isMethodDeclaration(m) && ["flush", "mutate"].includes(m.name.getText(ast)) &&
        !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword));
      classes.set(key(module, node.name.text), { dependencies, queued });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const value of classes.values()) if (!value.queued && value.dependencies.some(c => classes.get(c)?.queued)) {
      value.queued = true; changed = true;
    }
  }
  return new Set([...classes].filter(([, value]) => value.queued).map(([name]) => name));
}

export function storeCleanupProblems(classes: ReadonlySet<string>, file: string, source: string): string[] {
  const ast = parse(file, source), imports = bindings(ast);
  const queued = new Set([...imports].filter(([, b]) => classes.has(key(b.module, b.name))).map(([name]) => name));
  if (!queued.size) return [];
  const problems: string[] = [];
  for (const b of imports.values()) if (b.module === "node:fs/promises" && b.name === "rm") problems.push(`${file}: import rm from ./support/store-temp-dir`);
  visit(ast, node => {
    if (!ts.isNewExpression(node) || !queued.has(node.expression.getText(ast))) return;
    const parent = node.parent;
    if (!(ts.isCallExpression(parent) && parent.expression.getText(ast) === "trackPersistence")) {
      problems.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}: use testStore or trackPersistence`);
    }
  });
  return problems;
}
