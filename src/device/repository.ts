import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AdminDevicePowerView,
  DeviceBindingRecord,
  DeviceChannelRepository,
  DeviceFrameRecord,
  DeviceHistoryRecord,
  DeviceHistoryFilter,
  DeviceLibraryState,
  AdminDeviceBindingView,
  AdminDeviceEventView,
  PairingRecord,
  ProtocolLimits,
} from './types.js';

export class DeviceRepositoryError extends Error {
  constructor(readonly code: 'not_found' | 'expired' | 'consumed' | 'idempotency_conflict' | 'storage_unavailable') {
    super(code);
    this.name = 'DeviceRepositoryError';
  }
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function powerFromStateJson(text: unknown): AdminDevicePowerView | null {
  if (typeof text !== 'string') return null;
  try {
    const state = JSON.parse(text) as { power?: Partial<AdminDevicePowerView> };
    const power = state.power;
    if (power === undefined ||
        !['external', 'battery', 'unknown'].includes(String(power.source)) ||
        !['external_online', 'active', 'battery_idle', 'retry_backoff', 'low_battery'].includes(String(power.mode)) ||
        !(power.battery_percent === null ||
          (typeof power.battery_percent === 'number' && Number.isInteger(power.battery_percent) &&
           power.battery_percent >= 0 && power.battery_percent <= 100)) ||
        !(power.battery_mv === null ||
          (typeof power.battery_mv === 'number' && Number.isInteger(power.battery_mv) && power.battery_mv > 0))) {
      return null;
    }
    return {
      source: power.source as AdminDevicePowerView['source'],
      battery_percent: power.battery_percent,
      battery_mv: power.battery_mv,
      mode: power.mode as AdminDevicePowerView['mode'],
      ...Object.fromEntries(
        (['current_ma','average_current_ma','remaining_mah','full_mah','light_sleep_seconds','uptime_seconds'] as const)
          .filter((key) => typeof power[key] === 'number' && Number.isSafeInteger(power[key]))
          .map((key) => [key, power[key]]),
      ),
    };
  } catch {
    return null;
  }
}

function mergePowerTelemetry(currentText: string, incomingText: string): string {
  if (powerFromStateJson(incomingText) === null) return currentText;
  try {
    const current = JSON.parse(currentText) as Record<string, unknown>;
    const incoming = JSON.parse(incomingText) as { power?: unknown };
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return incomingText;
    current['power'] = incoming.power;
    return JSON.stringify(current);
  } catch {
    return incomingText;
  }
}

function deliveryId(channelId: string, publicationId: string): string {
  return `del_${createHash('sha256').update(`${channelId}\0${publicationId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function bindingFromRow(row: Record<string, unknown>): DeviceBindingRecord {
  return {
    binding_id: row['binding_id'] as string,
    device_id: row['device_id'] as string,
    channel_id: row['channel_id'] as string,
    instance_id: row['instance_id'] as string,
    epoch: row['epoch'] as string,
    protocol_version: 1,
    profiles: parseJson<string[]>(row['profiles'] as string),
    limits: parseJson<ProtocolLimits>(row['limits'] as string),
    status: row['status'] as 'active' | 'revoked',
    created_at: row['created_at'] as string,
    revoked_at: row['revoked_at'] as string | null,
  };
}

const BINDING_COLUMNS =
  'binding_id, device_id, channel_id, instance_id, epoch, protocol_version, profiles, limits, status, created_at, revoked_at';

export class SqliteDeviceChannelRepository implements DeviceChannelRepository {
  constructor(private readonly db: DatabaseSync, private readonly instanceId: string) {}

  configureChannel(input: {
    channelId: string;
    publisherCallerIds: readonly string[];
    nowIso: string;
    epochSource: () => string;
  }): { channel_id: string; epoch: string } {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        let channel = db.prepare('SELECT channel_id, epoch FROM device_channel WHERE channel_id = ?').get(input.channelId) as
          | { channel_id: string; epoch: string }
          | undefined;
        if (channel === undefined) {
          channel = { channel_id: input.channelId, epoch: input.epochSource() };
          db.prepare(
            'INSERT INTO device_channel (channel_id, epoch, revision, offer_fingerprint, created_at) VALUES (?, ?, 0, ?, ?)',
          ).run(channel.channel_id, channel.epoch, '', input.nowIso);
        }
        if (input.publisherCallerIds.length > 0) {
          const placeholders = input.publisherCallerIds.map(() => '?').join(',');
          db.prepare(
            `UPDATE operation SET channel_id = ? WHERE channel_id IS NULL AND caller_id IN (${placeholders})`,
          ).run(input.channelId, ...input.publisherCallerIds);
          const rows = db.prepare(
            `SELECT p.publication_id
             FROM publication p JOIN operation o ON o.operation_id = p.operation_id
             WHERE o.channel_id = ? AND NOT EXISTS (
               SELECT 1 FROM publication_channel pc WHERE pc.channel_id = ? AND pc.publication_id = p.publication_id
             ) ORDER BY p.acceptance_seq`,
          ).all(input.channelId, input.channelId) as { publication_id: string }[];
          const insert = db.prepare(
            'INSERT INTO publication_channel (channel_id, publication_id, delivery_id, routed_at) VALUES (?, ?, ?, ?)',
          );
          for (const row of rows) {
            insert.run(input.channelId, row.publication_id, deliveryId(input.channelId, row.publication_id), input.nowIso);
          }
          if (rows.length > 0) {
            db.prepare('UPDATE device_channel SET library_revision = library_revision + ? WHERE channel_id = ?')
              .run(rows.length, input.channelId);
          }
        }
        db.exec('COMMIT');
        return channel;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      if (error instanceof DeviceRepositoryError) throw error;
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  createPairing(input: {
    pairingId: string;
    codeDigest: string;
    channelId: string;
    allowedProfiles: readonly string[];
    createdAt: string;
    expiresAt: string;
    maxAttempts: number;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO device_pairing
         (code_digest, pairing_id, channel_id, allowed_profiles, created_at, expires_at, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.codeDigest,
        input.pairingId,
        input.channelId,
        JSON.stringify(input.allowedProfiles),
        input.createdAt,
        input.expiresAt,
        input.maxAttempts,
      );
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  pairingByDigest(codeDigest: string): PairingRecord | null {
    try {
      const row = this.db.prepare('SELECT * FROM device_pairing WHERE code_digest = ?').get(codeDigest) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) return null;
      return {
        code_digest: row['code_digest'] as string,
        pairing_id: row['pairing_id'] as string,
        channel_id: row['channel_id'] as string,
        allowed_profiles: parseJson<string[]>(row['allowed_profiles'] as string),
        created_at: row['created_at'] as string,
        expires_at: row['expires_at'] as string,
        max_attempts: row['max_attempts'] as number,
        failed_attempts: row['failed_attempts'] as number,
        consumed_at: row['consumed_at'] as string | null,
        request_id: row['request_id'] as string | null,
        request_digest: row['request_digest'] as string | null,
        binding_id: row['binding_id'] as string | null,
      };
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  consumePairing(input: {
    codeDigest: string;
    requestId: string;
    requestDigest: string;
    bindingId: string;
    deviceId: string;
    secretSha256: string;
    profiles: readonly string[];
    limits: ProtocolLimits;
    nowIso: string;
  }): { binding: DeviceBindingRecord; duplicate: boolean } {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const pairing = db.prepare('SELECT * FROM device_pairing WHERE code_digest = ?').get(input.codeDigest) as
          | Record<string, unknown>
          | undefined;
        if (pairing === undefined) throw new DeviceRepositoryError('not_found');
        if ((pairing['expires_at'] as string) <= input.nowIso) throw new DeviceRepositoryError('expired');
        if ((pairing['failed_attempts'] as number) >= (pairing['max_attempts'] as number)) {
          throw new DeviceRepositoryError('expired');
        }
        const priorBinding = pairing['binding_id'] as string | null;
        if (priorBinding !== null) {
          if (pairing['request_id'] !== input.requestId || pairing['request_digest'] !== input.requestDigest) {
            throw new DeviceRepositoryError('idempotency_conflict');
          }
          const row = db.prepare(`SELECT ${BINDING_COLUMNS} FROM device_binding WHERE binding_id = ?`).get(priorBinding) as
            | Record<string, unknown>
            | undefined;
          if (row === undefined) throw new DeviceRepositoryError('storage_unavailable');
          db.exec('ROLLBACK');
          return { binding: bindingFromRow(row), duplicate: true };
        }
        const channel = db.prepare('SELECT epoch FROM device_channel WHERE channel_id = ?').get(pairing['channel_id'] as string) as
          | { epoch: string }
          | undefined;
        if (channel === undefined) throw new DeviceRepositoryError('storage_unavailable');
        db.prepare(
          `INSERT INTO device_binding
           (binding_id, device_id, channel_id, instance_id, epoch, protocol_version, secret_sha256, profiles, limits, status, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?)`,
        ).run(
          input.bindingId,
          input.deviceId,
          pairing['channel_id'] as string,
          this.instanceId,
          channel.epoch,
          input.secretSha256,
          JSON.stringify(input.profiles),
          JSON.stringify(input.limits),
          input.nowIso,
        );
        db.prepare(
          'UPDATE device_pairing SET consumed_at = ?, request_id = ?, request_digest = ?, binding_id = ? WHERE code_digest = ?',
        ).run(input.nowIso, input.requestId, input.requestDigest, input.bindingId, input.codeDigest);
        const row = db.prepare(`SELECT ${BINDING_COLUMNS} FROM device_binding WHERE binding_id = ?`).get(input.bindingId) as Record<string, unknown>;
        db.exec('COMMIT');
        return { binding: bindingFromRow(row), duplicate: false };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      if (error instanceof DeviceRepositoryError) throw error;
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  notePairingFailure(codeDigest: string): void {
    try {
      this.db.prepare(
        'UPDATE device_pairing SET failed_attempts = min(max_attempts, failed_attempts + 1) WHERE code_digest = ? AND consumed_at IS NULL',
      ).run(codeDigest);
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  adminBindings(): AdminDeviceBindingView[] {
    try {
      const rows = this.db.prepare(
        `SELECT b.binding_id, b.device_id, b.channel_id, b.profiles, b.status,
                b.created_at, b.revoked_at, s.last_seq, s.reported_at, s.state_json
         FROM device_binding b
         LEFT JOIN device_binding_state s ON s.binding_id = b.binding_id
         WHERE b.instance_id = ?
         ORDER BY b.created_at DESC, b.binding_id DESC`,
      ).all(this.instanceId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        binding_id: row['binding_id'] as string,
        device_id: row['device_id'] as string,
        channel_id: row['channel_id'] as string,
        profiles: parseJson<string[]>(row['profiles'] as string),
        status: row['status'] as 'active' | 'revoked',
        created_at: row['created_at'] as string,
        revoked_at: row['revoked_at'] as string | null,
        last_seq: row['last_seq'] as number | null,
        last_reported_at: row['reported_at'] as string | null,
        power: powerFromStateJson(row['state_json']),
      }));
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  adminRecentEvents(limit: number): AdminDeviceEventView[] {
    try {
      return this.db.prepare(
        `SELECT e.binding_id, b.device_id, e.seq, e.kind, e.publication_id,
                e.page_id, e.received_at
         FROM device_event e
         JOIN device_binding b ON b.binding_id = e.binding_id
         WHERE b.instance_id = ?
         ORDER BY e.received_at DESC, e.seq DESC
         LIMIT ?`,
      ).all(this.instanceId, limit) as unknown as AdminDeviceEventView[];
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  bindingBySecretDigest(secretDigest: string): DeviceBindingRecord | null {
    try {
      const row = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM device_binding WHERE secret_sha256 = ?`).get(secretDigest) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : bindingFromRow(row);
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  bindingById(bindingId: string): DeviceBindingRecord | null {
    try {
      const row = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM device_binding WHERE binding_id = ?`).get(bindingId) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : bindingFromRow(row);
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  revokeBinding(bindingId: string, nowIso: string): boolean {
    try {
      const existing = this.db.prepare('SELECT 1 FROM device_binding WHERE binding_id = ?').get(bindingId);
      if (existing === undefined) return false;
      this.db.prepare(
        "UPDATE device_binding SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE binding_id = ?",
      ).run(nowIso, bindingId);
      return true;
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  currentScreen(binding: DeviceBindingRecord, nowIso: string): { epoch: string; revision: number; frame: DeviceFrameRecord | null } {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const channel = db.prepare(
          'SELECT epoch, revision, offer_fingerprint, current_publication_id FROM device_channel WHERE channel_id = ?',
        ).get(binding.channel_id) as
          | { epoch: string; revision: number; offer_fingerprint: string; current_publication_id: string | null }
          | undefined;
        if (channel === undefined) throw new DeviceRepositoryError('storage_unavailable');
        const frame = db.prepare(
          `SELECT p.publication_id, p.acceptance_seq, o.accepted_at, p.committed_at, p.expires_at, p.withdrawn_at,
                  pc.delivery_id, e.edition_id, e.profile, rp.page_id, rp.part_id, rp.page_index,
                  (SELECT count(*) FROM render_page count_page WHERE count_page.edition_id = e.edition_id) AS page_count,
                  rp.width, rp.height, a.sha256, a.byte_length, a.relative_path
           FROM publication_channel pc
           JOIN publication p ON p.publication_id = pc.publication_id
           JOIN operation o ON o.operation_id = p.operation_id
           JOIN publication_default_edition de ON de.publication_id = p.publication_id
           JOIN render_edition e ON e.edition_id = de.edition_id
           JOIN render_page rp ON rp.edition_id = e.edition_id AND rp.page_index = 0
           JOIN page_asset pa ON pa.page_id = rp.page_id AND pa.role = 'gray4'
           JOIN asset a ON a.asset_id = pa.asset_id
           WHERE pc.channel_id = ? AND p.withdrawn_at IS NULL AND p.eligible_at <= ?
             AND (p.expires_at IS NULL OR p.expires_at > ?)
           ORDER BY p.eligible_at DESC, p.acceptance_seq DESC LIMIT 1`,
        ).get(binding.channel_id, nowIso, nowIso) as DeviceFrameRecord | undefined;
        const fingerprint = frame === undefined
          ? ''
          : createHash('sha256')
              .update(`${frame.publication_id}\0${frame.edition_id}\0${frame.page_id}\0${frame.sha256}`, 'utf8')
              .digest('hex');
        let revision = channel.revision;
        if (fingerprint !== channel.offer_fingerprint) {
          revision += 1;
          if (channel.current_publication_id !== null && channel.current_publication_id !== frame?.publication_id) {
            db.prepare(
              'UPDATE publication_channel SET superseded_at = COALESCE(superseded_at, ?) WHERE channel_id = ? AND publication_id = ?',
            ).run(nowIso, binding.channel_id, channel.current_publication_id);
          }
          if (frame !== undefined) {
            db.prepare(
              'UPDATE publication_channel SET first_offered_at = COALESCE(first_offered_at, ?) WHERE channel_id = ? AND publication_id = ?',
            ).run(nowIso, binding.channel_id, frame.publication_id);
          }
          db.prepare(
            'UPDATE device_channel SET revision = ?, offer_fingerprint = ?, current_publication_id = ? WHERE channel_id = ?',
          ).run(revision, fingerprint, frame?.publication_id ?? null, binding.channel_id);
        }
        db.exec('COMMIT');
        return { epoch: channel.epoch, revision, frame: frame ?? null };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      if (error instanceof DeviceRepositoryError) throw error;
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  historyHighWater(channelId: string): number {
    try {
      const row = this.db.prepare(
        'SELECT COALESCE(max(p.commit_seq), 0) AS n FROM publication_channel pc JOIN publication p ON p.publication_id = pc.publication_id WHERE pc.channel_id = ?',
      ).get(channelId) as { n: number };
      return row.n;
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  libraryState(channelId: string, selectedPublicationId: string | null): DeviceLibraryState {
    try {
      const channel = this.db.prepare(
        'SELECT library_revision FROM device_channel WHERE channel_id = ?',
      ).get(channelId) as { library_revision: number } | undefined;
      if (channel === undefined) throw new DeviceRepositoryError('storage_unavailable');
      const unread = this.db.prepare(
        `SELECT count(*) AS n
         FROM publication_channel pc
         WHERE pc.channel_id = ? AND NOT EXISTS (
           SELECT 1 FROM device_event ev
           JOIN device_binding b ON b.binding_id = ev.binding_id
           WHERE b.channel_id = pc.channel_id AND ev.publication_id = pc.publication_id
             AND ev.kind = 'acknowledged'
         )`,
      ).get(channelId) as { n: number };
      let selectedUnread: boolean | null = null;
      if (selectedPublicationId !== null) {
        const selected = this.db.prepare(
          `SELECT NOT EXISTS (
             SELECT 1 FROM device_event ev
             JOIN device_binding b ON b.binding_id = ev.binding_id
             WHERE b.channel_id = pc.channel_id AND ev.publication_id = pc.publication_id
               AND ev.kind = 'acknowledged'
           ) AS unread
           FROM publication_channel pc
           WHERE pc.channel_id = ? AND pc.publication_id = ?`,
        ).get(channelId, selectedPublicationId) as { unread: number } | undefined;
        selectedUnread = selected === undefined ? null : selected.unread !== 0;
      }
      return { revision: channel.library_revision, unread_count: unread.n, selected_unread: selectedUnread };
    } catch (error) {
      if (error instanceof DeviceRepositoryError) throw error;
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  historyPage(channelId: string, highWater: number, beforeSeq: number | null, limit: number, filter: DeviceHistoryFilter): DeviceHistoryRecord[] {
    try {
      const before = beforeSeq === null ? '' : 'AND p.acceptance_seq < ?';
      const unread = filter === 'unread'
        ? `AND NOT EXISTS (
             SELECT 1 FROM device_event ev
             JOIN device_binding b ON b.binding_id = ev.binding_id
             WHERE b.channel_id = pc.channel_id AND ev.publication_id = p.publication_id
               AND ev.kind = 'acknowledged'
           )`
        : '';
      const params: Array<string | number> = [channelId, highWater];
      if (beforeSeq !== null) params.push(beforeSeq);
      params.push(limit);
      return this.db.prepare(
        `SELECT p.publication_id, p.acceptance_seq, o.accepted_at, p.committed_at, p.expires_at, p.withdrawn_at,
                pc.delivery_id, e.edition_id, e.profile, part.genre, m.canonical_blob,
                NOT EXISTS (
                  SELECT 1 FROM device_event ev
                  JOIN device_binding b ON b.binding_id = ev.binding_id
                  WHERE b.channel_id = pc.channel_id AND ev.publication_id = p.publication_id
                    AND ev.kind = 'acknowledged'
                ) AS unread,
                (SELECT count(*) FROM render_page rp WHERE rp.edition_id = e.edition_id) AS page_count
         FROM publication_channel pc
         JOIN publication p ON p.publication_id = pc.publication_id
         JOIN operation o ON o.operation_id = p.operation_id
         JOIN manuscript_snapshot m ON m.manuscript_id = p.manuscript_id
         JOIN publication_part part ON part.publication_id = p.publication_id AND part.order_index = 0
         JOIN publication_default_edition de ON de.publication_id = p.publication_id
         JOIN render_edition e ON e.edition_id = de.edition_id
         WHERE pc.channel_id = ? AND p.commit_seq <= ? ${before} ${unread}
         ORDER BY p.acceptance_seq DESC LIMIT ?`,
      ).all(...params) as unknown as DeviceHistoryRecord[];
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  historyCursor(bindingId: string, cursorDigest: string): {
    snapshot_high_water: number; last_acceptance_seq: number; page_size: number; filter: DeviceHistoryFilter;
    library_revision: number; remaining_items: number | null; expires_at: string;
  } | null {
    try {
      return (this.db.prepare(
        'SELECT snapshot_high_water, last_acceptance_seq, page_size, filter, library_revision, remaining_items, expires_at FROM device_history_cursor WHERE binding_id = ? AND cursor_digest = ?',
      ).get(bindingId, cursorDigest) as { snapshot_high_water: number; last_acceptance_seq: number; page_size: number; filter: DeviceHistoryFilter; library_revision: number; remaining_items: number | null; expires_at: string } | undefined) ?? null;
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  insertHistoryCursor(input: {
    bindingId: string; cursorDigest: string; snapshotHighWater: number; lastAcceptanceSeq: number;
    pageSize: number; filter: DeviceHistoryFilter; libraryRevision: number; remainingItems: number | null;
    createdAt: string; expiresAt: string;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO device_history_cursor
         (cursor_digest, binding_id, snapshot_high_water, last_acceptance_seq, page_size, filter, library_revision, remaining_items, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.cursorDigest, input.bindingId, input.snapshotHighWater, input.lastAcceptanceSeq, input.pageSize,
        input.filter, input.libraryRevision, input.remainingItems, input.createdAt, input.expiresAt);
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  pages(binding: DeviceBindingRecord, publicationId: string, profile: string, editionId: string | null): DeviceFrameRecord[] {
    try {
      const selected = editionId === null
        ? this.db.prepare(
            `SELECT e.edition_id FROM publication_channel pc JOIN render_edition e ON e.publication_id = pc.publication_id
             WHERE pc.channel_id = ? AND pc.publication_id = ? AND e.profile = ? ORDER BY e.edition_seq ASC LIMIT 1`,
          ).get(binding.channel_id, publicationId, profile) as { edition_id: string } | undefined
        : this.db.prepare(
            `SELECT e.edition_id FROM publication_channel pc JOIN render_edition e ON e.publication_id = pc.publication_id
             WHERE pc.channel_id = ? AND pc.publication_id = ? AND e.edition_id = ? AND e.profile = ?`,
          ).get(binding.channel_id, publicationId, editionId, profile) as { edition_id: string } | undefined;
      if (selected === undefined) return [];
      return this.db.prepare(
        `SELECT p.publication_id, p.acceptance_seq, o.accepted_at, p.committed_at, p.expires_at, p.withdrawn_at,
                pc.delivery_id, e.edition_id, e.profile, rp.page_id, rp.part_id, rp.page_index,
                (SELECT count(*) FROM render_page count_page WHERE count_page.edition_id = e.edition_id) AS page_count,
                rp.width, rp.height, a.sha256, a.byte_length, a.relative_path
         FROM publication_channel pc
         JOIN publication p ON p.publication_id = pc.publication_id
         JOIN operation o ON o.operation_id = p.operation_id
         JOIN render_edition e ON e.publication_id = p.publication_id
         JOIN render_page rp ON rp.edition_id = e.edition_id
         JOIN page_asset pa ON pa.page_id = rp.page_id AND pa.role = 'gray4'
         JOIN asset a ON a.asset_id = pa.asset_id
         WHERE pc.channel_id = ? AND p.publication_id = ? AND e.edition_id = ?
         ORDER BY rp.page_index`,
      ).all(binding.channel_id, publicationId, selected.edition_id) as unknown as DeviceFrameRecord[];
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  authorizedAsset(binding: DeviceBindingRecord, sha256: string): { relative_path: string; byte_length: number } | null {
    try {
      const rows = this.db.prepare(
        `SELECT DISTINCT a.relative_path, a.byte_length, e.profile
         FROM asset a JOIN page_asset pa ON pa.asset_id = a.asset_id
         JOIN render_page rp ON rp.page_id = pa.page_id
         JOIN render_edition e ON e.edition_id = rp.edition_id
         JOIN publication_channel pc ON pc.publication_id = e.publication_id
         WHERE pc.channel_id = ? AND a.sha256 = ? AND pa.role = 'gray4'`,
      ).all(binding.channel_id, sha256) as { relative_path: string; byte_length: number; profile: string }[];
      const row = rows.find((item) => binding.profiles.includes(item.profile));
      return row === undefined ? null : { relative_path: row.relative_path, byte_length: row.byte_length };
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  subjectFrame(binding: DeviceBindingRecord, publicationId: string, pageId: string): DeviceFrameRecord | null {
    try {
      const row = this.db.prepare(
        `SELECT p.publication_id, p.acceptance_seq, o.accepted_at, p.committed_at, p.expires_at, p.withdrawn_at,
                pc.delivery_id, e.edition_id, e.profile, rp.page_id, rp.part_id, rp.page_index,
                (SELECT count(*) FROM render_page count_page WHERE count_page.edition_id = e.edition_id) AS page_count,
                rp.width, rp.height, a.sha256, a.byte_length, a.relative_path
         FROM publication_channel pc JOIN publication p ON p.publication_id = pc.publication_id
         JOIN operation o ON o.operation_id = p.operation_id
         JOIN render_edition e ON e.publication_id = p.publication_id
         JOIN render_page rp ON rp.edition_id = e.edition_id
         JOIN page_asset pa ON pa.page_id = rp.page_id AND pa.role = 'gray4'
         JOIN asset a ON a.asset_id = pa.asset_id
         WHERE pc.channel_id = ? AND p.publication_id = ? AND rp.page_id = ?`,
      ).get(binding.channel_id, publicationId, pageId) as DeviceFrameRecord | undefined;
      return row ?? null;
    } catch {
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }

  acceptEvent(input: {
    binding: DeviceBindingRecord; eventId: string; seq: number; kind: string; payloadDigest: string; payloadJson: string;
    publicationId: string | null; pageId: string | null; frameId: string | null; deliveryId: string | null;
    stateJson: string; receivedAt: string;
  }): { status: 'accepted' | 'duplicate'; received_at: string } {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare(
          'SELECT payload_digest, received_at FROM device_event WHERE binding_id = ? AND event_id = ?',
        ).get(input.binding.binding_id, input.eventId) as { payload_digest: string; received_at: string } | undefined;
        if (existing !== undefined) {
          if (existing.payload_digest !== input.payloadDigest) throw new DeviceRepositoryError('idempotency_conflict');
          db.exec('ROLLBACK');
          return { status: 'duplicate', received_at: existing.received_at };
        }
        const seqOwner = db.prepare(
          'SELECT event_id FROM device_event WHERE binding_id = ? AND seq = ?',
        ).get(input.binding.binding_id, input.seq) as { event_id: string } | undefined;
        if (seqOwner !== undefined) throw new DeviceRepositoryError('idempotency_conflict');
        const firstAcknowledgement = input.kind === 'acknowledged' && input.publicationId !== null &&
          db.prepare(
            `SELECT 1 FROM device_event ev
             JOIN device_binding b ON b.binding_id = ev.binding_id
             WHERE b.channel_id = ? AND ev.publication_id = ? AND ev.kind = 'acknowledged'
             LIMIT 1`,
          ).get(input.binding.channel_id, input.publicationId) === undefined;
        db.prepare(
          `INSERT INTO device_event
           (binding_id, event_id, seq, kind, payload_digest, payload_json, publication_id, page_id, frame_id, delivery_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.binding.binding_id, input.eventId, input.seq, input.kind, input.payloadDigest, input.payloadJson,
          input.publicationId, input.pageId, input.frameId, input.deliveryId, input.receivedAt,
        );
        if (firstAcknowledgement) {
          db.prepare('UPDATE device_channel SET library_revision = library_revision + 1 WHERE channel_id = ?')
            .run(input.binding.channel_id);
        }
        const state = db.prepare('SELECT last_seq, state_json FROM device_binding_state WHERE binding_id = ?').get(input.binding.binding_id) as
          | { last_seq: number; state_json: string }
          | undefined;
        if (state === undefined) {
          db.prepare(
            'INSERT INTO device_binding_state (binding_id, last_seq, state_json, reported_at) VALUES (?, ?, ?, ?)',
          ).run(input.binding.binding_id, input.seq, input.stateJson, input.receivedAt);
        } else if (input.seq > state.last_seq) {
          db.prepare(
            'UPDATE device_binding_state SET last_seq = ?, state_json = ?, reported_at = ? WHERE binding_id = ?',
          ).run(input.seq, input.stateJson, input.receivedAt, input.binding.binding_id);
        } else {
          // Firmware counters can legitimately restart below the server's old
          // high-water mark after a recovery/migration. Keep content state and
          // last_seq monotonic, but do not hide current reachability or power.
          db.prepare(
            'UPDATE device_binding_state SET state_json = ?, reported_at = ? WHERE binding_id = ?',
          ).run(
            mergePowerTelemetry(state.state_json, input.stateJson),
            input.receivedAt,
            input.binding.binding_id,
          );
        }
        db.exec('COMMIT');
        return { status: 'accepted', received_at: input.receivedAt };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      if (error instanceof DeviceRepositoryError) throw error;
      throw new DeviceRepositoryError('storage_unavailable');
    }
  }
}
