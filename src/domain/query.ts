/**
 * Query & withdraw domain (MCP-04): caller-scoped history snapshots with
 * opaque server-side cursors, the latest-eligible offer computation, and the
 * idempotent withdrawal ledger.
 *
 * Ordering rules fixed by the architecture (§16/§17) and the device contract:
 *  - history lists a caller's successfully published records by
 *    `acceptance_seq DESC`. The first query fixes the committed-publication
 *    `commit_seq` high water; late-completing older tasks and concurrently
 *    committed new manuscripts never enter an opened snapshot. Refreshing
 *    (a new first query) sees them.
 *  - peek picks `max(eligible_at, acceptance_seq)` among the caller's
 *    published, unwithdrawn, unexpired, `eligible_at <= now` publications.
 *    Completion time never participates.
 *  - cursors are 256-bit random tokens; the server stores only their SHA-256
 *    digest bound to (instance, caller, snapshot high water, last sort key,
 *    page size) with an expiry. Unknown/expired/foreign/tampered/page-size
 *    mismatched cursors are one uniform `invalid_input` — never a disclosure
 *    of whether the token belongs to another caller or instance.
 *  - withdraw cancels future automatic delivery eligibility only: the first
 *    call writes a stable `withdrawn_at` plus a ledger row in one
 *    transaction; replays of the same (instance, caller, request) key return
 *    the same stored result; a different publication for the same key is
 *    `idempotency_conflict`; unknown or foreign publications are one uniform
 *    `not_found`. Nothing is deleted and no device state is claimed.
 *
 * Clock, TTL and token sources are constructor dependencies (tests inject
 * them); they never appear in JSON configuration or the environment.
 */

import { createHash, randomBytes } from 'node:crypto';
import { BusinessError } from '../errors.js';
import { isValidRequestId } from './manuscript.js';
import { normalizeInstant } from './delivery.js';
import type { PublicationSummaryView } from './publication.js';

/** Public history page-size bounds (spec §5). */
export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 100;
/** Cursor lifetime: a snapshot stays continuable for 24h of server time. */
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** Opaque cursor token: exactly 64 lowercase hex chars (256-bit random). */
export const CURSOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** One caller-scoped published record as history/peek serve it. */
export interface PublicationRecordView {
  publication_id: string;
  operation_id: string;
  commit_seq: number;
  acceptance_seq: number;
  accepted_at: string;
  committed_at: string;
  deliver_after: string | null;
  eligible_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  /** Edition/page/asset facts (same shape as request_status publications). */
  summary: PublicationSummaryView;
}

/** Persisted cursor facts (the token itself never leaves the caller). */
export interface CursorRecord {
  cursor_id: string;
  instance_id: string;
  caller_id: string;
  cursor_digest: string;
  snapshot_high_water: number;
  last_acceptance_seq: number;
  page_size: number;
  created_at: string;
  expires_at: string;
}

/** Stored outcome of one withdraw ledger entry. */
export interface WithdrawLedgerRow {
  publication_id: string;
  /** The publication's stable withdrawal instant (never rewritten). */
  withdrawn_at: string;
}

export interface WithdrawOutcome {
  publication_id: string;
  withdrawn_at: string;
  /** True when the publication had already lost eligibility before this call. */
  already_withdrawn: boolean;
  /** True when this exact (instance, caller, request) key was replayed. */
  replayed: boolean;
}

/** Author-facing content view: authored fields and reading state, no renderer diagnostics. */
export interface AuthorWorkView {
  reference: string;
  title: string | null;
  body: string;
  signature: string | null;
  genre: string;
  page_count: number;
  part_count: number;
  unread: boolean;
}

/**
 * Storage contract of the query domain. `withdraw` owns its transaction and
 * throws the business outcomes (not_found / idempotency_conflict /
 * storage_unavailable) directly; read methods never surface SQL or paths.
 */
