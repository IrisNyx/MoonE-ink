/**
 * Persistent acceptance domain service (MCP-03a).
 *
 * One acceptance = one `BEGIN IMMEDIATE` SQLite transaction with the
 * semantics fixed by the task card:
 *
 *  1. `expectedInstanceId` is checked before any write (`instance_changed`).
 *  2. The ledger is read under the write lock: same key + same digest returns
 *     the stored receipt (even when the queue is full); same key + different
 *     digest is `idempotency_conflict` with no IDs or sequence numbers
 *     allocated.
 *  3. Pending (`accepted|processing`) operations are counted against
 *     `maxPendingOperations` (`queue_full`, no counter change).
 *  4. A globally increasing `acceptance_seq` is allocated from the persistent
 *     counter; one clock sample produces `accepted_at` (UTC RFC 3339) and the
 *     local `YYYY-MM-DD` in the configured IANA timezone.
 *  5. The per-local-date counter reserves `NN` (two digits minimum) forming
 *     `YYYY-MM-DD-NN`; each local date restarts at 01, and changing the
 *     configured timezone later never rewrites stored rows.
 *  6. Snapshot, operation and ledger rows are inserted and committed before
 *     the `accepted` receipt is returned.
 *
 * The domain is MCP-connection independent and carries no cancellation: once
 * a call is submitted, its facts live only in SQLite. The caller identity is
 * the authenticated `callerId` — credential rotation never enters the key.
 *
 * Clock and ID sources are constructor dependencies (tests inject them);
 * they never appear in JSON configuration, environment variables or the
 * production start path beyond their defaults.
 */

import { randomBytes } from 'node:crypto';
import { BusinessError } from '../errors.js';
import { canonicalizeManuscript, canonicalJsonBytes, requestDigest } from './canonical.js';
import { isValidRequestId, validateManuscript, type DeliverySemantics, type ManuscriptFieldPresence } from './manuscript.js';
import { freezeProductionCatalog, type ProductionCatalogSnapshot } from '../production-catalog.js';

export interface AcceptManuscriptInput {
  expectedInstanceId: string;
  /** Authenticated caller identity; never trusted from the manuscript. */
  callerId: string;
  requestId: string;
  /** Omitted preserves the historical immediate accepted receipt. */
  businessContract?: PublicationBusinessContract;
  /** Untrusted parsed-JSON manuscript value. */
  manuscript: unknown;
}

export interface AcceptanceReceipt {
  instance_id: string;
  operation_id: string;
  status: OperationStatus;
  accepted: true;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  business_contract: PublicationBusinessContract;
  /** Present only for terminal-v1 and fixed by the creating transaction. */
  deadline_at: string | null;
  /** Read-time fact: false on the creating call, true on replays. */
  replayed: boolean;
}

/**
 * Final terminal-v1 result produced before acceptance. It deliberately has
 * no operation/publication identifiers or sequence number: an invalid
 * manuscript must not consume publication capacity or numbering. Only the
 * digest and a safe, fixed validation failure are persisted; manuscript
 * bytes are never copied into this record.
 */
export interface PreAcceptanceRejection {
  instance_id: string;
  request_id: string;
  business_contract: 'terminal-v1';
  accepted: false;
  outcome: 'rejected';
  phase: 'pre-acceptance';
  rejected_at: string;
  failure: {
    category: 'manuscript';
    code: 'invalid_input' | 'unsupported_genre' | 'unsupported_content_slot';
    message: string;
    retryable: false;
  };
  replayed: boolean;
}

export interface PreAcceptanceRejectionFacts {
  callerId: string;
  requestId: string;
  digestHex: string;
  businessContract: 'terminal-v1';
  rejectedAt: string;
  failureCode: PreAcceptanceRejection['failure']['code'];
  failureMessage: string;
}

export type OperationStatus = 'accepted' | 'processing' | 'published' | 'failed' | 'unknown_after_restore';
export type PublicationBusinessContract = 'accepted-v2' | 'terminal-v1';

export interface OperationView {
  instance_id: string;
  operation_id: string;
  request_id: string;
  caller_id: string;
  status: OperationStatus;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  reserved_local_date: string;
  request_digest_hex: string;
}

export interface LookupQuery {
  expectedInstanceId: string;
  callerId: string;
  /** Exactly one of operationId / requestId. */
  operationId?: string;
  requestId?: string;
}

