/**
 * Side-by-side layouts that stay outside ResizableSplit (side-panes-are-resizable). Every other client layout that puts
 * a fixed-width or fixed-share pane beside a flexible one draws it through `ResizableSplit` (`client/split.tsx`).
 * Key: "<file>:<what the guard matched>"; value: why it isn't a pane the developer should resize. Guarded by
 * tests/side-panes.test.ts.
 */
export const SIDE_PANE_ALLOWED: Record<string, string> = {
  "client/panel.tsx:flex: 5": "The wide workspace view's two card columns (actions, then stacks and activity) sit in one ScrollView and scroll together; they are one page laid out in two columns, not a pane beside a list.",
  "client/panel.tsx:flex: 6": "The second of the wide workspace view's two card columns, which scroll together in one ScrollView with the first; a divider between them would resize half a page, not a pane.",
};
