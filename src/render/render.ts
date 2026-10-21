/**
 * Postcard render orchestration (single deterministic pipeline).
 *
 * manuscript -> font/cmap gates -> React-rendered paper -> locked Chromium
 * (loopback only) -> fit gates -> 540x960 PNG -> gray4 frame -> artifacts.
 *
 * Fit is fixed and testable: no shrinking, no clipping, no hiding, no fading.
 * The page, the paper, the body and every decoration's critical box must sit
 * inside 540x960; the body's scrollHeight must fit its clientHeight and every
 * visible line rect must be a non-zero box inside the body frame. Anything
 * longer fails with `render_overflow` and leaves no success artifacts.
 */

import { createHash } from 'node:crypto';
import {
  CHROMIUM_REVISION,
  CHROMIUM_VERSION,
  GRAY4_ALGORITHM,
  GRAY4_ALGORITHM_VERSION,
  GRAY4_BYTE_LENGTH,
  GRAY4_STRIDE_BYTES,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  RENDER_PROFILE,
  RENDERER_BUILD,
  SERVICE_VERSION,
} from '../version.js';
import { RenderError } from './errors.js';
import { renderPageInChromium, type PageMeasurement } from './browser.js';
import { loadFontAssets, assertGlyphCoverage, type LoadedFontAssets } from './fonts.js';
import { decodePngRgba, rgbaToGray4 } from './gray4.js';
import { parseManuscript, type ParsedManuscript } from './manuscript.js';
import { buildPageHtml } from './page.js';
import { TEMPLATE_TEXT } from './sheet.js';
import { prepareOutputDir, writeArtifact } from './outputs.js';

export interface RenderRequest {
  /** Parsed manuscript JSON value. */
  manuscript: unknown;
  /** Byte length of the raw manuscript JSON file (input budget gate). */
  manuscriptBytes?: number;
  /** Output directory: must not exist or must be empty. */
  outputPath: string;
  /** Override the fonts root (tests use a copied tree). */
  fontsRoot?: string;
}

