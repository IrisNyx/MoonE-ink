# Public placeholder artwork

`rose-placeholder.svg` is an original flat black-and-white vector rose made for
the public Ephemera release. `rose-placeholder.png` is a transparent 512-pixel
rasterization of that SVG for the renderer's PNG-only mascot slots. Neither is
copied from the upstream rose/fox art or the owner's private iris/mascot art.

Both are distributed under the package's AGPL-3.0-only license. To regenerate
the PNG during development, set `PLAYWRIGHT_BROWSERS_PATH` to the locked
Chromium cache and run `node scripts/render-public-rose.mjs`.
