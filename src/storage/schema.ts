/**
 * SQLite schema for the persistent acceptance facts and the publication
 * pipeline.
 *
 * Version history:
 *  - v1 (MCP-01/02): `instance` identity table only.
 *  - v2 (MCP-03a): adds the four fact families of persistent acceptance —
 *    immutable manuscript snapshots, the (instance, caller, request)
 *    idempotency ledger, operations with their reserved numbering, and the
 *    global acceptance / per-local-date publication counters.
 *  - v3 (MCP-03b): adds the operation execution facts (attempt count, lease
 *    id/expiry, stable failure code, completion timestamp as columns on
 *    `operation`), the global publication commit counter, and the immutable
 *    publication families: publication (1:1 with its operation, keyed by the
 *    acceptance-time reserved `YYYY-MM-DD-NN` id), ordered parts, render
 *    editions, pages, content-addressed assets and page-asset references.
 *  - v4 (MCP-04): adds the publication query columns (`deliver_after`,
 *    `expires_at`, `eligible_at`, `withdrawn_at` — backfilled from the
 *    immutable manuscript snapshots in the same migration transaction), the
 *    `(instance, caller, request)` withdraw idempotency ledger and the
 *    history cursor digest records.
 *  - v5 (publication delivery v2): replaces the single-edition-per-profile
 *    constraint with immutable per-publication edition sequences, stores the
 *    actual layout snapshot on each edition, and makes the publication's
 *    default edition an explicit fact.
 *  - v6 (Device Channel v1): freezes the acceptance-time channel route,
 *    adds channel/delivery, pairing/binding, device cursor and event facts.
 *  - v7 (production catalog v1): freezes the enabled template/resource
 *    catalog revision and complete selection snapshot with every manuscript.
 *  - v8 (terminal publication v1): freezes the business contract, absolute
 *    deadline and bounded review/terminal outcome facts on each operation.
 *  - v9 (terminal pre-acceptance finality): adds a caller/request-scoped
 *    rejection ledger for invalid terminal-v1 manuscripts. It stores only a
 *    digest and safe error facts, never the rejected manuscript bytes.
 *  - v10 (device library): adds an independent channel library revision and
 *    binds device history cursors to their filter, revision and recent window.
 *
 * Migrating v1 → v2 → v3 only creates new objects and columns; the `instance`
 * row (identity and created_at), the acceptance ledger, manuscript BLOBs,
 * operation IDs, sequences, reserved numbering and timestamps are untouched.
 * Every migration and the `PRAGMA user_version` update run inside one
 * transaction, so an interrupted or failed migration leaves the previous
 * version complete and byte-stable — never a half-migrated database. A
 * brand-new database bootstraps v1+v2+v3 in one transaction the same way. A
 * database claiming a newer (unknown) version is refused, never downgraded.
 *
 * Every version of this schema keeps `instance` exactly as MCP-01 created it;
 * the unique index on `instance_id` gives ledger rows a real FK target.
 */