export interface RenderOutcome {
  ok: true;
  outputDir: string;
  profile: string;
  tone: { value: string; source: 'author' | 'template-default' };
  page: { width: number; height: number };
  files: Record<string, { bytes: number; sha256: string }>;
  chromium: { version: string; revision: string; playwright: string };
  fonts: { manifestVersion: number; count: number; served: number };
  gray4: { byteLength: number; inkPixels: number; distinctLevels: number[] };
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface FitEvaluation {
  ok: boolean;
  failures: string[];
  checks: { name: string; ok: boolean }[];
}

const BOX_TOLERANCE = 1.5;

/**
 * Deterministic fit gate over the measured page. Exported for unit tests.
 */
export function evaluateFit(measurement: PageMeasurement): FitEvaluation {
  const checks: { name: string; ok: boolean }[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    checks.push({ name, ok });
    if (!ok) failures.push(name);
  };

  check(
    'viewport_locked',
    measurement.viewport.width === PAGE_WIDTH && measurement.viewport.height === PAGE_HEIGHT,
  );
  check(
    'document_fits_viewport',
    measurement.document.scrollWidth <= PAGE_WIDTH && measurement.document.scrollHeight <= PAGE_HEIGHT,
  );
  const inPage = (box: { x: number; y: number; width: number; height: number }) =>
    box.x >= -BOX_TOLERANCE &&
    box.y >= -BOX_TOLERANCE &&
    box.x + box.width <= PAGE_WIDTH + BOX_TOLERANCE &&
    box.y + box.height <= PAGE_HEIGHT + BOX_TOLERANCE;
  for (const name of ['sheet', 'head', 'stamp', 'postmark', 'divider', 'bodyText'] as const) {
    const box = measurement.boxes[name];
    check(`box_${name}_in_page`, box !== undefined && box.width > 0 && box.height > 0 && inPage(box));
  }
  check(
    'sheet_exact_geometry',
    Math.abs(measurement.boxes.sheet!.width - PAGE_WIDTH) <= BOX_TOLERANCE &&
      Math.abs(measurement.boxes.sheet!.height - PAGE_HEIGHT) <= BOX_TOLERANCE,
  );
  const body = measurement.bodyText;
  check('body_minimum_font_size', body.fontSizePx >= 26);
  check('body_no_vertical_overflow', body.scrollHeight <= body.clientHeight);
  check('body_no_horizontal_overflow', body.scrollWidth <= body.clientWidth);
  const bodyBox = measurement.boxes.bodyText!;
  let visibleLineCount = 0;
  let linesWithin = true;
  let linesNonZeroHeight = true;
  for (const rect of body.lineRects) {
    if (rect.height <= 0) linesNonZeroHeight = false;
    if (rect.width > 0) visibleLineCount += 1;
    const within =
      rect.x >= bodyBox.x - BOX_TOLERANCE &&
      rect.y >= bodyBox.y - BOX_TOLERANCE &&
      rect.x + rect.width <= bodyBox.x + bodyBox.width + BOX_TOLERANCE &&
      rect.y + rect.height <= bodyBox.y + bodyBox.height + BOX_TOLERANCE;
    if (!within) linesWithin = false;
  }
  check('body_lines_non_zero_height', linesNonZeroHeight);
  check('body_lines_within_body_box', linesWithin);
  check('body_has_visible_lines', visibleLineCount > 0);
  check('fonts_ready', measurement.fontsReady);

  return { ok: failures.length === 0, failures, checks };
}

/** Gate every string the paper will paint through the real font cmaps. */
function assertTemplateGlyphs(assets: LoadedFontAssets): void {
  for (const text of TEMPLATE_TEXT.noto700) assertGlyphCoverage(assets, text, 'noto700', 'template text');
  for (const text of TEMPLATE_TEXT.noto500) assertGlyphCoverage(assets, text, 'noto500', 'template text');
  for (const text of TEMPLATE_TEXT.cormorant500) assertGlyphCoverage(assets, text, 'cormorant500', 'template text');
  for (const text of TEMPLATE_TEXT.cormorantItalic500) assertGlyphCoverage(assets, text, 'cormorantItalic500', 'template text');
}

export async function renderPostcard(request: RenderRequest): Promise<RenderOutcome> {
  const parsed: ParsedManuscript = parseManuscript(request.manuscript, request.manuscriptBytes);

  const assets = await loadFontAssets(request.fontsRoot);
  assertGlyphCoverage(assets, parsed.manuscript.body, 'noto500', 'manuscript body');
  assertTemplateGlyphs(assets);

  const pageHtml = buildPageHtml(parsed.effectiveTone, parsed.manuscript.body);

  const rendered = await renderPageInChromium({ pageHtml, assets });

  // Content integrity: the DOM body node must be the manuscript body exactly.
  const bodyDigest = sha256Hex(parsed.manuscript.body);
  const domDigest = sha256Hex(rendered.measurement.bodyText.textContent);
  const contentMatches =
    domDigest === bodyDigest && rendered.measurement.bodyText.textContent === parsed.manuscript.body;
  if (!contentMatches) {
    throw new RenderError('author_content_mismatch', 'rendered body text does not match the manuscript body');
  }

  const fit = evaluateFit(rendered.measurement);
  if (!fit.ok) {
    if (fit.failures.some((name) => name.startsWith('body_no_') || name === 'document_fits_viewport' || name.startsWith('body_lines'))) {
      throw new RenderError('render_overflow', `body does not fit the postcard paper (${fit.failures.slice(0, 3).join(', ')})`);
    }
    throw new RenderError('render_failed', `paper layout gate failed (${fit.failures.slice(0, 3).join(', ')})`);
  }

  // Pixels: decode the real PNG and convert to the gray4 frame.
  const decoded = decodePngRgba(rendered.png);
  const gray4 = rgbaToGray4(decoded.rgba, decoded.width, decoded.height);
  if (gray4.byteLength !== GRAY4_BYTE_LENGTH) {
    throw new RenderError('render_failed', 'gray4 frame has the wrong length');
  }
  if (gray4.inkPixels === 0 || gray4.distinctLevels.length < 2) {
    throw new RenderError('render_failed', 'rendered page appears blank');
  }

  const pngSha256 = sha256Hex(rendered.png);
  const gray4Sha256 = sha256Hex(gray4.frame);

  const verification = {
    verification_version: 1,
    profile: RENDER_PROFILE,
    input: {
      intent_sha256: sha256Hex(parsed.manuscript.intent),
      intent_utf8_bytes: parsed.intentUtf8Bytes,
      intent_scalar_count: parsed.intentScalarCount,
      body_sha256: bodyDigest,
      body_utf8_bytes: parsed.bodyUtf8Bytes,
      body_scalar_count: parsed.bodyScalarCount,
    },
    dom: {
      body_text_sha256: domDigest,
      body_text_utf8_bytes: Buffer.byteLength(rendered.measurement.bodyText.textContent, 'utf8'),
      body_text_scalar_count: rendered.measurement.bodyText.textLengthScalars,
      matches_input_body: contentMatches,
      body_font_size_px: rendered.measurement.bodyText.fontSizePx,
    },
    provenance: { field: 'body', start_utf8: 0, end_utf8: parsed.bodyUtf8Bytes },
    fonts: {
      manifest_version: assets.manifestVersion,
      file_count: assets.fontCount,
      files_served: rendered.fontFilesServed.length,
      fonts_ready: rendered.measurement.fontsReady,
      fonts_check: rendered.measurement.fontsCheck,
    },
    resources: {
      request_count: rendered.requests.length,
      blocked_count: rendered.requests.filter((r) => r.blocked).length,
      requests: rendered.requests.map((r) => ({
        path: safeUrlPath(r.url),
        method: r.method,
        status: r.status,
        failed: r.failed,
        blocked: r.blocked,
      })),
    },
    viewport: { width: rendered.measurement.viewport.width, height: rendered.measurement.viewport.height, device_scale_factor: 1 },
    boxes: rendered.measurement.boxes,
    body_lines: {
      rect_count: rendered.measurement.bodyText.lineRects.length,
      visible_line_count: rendered.measurement.bodyText.lineRects.filter((r) => r.width > 0).length,
      rects: rendered.measurement.bodyText.lineRects,
    },
    fit: {
      body_scroll_height: rendered.measurement.bodyText.scrollHeight,
      body_client_height: rendered.measurement.bodyText.clientHeight,
      checks: fit.checks,
      ok: fit.ok,
    },
    pixels: {
      png: { width: decoded.width, height: decoded.height, sha256: pngSha256 },
      gray4: {
        byte_length: gray4.byteLength,
        sha256: gray4Sha256,
        ink_pixels: gray4.inkPixels,
        distinct_levels: gray4.distinctLevels,
      },
    },
  };

  const renderManifest = {
    manifest_version: 1,
    profile: RENDER_PROFILE,
    format: 'gray4',
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    stride_bytes: GRAY4_STRIDE_BYTES,
    byte_length: GRAY4_BYTE_LENGTH,
    assets: {
      'page.png': { sha256: pngSha256, bytes: rendered.png.length },
      'page.gray4': { sha256: gray4Sha256, bytes: gray4.byteLength },
    },
    renderer: {
      build: RENDERER_BUILD,
      service_version: SERVICE_VERSION,
      schema_version: 1,
      genre: 'postcard',
      tone: { value: parsed.effectiveTone, source: parsed.toneSource },
    },
    toolchain: {
      node: process.version,
      playwright: rendered.playwrightVersion,
      chromium: { revision: CHROMIUM_REVISION, version: CHROMIUM_VERSION, reported: rendered.chromiumVersion },
    },
    fonts: { manifest_version: assets.manifestVersion, file_count: assets.fontCount },
    conversion: { algorithm: GRAY4_ALGORITHM, version: GRAY4_ALGORITHM_VERSION, dithering: false },
  };

  const outputDir = await prepareOutputDir(request.outputPath);
  const verificationJson = JSON.stringify(verification, null, 1);
  const manifestJson = JSON.stringify(renderManifest, null, 1);
  const sizes = {
    'page.png': await writeArtifact(outputDir, 'page.png', rendered.png),
    'page.gray4': await writeArtifact(outputDir, 'page.gray4', gray4.frame),
    'verification.json': await writeArtifact(outputDir, 'verification.json', verificationJson),
    'render-manifest.json': await writeArtifact(outputDir, 'render-manifest.json', manifestJson),
  };

  return {
    ok: true,
    outputDir,
    profile: RENDER_PROFILE,
    tone: { value: parsed.effectiveTone, source: parsed.toneSource },
    page: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    files: {
      'page.png': { bytes: sizes['page.png']!.bytes, sha256: pngSha256 },
      'page.gray4': { bytes: sizes['page.gray4']!.bytes, sha256: gray4Sha256 },
      'verification.json': { bytes: sizes['verification.json']!.bytes, sha256: sha256Hex(verificationJson) },
      'render-manifest.json': { bytes: sizes['render-manifest.json']!.bytes, sha256: sha256Hex(manifestJson) },
    },
    chromium: { version: rendered.chromiumVersion, revision: CHROMIUM_REVISION, playwright: rendered.playwrightVersion },
    fonts: { manifestVersion: assets.manifestVersion, count: assets.fontCount, served: rendered.fontFilesServed.length },
    gray4: { byteLength: gray4.byteLength, inkPixels: gray4.inkPixels, distinctLevels: gray4.distinctLevels },
  };
}

/** Reduce a request URL to its loopback path for evidence (no query, no creds). */
function safeUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return '<unparsed>';
  }
}
