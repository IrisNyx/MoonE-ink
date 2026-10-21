/**
 * Font asset manifest + cmap coverage for the postcard renderer.
 *
 * The renderer ships exactly the woff2 subsets the postcard paper binds:
 * Noto Serif SC normal 500/700 (101 unique files — both weights reference
 * the same variable subsets) and Cormorant Garamond normal/italic 500
 * (10 files). assets/fonts/fonts.manifest.json is the machine-checkable
 * inventory; every render re-verifies every file's SHA-256 so a deleted or
 * corrupted font fails with `asset_unavailable` before any browser starts
 * (acceptance R04).
 *
 * Glyph coverage is decided from the *actual cmaps* of those files via
 * fontkit — `document.fonts.check()` in the browser is recorded as loading
 * evidence, never as the only missing-glyph gate. A scalar without a cmap
 * entry in every bound font role is `unsupported_glyph` (no silent system
 * fallback, so emoji and unshipped CJK extensions fail loudly).
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { RenderError } from './errors.js';

const require_ = createRequire(import.meta.url);
// Bounded lazy require keeps the CJS fontkit build out of the service path.
type Fontkit = typeof import('fontkit');
function loadFontkit(): Fontkit {
  return require_('fontkit') as Fontkit;
}

export const FONT_MANIFEST_VERSION = 1;
export const EXPECTED_FONT_COUNT = 111;

export const NOTO_FAMILY = 'Noto Serif SC';
export const CORMORANT_FAMILY = 'Cormorant Garamond';

/** CSS-facing font roles the paper binds (no fallback families anywhere). */
export interface FontRoles {
  /** CJK/Latin prose: 'Noto Serif SC' normal 500. */
  noto500: string[];
  /** CJK display headings: 'Noto Serif SC' normal 700. */
  noto700: string[];
  /** Latin display: 'Cormorant Garamond' normal 500. */
  cormorant500: string[];
  /** Latin italic display: 'Cormorant Garamond' italic 500. */
  cormorantItalic500: string[];
}

export interface FontManifestEntry {
  file: string;
  sha256: string;
  bytes: number;
  faces: { family: string; style: string; weight: number; unicode_range: string }[];
}

export interface LoadedFontAssets {
  manifestVersion: number;
  fontsRoot: string;
  cssText: string;
  files: FontManifestEntry[];
  roles: FontRoles;
  /** family|style|weight -> sorted unicode scalar set from the real cmaps */
  coverage: Map<string, Set<number>>;
  fontCount: number;
}

interface RawManifest {
  manifest_version?: number;
  files?: FontManifestEntry[];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(path),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) hash.update(chunk);
    },
  );
  return hash.digest('hex');
}

/**
 * Load and verify the font inventory under `fontsRoot` (defaults to the
 * packaged assets/fonts directory next to the compiled module).
 */
export async function loadFontAssets(fontsRoot?: string): Promise<LoadedFontAssets> {
  // dist/src/render/fonts.js -> <package>/assets/fonts
  const root = fontsRoot ?? join(import.meta.dirname, '../../../assets/fonts');
  let raw: RawManifest;
  try {
    raw = JSON.parse(await readFile(join(root, 'fonts.manifest.json'), 'utf8')) as RawManifest;
  } catch {
    throw new RenderError('asset_unavailable', 'font manifest is missing or unreadable');
  }
  if (raw.manifest_version !== FONT_MANIFEST_VERSION || !Array.isArray(raw.files)) {
    throw new RenderError('asset_unavailable', 'font manifest version is not supported');
  }
  const files = raw.files;
  if (files.length !== EXPECTED_FONT_COUNT) {
    throw new RenderError('asset_unavailable', 'font inventory does not match the renderer manifest');
  }

  const fontkit = loadFontkit();
  const roles: FontRoles = { noto500: [], noto700: [], cormorant500: [], cormorantItalic500: [] };
  const coverage = new Map<string, Set<number>>();

  for (const entry of files) {
    if (!/^[A-Za-z0-9._-]+\.woff2$/.test(entry.file)) {
      throw new RenderError('asset_unavailable', 'font inventory contains an unexpected file name');
    }
    const path = join(root, entry.file);
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch {
      throw new RenderError('asset_unavailable', 'a required font file is missing');
    }
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== entry.sha256 || buffer.length !== entry.bytes) {
      throw new RenderError('asset_unavailable', 'a required font file failed its integrity check');
    }
    // Real cmap of the actual file (not the CSS unicode-range guesswork).
    let characterSet: number[];
    try {
      const font = fontkit.create(buffer);
      characterSet = font.characterSet;
    } catch {
      throw new RenderError('asset_unavailable', 'a required font file could not be parsed');
    }
    if (!Array.isArray(characterSet) || characterSet.length === 0) {
      throw new RenderError('asset_unavailable', 'a required font file has no usable cmap');
    }
    for (const face of entry.faces) {
      if (face.family === NOTO_FAMILY && face.style === 'normal' && face.weight === 500) roles.noto500.push(entry.file);
      if (face.family === NOTO_FAMILY && face.style === 'normal' && face.weight === 700) roles.noto700.push(entry.file);
      if (face.family === CORMORANT_FAMILY && face.style === 'normal' && face.weight === 500) roles.cormorant500.push(entry.file);
      if (face.family === CORMORANT_FAMILY && face.style === 'italic' && face.weight === 500) roles.cormorantItalic500.push(entry.file);
      const key = `${face.family}|${face.style}|${face.weight}`;
      let set = coverage.get(key);
      if (set === undefined) {
        set = new Set<number>();
        coverage.set(key, set);
      }
      for (const cp of characterSet) set.add(cp);
    }
  }

  for (const [name, list] of Object.entries(roles)) {
    if (list.length === 0) throw new RenderError('asset_unavailable', `font inventory lacks the ${name} role`);
  }

  let cssText: string;
  try {
    cssText = await readFile(join(root, 'fonts.css'), 'utf8');
  } catch {
    throw new RenderError('asset_unavailable', 'font stylesheet is missing');
  }

  return {
    manifestVersion: FONT_MANIFEST_VERSION,
    fontsRoot: root,
    cssText,
    files,
    roles,
    coverage,
    fontCount: files.length,
  };
}

/**
 * Every Unicode scalar of `text` must have a cmap entry in at least one of the
 * bound role files. \n, \r and \t are layout controls the engine handles
 * without glyphs; they are exempt (they still flow byte-exact through the
 * DOM text node). Returns the offending scalar positions for a stable error.
 */
export function assertGlyphCoverage(assets: LoadedFontAssets, text: string, role: keyof FontRoles, what: string): void {
  const family = role.startsWith('noto') ? NOTO_FAMILY : CORMORANT_FAMILY;
  const style = role === 'cormorantItalic500' ? 'italic' : 'normal';
  const weight = role.endsWith('700') ? 700 : 500;
  const union = assets.coverage.get(`${family}|${style}|${weight}`);
  if (union === undefined) {
    throw new RenderError('asset_unavailable', 'font coverage table is incomplete');
  }

  const missing: number[] = [];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) {
      index += 1;
      continue;
    }
    if (!union.has(cp) && missing.length < 5) missing.push(index);
    index += 1;
  }
  if (missing.length > 0) {
    throw new RenderError(
      'unsupported_glyph',
      `${what} contains a Unicode scalar with no glyph in the bound fonts (first at ${missing[0]})`,
    );
  }
}

/** Number of distinct files the browser must be able to fetch for a text. */
export function fontStats(assets: LoadedFontAssets): { files: number; manifestVersion: number } {
  return { files: assets.fontCount, manifestVersion: assets.manifestVersion };
}
