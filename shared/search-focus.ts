/**
 * One owner for "put the caret in Home's search" (every-search-request-lands-in-the-visible-search). Every way to
 * ask (the search-from-anywhere key, ⌘K "Follow-up: Search", `/`) calls `request()`. The request is a wish, not an
 * event: it holds until the developer acts (a key, a pointer, a click, a wheel, typed input: `cancel()`), and while it
 * holds, the search field on screen takes the caret whenever one can: now, when a field mounts, when one lays out (a
 * screen kept mounted behind comes forward, the field remounts) and when focus moves without the developer
 * (`focusMoved`). No timer and no retry loop: each attempt is driven by one of those events.
 *
 * A focus move is not always the page's: a dialog that opens takes focus on purpose, and a screen reader's virtual
 * cursor or voice control moves focus with no key or pointer the page hears. So while a menu or modal dialog is drawn
 * over the search the request waits (no delivery, no focus fight; it goes on when the dialog hands focus back), and
 * once the caret has landed a focus move elsewhere is taken back at most once (enough for ⌘K handing focus back as it
 * closes); the next one is the developer's.
 *
 * A field is shown only when it is on screen. Paseo keeps earlier screens mounted behind the current one, so more
 * than one Home search can be mounted; only the newest one the developer can see takes the caret. Pure, so tests run
 * it without a DOM (client/search-focus.ts is the adapter).
 */
export type FocusField = {
  /** On screen now: laid out, not hidden behind another screen. */
  shown(): boolean;
  /** Holds the caret now. */
  focused(): boolean;
  focus(): void;
  /** A menu or modal dialog is drawn over it: the request waits (never fights the dialog for focus). */
  covered?(): boolean;
};

export function createSearchFocus() {
  const fields: FocusField[] = [];
  let want = false;
  /** The caret landed for this request (so a later focus move away may be taken back once). */
  let landed = false;
  let retaken = false;
  /** A focus() inside a delivery fires focusin, which must not deliver again. */
  let delivering = false;
  /** The newest shown field: a screen pushed later sits in front. */
  const target = () => { for (let i = fields.length - 1; i >= 0; i--) if (fields[i].shown()) return fields[i]; return null; };
  const deliver = (): boolean => {
    if (!want || delivering) return false;
    const field = target();
    if (!field || field.covered?.()) return false;
    delivering = true;
    try { if (!field.focused()) field.focus(); } finally { delivering = false; }
    const took = field.focused();
    if (took) landed = true;
    return took;
  };
  return {
    /** Asks for the caret in the shown search field; true when it is there now. It keeps asking until `cancel()`. */
    request(): boolean { want = true; landed = false; retaken = false; return deliver(); },
    /** A Home search field is on screen (so a request needs no navigation). */
    shown: () => target() !== null,
    /** A request is waiting for the developer to act. */
    wanted: () => want,
    /** A search field mounted; it takes a waiting request if it is on screen. Returns its removal. */
    register(field: FocusField): () => void {
      fields.push(field); deliver();
      return () => { const i = fields.indexOf(field); if (i >= 0) fields.splice(i, 1); };
    },
    /** A field laid out (came on screen, remounted): try again. */
    changed(): boolean { return deliver(); },
    /**
     * Focus moved without a key or pointer the page heard. Into a dialog, or onto the search: nothing to do (the
     * request waits for the dialog). Elsewhere: taken back while the caret hasn't landed yet, and once after it has.
     */
    focusMoved(into: { dialog: boolean; search: boolean }): void {
      if (!want || delivering || into.search || into.dialog) return;
      if (landed) { if (retaken) { want = false; return; } retaken = true; }
      deliver();
    },
    /** The developer acted: the request is theirs to keep or drop, so stop holding it. */
    cancel(): void { want = false; },
  };
}
export type SearchFocus = ReturnType<typeof createSearchFocus>;