/** DDL only a brand-new (user_version 0) database needs: the v1 identity table. */
export const SCHEMA_INSTANCE_TABLE: readonly string[] = [
  `CREATE TABLE instance (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     instance_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

/**
 * DDL that must hold at schema version 2, fresh and migrated alike. No
 * `IF NOT EXISTS`: a database that claims an older version while already
 * containing one of these tables is in a malformed half-state, and the
 * migration must fail loudly (and roll back) instead of silently keeping a
 * foreign table.
 */
export const SCHEMA_V2_STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX instance_identity ON instance (instance_id)`,
  `CREATE TABLE manuscript_snapshot (
     manuscript_id TEXT PRIMARY KEY,
     canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version = 1),
     digest_algorithm TEXT NOT NULL CHECK (digest_algorithm IN ('sha-256')),
     request_digest_hex TEXT NOT NULL CHECK (length(request_digest_hex) = 64),
     canonical_blob BLOB NOT NULL CHECK (length(canonical_blob) > 0),
     field_presence TEXT NOT NULL CHECK (length(field_presence) > 0),
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE operation (
     operation_id TEXT PRIMARY KEY,
     status TEXT NOT NULL CHECK (status IN ('accepted', 'processing', 'published', 'failed')),
     caller_id TEXT NOT NULL CHECK (length(caller_id) > 0),
     manuscript_id TEXT NOT NULL UNIQUE,
     acceptance_seq INTEGER NOT NULL UNIQUE CHECK (acceptance_seq > 0),
     accepted_at TEXT NOT NULL CHECK (length(accepted_at) > 0),
     reserved_publication_id TEXT NOT NULL UNIQUE CHECK (length(reserved_publication_id) > 0),
     reserved_local_date TEXT NOT NULL CHECK (length(reserved_local_date) = 10),
     FOREIGN KEY (manuscript_id) REFERENCES manuscript_snapshot (manuscript_id)
   )`,
  `CREATE TABLE request_ledger (
     instance_id TEXT NOT NULL,
     caller_id TEXT NOT NULL,
     request_id TEXT NOT NULL,
     request_digest_hex TEXT NOT NULL CHECK (length(request_digest_hex) = 64),
     canonicalization_version INTEGER NOT NULL,
     digest_algorithm TEXT NOT NULL,
     operation_id TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     PRIMARY KEY (instance_id, caller_id, request_id),
     FOREIGN KEY (operation_id) REFERENCES operation (operation_id),
     FOREIGN KEY (instance_id) REFERENCES instance (instance_id)
   )`,
  `CREATE TABLE acceptance_counter (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     next_seq INTEGER NOT NULL CHECK (next_seq > 0)
   )`,
  `CREATE TABLE publication_counter (
     local_date TEXT PRIMARY KEY CHECK (length(local_date) = 10),
     last_number INTEGER NOT NULL CHECK (last_number > 0)
   )`,
];

/** Bootstrap rows every empty v2 database needs (fresh path and migration). */
export const SCHEMA_V2_BOOTSTRAP: readonly string[] = [
  `INSERT INTO acceptance_counter (singleton, next_seq) VALUES (1, 1)`,
];

/**
 * DDL that upgrades schema version 2 to version 3 (MCP-03b): the operation
 * execution facts (attempt/lease/failure/completion columns on `operation`)
 * and the immutable publication fact families — global commit counter,
 * publication, ordered parts, render editions, pages, content-addressed
 * assets and their page references.
 *
 * v2→v3 runs inside one transaction together with `PRAGMA user_version = 3`.
 * `ALTER TABLE … ADD COLUMN` fails loudly when the column already exists, so
 * a database claiming v2 while already carrying v3 objects cannot be silently
 * skipped — the migration rolls back and the database stays a complete v2
 * (same doctrine as the v2 statements: no `IF NOT EXISTS` anywhere).
 */
