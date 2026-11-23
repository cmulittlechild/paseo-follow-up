/**
 * Follow-up's global keys (every-shortcut-is-configurable-and-never-paseo-s). Each one is a Display setting with a
 * None choice, matched with exact modifiers, and never a combo Paseo's web app binds (PASEO_BOUND, pinned from its
 * bundle). Pure, so tests run it without a DOM.
 */

/** "Search from anywhere": opens Home with the cursor in its search. Mod is ⌘ on a Mac and Ctrl elsewhere. */
export const SEARCH_SHORTCUTS = ["mod-shift-k", "mod-shift-h", "none"] as const;
export type SearchShortcut = typeof SEARCH_SHORTCUTS[number];
export const DEFAULT_SEARCH_SHORTCUT: SearchShortcut = "mod-shift-k";

/**
 * "New from anywhere": opens New (docs/dispatch.md). Absent means the host's default (`newShortcutPreset`): ⌘⇧N inside
 * Paseo's desktop app, ⌘⇧O in a browser tab, where Chrome keeps Ctrl/Cmd+Shift+N for a new incognito window and never
 * hands it to the page. An explicit pick wins everywhere.
 */
export const NEW_SHORTCUTS = ["mod-shift-n", "mod-shift-o", "none"] as const;
export type NewShortcut = typeof NEW_SHORTCUTS[number];
/** Every preset a Follow-up key can take. */
export type KeyPreset = SearchShortcut | NewShortcut;

const KEYS: Record<Exclude<KeyPreset, "none">, { key: string; code: string; shift: boolean }> = {
  "mod-shift-k": { key: "k", code: "KeyK", shift: true },
  "mod-shift-h": { key: "h", code: "KeyH", shift: true },
  "mod-shift-n": { key: "n", code: "KeyN", shift: true },
  "mod-shift-o": { key: "o", code: "KeyO", shift: true },
};

/** Inside Paseo's desktop app (Electron: it sets `window.paseoDesktop`), not a browser tab. */
export function isDesktopApp(win: unknown = globalThis): boolean {
  const w = win as { paseoDesktop?: unknown; navigator?: { userAgent?: string } } | null;
  return !!w && (w.paseoDesktop != null || /\bElectron\//.test(w.navigator?.userAgent ?? ""));
}
export function isNewShortcut(value: unknown): value is NewShortcut {
  return typeof value === "string" && (NEW_SHORTCUTS as readonly string[]).includes(value);
}
/** The key New answers to: the explicit pick, else the host's default (unknown is the default, never off). */
export function newShortcutPreset(value: unknown, desktop: boolean): NewShortcut {
  return isNewShortcut(value) ? value : desktop ? "mod-shift-n" : "mod-shift-o";
}
/** The Settings → Display choices for New from anywhere. */
/** The setting's hint: what the key opens, and why a browser tab defaults to ⌘⇧O. */
export function newShortcutHint(desktop: boolean, mac: boolean): string {
  return desktop ? "Opens New from any screen, even mid-message."
    : `Opens New from any screen. In a browser tab, Chrome keeps ${shortcutLabel("mod-shift-n", mac)} for a new incognito window, so ${shortcutLabel("mod-shift-o", mac)} is the default here.`;
}
export function newShortcutOptions(mac: boolean): { label: string; value: NewShortcut }[] {
  return NEW_SHORTCUTS.map(value => ({ value, label: shortcutLabel(value, mac) ?? "None" }));
}

/** ⌘ on a Mac (and iPad keyboards), Ctrl everywhere else; reads the browser's navigator when given none. */
export function isMac(platform?: string): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  return /Mac|iPhone|iPad/.test(platform ?? nav?.platform ?? nav?.userAgent ?? "");
}

export function isSearchShortcut(value: unknown): value is SearchShortcut {
  return typeof value === "string" && (SEARCH_SHORTCUTS as readonly string[]).includes(value);
}

/** Unknown is the default, never off (invariant 7). */
export function searchShortcutOf(value: unknown): SearchShortcut {
  return isSearchShortcut(value) ? value : DEFAULT_SEARCH_SHORTCUT;
}

export type KeyEventLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; repeat?: boolean };

/**
 * True when `event` is exactly `preset`: Mod (⌘ on a Mac, Ctrl elsewhere), Shift as the preset says, no other modifier,
 * and the key by its character or its physical code (so the key works across keyboard layouts).
 * Never while an input method is composing, never on auto-repeat.
 */
