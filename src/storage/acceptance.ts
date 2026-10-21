/**
 * SQLite implementation of the acceptance repository (MCP-03a).
 *
 * All SQL of the persistent acceptance domain lives here; no MCP handler ever
 * sees raw SQL. One acceptance runs inside a single `BEGIN IMMEDIATE`
 * transaction (see src/domain/acceptance.ts for the step semantics).
 *
 * Error mapping contract:
 *  - business outcomes (replay, conflict, queue_full) are returned/thrown as
 *    BusinessError and never touch the storage mapping;
 *  - every SQLite/disk failure — including test-injected trigger aborts —
 *    rolls the transaction back and surfaces as a fixed-message
 *    `storage_unavailable`; SQL text, paths, OS messages and trigger
 *    payloads are never echoed.
 */

import { DatabaseSync } from 'node:sqlite';
import { BusinessError } from '../errors.js';
import { canonicalJsonBytes } from '../domain/canonical.js';
import { productionCatalogSnapshotJson } from '../production-catalog.js';
import {
  formatDailyNumber,
  type AcceptanceFacts,
  type AcceptanceIds,
  type AcceptanceReceipt,
  type AcceptanceRepository,
  type OperationView,
  type PreAcceptanceRejection,
  type PreAcceptanceRejectionFacts,
} from '../domain/acceptance.js';

/** Bounded retries when a freshly generated random ID collides with a row. */
const ID_COLLISION_RETRIES = 4;

interface LedgerRow {
  request_digest_hex: string;
  operation_id: string;
}

interface OperationRow {
  operation_id: string;
  status: string;
  caller_id: string;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  reserved_local_date: string;
  business_contract: AcceptanceReceipt['business_contract'];
  deadline_at: string | null;
}

interface OperationViewRow extends OperationRow {
  request_id: string;
  request_digest_hex: string;
}

interface PreAcceptanceRejectionRow {
  request_digest_hex: string;
  business_contract: 'terminal-v1';
  failure_code: PreAcceptanceRejection['failure']['code'];
  failure_message: string;
  rejected_at: string;
}

function storageUnavailable(): BusinessError {
  // Fixed message: the underlying SQLite error may contain SQL text, paths,
  // or trigger payloads — none of that may reach callers or logs.
  return new BusinessError('storage_unavailable', 'persistence layer is unavailable', true);
}

