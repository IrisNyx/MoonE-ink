import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { openDataStore, type DataStore } from '../../src/storage.js';
import { AcceptanceService, type AcceptanceRepository } from '../../src/domain/acceptance.js';
import { QueryService, type QueryRepository } from '../../src/domain/query.js';
import type { PublicationRepository } from '../../src/domain/publication.js';
import { AssetStore } from '../../src/jobs/assets.js';
import { PublicationWorker, type RenderJobInput, type WorkerDeps, type WorkerRenderOutcome } from '../../src/jobs/worker.js';
import { rgbaToGray4 } from '../../src/render/gray4.js';
import { GRAY4_BYTE_LENGTH, PAGE_HEIGHT, PAGE_WIDTH } from '../../src/version.js';
import { freshDir } from './env.js';

/**
 * Worker-level fixtures for the publication suite (P06–P08) and the query
 * suite (Q01–Q03). Everything runs against a real SQLite database and the
 * real filesystem inside the verifier scratch (EPHEMERA_TEST_TMP). The
 * renderer, clock and backoff are code dependencies of the fixture — they
 * never enter JSON configuration or the environment.
 */

export interface PublicationFixtureDeps {
  /** Epoch-milliseconds clock shared by acceptance, the worker and queries. */
  clock?: () => number;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  render?: WorkerDeps['render'];
  onBeforeCommit?: WorkerDeps['onBeforeCommit'];
  /** Query-service injections (cursor TTL in clock milliseconds). */
  cursorTtlMs?: number;
  channelForCaller?: (callerId: string) => string | null;
  terminalPublishBudgetMs?: number;
}

export interface PublicationFixture {
  dir: string;
  instanceId: string;
  readonly service: AcceptanceService;
  readonly publication: PublicationRepository;
  readonly query: QueryService;
  readonly assets: AssetStore;
  /** Read-only view of the current store (identity facts only by convention). */
  storeView(): DataStore;
  /** Build a worker over the SAME store (each attempt gets a fresh object). */
  makeWorker(overrides?: Partial<WorkerDeps>): PublicationWorker;
  counts(): { ledger: number; operation: number; snapshot: number; pending: number };
  counters(): { nextAcceptanceSeq: number; publicationCounters: Record<string, number> };
  publicationCounts(): ReturnType<PublicationRepository['publicationCounts']>;
  executionFacts(operationId: string): ReturnType<PublicationRepository['executionFacts']>;
  status(callerId: string, query: { operationId?: string; requestId?: string }): ReturnType<PublicationRepository['statusForCaller']>;
  raw(): RawReader;
  /** Close the store and open it again (simulates a process restart). */
  restart(): void;
  close(): void;
}

export class RawReader {
  constructor(readonly db: DatabaseSync) {}

