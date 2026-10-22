/**
 * Single-concurrency publication worker (MCP-03b).
 *
 * Loop per attempt (task card ordering):
 *  1. claim the earliest eligible operation inside one SQLite transaction
 *     (status accepted, or processing with an expired lease and attempts
 *     left) — writing a high-entropy lease id, lease expiry and the new
 *     attempt count. The same transaction first terminalizes any
 *     processing row whose lease expired with all attempts consumed
 *     (crash exhaustion) to a durable failed/render_failed state, so no
 *     fourth claim of that operation can ever exist;
 *  2. render OUTSIDE any transaction into this lease's scratch directory;
 *  3. independently re-verify the written artifacts (digest, byte length,
 *     PNG geometry, gray4 length, render manifest agreement);
 *  4. move the artifacts to immutable content-addressed paths (atomic
 *     same-directory temp + fsync + rename);
 *  5. commit asset/publication/part/edition/page rows, the commit sequence
 *     and the operation's `published` state in ONE transaction;
 *  6. only then does any status query report published.
 *
 * Failure policy: the five content/fit codes fail permanently on the first
 * attempt, as does a deterministic author-content integrity violation (both
 * without consuming the retry budget); everything else (renderer, asset,
 * storage) retries with a bounded total of 3 attempts and then terminates as
 * `render_failed` or `storage_unavailable`. The operation-level failure code
 * space is exactly those seven stable codes. Attempts, leases and state
 * transitions are all persisted; a restarted process only reclaims
 * operations whose lease has expired and continues the same operation,
 * manuscript and reserved number. If every attempt crashed, the next
 * claim after the final lease expires terminalizes the operation to a
 * durable failed state instead of leaving it processing forever.
 *
 * The renderer is a constructor dependency. Production passes the real
 * MCP-02 pipeline; tests may inject blocking/crashing/failing renderers —
 * the injection point is code-only, never JSON configuration, environment
 * or a public API.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';
import { resolveDeliveryIntent } from '../domain/acceptance.js';
import type { ClaimedJob, OperationFailureCode, PublicationRepository, ReviewCompletionInput } from '../domain/publication.js';
import { GRAY4_BYTE_LENGTH, LANDSCAPE_PAGE_HEIGHT, LANDSCAPE_PAGE_WIDTH, PAGE_HEIGHT, PAGE_WIDTH,
  RENDERER_BUILD, SERVICE_VERSION } from '../version.js';
import { readPngHeader } from '../render/gray4.js';
import { RenderError } from '../render/errors.js';
import { AssetStore } from './assets.js';
import { countScalars, mapToRendererManuscript } from './renderer.js';
import {
  effectiveTitle,
  selectedGenre,
  validateManuscript,
  type Manuscript,
  type ManuscriptV2,
  type ManuscriptV3,
} from '../domain/manuscript.js';
import {
  applyEditorAdditions,
  missingEditorSlots,
  type EditorAddition,
  type EditorSlot,
} from '../domain/genre-content.js';
import { layoutForGenre, PRODUCTION_LAYOUTS, type ProductionGenreId, type ProductionLayout } from '../production-catalog.js';
import type { AlmanacFacts } from '../facts/almanac.js';
import type { WeatherSnapshot } from '../weather/types.js';
import type { RendererManuscriptV1 } from '../render/manuscript.js';
import {
  TYPESETTER_REVIEW_SCHEMA,
  type TypesetterEvidence,
  type TypesetterReviewInput,
  type TypesetterReviewOutcome,
} from '../typesetter/reviewer.js';

/** Fixed maximum attempts including the first (task card). */
export const MAX_ATTEMPTS = 3;

/**
 * Render error codes that permanently fail an operation without retry,
 * mapped to their stable operation-level failure code.
 */
const PERMANENT_TERMINAL_CODES: ReadonlyMap<string, OperationFailureCode> = new Map([
  ['invalid_input', 'invalid_input'],
  ['unsupported_genre', 'unsupported_genre'],
  ['unsupported_content_slot', 'unsupported_content_slot'],
  ['unsupported_glyph', 'unsupported_glyph'],
  ['render_overflow', 'render_overflow'],
]);

/**
 * Thrown by test seams to simulate the process dying at a specific point:
 * the worker abandons everything without any further database or filesystem
 * write — no status transition, no scratch cleanup — exactly like a killed
 * process. Production code never constructs it.
 */
export class SimulatedProcessDeath extends Error {
  constructor(readonly point: string) {
    super(`simulated process death at ${point}`);
    this.name = 'SimulatedProcessDeath';
  }
}

