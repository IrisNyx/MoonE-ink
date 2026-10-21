/**
 * Production renderer adapter (MCP-03b): maps the immutable domain manuscript
 * to the MCP-02 RendererManuscriptV1 and runs the real postcard pipeline into
 * a per-lease scratch directory.
 *
 * The fixed mapping (task card): schema_version=1; genre = genrePreference or
 * the only accepted `postcard`; intent/body verbatim; effective title/subtitle
 * from the author's explicit authorization when present (otherwise the
 * original fields); tone verbatim when present (the renderer records
 * template-default=cream otherwise). delivery, protectedText and
 * titleAdaptation never reach the template as visible content.
 *
 * The postcard paper has no title/subtitle slot: a non-empty effective
 * title/subtitle fails here with the stable `unsupported_content_slot` before
 * any browser launches — titles are a protocol-safe boundary, not something
 * to drop silently.
 */

import { RenderError } from '../render/errors.js';
import { renderPostcard, type RenderOutcome } from '../render/render.js';
import { NOTE_RENDERER_BUILD, renderNote } from '../render/note.js';
import { GENRE_RENDERER_BUILD, renderGenre } from '../render/genre.js';
import { signatureForGenre, type RenderBranding } from '../render/branding.js';
import type { EditorAddition } from '../domain/genre-content.js';
import { almanacFactsForDate } from '../facts/almanac.js';
import type { WeatherSnapshot } from '../weather/types.js';
import { countScalars, TONES, type RendererManuscriptV1, type Tone } from '../render/manuscript.js';
import { effectiveSubtitle, effectiveTitle, selectedGenre, type Manuscript, type ManuscriptV2, type ManuscriptV3 } from '../domain/manuscript.js';
import { bylineRolesForGenre, type ProductionGenreId } from '../production-catalog.js';
import { RENDERER_BUILD, RENDER_PROFILE } from '../version.js';
export interface TitleProvenance {
  field: 'title' | 'subtitle';
  source: 'author' | 'author-authorized-replacement';
  action: 'replace' | 'supply' | null;
  original_present: boolean;
}

export interface RendererMapping {
  rendererManuscript: RendererManuscriptV1;
  titleProvenance: TitleProvenance[];
  /** Effective title/subtitle actually handed to the renderer (may be empty). */
  effectiveTitle: string | undefined;
  effectiveSubtitle: string | undefined;
  toneSource: 'author' | 'template-default';
}

export function mapToRendererManuscript(manuscript: Manuscript): RendererMapping {
  const title = effectiveTitle(manuscript);
  const subtitle = effectiveSubtitle(manuscript);
  if (title.value !== undefined && title.value.length > 0) {
    throw new RenderError('unsupported_content_slot', 'postcard paper has no title slot');
  }
  if (subtitle.value !== undefined && subtitle.value.length > 0) {
    throw new RenderError('unsupported_content_slot', 'postcard paper has no subtitle slot');
  }

  let tone: Tone | undefined;
  if (manuscript.tone !== undefined) {
    // The renderer validates tones itself; this pre-check only keeps the
    // error code stable regardless of who rejects first.
    if (!(TONES as readonly string[]).includes(manuscript.tone)) {
      throw new RenderError('invalid_input', 'tone must be one of the supported palette names');
    }
    tone = manuscript.tone as Tone;
  }

  const genre = manuscript.genrePreference ?? 'postcard';
  const rendererManuscript: RendererManuscriptV1 = {
    schema_version: 1,
    genre: 'postcard',
    intent: manuscript.intent,
    body: manuscript.body,
    // Empty-string titles travel verbatim (the renderer accepts them); a
    // non-empty one already failed above.
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(subtitle.value === undefined ? {} : { subtitle: subtitle.value }),
    ...(tone === undefined ? {} : { tone }),
  };
  if (genre !== 'postcard') {
    // Defense in depth: only the accepted genre reaches the renderer.
    throw new RenderError('unsupported_genre', 'genre is not supported by this renderer');
  }

  const titleProvenance: TitleProvenance[] = [];
  if (manuscript.title !== undefined || manuscript.titleAdaptation?.title !== undefined) {
    titleProvenance.push({
      field: 'title',
      source: title.source,
      action: title.action ?? null,
      original_present: manuscript.title !== undefined,
    });
  }
  if (manuscript.subtitle !== undefined || manuscript.titleAdaptation?.subtitle !== undefined) {
    titleProvenance.push({
      field: 'subtitle',
      source: subtitle.source,
      action: subtitle.action ?? null,
      original_present: manuscript.subtitle !== undefined,
    });
  }

  return {
    rendererManuscript,
    titleProvenance,
    effectiveTitle: title.value,
    effectiveSubtitle: subtitle.value,
    toneSource: tone === undefined ? 'template-default' : 'author',
  };
}

