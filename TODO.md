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
- [x] One shared scrubber while presenting (hover to show), and play/pause for
      the whole group.
- [x] Optional wipe: two videos (or images) stacked, with a draggable divider
      (before/after slider), authored as `compare: "wipe"` (+ `wipe` position)
      on the upper layer.
- [x] Inspector: multi-select videos → "Play in sync"; a synced video shows
      its partners and an Unsync button.
- [x] HTML round trip: `data-sync-group`, `data-compare`, `data-wipe`.

## 2. Paper cards from a URL or PDF

Paste an arXiv/DOI/project URL or drop a PDF and get a figure-ready card: the
paper's first page or the site's screenshot, with a drop shadow, plus title,
authors and venue as editable text.

- [x] Server/desktop job: PDF → first page PNG (crop top N%), URL → headless
      screenshot at 16:10.
- [x] Metadata: arXiv API / DOI (Crossref) for title, authors, year, venue.
- [x] Inserted as a group: image (shadow, radius) + title + "Authors, Venue Year".
      (The deck has no groups yet: the three objects arrive selected together.)
- [ ] Re-fetch action when the paper updates.

## 3. Code blocks with syntax highlighting

- [ ] Code element (or a text role) highlighted with Shiki at render time.
- [ ] Bundled color schemes: GitHub Light, GitHub Dark, One Dark, Solarized
      Light, Dracula, plus one matching the deck theme; picker in the inspector.
- [ ] Line builds: reveal or highlight lines step by step (`data-lines="1-3,5"`
      per build step).
- [ ] Copy-as-text keeps the raw code; HTML round trip as `<pre><code class="language-…">`.

## 4. Equation builds and equation Morph

- [x] Equation builds: reveal or color individual terms of a LaTeX equation
      step by step (`\htmlClass{step-1}{…}` or `\class` markers per term).
- [x] Equation Morph: when a slide pair has two LaTeX equations, match KaTeX
      glyphs (by character and position in the token stream) and animate each
      matched glyph to its new place; fade only unmatched ones
      (`f(x) = 0` → `f(x) = y` → `f(x) = y + 1` moves, never blurs).
- [x] Fallback to today's cross-fade when nothing matches.
- [x] Emphasis build ("pulse"): a marked term grows for a moment (about 1.6x,
      ~0.8 s) and settles back, to point the audience at one part of the
      equation without changing it.

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

- [x] Phone remote page served by the collab server: next/previous, current and
      next slide thumbnails, speaker notes, timer.
- [x] Pair by QR code shown in Speaker View.
- [x] Reuse the existing presentation bus messages; works over Tailscale.
- [ ] Pairing from the desktop app's own presentation windows (today: only
      while hosting a collaboration session).

## 8. 3D model shading modes (no agent needed)

Built into the mesh viewer, chosen in the inspector or with a small toggle on
the viewer itself.

- [x] Modes: original materials, clay, surface normals (RGB), depth (z-buffer,
      near light / far dark), UV checker, wireframe.
- [x] Remembered in the deck: the web element's `fragment` (`shading=normals`),
      chosen from the inspector's Shading menu; hover buttons switch it live.
- [x] Side-by-side views share the one mode, so comparisons stay fair.
- [ ] Per-model modes, and a poster re-captured in the chosen mode (the canvas
      still shows the import-time still).

## Smaller follow-ups

- [ ] Link an object to another slide (jump to a backup slide and return).
- [ ] QR code element generated from a URL.
- [ ] Talk progress bar / section marker.