export interface RenderJobInput {
  operationId: string;
  leaseId: string;
  manuscript: Manuscript;
  /** Bounded secondary text added by the editor; never merged into the author manuscript. */
  editorAdditions?: readonly EditorAddition[];
  /** Trusted data resolved by the service, never authored or invented by the typesetter. */
  publicationFacts?: { almanac?: AlmanacFacts; weather?: WeatherSnapshot };
  /** Present for the legacy postcard renderer; notes use the v2 manuscript. */
  rendererManuscript?: RendererManuscriptV1;
  /** Acceptance-time local date reserved into the publication id. */
  date?: string;
  /** Immutable acceptance instant; used by layouts that print a publication time. */
  acceptedAt?: string;
  /** IANA timezone paired with the reserved local date. */
  timezone?: string;
  tmpDir: string;
}

export interface WorkerRenderOutcome {
  genre?: ProductionGenreId;
  profile?: string;
  rendererBuild?: string;
  /** Renderer-reported per-file facts; re-verified against the real bytes. */
  png: { sha256: string; bytes: number };
  gray4: { sha256: string; bytes: number };
  tone: { value: string; source: 'author' | 'template-default' };
  chromium: { version: string; revision: string; playwright: string };
  fonts: { manifestVersion: number; count: number; served: number };
  gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
  /** Multi-page render facts. Absent means the legacy page.png/page.gray4 pair. */
  pages?: Array<{
    index: number;
    width?: number;
    height?: number;
    pngName: string;
    gray4Name: string;
    png: { sha256: string; bytes: number };
    gray4: { sha256: string; bytes: number };
    gray4Facts: { byteLength: number; inkPixels: number; distinctLevels: number[] };
    sourceRanges?: unknown[];
    partRole?: 'main' | 'supplement';
  }>;
  paper?: unknown;
  editorialSpec?: unknown;
  provenance?: unknown;
  parts?: Array<{ role: 'main' | 'supplement'; genre: string; paper: unknown; editorialSpec: unknown; provenance: unknown }>;
}

