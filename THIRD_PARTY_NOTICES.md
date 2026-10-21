# Third-party notices for `services/ephemera`

This service combines original code with material derived from the AGPL-3.0
upstream project `kimi-room` and with OFL-1.1 fonts. The combined work is
distributed under **GNU AGPL-3.0-only** (see [LICENSE](LICENSE)).

## Upstream code derivation (AGPL-3.0)

- **Upstream project**: `kimi-room@0.33.0` (package name `kimi-room`),
  copyright © 2026 marikagura. The frozen local snapshot matches the
  user-provided checkout; the public upstream is
  <https://github.com/marikagura/kimi-room>.
- **Files adapted** (from the frozen read-only snapshot `reference/ephemera-web`):
  - `src/components/ephemera/EphemeraClient.tsx` — the paper structure,
    typography, decorative SVGs, CSS and the built-in genre layouts, adapted
    into `src/render/original/EphemeraClient.tsx`, `src/render/sheet.tsx` and
    `src/render/page.ts`. Device dimensions, pagination, data contracts and
    public-release artwork have subsequently been changed. The web shell,
    navigation, drawer, push and demo-paper store are not distributed.
  - `public/fonts/kimi-fonts.css` — the `@font-face` declarations for the
    postcard-bound families, reduced to the required subset in
    `assets/fonts/fonts.css`.
  - `src/lib/ephemera-demo.ts` — referenced only for the `Paper` field
    vocabulary; no demo data was carried over.
- **Modification period**: 2026-10-06 through 2026-10-21.
- **License**: GNU Affero General Public License v3.0 only. The full license
  text is copied verbatim into [LICENSE](LICENSE). Because the renderer is a
  derivative work, the combined `services/ephemera` package is AGPL-3.0-only.

### Deliberately excluded upstream assets

The upstream ships images under narrower terms than its code. None of the
following are copied into, referenced by, or requested over the network by
this service:

- `rose-bud-pink.png` (CC BY-NC 4.0) — replaced by a simple inline geometric
  SVG bud ornament.
- `entry-motion.png` (upstream brand identity; upstream asks forks to replace
  it) — replaced by a generic inline `EPHEMERA POST` cancellation-mark SVG.
- `public/images/mood/**` and all other raster art — out of scope for the
  postcard paper.

The replacement ornaments are original geometric drawings in this project and
do not trace the replaced artwork.

The public release excludes both upstream fox artwork and the owner's private
mascot and iris artwork. Its default primary mark, secondary mark, and all five
mascot-state slots use the original black-and-white rose in
`assets/public/rose-placeholder.svg` (with a PNG raster fallback). Users can
replace those images in their own private personalization data directory.

## Fonts (SIL Open Font License 1.1)

`assets/fonts/` ships exactly the woff2 subsets the postcard binds, with the
license text at [licenses/OFL-1.1.txt](licenses/OFL-1.1.txt) and family
copyright statements at [licenses/FONT_NOTICES.md](licenses/FONT_NOTICES.md):

| Family | Style/weight | Files | Upstream source |
| --- | --- | --- | --- |
| Noto Serif SC | normal 500 + 700 (shared variable subsets) | 101 unique woff2 | <https://github.com/notofonts/noto-cjk> via Google Fonts `ofl/notoserifsc` |
| Cormorant Garamond | normal 500 + italic 500 | 10 unique woff2 | <https://github.com/CatharsisFonts/Cormorant> via Google Fonts `ofl/cormorantgaramond` |

Total: 111 unique woff2 files, each with a SHA-256 entry in
`assets/fonts/fonts.manifest.json` (machine-checkable; the renderer fails
closed if any file is missing or altered). The fonts were taken from the
upstream snapshot's self-hosted Google Fonts subsets; per OFL 1.1 they are
redistributed under the OFL with their reserved names untouched.

## npm dependencies

Runtime and development dependencies are exact-pinned in `package.json` /
`package-lock.json`:

| Package | Version | License |
| --- | --- | --- |
| `@modelcontextprotocol/server` / `-client` / `-node` / `-core` | 2.3.1 / 2.3.1 / 2.1.1 / 2.3.1 | MIT |
| `zod` | 4.6.5 | MIT |
| `lunar-javascript` | 1.7.7 | MIT; copyright © 2018 6tail |
| `astronomy-engine` | 2.1.19 | MIT; copyright © 2019–2023 Don Cross |
| `react` / `react-dom` | 19.3.0 | MIT |
| `playwright-core` | 1.62.0 | Apache-2.0 |
| `pngjs` | 7.0.0 | MIT |
| `fontkit` | 2.0.4 | MIT |
| `esptool-js` | 0.6.1 | Apache-2.0 |
| `pako` (via `esptool-js`) | 2.2.0 | MIT and Zlib |
| `atob-lite` / `tslib` (via `esptool-js`) | 2.0.0 / 2.8.1 | MIT / 0BSD |
| `typescript` / `@types/node` / `@types/react` / `@types/react-dom` | 5.9.3 / 24.19.1 / 19.3.0 / 19.3.0 | Apache-2.0 / MIT |

The locked Chromium binaries (revision 1234, version 151.0.7922.34) used by
playwright-core are provided through `PLAYWRIGHT_BROWSERS_PATH` by the
deploying environment and are not part of this package.

The Owner console serves the exact-pinned `esptool-js` browser bundle from
the installed package. It is used locally in Chrome/Edge to flash the bundled
ESP32-S3 firmware over Web Serial; the console does not load a CDN copy.