export interface QueryRepository {
  /** Current committed-publication high water (max commit_seq, 0 if none). */
  commitHighWater(): number;
  /**
   * One history page for the caller: publications with `commit_seq <=
   * highWater` (and `acceptance_seq < beforeAcceptanceSeq` when given),
   * ordered by acceptance_seq DESC, at most `limit` rows, each with its
   * edition/page/asset summary.
   */
  historyPage(
    callerId: string,
    highWater: number,
    beforeAcceptanceSeq: number | null,
    limit: number,
  ): PublicationRecordView[];
  /**
   * The caller's latest eligible offer at `nowIso` (normalized UTC):
   * published, not withdrawn, `expires_at > now`, `eligible_at <= now`,
   * max by (eligible_at, acceptance_seq). Null when none qualifies.
   */
  latestEligibleOffer(callerId: string, nowIso: string): PublicationRecordView | null;
  /** Cursor record by token digest, scoped to this instance and caller. */
  findCursorByDigest(digestHex: string, callerId: string): CursorRecord | null;
  /** Persist a new cursor record (id/digest collision is a storage failure). */
  insertCursor(record: CursorRecord): void;
  /**
   * Execute one withdrawal attempt atomically: ledger replay/conflict,
   * caller-scoped publication lookup, the conditional first `withdrawn_at`
   * write and the ledger insert. Returns the stored outcome.
   */
  withdraw(input: { callerId: string; requestId: string; publicationId: string; nowIso: string }): WithdrawOutcome;
  /** Ledger lookup (tests and diagnostics). */
  withdrawLedger(callerId: string, requestId: string): WithdrawLedgerRow | null;
  /** Published authored works newest first, with device acknowledgement folded into unread. */
  authorWorks?(callerId: string, limit: number): AuthorWorkView[];
  /** Publication currently reported in the newest active device state, if any. */
  currentPresentedPublication?(callerId: string): { state: 'known' | 'unknown'; publicationId: string | null };
}

export interface QueryServiceDeps {
  repository: QueryRepository;
  instanceId: string;
  /** Test-only injections; defaults use the system clock and crypto random. */
  clock?: () => number;
  cursorTtlMs?: number;
  cursorTokenSource?: () => string;
  cursorIdSource?: () => string;
}

/** Wire shape of one `ephemera_history` item. */
export type HistoryItemWire = {
  publication_id: string;
  operation_id: string;
  acceptance_seq: number;
  accepted_at: string;
  committed_at: string;
  deliver_after: string | null;
  eligible_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  edition: {
    edition_id: string;
    profile: string;
    renderer: PublicationSummaryView['renderer'];
  };
  pages: PublicationSummaryView['pages'];
};

export interface HistoryPageWire {
  instance_id: string;
  items: HistoryItemWire[];
  next_cursor: string | null;
}

/** Wire shape of the `ephemera_peek` offer (device state is never implied). */
export type PeekOfferWire = HistoryItemWire;

export interface PeekResultWire {
  instance_id: string;
  offer: PeekOfferWire | null;
  device_channel_enabled: false;
  device_status: {
    state: 'unknown';
    offered_at: null;
    cached_at: null;
    presented_at: null;
    acknowledged_at: null;
    last_reported_at: null;
  };
}

export interface WithdrawResultWire {
  instance_id: string;
  request_id: string;
  publication_id: string;
  withdrawn_at: string;
  already_withdrawn: boolean;
  replayed: boolean;
}

export interface AuthorPeekWire {
  current_state: 'known' | 'unknown';
  current: AuthorWorkView | null;
  unread_count: number;
  items: AuthorWorkView[];
}

function toWire(record: PublicationRecordView): HistoryItemWire {
  return {
    publication_id: record.publication_id,
    operation_id: record.operation_id,
    acceptance_seq: record.acceptance_seq,
    accepted_at: record.accepted_at,
    committed_at: record.committed_at,
    deliver_after: record.deliver_after,
    eligible_at: record.eligible_at,
    expires_at: record.expires_at,
    withdrawn_at: record.withdrawn_at,
    edition: {
      edition_id: record.summary.edition_id,
      profile: record.summary.profile,
      renderer: record.summary.renderer,
    },
    pages: record.summary.pages,
  };
}

export class QueryService {
  private readonly repository: QueryRepository;
  private readonly instanceId: string;
  private readonly clock: () => number;
  private readonly cursorTtlMs: number;
  private readonly cursorTokenSource: () => string;
  private readonly cursorIdSource: () => string;

