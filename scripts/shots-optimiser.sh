#!/bin/sh
# Sourced by readme-shots.sh and gallery-shots.sh: make sure screenshots.mjs finds a PNG optimiser, so shots are taken at
# deviceScaleFactor 2 and compressed. With neither pngquant nor oxipng on PATH, and uv's uvx available, a pngquant shim
# that runs PyPI's pngquant-cli goes first on PATH. Nothing is installed globally.
if ! command -v pngquant >/dev/null 2>&1 && ! command -v oxipng >/dev/null 2>&1 && command -v uvx >/dev/null 2>&1; then
  shim="$(mktemp -d)"
  printf '#!/bin/sh\nexec uvx --quiet --from pngquant-cli pngquant "$@"\n' > "$shim/pngquant"
  chmod +x "$shim/pngquant"
  PATH="$shim:$PATH"; export PATH
fi
