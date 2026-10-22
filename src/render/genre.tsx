import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ManuscriptV3 } from '../domain/manuscript.js';
import {
  applyEditorAdditions,
  contentTextSegments,
  contentToPaperFields,
  editorMascotMood,
  type EditorAddition,
} from '../domain/genre-content.js';
import { layoutForGenre, type ProductionGenreId } from '../production-catalog.js';
import {
  CHROMIUM_REVISION,
  GRAY4_ALGORITHM,
  GRAY4_ALGORITHM_VERSION,
  GRAY4_BYTE_LENGTH,
  GRAY4_STRIDE_BYTES,
  LANDSCAPE_GRAY4_STRIDE_BYTES,
  LANDSCAPE_PAGE_HEIGHT,
  LANDSCAPE_PAGE_WIDTH,
  LANDSCAPE_RENDER_PROFILE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PLAYWRIGHT_VERSION,
  RENDER_PROFILE,
  SERVICE_VERSION,
} from '../version.js';
import { withLockedPageSession, type LockedPageLoad } from './browser.js';
import { deviceLayoutCss } from './device-layout.js';
import { deviceSurfaceCss } from './device-surface.js';
import { RenderError } from './errors.js';
import { assertGlyphCoverage, loadFontAssets } from './fonts.js';
import { decodePngRgba, rgbaToGray4 } from './gray4.js';
import { effectiveMascotDataUrls, publicBrandingFacts, type RenderBranding } from './branding.js';
import { prepareOutputDir, writeArtifact } from './outputs.js';
import { BrandedPaperSheet, PAPER_CSS } from './original/EphemeraClient.js';
import type { Paper } from './original/ephemera-demo.js';
import type { AlmanacFacts } from '../facts/almanac.js';
import type { WeatherSnapshot } from '../weather/types.js';
import { weatherDayLabel, weatherTemperatureLabel } from '../weather/types.js';
import { weatherSnapshotIconData } from '../weather/icons.js';

export const GENRE_RENDERER_BUILD = 'original-genre-renderer/7';
const MAX_PAGES = 16;

const PRODUCTION_FONT_VARS = ':root{--font-cormorant:"Cormorant Garamond";--font-noto-serif-sc:"Noto Serif SC";--font-sans:Arial,sans-serif}';

type PageRole = 'main' | 'supplement';
interface PlannedPage {
  paper: Paper;
  role: PageRole;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  authoredFragments?: readonly string[];
}

export interface GenrePageOutcome {
  index: number;
  width: number;
  height: number;
  pngName: string;
  gray4Name: string;
  png: { sha256: string; bytes: number };
  gray4: { sha256: string; bytes: number };
  gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
  sourceRanges: Array<{ field: 'body'; startCodePoint: number; endCodePoint: number }>;
  partRole: PageRole;
}

export interface GenreRenderOutcome {
  ok: true;
  outputDir: string;
  profile: string;
  genre: ProductionGenreId;
  pages: GenrePageOutcome[];
  paper: unknown;
  editorialSpec: unknown;
  provenance: unknown;
  parts: Array<{ role: PageRole; genre: string; paper: unknown; editorialSpec: unknown; provenance: unknown }>;
  chromium: { version: string; revision: string; playwright: string };
  fonts: { manifestVersion: number; count: number; served: number };
}

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const codePointLength = (value: string): number => Array.from(value).length;

function chineseNumber(value: number): string {
  const digits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value]!;
  if (value === 10) return '十';
  if (value < 20) return `十${digits[value - 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones === 0 ? '' : digits[ones]}`;
}

interface CalendarDateFacts {
  year: number;
  month: number;
  day: number;
  dateCn: string;
  monthDayCn: string;
  weekday: string;
  weekdayEn: string;
  monthEn: string;
  parsed: Date;
}

function calendarDateFacts(date: string): CalendarDateFacts | undefined {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (matched === null) return undefined;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31 || Number.isNaN(parsed.valueOf())) {
    return undefined;
  }
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return undefined;
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekdaysEn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const monthsEn = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return {
    year, month, day, parsed,
    dateCn: `${chineseNumber(month)}月${chineseNumber(day)}日`,
    monthDayCn: `${chineseNumber(month)}月${chineseNumber(day)}`,
    weekday: weekdays[parsed.getUTCDay()]!,
    weekdayEn: weekdaysEn[parsed.getUTCDay()]!,
    monthEn: monthsEn[month - 1]!,
  };
}

function isoWeekNumber(date: Date): number {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday.valueOf() - yearStart.valueOf()) / 86_400_000) + 1) / 7);
}