export interface WorkerLogger {
  debug(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

export interface WorkerDeps {
  repository: PublicationRepository;
  assets: AssetStore;
  /** Execute the real render into tmpDir; production passes the MCP-02 pipeline. */
  render: (job: RenderJobInput) => Promise<WorkerRenderOutcome>;
  resolvePublicationFacts?: (input: {
    genre: ProductionGenreId;
    publicationDate: string;
  }) => Promise<{ almanac?: AlmanacFacts; weather?: WeatherSnapshot } | undefined>;
  /** Optional visual reviewer; only terminal-v1 uses this submission gate. */
  reviewer?: {
    review(input: TypesetterReviewInput): Promise<TypesetterReviewOutcome>;
    isEnabled?(): boolean;
    select?(input: {
      manuscript: unknown;
      catalogRevision: string;
      candidates: ProductionLayout[];
      deadlineAt: string;
    }): Promise<{ kind: 'selected'; layoutId: string; reason: string } | { kind: 'technical_failure' }>;
    fill?(input: {
      manuscript: unknown;
      layoutId: string;
      allowedSlots: readonly EditorSlot[];
      facts?: unknown;
      deadlineAt: string;
    }): Promise<{ kind: 'filled'; additions: EditorAddition[] } | { kind: 'technical_failure' }>;
    returnFeedback?(input: {
      layoutId: string;
      issues: TypesetterEvidence['issues'];
      deadlineAt: string;
    }): Promise<string>;
  };
  now?: () => Date;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /**
   * Test-only lifecycle probe fired after the final assets are durable and
   * right before the publication commit. Throwing SimulatedProcessDeath from
   * it acts like dying at that exact point.
   */
  onBeforeCommit?: (job: ClaimedJob, assets: { png: string; gray4: string }) => void;
  log?: WorkerLogger;
}

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;
const STOP_TIMEOUT_MS = 120_000;

interface ArtifactPageFacts {
  index: number;
  width: number;
  height: number;
  partRole?: 'main' | 'supplement';
  png: { sha256: string; bytes: number; relativePath: string };
  gray4: { sha256: string; bytes: number; relativePath: string };
}

interface ArtifactFacts {
  pages: ArtifactPageFacts[];
  /** First-page aliases retained for the existing process-death test seam. */
  png: ArtifactPageFacts['png'];
  gray4: ArtifactPageFacts['gray4'];
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export class PublicationWorker {
  private readonly repository: PublicationRepository;
  private readonly assets: AssetStore;
  private readonly renderFn: (job: RenderJobInput) => Promise<WorkerRenderOutcome>;
  private readonly reviewer?: {
    review(input: TypesetterReviewInput): Promise<TypesetterReviewOutcome>;
    isEnabled?(): boolean;
    select?(input: {
      manuscript: unknown;
      catalogRevision: string;
      candidates: ProductionLayout[];
      deadlineAt: string;
    }): Promise<{ kind: 'selected'; layoutId: string; reason: string } | { kind: 'technical_failure' }>;
    fill?(input: {
      manuscript: unknown;
      layoutId: string;
      allowedSlots: readonly EditorSlot[];
      facts?: unknown;
      deadlineAt: string;
    }): Promise<{ kind: 'filled'; additions: EditorAddition[] } | { kind: 'technical_failure' }>;
    returnFeedback?(input: {
      layoutId: string;
      issues: TypesetterEvidence['issues'];
      deadlineAt: string;
    }): Promise<string>;
  };
  private readonly resolvePublicationFacts?: WorkerDeps['resolvePublicationFacts'];
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly onBeforeCommit?: (job: ClaimedJob, assets: { png: string; gray4: string }) => void;
  private readonly log?: WorkerLogger;

  private running = false;
  private stopping = true;
  private wakeResolve: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;

  constructor(deps: WorkerDeps) {
    this.repository = deps.repository;
    this.assets = deps.assets;
    this.renderFn = deps.render;
    this.resolvePublicationFacts = deps.resolvePublicationFacts;
    this.reviewer = deps.reviewer;
    this.now = deps.now ?? (() => new Date());
    this.leaseDurationMs = deps.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.backoffMs = deps.backoffMs ?? ((attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8_000));
    this.onBeforeCommit = deps.onBeforeCommit;
    this.log = deps.log;
  }

  /** Start the background loop (idempotent). */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.loopDone = this.loop();
  }

  /** Wake an idle worker after a synchronous terminal-v1 submission. */
  notify(): void {
    this.wake();
  }

  /**
   * Stop claiming new work and wait (bounded) for the current attempt to
   * finish. If the bound is exceeded the lease stays behind; the next start
   * recovers it after expiry. Never throws.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    const loops = this.loopDone ?? Promise.resolve();
    await Promise.race([
      loops,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    this.running = false;
    this.stopping = true;
  }

  /**
   * Process at most one claimed operation end-to-end. Returns true when a
   * job was claimed. Simulated process death propagates without any
   * cleanup, mirroring a killed process (the scratch dir stays behind for
   * startup cleanup).
   */
  async runOnce(): Promise<boolean> {
    const now = this.now();
    const leaseId = `lease_${randomBytes(16).toString('hex')}`;
    const job = this.repository.claim({
      nowIso: now.toISOString(),
      leaseId,
      leaseDurationMs: this.leaseDurationMs,
      maxAttempts: MAX_ATTEMPTS,
    });
    if (job === null) {
      return false;
    }
    let died = false;
    try {
      await this.processAttempt(job);
    } catch (error) {
      if (error instanceof SimulatedProcessDeath) {
        died = true;
      }
      throw error;
    } finally {
      if (!died) {
        try {
          this.assets.removeLeaseTmp(job.operation_id, job.lease_id);
        } catch {
          // scratch cleanup is best-effort; startup reclaims leftovers
        }
      }
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let didWork: boolean;
      try {
        didWork = await this.runOnce();
      } catch (error) {
        if (error instanceof SimulatedProcessDeath) {
          // The simulated process is gone: nothing more runs here.
          return;
        }
        this.log?.warn('worker_attempt_error', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
        didWork = false;
      }
      if (this.stopping) {
        return;
      }
      if (!didWork) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeResolve = () => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
    });
  }

  private wake(): void {
    this.wakeResolve?.();
  }

  private async processAttempt(job: ClaimedJob): Promise<void> {
    const tmpDir = this.assets.leaseTmpDir(job.operation_id, job.lease_id);
    let manuscript: Manuscript;
    try {
      manuscript = validateManuscript(JSON.parse(Buffer.from(job.canonical).toString('utf8'))).manuscript;
    } catch {
      // This snapshot already passed acceptance; failure to read it is a
      // publication-service failure, not a request to rewrite the manuscript.
      this.terminate(job, 'render_failed');
      return;
    }

    const catalog = job.production_catalog_snapshot as {
      revision?: unknown;
      enabled_layouts?: unknown;
      request?: { layout_variant?: unknown };
    };
    let selectedLayoutId = typeof catalog.request?.layout_variant === 'string'
      ? catalog.request.layout_variant
      : layoutForGenre(selectedGenre(manuscript)).id;
    let selectionEvidence: { layout_id: string; reason: string; source: 'author' | 'model' | 'deterministic' } = {
      layout_id: selectedLayoutId,
      reason: '按已冻结的版式目录与确定性规则选择。',
      source: typeof catalog.request?.layout_variant === 'string' ? 'author' : 'deterministic',
    };
    if (job.business_contract === 'terminal-v1' && this.reviewer !== undefined &&
        (this.reviewer.isEnabled?.() ?? true) && this.reviewer.select !== undefined &&
        'schemaVersion' in manuscript && manuscript.schemaVersion === 3 && manuscript.layoutVariant === undefined &&
        job.deadline_at !== null) {
      const frozenIds = Array.isArray(catalog.enabled_layouts)
        ? new Set(catalog.enabled_layouts.flatMap((item) =>
            typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
              ? [(item as { id: string }).id]
              : []))
        : new Set(PRODUCTION_LAYOUTS.map((layout) => layout.id));
      let candidates = PRODUCTION_LAYOUTS.filter((layout) => frozenIds.has(layout.id));
      if (manuscript.content !== undefined) {
        const structuredGenre = manuscript.content.kind;
        candidates = candidates.filter((layout) => layout.genre === structuredGenre);
      }
      if (manuscript.genrePreferenceMode === 'strict' && manuscript.genrePreference !== undefined) {
        candidates = candidates.filter((layout) => layout.genre === manuscript.genrePreference);
      }
      if (manuscript.content === undefined) {
        candidates = candidates.filter((layout) => layout.required_fact_fields.length === 0);
      }
      const selection = await this.reviewer.select({
        manuscript,
        catalogRevision: typeof catalog.revision === 'string' ? catalog.revision : 'unknown',
        candidates: [...candidates],
        deadlineAt: job.deadline_at,
      });
      const layout = selection.kind === 'selected'
        ? candidates.find((candidate) => candidate.id === selection.layoutId)
        : undefined;
      if (selection.kind !== 'selected' || layout === undefined) {
        this.completeReview(job, {
          nowIso: this.now().toISOString(),
          status: 'technical_failure',
          snapshot: { schema: 'ephemera-typesetter-pipeline-v1', stage: 'select', decision: 'technical_failure' },
          terminalCode: 'model_unavailable',
          terminalDetail: 'typesetter selection failed',
        });
        return;
      }
      try {
        manuscript = validateManuscript({
          ...(manuscript as ManuscriptV3),
          genrePreference: layout.genre,
          layoutVariant: layout.id,
        }).manuscript;
      } catch {
        this.completeReview(job, {
          nowIso: this.now().toISOString(),
          status: 'technical_failure',
          snapshot: { schema: 'ephemera-typesetter-pipeline-v1', stage: 'select', decision: 'technical_failure' },
          terminalCode: 'model_unavailable',
          terminalDetail: 'typesetter selected an incompatible layout',
        });
        return;
      }
      selectedLayoutId = layout.id;
      selectionEvidence = { layout_id: layout.id, reason: selection.reason, source: 'model' };
    }

    let publicationFacts: { almanac?: AlmanacFacts; weather?: WeatherSnapshot } | undefined;
    if (this.resolvePublicationFacts !== undefined) {
      try {
        publicationFacts = await this.resolvePublicationFacts({
          genre: selectedGenre(manuscript),
          publicationDate: job.reserved_publication_id.slice(0, 10),
        });
      } catch {
        await this.handleTransientFailure(job, 'render_failed');
        return;
      }
    }

    let editorAdditions: EditorAddition[] = [];
    if (job.business_contract === 'terminal-v1' && this.reviewer !== undefined &&
        (this.reviewer.isEnabled?.() ?? true) && this.reviewer.fill !== undefined &&
        'schemaVersion' in manuscript && manuscript.schemaVersion === 3 && manuscript.content !== undefined &&
        job.deadline_at !== null) {
      const allowedSlots = missingEditorSlots(manuscript.content);
      if (allowedSlots.length > 0) {
        const filled = await this.reviewer.fill({
          manuscript,
          layoutId: selectedLayoutId,
          allowedSlots,
          ...(publicationFacts === undefined ? {} : { facts: publicationFacts }),
          deadlineAt: job.deadline_at,
        });
        if (filled.kind !== 'filled') {
          this.completeReview(job, {
            nowIso: this.now().toISOString(),
            status: 'technical_failure',
            snapshot: { schema: 'ephemera-typesetter-pipeline-v1', stage: 'fill', decision: 'technical_failure', selection: selectionEvidence },
            terminalCode: 'model_unavailable',
            terminalDetail: 'typesetter secondary-slot fill failed',
          });
          return;
        }
        try {
          applyEditorAdditions(manuscript.content, filled.additions);
          editorAdditions = filled.additions;
        } catch {
          this.completeReview(job, {
            nowIso: this.now().toISOString(),
            status: 'technical_failure',
            snapshot: { schema: 'ephemera-typesetter-pipeline-v1', stage: 'fill', decision: 'technical_failure', selection: selectionEvidence },
            terminalCode: 'model_unavailable',
            terminalDetail: 'typesetter attempted to write outside missing secondary slots',
          });
          return;
        }
      }
    }

    let outcome: WorkerRenderOutcome;
    try {
      const mapping = selectedGenre(manuscript) === 'postcard' &&
        (!('schemaVersion' in manuscript) || manuscript.schemaVersion !== 3)
        ? mapToRendererManuscript(manuscript)
        : null;
      outcome = await this.renderFn({
        operationId: job.operation_id,
        leaseId: job.lease_id,
        manuscript,
        ...(publicationFacts === undefined ? {} : { publicationFacts }),
        ...(editorAdditions.length === 0 ? {} : { editorAdditions }),
        ...(mapping === null ? {} : { rendererManuscript: mapping.rendererManuscript }),
        date: job.reserved_publication_id.slice(0, 10),
        acceptedAt: job.accepted_at,
        tmpDir,
      });
    } catch (error) {
      if (error instanceof SimulatedProcessDeath) {
        throw error;
      }
      if (error instanceof RenderError) {
        if (error.code === 'unsupported_glyph' && error.message.includes('template text')) {
          this.terminate(job, 'render_failed');
          return;
        }
        const terminal = PERMANENT_TERMINAL_CODES.get(error.code);
        if (terminal !== undefined) {
          this.terminate(job, terminal, error.message);
          return;
        }
        // A deterministic author-content integrity violation also has no
        // point in retrying, but the operation-level code space stays at the
        // seven stable codes — it terminates as render_failed.
        if (error.code === 'author_content_mismatch') {
          this.terminate(job, 'render_failed');
          return;
        }
      }
      await this.handleTransientFailure(job, 'render_failed');
      return;
    }

    let reviewedHashes: string[] | undefined;
    if (job.business_contract === 'terminal-v1' && this.reviewer !== undefined &&
        (this.reviewer.isEnabled?.() ?? true)) {
      let pageInputs: Array<{ index: number; png: Uint8Array }>;
      try {
        const reported = outcome.pages ?? [{ index: 0, pngName: 'page.png' }];
        pageInputs = reported.map((page, index) => {
          if (page.index !== index || !/^[A-Za-z0-9._-]+$/.test(page.pngName)) {
            throw new Error('invalid renderer page inventory');
          }
          return { index, png: readFileSync(join(tmpDir, page.pngName)) };
        });
      } catch {
        await this.handleTransientFailure(job, 'render_failed');
        return;
      }
      let review;
      try {
        review = await this.reviewer.review({
          manuscript: editorAdditions.length === 0 ? manuscript : { author: manuscript, editor: editorAdditions },
          catalogRevision: typeof catalog.revision === 'string' ? catalog.revision : 'unknown',
          layoutId: selectedLayoutId,
          pages: pageInputs,
          deadlineAt: job.deadline_at!,
        });
      } catch {
        const evidence: TypesetterEvidence = {
          schema: TYPESETTER_REVIEW_SCHEMA,
          decision: 'technical_failure',
          reviewed_page_indexes: [],
          page_sha256: [],
          issues: [],
          usage: { input_tokens: null, output_tokens: null },
          technical_code: 'disconnected',
          elapsed_ms: 0,
        };
        this.completeReview(job, {
          nowIso: this.now().toISOString(),
          status: 'technical_failure',
          snapshot: evidence,
          terminalCode: 'model_unavailable',
          terminalDetail: 'typesetter review transport failed',
        });
        return;
      }
      if (review.kind !== 'approved') {
        const returned = review.kind === 'rejected' && this.reviewer.returnFeedback !== undefined && job.deadline_at !== null
          ? await this.reviewer.returnFeedback({
              layoutId: selectedLayoutId,
              issues: review.evidence.issues,
              deadlineAt: job.deadline_at,
            })
          : undefined;
        this.completeReview(job, {
          nowIso: this.now().toISOString(),
          status: review.kind === 'rejected' ? 'rejected' : 'technical_failure',
          snapshot: { ...review.evidence, selection: selectionEvidence, editor_additions: editorAdditions, ...(returned === undefined ? {} : { return_message: returned }) },
          terminalCode: review.kind === 'rejected' ? 'model_rejected' : 'model_unavailable',
          terminalDetail: review.kind === 'rejected'
            ? returned ?? '排版审核未通过，请调整内容后重新投稿。'
            : `排版工审核最终页失败：${review.evidence.technical_code === 'timeout' ? '超时' : review.evidence.technical_code ?? 'unknown'}（耗时 ${review.evidence.elapsed_ms} 毫秒）`,
        });
        return;
      }
      if (!this.completeReview(job, {
        nowIso: this.now().toISOString(),
        status: 'approved',
        snapshot: { ...review.evidence, selection: selectionEvidence, editor_additions: editorAdditions },
      })) {
        return;
      }
      reviewedHashes = review.evidence.page_sha256;
    }

    let facts: ArtifactFacts;
    const beforeAssets = this.now().toISOString();
    if (job.business_contract === 'terminal-v1' && job.deadline_at !== null && beforeAssets >= job.deadline_at) {
      this.repository.expireOperation(job.operation_id, beforeAssets);
      return;
    }
    try {
      facts = this.verifyAndCommitAssets(tmpDir, outcome);
    } catch (error) {
      if (error instanceof SimulatedProcessDeath) {
        throw error;
      }
      await this.handleTransientFailure(job, 'storage_unavailable');
      return;
    }
    if (reviewedHashes !== undefined &&
        (reviewedHashes.length !== facts.pages.length || reviewedHashes.some((hash, index) => hash !== facts.pages[index]!.png.sha256))) {
      await this.handleTransientFailure(job, 'storage_unavailable');
      return;
    }

    if (this.onBeforeCommit !== undefined) {
      // Test seam: a throw here simulates dying with assets already durable.
      this.onBeforeCommit(job, { png: facts.png.relativePath, gray4: facts.gray4.relativePath });
    }

    try {
      this.commit(job, manuscript, outcome, facts);
    } catch (error) {
      if (error instanceof SimulatedProcessDeath) {
        throw error;
      }
      await this.handleTransientFailure(job, 'storage_unavailable');
    }
  }

  /** Re-verify the written artifacts, then move them into the asset store. */
  private verifyAndCommitAssets(tmpDir: string, outcome: WorkerRenderOutcome): ArtifactFacts {
    const read = (name: string): Buffer => readFileSync(join(tmpDir, name));
    const manifest = JSON.parse(read('render-manifest.json').toString('utf8')) as {
      assets?: Record<string, { sha256?: string; bytes?: number }>;
      pages?: Array<{ page_index?: number; assets?: Record<string, { sha256?: string; bytes?: number }> }>;
      width?: number;
      height?: number;
    };
    const validGeometry = (manifest.width === PAGE_WIDTH && manifest.height === PAGE_HEIGHT) ||
      (manifest.width === LANDSCAPE_PAGE_WIDTH && manifest.height === LANDSCAPE_PAGE_HEIGHT);
    if (!validGeometry) {
      throw new BusinessError('storage_unavailable', 'rendered page geometry does not match the locked target', true);
    }
    const reported = outcome.pages ?? [{
      index: 0,
      pngName: 'page.png',
      gray4Name: 'page.gray4',
      png: outcome.png,
      gray4: outcome.gray4,
      gray4Facts: outcome.gray4Facts,
    }];
    if (reported.length < 1 || reported.length > 16) {
      throw new BusinessError('storage_unavailable', 'renderer reported an invalid page count', true);
    }
    const indexes = reported.map((page) => page.index);
    if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value !== index)) {
      throw new BusinessError('storage_unavailable', 'renderer reported invalid page indexes', true);
    }
    const pages: ArtifactPageFacts[] = [];
    for (const page of reported) {
      if (!/^[A-Za-z0-9._-]+$/.test(page.pngName) || !/^[A-Za-z0-9._-]+$/.test(page.gray4Name)) {
        throw new BusinessError('storage_unavailable', 'renderer reported an invalid asset name', true);
      }
      const png = read(page.pngName);
      const gray4 = read(page.gray4Name);
      const pngSha = sha256Hex(png);
      const gray4Sha = sha256Hex(gray4);
      if (pngSha !== page.png.sha256 || png.length !== page.png.bytes) {
        throw new BusinessError('storage_unavailable', 'rendered PNG does not match the renderer report', true);
      }
      if (gray4Sha !== page.gray4.sha256 || gray4.length !== page.gray4.bytes) {
        throw new BusinessError('storage_unavailable', 'rendered gray4 does not match the renderer report', true);
      }
      const pageManifest = manifest.pages?.find((item) => item.page_index === page.index)?.assets ?? manifest.assets;
      const manifestPng = pageManifest?.[page.pngName];
      const manifestGray4 = pageManifest?.[page.gray4Name];
      if (manifestPng?.sha256 !== pngSha || manifestPng?.bytes !== png.length) {
        throw new BusinessError('storage_unavailable', 'render manifest disagrees about the PNG', true);
      }
      if (manifestGray4?.sha256 !== gray4Sha || manifestGray4?.bytes !== gray4.length) {
        throw new BusinessError('storage_unavailable', 'render manifest disagrees about the gray4 frame', true);
      }
      const header = readPngHeader(png);
      if (header.width !== manifest.width || header.height !== manifest.height ||
          (page.width !== undefined && page.width !== manifest.width) ||
          (page.height !== undefined && page.height !== manifest.height)) {
        throw new BusinessError('storage_unavailable', 'rendered page geometry does not match the locked target', true);
      }
      if (gray4.length !== GRAY4_BYTE_LENGTH || page.gray4Facts.byteLength !== GRAY4_BYTE_LENGTH) {
        throw new BusinessError('storage_unavailable', 'gray4 frame length does not match the locked target', true);
      }
      const committedPng = this.assets.commitTmpFile(join(tmpDir, page.pngName), 'png', pngSha, png.length);
      const committedGray4 = this.assets.commitTmpFile(join(tmpDir, page.gray4Name), 'gray4', gray4Sha, gray4.length);
      pages.push({
        index: page.index, width: manifest.width, height: manifest.height,
        ...(page.partRole === undefined ? {} : { partRole: page.partRole }),
        png: { sha256: committedPng.sha256, bytes: committedPng.byteLength, relativePath: committedPng.relativePath },
        gray4: { sha256: committedGray4.sha256, bytes: committedGray4.byteLength, relativePath: committedGray4.relativePath },
      });
    }
    return { pages, png: pages[0]!.png, gray4: pages[0]!.gray4 };
  }

