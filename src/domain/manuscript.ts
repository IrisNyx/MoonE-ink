/**
 * Author manuscript (ManuscriptV1) — domain validation for persistent
 * acceptance (MCP-03a) plus the author title authorization wire schema
 * (MCP-03b).
 *
 * The acceptance entry receives the manuscript as an untrusted parsed-JSON
 * value and must accept exactly the documented shape: unknown fields at any
 * level, non-JSON values and non-finite numbers are rejected. This schema has
 * no numeric fields at all, so any number anywhere is `invalid_input`.
 *
 * `caller_id` is never taken from the manuscript or any other external
 * parameter: the authenticated caller identity is a separate domain input.
 *
 * Author text is stored verbatim: no trimming, no Unicode normalization, no
 * blank-line collapsing, no punctuation rewriting. Validation only measures
 * (UTF-8 bytes / Unicode scalar counts); it never rewrites.
 *
 * `titleAdaptation` (MCP-03b) is the most conservative authorization form:
 * the author explicitly supplies the final replacement/supplied value for
 * title and/or subtitle. There is no translate/rewrite/shorten action, no
 * boolean grant, no editor directive. `replace` requires the original field
 * to exist; `supply` requires it to be absent. The authorization object joins
 * the manuscript in the same immutable canonical BLOB and request digest, and
 * field presence is recorded separately. The body is never authorizable.
 */

import { BusinessError } from '../errors.js';
import {
  PRODUCTION_GENRE_IDS,
  PRODUCTION_LAYOUTS,
  PRODUCTION_LAYOUT_VARIANT_IDS,
  bylineRolesForGenre,
  type ProductionGenreId,
} from '../production-catalog.js';
import {
  GENRE_CONTENT_SCHEMA,
  contentPrimaryText,
  genreForContent,
  type GenreContent,
} from './genre-content.js';

export type ManuscriptIntent =
  | 'note'
  | 'letter'
  | 'share'
  | 'reminder'
  | 'question'
  | 'celebration'
  | 'other';

const INTENTS: readonly string[] = [
  'note',
  'letter',
  'share',
  'reminder',
  'question',
  'celebration',
  'other',
];

export type DeliveryPersistence = 'ephemeral' | 'keep' | 'archive';
export type DeliveryPresentation = 'ambient' | 'foreground' | 'physical-preferred';
export type DeliveryInterruption = 'never' | 'when-idle' | 'important';
export type PreferredMedium = 'ephemera' | 'print';

/** Author-provided delivery semantics; all author strings kept verbatim. */
export interface DeliverySemantics {
  persistence: DeliveryPersistence;
  presentation: DeliveryPresentation;
  interruption: DeliveryInterruption;
  preferredMedium?: PreferredMedium;
  deliverAfter?: string;
  expiresAt?: string;
}

/**
 * Author title authorization, wire schema `explicit-replacement-v1`. Exactly
 * one shape is accepted: the author names the final title/subtitle value
 * explicitly. At least one of title/subtitle must appear; unknown fields are
 * rejected at every level.
 */
export interface TitleAdaptationSlot {
  action: 'replace' | 'supply';
  value: string;
}

export interface AuthorTitleAuthorizationV1 {
  schema: 'explicit-replacement-v1';
  title?: TitleAdaptationSlot;
  subtitle?: TitleAdaptationSlot;
}

/** The stored manuscript: exactly what the author sent, nothing defaulted. */
export interface ManuscriptV1 {
  intent: ManuscriptIntent;
  body: string;
  title?: string;
  subtitle?: string;
  protectedText?: string[];
  tone?: string;
  genrePreference?: string;
  delivery?: DeliverySemantics;
  titleAdaptation?: AuthorTitleAuthorizationV1;
}

/**
 * First structured manuscript slice.  Version 1 deliberately remains
 * untagged and byte-compatible; an explicit numeric tag therefore always
 * means the v2 contract below.  This first v2 slice supports the fields the
 * production note renderer can preserve end to end.  `structure` and
 * `authorFields` stay rejected until their per-genre schemas are implemented.
 */
export interface ManuscriptV2 {
  schemaVersion: 2;
  intent: ManuscriptIntent;
  body: string;
  title?: string;
  subtitle?: string;
  signature?: string;
  protectedText?: string[];
  tone?: string;
  genrePreference?: 'postcard' | 'note';
  genrePreferenceMode?: 'strict' | 'preferred';
  layoutVariant?: (typeof PRODUCTION_LAYOUT_VARIANT_IDS)[number];
  delivery?: DeliverySemantics;
  titleAdaptation?: AuthorTitleAuthorizationV1;
}

export type AuthorFieldValue = string | number | boolean | null | AuthorFieldValue[] | { [key: string]: AuthorFieldValue };