export class SqliteAcceptanceRepository implements AcceptanceRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly instanceId: string,
    private readonly unknownAfterRestore: ReadonlySet<string> = new Set(),
  ) {}

  accept(facts: AcceptanceFacts): AcceptanceReceipt {
    try {
      return this.acceptInTransaction(facts);
    } catch (error) {
      if (error instanceof BusinessError) {
        // Business outcomes pass through untouched (conflict / queue_full /
        // storage_unavailable already mapped below).
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private acceptInTransaction(facts: AcceptanceFacts): AcceptanceReceipt {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // A terminal-v1 request rejected before acceptance is already final.
      // It owns the same caller/request namespace as the ordinary ledger, so
      // a later valid-looking request cannot spend IDs or publish under it.
      const priorRejection = db
        .prepare('SELECT request_digest_hex, business_contract FROM preacceptance_rejection WHERE instance_id = ? AND caller_id = ? AND request_id = ?')
        .get(this.instanceId, facts.callerId, facts.requestId) as
          | Pick<PreAcceptanceRejectionRow, 'request_digest_hex' | 'business_contract'>
          | undefined;
      if (priorRejection !== undefined) {
        throw new BusinessError(
          'idempotency_conflict',
          priorRejection.request_digest_hex === facts.digestHex && priorRejection.business_contract === facts.businessContract
            ? 'request id already has a final pre-acceptance rejection'
            : 'request id was already used with different input',
        );
      }

      // (2) Ledger first, under the write lock.
      const existing = db
        .prepare('SELECT request_digest_hex, operation_id FROM request_ledger WHERE instance_id = ? AND caller_id = ? AND request_id = ?')
        .get(this.instanceId, facts.callerId, facts.requestId) as LedgerRow | undefined;
      if (existing !== undefined) {
        if (existing.request_digest_hex !== facts.digestHex) {
          throw new BusinessError(
            'idempotency_conflict',
            'request id was already used with different input',
          );
        }
        const operation = db
          .prepare('SELECT operation_id, status, caller_id, acceptance_seq, accepted_at, reserved_publication_id, reserved_local_date, business_contract, deadline_at FROM operation WHERE operation_id = ?')
          .get(existing.operation_id) as OperationRow | undefined;
        if (operation === undefined) {
          // Ledger and operation rows are written in one transaction; a
          // ledger entry without its operation is database corruption.
          throw storageUnavailable();
        }
        if (operation.business_contract !== facts.businessContract) {
          throw new BusinessError('idempotency_conflict', 'request id was already used with a different business contract');
        }
        db.exec('ROLLBACK');
        // Replay works even when the queue is full: no counter is touched.
        // The receipt carries the operation's CURRENT status — a replay after
        // the worker picked the job up reports processing/published/failed.
        return {
          instance_id: this.instanceId,
          operation_id: operation.operation_id,
          status: this.unknownAfterRestore.has(operation.operation_id)
            ? 'unknown_after_restore'
            : (operation.status as AcceptanceReceipt['status']),
          accepted: true,
          acceptance_seq: operation.acceptance_seq,
          accepted_at: operation.accepted_at,
          reserved_publication_id: operation.reserved_publication_id,
          business_contract: operation.business_contract,
          deadline_at: operation.deadline_at,
          replayed: true,
        };
      }

      // (3) Capacity check on ordinary pending work, inside the transaction.
      const pending = db
        .prepare("SELECT count(*) AS n FROM operation WHERE status IN ('accepted', 'processing')")
        .get() as { n: number };
      if (pending.n >= facts.maxPendingOperations) {
        throw new BusinessError('queue_full', 'pending operation limit reached', true);
      }

      // (4) Global sequence from the persistent counter; one clock sample
      // gives accepted_at and the local date.
      const counter = db
        .prepare('SELECT next_seq FROM acceptance_counter WHERE singleton = 1')
        .get() as { next_seq: number } | undefined;
      if (counter === undefined) {
        throw storageUnavailable();
      }
      const acceptanceSeq = counter.next_seq;
      const stamp = facts.allocateStamp();
      const deadlineAt = facts.businessContract === 'terminal-v1'
        ? new Date(Date.parse(stamp.acceptedAtIso) + facts.terminalPublishBudgetMs).toISOString()
        : null;

      // (5) Per-local-date reservation: YYYY-MM-DD-NN.
      const dateCounter = db
        .prepare('SELECT last_number FROM publication_counter WHERE local_date = ?')
        .get(stamp.localDate) as { last_number: number } | undefined;
      const dailyNumber = (dateCounter?.last_number ?? 0) + 1;
      const reservedPublicationId = `${stamp.localDate}-${formatDailyNumber(dailyNumber)}`;

      // (6) Insert snapshot, operation and ledger; the unique constraints are
      // the last line of defense even if a same-key race somehow got here.
      const presenceJson = Buffer.from(canonicalJsonBytes(facts.fieldPresence)).toString('utf8');
      let usedIds: AcceptanceIds | undefined;
      for (let attempts = 0; ; attempts += 1) {
        const ids = facts.allocateIds();
        const occupied =
          db.prepare('SELECT 1 FROM manuscript_snapshot WHERE manuscript_id = ?').get(ids.manuscriptId) !==
            undefined ||
          db.prepare('SELECT 1 FROM operation WHERE operation_id = ?').get(ids.operationId) !== undefined;
        if (!occupied) {
          usedIds = ids;
          db.prepare(
            'INSERT INTO manuscript_snapshot (manuscript_id, canonicalization_version, digest_algorithm, request_digest_hex, canonical_blob, field_presence, created_at, production_catalog_revision, production_catalog_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            ids.manuscriptId,
            facts.canonicalizationVersion,
            facts.digestAlgorithm,
            facts.digestHex,
            facts.canonical,
            presenceJson,
            stamp.acceptedAtIso,
            facts.productionCatalog.revision,
            productionCatalogSnapshotJson(facts.productionCatalog),
          );
          db.prepare(
            "INSERT INTO operation (operation_id, status, caller_id, manuscript_id, acceptance_seq, accepted_at, reserved_publication_id, reserved_local_date, channel_id, business_contract, deadline_at, review_status) VALUES (?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            ids.operationId,
            facts.callerId,
            ids.manuscriptId,
            acceptanceSeq,
            stamp.acceptedAtIso,
            reservedPublicationId,
            stamp.localDate,
            facts.channelId,
            facts.businessContract,
            deadlineAt,
            facts.businessContract === 'terminal-v1' ? 'deterministic_only' : 'not_requested',
          );
          db.prepare(
            'INSERT INTO request_ledger (instance_id, caller_id, request_id, request_digest_hex, canonicalization_version, digest_algorithm, operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            this.instanceId,
            facts.callerId,
            facts.requestId,
            facts.digestHex,
            facts.canonicalizationVersion,
            facts.digestAlgorithm,
            ids.operationId,
            stamp.acceptedAtIso,
          );
          break;
        }
        // Astronomically unlikely high-entropy collision: bounded retry, and
        // the primary keys still guard against overwriting an old row.
        if (attempts + 1 >= ID_COLLISION_RETRIES) {
          throw storageUnavailable();
        }
      }
      if (usedIds === undefined) {
        throw storageUnavailable();
      }

      // Commit both counter updates with the facts, atomically.
      db.prepare('UPDATE acceptance_counter SET next_seq = ? WHERE singleton = 1').run(acceptanceSeq + 1);
      if (dateCounter === undefined) {
        db.prepare('INSERT INTO publication_counter (local_date, last_number) VALUES (?, ?)').run(
          stamp.localDate,
          dailyNumber,
        );
      } else {
        db.prepare('UPDATE publication_counter SET last_number = ? WHERE local_date = ?').run(
          dailyNumber,
          stamp.localDate,
        );
      }

      db.exec('COMMIT');
      return {
        instance_id: this.instanceId,
        operation_id: usedIds.operationId,
        status: 'accepted',
        accepted: true,
        acceptance_seq: acceptanceSeq,
        accepted_at: stamp.acceptedAtIso,
        reserved_publication_id: reservedPublicationId,
        business_contract: facts.businessContract,
        deadline_at: deadlineAt,
        replayed: false,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already have ended; the original error stands.
      }
      if (error instanceof BusinessError) {
        throw error;
      }
      // Storage failure (including trigger aborts): everything above —
      // snapshot, ledger, operation rows and both counters — is rolled back.
      throw storageUnavailable();
    }
  }

  rejectPreAcceptance(facts: PreAcceptanceRejectionFacts): PreAcceptanceRejection {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db
          .prepare(
            'SELECT request_digest_hex, business_contract, failure_code, failure_message, rejected_at ' +
              'FROM preacceptance_rejection WHERE instance_id = ? AND caller_id = ? AND request_id = ?',
          )
          .get(this.instanceId, facts.callerId, facts.requestId) as PreAcceptanceRejectionRow | undefined;
        if (existing !== undefined) {
          if (existing.request_digest_hex !== facts.digestHex || existing.business_contract !== facts.businessContract) {
            throw new BusinessError('idempotency_conflict', 'request id was already used with different input');
          }
          db.exec('ROLLBACK');
          return {
            instance_id: this.instanceId,
            request_id: facts.requestId,
            business_contract: 'terminal-v1',
            accepted: false,
            outcome: 'rejected',
            phase: 'pre-acceptance',
            rejected_at: existing.rejected_at,
            failure: {
              category: 'manuscript',
              code: existing.failure_code,
              message: existing.failure_message,
              retryable: false,
            },
            replayed: true,
          };
        }

        // Both ledgers share one logical idempotency namespace. An accepted
        // operation always wins as the prior use of the key, regardless of
        // whether a future validator would classify its input differently.
        const accepted = db
          .prepare(
            'SELECT l.request_digest_hex, o.business_contract FROM request_ledger l ' +
              'JOIN operation o ON o.operation_id = l.operation_id ' +
              'WHERE l.instance_id = ? AND l.caller_id = ? AND l.request_id = ?',
          )
          .get(this.instanceId, facts.callerId, facts.requestId) as
            | { request_digest_hex: string; business_contract: AcceptanceReceipt['business_contract'] }
            | undefined;
        if (accepted !== undefined) {
          throw new BusinessError(
            'idempotency_conflict',
            accepted.request_digest_hex === facts.digestHex && accepted.business_contract === facts.businessContract
              ? 'request id already belongs to an accepted operation'
              : 'request id was already used with different input',
          );
        }

        db.prepare(
          'INSERT INTO preacceptance_rejection ' +
            '(instance_id, caller_id, request_id, request_digest_hex, canonicalization_version, digest_algorithm, business_contract, failure_code, failure_message, rejected_at) ' +
            "VALUES (?, ?, ?, ?, 1, 'sha-256', ?, ?, ?, ?)",
        ).run(
          this.instanceId,
          facts.callerId,
          facts.requestId,
          facts.digestHex,
          facts.businessContract,
          facts.failureCode,
          facts.failureMessage,
          facts.rejectedAt,
        );
        db.exec('COMMIT');
        return {
          instance_id: this.instanceId,
          request_id: facts.requestId,
          business_contract: 'terminal-v1',
          accepted: false,
          outcome: 'rejected',
          phase: 'pre-acceptance',
          rejected_at: facts.rejectedAt,
          failure: {
            category: 'manuscript',
            code: facts.failureCode,
            message: facts.failureMessage,
            retryable: false,
          },
          replayed: false,
        };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the original failure.
        }
        if (error instanceof BusinessError) {
          throw error;
        }
        throw storageUnavailable();
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  lookupPreAcceptance(callerId: string, requestId: string): PreAcceptanceRejection | null {
    try {
      const row = this.db
        .prepare(
          'SELECT request_digest_hex, business_contract, failure_code, failure_message, rejected_at ' +
            'FROM preacceptance_rejection WHERE instance_id = ? AND caller_id = ? AND request_id = ?',
        )
        .get(this.instanceId, callerId, requestId) as PreAcceptanceRejectionRow | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        instance_id: this.instanceId,
        request_id: requestId,
        business_contract: 'terminal-v1',
        accepted: false,
        outcome: 'rejected',
        phase: 'pre-acceptance',
        rejected_at: row.rejected_at,
        failure: {
          category: 'manuscript',
          code: row.failure_code,
          message: row.failure_message,
          retryable: false,
        },
        replayed: true,
      };
    } catch {
      throw storageUnavailable();
    }
  }

  lookup(callerId: string, query: { operationId?: string; requestId?: string }): OperationView | null {
    try {
      let row: OperationViewRow | undefined;
      if (query.operationId !== undefined) {
        row = this.db
          .prepare(
            'SELECT o.operation_id, o.status, o.caller_id, o.acceptance_seq, o.accepted_at, o.reserved_publication_id, o.reserved_local_date, l.request_id, l.request_digest_hex ' +
              'FROM operation o JOIN request_ledger l ON l.operation_id = o.operation_id ' +
              'WHERE o.operation_id = ? AND o.caller_id = ?',
          )
          .get(query.operationId, callerId) as OperationViewRow | undefined;
      } else if (query.requestId !== undefined) {
        row = this.db
          .prepare(
            'SELECT o.operation_id, o.status, o.caller_id, o.acceptance_seq, o.accepted_at, o.reserved_publication_id, o.reserved_local_date, l.request_id, l.request_digest_hex ' +
              'FROM request_ledger l JOIN operation o ON o.operation_id = l.operation_id ' +
              'WHERE l.instance_id = ? AND l.caller_id = ? AND l.request_id = ?',
          )
          .get(this.instanceId, callerId, query.requestId) as OperationViewRow | undefined;
      } else {
        // Neither key given: nothing to find.
        return null;
      }
      if (row === undefined) {
        // Another caller's operation is indistinguishable from a missing one.
        return null;
      }
      return {
        instance_id: this.instanceId,
        operation_id: row.operation_id,
        request_id: row.request_id,
        caller_id: row.caller_id,
        status: this.unknownAfterRestore.has(row.operation_id)
          ? 'unknown_after_restore'
          : (row.status as OperationView['status']),
        acceptance_seq: row.acceptance_seq,
        accepted_at: row.accepted_at,
        reserved_publication_id: row.reserved_publication_id,
        reserved_local_date: row.reserved_local_date,
        request_digest_hex: row.request_digest_hex,
      };
    } catch {
      throw storageUnavailable();
    }
  }

  factCounts(): { ledger: number; operation: number; snapshot: number; pending: number } {
    try {
      const one = (table: string): number =>
        (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      const pending = (
        this.db
          .prepare("SELECT count(*) AS n FROM operation WHERE status IN ('accepted', 'processing')")
          .get() as { n: number }
      ).n;
      return {
        ledger: one('request_ledger'),
        operation: one('operation'),
        snapshot: one('manuscript_snapshot'),
        pending,
      };
    } catch {
      throw storageUnavailable();
    }
  }

  counterState(): { nextAcceptanceSeq: number; publicationCounters: Record<string, number> } {
    try {
      const next = (this.db.prepare('SELECT next_seq FROM acceptance_counter WHERE singleton = 1').get() as {
        next_seq: number;
      }).next_seq;
      const rows = this.db.prepare('SELECT local_date, last_number FROM publication_counter').all() as {
        local_date: string;
        last_number: number;
      }[];
      const publicationCounters: Record<string, number> = {};
      for (const row of rows) {
        publicationCounters[row.local_date] = row.last_number;
      }
      return {
        nextAcceptanceSeq: next,
        publicationCounters,
      };
    } catch {
      throw storageUnavailable();
    }
  }
}