export const SCHEMA_V3_STATEMENTS: readonly string[] = [
  // --- operation execution facts (state stays in the v2 status column) ---
  `ALTER TABLE operation ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)`,
  `ALTER TABLE operation ADD COLUMN lease_id TEXT`,
  `ALTER TABLE operation ADD COLUMN lease_expires_at TEXT`,
  `ALTER TABLE operation ADD COLUMN failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('invalid_input','unsupported_genre','unsupported_content_slot','unsupported_glyph','render_overflow','render_failed','storage_unavailable'))`,
  `ALTER TABLE operation ADD COLUMN completed_at TEXT`,
  `CREATE INDEX operation_claim_order ON operation (status, acceptance_seq)`,
  // --- global publication commit counter ---
  `CREATE TABLE publication_commit_counter (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     next_seq INTEGER NOT NULL CHECK (next_seq > 0)
   )`,
  // --- immutable publication: one row per published operation ---
  `CREATE TABLE publication (
     publication_id TEXT PRIMARY KEY CHECK (length(publication_id) > 0),
     operation_id TEXT NOT NULL UNIQUE,
     manuscript_id TEXT NOT NULL UNIQUE,
     request_digest_hex TEXT NOT NULL CHECK (length(request_digest_hex) = 64),
     acceptance_seq INTEGER NOT NULL CHECK (acceptance_seq > 0),
     commit_seq INTEGER NOT NULL UNIQUE CHECK (commit_seq > 0),
     committed_at TEXT NOT NULL CHECK (length(committed_at) > 0),
     delivery_intent TEXT NOT NULL CHECK (length(delivery_intent) > 0),
     author_title_adaptation TEXT,
     FOREIGN KEY (operation_id) REFERENCES operation (operation_id),
     FOREIGN KEY (manuscript_id) REFERENCES manuscript_snapshot (manuscript_id)
   )`,
  // --- ordered parts (exactly one main postcard part in this batch) ---
  `CREATE TABLE publication_part (
     part_id TEXT PRIMARY KEY,
     publication_id TEXT NOT NULL,
     order_index INTEGER NOT NULL CHECK (order_index >= 0),
     role TEXT NOT NULL CHECK (role IN ('main', 'continuation')),
     genre TEXT NOT NULL CHECK (length(genre) > 0),
     paper_snapshot TEXT NOT NULL CHECK (length(paper_snapshot) > 0),
     editorial_spec TEXT NOT NULL CHECK (length(editorial_spec) > 0),
     provenance_snapshot TEXT NOT NULL CHECK (length(provenance_snapshot) > 0),
     UNIQUE (publication_id, order_index),
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id)
   )`,
  // --- immutable render editions (one 540x960 gray4 profile per publication) ---
  `CREATE TABLE render_edition (
     edition_id TEXT PRIMARY KEY,
     publication_id TEXT NOT NULL,
     profile TEXT NOT NULL CHECK (length(profile) > 0),
     renderer_build TEXT NOT NULL CHECK (length(renderer_build) > 0),
     renderer_version TEXT NOT NULL CHECK (length(renderer_version) > 0),
     chromium_version TEXT NOT NULL CHECK (length(chromium_version) > 0),
     playwright_version TEXT NOT NULL CHECK (length(playwright_version) > 0),
     fonts_manifest_version INTEGER NOT NULL,
     fonts_file_count INTEGER NOT NULL CHECK (fonts_file_count > 0),
     created_at TEXT NOT NULL CHECK (length(created_at) > 0),
     UNIQUE (publication_id, profile),
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id)
   )`,
  // --- pages (exactly one page per edition in this batch) ---
  `CREATE TABLE render_page (
     page_id TEXT PRIMARY KEY,
     edition_id TEXT NOT NULL,
     part_id TEXT NOT NULL,
     page_index INTEGER NOT NULL CHECK (page_index >= 0),
     width INTEGER NOT NULL CHECK (width > 0),
     height INTEGER NOT NULL CHECK (height > 0),
     UNIQUE (edition_id, page_index),
     FOREIGN KEY (edition_id) REFERENCES render_edition (edition_id),
     FOREIGN KEY (part_id) REFERENCES publication_part (part_id)
   )`,
  // --- content-addressed immutable assets ---
  `CREATE TABLE asset (
     asset_id TEXT PRIMARY KEY,
     sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
     kind TEXT NOT NULL CHECK (kind IN ('png', 'gray4')),
     media_type TEXT NOT NULL CHECK (length(media_type) > 0),
     byte_length INTEGER NOT NULL CHECK (byte_length > 0),
     relative_path TEXT NOT NULL UNIQUE CHECK (length(relative_path) > 0),
     created_at TEXT NOT NULL CHECK (length(created_at) > 0)
   )`,
  `CREATE TABLE page_asset (
     page_id TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('primary', 'gray4')),
     PRIMARY KEY (page_id, asset_id),
     FOREIGN KEY (page_id) REFERENCES render_page (page_id),
     FOREIGN KEY (asset_id) REFERENCES asset (asset_id)
   )`,
];

/** Bootstrap rows every schema v3 database needs (fresh path and migration). */
export const SCHEMA_V3_BOOTSTRAP: readonly string[] = [
  `INSERT INTO publication_commit_counter (singleton, next_seq) VALUES (1, 1)`,
];