function weekLabel(facts: CalendarDateFacts): string {
  const weekday = facts.parsed.getUTCDay() || 7;
  const monday = new Date(facts.parsed);
  monday.setUTCDate(monday.getUTCDate() - weekday + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const label = (value: Date): string => `${chineseNumber(value.getUTCMonth() + 1)}月${chineseNumber(value.getUTCDate())}日`;
  return `${label(monday)} – ${label(sunday)} · 第 ${isoWeekNumber(facts.parsed)} 周`;
}

interface PublicationDateContext {
  acceptedAt?: string;
  timezone?: string;
  weatherSnapshot?: WeatherSnapshot;
}

function publicationTime(context: PublicationDateContext): string | undefined {
  if (context.acceptedAt === undefined || context.timezone === undefined) return undefined;
  const instant = new Date(context.acceptedAt);
  if (Number.isNaN(instant.valueOf())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: context.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const hour = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;
    return hour === undefined || minute === undefined ? undefined : `${hour}:${minute}`;
  } catch {
    return undefined;
  }
}

/** System-owned publication-date fields, matched to the slots in the original paper components. */
export function publicationDatePaperFields(
  genre: ProductionGenreId,
  date: string,
  context: PublicationDateContext = {},
): Partial<Paper> {
  const facts = calendarDateFacts(date);
  if (facts === undefined) return {};
  switch (genre) {
    case 'wakepaper': return { dateCn: facts.dateCn, sub: `${facts.weekday} · 清晨` };
    case 'weekly-chart': return { week: weekLabel(facts) };
    case 'iou': return { dateCn: `${facts.dateCn} · ${facts.weekday}` };
    case 'emblem': return { dateCn: `${facts.dateCn} · ${facts.weekday}` };
    case 'poem': return { dateCn: `${facts.dateCn} · 夜` };
    case 'extra':
    case 'prescription':
    case 'customs': return { dateCn: facts.dateCn };
    case 'night-log':
    case 'checkup': return { dateCn: `${facts.dateCn} · ${facts.weekday}` };
    case 'starmap': {
      const time = publicationTime(context);
      const weather = context.weatherSnapshot?.days[0]?.date === date
        ? context.weatherSnapshot.current.description
        : undefined;
      const details = [facts.weekday, time, weather].filter((value): value is string => value !== undefined);
      return { dateCn: facts.dateCn, ...(details.length === 1 ? {} : { sub: details.join(' · ') }) };
    }
    case 'postcard': return { md: facts.monthDayCn };
    case 'boarding-pass': return { dateCn: `${facts.monthEn} ${facts.day} · ${facts.weekdayEn}` };
    case 'note':
    case 'weather':
    case 'almanac':
    case 'itinerary':
    case 'passport':
    case 'ticket-stub':
    case 'telegram':
    case 'omikuji':
    case 'programme': return {};
  }
}

function authoredPaper(
  manuscript: ManuscriptV3,
  genre: ProductionGenreId,
  date: string,
  editorAdditions: readonly EditorAddition[] = [],
  almanacFacts?: AlmanacFacts,
  weatherSnapshot?: WeatherSnapshot,
  acceptedAt?: string,
  timezone?: string,
): Paper {
  const effectiveContent = manuscript.content === undefined
    ? undefined
    : applyEditorAdditions(manuscript.content, editorAdditions);
  const authored = (manuscript.content === undefined
    ? manuscript.authorFields ?? {}
    : contentToPaperFields(effectiveContent!)) as unknown as Partial<Paper>;
  const paper: Paper = {
    ...authored,
    date,
    kind: genre,
    ...(manuscript.title === undefined ? {} : { title: manuscript.title }),
    ...(manuscript.subtitle === undefined ? {} : { sub: manuscript.subtitle }),
    ...((manuscript.bylines?.issuer ?? manuscript.signature) === undefined ? {} : { issuer: manuscript.bylines?.issuer ?? manuscript.signature }),
    ...(manuscript.bylines?.recipient === undefined ? {} : { recipient: manuscript.bylines.recipient }),
  };
  if (manuscript.content !== undefined) {
    const mascotMood = editorMascotMood(manuscript.content, editorAdditions);
    if (mascotMood !== undefined) paper.mascotMood = mascotMood;
  }
  const publicationDate = publicationDatePaperFields(genre, date, { acceptedAt, timezone, weatherSnapshot });
  if (publicationDate.dateCn !== undefined) paper.dateCn = publicationDate.dateCn;
  if (publicationDate.md !== undefined) paper.md = publicationDate.md;
  if (publicationDate.week !== undefined) paper.week = publicationDate.week;
  if (publicationDate.sub !== undefined) paper.sub ??= publicationDate.sub;
  if (genre === 'boarding-pass' && publicationDate.dateCn !== undefined) {
    paper.dateCn = publicationDate.dateCn;
  }
  if (genre === 'almanac') {
    if (almanacFacts === undefined || almanacFacts.date !== date) {
      throw new RenderError('render_failed', 'almanac facts are missing or belong to another date');
    }
    const shortDate = almanacFacts.lunar_date.short_label;
    const monthBoundary = shortDate.indexOf('月');
    const facts = calendarDateFacts(date);
    paper.dateCn = monthBoundary < 0 ? shortDate : shortDate.slice(monthBoundary + 1);
    paper.md = monthBoundary < 0
      ? facts?.weekday
      : `${shortDate.slice(0, monthBoundary + 1)}${facts === undefined ? '' : ` · ${facts.weekday}`}`;
    const lunarYear = /^农历(.+?年)/.exec(almanacFacts.lunar_date.label)?.[1] ?? `${almanacFacts.lunar_date.year}年`;
    paper.year = `农历${lunarYear} · ${almanacFacts.solar_term.current}`;
    paper.phase = almanacFacts.moon_phase.label;
    paper.term = almanacFacts.solar_term.occurs_today
      ? `${almanacFacts.solar_term.current} · 今日交节`
      : almanacFacts.solar_term.current;
  }
  if (genre === 'weather' && manuscript.content?.kind === 'weather') {
    if (weatherSnapshot === undefined || weatherSnapshot.days[0].date !== date) {
      throw new RenderError('render_failed', 'weather facts are missing or do not match the publication date');
    }
    paper.wxToday = {
      label: `今日 · ${weatherSnapshot.days[0].description}`,
      sky: weatherSnapshot.current.icon,
    };
    paper.wx = weatherSnapshot.days.map((day, index) => ({
      when: weatherDayLabel(index),
      en: day.date.slice(5),
      sky: day.icon,
      cond: day.description,
      sub: weatherTemperatureLabel(day.temperature_min_c, day.temperature_max_c),
    }));
  }
  if (manuscript.content !== undefined) return paper;

  // Compatibility path for already stored v3 body/authorFields manuscripts.
  // New author submissions use `content`, above, and never pass through these
  // generic projections.
  const body = manuscript.body;
  switch (genre) {
    case 'wakepaper': paper.night = body; break;
    case 'note': paper.paragraphs = [body]; paper.text = body; break;
    case 'weekly-chart': paper.caption = body; break;
    case 'weather': paper.night = body; break;
    case 'almanac': paper.oneline = body; break;
    case 'postcard': paper.text = body; break;
    case 'boarding-pass': paper.oneline = body; break;
    case 'itinerary':
      if (paper.legs?.length) paper.oneline = body;
      else paper.legs = [{ t: '', zh: body, en: '', x: '' }];
      break;
    case 'passport': paper.oneline = body; break;
    case 'customs': paper.night = body; break;
    case 'iou':
      if (paper.clauses?.length) paper.oneline = body;
      else paper.clauses = [{ k: '内容', v: body }];
      break;
    case 'ticket-stub':
      if (paper.clauses?.length) paper.oneline = body;
      else paper.clauses = [{ k: '内容', v: body }];
      break;
    case 'telegram': if (!paper.tg?.length) paper.tg = body.split(/\r\n|\r|\n/); break;
    case 'extra': paper.night = body; break;
    case 'prescription':
      if (paper.rx?.length) paper.oneline = body;
      else paper.rx = [{ d: body, sig: '' }];
      break;
    case 'checkup':
      paper.night = body;
      break;
    case 'night-log':
      if (paper.log?.length) paper.night = body;
      else paper.log = [{ t: '', e: body, tag: '' }];
      break;
    case 'starmap': paper.night = body; break;
    case 'poem': paper.poem = [...(paper.poem ?? []), ...body.split(/\r\n|\r|\n/)]; break;
    case 'omikuji': paper.text = body; break;
    case 'emblem': paper.night = body; break;
    case 'programme':
      if (paper.prog?.length) paper.oneline = body;
      else paper.prog = [{ t: '', zh: body, en: '', x: '' }];
      break;
  }
  return paper;
}

function pageHtml(
  paper: Paper,
  branding?: RenderBranding,
  pageIndex?: number,
  pageCount?: number,
  weatherIcons?: { current: string; days: readonly string[] },
  landscape = false,
): string {
  const width = landscape ? LANDSCAPE_PAGE_WIDTH : PAGE_WIDTH;
  const showFolio = pageIndex !== undefined && pageCount !== undefined && pageCount > 1;
  const paperBranding = {
    ...(branding?.primaryLogoDataUrl === undefined ? {} : { primaryLogoDataUrl: branding.primaryLogoDataUrl }),
    ...(branding?.secondaryLogoDataUrl === undefined ? {} : { secondaryLogoDataUrl: branding.secondaryLogoDataUrl }),
    mascotDataUrls: effectiveMascotDataUrls(branding),
  };
  const markup = renderToStaticMarkup(<div className={showFolio ? 'pp-root eph-has-publication-folio' : 'pp-root'}><main className="pp-feed"><BrandedPaperSheet paper={paper}
    branding={paperBranding} weatherIconDataUrls={weatherIcons}/></main>{showFolio ? <div className="eph-publication-folio">{pageIndex + 1} / {pageCount}</div> : null}</div>);
  return [
    '<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=${width},initial-scale=1">`,
    '<title>ephemera paper</title><link rel="stylesheet" href="/fonts/fonts.css">',
    `<style>${PRODUCTION_FONT_VARS}\n${PAPER_CSS}\n${deviceSurfaceCss(landscape)}\n${deviceLayoutCss(landscape)}\n` +
      '.eph-inline-mark,.eph-inline-fox{flex:none}.eph-pc-bud,.eph-stub-rose{width:28px;height:28px;fill:currentColor}' +
      '.eph-publication-folio{position:absolute;z-index:20;right:36px;bottom:13px;font:600 16px/1 "Cormorant Garamond",serif;letter-spacing:.12em;color:#111}' +
      '.eph-has-publication-folio .eph-note-folio{display:none}</style>',
    `</head><body>${markup}</body></html>`,
  ].join('\n');
}

interface Geometry {
  fits: boolean;
  failures: string[];
  text: string;
  wakepaper?: { mastheadRuleCount: number; footerBottomGap: number | null };
  emblem?: { logoCount: number; footerCount: number };
}
async function measure(page: import('playwright-core').Page, width: number, height: number): Promise<Geometry> {
  return page.evaluate(({ width, height }) => {
    const failures: string[] = [];
    const root = document.querySelector('.pp-root')?.getBoundingClientRect();
    const sheet = document.querySelector('.pp-sheet')?.getBoundingClientRect();
    const scrolling = document.scrollingElement ?? document.documentElement;
    if (root === undefined || sheet === undefined) failures.push('paper_missing');
    else if (Math.abs(sheet.x) > .5 || Math.abs(sheet.y) > .5 || Math.abs(sheet.width - width) > .5) failures.push('sheet_geometry');
    if (scrolling.scrollWidth > width || scrolling.scrollHeight > height) failures.push('document_overflow');
    const poemStage = document.querySelector('.eph-poem-stage')?.getBoundingClientRect();
    if (poemStage !== undefined) {
      const footerTop = document.querySelector('.eph-poem-sign')?.getBoundingClientRect().top ?? height;
      const bottom = Math.min(poemStage.bottom, footerTop, height);
      for (const [index, column] of Array.from(document.querySelectorAll('.eph-poem-col')).entries()) {
        const box = column.getBoundingClientRect();
        // Column width also counts intentionally empty authored lines. Check
        // text ranges vertically: flex alignment stretches every column box
        // to the longest line, which would otherwise blame unrelated lines.
        if (box.left < poemStage.left - .5 || box.right > poemStage.right + .5) {
          failures.push(`poem_columns_overflow:${index + 1}`);
        }
        const range = document.createRange();
        range.selectNodeContents(column);
        if (Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0 &&
          (rect.top < poemStage.top - .5 || rect.bottom > bottom + .5))) {
          failures.push(`poem_line_overflow:${index + 1}`);
        }
      }
    }
    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = textNodes.nextNode())) {
      if (!(node.textContent ?? '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.left < -.5 || rect.top < -.5 || rect.right > width + .5 || rect.bottom > height + .5) {
          failures.push('text_outside_page');
          break;
        }
      }
      if (failures.at(-1) === 'text_outside_page') break;
    }
    if (document.fonts.status !== 'loaded') failures.push('fonts_not_ready');
    const bodyFont = getComputedStyle(document.querySelector('.eph-body') ?? document.body).fontFamily;
    if (!bodyFont.includes('Noto Serif SC')) failures.push('noto_serif_not_bound');
    const latin = document.querySelector('.mh-kicker,.rseg-n,.rseg-en');
    if (latin !== null && !getComputedStyle(latin).fontFamily.includes('Cormorant Garamond')) {
      failures.push('cormorant_not_bound');
    }
    const surface = getComputedStyle(document.querySelector('.pp-sheet') ?? document.body).backgroundColor;
    if (surface !== 'rgb(255, 255, 255)') failures.push('paper_not_white');
    const customsHeader = document.querySelector('.eph-cust-hrow');
    if (customsHeader !== null) {
      for (const cell of Array.from(customsHeader.children)) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const lines = new Set(Array.from(range.getClientRects()).filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
        if (lines.size > 1 || cell.scrollWidth > cell.clientWidth + 1) {
          failures.push(`customs_header_wrap:${cell.textContent?.trim()}:${cell.scrollWidth}/${cell.clientWidth}:${lines.size}:font=${getComputedStyle(cell).fontSize}/${getComputedStyle(customsHeader).fontSize}`);
        }
      }
    }
    const passportGrid = document.querySelector('.eph-pass-grid');
    if (passportGrid !== null && getComputedStyle(passportGrid).gridTemplateColumns.trim().split(/\s+/).length !== 3) {
      failures.push('passport_grid_columns');
    }
    const wakepaper = document.querySelector('.eph-wake');
    const wakeFooter = document.querySelector('.eph-wake-footer')?.getBoundingClientRect();
    const emblem = document.querySelector('.eph-crest-body');
    return {
      fits: failures.length === 0,
      failures,
      text: document.body.textContent ?? '',
      ...(wakepaper === null ? {} : {
        wakepaper: {
          mastheadRuleCount: wakepaper.querySelectorAll('.mh-rule').length,
          footerBottomGap: wakeFooter === undefined ? null : height - wakeFooter.bottom,
        },
      }),
      ...(emblem === null ? {} : {
        emblem: {
          logoCount: emblem.querySelectorAll('.eph-crest-ins').length,
          footerCount: emblem.querySelectorAll(':scope > .eph-sign').length,
        },
      }),
    };
  }, { width, height });
}

