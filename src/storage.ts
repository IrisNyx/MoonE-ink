import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fsFailureCategory } from './diagnostics.js';
import { StorageSchemaError } from './storage/errors.js';
import {
  SCHEMA_INSTANCE_TABLE,
  SCHEMA_V2_BOOTSTRAP,
  SCHEMA_V2_STATEMENTS,
  SCHEMA_V3_BOOTSTRAP,
  SCHEMA_V3_STATEMENTS,
  SCHEMA_V4_STATEMENTS,
  SCHEMA_V5_FINAL_STATEMENTS,
  SCHEMA_V5_REPLACEMENT_TABLES,
  SCHEMA_V6_STATEMENTS,
  SCHEMA_V7_STATEMENTS,
  SCHEMA_V8_STATEMENTS,
  SCHEMA_V9_STATEMENTS,
  SCHEMA_V10_STATEMENTS,
} from './storage/schema.js';
import { SqliteAcceptanceRepository } from './storage/acceptance.js';
import { SqlitePublicationRepository } from './storage/publication.js';
import { SqliteQueryRepository } from './storage/query.js';
import type { AcceptanceRepository } from './domain/acceptance.js';
import type { PublicationRepository } from './domain/publication.js';
import type { QueryRepository } from './domain/query.js';
import { SqliteDeviceChannelRepository } from './device/repository.js';
import type { DeviceChannelRepository } from './device/types.js';
import { computeDeliveryWindow } from './domain/delivery.js';
import type { DeliverySemantics } from './domain/manuscript.js';
import { readRestorePolicy, type RestorePolicy } from './restore-policy.js';

/**
 * Business API schema version persisted in SQLite (PRAGMA user_version).
 * v2 adds the persistent-acceptance facts (MCP-03a) on top of the v1
 * instance identity; v3 adds the operation execution facts and the immutable
 * publication families (MCP-03b); v4 adds the publication query columns
 * (backfilled from the immutable manuscript snapshots), the withdraw
 * idempotency ledger and the history cursor digests (MCP-04); v5 adds
 * immutable edition sequences, edition layout snapshots and an explicit
 * publication default-edition fact; see
 * src/storage/schema.ts for the history.
 */
export const SUPPORTED_SCHEMA_VERSION = 10;

const LOCK_NAME = 'ephemera.lock';
const DB_NAME = 'ephemera.sqlite';

/** Bounded busy timeout so writer contention fails fast but gracefully. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Windows file systems intermittently refuse a brand-new SQLite open or WAL
 * file creation (real-time scanners hold the fresh file briefly; near-limit
 * path lengths widen the window). Startup retries these transient classes a
 * bounded number of times before failing; deterministic problems (busy lock,
 * unsupported schema, wrong permissions) never enter the retry path.
 */
const OPEN_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/** SQLite base result codes that startup treats as transient. */
function isTransientSqliteError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') {
    return false;
  }
  const base = errcode & 0xff;
  return base === 5 || base === 6 || base === 10 || base === 14; // BUSY, LOCKED, IOERR, CANTOPEN
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class DataDirBusyError extends Error {
  constructor(readonly ownerPid: number) {
    super(
      `data directory is owned by another live service process (pid ${ownerPid}); ` +
        'stop that process first or configure a separate data directory',
    );
    this.name = 'DataDirBusyError';
  }
}

export interface DataStore {
  readonly instanceId: string;
  readonly schemaVersion: number;
  readonly dataDir: string;
  /** Persisted creation timestamp of the instance identity (ISO UTC). */
  readonly instanceCreatedAt: string;
  readonly restorePolicy: RestorePolicy | null;
  /**
   * The acceptance repository bound to this database. Raw SQL never crosses
   * this boundary; MCP handlers receive the domain services, not this object.
   */
  createAcceptanceRepository(): AcceptanceRepository;
  /** The publication/worker repository bound to this database. */
  createPublicationRepository(): PublicationRepository;
  /** The MCP-04 query/withdraw repository bound to this database. */
  createQueryRepository(): QueryRepository;
  /** Device Channel v1 repository; routes/admin/device events stay outside MCP. */
  createDeviceChannelRepository(): DeviceChannelRepository;
  close(): void;
}

