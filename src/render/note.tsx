import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decodePngRgba, rgbaToGray4 } from './gray4.js';
import { publicBrandingFacts, type RenderBranding } from './branding.js';
import { assertGlyphCoverage, loadFontAssets } from './fonts.js';
import { RenderError } from './errors.js';
import { withLockedPageSession, type RecordedRequest } from './browser.js';
import {
  NoteSheet,
  noteCss,
  noteSpecFor,
  type NoteDocument,
  type NoteLayoutSpec,
  type NoteLayoutVariant,
} from './note-sheet.js';
import { NotePaginationError, paginateNote, type NoteFragment, type NoteMeasure } from './note-pagination.js';
import { prepareOutputDir, writeArtifact } from './outputs.js';
import {
  CHROMIUM_REVISION,
  GRAY4_ALGORITHM,
  GRAY4_ALGORITHM_VERSION,
  GRAY4_BYTE_LENGTH,
  GRAY4_STRIDE_BYTES,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PLAYWRIGHT_VERSION,
  RENDER_PROFILE,
  SERVICE_VERSION,
} from '../version.js';

export const NOTE_RENDERER_BUILD = 'note-renderer/3';

export interface NoteParagraphSource {
  index: number;
  text: string;
  startUtf16: number;
  endUtf16: number;
  startCodePoint: number;
  endCodePoint: number;
  separatorAfter: {
    text: string;
    startCodePoint: number;
    endCodePoint: number;
  } | null;
}

export interface NoteRenderRequest {
  body: string;
  title?: string;
  signature?: string;
  date: string;
  outputPath: string;
  fontsRoot?: string;
  layoutVariant?: NoteLayoutVariant;
  branding?: RenderBranding;
  signatureSource?: 'author' | 'owner-config';
}

export interface NotePageOutcome {
  index: number;
  pngName: string;
  gray4Name: string;
  png: { sha256: string; bytes: number };
  gray4: { sha256: string; bytes: number };
  sourceRanges: Array<{
    field: 'body';
    startCodePoint: number;
    endCodePoint: number;
    paragraphIndex: number;
    continuedBefore: boolean;
    continuedAfter: boolean;
  }>;
  gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
}

export interface NoteRenderOutcome {
  ok: true;
  outputDir: string;
  profile: string;
  genre: 'note';
  pages: NotePageOutcome[];
  paper: unknown;
  editorialSpec: unknown;
  provenance: unknown;
  chromium: { version: string; revision: string; playwright: string };
  fonts: { manifestVersion: number; count: number; served: number };
}

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const codePointsBefore = (source: string, utf16Offset: number): number => Array.from(source.slice(0, utf16Offset)).length;

/**
 * Deterministically split on pairs of consecutive authored line-break tokens.
 * Each exact separator is retained beside the preceding paragraph. Four line
 * breaks therefore preserve one explicit empty paragraph; an odd extra break
 * remains visible in the following paragraph. Joining text+separators is byte
 * identical to the accepted body.
 */
