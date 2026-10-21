/**
 * Delivery window facts for publication queries (MCP-04).
 *
 * The architecture fixes two rules this module implements once so every
 * caller (worker commit, schema v4 backfill, history/peek SQL) shares them:
 *
 *  - `eligible_at = max(accepted_at, delivery.deliverAfter)` — the instant a
 *    publication may first be offered automatically. Ordering uses acceptance
 *    order and the reserved delivery time, never worker completion time.
 *  - all stored query times are normalized UTC instants in the fixed
 *    `Date#toISOString()` shape (`YYYY-MM-DDTHH:MM:SS.sssZ`, always 24 chars
 *    for years 1000–9999). Fixed-width UTC ISO spells compare
 *    lexicographically exactly as instants, so SQL text comparison IS instant
 *    comparison — the author's original timezone spelling is never used for
 *    ordering (it stays verbatim inside the immutable manuscript snapshot).
 *
 * Boundary semantics (task card): `eligible_at <= now` is deliverable;
 * `expires_at <= now` is expired. Both comparisons are inclusive at "now".
 */

import { parseRfc3339 } from './manuscript.js';

/** Normalized UTC instant string; the only spelling stored in query columns. */
export function normalizeInstant(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface DeliveryWindowFacts {
  /** Normalized deliverAfter instant, or null when the author set none. */
  deliver_after: string | null;
  /** Normalized expiresAt instant, or null when the author set none. */
  expires_at: string | null;
  /** max(accepted_at, deliverAfter) as a normalized instant. */
  eligible_at: string;
}

/**
 * Derive the persisted delivery window from the immutable manuscript
 * delivery snapshot. `deliverAfter`/`expiresAt` are the author's original
 * RFC 3339 spellings (or null/undefined when absent); `acceptedAtIso` is the
 * operation's stored acceptance instant. Parsing failures cannot occur for
 * accepted manuscripts (acceptance validated them) — a failure here means
 * database corruption and surfaces as an error the caller maps to
 * storage_unavailable.
 */
export function computeDeliveryWindow(
  acceptedAtIso: string,
  deliverAfter: string | null | undefined,
  expiresAt: string | null | undefined,
): DeliveryWindowFacts {
  const acceptedMs = parseRfc3339(acceptedAtIso, 'accepted_at');
  let deliverAfterMs: number | null = null;
  if (deliverAfter !== undefined && deliverAfter !== null) {
    deliverAfterMs = parseRfc3339(deliverAfter, 'delivery.deliverAfter');
  }
  let expiresMs: number | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expiresMs = parseRfc3339(expiresAt, 'delivery.expiresAt');
  }
  const eligibleMs = deliverAfterMs === null ? acceptedMs : Math.max(acceptedMs, deliverAfterMs);
  return {
    deliver_after: deliverAfterMs === null ? null : normalizeInstant(deliverAfterMs),
    expires_at: expiresMs === null ? null : normalizeInstant(expiresMs),
    eligible_at: normalizeInstant(eligibleMs),
  };
}