/**
 * DDL that upgrades schema version 3 to version 4 (MCP-04): the publication
 * query columns, the withdraw idempotency ledger and the history cursor
 * digest records, plus the ordering indexes the query paths rely on.
 *
 * The four publication columns arrive via `ALTER TABLE … ADD COLUMN` (no
 * DEFAULT, no NOT NULL) and are backfilled for every existing row inside the
 * SAME migration transaction by `backfillPublicationQueryColumns` — v3 rows
 * derive `deliver_after`/`expires_at` deterministically from their immutable
 * manuscript snapshot and `eligible_at = max(accepted_at, deliverAfter)`;
 * `withdrawn_at` starts NULL (nothing was ever withdrawn under v3). Like the
 * earlier migrations there is no `IF NOT EXISTS`: a database claiming v3
 * while already carrying a v4 object fails loudly and rolls back to a
 * complete v3.
 *
 * All times written to these columns are normalized UTC instants
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`, fixed width) so SQL text comparison equals
 * instant comparison — see src/domain/delivery.ts.
 */
export const SCHEMA_V4_STATEMENTS: readonly string[] = [
  // --- publication query columns (backfilled in the same transaction) ---
  `ALTER TABLE publication ADD COLUMN deliver_after TEXT`,
  `ALTER TABLE publication ADD COLUMN expires_at TEXT`,
  `ALTER TABLE publication ADD COLUMN eligible_at TEXT`,
  `ALTER TABLE publication ADD COLUMN withdrawn_at TEXT`,
  // --- ordering indexes for the caller-scoped query paths ---
  `CREATE INDEX operation_caller_order ON operation (caller_id, acceptance_seq DESC)`,
  `CREATE INDEX publication_offer_order ON publication (eligible_at DESC, acceptance_seq DESC)`,
  // --- withdraw idempotency ledger: one stored outcome per key ---
  `CREATE TABLE withdraw_ledger (
     instance_id TEXT NOT NULL,
     caller_id TEXT NOT NULL CHECK (length(caller_id) > 0),
     request_id TEXT NOT NULL CHECK (length(request_id) > 0),
     publication_id TEXT NOT NULL CHECK (length(publication_id) > 0),
     withdrawn_at TEXT NOT NULL CHECK (length(withdrawn_at) > 0),
     created_at TEXT NOT NULL CHECK (length(created_at) > 0),
     PRIMARY KEY (instance_id, caller_id, request_id),
     FOREIGN KEY (instance_id) REFERENCES instance (instance_id),
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id)
   )`,
  `CREATE INDEX withdraw_ledger_publication ON withdraw_ledger (publication_id)`,
  // --- history cursor digests: the token itself is never stored ---
  `CREATE TABLE history_cursor (
     cursor_id TEXT PRIMARY KEY,
     instance_id TEXT NOT NULL,
     caller_id TEXT NOT NULL CHECK (length(caller_id) > 0),
     cursor_digest TEXT NOT NULL UNIQUE CHECK (length(cursor_digest) = 64),
     snapshot_high_water INTEGER NOT NULL CHECK (snapshot_high_water >= 0),
     last_acceptance_seq INTEGER NOT NULL CHECK (last_acceptance_seq > 0),
     page_size INTEGER NOT NULL CHECK (page_size > 0 AND page_size <= 100),
     created_at TEXT NOT NULL CHECK (length(created_at) > 0),
     expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
     UNIQUE (instance_id, caller_id, cursor_digest),
     FOREIGN KEY (instance_id) REFERENCES instance (instance_id)
   )`,
];

/**
 * Replacement tables used by the v4 -> v5 migration. SQLite cannot remove
 * the old `UNIQUE (publication_id, profile)` constraint in place, so the
 * migration rebuilds the three-table render graph while foreign-key
 * enforcement is temporarily disabled. The caller copies all rows, swaps the
 * tables and runs `foreign_key_check` before accepting the new version.
 */