interface LockContent {
  pid: number;
  started_at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM on Windows means the process exists but belongs to another session.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeLock(lockPath: string): void {
  const fd = openSync(lockPath, 'wx');
  try {
    const content: LockContent = { pid: process.pid, started_at: new Date().toISOString() };
    writeSync(fd, JSON.stringify(content));
  } finally {
    closeSync(fd);
  }
}

/**
 * Acquire exclusive ownership of the data directory via an exclusive-create
 * lock file. A leftover lock from a dead owner is replaced only after the
 * owner's pid is confirmed dead (crash recovery); the stale file is kept
 * aside as evidence, never blindly deleted. An unparseable lock is never
 * removed automatically. Thrown messages carry stable categories only: the
 * raw OS text embeds the absolute data directory path.
 */
function acquireLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_NAME);
  try {
    writeLock(lockPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`data directory lock could not be created (${fsFailureCategory(error)})`);
    }
  }

  let content: LockContent;
  try {
    content = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContent;
  } catch {
    throw new Error(
      `data directory lock exists but is unreadable (${LOCK_NAME}); refusing to start or remove it automatically`,
    );
  }
  if (typeof content.pid !== 'number' || !Number.isInteger(content.pid)) {
    throw new Error(`data directory lock has an invalid pid (${LOCK_NAME}); refusing to start`);
  }
  if (pidAlive(content.pid)) {
    throw new DataDirBusyError(content.pid);
  }

  const stalePath = join(dataDir, `ephemera.lock.stale.${Date.now()}`);
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    throw new Error(`data directory lock could not be rotated (${fsFailureCategory(error)})`);
  }
  try {
    writeLock(lockPath);
  } catch (error) {
    throw new Error(`data directory lock could not be created (${fsFailureCategory(error)})`);
  }
}

function releaseLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_NAME);
  if (!existsSync(lockPath)) {
    return;
  }
  try {
    const content = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContent;
    if (content.pid !== process.pid) {
      // Not ours: another (recovery) process owns it now. Leave it alone.
      return;
    }
  } catch {
    return;
  }
  unlinkSync(lockPath);
}

/**
 * Apply connection pragmas. WAL keeps the accepted MCP-02 semantics; the busy
 * timeout bounds writer contention; foreign key enforcement is switched on
 * and *verified* — a build that cannot enforce FKs must refuse to start, not
 * silently weaken the schema's guarantees.
 */
function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');
  const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  if (fkRow?.foreign_keys !== 1) {
    throw new Error('database refused to enable foreign key enforcement; refusing to start');
  }
}

function createUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

function readUserVersion(db: DatabaseSync): number {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return versionRow?.user_version ?? 0;
}

/**
 * Run `body` inside one `BEGIN IMMEDIATE` transaction. DDL in SQLite is
 * transactional, so a failure at any statement rolls everything the body did
 * back — no partial schema, no wrong user_version, no half-initialized rows.
 */
function inImmediateTransaction(db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    body();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Connection-level failure; the original error is the real cause.
    }
    throw error;
  }
}

/**
 * Run DDL and the user_version bump inside one transaction. A failure at any
 * statement (including a pre-existing foreign table in a malformed
 * half-migrated database) rolls everything back.
 */
function runTransactional(db: DatabaseSync, statements: readonly string[], targetVersion: number): void {
  inImmediateTransaction(db, () => {
    for (const statement of statements) {
      db.exec(statement);
    }
    createUserVersion(db, targetVersion);
  });
}

/**
 * Backfill the v4 publication query columns for every existing publication,
 * inside the migration transaction. The facts come from the immutable
 * manuscript snapshot (the author's verbatim delivery spellings) and the
 * operation's stored `accepted_at`; `computeDeliveryWindow` normalizes them,
 * so `eligible_at = max(accepted_at, deliverAfter)` holds for pre-v4 rows
 * exactly as for new commits. A snapshot that cannot be parsed is database
 * corruption: the error rolls the whole migration back (the database stays a
 * complete v3) instead of leaving rows with missing query facts.
 */