export function deriveNoteParagraphs(body: string): NoteParagraphSource[] {
  const breaks = [...body.matchAll(/\r\n|\r|\n/g)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const result: NoteParagraphSource[] = [];
  let cursor = 0;
  let scan = 0;
  while (scan + 1 < breaks.length) {
    const first = breaks[scan]!;
    const second = breaks[scan + 1]!;
    if (first.end !== second.start || first.start < cursor) {
      scan += 1;
      continue;
    }
    const separatorEnd = second.end;
    result.push({
      index: result.length,
      text: body.slice(cursor, first.start),
      startUtf16: cursor,
      endUtf16: first.start,
      startCodePoint: codePointsBefore(body, cursor),
      endCodePoint: codePointsBefore(body, first.start),
      separatorAfter: {
        text: body.slice(first.start, separatorEnd),
        startCodePoint: codePointsBefore(body, first.start),
        endCodePoint: codePointsBefore(body, separatorEnd),
      },
    });
    cursor = separatorEnd;
    scan += 2;
  }
  result.push({
    index: result.length,
    text: body.slice(cursor),
    startUtf16: cursor,
    endUtf16: body.length,
    startCodePoint: codePointsBefore(body, cursor),
    endCodePoint: codePointsBefore(body, body.length),
    separatorAfter: null,
  });
  const reconstructed = result.map((item) => item.text + (item.separatorAfter?.text ?? '')).join('');
  if (reconstructed !== body) throw new RenderError('author_content_mismatch', 'note paragraph derivation changed the body');
  return result;
}

function pageHtml(document: NoteDocument, fragments: readonly NoteFragment[], pageIndex: number, pageCount: number,
  final: boolean, spec: NoteLayoutSpec, branding?: RenderBranding): string {
  const markup = renderToStaticMarkup(<NoteSheet document={document} fragments={fragments}
    pageIndex={pageIndex} pageCount={pageCount} final={final} secondaryLogoDataUrl={branding?.secondaryLogoDataUrl}/>);
  return [
    '<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=540,initial-scale=1">',
    '<title>ephemera note</title><link rel="stylesheet" href="/fonts/fonts.css">',
    `<style>${noteCss(spec)}\n.eph-note-brandmark{width:18px;height:18px;object-fit:contain}</style></head><body>${markup}</body></html>`,
  ].join('\n');
}

interface PageGeometry {
  fits: boolean;
  failures: string[];
  lineEnds: number[][];
  fragments: Array<NoteFragment & { fontSize: string; lineHeight: string; writingMode: string }>;
  titleTexts: string[];
  signatureTexts: string[];
  surface: string;
  primaryInk: string;
}

async function measure(page: import('playwright-core').Page, spec: NoteLayoutSpec): Promise<PageGeometry> {
  return page.evaluate(({ bodyPx, titlePx, signaturePx, englishPx }) => {
    const safe = { left: 36, top: 56, right: 504, bottom: 924 };
    const within = (rect: DOMRect) => rect.left >= safe.left - .5 && rect.top >= safe.top - .5 &&
      rect.right <= safe.right + .5 && rect.bottom <= safe.bottom + .5;
    const sheet = document.querySelector('.eph-note-sheet')!.getBoundingClientRect();
    // Author body text alone is constrained to the content safe area. The
    // template header intentionally has optical glyph overhang at y=54 while
    // its box starts at the locked 56px top margin.
    const body = document.querySelector('.eph-note-copy')!;
    const failures: string[] = [];
    if (sheet.x !== 0 || sheet.y !== 0 || sheet.width !== 540 || sheet.height !== 960) failures.push('sheet_geometry');
    const scrolling = document.scrollingElement ?? document.documentElement;
    if (scrolling.scrollWidth > 540 || scrolling.scrollHeight > 960) failures.push('document_overflow');
    const textRects: DOMRect[] = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      textRects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    if (textRects.some((rect) => !within(rect))) failures.push('text_outside_safe_area');
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    const fragments = Array.from(document.querySelectorAll<HTMLParagraphElement>('.eph-note-paragraph')).map((element) => {
      const text = element.textContent ?? '';
      const textNode = element.firstChild;
      const lines: { top: number; end: number }[] = [];
      if (textNode && text.length) {
        for (const segment of segmenter.segment(text)) {
          const range = document.createRange();
          range.setStart(textNode, segment.index);
          range.setEnd(textNode, segment.index + segment.segment.length);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
          const rect = rects.find((item) => item.width > 0) ?? rects[0] ?? range.getBoundingClientRect();
          const end = segment.index + segment.segment.length;
          const previous = lines.at(-1);
          if (previous && Math.abs(previous.top - rect.top) < 1) previous.end = end;
          else lines.push({ top: rect.top, end });
        }
      }
      const lineEnds = lines.map((line) => line.end);
      if (!text.length) lineEnds.push(0);
      const style = getComputedStyle(element);
      return {
        paragraphIndex: Number(element.dataset.paragraph), start: Number(element.dataset.start), end: Number(element.dataset.end), text,
        continuedBefore: element.dataset.continuedBefore === 'true', continuedAfter: element.dataset.continuedAfter === 'true',
        lineEnds, fontSize: style.fontSize, lineHeight: style.lineHeight, writingMode: style.writingMode,
        boxFits: within(element.getBoundingClientRect()),
      };
    });
    if (fragments.some((item) => !item.boxFits)) failures.push('paragraph_outside_safe_area');
    if (fragments.some((item) => item.fontSize !== `${bodyPx}px` || item.writingMode !== 'horizontal-tb')) failures.push('body_typography');
    if (Array.from(document.querySelectorAll('.eph-note-title')).some((element) => getComputedStyle(element).fontSize !== `${titlePx}px`)) failures.push('title_typography');
    if (Array.from(document.querySelectorAll('.eph-note-signature')).some((element) => getComputedStyle(element).fontSize !== `${signaturePx}px`)) failures.push('signature_typography');
    const primaryElements = Array.from(document.querySelectorAll('.eph-note-title,.eph-note-paragraph'));
    const primaryInk = primaryElements.length === 0 ? 'rgb(0, 0, 0)' : getComputedStyle(primaryElements[0]!).color;
    if (primaryElements.some((element) => getComputedStyle(element).color !== 'rgb(0, 0, 0)')) failures.push('primary_ink_not_black');
    const fontsReady = document.fonts.status === 'loaded' && document.fonts.check(`500 ${bodyPx}px "Noto Serif SC"`, '便签') &&
      document.fonts.check(`500 ${englishPx}px "Cormorant Garamond"`, 'note');
    if (!fontsReady) failures.push('fonts_not_ready');
    const surface = getComputedStyle(document.querySelector('.pp-sheet')!).backgroundColor;
    if (surface !== 'rgb(255, 255, 255)') failures.push('paper_not_white');
    return {
      fits: failures.length === 0,
      failures,
      lineEnds: fragments.map((item) => item.lineEnds),
      fragments: fragments.map(({ boxFits: _boxFits, lineEnds: _lineEnds, ...item }) => item),
      titleTexts: Array.from(document.querySelectorAll('[data-author-title]')).map((element) => element.textContent ?? ''),
      signatureTexts: Array.from(document.querySelectorAll('[data-author-signature]')).map((element) => element.textContent ?? ''),
      surface,
      primaryInk,
    };
  }, { bodyPx: spec.bodyPx, titlePx: spec.titlePx, signaturePx: spec.signaturePx, englishPx: spec.englishPx });
}

function safeRequests(requests: RecordedRequest[]): unknown[] {
  return requests.map((request) => ({ path: new URL(request.url).pathname, method: request.method, status: request.status,
    failed: request.failed, blocked: request.blocked }));
}

export async function renderNote(request: NoteRenderRequest): Promise<NoteRenderOutcome> {
  const spec = noteSpecFor(request.layoutVariant);
  const paragraphs = deriveNoteParagraphs(request.body);
  const document: NoteDocument = {
    date: request.date,
    paragraphs: paragraphs.map((item) => item.text),
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.signature === undefined ? {} : { signature: request.signature }),
  };
  const assets = await loadFontAssets(request.fontsRoot);
  for (const [label, text] of [['body', request.body], ['title', request.title], ['signature', request.signature]] as const) {
    if (text !== undefined) assertGlyphCoverage(assets, text, 'noto500', `note ${label}`);
  }
  for (const value of ['便　签']) assertGlyphCoverage(assets, value, 'noto500', 'note template text');
  for (const value of ['a little note', request.date, '/']) assertGlyphCoverage(assets, value, 'cormorant500', 'note template text');

  try {
    return await withLockedPageSession(assets, async (session) => {
      const memo = new Map<string, NoteMeasure>();
      const measureCandidate = async (fragments: NoteFragment[], options: { pageIndex: number; final: boolean }): Promise<NoteMeasure> => {
        const key = JSON.stringify([fragments, options]);
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        await session.loadHtml(pageHtml(document, fragments, options.pageIndex, spec.maxPages, options.final, spec, request.branding));
        const geometry = await measure(session.page, spec);
        const structural = geometry.failures.filter((failure) =>
          ['sheet_geometry', 'fonts_not_ready', 'paper_not_white', 'body_typography', 'title_typography',
            'signature_typography', 'primary_ink_not_black'].includes(failure),
        );
        if (structural.length > 0) {
          throw new RenderError('render_failed', `note measurement environment failed (${structural.join(', ')})`);
        }
        const result = { fits: geometry.fits, lineEnds: geometry.lineEnds };
        memo.set(key, result);
        return result;
      };
      const pages = await paginateNote(document.paragraphs, measureCandidate, {
        maxPages: spec.maxPages,
        minLinesAtSplit: spec.minLinesAtSplit,
      });
      const rendered: Array<{ png: Buffer; gray4: Buffer; outcome: NotePageOutcome; verification: unknown }> = [];
      let served = 0;
      let titleCopies = 0;
      let signatureCopies = 0;
      for (let index = 0; index < pages.length; index += 1) {
        const final = index === pages.length - 1;
        const loaded = await session.loadHtml(pageHtml(document, pages[index]!, index, pages.length, final, spec, request.branding));
        served += loaded.fontFilesServed.length;
        const geometry = await measure(session.page, spec);
        if (!geometry.fits) throw new RenderError('render_failed', `note page ${index + 1} failed final geometry (${geometry.failures.slice(0, 3).join(', ')})`);
        const expected = pages[index]!;
        const actual = geometry.fragments.map(({ fontSize: _fontSize, lineHeight: _lineHeight, writingMode: _writingMode, ...item }) => item);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new RenderError('author_content_mismatch', 'rendered note fragments differ from the pagination plan');
        }
        titleCopies += geometry.titleTexts.length;
        signatureCopies += geometry.signatureTexts.length;
        if (geometry.titleTexts.some((text) => text !== request.title) || (geometry.titleTexts.length && index !== 0) ||
            geometry.signatureTexts.some((text) => text !== request.signature) || (geometry.signatureTexts.length && !final)) {
          throw new RenderError('author_content_mismatch', 'note title or signature moved or changed');
        }
        const png = await session.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
        const decoded = decodePngRgba(png);
        const converted = rgbaToGray4(decoded.rgba, decoded.width, decoded.height);
        if (converted.byteLength !== GRAY4_BYTE_LENGTH || converted.inkPixels === 0 || converted.distinctLevels.length < 2) {
          throw new RenderError('render_failed', 'rendered note page has invalid pixels');
        }
        const sourceRanges = expected.map((item) => {
          const source = paragraphs[item.paragraphIndex]!;
          const globalStart = source.startUtf16 + item.start;
          const globalEnd = source.startUtf16 + item.end;
          return {
            field: 'body' as const,
            startCodePoint: codePointsBefore(request.body, globalStart),
            endCodePoint: codePointsBefore(request.body, globalEnd),
            paragraphIndex: item.paragraphIndex,
            continuedBefore: item.continuedBefore,
            continuedAfter: item.continuedAfter,
          };
        });
        const pngName = `page-${String(index).padStart(3, '0')}.png`;
        const gray4Name = `page-${String(index).padStart(3, '0')}.gray4`;
        const outcome: NotePageOutcome = {
          index, pngName, gray4Name,
          png: { sha256: hash(png), bytes: png.length },
          gray4: { sha256: hash(converted.frame), bytes: converted.byteLength },
          sourceRanges,
          gray4Facts: { byteLength: converted.byteLength, inkPixels: converted.inkPixels, distinctLevels: converted.distinctLevels },
        };
        rendered.push({ png, gray4: converted.frame, outcome, verification: {
          page_index: index, final, geometry, source_ranges: sourceRanges, resources: safeRequests(loaded.requests),
          pixels: { png_sha256: outcome.png.sha256, gray4_sha256: outcome.gray4.sha256 },
        }});
      }
      if (titleCopies !== (request.title ? 1 : 0) || signatureCopies !== (request.signature ? 1 : 0)) {
        throw new RenderError('author_content_mismatch', 'note title/signature coverage is incomplete');
      }
      const reconstructed = paragraphs.map((item) => item.text + (item.separatorAfter?.text ?? '')).join('');
      if (reconstructed !== request.body) throw new RenderError('author_content_mismatch', 'note source reconstruction failed');

      const paper = {
        schemaVersion: 1,
        genre: 'note',
        layoutVariant: spec.version,
        date: request.date,
        body: request.body,
        paragraphs,
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.signature === undefined ? {} : { signature: request.signature }),
      };
      const editorialSpec = {
        ...spec,
        surface: 'device-white-v1',
        primaryInk: '#000000',
        rasterProfile: RENDER_PROFILE,
        pageCount: pages.length,
        pages: rendered.map(({ outcome }) => ({ pageIndex: outcome.index, sourceRanges: outcome.sourceRanges })),
        personalization: publicBrandingFacts(request.branding),
      };
      const provenance = {
        version: 2,
        encoding: 'unicode-code-points; end-exclusive',
        body: { field: 'body', start: 0, end: Array.from(request.body).length, sha256: hash(request.body) },
        paragraphs: paragraphs.map((item) => ({ index: item.index, textRange: { field: 'body', start: item.startCodePoint, end: item.endCodePoint },
          separatorAfter: item.separatorAfter === null ? null : { field: 'body', start: item.separatorAfter.startCodePoint, end: item.separatorAfter.endCodePoint } })),
        pages: rendered.map(({ outcome }) => ({ pageIndex: outcome.index, ranges: outcome.sourceRanges })),
        title: request.title === undefined ? null : { field: 'title', exact: true },
        signature: request.signature === undefined ? null : {
          field: 'signature', exact: true, pageIndex: pages.length - 1, source: request.signatureSource ?? 'author',
        },
      };
      const outputDir = await prepareOutputDir(request.outputPath);
      for (const item of rendered) {
        await writeArtifact(outputDir, item.outcome.pngName, item.png);
        await writeArtifact(outputDir, item.outcome.gray4Name, item.gray4);
        await writeArtifact(outputDir, `page-${String(item.outcome.index).padStart(3, '0')}.verification.json`, JSON.stringify(item.verification, null, 1));
      }
      const manifest = {
        manifest_version: 2,
        profile: RENDER_PROFILE,
        format: 'gray4', width: PAGE_WIDTH, height: PAGE_HEIGHT, stride_bytes: GRAY4_STRIDE_BYTES, byte_length: GRAY4_BYTE_LENGTH,
        renderer: { build: NOTE_RENDERER_BUILD, service_version: SERVICE_VERSION, manuscript_schema_version: 2, genre: 'note', layout: spec.version },
        toolchain: { node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: { revision: CHROMIUM_REVISION, version: session.chromiumVersion } },
        fonts: { manifest_version: assets.manifestVersion, file_count: assets.fontCount },
        conversion: { algorithm: GRAY4_ALGORITHM, version: GRAY4_ALGORITHM_VERSION, dithering: false },
        pages: rendered.map(({ outcome }) => ({ page_index: outcome.index,
          assets: { [outcome.pngName]: outcome.png, [outcome.gray4Name]: outcome.gray4 } })),
        source: { body_sha256: hash(request.body), reconstructed: true, title_copies: titleCopies, signature_copies: signatureCopies },
      };
      await writeArtifact(outputDir, 'render-manifest.json', JSON.stringify(manifest, null, 1));
      await writeArtifact(outputDir, 'verification.json', JSON.stringify({ paper, editorialSpec, provenance }, null, 1));
      return {
        ok: true, outputDir, profile: RENDER_PROFILE, genre: 'note' as const,
        pages: rendered.map(({ outcome }) => outcome), paper, editorialSpec, provenance,
        chromium: { version: session.chromiumVersion, revision: CHROMIUM_REVISION, playwright: PLAYWRIGHT_VERSION },
        fonts: { manifestVersion: assets.manifestVersion, count: assets.fontCount, served },
      };
    });
  } catch (error) {
    if (error instanceof NotePaginationError) throw new RenderError(error.code, error.message);
    throw error;
  }
}
