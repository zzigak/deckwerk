#!/bin/sh
# Regenerates every picture and clip in site/docs/media from scratch:
# builds the docs deck, exports it, records the player, and screenshots the
# editor and a browser session. Needs ffmpeg, cwebp and Google Chrome.
#
#   sh site/docs/media-src/make.sh <checkout> <work-dir> [<wipe-chip-checkout>]
#
# <checkout> is a DeckWerk checkout with every feature on the page and its
# dependencies installed. The Compare button and Comparison length pictures
# come from the checkout that has them, given third, on a two-slide deck.
set -e
here=$(cd "$(dirname "$0")" && pwd)
checkout=$(cd "${1:?usage: make.sh <checkout> <work-dir> [<wipe-chip-checkout>]}" && pwd)
work=${2:?usage: make.sh <checkout> <work-dir> [<wipe-chip-checkout>]}
mkdir -p "$work"
work=$(cd "$work" && pwd)
node_cmd() { (cd "$1" && shift && node_modules/.bin/vite-node --config vitest.config.ts "$@"); }

(cd "$checkout" && npm run build:export >/dev/null && npm run build:mesh-viewer >/dev/null)
node_cmd "$checkout" "$here/build-deck.mts" "$work/deck"
rm -rf "$work/web"
node_cmd "$checkout" scripts/export-deck.mts -- "$work/deck" "$work/web" --quality original --no-thumbnail
node "$here/capture.mjs" "$checkout" "$work/deck" "$work/web"
node_cmd "$checkout" "$here/ui.mts" "$work/deck"
node_cmd "$checkout" "$here/web.mts" "$work/deck"
if [ -n "$3" ]; then
  node -e '
    const fs = require("fs");
    const [from, to] = process.argv.slice(1);
    fs.cpSync(from, to, { recursive: true });
    const deck = JSON.parse(fs.readFileSync(`${to}/deck.json`, "utf8"));
    deck.slides = deck.slides.filter((slide) => ["synced", "wipe"].includes(slide.name));
    fs.writeFileSync(`${to}/deck.json`, JSON.stringify(deck, null, 1));
  ' "$work/deck" "$work/compare-deck"
  node_cmd "$3" "$here/ui.mts" "$work/compare-deck" wipe-button wipe-length
fi
node "$here/../render.mjs"