export const SCHEMA_V5_REPLACEMENT_TABLES: readonly string[] = [
  `CREATE TABLE render_edition_v5 (
     edition_id TEXT PRIMARY KEY,
     publication_id TEXT NOT NULL,
     edition_seq INTEGER NOT NULL CHECK (edition_seq > 0),
     profile TEXT NOT NULL CHECK (length(profile) > 0),
     renderer_build TEXT NOT NULL CHECK (length(renderer_build) > 0),
     renderer_version TEXT NOT NULL CHECK (length(renderer_version) > 0),
     chromium_version TEXT NOT NULL CHECK (length(chromium_version) > 0),
     playwright_version TEXT NOT NULL CHECK (length(playwright_version) > 0),
     fonts_manifest_version INTEGER NOT NULL,
     fonts_file_count INTEGER NOT NULL CHECK (fonts_file_count > 0),
     layout_snapshot TEXT NOT NULL CHECK (length(layout_snapshot) > 0),
     created_at TEXT NOT NULL CHECK (length(created_at) > 0),
     UNIQUE (publication_id, edition_seq),
     UNIQUE (publication_id, edition_id),
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id)
   )`,
  `CREATE TABLE render_page_v5 (
     page_id TEXT PRIMARY KEY,
     edition_id TEXT NOT NULL,
     part_id TEXT NOT NULL,
     page_index INTEGER NOT NULL CHECK (page_index >= 0),
     width INTEGER NOT NULL CHECK (width > 0),
     height INTEGER NOT NULL CHECK (height > 0),
     UNIQUE (edition_id, page_index),
     FOREIGN KEY (edition_id) REFERENCES render_edition_v5 (edition_id),
     FOREIGN KEY (part_id) REFERENCES publication_part (part_id)
   )`,
  `CREATE TABLE page_asset_v5 (
     page_id TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('primary', 'gray4')),
     PRIMARY KEY (page_id, asset_id),
     FOREIGN KEY (page_id) REFERENCES render_page_v5 (page_id),
     FOREIGN KEY (asset_id) REFERENCES asset (asset_id)
   )`,
];

/** Objects created after the v5 replacement tables have their final names. */
export const SCHEMA_V5_FINAL_STATEMENTS: readonly string[] = [
  `CREATE INDEX render_edition_profile ON render_edition (publication_id, profile, edition_seq DESC)`,
  `CREATE TABLE publication_default_edition (
     publication_id TEXT PRIMARY KEY,
     edition_id TEXT NOT NULL UNIQUE,
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id),
     FOREIGN KEY (publication_id, edition_id) REFERENCES render_edition (publication_id, edition_id)
   )`,
];

