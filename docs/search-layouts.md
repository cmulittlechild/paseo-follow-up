# Searching with another keyboard layout

`shared/layout-swap.ts` owns layout conversion and physical-key reconstruction; `shared/search.ts` owns matching
and ranking. `tests/layout-search.test.ts` covers both.

Home, the sidebar's workspace filter, the Follow-up Search command (which opens Home), and the agent tools
`workstreams` and `list_prs` share the workspace matcher. Catch up and `inbox_list` have no workspace text filter.
The Overseer ask keeps the words as typed; conversion only affects workspace results.

Desktop/web search captures `KeyboardEvent.code` while the field is focused and reconstructs US QWERTY positions
regardless of the active layout. This supports any physical layout that emits ordinary character key events.
It does not transliterate or interpret IME text. Paste, cut, drop, composition, selection edits, missing codes,
modifier shortcuts and unverified input discard the reconstruction. Clearing the field starts it again.
Backspace at the end removes one captured character. Nothing is stored or sent to a server.

For phones, paste and agent queries, small built-in tables support standard Israeli Hebrew (SI-1452) and Russian
ЙЦУКЕН in both directions. Other pasted/phone layouts search as typed. No browser keyboard permission is required;
`getLayoutMap()` is optional and is not used. Latin phonetic variants such as Hebrew-QWERTY are different layouts.

The [Unicode CLDR Hebrew keyboard charts](https://www.unicode.org/cldr/charts/40/keyboards/layouts/he.html) show the
same Hebrew letter positions for macOS Hebrew and Android Hebrew. Punctuation differs: macOS uses geresh on W
rather than the PC apostrophe; Android has separate punctuation keys and a shorter letter row. The fallback uses
standard Israeli PC punctuation, accepts macOS geresh for W, and tries Android’s apostrophe/hyphen Q/W variant.
Separate phone punctuation keys are not treated as physical US punctuation positions.
The charts describe Android's standard layout; Gboard is configurable, so custom variants are not guaranteed.
Physical capture uses actual key positions instead. Spaces, digits and unmapped characters survive conversion.

The MIT package [convert-layout](https://github.com/ai/convert-layout) was checked before choosing built-in tables:
its repository is archived and its last npm release is 0.11.1 (2022). Keeping two small fallback maps avoids adding
an archived dependency. The physical-key path follows the [UI Events key model](https://www.w3.org/TR/uievents/).
