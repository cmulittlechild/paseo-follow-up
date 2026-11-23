#!/bin/sh
# Re-renders every README image in place (docs/screenshots/), each run through the machine-wide harness slot, shown as
# the latest stable tag so an image never shows a beta version:
#   - the plugin page's Home shot and the guide's phone shot, on Paseo 0.15 (what the floor serves);
#   - the guide's sidebar view shot, on the global Paseo CLI (HARNESS_PASEO=0.16: 0.16 or later);
#   - the README's 16:9 frames (Home, the sidebar view, the Overseer, a task waiting on a deploy; light and dark) and
#     Catch up on a phone (light and dark), on the global CLI (`--only frames`);
#   - the slide set (follow-up-slide-*.png: the cover, then six slides each zooming one real element), composed
#     by scripts/cover.mjs from the frames run; the README's cover and paseo-plugin.json's media, cover first.
#     COVER_HEADLINE ("First line|Second line") and COVER_SUBLINE override the cover's words.
# Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md); HARNESS_SLOT overrides the slot wrapper's path.
set -eu
here="$(dirname "$0")"
. "$here/shots-optimiser.sh"
slot="${HARNESS_SLOT:-$HOME/paseo-harness/tools/harness-slot}"
stable="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' | sed 's/^v//')"
"$slot" node scripts/screenshots.mjs --only home,phone --as-version "$stable" "$@"
HARNESS_PASEO=0.16 "$slot" node scripts/screenshots.mjs --only sidebar --as-version "$stable" "$@"
tmp="$(mktemp -d)"
HARNESS_PASEO=0.16 "$slot" node scripts/screenshots.mjs --only frames --as-version "$stable" --out "$tmp" "$@"
for f in "$tmp"/follow-up-frame-*.png "$tmp"/follow-up-catch-up-phone-*.png; do cp "$f" docs/screenshots/; done
"$slot" node scripts/cover.mjs --from "$tmp" --out docs/screenshots
rm -rf "$tmp"