function backfillPublicationQueryColumns(db: DatabaseSync): void {
  const rows = db
    .prepare(
      'SELECT p.publication_id AS publication_id, p.manuscript_id AS manuscript_id, o.accepted_at AS accepted_at ' +
        'FROM publication p JOIN operation o ON o.operation_id = p.operation_id',
    )
    .all() as { publication_id: string; manuscript_id: string; accepted_at: string }[];
  const readSnapshot = db.prepare('SELECT canonical_blob FROM manuscript_snapshot WHERE manuscript_id = ?');
  const update = db.prepare('UPDATE publication SET deliver_after = ?, expires_at = ?, eligible_at = ? WHERE publication_id = ?');
  for (const row of rows) {
    const snapshot = readSnapshot.get(row.manuscript_id) as { canonical_blob: Uint8Array } | undefined;
    if (snapshot === undefined) {
      throw new StorageSchemaError('publication references a missing manuscript snapshot');
    }
    let manuscript: { delivery?: DeliverySemantics };
    try {
      manuscript = JSON.parse(Buffer.from(snapshot.canonical_blob).toString('utf8')) as { delivery?: DeliverySemantics };
    } catch {
      throw new StorageSchemaError('manuscript snapshot is not parseable');
    }
    const window = computeDeliveryWindow(
      row.accepted_at,
      manuscript.delivery?.deliverAfter ?? null,
      manuscript.delivery?.expiresAt ?? null,
    );
    update.run(window.deliver_after, window.expires_at, window.eligible_at, row.publication_id);
  }
}

/**
 * Apply the v4 upgrade (DDL + in-transaction backfill of the publication
 * query columns + the user_version bump) as ONE transaction; a failure at
 * any point leaves the complete previous version.
 */
function upgradeToV4(db: DatabaseSync): void {
  inImmediateTransaction(db, () => {
    for (const statement of SCHEMA_V4_STATEMENTS) {
      db.exec(statement);
    }
    backfillPublicationQueryColumns(db);
    createUserVersion(db, 4);
  });
}

/**
 * Rebuild the render graph for schema v5. `foreign_keys` must be changed
 * outside a transaction in SQLite. Row copying, table swapping, default
 * selection and the user_version bump remain one atomic transaction; any
 * failure restores the complete v4 layout before enforcement is re-enabled.
 */
