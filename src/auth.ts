import { createHash, timingSafeEqual } from 'node:crypto';

export interface CredentialConfigEntry {
  credential_id: string;
  caller_id: string;
  token_sha256: string;
  revoked: boolean;
  tool_view?: 'author' | 'internal';
}

export interface CallerIdentity {
  callerId: string;
  credentialId: string;
  toolView: 'author' | 'internal';
}

export type AuthFailure =
  | { status: 401; reason: 'missing_token' }
  | { status: 401; reason: 'malformed_header' }
  | { status: 401; reason: 'unknown_token' }
  | { status: 403; reason: 'credential_revoked' };

export type AuthResult = { ok: true; identity: CallerIdentity } | { ok: false; failure: AuthFailure };

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Static bearer credential table loaded from private configuration.
 *
 * The configuration only ever contains SHA-256 digests of tokens; raw tokens
 * exist in memory for the duration of a single request validation and are
 * never logged.
 */
export class CredentialStore {
  private readonly entries: readonly CredentialConfigEntry[];

  constructor(entries: readonly CredentialConfigEntry[]) {
    this.entries = entries;
  }

  authenticate(authorizationHeader: string | undefined): AuthResult {
    if (authorizationHeader === undefined || authorizationHeader.length === 0) {
      return { ok: false, failure: { status: 401, reason: 'missing_token' } };
    }
    // HTTP authentication schemes are case-insensitive. Some mobile HTTP
    // stacks also preserve extra horizontal whitespace inserted by an
    // adapter, so accept those harmless representation differences while
    // keeping the token alphabet and digest validation unchanged.
    const match = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]+)[ \t]*$/i.exec(authorizationHeader);
    if (match === null) {
      return { ok: false, failure: { status: 401, reason: 'malformed_header' } };
    }
    const presented = digestToken(match[1] as string);

    for (const entry of this.entries) {
      const expected = Buffer.from(entry.token_sha256, 'hex');
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
        if (entry.revoked) {
          return { ok: false, failure: { status: 403, reason: 'credential_revoked' } };
        }
        return {
          ok: true,
          identity: { callerId: entry.caller_id, credentialId: entry.credential_id, toolView: entry.tool_view ?? 'internal' },
        };
      }
    }
    return { ok: false, failure: { status: 401, reason: 'unknown_token' } };
  }
}