export const SCHEMA_V6_STATEMENTS: readonly string[] = [
  `ALTER TABLE operation ADD COLUMN channel_id TEXT`,
  `CREATE TABLE device_channel (
     channel_id TEXT PRIMARY KEY CHECK (length(channel_id) > 0),
     epoch TEXT NOT NULL CHECK (length(epoch) > 0),
     revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
     offer_fingerprint TEXT NOT NULL DEFAULT '',
     current_publication_id TEXT,
     created_at TEXT NOT NULL CHECK (length(created_at) > 0),
     FOREIGN KEY (current_publication_id) REFERENCES publication (publication_id)
   )`,
  `CREATE TABLE publication_channel (
     channel_id TEXT NOT NULL,
     publication_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL UNIQUE CHECK (length(delivery_id) > 0),
     routed_at TEXT NOT NULL CHECK (length(routed_at) > 0),
     first_offered_at TEXT,
     superseded_at TEXT,
     PRIMARY KEY (channel_id, publication_id),
     FOREIGN KEY (channel_id) REFERENCES device_channel (channel_id),
     FOREIGN KEY (publication_id) REFERENCES publication (publication_id)
   )`,
  `CREATE INDEX publication_channel_history ON publication_channel (channel_id, publication_id)`,
  `CREATE TABLE device_pairing (
     code_digest TEXT PRIMARY KEY CHECK (length(code_digest) = 64),
     pairing_id TEXT NOT NULL UNIQUE,
     channel_id TEXT NOT NULL,
     allowed_profiles TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
     failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
     consumed_at TEXT,
     request_id TEXT,
     request_digest TEXT,
     binding_id TEXT,
     FOREIGN KEY (channel_id) REFERENCES device_channel (channel_id)
   )`,
  `CREATE TABLE device_binding (
     binding_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     instance_id TEXT NOT NULL,
     epoch TEXT NOT NULL,
     protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
     secret_sha256 TEXT NOT NULL UNIQUE CHECK (length(secret_sha256) = 64),
     profiles TEXT NOT NULL,
     limits TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active','revoked')),
     created_at TEXT NOT NULL,
     revoked_at TEXT,
     FOREIGN KEY (channel_id) REFERENCES device_channel (channel_id),
     FOREIGN KEY (instance_id) REFERENCES instance (instance_id)
   )`,
  `CREATE INDEX device_binding_secret ON device_binding (secret_sha256)`,
  `CREATE TABLE device_history_cursor (
     cursor_digest TEXT PRIMARY KEY CHECK (length(cursor_digest) = 64),
     binding_id TEXT NOT NULL,
     snapshot_high_water INTEGER NOT NULL CHECK (snapshot_high_water >= 0),
     last_acceptance_seq INTEGER NOT NULL CHECK (last_acceptance_seq > 0),
     page_size INTEGER NOT NULL CHECK (page_size > 0 AND page_size <= 100),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     FOREIGN KEY (binding_id) REFERENCES device_binding (binding_id)
   )`,
  `CREATE TABLE device_event (
     binding_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     seq INTEGER NOT NULL CHECK (seq > 0),
     kind TEXT NOT NULL CHECK (kind IN ('cached','presented','acknowledged','status','interaction')),
     payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
     payload_json TEXT NOT NULL,
     publication_id TEXT,
     page_id TEXT,
     frame_id TEXT,
     delivery_id TEXT,
     received_at TEXT NOT NULL,
     PRIMARY KEY (binding_id, event_id),
     UNIQUE (binding_id, seq),
     FOREIGN KEY (binding_id) REFERENCES device_binding (binding_id)
   )`,
  `CREATE INDEX device_event_publication ON device_event (binding_id, publication_id, kind)`,
  `CREATE TABLE device_binding_state (
     binding_id TEXT PRIMARY KEY,
     last_seq INTEGER NOT NULL CHECK (last_seq > 0),
     state_json TEXT NOT NULL,
     reported_at TEXT NOT NULL,
     FOREIGN KEY (binding_id) REFERENCES device_binding (binding_id)
   )`,
];

/**
 * C2 acceptance freeze. Existing snapshots predate the production registry;
 * they receive an explicit legacy marker and are never reinterpreted as if
 * they had been accepted under the new catalog.
 */
export const SCHEMA_V7_STATEMENTS: readonly string[] = [
  `ALTER TABLE manuscript_snapshot ADD COLUMN production_catalog_revision TEXT NOT NULL DEFAULT 'legacy-v1' CHECK (length(production_catalog_revision) > 0)`,
  `ALTER TABLE manuscript_snapshot ADD COLUMN production_catalog_snapshot TEXT NOT NULL DEFAULT '{"revision":"legacy-v1","resources_revision":"legacy-v1","enabled_layouts":[],"request":{}}' CHECK (length(production_catalog_snapshot) > 0)`,
];

/**
 * C2 terminal publication contract. The legacy accepted-v2 contract remains
 * the migration default so existing operations keep their original meaning.
 * A terminal-v1 operation owns one absolute deadline; terminal_code/detail
 * are deliberately separate from the older constrained failure_code column
 * so the legacy failure vocabulary and historical rows remain byte-stable.
 */