function withBody(paper: Paper, genre: ProductionGenreId, body: string, supplement = false): Paper {
  const next: Paper = { ...paper };
  if (supplement) {
    return { date: paper.date, kind: 'note', title: '醒来纸 · 附刊', paragraphs: [body], text: body, issuer: paper.issuer };
  }
  switch (genre) {
    case 'wakepaper': case 'weather': case 'extra': case 'starmap': case 'emblem': next.night = body; break;
    case 'note': next.paragraphs = [body]; next.text = body; break;
    case 'weekly-chart': next.caption = body; break;
    case 'almanac': case 'boarding-pass': case 'passport': next.oneline = body; break;
    case 'postcard': case 'omikuji': next.text = body; break;
    case 'telegram': next.tg = body.split(/\r\n|\r|\n/); break;
    case 'poem': next.poem = body.split(/\r\n|\r|\n/); break;
    default: break;
  }
  return next;
}

async function largestFittingPrefix(
  body: string,
  minimum: number,
  fits: (candidate: string) => Promise<boolean>,
): Promise<number> {
  const scalars = Array.from(body);
  let low = minimum;
  let high = scalars.length;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (await fits(scalars.slice(0, mid).join(''))) { best = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return best;
}

type WakeSection = 'night' | 'pins' | 'oneLine';
type WakeFlowUnit =
  | { kind: 'heading'; section: WakeSection; start: number; end: number }
  | { kind: 'text'; section: WakeSection; field: 'night' | 'night2' | 'oneline'; chars: string[];
      start: number; end: number; primaryStart?: number }
  | { kind: 'pin'; section: 'pins'; time: string; chars: string[]; start: number; end: number };

interface WakeFlow { units: WakeFlowUnit[]; total: number; bodyLength: number }

function buildWakeFlow(base: Paper, body: string): WakeFlow {
  const units: WakeFlowUnit[] = [];
  let cursor = 0;
  const heading = (section: WakeSection) => {
    units.push({ kind: 'heading', section, start: cursor, end: cursor + 1 });
    cursor += 1;
  };
  const text = (section: WakeSection, field: 'night' | 'night2' | 'oneline', value: string | undefined,
    primaryStart?: number) => {
    if (value === undefined || value.length === 0) return;
    const chars = Array.from(value);
    units.push({ kind: 'text', section, field, chars, start: cursor, end: cursor + chars.length,
      ...(primaryStart === undefined ? {} : { primaryStart }) });
    cursor += chars.length;
  };

  heading('night');
  text('night', 'night', base.night, 0);
  text('night', 'night2', base.night2);
  heading('pins');
  for (const pin of base.pins ?? []) {
    const chars = Array.from(pin.v);
    const length = Math.max(1, chars.length);
    units.push({ kind: 'pin', section: 'pins', time: pin.t, chars, start: cursor, end: cursor + length });
    cursor += length;
  }
  heading('oneLine');
  text('oneLine', 'oneline', base.oneline);
  return { units, total: cursor, bodyLength: codePointLength(body) };
}

function wakeUnitAt(flow: WakeFlow, token: number): WakeFlowUnit | undefined {
  return flow.units.find((unit) => token >= unit.start && token < unit.end);
}

function trimTrailingWakeHeadings(flow: WakeFlow, pageStart: number, candidateEnd: number): number {
  let end = candidateEnd;
  while (end > pageStart) {
    const unit = wakeUnitAt(flow, end - 1);
    if (unit?.kind !== 'heading' || end !== unit.end) break;
    end = unit.start;
  }
  return end;
}

function wakeBreakEndsWithHeading(flow: WakeFlow, pageStart: number, candidateEnd: number): boolean {
  if (candidateEnd <= pageStart) return false;
  const unit = wakeUnitAt(flow, candidateEnd - 1);
  return unit?.kind === 'heading' && candidateEnd === unit.end;
}

function wakePaperForRange(base: Paper, flow: WakeFlow, start: number, end: number, final: boolean): PlannedPage {
  const paper: Paper = {
    ...base,
    night: undefined,
    night2: undefined,
    pins: undefined,
    oneline: undefined,
    wakePage: { showNightHeading: false, showPinsHeading: false, showOneLineHeading: false, final },
  };
  const pins: NonNullable<Paper['pins']> = [];
  const authoredFragments: string[] = [];
  const primaryChunks: string[] = [];
  let sourceStart: number | undefined;
  let sourceEnd: number | undefined;

  for (const unit of flow.units) {
    const intersectionStart = Math.max(start, unit.start);
    const intersectionEnd = Math.min(end, unit.end);
    if (intersectionStart >= intersectionEnd) continue;
    if (unit.kind === 'heading') {
      if (unit.section === 'night') paper.wakePage!.showNightHeading = true;
      else if (unit.section === 'pins') paper.wakePage!.showPinsHeading = true;
      else paper.wakePage!.showOneLineHeading = true;
      continue;
    }

    const localStart = intersectionStart - unit.start;
    const localEnd = intersectionEnd - unit.start;
    const fragment = unit.chars.slice(localStart, localEnd).join('');
    if (unit.kind === 'pin') {
      const time = localStart === 0 ? unit.time : '';
      pins.push({ t: time, v: fragment });
      if (time.length > 0) authoredFragments.push(time);
      if (fragment.length > 0) authoredFragments.push(fragment);
      continue;
    }

    paper[unit.field] = fragment;
    if (fragment.length > 0) authoredFragments.push(fragment);
    if (unit.primaryStart !== undefined) {
      const fragmentStart = unit.primaryStart + localStart;
      const fragmentEnd = unit.primaryStart + localEnd;
      sourceStart ??= fragmentStart;
      sourceEnd = fragmentEnd;
      primaryChunks.push(fragment);
    }
  }
  if (pins.length > 0) paper.pins = pins;
  return {
    paper,
    role: start === 0 ? 'main' : 'supplement',
    sourceStart: sourceStart ?? flow.bodyLength,
    sourceEnd: sourceEnd ?? flow.bodyLength,
    sourceText: primaryChunks.join(''),
    authoredFragments,
  };
}

async function planWakepaperPages(
  base: Paper,
  body: string,
  fits: (paper: Paper) => Promise<boolean>,
): Promise<PlannedPage[]> {
  const flow = buildWakeFlow(base, body);
  const pages: PlannedPage[] = [];
  let start = 0;
  while (start < flow.total) {
    if (pages.length >= MAX_PAGES) throw new RenderError('render_overflow', 'paper needs more than 16 pages');
    const finalPage = wakePaperForRange(base, flow, start, flow.total, true);
    if (await fits(finalPage.paper)) {
      pages.push(finalPage);
      break;
    }

    let low = start + 1;
    let high = flow.total - 1;
    let best = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = wakePaperForRange(base, flow, start, mid, false);
      if (await fits(candidate.paper)) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const maximumEnd = trimTrailingWakeHeadings(flow, start, best);
    if (best < 0 || maximumEnd <= start) {
      throw new RenderError('render_overflow', 'one authored wakepaper fragment cannot fit the selected paper');
    }

    // When the remaining flow can become the final signed sheet, keep as much
    // authored content there as possible instead of leaving a nearly blank
    // last page containing only punctuation and the footer.
    let finalLow = start + 1;
    let finalHigh = maximumEnd;
    let balancedEnd = -1;
    while (finalLow <= finalHigh) {
      const mid = Math.floor((finalLow + finalHigh) / 2);
      const remainingFinal = wakePaperForRange(base, flow, mid, flow.total, true);
      if (await fits(remainingFinal.paper)) {
        balancedEnd = mid;
        finalHigh = mid - 1;
      } else {
        finalLow = mid + 1;
      }
    }
    if (balancedEnd >= 0) {
      while (balancedEnd <= maximumEnd && wakeBreakEndsWithHeading(flow, start, balancedEnd)) balancedEnd += 1;
      if (balancedEnd > maximumEnd || !(await fits(wakePaperForRange(base, flow, balancedEnd, flow.total, true).paper))) {
        balancedEnd = -1;
      }
    }
    const end = balancedEnd >= 0 ? balancedEnd : maximumEnd;
    pages.push(wakePaperForRange(base, flow, start, end, false));
    start = end;
  }
  return pages;
}

function emblemPaperForPage(base: Paper, body: string, first: boolean, final: boolean): Paper {
  return { ...withBody(base, 'emblem', body), emblemPage: { showLogo: first, final } };
}

async function planEmblemPages(
  base: Paper,
  body: string,
  fits: (paper: Paper) => Promise<boolean>,
): Promise<PlannedPage[]> {
  const scalars = Array.from(body);
  const pages: PlannedPage[] = [];
  let sourceStart = 0;
  while (sourceStart < scalars.length) {
    if (pages.length >= MAX_PAGES) throw new RenderError('render_overflow', 'paper needs more than 16 pages');
    const first = pages.length === 0;
    const remaining = scalars.slice(sourceStart).join('');
    const finalPaper = emblemPaperForPage(base, remaining, first, true);
    if (await fits(finalPaper)) {
      pages.push({ paper: finalPaper, role: 'main', sourceStart, sourceEnd: scalars.length, sourceText: remaining });
      break;
    }
    const count = await largestFittingPrefix(remaining, 1, async (candidate) =>
      fits(emblemPaperForPage(base, candidate, first, false)));
    if (count < 1) throw new RenderError('render_overflow', 'one authored emblem character cannot fit the selected paper');
    const sourceEnd = sourceStart + count;
    const chunk = scalars.slice(sourceStart, sourceEnd).join('');
    pages.push({ paper: emblemPaperForPage(base, chunk, first, false), role: 'main', sourceStart, sourceEnd, sourceText: chunk });
    sourceStart = sourceEnd;
  }
  return pages;
}

const ARRAY_GENRES: Partial<Record<ProductionGenreId, { field: keyof Paper; pageSize: number }>> = {
  itinerary: { field: 'legs', pageSize: 4 }, passport: { field: 'stamps', pageSize: 4 },
  customs: { field: 'customs', pageSize: 4 }, 'night-log': { field: 'log', pageSize: 5 },
  programme: { field: 'prog', pageSize: 3 },
};

function fixedArrayPages(base: Paper, genre: ProductionGenreId, body: string): PlannedPage[] | null {
  const config = ARRAY_GENRES[genre];
  if (config === undefined) return null;
  const values = base[config.field];
  if (!Array.isArray(values) || values.length === 0) {
    return [{ paper: base, role: 'main', sourceStart: 0, sourceEnd: codePointLength(body), sourceText: body }];
  }
  const pages: PlannedPage[] = [];
  for (let start = 0; start < values.length; start += config.pageSize) {
    const paper = { ...base, [config.field]: values.slice(start, start + config.pageSize) } as Paper;
    if (start > 0) {
      paper.oneline = undefined;
      paper.night = undefined;
    }
    const final = start + config.pageSize >= values.length;
    if (genre === 'passport') {
      paper.passportPage = { final, stampOffset: start };
      paper.oneline = final ? base.oneline : undefined;
    }
    if (genre === 'customs') {
      paper.customsPage = { final };
      paper.night = final ? base.night : undefined;
    }
    pages.push({ paper, role: 'main', sourceStart: start === 0 ? 0 : codePointLength(body),
      sourceEnd: codePointLength(body), sourceText: start === 0 ? body : '' });
  }
  return pages;
}

function requestsForEvidence(loaded: LockedPageLoad): unknown[] {
  return loaded.requests.map((request) => ({ path: new URL(request.url).pathname, method: request.method,
    status: request.status, failed: request.failed, blocked: request.blocked }));
}

export async function renderGenre(request: {
  manuscript: ManuscriptV3; genre: Exclude<ProductionGenreId, 'note'>; date: string; outputPath: string; fontsRoot?: string;
  acceptedAt?: string;
  timezone?: string;
  branding?: RenderBranding;
  editorAdditions?: readonly EditorAddition[];
  almanacFacts?: AlmanacFacts;
  weatherSnapshot?: WeatherSnapshot;
}): Promise<GenreRenderOutcome> {
  const { manuscript, genre } = request;
  const layout = layoutForGenre(genre, manuscript.layoutVariant);
  const landscape = layout.orientation === 'landscape';
  const pageWidth = landscape ? LANDSCAPE_PAGE_WIDTH : PAGE_WIDTH;
  const pageHeight = landscape ? LANDSCAPE_PAGE_HEIGHT : PAGE_HEIGHT;
  const strideBytes = landscape ? LANDSCAPE_GRAY4_STRIDE_BYTES : GRAY4_STRIDE_BYTES;
  const renderProfile = landscape ? LANDSCAPE_RENDER_PROFILE : RENDER_PROFILE;
  const editorAdditions = request.editorAdditions ?? [];
  const base = authoredPaper(
    manuscript,
    genre,
    request.date,
    editorAdditions,
    request.almanacFacts,
    request.weatherSnapshot,
    request.acceptedAt,
    request.timezone,
  );
  const weatherIcons = request.weatherSnapshot === undefined ? undefined : weatherSnapshotIconData(request.weatherSnapshot);
  const assets = await loadFontAssets(request.fontsRoot);
  for (const [label, value] of [['body', manuscript.body], ['title', manuscript.title], ['subtitle', manuscript.subtitle], ['signature', manuscript.signature]] as const) {
    if (value !== undefined) assertGlyphCoverage(assets, value, 'noto500', `${genre} ${label}`);
  }

  return withLockedPageSession(assets, async (session) => {
    const geometryFor = async (paper: Paper, pageIndex?: number, pageCount?: number): Promise<{ geometry: Geometry; loaded: LockedPageLoad }> => {
      const loaded = await session.loadHtml(pageHtml(paper, request.branding, pageIndex, pageCount, weatherIcons, landscape));
      const geometry = await measure(session.page, pageWidth, pageHeight);
      const structural = geometry.failures.filter((failure) => failure !== 'document_overflow' && failure !== 'text_outside_page' &&
        !failure.startsWith('poem_line_overflow:') && !failure.startsWith('poem_columns_overflow:'));
      if (structural.length) throw new RenderError('render_failed', `paper environment failed (${structural.join(', ')})`);
      return { geometry, loaded };
    };

    let plan = genre === 'wakepaper'
      ? await planWakepaperPages(base, manuscript.body, async (paper) => (await geometryFor(paper)).geometry.fits)
      : genre === 'emblem'
        ? await planEmblemPages(base, manuscript.body, async (paper) => (await geometryFor(paper)).geometry.fits)
        : fixedArrayPages(base, genre, manuscript.body);
    if (plan === null && (layout.pagination === 'paged' || layout.pagination === 'supplement')) {
      const pages: PlannedPage[] = [];
      let remaining = manuscript.body;
      let sourceStart = 0;
      let first = true;
      while (remaining.length > 0) {
        if (pages.length >= MAX_PAGES) throw new RenderError('render_overflow', 'paper needs more than 16 pages');
        const supplement = genre === 'wakepaper' && !first;
        const count = await largestFittingPrefix(remaining, 1, async (candidate) =>
          (await geometryFor(withBody(base, genre, candidate, supplement))).geometry.fits);
        if (count < 1) throw new RenderError('render_overflow', 'one authored character cannot fit the selected paper');
        const scalars = Array.from(remaining);
        const chunk = scalars.slice(0, count).join('');
        const sourceEnd = sourceStart + count;
        pages.push({ paper: withBody(base, genre, chunk, supplement), role: supplement ? 'supplement' : 'main',
          sourceStart, sourceEnd, sourceText: chunk });
        remaining = scalars.slice(count).join('');
        sourceStart = sourceEnd;
        first = false;
      }
      plan = pages;
    }
    if (plan === null) {
      plan = [{ paper: base, role: 'main', sourceStart: 0, sourceEnd: codePointLength(manuscript.body), sourceText: manuscript.body }];
    }
    if (plan.length > MAX_PAGES) throw new RenderError('render_overflow', 'paper needs more than 16 pages');

    const rendered: Array<{ png: Buffer; gray4: Buffer; outcome: GenrePageOutcome; verification: unknown; renderedText: string }> = [];
    let served = 0;
    for (let index = 0; index < plan.length; index += 1) {
      const planned = plan[index]!;
      const { geometry, loaded } = await geometryFor(planned.paper, index, plan.length);
      served += loaded.fontFilesServed.length;
      if (!geometry.fits) {
        const longLine = geometry.failures.find((failure) => failure.startsWith('poem_line_overflow:'));
        if (longLine !== undefined) {
          throw new RenderError('render_overflow',
            `诗稿第 ${longLine.split(':')[1]} 行的句长超出当前版式的可用区域。请在合适的位置加换行，或选择能容纳该句的版式；原文未被删改。`);
        }
        const excessColumn = geometry.failures.find((failure) => failure.startsWith('poem_columns_overflow:'));
        if (excessColumn !== undefined) {
          throw new RenderError('render_overflow',
            `诗稿第 ${excessColumn.split(':')[1]} 行超出当前版式能容纳的诗行范围。请选择能容纳更多诗行的版式；原文未被删改。`);
        }
        throw new RenderError('render_overflow', `${genre} page ${index + 1} does not fit`);
      }
      if (planned.sourceText.length > 0) {
        const structuredPagedBody = manuscript.content !== undefined && (genre === 'wakepaper' || genre === 'emblem');
        const pieces = manuscript.content === undefined && (genre === 'poem' || genre === 'telegram')
          ? planned.sourceText.split(/\r\n|\r|\n/).filter((piece) => piece.length > 0)
          : manuscript.content === undefined || structuredPagedBody ? [planned.sourceText] : [];
        if (pieces.some((piece) => !geometry.text.includes(piece))) {
          throw new RenderError('author_content_mismatch', 'rendered paper does not contain the authored body');
        }
      }
      if (planned.authoredFragments?.some((fragment) => fragment.length > 0 && !geometry.text.includes(fragment))) {
        throw new RenderError('author_content_mismatch', 'rendered wakepaper does not contain every planned authored fragment');
      }
      const png = await session.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
      const decoded = decodePngRgba(png, pageWidth, pageHeight);
      const converted = rgbaToGray4(decoded.rgba, decoded.width, decoded.height);
      if (converted.byteLength !== GRAY4_BYTE_LENGTH || converted.inkPixels === 0 || converted.distinctLevels.length < 2) {
        throw new RenderError('render_failed', 'rendered paper has invalid pixels');
      }
      const pngName = `page-${String(index).padStart(3, '0')}.png`;
      const gray4Name = `page-${String(index).padStart(3, '0')}.gray4`;
      const outcome: GenrePageOutcome = {
        index, width: pageWidth, height: pageHeight, pngName, gray4Name,
        png: { sha256: hash(png), bytes: png.length },
        gray4: { sha256: hash(converted.frame), bytes: converted.byteLength },
        gray4Facts: { byteLength: converted.byteLength, inkPixels: converted.inkPixels, distinctLevels: converted.distinctLevels },
        sourceRanges: planned.sourceText.length === 0 ? [] : [{ field: 'body', startCodePoint: planned.sourceStart, endCodePoint: planned.sourceEnd }],
        partRole: planned.role,
      };
      rendered.push({ png, gray4: converted.frame, outcome, renderedText: geometry.text, verification: {
        page_index: index, part_role: planned.role, geometry, source_ranges: outcome.sourceRanges,
        resources: requestsForEvidence(loaded), pixels: { png_sha256: outcome.png.sha256, gray4_sha256: outcome.gray4.sha256 },
      }});
    }

    if (manuscript.content !== undefined) {
      const editorTextAdditions = editorAdditions.filter((addition) => !addition.path.startsWith('presentation.'));
      const finalText = rendered.map((item) => item.renderedText).join('\n');
      const contentSegments = contentTextSegments(manuscript.content);
      const splitWakepaperFlow = plan.length > 1 && genre === 'wakepaper';
      const splitStructuredPrimary = plan.length > 1 && genre === 'emblem';
      const authoredSegments = [
        ...(splitWakepaperFlow ? [] : splitStructuredPrimary ? contentSegments.slice(1) : contentSegments),
        manuscript.title,
        manuscript.subtitle,
        manuscript.signature,
        manuscript.bylines?.issuer,
        manuscript.bylines?.recipient,
      ].filter((segment): segment is string => segment !== undefined && segment.length > 0);
      const missing = authoredSegments.filter((segment) => !finalText.includes(segment));
      if (missing.length > 0) {
        throw new RenderError('author_content_mismatch', 'rendered paper does not contain every authored structured field');
      }
      if (!splitWakepaperFlow && editorTextAdditions.some((addition) => !finalText.includes(addition.value))) {
        throw new RenderError('render_failed', 'rendered paper does not contain every accepted editor addition');
      }
    }

    const mainPages = rendered.filter((item) => item.outcome.partRole === 'main');
    const supplementPages = rendered.filter((item) => item.outcome.partRole === 'supplement');
    const makeProvenance = (rows: typeof rendered) => ({
      version: 3, encoding: 'unicode-code-points; end-exclusive',
      body: { field: 'body', start: rows.at(0)?.outcome.sourceRanges.at(0)?.startCodePoint ?? 0,
        end: rows.at(-1)?.outcome.sourceRanges.at(-1)?.endCodePoint ?? 0, sha256: hash(manuscript.body) },
      pages: rows.map((item) => ({ pageIndex: item.outcome.index, ranges: item.outcome.sourceRanges })),
      ...(manuscript.content === undefined ? {} : {
        structured_content: { source: 'author', sha256: hash(JSON.stringify(manuscript.content)), fields: contentTextSegments(manuscript.content) },
      }),
      ...(editorAdditions.length === 0 ? {} : {
        editor: { source: 'editor', additions: editorAdditions.map((addition) => ({ ...addition })) },
      }),
      ...(request.almanacFacts === undefined ? {} : {
        system_facts: { source: 'system', almanac: request.almanacFacts },
      }),
      ...(request.weatherSnapshot === undefined ? {} : {
        weather_facts: { source: 'system', snapshot: request.weatherSnapshot },
      }),
    });
    const editorialSpec = {
      version: 3, genre, layout: layout.id, surface: 'device-white-v1', primaryInk: '#000000',
      rasterProfile: renderProfile, orientation: layout.orientation, pagination: layout.pagination, pageCount: rendered.length,
      pages: rendered.map((item) => ({ pageIndex: item.outcome.index, partRole: item.outcome.partRole, sourceRanges: item.outcome.sourceRanges })),
      personalization: publicBrandingFacts(request.branding),
      ...(request.almanacFacts === undefined ? {} : { almanacFacts: request.almanacFacts }),
      ...(request.weatherSnapshot === undefined ? {} : { weatherSnapshot: request.weatherSnapshot }),
    };
    const parts: GenreRenderOutcome['parts'] = [{
      role: 'main', genre, paper: { ...base, body: manuscript.body }, editorialSpec,
      provenance: makeProvenance(mainPages),
    }];
    if (supplementPages.length > 0) {
      parts.push({ role: 'supplement', genre: 'wakepaper', paper: { ...base, body: manuscript.body },
        editorialSpec: { ...editorialSpec, genre: 'wakepaper', layout: layout.id, pageCount: supplementPages.length },
        provenance: makeProvenance(supplementPages) });
    }

    const outputDir = await prepareOutputDir(request.outputPath);
    for (const item of rendered) {
      await writeArtifact(outputDir, item.outcome.pngName, item.png);
      await writeArtifact(outputDir, item.outcome.gray4Name, item.gray4);
      await writeArtifact(outputDir, `page-${String(item.outcome.index).padStart(3, '0')}.verification.json`, JSON.stringify(item.verification, null, 1));
    }
    const manifest = {
      manifest_version: 3, profile: renderProfile, format: 'gray4', width: pageWidth, height: pageHeight,
      stride_bytes: strideBytes, byte_length: GRAY4_BYTE_LENGTH,
      renderer: { build: GENRE_RENDERER_BUILD, service_version: SERVICE_VERSION, manuscript_schema_version: 3, genre, layout: layout.id },
      toolchain: { node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: { revision: CHROMIUM_REVISION, version: session.chromiumVersion } },
      fonts: { manifest_version: assets.manifestVersion, file_count: assets.fontCount },
      conversion: { algorithm: GRAY4_ALGORITHM, version: GRAY4_ALGORITHM_VERSION, dithering: false },
      pages: rendered.map(({ outcome }) => ({ page_index: outcome.index, part_role: outcome.partRole,
        assets: { [outcome.pngName]: outcome.png, [outcome.gray4Name]: outcome.gray4 } })),
      source: { body_sha256: hash(manuscript.body), covered_code_points: rendered.flatMap((item) => item.outcome.sourceRanges) },
    };
    await writeArtifact(outputDir, 'render-manifest.json', JSON.stringify(manifest, null, 1));
    await writeArtifact(outputDir, 'verification.json', JSON.stringify({ paper: base, editorialSpec, parts }, null, 1));
    return {
      ok: true, outputDir, profile: renderProfile, genre, pages: rendered.map((item) => item.outcome),
      paper: base, editorialSpec, provenance: { version: 3, body: { field: 'body', start: 0, end: codePointLength(manuscript.body), sha256: hash(manuscript.body) } },
      parts, chromium: { version: session.chromiumVersion, revision: CHROMIUM_REVISION, playwright: PLAYWRIGHT_VERSION },
      fonts: { manifestVersion: assets.manifestVersion, count: assets.fontCount, served },
    };
  }, { width: pageWidth, height: pageHeight });
}
