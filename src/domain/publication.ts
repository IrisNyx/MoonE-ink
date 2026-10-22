/**
 * Publication domain contract (MCP-03b): the worker-facing repository that
 * owns operation execution state, and the read-side view the
 * `ephemera_request_status` tool serves.
 *
 * All state transitions happen inside repository methods (single SQLite
 * transactions); the worker never writes SQL. Storage failures surface as
 * safe `storage_unavailable` errors — never SQL text, paths or OS messages.
 */

import type { AuthorTitleAuthorizationV1 } from './manuscript.js';
import type { DeliveryIntentSnapshot, OperationStatus, PublicationBusinessContract } from './acceptance.js';

/** Stable failure codes an operation can terminate with. */
export type OperationFailureCode =
  | 'invalid_input'
  | 'unsupported_genre'
  | 'unsupported_content_slot'
  | 'unsupported_glyph'
  | 'render_overflow'
  | 'render_failed'
  | 'storage_unavailable'
  | 'unknown_after_restore';

export type TerminalFailureCode = OperationFailureCode | 'deadline_exceeded' | 'model_rejected' | 'model_unavailable';

export interface ClaimInput {
  nowIso: string;
  leaseId: string;
  leaseDurationMs: number;
  maxAttempts: number;
}

/** An operation claimed for one attempt, with its immutable manuscript BLOB. */
export interface ClaimedJob {
  operation_id: string;
  manuscript_id: string;
  caller_id: string;
  acceptance_seq: number;
  /** Immutable UTC instant captured when this manuscript was accepted. */
  accepted_at: string;
  reserved_publication_id: string;
  attempt_count: number;
  lease_id: string;
  lease_expires_at: string;
  /** The canonical manuscript JSON bytes accepted with the operation. */
  canonical: Uint8Array;
  request_digest_hex: string;
  business_contract: PublicationBusinessContract;
  deadline_at: string | null;
  production_catalog_snapshot: unknown;
}

export interface CommitAssetInput {
  sha256: string;
  kind: 'png' | 'gray4';
  mediaType: string;
  byteLength: number;
  /** Content-addressed path relative to the data directory. */
  relativePath: string;
  /** Which page slot the asset fills. */
  role: 'primary' | 'gray4';
}

export interface PublicationCommitInput {
  operationId: string;
  leaseId: string;
  nowIso: string;
  deliveryIntent: DeliveryIntentSnapshot;
  authorTitleAdaptation: AuthorTitleAuthorizationV1 | null;
  /**
   * The author's delivery window spellings from the immutable manuscript
   * (RFC 3339 as authored, or null). Storage normalizes them and persists
   * `deliver_after`/`expires_at`/`eligible_at` on the publication row
   * (schema v4); the query paths order by those facts, never by completion
   * time.
   */
  deliverAfter: string | null;
  expiresAt: string | null;
  /** Legacy one-part input; new publications use `parts`. */
  part?: {
    id: string;
    role: 'main';
    genre: string;
    /** Renderer-facing structured data snapshot (JSON-serialized in storage). */
    paper: unknown;
    editorialSpec: unknown;
    /** Body/title provenance records covering the manuscript exactly once. */
    provenance: unknown;
  };
  /** Ordered main plus optional continuation/supplement parts. */
  parts?: Array<{
    id: string;
    role: 'main' | 'continuation';
    genre: string;
    paper: unknown;
    editorialSpec: unknown;
    provenance: unknown;
  }>;
  edition: {
    id: string;
    seq: number;
    profile: string;
    rendererBuild: string;
    rendererVersion: string;
    chromiumVersion: string;
    playwrightVersion: string;
    fontsManifestVersion: number;
    fontsFileCount: number;
    /** Actual per-edition layout, page breaks and source ranges. */
    layoutSnapshot: unknown;
  };
  pages: Array<{
    id: string;
    index: number;
    width: number;
    height: number;
    /** Index into `parts`; omitted means the first/main part. */
    partIndex?: number;
    assets: CommitAssetInput[];
  }>;
}

export interface PublicationCommitResult {
  publication_id: string;
  commit_seq: number;
  /** False when the publication already existed (idempotent re-commit). */
  created: boolean;
}

