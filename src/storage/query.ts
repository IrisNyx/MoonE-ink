/**
 * SQLite implementation of the MCP-04 query/withdraw repository.
 *
 * Read methods are single SELECT/JOIN round trips; `withdraw` owns one
 * `BEGIN IMMEDIATE` transaction covering the ledger replay/conflict check,
 * the caller-scoped publication lookup, the conditional first `withdrawn_at`
 * write and the ledger insert. Storage failures — including test-injected
 * trigger aborts — roll back and surface as fixed-message
 * `storage_unavailable`; SQL text, paths, OS messages and trigger payloads
 * never reach callers or logs. All time comparisons run on the normalized
 * UTC instant strings persisted by schema v4 (see src/domain/delivery.ts),
 * so text ordering IS instant ordering.
 */

import { DatabaseSync } from 'node:sqlite';
import { BusinessError } from '../errors.js';
import { STORED_GENRE_CONTENT_SCHEMA, contentDisplayText } from '../domain/genre-content.js';
import type {
  CursorRecord,
  PublicationRecordView,
  QueryRepository,
  AuthorWorkView,
  WithdrawLedgerRow,
  WithdrawOutcome,
} from '../domain/query.js';
import type { PublicationSummaryView } from '../domain/publication.js';

function storageUnavailable(): BusinessError {
  return new BusinessError('storage_unavailable', 'persistence layer is unavailable', true);
}

interface PublicationQueryRow {
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
}