  /** Build the immutable publication snapshot and commit it atomically. */
  private commit(job: ClaimedJob, manuscript: Manuscript, outcome: WorkerRenderOutcome, facts: ArtifactFacts): void {
    const genre = selectedGenre(manuscript);
    const mapping = genre === 'postcard' && (!('schemaVersion' in manuscript) || manuscript.schemaVersion !== 3)
      ? mapToRendererManuscript(manuscript)
      : null;
    // Pre-commit content integrity (task card): the paper body must equal
    // the author body verbatim and the provenance must cover every Unicode
    // code point of the body exactly once, in order, without rewriting.
    if (mapping !== null && mapping.rendererManuscript.body !== manuscript.body) {
      throw new BusinessError('storage_unavailable', 'paper body does not equal the author body', true);
    }
    if (mapping !== null && mapping.effectiveTitle !== undefined && mapping.effectiveTitle.length > 0) {
      throw new BusinessError('storage_unavailable', 'paper still carries an unsupported title slot', true);
    }
    if (mapping !== null && mapping.effectiveSubtitle !== undefined && mapping.effectiveSubtitle.length > 0) {
      throw new BusinessError('storage_unavailable', 'paper still carries an unsupported subtitle slot', true);
    }
    const bodyScalars = countScalars(manuscript.body);
    let paper: unknown;
    let editorialSpec: unknown;
    let provenance: unknown;
    let renderedParts: Array<{ role: 'main' | 'continuation'; genre: string; paper: unknown; editorialSpec: unknown; provenance: unknown }>;
    if (genre === 'postcard' && mapping !== null) {
      provenance = {
        version: 1,
        body: { field: 'body', start: 0, end: bodyScalars, source: 'author' },
        titles: mapping.titleProvenance,
      };
      paper = { ...mapping.rendererManuscript, tone: outcome.tone };
      editorialSpec = {
        version: 1,
        genre: 'postcard',
        pagination: 'forbidden',
        slots: ['body'],
        title_slot: false,
        subtitle_slot: false,
        page: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      };
      renderedParts = [{ role: 'main', genre, paper, editorialSpec, provenance }];
    } else if (genre === 'note') {
      const note = manuscript as ManuscriptV2;
      const paperRecord = outcome.paper as Record<string, unknown> | undefined;
      const provenanceRecord = outcome.provenance as Record<string, unknown> | undefined;
      const effective = effectiveTitle(note).value;
      if (outcome.genre !== 'note' || paperRecord?.body !== note.body || paperRecord?.title !== effective ||
          paperRecord?.signature !== note.signature || outcome.editorialSpec === undefined || provenanceRecord === undefined) {
        throw new BusinessError('storage_unavailable', 'note snapshot does not match the author manuscript', true);
      }
      const coverage = provenanceRecord.body as { start?: unknown; end?: unknown } | undefined;
      if (coverage?.start !== 0 || coverage.end !== bodyScalars) {
        throw new BusinessError('storage_unavailable', 'note provenance does not cover the author body', true);
      }
      const paragraphRows = paperRecord.paragraphs;
      if (!Array.isArray(paragraphRows) || paragraphRows.map((item) => {
        const row = item as { text?: unknown; separatorAfter?: { text?: unknown } | null };
        return (typeof row.text === 'string' ? row.text : '') +
          (row.separatorAfter !== null && typeof row.separatorAfter?.text === 'string' ? row.separatorAfter.text : '');
      }).join('') !== note.body) {
        throw new BusinessError('storage_unavailable', 'note paragraph snapshot cannot reconstruct the author body', true);
      }
      paper = outcome.paper;
      editorialSpec = outcome.editorialSpec;
      provenance = outcome.provenance;
      renderedParts = [{ role: 'main', genre, paper, editorialSpec, provenance }];
    } else {
      const provenanceRecord = outcome.provenance as { body?: { start?: unknown; end?: unknown } } | undefined;
      if (outcome.genre !== genre || outcome.paper === undefined || outcome.editorialSpec === undefined ||
          provenanceRecord?.body?.start !== 0 || provenanceRecord.body.end !== bodyScalars ||
          outcome.parts === undefined || outcome.parts.length < 1 || outcome.parts[0]?.role !== 'main') {
        throw new BusinessError('storage_unavailable', 'genre snapshot does not cover the author manuscript', true);
      }
      paper = outcome.paper;
      editorialSpec = outcome.editorialSpec;
      provenance = outcome.provenance;
      renderedParts = outcome.parts.map((part, index) => ({
        role: index === 0 ? 'main' : 'continuation',
        genre: part.genre,
        paper: part.paper,
        editorialSpec: part.editorialSpec,
        provenance: part.provenance,
      }));
    }
    const partInputs = renderedParts.map((part) => ({ id: `pt_${randomBytes(12).toString('hex')}`, ...part }));
    const result = this.repository.commitPublication({
      operationId: job.operation_id,
      leaseId: job.lease_id,
      nowIso: this.now().toISOString(),
      deliveryIntent: resolveDeliveryIntent(manuscript),
      authorTitleAdaptation: manuscript.titleAdaptation ?? null,
      deliverAfter: manuscript.delivery?.deliverAfter ?? null,
      expiresAt: manuscript.delivery?.expiresAt ?? null,
      parts: partInputs,
      edition: {
        id: `ed_${randomBytes(12).toString('hex')}`,
        seq: 1,
        profile: outcome.profile ?? 'epaper-540x960-gray4-v1',
        rendererBuild: outcome.rendererBuild ?? RENDERER_BUILD,
        rendererVersion: SERVICE_VERSION,
        chromiumVersion: outcome.chromium.version,
        playwrightVersion: outcome.chromium.playwright,
        fontsManifestVersion: outcome.fonts.manifestVersion,
        fontsFileCount: outcome.fonts.count,
        layoutSnapshot: editorialSpec,
      },
      pages: facts.pages.map((page) => ({
        id: `pg_${randomBytes(12).toString('hex')}`,
        index: page.index,
        width: page.width,
        height: page.height,
        partIndex: page.partRole === 'supplement' ? 1 : 0,
        assets: [
          { sha256: page.png.sha256, kind: 'png' as const, mediaType: 'image/png', byteLength: page.png.bytes, relativePath: page.png.relativePath, role: 'primary' as const },
          { sha256: page.gray4.sha256, kind: 'gray4' as const, mediaType: 'application/octet-stream', byteLength: page.gray4.bytes, relativePath: page.gray4.relativePath, role: 'gray4' as const },
        ],
      })),
    });
    if (result === null) {
      this.log?.warn('operation_failed', { operation_id: job.operation_id, code: 'deadline_exceeded' });
      return;
    }
    this.log?.info('publication_committed', {
      operation_id: job.operation_id,
      publication_id: result.publication_id,
      commit_seq: result.commit_seq,
      created: result.created,
    });
    try {
      const archived = this.assets.archivePublication({
        publicationId: result.publication_id,
        manuscript,
        body: manuscript.body,
        pages: facts.pages.map((page) => ({
          index: page.index,
          ...(page.partRole === undefined ? {} : { partRole: page.partRole }),
          png: {
            sha256: page.png.sha256,
            kind: 'png' as const,
            mediaType: 'image/png',
            byteLength: page.png.bytes,
            relativePath: page.png.relativePath,
          },
        })),
      });
      this.log?.info('publication_archived', { publication_id: result.publication_id, path: archived });
    } catch {
      // The canonical publication is already committed and remains usable;
      // expose the missing convenience archive as an operational warning.
      this.log?.warn('publication_archive_failed', { publication_id: result.publication_id });
    }
  }