/**
 * Complete genre-library manuscript. `authorFields` carries only authored,
 * genre-specific facts; the renderer may arrange them but must not invent or
 * rewrite them. Date/kind/body stay owned by the publication envelope.
 */
export interface ManuscriptV3 {
  schemaVersion: 3;
  intent: ManuscriptIntent;
  body: string;
  title?: string;
  subtitle?: string;
  signature?: string;
  /** Optional visible bylines. Author values win; omitted roles may use Owner defaults. */
  bylines?: AuthorBylines;
  protectedText?: string[];
  tone?: string;
  genrePreference?: ProductionGenreId;
  genrePreferenceMode?: 'strict' | 'preferred';
  layoutVariant?: (typeof PRODUCTION_LAYOUT_VARIANT_IDS)[number];
  /** Public, per-genre author structure. `body` is an internal deterministic projection when present. */
  content?: GenreContent;
  /** Legacy v3 renderer fields; retained only so already-stored manuscripts keep rendering. */
  authorFields?: Record<string, AuthorFieldValue>;
  delivery?: DeliverySemantics;
  titleAdaptation?: AuthorTitleAuthorizationV1;
}

export interface AuthorBylines {
  issuer?: string;
  recipient?: string;
}

export type Manuscript = ManuscriptV1 | ManuscriptV2 | ManuscriptV3;

/** Presence of every accepted field, as the author supplied it. */
export interface ManuscriptFieldPresence {
  intent: boolean;
  body: boolean;
  title: boolean;
  subtitle: boolean;
  protectedText: boolean;
  tone: boolean;
  genrePreference: boolean;
  delivery: boolean;
  deliveryPersistence: boolean;
  deliveryPresentation: boolean;
  deliveryInterruption: boolean;
  deliveryPreferredMedium: boolean;
  deliveryDeliverAfter: boolean;
  deliveryExpiresAt: boolean;
  titleAdaptation: boolean;
  titleAdaptationTitle: boolean;
  titleAdaptationSubtitle: boolean;
  schemaVersion?: boolean;
  signature?: boolean;
  bylines?: boolean;
  genrePreferenceMode?: boolean;
  layoutVariant?: boolean;
  content?: boolean;
  authorFields?: boolean;
}

export interface ValidatedManuscript {
  manuscript: Manuscript;
  presence: ManuscriptFieldPresence;
}

/** Exported limits are part of the public contract; documented in README. */
export const MANUSCRIPT_LIMITS = {
  bodyMinUtf8Bytes: 1,
  bodyMaxUtf8Bytes: 64 * 1024,
  titleMaxScalars: 512,
  subtitleMaxScalars: 512,
  signatureMaxScalars: 512,
  adaptationValueMaxScalars: 512,
  toneMaxUtf8Bytes: 128,
  genrePreferenceMaxUtf8Bytes: 128,
  protectedTextMaxItems: 64,
  protectedTextItemMaxUtf8Bytes: 64 * 1024,
  protectedTextTotalMaxUtf8Bytes: 256 * 1024,
  requestIdPattern: /^[A-Za-z0-9._:-]{1,128}$/,
} as const;

export const ACCEPTED_GENRES = PRODUCTION_GENRE_IDS;

const MANUSCRIPT_KEYS = new Set([
  'intent',
  'body',
  'title',
  'subtitle',
  'protectedText',
  'tone',
  'genrePreference',
  'delivery',
  'titleAdaptation',
]);

const MANUSCRIPT_V2_KEYS = new Set([
  ...MANUSCRIPT_KEYS,
  'schemaVersion',
  'signature',
  'genrePreferenceMode',
  'layoutVariant',
]);

const MANUSCRIPT_V3_KEYS = new Set([...MANUSCRIPT_V2_KEYS, 'bylines', 'content', 'authorFields']);
const BYLINE_KEYS = new Set(['issuer', 'recipient']);

const AUTHOR_FIELD_KEYS = new Set([
  'no', 'year', 'md', 'weekday', 'trivia', 'today', 'oneline', 'issuer', 'recipient',
  'place', 'aside', 'gift', 'why', 'image', 'imageSource', 'variant', 'ban', 'level',
  'note', 'caption', 'notes', 'wxToday', 'wxDays', 'dateCn', 'phase', 'term',
  'goodText', 'badText', 'from', 'to', 'seat', 'gate', 'boards', 'stub', 'legs',
  'prog', 'holder', 'stamps', 'customs', 'checks', 'sub', 'night2', 'pins', 'week',
  'lit', 'clauses', 'tg', 'en', 'poem', 'rx', 'log', 'wx',
]);