function upgradeToV5(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    inImmediateTransaction(db, () => {
      for (const statement of SCHEMA_V5_REPLACEMENT_TABLES) {
        db.exec(statement);
      }
      db.exec(`
        INSERT INTO render_edition_v5 (
          edition_id, publication_id, edition_seq, profile, renderer_build,
          renderer_version, chromium_version, playwright_version,
          fonts_manifest_version, fonts_file_count, layout_snapshot, created_at
        )
        SELECT
          current.edition_id,
          current.publication_id,
          1 + (
            SELECT count(*)
            FROM render_edition prior
            WHERE prior.publication_id = current.publication_id
              AND (
                prior.created_at < current.created_at OR
                (prior.created_at = current.created_at AND prior.edition_id < current.edition_id)
              )
          ),
          current.profile,
          current.renderer_build,
          current.renderer_version,
          current.chromium_version,
          current.playwright_version,
          current.fonts_manifest_version,
          current.fonts_file_count,
          COALESCE(
            (
              SELECT part.editorial_spec
              FROM publication_part part
              WHERE part.publication_id = current.publication_id
              ORDER BY part.order_index ASC
              LIMIT 1
            ),
            '{"migration":"v4-layout-snapshot-unavailable"}'
          ),
          current.created_at
        FROM render_edition current
      `);
      db.exec(`
        INSERT INTO render_page_v5 (page_id, edition_id, part_id, page_index, width, height)
        SELECT page_id, edition_id, part_id, page_index, width, height
        FROM render_page
      `);
      db.exec(`
        INSERT INTO page_asset_v5 (page_id, asset_id, role)
        SELECT page_id, asset_id, role
        FROM page_asset
      `);
      db.exec('DROP TABLE page_asset');
      db.exec('DROP TABLE render_page');
      db.exec('DROP TABLE render_edition');
      db.exec('ALTER TABLE render_edition_v5 RENAME TO render_edition');
      db.exec('ALTER TABLE render_page_v5 RENAME TO render_page');
      db.exec('ALTER TABLE page_asset_v5 RENAME TO page_asset');
      for (const statement of SCHEMA_V5_FINAL_STATEMENTS) {
        db.exec(statement);
      }
      db.exec(`
        INSERT INTO publication_default_edition (publication_id, edition_id)
        SELECT publication_id, edition_id
        FROM render_edition
        WHERE edition_seq = 1
      `);
      createUserVersion(db, 5);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const fkProblem = db.prepare('PRAGMA foreign_key_check').get();
  if (fkProblem !== undefined) {
    throw new StorageSchemaError('schema v5 migration produced an invalid foreign-key graph');
  }
}

function upgradeToV6(db: DatabaseSync): void {
  runTransactional(db, SCHEMA_V6_STATEMENTS, 6);
}

function upgradeToV7(db: DatabaseSync): void {
  runTransactional(db, SCHEMA_V7_STATEMENTS, 7);
}

function upgradeToV8(db: DatabaseSync): void {
  runTransactional(db, SCHEMA_V8_STATEMENTS, 8);
}

function upgradeToV9(db: DatabaseSync): void {
  runTransactional(db, SCHEMA_V9_STATEMENTS, 9);
  upgradeToV10(db);
}

function upgradeToV10(db: DatabaseSync): void {
  inImmediateTransaction(db, () => {
    for (const statement of SCHEMA_V10_STATEMENTS) db.exec(statement);
    db.exec(`
      UPDATE device_channel
      SET library_revision =
        (SELECT count(*) FROM publication_channel pc WHERE pc.channel_id = device_channel.channel_id) +
        (SELECT count(DISTINCT ev.publication_id)
         FROM device_event ev
         JOIN device_binding b ON b.binding_id = ev.binding_id
         WHERE b.channel_id = device_channel.channel_id
           AND ev.kind = 'acknowledged'
           AND ev.publication_id IS NOT NULL)
    `);
    createUserVersion(db, 10);
  });
}

function readInstanceRow(db: DatabaseSync): { instance_id: string; created_at: string } {
  const instanceRow = db.prepare('SELECT instance_id, created_at FROM instance WHERE singleton = 1').get() as
    | { instance_id: string; created_at: string }
    | undefined;
  if (instanceRow === undefined) {
    throw new StorageSchemaError('database has no instance row');
  }
  return instanceRow;
}

function openDatabase(dataDir: string): { db: DatabaseSync; instanceId: string; createdAt: string } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(join(dataDir, DB_NAME));
  } catch (error) {
    // The SQLite open failure embeds the absolute database path.
    const wrapped = new Error(`database could not be opened (${fsFailureCategory(error)})`);
    // Preserve the SQLite result code so the transient-open retry above can
    // classify this failure without unwrapping the redacted message.
    (wrapped as { errcode?: number }).errcode = (error as { errcode?: number }).errcode;
    throw wrapped;
  }
  try {
    applyPragmas(db);

    const userVersion = readUserVersion(db);
    if (userVersion === 0) {
      // Fresh directory: the v1 identity table, its single instance row, the
      // v2 tables/indexes, the counter bootstrap rows, the v3 objects, the
      // v4 objects (with an empty backfill) are created atomically, then the
      // render graph is upgraded to v5 by the same migration used for old
      // stores. A crash leaves either the complete v4 or complete v5 state.
      const instanceId = `inst_${randomBytes(16).toString('hex')}`;
      const createdAt = new Date().toISOString();
      inImmediateTransaction(db, () => {
        for (const statement of SCHEMA_INSTANCE_TABLE) {
          db.exec(statement);
        }
        db.prepare('INSERT INTO instance (singleton, instance_id, created_at) VALUES (1, ?, ?)').run(
          instanceId,
          createdAt,
        );
        for (const statement of SCHEMA_V2_STATEMENTS) {
          db.exec(statement);
        }
        for (const statement of SCHEMA_V2_BOOTSTRAP) {
          db.exec(statement);
        }
        for (const statement of SCHEMA_V3_STATEMENTS) {
          db.exec(statement);
        }
        for (const statement of SCHEMA_V3_BOOTSTRAP) {
          db.exec(statement);
        }
        for (const statement of SCHEMA_V4_STATEMENTS) {
          db.exec(statement);
        }
        backfillPublicationQueryColumns(db);
        createUserVersion(db, 4);
      });
      upgradeToV5(db);
      upgradeToV6(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      return { db, instanceId, createdAt };
    }

    if (userVersion === 1 || userVersion === 2) {
      // In-place upgrade from an accepted older layout: identity and
      // created_at stay untouched; only new tables, indexes and columns are
      // added. v1 chains straight through the v2 statements into v3 inside
      // one single transaction; v2 runs only the v3 statements. Both then
      // continue into the v4 upgrade (a second transaction), whose backfill
      // finds no publication rows on v1/v2 layouts. A failure at any
      // statement rolls back to the complete previous version.
      const before = readInstanceRow(db);
      const statements =
        userVersion === 1
          ? [...SCHEMA_V2_STATEMENTS, ...SCHEMA_V2_BOOTSTRAP, ...SCHEMA_V3_STATEMENTS, ...SCHEMA_V3_BOOTSTRAP]
          : [...SCHEMA_V3_STATEMENTS, ...SCHEMA_V3_BOOTSTRAP];
      runTransactional(db, statements, 3);
      const mid = readInstanceRow(db);
      if (mid.instance_id !== before.instance_id || mid.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      upgradeToV4(db);
      upgradeToV5(db);
      upgradeToV6(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 3) {
      // MCP-03b layout: add the query columns (backfilled from the immutable
      // manuscript snapshots), the withdraw ledger and the cursor digests.
      // Identity and created_at stay untouched.
      const before = readInstanceRow(db);
      upgradeToV4(db);
      upgradeToV5(db);
      upgradeToV6(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 4) {
      const before = readInstanceRow(db);
      upgradeToV5(db);
      upgradeToV6(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 5) {
      const before = readInstanceRow(db);
      upgradeToV6(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 6) {
      const before = readInstanceRow(db);
      upgradeToV7(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 7) {
      const before = readInstanceRow(db);
      upgradeToV8(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 8) {
      const before = readInstanceRow(db);
      upgradeToV9(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion === 9) {
      const before = readInstanceRow(db);
      upgradeToV10(db);
      const after = readInstanceRow(db);
      if (after.instance_id !== before.instance_id || after.created_at !== before.created_at) {
        throw new StorageSchemaError('migration must not alter the instance identity');
      }
      return { db, instanceId: after.instance_id, createdAt: after.created_at };
    }

    if (userVersion !== SUPPORTED_SCHEMA_VERSION) {
      // Unknown (possibly newer) version: refuse, never downgrade.
      throw new StorageSchemaError(
        `database schema version ${userVersion} is not supported by this service ` +
          `(supported: ${SUPPORTED_SCHEMA_VERSION}); refusing to open or migrate`,
      );
    }

    const instanceRow = readInstanceRow(db);
    return { db, instanceId: instanceRow.instance_id, createdAt: instanceRow.created_at };
  } catch (error) {
    try {
      db.close();
    } catch {
      // best effort during error path
    }
    throw error;
  }
}

/**
 * Open the service data directory: take the ownership lock, open SQLite,
 * bootstrap or migrate the schema, and restore the persistent instance
 * identity. The same directory restarts with the same instance_id (v1
 * directories keep it across the v2 migration); a fresh directory yields a
 * fresh identity. Exactly one service process may own a directory at a time.
 *
 * Transient SQLite open failures (see OPEN_RETRY_DELAYS_MS) are retried a
 * bounded number of times; every attempt re-runs the full open sequence, and
 * the transactional schema bootstrap makes retried migrations safe.
 */
export function openDataStore(dataDir: string): DataStore {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    // The OS message embeds the absolute data directory path.
    throw new Error(`data directory could not be created (${fsFailureCategory(error)})`);
  }
  acquireLock(dataDir);

  let opened: { db: DatabaseSync; instanceId: string; createdAt: string };
  try {
    let attempt = 0;
    for (;;) {
      try {
        opened = openDatabase(dataDir);
        break;
      } catch (error) {
        attempt += 1;
        if (attempt > OPEN_RETRY_DELAYS_MS.length || !isTransientSqliteError(error)) {
          throw error;
        }
        sleepSync(OPEN_RETRY_DELAYS_MS[attempt - 1]!);
      }
    }
  } catch (error) {
    releaseLock(dataDir);
    throw error;
  }

  const { db, instanceId, createdAt } = opened;
  let restorePolicy: RestorePolicy | null;
  try {
    restorePolicy = readRestorePolicy(dataDir, instanceId);
  } catch (error) {
    try {
      db.close();
    } finally {
      releaseLock(dataDir);
    }
    throw error;
  }
  const restoredUnknown = new Set(restorePolicy?.unknown_operation_ids ?? []);
  return {
    instanceId,
    instanceCreatedAt: createdAt,
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    dataDir,
    restorePolicy,
    createAcceptanceRepository(): AcceptanceRepository {
      return new SqliteAcceptanceRepository(db, instanceId, restoredUnknown);
    },
    createPublicationRepository(): PublicationRepository {
      return new SqlitePublicationRepository(db, instanceId, restoredUnknown);
    },
    createQueryRepository(): QueryRepository {
      return new SqliteQueryRepository(db, instanceId);
    },
    createDeviceChannelRepository(): DeviceChannelRepository {
      return new SqliteDeviceChannelRepository(db, instanceId);
    },
    close() {
      try {
        db.close();
      } finally {
        releaseLock(dataDir);
      }
    },
  };
}