/** One clock sample materialized for both the UTC stamp and the local date. */
export interface AcceptanceStamp {
  acceptedAtIso: string;
  localDate: string;
}

export interface AcceptanceIds {
  operationId: string;
  manuscriptId: string;
}

/**
 * Storage contract of the acceptance domain. Implementations own the
 * transaction boundary and must map storage failures to safe
 * `storage_unavailable` errors (never surfacing SQL, paths or OS messages).
 */
export interface AcceptanceRepository {
  accept(facts: AcceptanceFacts): AcceptanceReceipt;
  rejectPreAcceptance(facts: PreAcceptanceRejectionFacts): PreAcceptanceRejection;
  lookupPreAcceptance(callerId: string, requestId: string): PreAcceptanceRejection | null;
  lookup(callerId: string, query: { operationId?: string; requestId?: string }): OperationView | null;
  /** Row counts of the four fact families, for tests and diagnostics only. */
  factCounts(): { ledger: number; operation: number; snapshot: number; pending: number };
  /** Current counter values (post-commit), for tests and diagnostics only. */
  counterState(): { nextAcceptanceSeq: number; publicationCounters: Record<string, number> };
}

export interface AcceptanceFacts {
  callerId: string;
  requestId: string;
  digestHex: string;
  canonical: Uint8Array;
  canonicalizationVersion: number;
  digestAlgorithm: string;
  fieldPresence: ManuscriptFieldPresence;
  productionCatalog: ProductionCatalogSnapshot;
  businessContract: PublicationBusinessContract;
  terminalPublishBudgetMs: number;
  /** Trusted route frozen with the operation; null keeps it outside Device Channel. */
  channelId: string | null;
  maxPendingOperations: number;
  /** Sampled inside the transaction, only once a write will proceed. */
  allocateStamp: () => AcceptanceStamp;
  /** High-entropy typed-prefix IDs; may be called again for bounded retries. */
  allocateIds: () => AcceptanceIds;
}