const DELIVERY_KEYS = new Set([
  'persistence',
  'presentation',
  'interruption',
  'preferredMedium',
  'deliverAfter',
  'expiresAt',
]);

const ADAPTATION_KEYS = new Set(['schema', 'title', 'subtitle']);
const ADAPTATION_SLOT_KEYS = new Set(['action', 'value']);

function invalid(message: string): BusinessError {
  return new BusinessError('invalid_input', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAuthorValue(value: unknown, depth = 0): AuthorFieldValue {
  if (depth > 5) throw invalid('authorFields is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('authorFields contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw invalid('authorFields contains an oversized list');
    return value.map((item) => validateAuthorValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const result: Record<string, AuthorFieldValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.length > 64) throw invalid('authorFields contains an invalid object key');
      result[key] = validateAuthorValue(item, depth + 1);
    }
    return result;
  }
  throw invalid('authorFields must contain JSON values');
}

function validateAuthorFields(value: unknown): Record<string, AuthorFieldValue> {
  if (!isPlainObject(value)) throw invalid('authorFields must be a JSON object');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) {
    throw invalid('authorFields is outside the accepted size range');
  }
  const result: Record<string, AuthorFieldValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!AUTHOR_FIELD_KEYS.has(key)) throw invalid('authorFields contains an unknown field');
    result[key] = validateAuthorValue(item);
  }
  return result;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function scalarCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Validate a requestId / callerId shaped identifier: 1–128 ASCII chars from
 * `[A-Za-z0-9._:-]`. Exported so the acceptance entry validates both.
 */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && MANUSCRIPT_LIMITS.requestIdPattern.test(value);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Proleptic Gregorian leap rule; the parser's years 0000–9999 follow it. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1]!;
}

/**
 * Days since 1970-01-01 in the proleptic Gregorian calendar (the classic
 * civil-days algorithm). `Date.UTC` is unusable here: it maps years 0–99 to
 * 1900–1999, which would corrupt the comparison of legal four-digit RFC 3339
 * years 0000–0099.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400; // [0, 399]
  const monthFromMarch = (month + 9) % 12; // March = 0
  const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Strict RFC 3339 timestamp with a mandatory `Z` or explicit numeric offset.
 * Returns the comparable epoch milliseconds; throws invalid_input on any
 * shape or calendar violation (JS Date parsing alone is too lenient, e.g. it
 * silently rolls 2026-02-30 into March). Every four-digit year 0000–9999 is
 * taken literally in the proleptic Gregorian calendar — `Date.UTC`-style
 * remapping of 00–99 onto 1900–1999 would corrupt years 0000–0099. The
 * author's original string is what gets stored — this never rewrites the
 * timezone.
 *
 * Exported (MCP-04) so the delivery-window computation and the schema v4
 * backfill compare instants with the one strict parser, never by naive text
 * ordering of author spellings.
 */