  private async handleTransientFailure(job: ClaimedJob, finalCode: 'render_failed' | 'storage_unavailable'): Promise<void> {
    this.log?.warn('worker_attempt_failed', {
      operation_id: job.operation_id,
      attempt: job.attempt_count,
      final_code_if_exhausted: finalCode,
    });
    const nowIso = this.now().toISOString();
    try {
      if (job.attempt_count >= MAX_ATTEMPTS) {
        this.repository.failOperation(job.operation_id, job.lease_id, finalCode, nowIso);
        return;
      }
      this.repository.releaseForRetry(job.operation_id, job.lease_id, nowIso);
    } catch (error) {
      // The attempt bookkeeping itself failed: leave the lease to expire;
      // the next claim recovers or terminates per the attempt count.
      this.log?.warn('worker_bookkeeping_failed', {
        operation_id: job.operation_id,
        kind: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    // Bounded backoff before the same operation can be claimed again.
    const backoff = this.backoffMs(job.attempt_count);
    if (backoff > 0) {
      await this.sleep(backoff);
    }
  }

  private completeReview(
    job: ClaimedJob,
    input: Omit<ReviewCompletionInput, 'operationId' | 'leaseId'>,
  ): boolean {
    try {
      this.repository.completeReview({ ...input, operationId: job.operation_id, leaseId: job.lease_id });
      return true;
    } catch (error) {
      // A deadline/other terminal transaction may have won while the model
      // response was in flight. Never revive or overwrite that outcome.
      try {
        const facts = this.repository.executionFacts(job.operation_id);
        if (facts?.status === 'failed' || facts?.status === 'published' || facts?.status === 'unknown_after_restore') {
          return false;
        }
      } catch {
        // Fall through to the bounded lease-recovery path.
      }
      this.log?.warn('worker_bookkeeping_failed', {
        operation_id: job.operation_id,
        kind: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  private terminate(job: ClaimedJob, code: OperationFailureCode, detail?: string): void {
    try {
      this.repository.failOperation(job.operation_id, job.lease_id, code, this.now().toISOString(), detail);
      this.log?.warn('operation_failed', { operation_id: job.operation_id, code });
    } catch (error) {
      this.log?.warn('worker_bookkeeping_failed', {
        operation_id: job.operation_id,
        kind: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