  constructor(deps: QueryServiceDeps) {
    this.repository = deps.repository;
    this.instanceId = deps.instanceId;
    this.clock = deps.clock ?? (() => Date.now());
    this.cursorTtlMs = deps.cursorTtlMs ?? CURSOR_TTL_MS;
    this.cursorTokenSource = deps.cursorTokenSource ?? (() => randomBytes(32).toString('hex'));
    this.cursorIdSource = deps.cursorIdSource ?? (() => `cur_${randomBytes(12).toString('hex')}`);
  }

  private requireCaller(callerId: string | undefined): string {
    if (callerId === undefined || callerId.length === 0) {
      // Identity comes from the authenticated credential; a missing value is
      // a wiring defect, never trusted input.
      throw new BusinessError('invalid_input', 'caller identity is missing');
    }
    return callerId;
  }

  private requireInstance(expectedInstanceId: unknown): void {
    if (typeof expectedInstanceId !== 'string' || expectedInstanceId.length === 0) {
      throw new BusinessError('invalid_input', 'expected_instance_id must be a non-empty string');
    }
    if (expectedInstanceId !== this.instanceId) {
      throw new BusinessError('instance_changed', 'expected instance does not match this service instance');
    }
  }

  private parseLimit(limit: unknown): number {
    if (limit === undefined) {
      return HISTORY_LIMIT_DEFAULT;
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
      throw new BusinessError('invalid_input', `limit must be an integer between 1 and ${HISTORY_LIMIT_MAX}`);
    }
    return limit;
  }

  /**
   * `ephemera_history`: one stable snapshot page. The first call fixes the
   * commit high water and issues an opaque cursor for the remainder;
   * continuations reuse the stored snapshot and sort key. A `next_cursor` is
   * only issued when more rows remain inside the snapshot.
   */
  history(
    callerId: string | undefined,
    args: { expected_instance_id: unknown; limit?: unknown; cursor?: unknown },
  ): HistoryPageWire {
    const caller = this.requireCaller(callerId);
    this.requireInstance(args.expected_instance_id);
    const nowIso = normalizeInstant(this.clock());

    let highWater: number;
    let beforeSeq: number | null;
    let pageSize: number;

    if (args.cursor === undefined) {
      pageSize = this.parseLimit(args.limit);
      highWater = this.repository.commitHighWater();
      beforeSeq = null;
    } else {
      // Every cursor rejection shares ONE message and code: malformed,
      // unknown, tampered, foreign-caller, foreign-instance and expired
      // tokens are indistinguishable to the caller.
      const invalidCursor = (): BusinessError => new BusinessError('invalid_input', 'cursor is unknown or no longer valid');
      if (typeof args.cursor !== 'string' || !CURSOR_TOKEN_PATTERN.test(args.cursor)) {
        throw invalidCursor();
      }
      // Only the digest is ever looked up or stored; the token itself stays
      // with the caller and the lookup is scoped to this caller.
      const digest = createHash('sha256').update(args.cursor, 'utf8').digest('hex');
      const cursor = this.repository.findCursorByDigest(digest, caller);
      if (cursor === null || cursor.expires_at <= nowIso) {
        throw invalidCursor();
      }
      if (args.limit !== undefined && this.parseLimit(args.limit) !== cursor.page_size) {
        throw new BusinessError('invalid_input', 'cursor does not match the requested page size');
      }
      highWater = cursor.snapshot_high_water;
      beforeSeq = cursor.last_acceptance_seq;
      pageSize = cursor.page_size;
    }

    // One row over the page size detects whether another page remains
    // without leaking any extra record.
    const fetched = this.repository.historyPage(caller, highWater, beforeSeq, pageSize + 1);
    const hasMore = fetched.length > pageSize;
    const items = fetched.slice(0, pageSize).map(toWire);

    let nextCursor: string | null = null;
    if (hasMore) {
      // Every page issues a fresh token: each cursor record binds one
      // snapshot position, and old tokens simply age out at their expiry.
      const token = this.cursorTokenSource();
      if (!CURSOR_TOKEN_PATTERN.test(token)) {
        throw new BusinessError('storage_unavailable', 'cursor source is not available', true);
      }
      const digest = createHash('sha256').update(token, 'utf8').digest('hex');
      this.repository.insertCursor({
        cursor_id: this.cursorIdSource(),
        instance_id: this.instanceId,
        caller_id: caller,
        cursor_digest: digest,
        snapshot_high_water: highWater,
        last_acceptance_seq: items[items.length - 1]!.acceptance_seq,
        page_size: pageSize,
        created_at: nowIso,
        expires_at: normalizeInstant(Date.parse(nowIso) + this.cursorTtlMs),
      });
      nextCursor = token;
    }

    return { instance_id: this.instanceId, items, next_cursor: nextCursor };
  }