export function parseRfc3339(value: string, field: string): number {
  const match = RFC3339.exec(value);
  if (match === null) {
    throw invalid(`${field} must be an RFC 3339 timestamp with Z or an explicit offset`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) throw invalid(`${field} month is out of range`);
  if (day < 1 || day > daysInMonth(year, month)) throw invalid(`${field} day is out of range`);
  if (hour > 23) throw invalid(`${field} hour is out of range`);
  if (minute > 59) throw invalid(`${field} minute is out of range`);
  // :60 is the RFC 3339 leap-second spelling; anything above is invalid.
  if (second > 60) throw invalid(`${field} second is out of range`);
  // Group 7 (fractional seconds) is optional; group 8 always matches.
  const fraction = match[7];
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw invalid(`${field} offset is out of range`);
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const wholeSeconds = daysFromCivil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
  const milliseconds = fraction === undefined ? 0 : Number(`0${fraction}`) * 1_000;
  return wholeSeconds * 1_000 + milliseconds - offsetMinutes * 60_000;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string`);
  }
  return value;
}

function validateDelivery(input: Record<string, unknown>): {
  delivery: DeliverySemantics;
  presence: Pick<
    ManuscriptFieldPresence,
    'deliveryPersistence' | 'deliveryPresentation' | 'deliveryInterruption' | 'deliveryPreferredMedium' | 'deliveryDeliverAfter' | 'deliveryExpiresAt'
  >;
} {
  for (const key of Object.keys(input)) {
    if (!DELIVERY_KEYS.has(key)) {
      throw invalid('delivery contains an unknown field');
    }
  }
  for (const required of ['persistence', 'presentation', 'interruption'] as const) {
    if (input[required] === undefined) {
      throw invalid(`delivery.${required} is required when delivery is present`);
    }
  }
  const persistence = expectString(input.persistence, 'delivery.persistence');
  if (persistence !== 'ephemeral' && persistence !== 'keep' && persistence !== 'archive') {
    throw invalid('delivery.persistence must be one of the supported values');
  }
  const presentation = expectString(input.presentation, 'delivery.presentation');
  if (presentation !== 'ambient' && presentation !== 'foreground' && presentation !== 'physical-preferred') {
    throw invalid('delivery.presentation must be one of the supported values');
  }
  const interruption = expectString(input.interruption, 'delivery.interruption');
  if (interruption !== 'never' && interruption !== 'when-idle' && interruption !== 'important') {
    throw invalid('delivery.interruption must be one of the supported values');
  }

  let preferredMedium: PreferredMedium | undefined;
  if (input.preferredMedium !== undefined) {
    const medium = expectString(input.preferredMedium, 'delivery.preferredMedium');
    if (medium !== 'ephemera' && medium !== 'print') {
      throw invalid('delivery.preferredMedium must be one of the supported values');
    }
    preferredMedium = medium;
  }

  // Times keep the author's exact spelling; only validity is checked here.
  let deliverAfter: string | undefined;
  let expiresAt: string | undefined;
  if (input.deliverAfter !== undefined) {
    deliverAfter = expectString(input.deliverAfter, 'delivery.deliverAfter');
    parseRfc3339(deliverAfter, 'delivery.deliverAfter');
  }
  if (input.expiresAt !== undefined) {
    expiresAt = expectString(input.expiresAt, 'delivery.expiresAt');
    parseRfc3339(expiresAt, 'delivery.expiresAt');
  }
  if (deliverAfter !== undefined && expiresAt !== undefined) {
    const from = parseRfc3339(deliverAfter, 'delivery.deliverAfter');
    const to = parseRfc3339(expiresAt, 'delivery.expiresAt');
    if (to < from) {
      throw invalid('delivery interval ends before it starts');
    }
  }

  return {
    delivery: {
      persistence,
      presentation,
      interruption,
      ...(preferredMedium === undefined ? {} : { preferredMedium }),
      ...(deliverAfter === undefined ? {} : { deliverAfter }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    presence: {
      deliveryPersistence: true,
      deliveryPresentation: true,
      deliveryInterruption: true,
      deliveryPreferredMedium: preferredMedium !== undefined,
      deliveryDeliverAfter: deliverAfter !== undefined,
      deliveryExpiresAt: expiresAt !== undefined,
    },
  };
}

/**
 * Validate the author title authorization (`titleAdaptation`). The presence
 * flags of the original title/subtitle are required here: `replace` demands
 * the original field exist, `supply` demands it absent — an authorization that
 * mismatches the manuscript it travels with is invalid input, not a stored
 * grant. Values are kept verbatim; only length is measured.
 */
function validateTitleAdaptation(
  input: Record<string, unknown>,
  field: string,
  originalPresent: boolean,
): TitleAdaptationSlot {
  for (const key of Object.keys(input)) {
    if (!ADAPTATION_SLOT_KEYS.has(key)) {
      throw invalid('titleAdaptation contains an unknown field');
    }
  }
  if (input.action !== 'replace' && input.action !== 'supply') {
    throw invalid('titleAdaptation action must be replace or supply');
  }
  if (input.action === 'replace' && !originalPresent) {
    throw invalid(`titleAdaptation ${field} replace requires the manuscript field to exist`);
  }
  if (input.action === 'supply' && originalPresent) {
    throw invalid(`titleAdaptation ${field} supply requires the manuscript field to be absent`);
  }
  if (typeof input.value !== 'string') {
    throw invalid('titleAdaptation value must be a string');
  }
  if (scalarCount(input.value) > MANUSCRIPT_LIMITS.adaptationValueMaxScalars) {
    throw invalid('titleAdaptation value is longer than accepted');
  }
  return { action: input.action, value: input.value };
}

function validateAdaptation(
  input: Record<string, unknown>,
  titlePresent: boolean,
  subtitlePresent: boolean,
): { adaptation: AuthorTitleAuthorizationV1; presence: { titleAdaptationTitle: boolean; titleAdaptationSubtitle: boolean } } {
  for (const key of Object.keys(input)) {
    if (!ADAPTATION_KEYS.has(key)) {
      throw invalid('titleAdaptation contains an unknown field');
    }
  }
  if (input.schema !== 'explicit-replacement-v1') {
    throw invalid('titleAdaptation schema is not supported');
  }
  if (input.title === undefined && input.subtitle === undefined) {
    throw invalid('titleAdaptation needs at least one of title or subtitle');
  }
  let title: TitleAdaptationSlot | undefined;
  if (input.title !== undefined) {
    if (!isPlainObject(input.title)) {
      throw invalid('titleAdaptation title must be a JSON object');
    }
    title = validateTitleAdaptation(input.title, 'title', titlePresent);
  }
  let subtitle: TitleAdaptationSlot | undefined;
  if (input.subtitle !== undefined) {
    if (!isPlainObject(input.subtitle)) {
      throw invalid('titleAdaptation subtitle must be a JSON object');
    }
    subtitle = validateTitleAdaptation(input.subtitle, 'subtitle', subtitlePresent);
  }
  return {
    adaptation: {
      schema: 'explicit-replacement-v1',
      ...(title === undefined ? {} : { title }),
      ...(subtitle === undefined ? {} : { subtitle }),
    },
    presence: {
      titleAdaptationTitle: title !== undefined,
      titleAdaptationSubtitle: subtitle !== undefined,
    },
  };
}

/**
 * Validate an untrusted value as ManuscriptV1. Throws BusinessError with a
 * stable code and a fixed message that never echoes manuscript content or
 * attacker-supplied field names.
 */
export function validateManuscript(input: unknown): ValidatedManuscript {
  if (!isPlainObject(input)) {
    throw invalid('manuscript must be a JSON object');
  }
  const isV2 = input.schemaVersion === 2;
  const isV3 = input.schemaVersion === 3;
  const isStructured = isV2 || isV3;
  const allowedKeys = isV3 ? MANUSCRIPT_V3_KEYS : isV2 ? MANUSCRIPT_V2_KEYS : MANUSCRIPT_KEYS;
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      // Unknown fields include any self-reported caller identity, renderer
      // parameters or a differently-spelled adaptation grant. Fixed message,
      // no echo.
      throw invalid('manuscript contains an unknown field');
    }
  }
  if (input.schemaVersion !== undefined && !isStructured) {
    throw invalid('manuscript schemaVersion is not supported');
  }

  const intentValue = expectString(input.intent, 'intent');
  if (!INTENTS.includes(intentValue)) {
    throw invalid('intent must be one of the supported values');
  }
  const intent = intentValue as ManuscriptIntent;

  let content: GenreContent | undefined;
  if (isV3 && input.content !== undefined) {
    const parsed = GENRE_CONTENT_SCHEMA.safeParse(input.content);
    if (!parsed.success) {
      throw invalid('content does not match the selected genre contract');
    }
    content = parsed.data;
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body !== contentPrimaryText(content))) {
      throw invalid('body conflicts with the structured primary content');
    }
    if (input.authorFields !== undefined) {
      throw invalid('structured content cannot be combined with legacy authorFields');
    }
  }

  const bodyWasPresent = content === undefined && input.body !== undefined;
  const body = content === undefined ? expectString(input.body, 'body') : contentPrimaryText(content);
  const bodyBytes = utf8Bytes(body);
  if (bodyBytes < MANUSCRIPT_LIMITS.bodyMinUtf8Bytes || bodyBytes > MANUSCRIPT_LIMITS.bodyMaxUtf8Bytes) {
    throw invalid('body is outside the accepted size range');
  }

  let title: string | undefined;
  if (input.title !== undefined) {
    title = expectString(input.title, 'title');
    if (scalarCount(title) > MANUSCRIPT_LIMITS.titleMaxScalars) {
      throw invalid('title is longer than accepted');
    }
  }
  let subtitle: string | undefined;
  if (input.subtitle !== undefined) {
    subtitle = expectString(input.subtitle, 'subtitle');
    if (scalarCount(subtitle) > MANUSCRIPT_LIMITS.subtitleMaxScalars) {
      throw invalid('subtitle is longer than accepted');
    }
  }

  let signature: string | undefined;
  if (isStructured && input.signature !== undefined) {
    signature = expectString(input.signature, 'signature');
    if (scalarCount(signature) > MANUSCRIPT_LIMITS.signatureMaxScalars) {
      throw invalid('signature is longer than accepted');
    }
  }

  let bylines: AuthorBylines | undefined;
  if (isV3 && input.bylines !== undefined) {
    if (!isPlainObject(input.bylines)) throw invalid('bylines must be a JSON object');
    for (const key of Object.keys(input.bylines)) {
      if (!BYLINE_KEYS.has(key)) throw invalid('bylines contains an unknown field');
    }
    const issuer = input.bylines.issuer === undefined ? undefined : expectString(input.bylines.issuer, 'bylines.issuer');
    const recipient = input.bylines.recipient === undefined ? undefined : expectString(input.bylines.recipient, 'bylines.recipient');
    if (issuer === undefined && recipient === undefined) throw invalid('bylines needs at least one visible role');
    if ([issuer, recipient].some((value) => value !== undefined && scalarCount(value) > MANUSCRIPT_LIMITS.signatureMaxScalars)) {
      throw invalid('bylines contains a value longer than accepted');
    }
    if (signature !== undefined && issuer !== undefined) {
      throw invalid('use bylines.issuer instead of sending both it and signature');
    }
    bylines = { ...(issuer === undefined ? {} : { issuer }), ...(recipient === undefined ? {} : { recipient }) };
  }

  let protectedText: string[] | undefined;
  if (input.protectedText !== undefined) {
    if (!Array.isArray(input.protectedText)) {
      throw invalid('protectedText must be an array of strings');
    }
    if (input.protectedText.length > MANUSCRIPT_LIMITS.protectedTextMaxItems) {
      throw invalid('protectedText has too many entries');
    }
    let total = 0;
    const items: string[] = [];
    for (const item of input.protectedText) {
      const text = expectString(item, 'protectedText entry');
      const size = utf8Bytes(text);
      if (size > MANUSCRIPT_LIMITS.protectedTextItemMaxUtf8Bytes) {
        throw invalid('protectedText entry is longer than accepted');
      }
      total += size;
      items.push(text);
    }
    if (total > MANUSCRIPT_LIMITS.protectedTextTotalMaxUtf8Bytes) {
      throw invalid('protectedText is longer than accepted');
    }
    // Order and duplicates are preserved exactly as the author wrote them.
    protectedText = items;
  }

  let tone: string | undefined;
  if (input.tone !== undefined) {
    tone = expectString(input.tone, 'tone');
    if (utf8Bytes(tone) > MANUSCRIPT_LIMITS.toneMaxUtf8Bytes) {
      throw invalid('tone is longer than accepted');
    }
  }

  let genrePreference: string | undefined;
  if (input.genrePreference !== undefined) {
    genrePreference = expectString(input.genrePreference, 'genrePreference');
    if (utf8Bytes(genrePreference) > MANUSCRIPT_LIMITS.genrePreferenceMaxUtf8Bytes) {
      throw invalid('genrePreference is longer than accepted');
    }
    if (!(ACCEPTED_GENRES as readonly string[]).includes(genrePreference)) {
      throw new BusinessError('unsupported_genre', 'genre is not supported by an accepted renderer');
    }
    if (!isStructured && genrePreference !== 'postcard') {
      throw new BusinessError('unsupported_genre', 'genre is not supported by this manuscript version');
    }
    if (isV2 && genrePreference !== 'postcard' && genrePreference !== 'note') {
      throw new BusinessError('unsupported_genre', 'genre is not supported by this manuscript version');
    }
  }

  if (content !== undefined) {
    const contentGenre = genreForContent(content);
    if (genrePreference !== undefined && genrePreference !== contentGenre) {
      throw invalid('genrePreference does not match content.kind');
    }
    genrePreference = contentGenre;
  }

  let genrePreferenceMode: 'strict' | 'preferred' | undefined;
  if (isStructured && input.genrePreferenceMode !== undefined) {
    const value = expectString(input.genrePreferenceMode, 'genrePreferenceMode');
    if (value !== 'strict' && value !== 'preferred') {
      throw invalid('genrePreferenceMode must be strict or preferred');
    }
    genrePreferenceMode = value;
    if (genrePreference === undefined) {
      throw invalid('genrePreferenceMode requires genrePreference');
    }
  }

  let layoutVariant: (typeof PRODUCTION_LAYOUT_VARIANT_IDS)[number] | undefined;
  if (isStructured && input.layoutVariant !== undefined) {
    const value = expectString(input.layoutVariant, 'layoutVariant');
    if (!(PRODUCTION_LAYOUT_VARIANT_IDS as readonly string[]).includes(value)) {
      throw invalid('layoutVariant is not supported');
    }
    layoutVariant = value as (typeof PRODUCTION_LAYOUT_VARIANT_IDS)[number];
  }

  if (isStructured) {
    const selectedGenre = genrePreference ?? (content === undefined ? 'note' : genreForContent(content));
    if (isV2 && layoutVariant !== undefined && !['postcard-portrait', 'note-portrait-v4'].includes(layoutVariant)) {
      throw invalid('layoutVariant is not supported by this manuscript version');
    }
    if (layoutVariant !== undefined) {
      const layout = PRODUCTION_LAYOUTS.find((item) => item.id === layoutVariant);
      if (layout === undefined || (genrePreference !== undefined && layout.genre !== selectedGenre)) {
        throw invalid('layoutVariant does not match the selected genre');
      }
    }
    if (isV2 && selectedGenre === 'postcard' && signature !== undefined) {
      throw new BusinessError('unsupported_content_slot', 'postcard paper has no signature slot');
    }
    if (isV2 && selectedGenre === 'note' && tone !== undefined) {
      throw new BusinessError('unsupported_content_slot', 'note paper has no tone slot');
    }
    if (selectedGenre === 'note' && subtitle !== undefined && subtitle.length > 0) {
      throw new BusinessError('unsupported_content_slot', 'note paper has no subtitle slot');
    }
    if (bylines?.recipient !== undefined && !bylineRolesForGenre(selectedGenre as ProductionGenreId).includes('recipient')) {
      throw new BusinessError('unsupported_content_slot', `${selectedGenre} paper has no recipient byline slot`);
    }
  }

  let authorFields: Record<string, AuthorFieldValue> | undefined;
  if (isV3 && input.authorFields !== undefined) {
    authorFields = validateAuthorFields(input.authorFields);
  }


  if (content?.kind === 'extra' && (title === undefined || title.length === 0)) {
    throw invalid('extra content requires a non-empty title');
  }
  if (content?.kind === 'emblem' && (title === undefined || title.length === 0)) {
    throw invalid('emblem content requires a non-empty title');
  }
  if (content !== undefined && title !== undefined && !['note', 'iou', 'extra', 'emblem'].includes(content.kind)) {
    throw new BusinessError('unsupported_content_slot', `${content.kind} paper has no author title slot`);
  }
  if (content !== undefined && subtitle !== undefined && !['wakepaper', 'starmap', 'boarding-pass'].includes(content.kind)) {
    throw new BusinessError('unsupported_content_slot', `${content.kind} paper has no author subtitle slot`);
  }

  let delivery: DeliverySemantics | undefined;
  let deliveryPresence: {
    deliveryPersistence: boolean;
    deliveryPresentation: boolean;
    deliveryInterruption: boolean;
    deliveryPreferredMedium: boolean;
    deliveryDeliverAfter: boolean;
    deliveryExpiresAt: boolean;
  };
  if (input.delivery !== undefined) {
    if (!isPlainObject(input.delivery)) {
      throw invalid('delivery must be a JSON object');
    }
    const validated = validateDelivery(input.delivery);
    delivery = validated.delivery;
    deliveryPresence = validated.presence;
  } else {
    deliveryPresence = {
      deliveryPersistence: false,
      deliveryPresentation: false,
      deliveryInterruption: false,
      deliveryPreferredMedium: false,
      deliveryDeliverAfter: false,
      deliveryExpiresAt: false,
    };
  }

  // The authorization is validated against the ORIGINAL title/subtitle
  // presence of this manuscript — replace needs the field, supply needs its
  // absence. It joins the canonical BLOB below, binding the exact snapshot.
  let titleAdaptation: AuthorTitleAuthorizationV1 | undefined;
  let adaptationPresence: { titleAdaptationTitle: boolean; titleAdaptationSubtitle: boolean };
  if (input.titleAdaptation !== undefined) {
    if (!isPlainObject(input.titleAdaptation)) {
      throw invalid('titleAdaptation must be a JSON object');
    }
    const validated = validateAdaptation(input.titleAdaptation, title !== undefined, subtitle !== undefined);
    titleAdaptation = validated.adaptation;
    adaptationPresence = validated.presence;
  } else {
    adaptationPresence = { titleAdaptationTitle: false, titleAdaptationSubtitle: false };
  }

  return {
    manuscript: {
      ...(isV3 ? { schemaVersion: 3 as const } : isV2 ? { schemaVersion: 2 as const } : {}),
      intent,
      body,
      ...(title === undefined ? {} : { title }),
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(signature === undefined ? {} : { signature }),
      ...(bylines === undefined ? {} : { bylines }),
      ...(protectedText === undefined ? {} : { protectedText }),
      ...(tone === undefined ? {} : { tone }),
      ...(genrePreference === undefined ? {} : { genrePreference }),
      ...(genrePreferenceMode === undefined ? {} : { genrePreferenceMode }),
      ...(layoutVariant === undefined ? {} : { layoutVariant }),
      ...(content === undefined ? {} : { content }),
      ...(authorFields === undefined ? {} : { authorFields }),
      ...(delivery === undefined ? {} : { delivery }),
      ...(titleAdaptation === undefined ? {} : { titleAdaptation }),
    },
    presence: {
      intent: true,
      body: bodyWasPresent,
      title: title !== undefined,
      subtitle: subtitle !== undefined,
      protectedText: protectedText !== undefined,
      tone: tone !== undefined,
      genrePreference: genrePreference !== undefined,
      delivery: delivery !== undefined,
      ...deliveryPresence,
      titleAdaptation: titleAdaptation !== undefined,
      ...adaptationPresence,
      ...(isStructured
        ? {
            schemaVersion: true,
            signature: signature !== undefined,
            ...(isV3 ? { bylines: bylines !== undefined } : {}),
            genrePreferenceMode: genrePreferenceMode !== undefined,
            layoutVariant: layoutVariant !== undefined,
            ...(isV3 ? { content: content !== undefined, authorFields: authorFields !== undefined } : {}),
          }
        : {}),
    },
  };
}

/**
 * The effective title/subtitle the renderer-facing manuscript carries, plus
 * the provenance of where each value came from. With a valid authorization
 * the explicit value wins and the original field plus the action are recorded
 * as provenance; otherwise the author's original field is used verbatim.
 */
export interface EffectiveTitle {
  value: string | undefined;
  source: 'author' | 'author-authorized-replacement';
  originalValue: string | undefined;
  action: 'replace' | 'supply' | undefined;
}

export function effectiveTitle(
  manuscript: Pick<ManuscriptV1, 'title' | 'titleAdaptation'>,
): EffectiveTitle {
  const authorization = manuscript.titleAdaptation;
  if (authorization?.title !== undefined) {
    return {
      value: authorization.title.value,
      source: 'author-authorized-replacement',
      originalValue: manuscript.title,
      action: authorization.title.action,
    };
  }
  return { value: manuscript.title, source: 'author', originalValue: manuscript.title, action: undefined };
}

export function effectiveSubtitle(
  manuscript: Pick<ManuscriptV1, 'subtitle' | 'titleAdaptation'>,
): EffectiveTitle {
  const authorization = manuscript.titleAdaptation;
  if (authorization?.subtitle !== undefined) {
    return {
      value: authorization.subtitle.value,
      source: 'author-authorized-replacement',
      originalValue: manuscript.subtitle,
      action: authorization.subtitle.action,
    };
  }
  return { value: manuscript.subtitle, source: 'author', originalValue: manuscript.subtitle, action: undefined };
}

/**
 * Deterministic content-aware selection. Explicit author choices win; without
 * one, structured fields are the strongest signal and prose intent/shape is
 * the fallback. The result is frozen by the worker into the publication.
 */
export function selectedGenre(manuscript: Manuscript): ProductionGenreId {
  if (!('schemaVersion' in manuscript)) return 'postcard';
  if (manuscript.schemaVersion === 2) return manuscript.genrePreference ?? 'note';
  if (manuscript.content !== undefined) return genreForContent(manuscript.content);
  if (manuscript.genrePreference !== undefined) return manuscript.genrePreference;
  if (manuscript.layoutVariant !== undefined) {
    const layout = PRODUCTION_LAYOUTS.find((item) => item.id === manuscript.layoutVariant);
    if (layout !== undefined) return layout.genre;
  }

  const fields = manuscript.authorFields ?? {};
  const structuredSignals: Array<[ProductionGenreId, readonly string[]]> = [
    ['weather', ['wx', 'wxToday', 'wxDays']],
    ['weekly-chart', ['notes', 'week', 'lit']],
    ['almanac', ['dateCn', 'phase', 'term', 'goodText', 'badText']],
    ['boarding-pass', ['from', 'to', 'seat', 'gate', 'boards']],
    ['itinerary', ['legs']],
    ['passport', ['stamps', 'holder']],
    ['customs', ['customs']],
    ['iou', ['clauses']],
    ['night-log', ['log']],
    ['programme', ['prog']],
    ['prescription', ['rx']],
    ['checkup', ['checks']],
    ['poem', ['poem']],
    ['telegram', ['tg']],
    ['omikuji', ['ban', 'level']],
    ['wakepaper', ['night2', 'pins', 'trivia', 'today']],
  ];
  for (const [genre, keys] of structuredSignals) {
    if (keys.some((key) => Object.hasOwn(fields, key))) return genre;
  }

  const compact = manuscript.body.trim();
  const lines = compact.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const averageLine = lines.length === 0 ? compact.length : lines.reduce((sum, line) => sum + Array.from(line).length, 0) / lines.length;
  if (lines.length >= 3 && lines.length <= 16 && averageLine <= 22) return 'poem';
  if (manuscript.intent === 'celebration') return 'extra';
  if (manuscript.intent === 'question') return 'telegram';
  if (manuscript.intent === 'reminder' && /药|吃|喝水|休息|睡|服用|复诊/u.test(compact)) return 'prescription';
  if ((manuscript.intent === 'letter' || manuscript.intent === 'share') && Array.from(compact).length > 220) return 'wakepaper';
  if (manuscript.intent === 'share' && manuscript.title === undefined && Array.from(compact).length <= 180) return 'postcard';
  return 'note';
}