interface CursorRow {
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

const PUBLICATION_SELECT =
  'SELECT p.publication_id AS publication_id, p.operation_id AS operation_id, p.commit_seq AS commit_seq, p.acceptance_seq AS acceptance_seq, ' +
  'o.accepted_at AS accepted_at, p.committed_at AS committed_at, p.deliver_after AS deliver_after, ' +
  'p.eligible_at AS eligible_at, p.expires_at AS expires_at, p.withdrawn_at AS withdrawn_at ' +
  'FROM publication p JOIN operation o ON o.operation_id = p.operation_id';

export class SqliteQueryRepository implements QueryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly instanceId: string,
  ) {}

  commitHighWater(): number {
    try {
      const row = this.db.prepare('SELECT COALESCE(MAX(commit_seq), 0) AS high FROM publication').get() as {
        high: number;
      };
      return row.high;
    } catch {
      throw storageUnavailable();
    }
  }

  historyPage(
    callerId: string,
    highWater: number,
    beforeAcceptanceSeq: number | null,
    limit: number,
  ): PublicationRecordView[] {
    try {
      let rows: PublicationQueryRow[];
      if (beforeAcceptanceSeq === null) {
        rows = this.db
          .prepare(`${PUBLICATION_SELECT} WHERE o.caller_id = ? AND p.commit_seq <= ? ORDER BY p.acceptance_seq DESC LIMIT ?`)
          .all(callerId, highWater, limit) as unknown as PublicationQueryRow[];
      } else {
        rows = this.db
          .prepare(
            `${PUBLICATION_SELECT} WHERE o.caller_id = ? AND p.commit_seq <= ? AND p.acceptance_seq < ? ORDER BY p.acceptance_seq DESC LIMIT ?`,
          )
          .all(callerId, highWater, beforeAcceptanceSeq, limit) as unknown as PublicationQueryRow[];
      }
      return rows.map((row) => this.withSummary(row));
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  latestEligibleOffer(callerId: string, nowIso: string): PublicationRecordView | null {
    try {
      // Boundary rules: eligible_at <= now is deliverable (inclusive);
      // expires_at <= now is expired, so eligibility requires expires_at > now
      // (exclusive). withdrawn_at is NULL for every eligible candidate.
      const row = this.db
        .prepare(
          `${PUBLICATION_SELECT} WHERE o.caller_id = ? AND p.withdrawn_at IS NULL ` +
            'AND (p.expires_at IS NULL OR p.expires_at > ?) AND p.eligible_at <= ? ' +
            'ORDER BY p.eligible_at DESC, p.acceptance_seq DESC LIMIT 1',
        )
        .get(callerId, nowIso, nowIso) as PublicationQueryRow | undefined;
      return row === undefined ? null : this.withSummary(row);
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  findCursorByDigest(digestHex: string, callerId: string): CursorRecord | null {
    try {
      const row = this.db
        .prepare(
          'SELECT cursor_id, instance_id, caller_id, cursor_digest, snapshot_high_water, last_acceptance_seq, page_size, created_at, expires_at ' +
            'FROM history_cursor WHERE cursor_digest = ? AND caller_id = ? AND instance_id = ?',
        )
        .get(digestHex, callerId, this.instanceId) as CursorRow | undefined;
      return row === undefined ? null : { ...row };
    } catch {
      throw storageUnavailable();
    }
  }

  insertCursor(record: CursorRecord): void {
    try {
      this.db
        .prepare(
          'INSERT INTO history_cursor (cursor_id, instance_id, caller_id, cursor_digest, snapshot_high_water, last_acceptance_seq, page_size, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.cursor_id,
          record.instance_id,
          record.caller_id,
          record.cursor_digest,
          record.snapshot_high_water,
          record.last_acceptance_seq,
          record.page_size,
          record.created_at,
          record.expires_at,
        );
    } catch {
      throw storageUnavailable();
    }
  }

  withdraw(input: { callerId: string; requestId: string; publicationId: string; nowIso: string }): WithdrawOutcome {
    try {
      const db = this.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        // (1) Ledger replay / conflict under the write lock.
        const ledger = db
          .prepare('SELECT publication_id, withdrawn_at FROM withdraw_ledger WHERE instance_id = ? AND caller_id = ? AND request_id = ?')
          .get(this.instanceId, input.callerId, input.requestId) as { publication_id: string; withdrawn_at: string } | undefined;
        if (ledger !== undefined) {
          if (ledger.publication_id !== input.publicationId) {
            throw new BusinessError('idempotency_conflict', 'request id was already used with different input');
          }
          db.exec('ROLLBACK');
          return {
            publication_id: ledger.publication_id,
            withdrawn_at: ledger.withdrawn_at,
            already_withdrawn: true,
            replayed: true,
          };
        }

        // (2) Caller-scoped publication lookup. Another caller's publication
        // is indistinguishable from a missing one — same not_found, no data.
        const publication = db
          .prepare(
            'SELECT p.withdrawn_at AS withdrawn_at, o.caller_id AS caller_id FROM publication p JOIN operation o ON o.operation_id = p.operation_id WHERE p.publication_id = ?',
          )
          .get(input.publicationId) as { withdrawn_at: string | null; caller_id: string } | undefined;
        if (publication === undefined || publication.caller_id !== input.callerId) {
          throw new BusinessError('not_found', 'publication not found for this caller');
        }

        // (3) The first withdrawal fixes the stable timestamp; a later
        // request for an already-withdrawn publication records the SAME time.
        let withdrawnAt: string;
        let alreadyWithdrawn: boolean;
        if (publication.withdrawn_at === null) {
          withdrawnAt = input.nowIso;
          alreadyWithdrawn = false;
          const updated = db
            .prepare('UPDATE publication SET withdrawn_at = ? WHERE publication_id = ? AND withdrawn_at IS NULL')
            .run(withdrawnAt, input.publicationId);
          if (updated.changes !== 1) {
            throw storageUnavailable();
          }
        } else {
          withdrawnAt = publication.withdrawn_at;
          alreadyWithdrawn = true;
        }

        // (4) The ledger row persists this key's stored outcome; replays of
        // the key return exactly these facts.
        db.prepare(
          'INSERT INTO withdraw_ledger (instance_id, caller_id, request_id, publication_id, withdrawn_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(this.instanceId, input.callerId, input.requestId, input.publicationId, withdrawnAt, input.nowIso);

        db.exec('COMMIT');
        return {
          publication_id: input.publicationId,
          withdrawn_at: withdrawnAt,
          already_withdrawn: alreadyWithdrawn,
          replayed: false,
        };
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

  withdrawLedger(callerId: string, requestId: string): WithdrawLedgerRow | null {
    try {
      const row = this.db
        .prepare('SELECT publication_id, withdrawn_at FROM withdraw_ledger WHERE instance_id = ? AND caller_id = ? AND request_id = ?')
        .get(this.instanceId, callerId, requestId) as WithdrawLedgerRow | undefined;
      return row === undefined ? null : { ...row };
    } catch {
      throw storageUnavailable();
    }
  }

  authorWorks(callerId: string, limit: number): AuthorWorkView[] {
    try {
      const rows = this.db.prepare(
        `SELECT p.publication_id, m.canonical_blob, part.genre,
                (SELECT count(*) FROM publication_part pcnt WHERE pcnt.publication_id = p.publication_id) AS part_count,
                (SELECT count(*) FROM publication_default_edition de
                  JOIN render_page rp ON rp.edition_id = de.edition_id
                  WHERE de.publication_id = p.publication_id) AS page_count,
                EXISTS(
                  SELECT 1 FROM device_event ev
                  JOIN device_binding b ON b.binding_id = ev.binding_id
                  JOIN publication_channel pc ON pc.publication_id = p.publication_id AND pc.channel_id = b.channel_id
                  WHERE ev.publication_id = p.publication_id AND ev.kind = 'acknowledged'
                ) AS acknowledged
         FROM publication p
         JOIN operation o ON o.operation_id = p.operation_id
         JOIN manuscript_snapshot m ON m.manuscript_id = p.manuscript_id
         JOIN publication_part part ON part.publication_id = p.publication_id AND part.order_index = 0
         WHERE o.caller_id = ?
         ORDER BY p.acceptance_seq DESC
         LIMIT ?`,
      ).all(callerId, limit) as Array<{
        publication_id: string; canonical_blob: Uint8Array; genre: string; part_count: number; page_count: number; acknowledged: number;
      }>;
      return rows.map((row) => {
        const manuscript = JSON.parse(Buffer.from(row.canonical_blob).toString('utf8')) as {
          title?: unknown; body?: unknown; signature?: unknown; bylines?: { issuer?: unknown }; content?: unknown;
        };
        if (typeof manuscript.body !== 'string') throw storageUnavailable();
        let authorText = manuscript.body;
        if (manuscript.content !== undefined) {
          const parsed = STORED_GENRE_CONTENT_SCHEMA.safeParse(manuscript.content);
          if (!parsed.success) throw storageUnavailable();
          authorText = contentDisplayText(parsed.data);
        }
        return {
          reference: row.publication_id,
          title: typeof manuscript.title === 'string' ? manuscript.title : null,
          body: authorText,
          signature: typeof manuscript.bylines?.issuer === 'string'
            ? manuscript.bylines.issuer
            : typeof manuscript.signature === 'string' ? manuscript.signature : null,
          genre: row.genre,
          page_count: row.page_count,
          part_count: row.part_count,
          unread: row.acknowledged === 0,
        };
      });
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw storageUnavailable();
    }
  }

  currentPresentedPublication(callerId: string): { state: 'known' | 'unknown'; publicationId: string | null } {
    try {
      const rows = this.db.prepare(
        `SELECT s.state_json
         FROM device_binding_state s
         JOIN device_binding b ON b.binding_id = s.binding_id AND b.status = 'active'
         WHERE EXISTS (SELECT 1 FROM operation o WHERE o.caller_id = ? AND o.channel_id = b.channel_id)
         ORDER BY s.reported_at DESC, s.last_seq DESC`,
      ).all(callerId) as Array<{ state_json: string }>;
      if (rows.length === 0) return { state: 'unknown', publicationId: null };
      for (const row of rows) {
        const state = JSON.parse(row.state_json) as { presented_frame?: { publication_id?: unknown } | null };
        const id = state.presented_frame?.publication_id;
        if (typeof id === 'string') return { state: 'known', publicationId: id };
      }
      return { state: 'known', publicationId: null };
    } catch {
      throw storageUnavailable();
    }
  }

  /** Attach the edition/page/asset summary of one publication row. */
  private withSummary(row: PublicationQueryRow): PublicationRecordView {
    const summary = this.loadSummaryByPublication(row.publication_id, row.commit_seq);
    if (summary === null) {
      // A committed publication always has its edition/pages; missing rows
      // are corruption, not a query outcome.
      throw storageUnavailable();
    }
    return { ...row, summary };
  }

  private loadSummaryByPublication(publicationId: string, commitSeq: number): PublicationSummaryView | null {
    const db = this.db;
    const editionRow = db
      .prepare(
        'SELECT e.edition_id, e.profile, e.renderer_build, e.renderer_version, e.chromium_version, e.playwright_version, e.fonts_manifest_version, e.fonts_file_count FROM publication_default_edition d JOIN render_edition e ON e.edition_id = d.edition_id WHERE d.publication_id = ?',
      )
      .get(publicationId) as
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
      .prepare('SELECT page_id, page_index, width, height FROM render_page WHERE edition_id = ? ORDER BY page_index ASC')
      .all(editionRow.edition_id) as { page_id: string; page_index: number; width: number; height: number }[];
    const pages = pageRows.map((page) => {
      const assets = db
        .prepare(
          'SELECT a.sha256, a.byte_length, a.kind, pa.role FROM page_asset pa JOIN asset a ON a.asset_id = pa.asset_id WHERE pa.page_id = ? ORDER BY pa.role ASC',
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
      publication_id: publicationId,
      commit_seq: commitSeq,
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
}