  /**
   * `ephemera_peek`: the caller's latest eligible offer with the device
   * channel honestly disabled and every device fact explicitly unknown.
   */
  peek(callerId: string | undefined, args: { expected_instance_id: unknown }): PeekResultWire {
    const caller = this.requireCaller(callerId);
    this.requireInstance(args.expected_instance_id);
    const nowIso = normalizeInstant(this.clock());
    const offer = this.repository.latestEligibleOffer(caller, nowIso);
    return {
      instance_id: this.instanceId,
      offer: offer === null ? null : toWire(offer),
      device_channel_enabled: false,
      device_status: {
        state: 'unknown',
        offered_at: null,
        cached_at: null,
        presented_at: null,
        acknowledged_at: null,
        last_reported_at: null,
      },
    };
  }

  /** The compact author view used by the two-tool MCP surface. */
  authorPeek(
    callerId: string | undefined,
    args: { scope?: 'overview' | 'unread' | 'recent' | 'work'; work?: string; limit?: number },
  ): AuthorPeekWire {
    const caller = this.requireCaller(callerId);
    const limit = this.parseLimit(args.limit);
    const scope = args.scope ?? 'overview';
    if (scope === 'work' && (typeof args.work !== 'string' || args.work.length === 0)) {
      throw new BusinessError('invalid_input', 'work is required when scope is work');
    }
    if (this.repository.authorWorks === undefined || this.repository.currentPresentedPublication === undefined) {
      throw new BusinessError('storage_unavailable', 'author reading view is unavailable', true);
    }
    const all = this.repository.authorWorks(caller, Math.max(limit, 100));
    const displayed = this.repository.currentPresentedPublication(caller);
    const current = displayed.publicationId === null
      ? null
      : all.find((item) => item.reference === displayed.publicationId) ?? null;
    const unread = all.filter((item) => item.unread);
    let items: AuthorWorkView[];
    if (scope === 'work') {
      const needle = args.work!;
      items = all.filter((item) => item.reference === needle || item.title === needle || item.body.includes(needle)).slice(0, limit);
    } else if (scope === 'unread' || scope === 'overview') {
      items = unread.slice(0, limit);
    } else {
      items = all.slice(0, limit);
    }
    return { current_state: displayed.state, current, unread_count: unread.length, items };
  }

  /**
   * `ephemera_withdraw`: idempotent cancellation of future automatic
   * delivery eligibility. All validation happens before the transaction.
   */
  withdraw(
    callerId: string | undefined,
    args: { expected_instance_id: unknown; request_id: unknown; publication_id: unknown },
  ): WithdrawResultWire {
    const caller = this.requireCaller(callerId);
    this.requireInstance(args.expected_instance_id);
    if (typeof args.request_id !== 'string' || !isValidRequestId(args.request_id)) {
      throw new BusinessError('invalid_input', 'request_id must be 1-128 chars of [A-Za-z0-9._:-]');
    }
    if (typeof args.publication_id !== 'string' || args.publication_id.length === 0) {
      throw new BusinessError('invalid_input', 'publication_id must be a non-empty string');
    }
    const nowIso = normalizeInstant(this.clock());
    const outcome = this.repository.withdraw({
      callerId: caller,
      requestId: args.request_id,
      publicationId: args.publication_id,
      nowIso,
    });
    return {
      instance_id: this.instanceId,
      request_id: args.request_id,
      publication_id: outcome.publication_id,
      withdrawn_at: outcome.withdrawn_at,
      already_withdrawn: outcome.already_withdrawn,
      replayed: outcome.replayed,
    };
  }
}