export { renderPostcard, countScalars };
export type { RenderOutcome };

/**
 * The production render dependency: run the real MCP-02 postcard pipeline
 * into the lease scratch directory and surface its per-file facts. The
 * worker re-verifies every reported fact against the actual bytes on disk.
 */
export async function realRenderJob(job: {
  manuscript: Manuscript;
  editorAdditions?: readonly EditorAddition[];
  rendererManuscript?: RendererManuscriptV1;
  date?: string;
  acceptedAt?: string;
  timezone?: string;
  tmpDir: string;
  branding?: RenderBranding;
  weatherSnapshot?: WeatherSnapshot;
  publicationFacts?: { almanac?: ReturnType<typeof almanacFactsForDate>; weather?: WeatherSnapshot };
}): Promise<{
  genre: ProductionGenreId;
  profile: string;
  rendererBuild: string;
  png: { sha256: string; bytes: number };
  gray4: { sha256: string; bytes: number };
  tone: { value: string; source: 'author' | 'template-default' };
  chromium: { version: string; revision: string; playwright: string };
  fonts: { manifestVersion: number; count: number; served: number };
  gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
  pages?: Array<{
    index: number;
    width?: number;
    height?: number;
    pngName: string;
    gray4Name: string;
    png: { sha256: string; bytes: number };
    gray4: { sha256: string; bytes: number };
    gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
    sourceRanges: unknown[];
    partRole?: 'main' | 'supplement';
  }>;
  paper?: unknown;
  editorialSpec?: unknown;
  provenance?: unknown;
  parts?: Array<{ role: 'main' | 'supplement'; genre: string; paper: unknown; editorialSpec: unknown; provenance: unknown }>;
}> {
  const genre = selectedGenre(job.manuscript);
  const authoredIssuer = 'bylines' in job.manuscript && job.manuscript.bylines?.issuer !== undefined
    ? job.manuscript.bylines.issuer
    : 'signature' in job.manuscript ? job.manuscript.signature : undefined;
  const authoredRecipient = 'bylines' in job.manuscript ? job.manuscript.bylines?.recipient : undefined;
  const visibleSignature = authoredIssuer ?? signatureForGenre(job.branding, genre, 'issuer');
  const visibleRecipient = bylineRolesForGenre(genre).includes('recipient')
    ? authoredRecipient ?? signatureForGenre(job.branding, genre, 'recipient')
    : undefined;
  if (genre === 'note') {
    const manuscript = job.manuscript as ManuscriptV2 | ManuscriptV3;
    const title = effectiveTitle(manuscript);
    const outcome = await renderNote({
      body: manuscript.body,
      ...(title.value === undefined ? {} : { title: title.value }),
      ...(visibleSignature === undefined ? {} : { signature: visibleSignature }),
      ...(job.branding === undefined ? {} : { branding: job.branding }),
      ...(visibleSignature === undefined ? {} : { signatureSource: manuscript.signature === undefined ? 'owner-config' as const : 'author' as const }),
      ...(manuscript.layoutVariant === 'note-portrait-v4'
        ? { layoutVariant: manuscript.layoutVariant }
        : {}),
      date: job.date ?? '1970-01-01',
      outputPath: job.tmpDir,
    });
    const first = outcome.pages[0];
    if (first === undefined) {
      throw new RenderError('render_failed', 'note renderer produced no pages');
    }
    return {
      genre: 'note',
      profile: outcome.profile,
      rendererBuild: NOTE_RENDERER_BUILD,
      png: first.png,
      gray4: first.gray4,
      tone: { value: 'white', source: 'template-default' },
      chromium: outcome.chromium,
      fonts: outcome.fonts,
      gray4Facts: first.gray4Facts,
      pages: outcome.pages,
      paper: outcome.paper,
      editorialSpec: outcome.editorialSpec,
      provenance: outcome.provenance,
    };
  }
  if ('schemaVersion' in job.manuscript && job.manuscript.schemaVersion === 3) {
    const resolvedBylines = {
      ...(visibleSignature === undefined ? {} : { issuer: visibleSignature }),
      ...(visibleRecipient === undefined ? {} : { recipient: visibleRecipient }),
    };
    const renderManuscript = Object.keys(resolvedBylines).length === 0
      ? job.manuscript
      : { ...job.manuscript, bylines: resolvedBylines };
    const publicationDate = job.date ?? '1970-01-01';
    const outcome = await renderGenre({
      manuscript: renderManuscript,
      genre,
      date: publicationDate,
      ...(job.acceptedAt === undefined ? {} : { acceptedAt: job.acceptedAt }),
      ...(job.timezone === undefined ? {} : { timezone: job.timezone }),
      outputPath: job.tmpDir,
      ...(job.branding === undefined ? {} : { branding: job.branding }),
      ...(job.editorAdditions === undefined ? {} : { editorAdditions: job.editorAdditions }),
      ...(genre === 'almanac' ? { almanacFacts: job.publicationFacts?.almanac ?? almanacFactsForDate(publicationDate) } : {}),
      ...((genre === 'weather' || genre === 'starmap') && (job.publicationFacts?.weather ?? job.weatherSnapshot) !== undefined
        ? { weatherSnapshot: job.publicationFacts?.weather ?? job.weatherSnapshot }
        : {}),
    });
    const first = outcome.pages[0];
    if (first === undefined) throw new RenderError('render_failed', 'genre renderer produced no pages');
    return {
      genre,
      profile: outcome.profile,
      rendererBuild: GENRE_RENDERER_BUILD,
      png: first.png,
      gray4: first.gray4,
      tone: { value: 'white', source: 'template-default' },
      chromium: outcome.chromium,
      fonts: outcome.fonts,
      gray4Facts: first.gray4Facts,
      pages: outcome.pages,
      paper: outcome.paper,
      editorialSpec: outcome.editorialSpec,
      provenance: outcome.provenance,
      parts: outcome.parts,
    };
  }
  if (job.rendererManuscript === undefined) {
    throw new RenderError('render_failed', 'postcard renderer input is missing');
  }
  const outcome = await renderPostcard({
    manuscript: job.rendererManuscript,
    outputPath: job.tmpDir,
  });
  return {
    genre: 'postcard',
    profile: RENDER_PROFILE,
    rendererBuild: RENDERER_BUILD,
    png: outcome.files['page.png']!,
    gray4: outcome.files['page.gray4']!,
    tone: outcome.tone,
    chromium: outcome.chromium,
    fonts: {
      manifestVersion: outcome.fonts.manifestVersion,
      count: outcome.fonts.count,
      served: outcome.fonts.served,
    },
    gray4Facts: {
      byteLength: outcome.gray4.byteLength,
      inkPixels: outcome.gray4.inkPixels,
      distinctLevels: outcome.gray4.distinctLevels,
    },
  };
}
