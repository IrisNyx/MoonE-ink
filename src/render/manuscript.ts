/**
 * Versioned renderer input (RendererManuscriptV1).
 *
 * The renderer accepts exactly this shape — never a Paper superset, HTML, JS,
 * CSS, URLs, template paths, image paths or an output path. `body` is the only
 * prose source and must flow byte-exact into the paper's single body node: no
 * trimming, no Unicode normalization, no blank-line collapsing, no punctuation
 * rewriting, no translation. `intent` is recorded (as a digest) but never
 * displayed. The postcard paper has no author title/subtitle slot, so a
 * non-empty title or subtitle is a stable `unsupported_content_slot` failure —
 * it must not be dropped in order to succeed.
 */

import { RenderError } from './errors.js';

export const MANUSCRIPT_SCHEMA_VERSION = 1;
export const SUPPORTED_GENRE = 'postcard' as const;
export const TONES = ['cream', 'gold'] as const;
export type Tone = (typeof TONES)[number];

/** Versioned default tone (Template source, not an author choice). */
export const DEFAULT_TONE: Tone = 'cream';

export interface RendererManuscriptV1 {
  schema_version: 1;
  genre: 'postcard';
  intent: string;
  body: string;
  title?: string;
  subtitle?: string;
  tone?: Tone;
}

export interface ParsedManuscript {
  manuscript: RendererManuscriptV1;
  /** Where the effective tone came from: the author's field or the template default. */
  toneSource: 'author' | 'template-default';
  effectiveTone: Tone;
  intentUtf8Bytes: number;
  intentScalarCount: number;
  bodyUtf8Bytes: number;
  bodyScalarCount: number;
}

const ALLOWED_KEYS = new Set(['schema_version', 'genre', 'intent', 'body', 'title', 'subtitle', 'tone']);
const MAX_BODY_UTF8_BYTES = 64 * 1024;
const MAX_MANUSCRIPT_BYTES = 128 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function countScalars(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Validate a parsed-JSON value as RendererManuscriptV1.
 *
 * Throws RenderError with stable codes; messages are fixed strings that never
 * echo field names, field values or any other manuscript content.
 */
export function parseManuscript(input: unknown, rawByteLength?: number): ParsedManuscript {
  if (rawByteLength !== undefined && rawByteLength > MAX_MANUSCRIPT_BYTES) {
    throw new RenderError('invalid_input', 'manuscript exceeds the maximum input size');
  }
  if (!isPlainObject(input)) {
    throw new RenderError('invalid_input', 'manuscript must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      // Field names are attacker-controlled input: fixed message, no echo.
      throw new RenderError('invalid_input', 'manuscript contains an unknown field');
    }
  }
  if (input.schema_version !== MANUSCRIPT_SCHEMA_VERSION) {
    throw new RenderError('invalid_input', 'unsupported manuscript schema_version');
  }
  if (input.genre !== SUPPORTED_GENRE) {
    throw new RenderError('unsupported_genre', 'genre is not supported by this renderer');
  }
  if (typeof input.intent !== 'string' || input.intent.length === 0) {
    throw new RenderError('invalid_input', 'intent must be a non-empty string');
  }
  if (typeof input.body !== 'string' || input.body.length === 0) {
    throw new RenderError('invalid_input', 'body must be a non-empty string');
  }
  const body = input.body;
  const bodyUtf8Bytes = Buffer.byteLength(body, 'utf8');
  if (bodyUtf8Bytes > MAX_BODY_UTF8_BYTES) {
    throw new RenderError('invalid_input', 'body exceeds the maximum size');
  }
  // Slot rejection happens before anything else can "succeed by dropping".
  if (input.title !== undefined && typeof input.title === 'string' && input.title.length > 0) {
    throw new RenderError('unsupported_content_slot', 'postcard paper has no title slot');
  }
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new RenderError('invalid_input', 'title must be a string when present');
  }
  if (input.subtitle !== undefined && typeof input.subtitle === 'string' && input.subtitle.length > 0) {
    throw new RenderError('unsupported_content_slot', 'postcard paper has no subtitle slot');
  }
  if (input.subtitle !== undefined && typeof input.subtitle !== 'string') {
    throw new RenderError('invalid_input', 'subtitle must be a string when present');
  }
  let tone: Tone | undefined;
  if (input.tone !== undefined) {
    if (typeof input.tone !== 'string' || !(TONES as readonly string[]).includes(input.tone)) {
      throw new RenderError('invalid_input', 'tone must be one of the supported palette names');
    }
    tone = input.tone as Tone;
  }
  return {
    manuscript: {
      schema_version: 1,
      genre: 'postcard',
      intent: input.intent,
      body,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
      ...(tone === undefined ? {} : { tone }),
    },
    toneSource: tone === undefined ? 'template-default' : 'author',
    effectiveTone: tone ?? DEFAULT_TONE,
    intentUtf8Bytes: Buffer.byteLength(input.intent, 'utf8'),
    intentScalarCount: countScalars(input.intent),
    bodyUtf8Bytes,
    bodyScalarCount: countScalars(body),
  };
}
