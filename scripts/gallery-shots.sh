#!/bin/sh
# Re-shoots the screenshot gallery (docs/screenshots/gallery/): one current render of every main surface, desktop light
# and 390x844 dark, under stable names, so the folder stays current instead of growing. One harness run on the global
# Paseo CLI (HARNESS_PASEO=0.16: 0.16 or later), through the machine-wide harness slot, then INDEX.md is rewritten with
# the commit and version shot. Synthetic data only. Not shipped in the npm package (package.json "files").
# Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md); HARNESS_SLOT overrides the slot wrapper's path.
# Re-shoot only some surfaces with --shot '<regex>' (e.g. --shot '^gallery-(home|pill)-'); INDEX.md still lists all.
set -eu
here="$(dirname "$0")"
. "$here/shots-optimiser.sh"
slot="${HARNESS_SLOT:-$HOME/paseo-harness/tools/harness-slot}"
dir=docs/screenshots/gallery
tmp="$(mktemp -d)"
HARNESS_PASEO=0.16 "$slot" node scripts/screenshots.mjs --only gallery,whats-new --whats-new-all --out "$tmp" "$@"
mkdir -p "$dir"
for f in "$tmp"/follow-up-gallery-*.png; do [ -e "$f" ] && cp "$f" "$dir/$(basename "$f" | sed 's/^follow-up-gallery-//')"; done
[ -e "$tmp/follow-up-whats-new-light.png" ] && cp "$tmp/follow-up-whats-new-light.png" "$dir/whats-new-desktop-light.png"
[ -e "$tmp/follow-up-whats-new-phone-dark.png" ] && cp "$tmp/follow-up-whats-new-phone-dark.png" "$dir/whats-new-phone-dark.png"
rm -rf "$tmp"
node "$here/gallery-index.mjs" "$dir"
