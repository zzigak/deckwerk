# TODO

Features for research talks, in the order we plan to build them. Each one
should stay an ordinary, editable deck object (not a web element) unless noted,
round-trip through the HTML authoring format, and work in the browser collab
editor as well as the desktop app.

## 1. Synced video comparison

Two or more videos that play, pause, loop and scrub together, for real vs.
simulated and before/after comparisons.

- [x] A "sync group" on video elements (`syncGroup: string`): the player drives
      every video in a group from one clock, so they never drift apart.
- [ ] One shared scrubber while presenting (hover to show), and play/pause for
      the whole group.
- [ ] Optional wipe: two videos (or images) stacked, with a draggable divider
      (before/after slider), authored as `compare: "wipe"` on the group.
- [x] Inspector: multi-select videos → "Play in sync"; a synced video shows
      its partners and an Unsync button.
- [x] HTML round trip: `data-sync-group` (`data-compare` comes with the wipe).

## 2. Paper cards from a URL or PDF

Paste an arXiv/DOI/project URL or drop a PDF and get a figure-ready card: the
paper's first page or the site's screenshot, with a drop shadow, plus title,
authors and venue as editable text.

- [ ] Server/desktop job: PDF → first page PNG (crop top N%), URL → headless
      screenshot at 16:10.
- [ ] Metadata: arXiv API / DOI (Crossref) for title, authors, year, venue.
- [ ] Inserted as a group: image (shadow, radius) + title + "Authors, Venue Year".
- [ ] Re-fetch action when the paper updates.

## 3. Code blocks with syntax highlighting

- [ ] Code element (or a text role) highlighted with Shiki at render time.
- [ ] Bundled color schemes: GitHub Light, GitHub Dark, One Dark, Solarized
      Light, Dracula, plus one matching the deck theme; picker in the inspector.
- [ ] Line builds: reveal or highlight lines step by step (`data-lines="1-3,5"`
      per build step).
- [ ] Copy-as-text keeps the raw code; HTML round trip as `<pre><code class="language-…">`.

## 4. Equation builds and equation Morph

- [ ] Equation builds: reveal or color individual terms of a LaTeX equation
      step by step (`\htmlClass{step-1}{…}` or `\class` markers per term).
- [ ] Equation Morph: when a slide pair has two LaTeX equations, match KaTeX
      glyphs (by character and position in the token stream) and animate each
      matched glyph to its new place; fade only unmatched ones
      (`f(x) = 0` → `f(x) = y` → `f(x) = y + 1` moves, never blurs).
- [ ] Fallback to today's cross-fade when nothing matches.

## 5. Media tab

- [ ] A panel listing every image/video/web page in the deck, with thumbnails,
      where each is used (slide numbers) and file size.
- [ ] Drag from the panel onto any slide to reuse it.
- [ ] Filter by type and by "used on this slide"; reveal-in-slide on click.
- [ ] Later: find unused and duplicate assets and offer to remove them.

## 6. Charts from data

Quarto-like: a CSV (or pasted table) plus a color scheme becomes a native chart.

- [ ] Chart element: bar, grouped bar, line, scatter; data stored in the deck
      (inline CSV) so it diffs and round-trips.
- [ ] Rendered as SVG at native resolution, styled by the deck theme fonts.
- [ ] Color schemes: deck palette, Tableau 10, Okabe-Ito (colorblind safe),
      viridis; import a palette from a list of hex colors.
- [ ] Builds: reveal series or bars step by step.
- [ ] Import CSV by drag-and-drop; edit data in a small grid in the inspector.

## 7. Presenting from a phone

- [ ] Phone remote page served by the collab server: next/previous, current and
      next slide thumbnails, speaker notes, timer.
- [ ] Pair by QR code shown in Speaker View.
- [ ] Reuse the existing presentation bus messages; works over Tailscale.

## 8. 3D model shading modes (no agent needed)

Built into the mesh viewer, chosen in the inspector or with a small toggle on
the viewer itself.

- [ ] Modes: original materials, clay, surface normals (RGB), depth (z-buffer,
      near light / far dark), UV checker, wireframe overlay.
- [ ] One mode per model or for the whole element; remembered in the deck.
- [ ] Side-by-side views keep one mode switch so comparisons stay fair.

## Smaller follow-ups

- [ ] Link an object to another slide (jump to a backup slide and return).
- [ ] QR code element generated from a URL.
- [ ] Talk progress bar / section marker.