/** Local calendar date of an instant in an IANA timezone, via formatToParts. */
export function localDateFor(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const byType: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      byType[part.type] = part.value;
    }
  }
  const year = byType['year'];
  const month = byType['month'];
  const day = byType['day'];
  if (year === undefined || month === undefined || day === undefined || !/^\d+$/.test(year) || !/^\d+$/.test(month) || !/^\d+$/.test(day)) {
    throw new BusinessError('invalid_input', 'timezone did not yield a calendar date');
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** `01`…`99`, `100`… — at least two digits, no upper bound padding. */
export function formatDailyNumber(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Versioned system default delivery intent recorded in the publication
 * snapshot when the author did not provide one (architecture §7/§8: defaults
 * are filled by a versioned policy and labeled as system-default — never
 * disguised as an author field).
 */
export const SYSTEM_DELIVERY_DEFAULT_VERSION = 1;
export const SYSTEM_DELIVERY_DEFAULT = {
  persistence: 'keep',
  presentation: 'ambient',
  interruption: 'when-idle',
} as const;

export interface DeliveryIntentSnapshot {
  persistence: string;
  presentation: string;
  interruption: string;
  source: 'author' | 'system-default';
  /** SYSTEM_DELIVERY_DEFAULT_VERSION for system defaults; 0 for author input. */
  defaultVersion: number;
}

/** Resolve the delivery intent recorded with a publication snapshot. */
export function resolveDeliveryIntent(manuscript: { delivery?: unknown }): DeliveryIntentSnapshot {
  const delivery = manuscript.delivery as DeliverySemantics | undefined;
  if (delivery !== undefined) {
    return {
      persistence: delivery.persistence,
      presentation: delivery.presentation,
      interruption: delivery.interruption,
      source: 'author',
      defaultVersion: 0,
    };
  }
  return {
    persistence: SYSTEM_DELIVERY_DEFAULT.persistence,
    presentation: SYSTEM_DELIVERY_DEFAULT.presentation,
    interruption: SYSTEM_DELIVERY_DEFAULT.interruption,
    source: 'system-default',
    defaultVersion: SYSTEM_DELIVERY_DEFAULT_VERSION,
  };
}

function defaultTimezoneCheck(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new BusinessError('invalid_input', 'timezone is not a known IANA timezone');
  }
}

export interface AcceptanceServiceDeps {
  repository: AcceptanceRepository;
  instanceId: string;
  /** IANA timezone for publication numbering (from server configuration). */
  timezone: string;
  /** Server-wide cap on accepted|processing operations (queue_full above). */
  maxPendingOperations: number;
  /** Overall queue→commit budget used only by the terminal-v1 contract. */
  terminalPublishBudgetMs?: number;
  channelForCaller?: (callerId: string) => string | null;
  /** Test-only injections; defaults use the system clock and crypto random. */
  clock?: () => number;
  idSource?: () => string;
}

export class AcceptanceService {
  private readonly repository: AcceptanceRepository;
  private readonly instanceId: string;
  private readonly timezone: string;
  private readonly maxPendingOperations: number;
  private readonly terminalPublishBudgetMs: number;
  private readonly clock: () => number;
  private readonly idSource: () => string;
  private readonly channelForCaller: (callerId: string) => string | null;

  constructor(deps: AcceptanceServiceDeps) {
    if (!Number.isInteger(deps.maxPendingOperations) || deps.maxPendingOperations < 1) {
      throw new RangeError('maxPendingOperations must be a positive integer');
    }
    defaultTimezoneCheck(deps.timezone);
    this.repository = deps.repository;
    this.instanceId = deps.instanceId;
    this.timezone = deps.timezone;
    this.maxPendingOperations = deps.maxPendingOperations;
    this.terminalPublishBudgetMs = deps.terminalPublishBudgetMs ?? 20_000;
    if (!Number.isInteger(this.terminalPublishBudgetMs) || this.terminalPublishBudgetMs < 1 || this.terminalPublishBudgetMs > 120_000) {
      throw new RangeError('terminalPublishBudgetMs must be an integer from 1 to 120000');
    }
    this.clock = deps.clock ?? (() => Date.now());
    this.idSource = deps.idSource ?? (() => randomBytes(16).toString('hex'));
    this.channelForCaller = deps.channelForCaller ?? (() => null);
  }

  /**
   * Accept a manuscript. Validation and canonicalization happen before the
   * transaction; every durable fact is decided inside it.
   */
  async accept(input: AcceptManuscriptInput): Promise<AcceptanceReceipt> {
    const businessContract = this.validateEnvelope(input);
    return this.acceptValidated(input, businessContract);
  }

  /**
   * Tool-facing submission entry. The legacy contract keeps its historical
   * error behavior. For terminal-v1 only, manuscript/schema rejections are
   * converted into durable final results that replay after retries/restarts.
   */
  async submit(input: AcceptManuscriptInput): Promise<AcceptanceReceipt | PreAcceptanceRejection> {
    const businessContract = this.validateEnvelope(input);
    try {
      return await this.acceptValidated(input, businessContract);
    } catch (error) {
      if (
        businessContract !== 'terminal-v1' ||
        !(error instanceof BusinessError) ||
        (error.code !== 'invalid_input' && error.code !== 'unsupported_genre' && error.code !== 'unsupported_content_slot')
      ) {
        throw error;
      }

      let canonical: Uint8Array;
      try {
        canonical = canonicalJsonBytes(input.manuscript);
      } catch {
        // MCP transports JSON, so this is reachable only through an invalid
        // in-process caller. There is no stable JSON value to bind a durable
        // idempotency record to.
        throw error;
      }
      const digest = requestDigest(canonical);
      return this.repository.rejectPreAcceptance({
        callerId: input.callerId,
        requestId: input.requestId,
        digestHex: digest.digestHex,
        businessContract,
        rejectedAt: new Date(this.clock()).toISOString(),
        failureCode: error.code,
        failureMessage: error.message,
      });
    }
  }

  private validateEnvelope(input: AcceptManuscriptInput): PublicationBusinessContract {
    if (typeof input.expectedInstanceId !== 'string' || input.expectedInstanceId.length === 0) {
      throw new BusinessError('invalid_input', 'expectedInstanceId must be a non-empty string');
    }
    if (!isValidRequestId(input.callerId)) {
      // Caller identity comes from authenticated configuration; a malformed
      // value here is a wiring bug, but it is still rejected, never trusted.
      throw new BusinessError('invalid_input', 'callerId is not a valid caller identifier');
    }
    if (!isValidRequestId(input.requestId)) {
      throw new BusinessError('invalid_input', 'requestId is not a valid request identifier');
    }
    if (input.expectedInstanceId !== this.instanceId) {
      // Before any write: no snapshot, operation, ledger or counter change.
      throw new BusinessError('instance_changed', 'expected instance does not match this service instance');
    }
    if (input.businessContract !== undefined && input.businessContract !== 'accepted-v2' && input.businessContract !== 'terminal-v1') {
      throw new BusinessError('invalid_input', 'business contract is not supported');
    }
    return input.businessContract ?? 'accepted-v2';
  }

  private async acceptValidated(
    input: AcceptManuscriptInput,
    businessContract: PublicationBusinessContract,
  ): Promise<AcceptanceReceipt> {
    const validated = validateManuscript(input.manuscript);
    const { canonical, digest } = canonicalizeManuscript(validated.manuscript);
    const productionCatalog = freezeProductionCatalog(validated.manuscript);

    const timezone = this.timezone;
    const clock = this.clock;
    const idSource = this.idSource;
    return this.repository.accept({
      callerId: input.callerId,
      requestId: input.requestId,
      digestHex: digest.digestHex,
      canonical,
      canonicalizationVersion: digest.canonicalizationVersion,
      digestAlgorithm: digest.algorithm,
      fieldPresence: validated.presence,
      productionCatalog,
      businessContract,
      terminalPublishBudgetMs: this.terminalPublishBudgetMs,
      channelId: this.channelForCaller(input.callerId),
      maxPendingOperations: this.maxPendingOperations,
      allocateStamp: () => {
        const epochMs = clock();
        return {
          acceptedAtIso: new Date(epochMs).toISOString(),
          localDate: localDateFor(epochMs, timezone),
        };
      },
      allocateIds: () => ({
        operationId: `op_${idSource()}`,
        manuscriptId: `ms_${idSource()}`,
      }),
    });
  }

  /**
   * Caller-scoped read-only lookup by operation ID or request ID (exactly
   * one). Another caller's operation is indistinguishable from a missing
   * one: same `not_found`, same message, no data in the error.
   */
  async lookup(query: LookupQuery): Promise<OperationView> {
    if (typeof query.expectedInstanceId !== 'string' || query.expectedInstanceId.length === 0) {
      throw new BusinessError('invalid_input', 'expectedInstanceId must be a non-empty string');
    }
    if (query.expectedInstanceId !== this.instanceId) {
      throw new BusinessError('instance_changed', 'expected instance does not match this service instance');
    }
    if (!isValidRequestId(query.callerId)) {
      throw new BusinessError('invalid_input', 'callerId is not a valid caller identifier');
    }
    const hasOperationId = query.operationId !== undefined;
    const hasRequestId = query.requestId !== undefined;
    if (hasOperationId === hasRequestId) {
      throw new BusinessError('invalid_input', 'lookup takes exactly one of operationId or requestId');
    }
    if (hasRequestId && !isValidRequestId(query.requestId)) {
      throw new BusinessError('invalid_input', 'requestId is not a valid request identifier');
    }
    const view = this.repository.lookup(query.callerId, {
      operationId: query.operationId,
      requestId: query.requestId,
    });
    if (view === null) {
      throw new BusinessError('not_found', 'operation not found for this caller');
    }
    return view;
  }

  /** Caller-scoped lookup of a terminal-v1 rejection that has no operation. */
  async lookupPreAcceptance(query: {
    expectedInstanceId: string;
    callerId: string;
    requestId: string;
  }): Promise<PreAcceptanceRejection | null> {
    if (typeof query.expectedInstanceId !== 'string' || query.expectedInstanceId.length === 0) {
      throw new BusinessError('invalid_input', 'expectedInstanceId must be a non-empty string');
    }
    if (query.expectedInstanceId !== this.instanceId) {
      throw new BusinessError('instance_changed', 'expected instance does not match this service instance');
    }
    if (!isValidRequestId(query.callerId) || !isValidRequestId(query.requestId)) {
      throw new BusinessError('invalid_input', 'callerId and requestId must be valid identifiers');
    }
    return this.repository.lookupPreAcceptance(query.callerId, query.requestId);
  }
}