export const SCHEMA_V8_STATEMENTS: readonly string[] = [
  `ALTER TABLE operation ADD COLUMN business_contract TEXT NOT NULL DEFAULT 'accepted-v2' CHECK (business_contract IN ('accepted-v2','terminal-v1'))`,
  `ALTER TABLE operation ADD COLUMN deadline_at TEXT`,
  `ALTER TABLE operation ADD COLUMN terminal_code TEXT`,
  `ALTER TABLE operation ADD COLUMN terminal_detail TEXT`,
  `ALTER TABLE operation ADD COLUMN review_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (review_status IN ('not_requested','deterministic_only','pending','approved','rejected','technical_failure'))`,
  `ALTER TABLE operation ADD COLUMN review_snapshot TEXT`,
  `CREATE INDEX operation_terminal_deadline ON operation (business_contract, status, deadline_at)`,
];

/**
 * C3 closes terminal-v1's pre-acceptance ambiguity. A schema/manuscript
 * rejection is a durable final outcome in the same logical idempotency
 * namespace as request_ledger, while deliberately consuming no acceptance
 * sequence, operation id, publication number or manuscript snapshot.
 */
export const SCHEMA_V9_STATEMENTS: readonly string[] = [
  `CREATE TABLE preacceptance_rejection (
     instance_id TEXT NOT NULL,
     caller_id TEXT NOT NULL CHECK (length(caller_id) > 0),
     request_id TEXT NOT NULL CHECK (length(request_id) > 0),
     request_digest_hex TEXT NOT NULL CHECK (length(request_digest_hex) = 64),
     canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version = 1),
     digest_algorithm TEXT NOT NULL CHECK (digest_algorithm = 'sha-256'),
     business_contract TEXT NOT NULL CHECK (business_contract = 'terminal-v1'),
     failure_code TEXT NOT NULL CHECK (failure_code IN ('invalid_input','unsupported_genre','unsupported_content_slot')),
     failure_message TEXT NOT NULL CHECK (length(failure_message) > 0),
     rejected_at TEXT NOT NULL CHECK (length(rejected_at) > 0),
     PRIMARY KEY (instance_id, caller_id, request_id),
     FOREIGN KEY (instance_id) REFERENCES instance (instance_id)
   )`,
];

export const SCHEMA_V10_STATEMENTS: readonly string[] = [
  `ALTER TABLE device_channel ADD COLUMN library_revision INTEGER NOT NULL DEFAULT 0 CHECK (library_revision >= 0)`,
  `ALTER TABLE device_history_cursor ADD COLUMN filter TEXT NOT NULL DEFAULT 'legacy' CHECK (filter IN ('legacy','recent','unread'))`,
  `ALTER TABLE device_history_cursor ADD COLUMN library_revision INTEGER NOT NULL DEFAULT 0 CHECK (library_revision >= 0)`,
  `ALTER TABLE device_history_cursor ADD COLUMN remaining_items INTEGER CHECK (remaining_items IS NULL OR remaining_items >= 0)`,
];

export const TABLE_NAMES_V2: readonly string[] = [
  'instance',
  'manuscript_snapshot',
  'operation',
  'request_ledger',
  'acceptance_counter',
  'publication_counter',
];

export const TABLE_NAMES_V3: readonly string[] = [
  ...TABLE_NAMES_V2,
  'publication_commit_counter',
  'publication',
  'publication_part',
  'render_edition',
  'render_page',
  'asset',
  'page_asset',
];

export const TABLE_NAMES_V4: readonly string[] = [
  ...TABLE_NAMES_V3,
  'withdraw_ledger',
  'history_cursor',
];

export const TABLE_NAMES_V5: readonly string[] = [
  ...TABLE_NAMES_V4,
  'publication_default_edition',
];

export const TABLE_NAMES_V6: readonly string[] = [
  ...TABLE_NAMES_V5,
  'device_channel',
  'publication_channel',
  'device_pairing',
  'device_binding',
  'device_history_cursor',
  'device_event',
  'device_binding_state',
];

export const TABLE_NAMES_V7: readonly string[] = [...TABLE_NAMES_V6];
export const TABLE_NAMES_V8: readonly string[] = [...TABLE_NAMES_V7];
export const TABLE_NAMES_V9: readonly string[] = [...TABLE_NAMES_V8, 'preacceptance_rejection'];
export const TABLE_NAMES_V10: readonly string[] = [...TABLE_NAMES_V9];