/** Read-side page/asset facts for the status summary. */
export interface PublicationPageView {
  page_id: string;
  page_index: number;
  width: number;
  height: number;
  assets: {
    role: 'primary' | 'gray4';
    kind: 'png' | 'gray4';
    sha256: string;
    bytes: number;
  }[];
}

export interface PublicationSummaryView {
  publication_id: string;
  commit_seq: number;
  edition_id: string;
  profile: string;
  target: { width: number; height: number };
  renderer: {
    build: string;
    version: string;
    chromium: string;
    playwright: string;
    fonts_manifest_version: number;
    fonts_file_count: number;
  };
  pages: PublicationPageView[];
}

export interface OperationStatusView {
  instance_id: string;
  operation_id: string;
  request_id: string;
  caller_id: string;
  status: OperationStatus;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  attempt_count: number;
  failure_code: TerminalFailureCode | null;
  business_contract: PublicationBusinessContract;
  deadline_at: string | null;
  terminal_detail: string | null;
  /** Present exactly when status is published. */
  publication: PublicationSummaryView | null;
}

export interface ExecutionFacts {
  status: OperationStatus;
  attempt_count: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  failure_code: TerminalFailureCode | null;
  business_contract: PublicationBusinessContract;
  deadline_at: string | null;
  completed_at: string | null;
}

export interface AdminFailureView {
  reference: string;
  caller_id: string;
  accepted_at: string;
  code: string;
  detail: string | null;
}

export interface AdminPublicationTextView {
  editor_additions: Array<{ path: string; value: string }>;
}

export interface ReviewCompletionInput {
  operationId: string;
  leaseId: string;
  nowIso: string;
  status: 'approved' | 'rejected' | 'technical_failure';
  /** Bounded evidence only; never raw images or manuscript text. */
  snapshot: unknown;
  terminalCode?: 'model_rejected' | 'model_unavailable';
  terminalDetail?: string;
}

/**
 * Storage contract of the publication domain. Every mutating method runs in
 * its own `BEGIN IMMEDIATE` transaction and maps storage failures to
 * `storage_unavailable`.
 */
export interface PublicationRepository {
  /** Claim the earliest eligible operation for one attempt (or null). */
  claim(input: ClaimInput): ClaimedJob | null;
  /**
   * Atomically insert asset/publication/part/edition/page rows, allocate the
   * global commit sequence and mark the operation published. Idempotent for
   * an operation that is already published (returns the stored facts).
   */
  commitPublication(input: PublicationCommitInput): PublicationCommitResult | null;
  /**
   * Release the lease so a transient failure can be retried later; the
   * attempt count stays. The status remains processing with an expired lease.
   */
  releaseForRetry(operationId: string, leaseId: string, nowIso: string): void;
  /** Terminate the operation with a stable failure code (permanent). */
  failOperation(operationId: string, leaseId: string, code: OperationFailureCode, nowIso: string, detail?: string): void;
  /** Atomically make an elapsed terminal-v1 request permanently failed. */
  expireOperation(operationId: string, nowIso: string): boolean;
  /** Persist review evidence; rejection/failure terminalizes in the same transaction. */
  completeReview(input: ReviewCompletionInput): void;
  /** Caller-scoped status view by operation id or request id (exactly one). */
  statusForCaller(
    callerId: string,
    query: { operationId?: string; requestId?: string },
  ): OperationStatusView | null;
  /** Execution facts of one operation (tests and diagnostics). */
  executionFacts(operationId: string): ExecutionFacts | null;
  /** Safe recent terminal failures for the owner console. */
  adminRecentFailures?(limit: number): AdminFailureView[];
  /** Owner-only text provenance for the Console; never exposed through author MCP. */
  adminPublicationText?(publicationId: string, callerId: string): AdminPublicationTextView | null;
  /** Publication row counts + commit counter (tests and diagnostics). */
  publicationCounts(): {
    publication: number;
    part: number;
    edition: number;
    page: number;
    asset: number;
    pageAsset: number;
    nextCommitSeq: number;
  };
  /** Relative paths of all assets referenced by committed publications. */
  referencedAssetPaths(): string[];
}
