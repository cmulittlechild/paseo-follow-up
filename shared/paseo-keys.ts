/** Canonical Paseo combos: expand Mod for both platforms and compare modifiers in one order. */
export function normalizeCombos(combos: readonly string[]): string[] {
  return [...new Set(combos.filter(Boolean).flatMap(combo => {
    const variants = combo.startsWith("Mod+") ? [combo.replace(/^Mod\+/, "Cmd+"), combo.replace(/^Mod\+/, "Ctrl+")] : [combo];
    return variants.map(value => {
      const parts = value.split("+");
      const key = parts.pop()!;
      const order = ["Cmd", "Ctrl", "Alt", "Shift"];
      return [...parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)), key.length === 1 ? key.toUpperCase() : key].join("+");
    });
  }))].sort();
}

/** Read JS string escapes before comparing (notably Cmd+\\). Only shortcut declarations count. */
export function extractPaseoCombos(bundle: string): string[] {
  return normalizeCombos([...bundle.matchAll(/\bcombo\s*:\s*("(?:\\.|[^"\\])*")/g)].map(m => JSON.parse(m[1]) as string));
}

export function keyConflicts(actual: readonly string[], bound: readonly string[], followUp: readonly string[]) {
  const known = new Set(normalizeCombos(bound));
  const ours = new Set(normalizeCombos(followUp));
  const combos = normalizeCombos(actual);
  return { collisions: combos.filter(c => ours.has(c)), additions: combos.filter(c => !known.has(c)) };
}