export function matchesShortcut(event: KeyEventLike, preset: KeyPreset, mac: boolean): boolean {
  if (preset === "none" || event.isComposing || event.repeat) return false;
  const want = KEYS[preset];
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey || event.shiftKey !== want.shift) return false;
  return event.key.toLowerCase() === want.key || event.code === want.code;
}

/** How the platform prints it: "⌘⇧K" on a Mac; "Ctrl+Shift+K" elsewhere; null for None. */
export function shortcutLabel(preset: KeyPreset, mac: boolean): string | null {
  if (preset === "none") return null;
  const { key, shift } = KEYS[preset];
  const k = key.toUpperCase();
  return mac ? `⌘${shift ? "⇧" : ""}${k}` : `Ctrl+${shift ? "Shift+" : ""}${k}`;
}

/** The preset in Paseo's own combo spelling ("Cmd+Shift+K", "Ctrl+Shift+K"), to compare with PASEO_BOUND. */
export function shortcutCombos(preset: KeyPreset): string[] {
  if (preset === "none") return [];
  const { key, shift } = KEYS[preset];
  const k = key.toUpperCase();
  return ["Cmd", "Ctrl"].map(mod => `${mod}+${shift ? "Shift+" : ""}${k}`);
}

/** The Settings → Display choices. */
export function searchShortcutOptions(mac: boolean): { label: string; value: SearchShortcut }[] {
  return SEARCH_SHORTCUTS.map(value => ({ value, label: shortcutLabel(value, mac) ?? "None" }));
}

/**
 * Every key combo Paseo's web app binds, read from its bundles (`combo:"…"` in the served web UI's index JS) of
 * 0.15.4, 0.16.x and 0.17.0-beta.1, the union (Mod expanded for both platforms).
 * check:paseo-keys checks latest and beta manually; tests fail if a preset takes one of these.
 */
export const PASEO_BOUND: readonly string[] = [
  "Cmd+/", "Ctrl+/", "Cmd+Shift+/", "Ctrl+Shift+/",
  "Alt+Digit", "Alt+Shift+Digit", "Alt+Shift+W", "Alt+Shift+[", "Alt+Shift+]", "Alt+[", "Alt+]",
  "Cmd+,", "Cmd+.", "Cmd+Alt+Digit", "Cmd+Alt+Shift+ArrowDown", "Cmd+Alt+Shift+ArrowLeft", "Cmd+Alt+Shift+ArrowRight",
  "Cmd+Alt+Shift+ArrowUp", "Cmd+Alt+T", "Cmd+B", "Cmd+D", "Cmd+Digit", "Cmd+E", "Cmd+K", "Cmd+L", "Cmd+N", "Cmd+O",
  "Cmd+P", "Cmd+Shift+A", "Cmd+Shift+ArrowDown", "Cmd+Shift+ArrowLeft", "Cmd+Shift+ArrowRight", "Cmd+Shift+ArrowUp",
  "Cmd+Shift+B", "Cmd+Shift+Backspace", "Cmd+Shift+D", "Cmd+Shift+E", "Cmd+Shift+F", "Cmd+Shift+G", "Cmd+Shift+P",
  "Cmd+Shift+T", "Cmd+Shift+W", "Cmd+Shift+[", "Cmd+Shift+\\", "Cmd+Shift+]", "Cmd+T", "Cmd+W", "Cmd+Z", "Cmd+[",
  "Cmd+\\", "Cmd+]", "Ctrl+,", "Ctrl+.", "Ctrl+Alt+T", "Ctrl+B", "Ctrl+D", "Ctrl+Digit", "Ctrl+E", "Ctrl+K", "Ctrl+L",
  "Ctrl+N", "Ctrl+O", "Ctrl+P", "Ctrl+Shift+A", "Ctrl+Shift+B", "Ctrl+Shift+Backspace", "Ctrl+Shift+D",
  "Ctrl+Shift+E", "Ctrl+Shift+F", "Ctrl+Shift+G", "Ctrl+Shift+P", "Ctrl+Shift+T", "Ctrl+T", "Ctrl+W", "Ctrl+Z",
  "Ctrl+[", "Ctrl+]", "Ctrl+`", "Enter", "Escape", "Shift+?", "Shift+Tab", "Space",
];