  one<T extends object>(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends object>(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  userVersion(): number {
    return (this.one<{ user_version: number }>('PRAGMA user_version') as { user_version: number }).user_version;
  }

  close(): void {
    this.db.close();
  }
}

export function openPublicationFixture(deps: PublicationFixtureDeps = {}, dir?: string): PublicationFixture {
  const dataDir = dir ?? freshDir('pub');
  const clock = deps.clock ?? (() => Date.now());
  const timezone = 'UTC';
  let idCounter = 0;
  const idSource = () => `${(idCounter += 1).toString(16)}`.padStart(32, '0');

  let store!: DataStore;
  let acceptanceRepository!: AcceptanceRepository;
  let publicationRepository!: PublicationRepository;
  let queryRepository!: QueryRepository;
  let service!: AcceptanceService;
  let query!: QueryService;
  let raw: RawReader | undefined;
  const assets = new AssetStore(dataDir);

  const open = (): void => {
    store = openDataStore(dataDir);
    acceptanceRepository = store.createAcceptanceRepository();
    publicationRepository = store.createPublicationRepository();
    queryRepository = store.createQueryRepository();
    service = new AcceptanceService({
      repository: acceptanceRepository,
      instanceId: store.instanceId,
      timezone,
      maxPendingOperations: 100,
      ...(deps.terminalPublishBudgetMs === undefined ? {} : { terminalPublishBudgetMs: deps.terminalPublishBudgetMs }),
      clock,
      idSource,
      channelForCaller: deps.channelForCaller,
    });
    query = new QueryService({
      repository: queryRepository,
      instanceId: store.instanceId,
      clock,
      ...(deps.cursorTtlMs === undefined ? {} : { cursorTtlMs: deps.cursorTtlMs }),
    });
  };
  open();
  const instanceId = store.instanceId;

  return {
    dir: dataDir,
    instanceId,
    get service(): AcceptanceService {
      return service;
    },
    get publication(): PublicationRepository {
      return publicationRepository;
    },
    get query(): QueryService {
      return query;
    },
    assets,
    storeView: () => store,
    makeWorker(overrides: Partial<WorkerDeps> = {}): PublicationWorker {
      return new PublicationWorker({
        repository: publicationRepository,
        assets,
        render: overrides.render ?? deps.render ?? syntheticRenderer(),
        ...(overrides.reviewer === undefined ? {} : { reviewer: overrides.reviewer }),
        now: () => new Date(clock()),
        leaseDurationMs: deps.leaseDurationMs,
        pollIntervalMs: deps.pollIntervalMs ?? 10,
        backoffMs: deps.backoffMs ?? (() => 0),
        onBeforeCommit: overrides.onBeforeCommit ?? deps.onBeforeCommit,
      });
    },
    counts: () => acceptanceRepository.factCounts(),
    counters: () => acceptanceRepository.counterState(),
    publicationCounts: () => publicationRepository.publicationCounts(),
    executionFacts: (operationId) => publicationRepository.executionFacts(operationId),
    status: (callerId, query) => publicationRepository.statusForCaller(callerId, query),
    raw(): RawReader {
      raw ??= new RawReader(new DatabaseSync(join(dataDir, 'ephemera.sqlite')));
      return raw;
    },
    restart(): void {
      raw?.close();
      raw = undefined;
      store.close();
      open();
    },
    close(): void {
      raw?.close();
      raw = undefined;
      store.close();
    },
  };
}

/**
 * Fast deterministic test renderer: builds a REAL 540x960 PNG via pngjs and
 * the real gray4 conversion, and writes the full artifact layout (page.png,
 * page.gray4, render-manifest.json) into the lease scratch directory. Body
 * length changes the ink block, so different manuscripts yield different
 * pixels; identical manuscripts are byte-identical (deterministic reuse).
 */
export function syntheticRenderer(
  behavior: {
    fail?: (job: RenderJobInput, call: number) => Error | undefined;
    beforeDeath?: (job: RenderJobInput, call: number) => void;
  } = {},
): (job: RenderJobInput) => Promise<WorkerRenderOutcome> {
  let call = 0;
  return async (job: RenderJobInput): Promise<WorkerRenderOutcome> => {
    call += 1;
    const failure = behavior.fail?.(job, call);
    if (behavior.beforeDeath !== undefined) {
      behavior.beforeDeath(job, call);
    }
    const png = new PNG({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    const ink = Buffer.byteLength(job.manuscript.body, 'utf8');
    for (let y = 40; y < 80; y += 1) {
      for (let x = 10 + (ink % 200); x < 60 + (ink % 200); x += 1) {
        const idx = (PAGE_WIDTH * y + x) * 4;
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }
    const pngBuffer = PNG.sync.write(png);
    const gray4 = rgbaToGray4(png.data, PAGE_WIDTH, PAGE_HEIGHT);
    mkdirSync(job.tmpDir, { recursive: true });
    if (failure !== undefined) {
      // A failing renderer may have produced partial output first.
      writeFileSync(join(job.tmpDir, 'page.png'), pngBuffer);
      throw failure;
    }
    writeFileSync(join(job.tmpDir, 'page.png'), pngBuffer);
    writeFileSync(join(job.tmpDir, 'page.gray4'), gray4.frame);
    const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
    const manifest = {
      manifest_version: 1,
      profile: 'epaper-540x960-gray4-v1',
      format: 'gray4',
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      stride_bytes: 270,
      byte_length: GRAY4_BYTE_LENGTH,
      assets: {
        'page.png': { sha256: sha(pngBuffer), bytes: pngBuffer.length },
        'page.gray4': { sha256: sha(gray4.frame), bytes: gray4.byteLength },
      },
      renderer: { build: 'postcard-renderer/1', schema_version: 1, genre: 'postcard' },
      toolchain: { chromium: { version: '151.0.7922.34-test' } },
    };
    writeFileSync(join(job.tmpDir, 'render-manifest.json'), JSON.stringify(manifest, null, 1));
    return {
      png: manifest.assets['page.png']!,
      gray4: manifest.assets['page.gray4']!,
      tone: { value: 'cream', source: 'template-default' },
      chromium: { version: '151.0.7922.34-test', revision: '1234', playwright: '1.62.0' },
      fonts: { manifestVersion: 1, count: 111, served: 0 },
      gray4Facts: { byteLength: gray4.byteLength, inkPixels: gray4.inkPixels, distinctLevels: gray4.distinctLevels },
    };
  };
}
