/**
 * Deterministic canonical JSON encoding, version 1, plus the versioned
 * request digest used by the acceptance ledger.
 *
 * Rules (fixed by `canonicalization_version = 1`):
 *  - object keys are sorted by Unicode code point (not UTF-16 code unit
 *    order, which would disagree for astral keys vs. high BMP keys);
 *  - arrays keep their author order;
 *  - strings are encoded exactly like a JSON string (JSON.stringify) and
 *    never altered: no trimming, no Unicode normalization, no escaping
 *    changes beyond standard JSON escaping of control characters;
 *  - numbers use their JSON spelling; non-finite numbers are refused (the
 *    ManuscriptV1 schema has no numeric fields, so this is defense in depth
 *    for future versions);
 *  - the canonical form is UTF-8 bytes.
 *
 * The request digest input is the fixed domain-separated, version-tagged byte
 * string: ASCII `ephemera.accept.v1`, one NUL byte, then the canonical
 * manuscript bytes; hashed with SHA-256. Changing any of these constants
 * requires a new canonicalization version.
 */

import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 1;
export const DIGEST_ALGORITHM = 'sha-256';
export const DIGEST_DOMAIN = 'ephemera.accept.v1';

/** Compare two strings by Unicode code point order. */
function compareByCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const ca = left[index]!.codePointAt(0)!;
    const cb = right[index]!.codePointAt(0)!;
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
  }
  return left.length - right.length;
}

function encodeValue(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('non-finite numbers are not canonicalizable');
      }
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      if (Array.isArray(value)) {
        out.push('[');
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) {
            out.push(',');
          }
          encodeValue(value[index], out);
        }
        out.push(']');
        return;
      }
      {
        const keys = Object.keys(value as Record<string, unknown>).sort(compareByCodePoint);
        out.push('{');
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) {
            out.push(',');
          }
          const key = keys[index]!;
          out.push(JSON.stringify(key), ':');
          encodeValue((value as Record<string, unknown>)[key], out);
        }
        out.push('}');
        return;
      }
    default:
      // undefined / symbol / function / bigint are not JSON values.
      throw new TypeError('value is not a JSON value');
  }
}

/** Canonical v1 encoding of a JSON value as UTF-8 bytes. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const chunks: string[] = [];
  encodeValue(value, chunks);
  return Buffer.from(chunks.join(''), 'utf8');
}

export interface RequestDigest {
  /** 32 raw digest bytes of the domain-prefixed canonical manuscript. */
  digestBytes: Uint8Array;
  /** 64 lowercase hex characters — the persisted ledger digest. */
  digestHex: string;
  algorithm: typeof DIGEST_ALGORITHM;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  /** Length of the canonical manuscript bytes (the stored BLOB size). */
  canonicalByteLength: number;
}

/** SHA-256 over `ephemera.accept.v1\0` + canonical manuscript bytes. */
export function requestDigest(canonical: Uint8Array): RequestDigest {
  const domain = Buffer.from(`${DIGEST_DOMAIN}\0`, 'utf8');
  const digest = createHash('sha256')
    .update(Buffer.concat([domain, Buffer.from(canonical)]))
    .digest();
  return {
    digestBytes: digest,
    digestHex: digest.toString('hex'),
    algorithm: DIGEST_ALGORITHM,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    canonicalByteLength: canonical.length,
  };
}

/**
 * Canonicalize the validated manuscript and compute its request digest in one
 * step. The returned canonical bytes are exactly what gets stored as the
 * immutable snapshot BLOB.
 */
export function canonicalizeManuscript(manuscript: unknown): { canonical: Uint8Array; digest: RequestDigest } {
  const canonical = canonicalJsonBytes(manuscript);
  return { canonical, digest: requestDigest(canonical) };
}
