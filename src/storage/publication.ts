/**
 * SQLite implementation of the publication repository (MCP-03b).
 *
 * Every method owns one `BEGIN IMMEDIATE` transaction (or a single read);
 * state transitions happen only through these methods. Storage failures —
 * including test-injected trigger aborts — roll back and surface as
 * fixed-message `storage_unavailable`; SQL text, paths, OS messages and
 * trigger payloads never reach callers or logs.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BusinessError } from '../errors.js';
import { canonicalJsonBytes } from '../domain/canonical.js';
import { computeDeliveryWindow } from '../domain/delivery.js';
import type {
  ClaimInput,
  ClaimedJob,
  CommitAssetInput,
  AdminFailureView,
  AdminPublicationTextView,
  ExecutionFacts,
  OperationFailureCode,
  OperationStatusView,
  PublicationCommitInput,
  PublicationCommitResult,
  PublicationRepository,
  PublicationSummaryView,
  ReviewCompletionInput,
} from '../domain/publication.js';
import type { OperationStatus, PublicationBusinessContract } from '../domain/acceptance.js';

function storageUnavailable(): BusinessError {
  return new BusinessError('storage_unavailable', 'persistence layer is unavailable', true);
}

interface ClaimRow {
  operation_id: string;
  manuscript_id: string;
  caller_id: string;
  acceptance_seq: number;
  reserved_publication_id: string;
  attempt_count: number;
  canonical_blob: Uint8Array;
  request_digest_hex: string;
}

interface ExecutionRow {
  status: string;
  attempt_count: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  failure_code: string | null;
  completed_at: string | null;
  business_contract: PublicationBusinessContract;
  deadline_at: string | null;
  terminal_code: string | null;
  terminal_detail: string | null;
}

interface StatusRow extends ExecutionRow {
  operation_id: string;
  request_id: string;
  caller_id: string;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
}

export class SqlitePublicationRepository implements PublicationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly instanceId: string,
    private readonly unknownAfterRestore: ReadonlySet<string> = new Set(),
  ) {}

  claim(input: ClaimInput): ClaimedJob | null {
    try {
      const leaseExpiresAt = new Date(Date.parse(input.nowIso) + input.leaseDurationMs).toISOString();
      const db = this.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        // A processing row whose lease expired with the attempt budget
        // exhausted can never be claimed again: the process died during
        // its final attempt, so no worker path remains to terminate it.
        // Terminalize it here — durably failed with the stable
        // render_failed code and a cleared lease — inside the same
        // transaction as the claim selection below, so no later tick can
        // observe or create a claimable fourth attempt. Unexpired leases
        // and operations with attempts remaining are never touched.
        db.prepare(
          "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'render_failed', completed_at = ? " +
            "WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count >= ?",
        ).run(input.nowIso, input.nowIso, input.maxAttempts);
        // The absolute terminal-v1 budget includes time spent waiting in the
        // queue and any crashed/slow attempt. Expiry wins atomically over a
        // late worker and clears its lease, making late results uncommittable.
        db.prepare(
          "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'render_failed', terminal_code = 'deadline_exceeded', terminal_detail = 'overall publication deadline elapsed', completed_at = ? " +
            "WHERE business_contract = 'terminal-v1' AND status IN ('accepted','processing') AND deadline_at IS NOT NULL AND deadline_at <= ?",
        ).run(input.nowIso, input.nowIso);
        // Earliest acceptance sequence first; a processing row is only
        // eligible again once its lease has expired and attempts remain.
        const row = db
          .prepare(
            "SELECT operation_id, manuscript_id, caller_id, acceptance_seq, accepted_at, reserved_publication_id, attempt_count, business_contract, deadline_at FROM operation " +
              "WHERE (deadline_at IS NULL OR deadline_at > ?) AND (status = 'accepted' " +
              "   OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count < ?)) " +
              'ORDER BY acceptance_seq ASC LIMIT 1',
          )
          .get(input.nowIso, input.nowIso, input.maxAttempts) as
          | {
              operation_id: string;
              manuscript_id: string;
              caller_id: string;
              acceptance_seq: number;
              accepted_at: string;
              reserved_publication_id: string;
              attempt_count: number;
              business_contract: PublicationBusinessContract;
              deadline_at: string | null;
            }
          | undefined;
        if (row === undefined) {
          db.exec('COMMIT');
          return null;
        }
        const attempt = row.attempt_count + 1;
        db.prepare(
          "UPDATE operation SET status = 'processing', attempt_count = ?, lease_id = ?, lease_expires_at = ? WHERE operation_id = ?",
        ).run(attempt, input.leaseId, leaseExpiresAt, row.operation_id);
        const snapshot = db
          .prepare('SELECT canonical_blob, request_digest_hex, production_catalog_snapshot FROM manuscript_snapshot WHERE manuscript_id = ?')
          .get(row.manuscript_id) as { canonical_blob: Uint8Array; request_digest_hex: string; production_catalog_snapshot: string } | undefined;
        if (snapshot === undefined) {
          throw storageUnavailable();
        }
        let productionCatalogSnapshot: unknown;
        try {
          productionCatalogSnapshot = JSON.parse(snapshot.production_catalog_snapshot);
        } catch {
          throw storageUnavailable();
        }
        db.exec('COMMIT');
        const job: ClaimedJob = {
          operation_id: row.operation_id,
          manuscript_id: row.manuscript_id,
          caller_id: row.caller_id,
          acceptance_seq: row.acceptance_seq,
          accepted_at: row.accepted_at,
          reserved_publication_id: row.reserved_publication_id,
          attempt_count: attempt,
          lease_id: input.leaseId,
          lease_expires_at: leaseExpiresAt,
          canonical: snapshot.canonical_blob,
          request_digest_hex: snapshot.request_digest_hex,
          business_contract: row.business_contract,
          deadline_at: row.deadline_at,
          production_catalog_snapshot: productionCatalogSnapshot,
        };
        return job;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // transaction already ended; original error stands
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  commitPublication(input: PublicationCommitInput): PublicationCommitResult | null {
    try {
      const db = this.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        const operation = db
          .prepare(
            'SELECT operation_id, status, lease_id, manuscript_id, acceptance_seq, accepted_at, reserved_publication_id, channel_id, business_contract, deadline_at FROM operation WHERE operation_id = ?',
          )
          .get(input.operationId) as
          | {
              operation_id: string;
              status: string;
              lease_id: string | null;
              manuscript_id: string;
              acceptance_seq: number;
              accepted_at: string;
              reserved_publication_id: string;
              channel_id: string | null;
              business_contract: PublicationBusinessContract;
              deadline_at: string | null;
            }
          | undefined;
        if (operation === undefined) {
          throw storageUnavailable();
        }
        if (operation.status === 'published') {
          // Idempotent re-commit (crash after commit before the worker saw
          // the result): return the stored facts, change nothing.
          const existing = db
            .prepare('SELECT publication_id, commit_seq FROM publication WHERE operation_id = ?')
            .get(input.operationId) as { publication_id: string; commit_seq: number } | undefined;
          if (existing === undefined) {
            throw storageUnavailable();
          }
          db.exec('ROLLBACK');
          return { publication_id: existing.publication_id, commit_seq: existing.commit_seq, created: false };
        }
        if (operation.status !== 'processing' || operation.lease_id !== input.leaseId) {
          // Not ours to finish: a stale lease raced a recovered worker.
          throw storageUnavailable();
        }
        if (operation.business_contract === 'terminal-v1' && operation.deadline_at !== null && input.nowIso >= operation.deadline_at) {
          db.prepare(
            "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'render_failed', terminal_code = 'deadline_exceeded', terminal_detail = 'overall publication deadline elapsed', completed_at = ? WHERE operation_id = ? AND status = 'processing' AND lease_id = ?",
          ).run(input.nowIso, input.operationId, input.leaseId);
          db.exec('COMMIT');
          return null;
        }
        if (db.prepare('SELECT 1 FROM publication WHERE operation_id = ?').get(input.operationId) !== undefined) {
          throw storageUnavailable();
        }

        const parts = input.parts ?? (input.part === undefined ? [] : [input.part]);
        if (parts.length < 1 || parts[0]?.role !== 'main' || parts.slice(1).some((part) => part.role !== 'continuation')) {
          throw storageUnavailable();
        }
        const serializedParts = parts.map((part) => ({
          ...part,
          paperJson: Buffer.from(canonicalJsonBytes(part.paper)).toString('utf8'),
          specJson: Buffer.from(canonicalJsonBytes(part.editorialSpec)).toString('utf8'),
          provenanceJson: Buffer.from(canonicalJsonBytes(part.provenance)).toString('utf8'),
        }));
        const layoutJson = Buffer.from(canonicalJsonBytes(input.edition.layoutSnapshot)).toString('utf8');
        const deliveryJson = Buffer.from(canonicalJsonBytes(input.deliveryIntent)).toString('utf8');
        const adaptationJson =
          input.authorTitleAdaptation === null
            ? null
            : Buffer.from(canonicalJsonBytes(input.authorTitleAdaptation)).toString('utf8');

        // Schema v4 delivery window: normalized instants derived from the
        // operation's stored acceptance time and the author's spellings; the
        // query paths order by these columns, never by completion time.
        const window = computeDeliveryWindow(operation.accepted_at, input.deliverAfter, input.expiresAt);

        // Assets first: the database must never reference bytes that are not
        // on disk (the caller verified the final files before committing).
        for (const page of input.pages) for (const asset of page.assets as CommitAssetInput[]) {
          const existing = db
            .prepare('SELECT sha256, byte_length, relative_path FROM asset WHERE sha256 = ?')
            .get(asset.sha256) as { sha256: string; byte_length: number; relative_path: string } | undefined;
          if (existing === undefined) {
            db.prepare(
              'INSERT INTO asset (asset_id, sha256, kind, media_type, byte_length, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(`as_${asset.sha256.slice(0, 24)}${asset.role === 'gray4' ? 'g' : 'p'}`, asset.sha256, asset.kind, asset.mediaType, asset.byteLength, asset.relativePath, input.nowIso);
          } else if (existing.byte_length !== asset.byteLength || existing.relative_path !== asset.relativePath) {
            throw storageUnavailable();
          }
        }

        const counter = db
          .prepare('SELECT next_seq FROM publication_commit_counter WHERE singleton = 1')
          .get() as { next_seq: number } | undefined;
        if (counter === undefined) {
          throw storageUnavailable();
        }
        const commitSeq = counter.next_seq;

        db.prepare(
          'INSERT INTO publication (publication_id, operation_id, manuscript_id, request_digest_hex, acceptance_seq, commit_seq, committed_at, delivery_intent, author_title_adaptation, deliver_after, expires_at, eligible_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        ).run(
          operation.reserved_publication_id,
          input.operationId,
          operation.manuscript_id,
          (db.prepare('SELECT request_digest_hex FROM manuscript_snapshot WHERE manuscript_id = ?').get(operation.manuscript_id) as { request_digest_hex: string }).request_digest_hex,
          operation.acceptance_seq,
          commitSeq,
          input.nowIso,
          deliveryJson,
          adaptationJson,
          window.deliver_after,
          window.expires_at,
          window.eligible_at,
        );
        db.prepare('UPDATE publication_commit_counter SET next_seq = ? WHERE singleton = 1').run(commitSeq + 1);
        for (let index = 0; index < serializedParts.length; index += 1) {
          const part = serializedParts[index]!;
          db.prepare(
            'INSERT INTO publication_part (part_id, publication_id, order_index, role, genre, paper_snapshot, editorial_spec, provenance_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(part.id, operation.reserved_publication_id, index, part.role, part.genre, part.paperJson, part.specJson, part.provenanceJson);
        }
        db.prepare(
          'INSERT INTO render_edition (edition_id, publication_id, edition_seq, profile, renderer_build, renderer_version, chromium_version, playwright_version, fonts_manifest_version, fonts_file_count, layout_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          input.edition.id,
          operation.reserved_publication_id,
          input.edition.seq,
          input.edition.profile,
          input.edition.rendererBuild,
          input.edition.rendererVersion,
          input.edition.chromiumVersion,
          input.edition.playwrightVersion,
          input.edition.fontsManifestVersion,
          input.edition.fontsFileCount,
          layoutJson,
          input.nowIso,
        );
        db.prepare('INSERT INTO publication_default_edition (publication_id, edition_id) VALUES (?, ?)').run(
          operation.reserved_publication_id,
          input.edition.id,
        );
        if (operation.channel_id !== null) {
          const deliveryId = `del_${createHash('sha256')
            .update(`${operation.channel_id}\0${operation.reserved_publication_id}`, 'utf8')
            .digest('hex')
            .slice(0, 32)}`;
          db.prepare(
            'INSERT INTO publication_channel (channel_id, publication_id, delivery_id, routed_at) VALUES (?, ?, ?, ?)',
          ).run(operation.channel_id, operation.reserved_publication_id, deliveryId, input.nowIso);
          db.prepare('UPDATE device_channel SET library_revision = library_revision + 1 WHERE channel_id = ?')
            .run(operation.channel_id);
        }
        for (const page of input.pages) {
          const part = serializedParts[page.partIndex ?? 0];
          if (part === undefined) throw storageUnavailable();
          db.prepare('INSERT INTO render_page (page_id, edition_id, part_id, page_index, width, height) VALUES (?, ?, ?, ?, ?, ?)').run(
            page.id,
            input.edition.id,
            part.id,
            page.index,
            page.width,
            page.height,
          );
          for (const asset of page.assets) {
            const assetRow = db.prepare('SELECT asset_id FROM asset WHERE sha256 = ?').get(asset.sha256) as { asset_id: string };
            db.prepare('INSERT INTO page_asset (page_id, asset_id, role) VALUES (?, ?, ?)').run(page.id, assetRow.asset_id, asset.role);
          }
        }
        db.prepare(
          "UPDATE operation SET status = 'published', lease_id = NULL, lease_expires_at = NULL, failure_code = NULL, completed_at = ? WHERE operation_id = ?",
        ).run(input.nowIso, input.operationId);
        db.exec('COMMIT');
        return { publication_id: operation.reserved_publication_id, commit_seq: commitSeq, created: true };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // transaction already ended; original error stands
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  releaseForRetry(operationId: string, leaseId: string, nowIso: string): void {
    try {
      const result = this.db
        .prepare(
          "UPDATE operation SET lease_id = NULL, lease_expires_at = ? WHERE operation_id = ? AND status = 'processing' AND lease_id = ?",
        )
        .run(nowIso, operationId, leaseId);
      if (result.changes !== 1) {
        throw storageUnavailable();
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  failOperation(operationId: string, leaseId: string, code: OperationFailureCode, nowIso: string, detail?: string): void {
    try {
      const result = this.db
        .prepare(
          "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = ?, terminal_detail = ?, completed_at = ? WHERE operation_id = ? AND status = 'processing' AND lease_id = ?",
        )
        .run(code, detail ?? null, nowIso, operationId, leaseId);
      if (result.changes !== 1) {
        throw storageUnavailable();
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  expireOperation(operationId: string, nowIso: string): boolean {
    try {
      const result = this.db
        .prepare(
          "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'render_failed', terminal_code = 'deadline_exceeded', terminal_detail = 'overall publication deadline elapsed', completed_at = ? " +
            "WHERE operation_id = ? AND business_contract = 'terminal-v1' AND status IN ('accepted','processing') AND deadline_at IS NOT NULL AND deadline_at <= ?",
        )
        .run(nowIso, operationId, nowIso);
      return result.changes === 1;
    } catch {
      throw storageUnavailable();
    }
  }

  completeReview(input: ReviewCompletionInput): void {
    try {
      const snapshotJson = Buffer.from(canonicalJsonBytes(input.snapshot)).toString('utf8');
      const db = this.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        const owned = db
          .prepare("SELECT 1 FROM operation WHERE operation_id = ? AND status = 'processing' AND lease_id = ?")
          .get(input.operationId, input.leaseId);
        if (owned === undefined) {
          throw storageUnavailable();
        }
        if (input.terminalCode === undefined) {
          if (input.status !== 'approved') {
            throw storageUnavailable();
          }
          db.prepare(
            "UPDATE operation SET review_status = 'approved', review_snapshot = ? WHERE operation_id = ? AND status = 'processing' AND lease_id = ?",
          ).run(snapshotJson, input.operationId, input.leaseId);
        } else {
          db.prepare(
            "UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'render_failed', terminal_code = ?, terminal_detail = ?, review_status = ?, review_snapshot = ?, completed_at = ? " +
              "WHERE operation_id = ? AND status = 'processing' AND lease_id = ?",
          ).run(
            input.terminalCode,
            input.terminalDetail ?? 'typesetter review did not approve publication',
            input.status,
            snapshotJson,
            input.nowIso,
            input.operationId,
            input.leaseId,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // original error stands
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  statusForCaller(
    callerId: string,
    query: { operationId?: string; requestId?: string },
  ): OperationStatusView | null {
    try {
      let row: StatusRow | undefined;
      const base =
        'SELECT o.operation_id, o.status, o.attempt_count, o.lease_id, o.lease_expires_at, o.failure_code, o.completed_at, o.business_contract, o.deadline_at, o.terminal_code, o.terminal_detail, o.caller_id, o.acceptance_seq, o.accepted_at, o.reserved_publication_id, l.request_id ' +
        'FROM operation o JOIN request_ledger l ON l.operation_id = o.operation_id ';
      if (query.operationId !== undefined) {
        row = this.db.prepare(`${base} WHERE o.operation_id = ? AND o.caller_id = ?`).get(query.operationId, callerId) as
          | StatusRow
          | undefined;
      } else if (query.requestId !== undefined) {
        row = this.db
          .prepare(`${base} WHERE l.instance_id = ? AND l.caller_id = ? AND l.request_id = ?`)
          .get(this.instanceId, callerId, query.requestId) as StatusRow | undefined;
      } else {
        return null;
      }
      if (row === undefined) {
        // Another caller's operation is indistinguishable from a missing one.
        return null;
      }
      const restoredUnknown = this.unknownAfterRestore.has(row.operation_id);
      let publication: PublicationSummaryView | null = null;
      if (!restoredUnknown && row.status === 'published') {
        publication = this.loadSummary(row.operation_id);
        if (publication === null) {
          throw storageUnavailable();
        }
      }
      return {
        instance_id: this.instanceId,
        operation_id: row.operation_id,
        request_id: row.request_id,
        caller_id: row.caller_id,
        status: restoredUnknown ? 'unknown_after_restore' : (row.status as OperationStatus),
        acceptance_seq: row.acceptance_seq,
        accepted_at: row.accepted_at,
        reserved_publication_id: row.reserved_publication_id,
        attempt_count: row.attempt_count,
        failure_code: restoredUnknown
          ? 'unknown_after_restore'
          : row.status === 'failed'
            ? ((row.terminal_code as OperationStatusView['failure_code']) ?? (row.failure_code as OperationFailureCode | null) ?? 'render_failed')
            : null,
        business_contract: row.business_contract,
        deadline_at: row.deadline_at,
        terminal_detail: row.terminal_detail,
        publication,
      };
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private loadSummary(operationId: string): PublicationSummaryView | null {
    const db = this.db;
    const publicationRow = db
      .prepare('SELECT publication_id, commit_seq FROM publication WHERE operation_id = ?')
      .get(operationId) as { publication_id: string; commit_seq: number } | undefined;
    if (publicationRow === undefined) {
      return null;
    }
    const editionRow = db
      .prepare(
        'SELECT e.edition_id, e.profile, e.renderer_build, e.renderer_version, e.chromium_version, e.playwright_version, e.fonts_manifest_version, e.fonts_file_count FROM publication_default_edition d JOIN render_edition e ON e.edition_id = d.edition_id WHERE d.publication_id = ?',
      )
      .get(publicationRow.publication_id) as
      | {
          edition_id: string;
          profile: string;
          renderer_build: string;
          renderer_version: string;
          chromium_version: string;
          playwright_version: string;
          fonts_manifest_version: number;
          fonts_file_count: number;
        }
      | undefined;
    if (editionRow === undefined) {
      return null;
    }
    const pageRows = db
      .prepare(
        'SELECT p.page_id, p.page_index, p.width, p.height FROM render_page p WHERE p.edition_id = ? ORDER BY p.page_index ASC',
      )
      .all(editionRow.edition_id) as { page_id: string; page_index: number; width: number; height: number }[];
    const pages = pageRows.map((page) => {
      const assets = db
        .prepare(
          'SELECT a.sha256, a.byte_length, a.kind, pa.role FROM page_asset pa JOIN asset a ON a.asset_id = pa.asset_id WHERE pa.page_id = ?',
        )
        .all(page.page_id) as { sha256: string; byte_length: number; kind: string; role: string }[];
      return {
        page_id: page.page_id,
        page_index: page.page_index,
        width: page.width,
        height: page.height,
        assets: assets.map((asset) => ({
          role: asset.role as 'primary' | 'gray4',
          kind: asset.kind as 'png' | 'gray4',
          sha256: asset.sha256,
          bytes: asset.byte_length,
        })),
      };
    });
    return {
      publication_id: publicationRow.publication_id,
      commit_seq: publicationRow.commit_seq,
      edition_id: editionRow.edition_id,
      profile: editionRow.profile,
      target: { width: pageRows[0]?.width ?? 0, height: pageRows[0]?.height ?? 0 },
      renderer: {
        build: editionRow.renderer_build,
        version: editionRow.renderer_version,
        chromium: editionRow.chromium_version,
        playwright: editionRow.playwright_version,
        fonts_manifest_version: editionRow.fonts_manifest_version,
        fonts_file_count: editionRow.fonts_file_count,
      },
      pages,
    };
  }

  executionFacts(operationId: string): ExecutionFacts | null {
    try {
      const row = this.db
        .prepare('SELECT status, attempt_count, lease_id, lease_expires_at, failure_code, completed_at, business_contract, deadline_at, terminal_code, terminal_detail FROM operation WHERE operation_id = ?')
        .get(operationId) as ExecutionRow | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        status: this.unknownAfterRestore.has(operationId)
          ? 'unknown_after_restore'
          : (row.status as ExecutionFacts['status']),
        attempt_count: row.attempt_count,
        lease_id: row.lease_id,
        lease_expires_at: row.lease_expires_at,
        failure_code: this.unknownAfterRestore.has(operationId)
          ? 'unknown_after_restore'
          : ((row.terminal_code as ExecutionFacts['failure_code']) ?? (row.failure_code as OperationFailureCode | null) ?? null),
        business_contract: row.business_contract,
        deadline_at: row.deadline_at,
        completed_at: row.completed_at,
      };
    } catch {
      throw storageUnavailable();
    }
  }

  adminRecentFailures(limit: number): AdminFailureView[] {
    try {
      return this.db.prepare(
        `SELECT reserved_publication_id AS reference, caller_id, accepted_at,
                COALESCE(terminal_code, failure_code, 'failed') AS code, terminal_detail AS detail
         FROM operation WHERE status = 'failed'
         ORDER BY COALESCE(completed_at, accepted_at) DESC, acceptance_seq DESC LIMIT ?`,
      ).all(limit) as unknown as AdminFailureView[];
    } catch {
      throw storageUnavailable();
    }
  }

  adminPublicationText(publicationId: string, callerId: string): AdminPublicationTextView | null {
    try {
      const rows = this.db.prepare(
        `SELECT part.provenance_snapshot
         FROM publication p
         JOIN operation o ON o.operation_id = p.operation_id
         JOIN publication_part part ON part.publication_id = p.publication_id
         WHERE p.publication_id = ? AND o.caller_id = ?
         ORDER BY part.order_index`,
      ).all(publicationId, callerId) as Array<{ provenance_snapshot: string }>;
      if (rows.length === 0) return null;
      const additions: Array<{ path: string; value: string }> = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const provenance = JSON.parse(row.provenance_snapshot) as {
          editor?: { additions?: Array<{ path?: unknown; value?: unknown }> };
        };
        for (const addition of provenance.editor?.additions ?? []) {
          if (typeof addition.path !== 'string' || typeof addition.value !== 'string') continue;
          const identity = `${addition.path}\u0000${addition.value}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          additions.push({ path: addition.path, value: addition.value });
        }
      }
      return { editor_additions: additions };
    } catch {
      throw storageUnavailable();
    }
  }

  publicationCounts(): {
    publication: number;
    part: number;
    edition: number;
    page: number;
    asset: number;
    pageAsset: number;
    nextCommitSeq: number;
  } {
    try {
      const one = (table: string): number =>
        (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        publication: one('publication'),
        part: one('publication_part'),
        edition: one('render_edition'),
        page: one('render_page'),
        asset: one('asset'),
        pageAsset: one('page_asset'),
        nextCommitSeq: (this.db.prepare('SELECT next_seq FROM publication_commit_counter WHERE singleton = 1').get() as { next_seq: number }).next_seq,
      };
    } catch {
      throw storageUnavailable();
    }
  }

  referencedAssetPaths(): string[] {
    try {
      return (
        this.db
          .prepare('SELECT relative_path FROM asset WHERE asset_id IN (SELECT asset_id FROM page_asset)')
          .all() as { relative_path: string }[]
      )
        .map((row) => row.relative_path)
        .sort();
    } catch {
      throw storageUnavailable();
    }
  }
}
