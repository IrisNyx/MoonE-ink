import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { test } from 'node:test';
import { BusinessError } from '../src/errors.js';
import { publish, requestStatus, type ToolContext } from '../src/tools.js';
import { realRenderJob } from '../src/jobs/renderer.js';
import { BoundedTypesetterReviewer, TYPESETTER_CAPABILITY_SCHEMA, TYPESETTER_REVIEW_SCHEMA } from '../src/typesetter/reviewer.js';
import { openPublicationFixture, syntheticRenderer } from './helpers/publication.js';
import { connectModernClient } from './helpers/client.js';
import { startService } from './helpers/proc.js';

function context(
  fixture: ReturnType<typeof openPublicationFixture>,
  wakePublisher: () => void,
  now: () => number = Date.now,
): ToolContext {
  return {
    store: fixture.storeView(),
    acceptance: fixture.service,
    publication: fixture.publication,
    query: fixture.query,
    publishAvailable: true,
    wakePublisher,
    terminalPollMs: 2,
    now,
  };
}

test('C2 terminal-v1: one call returns the committed publication and replay spends no new work', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const worker = fixture.makeWorker();
  let workerPromise: Promise<boolean> | undefined;
  let wakeCount = 0;
  const ctx = context(fixture, () => {
    wakeCount += 1;
    workerPromise ??= worker.runOnce();
  });
  const args = {
    expected_instance_id: fixture.instanceId,
    request_id: 'terminal-success-1',
    contract_version: 'terminal-v1' as const,
    manuscript: { intent: 'note', body: '一次调用完成出版。' },
  };
  try {
    const result = await publish(ctx, 'caller_terminal', args);
    await workerPromise;
    strictEqual(result.outcome, 'published', JSON.stringify(result));
    strictEqual(result.publication?.publication_id, result.reserved_publication_id);
    strictEqual(result.publication?.pages.length, 1);
    strictEqual(result.failure, undefined);
    strictEqual(fixture.publicationCounts().publication, 1);

    workerPromise = undefined;
    const replay = await publish(ctx, 'caller_terminal', args);
    await workerPromise;
    strictEqual(replay.outcome, 'published');
    strictEqual(replay.replayed, true);
    strictEqual(replay.operation_id, result.operation_id);
    strictEqual(fixture.publicationCounts().publication, 1);
    ok(wakeCount >= 2, 'both the original call and replay may wake the idle worker safely');

    await rejects(
      publish(ctx, 'caller_terminal', { ...args, contract_version: 'accepted-v2' }),
      (error: unknown) => error instanceof BusinessError && error.code === 'idempotency_conflict',
    );
  } finally {
    fixture.close();
  }
});

test('C2 terminal-v1: enabled typesetter selects a frozen candidate before rendering and records the choice', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 30_000 });
  const reviewer = Object.assign(new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review(request) {
      return {
        schema: TYPESETTER_REVIEW_SCHEMA,
        decision: 'approve',
        reviewed_page_indexes: request.pages.map((page) => page.index),
        issues: [],
        usage: null,
      };
    },
  }), {
    isEnabled: () => true,
    async select(input: { candidates: Array<{ id: string }> }) {
      ok(input.candidates.some((layout) => layout.id === 'note-portrait-v4'));
      ok(!input.candidates.some((layout) => layout.id === 'note-portrait-v3'));
      return { kind: 'selected' as const, layoutId: 'note-portrait-v4', reason: '短篇内容适合当前便签版式。' };
    },
  });
  const worker = fixture.makeWorker({ reviewer, render: realRenderJob });
  let workerPromise: Promise<boolean> | undefined;
  const ctx = context(fixture, () => { workerPromise ??= worker.runOnce(); });
  try {
    const result = await publish(ctx, 'caller_terminal', {
      expected_instance_id: fixture.instanceId,
      request_id: 'terminal-model-select-1',
      contract_version: 'terminal-v1',
      manuscript: { schemaVersion: 3, intent: 'note', body: '请替这张短纸选择合适的现有版式。' },
    });
    await workerPromise;
    if ('phase' in result) throw new Error('valid manuscript cannot fail before acceptance');
    strictEqual(result.outcome, 'published', JSON.stringify(result));
    const stored = fixture.raw().one<{ review_snapshot: string }>(
      'SELECT review_snapshot FROM operation WHERE operation_id = ?', result.operation_id,
    );
    const snapshot = JSON.parse(stored!.review_snapshot) as { selection: { layout_id: string; source: string } };
    strictEqual(snapshot.selection.layout_id, 'note-portrait-v4');
    strictEqual(snapshot.selection.source, 'model');
  } finally {
    fixture.close();
  }
});

test('C2 terminal-v1: editor fills only an omitted secondary slot and Console provenance keeps it separate', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 30_000 });
  const reviewer = Object.assign(new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review(request) {
      return {
        schema: TYPESETTER_REVIEW_SCHEMA,
        decision: 'approve',
        reviewed_page_indexes: request.pages.map((page) => page.index),
        issues: [],
        usage: null,
      };
    },
  }), {
    isEnabled: () => true,
    async select() {
      return { kind: 'selected' as const, layoutId: 'postcard-portrait', reason: '作者提交的是明信片结构。' };
    },
    async fill(input: { allowedSlots: readonly { path: string }[] }) {
      ok(input.allowedSlots.some((slot) => slot.path === 'closing'));
      return { kind: 'filled' as const, additions: [{ path: 'closing', value: '排版工补入的收尾。' }] };
    },
  });
  const worker = fixture.makeWorker({ reviewer, render: realRenderJob });
  let workerPromise: Promise<boolean> | undefined;
  const ctx = context(fixture, () => { workerPromise ??= worker.runOnce(); });
  try {
    const result = await publish(ctx, 'caller_editor_provenance', {
      expected_instance_id: fixture.instanceId,
      request_id: 'terminal-editor-fill-1',
      contract_version: 'terminal-v1',
      manuscript: {
        schemaVersion: 3,
        intent: 'share',
        content: { kind: 'postcard', message: '作者只写了这一段主文。', sentFrom: null },
      },
    });
    await workerPromise;
    strictEqual(result.outcome, 'published', JSON.stringify(result));
    const detail = fixture.publication.adminPublicationText?.(result.reserved_publication_id, 'caller_editor_provenance');
    deepStrictEqual(detail?.editor_additions, [{ path: 'closing', value: '排版工补入的收尾。' }]);
    const work = fixture.query.authorPeek('caller_editor_provenance', { scope: 'recent' }).items[0]!;
    strictEqual(work.body.includes('排版工补入的收尾。'), false, 'author readback remains the author original only');
  } finally {
    fixture.close();
  }
});

test('C2 terminal-v1: elapsed deadline wins over a late renderer and remains final on replay', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 40 });
  const baseRender = syntheticRenderer();
  const worker = fixture.makeWorker({
    render: async (job) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      return baseRender(job);
    },
  });
  let workerPromise: Promise<boolean> | undefined;
  const ctx = context(fixture, () => {
    workerPromise ??= worker.runOnce();
  });
  const args = {
    expected_instance_id: fixture.instanceId,
    request_id: 'terminal-deadline-1',
    contract_version: 'terminal-v1' as const,
    manuscript: { intent: 'note', body: '迟到结果不得出版。' },
  };
  try {
    const result = await publish(ctx, 'caller_terminal', args);
    strictEqual(result.outcome, 'rejected');
    strictEqual(result.failure?.category, 'deadline');
    strictEqual(result.failure?.code, 'deadline_exceeded');
    await workerPromise;
    strictEqual(fixture.publicationCounts().publication, 0);
    if ('phase' in result) throw new Error('valid manuscript cannot fail before acceptance');
    strictEqual(fixture.status('caller_terminal', { operationId: result.operation_id })?.status, 'failed');

    workerPromise = undefined;
    const replay = await publish(ctx, 'caller_terminal', args);
    await workerPromise;
    strictEqual(replay.outcome, 'rejected');
    strictEqual(replay.failure?.code, 'deadline_exceeded');
    strictEqual(replay.replayed, true);
    strictEqual(fixture.publicationCounts().publication, 0);
  } finally {
    fixture.close();
  }
});

test('C2 terminal-v1: a typesetter veto is a durable rejection and never commits pixels', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const reviewer = new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review() {
      return {
        schema: TYPESETTER_REVIEW_SCHEMA,
        decision: 'reject',
        reviewed_page_indexes: [0],
        issues: [{ code: 'collision', page_index: 0, message: '正文与落款发生重叠，部分字无法阅读。' }],
        usage: null,
      };
    },
  });
  const worker = fixture.makeWorker({ reviewer });
  let workerPromise: Promise<boolean> | undefined;
  const ctx = context(fixture, () => {
    workerPromise ??= worker.runOnce();
  });
  try {
    const result = await publish(ctx, 'caller_terminal', {
      expected_instance_id: fixture.instanceId,
      request_id: 'terminal-veto-1',
      contract_version: 'terminal-v1',
      manuscript: { intent: 'note', body: '模型否决不能被建议模式放行。' },
    });
    await workerPromise;
    strictEqual(result.outcome, 'rejected');
    strictEqual(result.failure?.category, 'manuscript');
    strictEqual(result.failure?.code, 'model_rejected');
    strictEqual(fixture.publicationCounts().publication, 0);
    if ('phase' in result) throw new Error('valid manuscript cannot fail before acceptance');
    const stored = fixture.raw().one<{ review_status: string; terminal_code: string; review_snapshot: string }>(
      'SELECT review_status, terminal_code, review_snapshot FROM operation WHERE operation_id = ?',
      result.operation_id,
    );
    strictEqual(stored?.review_status, 'rejected');
    strictEqual(stored?.terminal_code, 'model_rejected');
    strictEqual((JSON.parse(stored!.review_snapshot) as { decision: string }).decision, 'reject');
  } finally {
    fixture.close();
  }
});

test('terminal-v1 reports a typesetter timeout as a technical failure, not a manuscript rejection', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const reviewer = new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review() {
      return new Promise<never>(() => {});
    },
  }, { maxDurationMs: 20 });
  const worker = fixture.makeWorker({ reviewer });
  let workerPromise: Promise<boolean> | undefined;
  const ctx = context(fixture, () => {
    workerPromise ??= worker.runOnce();
  });
  try {
    const result = await publish(ctx, 'caller_terminal', {
      expected_instance_id: fixture.instanceId,
      request_id: 'terminal-typesetter-timeout-1',
      contract_version: 'terminal-v1',
      manuscript: { intent: 'note', body: '排版工超时不代表作者稿件有问题。' },
    });
    await workerPromise;
    strictEqual(result.outcome, 'rejected');
    strictEqual(result.failure?.category, 'technical');
    strictEqual(result.failure?.code, 'model_unavailable');
    strictEqual(result.failure?.message, '排版审核等待回复超时，本次没有发布。请稍后重新投稿。');
    strictEqual(fixture.publicationCounts().publication, 0);
  } finally {
    fixture.close();
  }
});

test('C3 terminal-v1: invalid manuscript rejection is durable, replayable and spends no publication facts', async () => {
  const fixture = openPublicationFixture();
  let wakeCount = 0;
  const makeContext = (): ToolContext => context(fixture, () => {
    wakeCount += 1;
  });
  const args = {
    expected_instance_id: fixture.instanceId,
    request_id: 'terminal-preaccept-1',
    contract_version: 'terminal-v1' as const,
    manuscript: { intent: 'note', body: 'DO_NOT_STORE_THIS_MARKER', unexpected: true },
  };
  try {
    const countersBefore = fixture.counters();
    const first = await publish(makeContext(), 'caller_terminal', args);
    ok('phase' in first, 'invalid terminal manuscript returns the pre-acceptance result shape');
    if (!('phase' in first)) throw new Error('expected pre-acceptance rejection');
    strictEqual(first.accepted, false);
    strictEqual(first.outcome, 'rejected');
    strictEqual(first.phase, 'pre-acceptance');
    strictEqual(first.failure.category, 'manuscript');
    strictEqual(first.failure.code, 'invalid_input');
    strictEqual(first.replayed, false);
    strictEqual(wakeCount, 0, 'invalid input never wakes the publication worker');
    strictEqual(fixture.publicationCounts().publication, 0);
    strictEqual(fixture.counts().operation, 0);
    strictEqual(fixture.counts().snapshot, 0);
    strictEqual(fixture.counts().ledger, 0);
    strictEqual(JSON.stringify(fixture.counters()), JSON.stringify(countersBefore));

    const stored = fixture.raw().one<{
      request_digest_hex: string;
      failure_code: string;
      failure_message: string;
      rejected_at: string;
    }>(
      'SELECT request_digest_hex, failure_code, failure_message, rejected_at FROM preacceptance_rejection ' +
        'WHERE instance_id = ? AND caller_id = ? AND request_id = ?',
      fixture.instanceId,
      'caller_terminal',
      args.request_id,
    );
    strictEqual(stored?.request_digest_hex.length, 64);
    strictEqual(stored?.failure_code, 'invalid_input');
    ok(!JSON.stringify(stored).includes('DO_NOT_STORE_THIS_MARKER'), 'rejection ledger stores no manuscript content');

    const replay = await publish(makeContext(), 'caller_terminal', args);
    ok('phase' in replay);
    if (!('phase' in replay)) throw new Error('expected replayed pre-acceptance rejection');
    strictEqual(replay.replayed, true);
    strictEqual(replay.rejected_at, first.rejected_at);
    strictEqual(replay.failure.message, first.failure.message);

    fixture.restart();
    const replayAfterRestart = await publish(makeContext(), 'caller_terminal', args);
    ok('phase' in replayAfterRestart);
    if (!('phase' in replayAfterRestart)) throw new Error('expected durable pre-acceptance rejection');
    strictEqual(replayAfterRestart.replayed, true);
    strictEqual(replayAfterRestart.rejected_at, first.rejected_at);

    const status = await requestStatus(makeContext(), 'caller_terminal', {
      expected_instance_id: fixture.instanceId,
      request_id: args.request_id,
    });
    ok('phase' in status);
    if (!('phase' in status)) throw new Error('expected queryable pre-acceptance rejection');
    strictEqual(status.status, 'rejected');
    strictEqual(status.accepted, false);
    strictEqual(status.rejected_at, first.rejected_at);
    strictEqual(status.failure.code, first.failure.code);
    await rejects(
      requestStatus(makeContext(), 'caller_other', {
        expected_instance_id: fixture.instanceId,
        request_id: args.request_id,
      }),
      (error: unknown) => error instanceof BusinessError && error.code === 'not_found',
    );

    await rejects(
      publish(makeContext(), 'caller_terminal', {
        ...args,
        manuscript: { intent: 'note', body: 'changed invalid input', unexpected: false },
      }),
      (error: unknown) => error instanceof BusinessError && error.code === 'idempotency_conflict',
    );
    await rejects(
      publish(makeContext(), 'caller_terminal', {
        ...args,
        manuscript: { intent: 'note', body: 'now valid' },
      }),
      (error: unknown) => error instanceof BusinessError && error.code === 'idempotency_conflict',
    );
    strictEqual(fixture.publicationCounts().publication, 0);
    strictEqual(fixture.counts().operation, 0);
  } finally {
    fixture.close();
  }
});

test('C3 terminal-v1: concurrent invalid retries create one caller-scoped result; accepted-v2 stays legacy', async () => {
  const fixture = openPublicationFixture();
  const ctx = context(fixture, () => {
    throw new Error('invalid manuscript must not wake worker');
  });
  const args = {
    expected_instance_id: fixture.instanceId,
    request_id: 'terminal-preaccept-concurrent',
    contract_version: 'terminal-v1' as const,
    manuscript: { intent: 'note' },
  };
  try {
    const results = await Promise.all(Array.from({ length: 16 }, () => publish(ctx, 'caller_terminal', args)));
    strictEqual(results.filter((result) => 'phase' in result && !result.replayed).length, 1);
    strictEqual(results.filter((result) => 'phase' in result && result.replayed).length, 15);
    strictEqual(
      fixture.raw().one<{ n: number }>('SELECT count(*) AS n FROM preacceptance_rejection')?.n,
      1,
    );

    const foreign = await publish(ctx, 'caller_other', args);
    ok('phase' in foreign);
    strictEqual(
      fixture.raw().one<{ n: number }>('SELECT count(*) AS n FROM preacceptance_rejection')?.n,
      2,
      'the same request id is isolated by authenticated caller',
    );

    await rejects(
      publish(ctx, 'caller_terminal', {
        expected_instance_id: fixture.instanceId,
        request_id: 'accepted-v2-invalid-still-errors',
        contract_version: 'accepted-v2',
        manuscript: { intent: 'note' },
      }),
      (error: unknown) => error instanceof BusinessError && error.code === 'invalid_input',
    );
    strictEqual(
      fixture.raw().one<{ n: number }>(
        "SELECT count(*) AS n FROM preacceptance_rejection WHERE request_id = 'accepted-v2-invalid-still-errors'",
      )?.n,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('C3 terminal-v1: MCP publish and request_status expose the same durable pre-acceptance result', async () => {
  const service = await startService({});
  try {
    const connection = await connectModernClient({
      port: service.port,
      token: service.token,
      clientName: 'terminal-preaccept-wire',
    });
    try {
      const info = (await connection.client.callTool({
        name: 'ephemera_service_info',
        arguments: {},
      })) as unknown as { structuredContent: { instance_id: string } };
      const instanceId = info.structuredContent.instance_id;
      const first = (await connection.client.callTool({
        name: 'ephemera_publish',
        arguments: {
          expected_instance_id: instanceId,
          request_id: 'terminal-preaccept-wire-1',
          contract_version: 'terminal-v1',
          manuscript: { intent: 'note' },
        },
      })) as unknown as {
        isError?: boolean;
        structuredContent: { phase: string; accepted: boolean; rejected_at: string; failure: { code: string } };
      };
      strictEqual(first.isError, undefined);
      strictEqual(first.structuredContent.phase, 'pre-acceptance');
      strictEqual(first.structuredContent.accepted, false);
      strictEqual(first.structuredContent.failure.code, 'invalid_input');

      const status = (await connection.client.callTool({
        name: 'ephemera_request_status',
        arguments: {
          expected_instance_id: instanceId,
          request_id: 'terminal-preaccept-wire-1',
        },
      })) as unknown as {
        isError?: boolean;
        structuredContent: { phase: string; accepted: boolean; status: string; rejected_at: string; failure: { code: string } };
      };
      strictEqual(status.isError, undefined);
      strictEqual(status.structuredContent.phase, 'pre-acceptance');
      strictEqual(status.structuredContent.accepted, false);
      strictEqual(status.structuredContent.status, 'rejected');
      strictEqual(status.structuredContent.rejected_at, first.structuredContent.rejected_at);
      strictEqual(status.structuredContent.failure.code, first.structuredContent.failure.code);
    } finally {
      await connection.close();
    }
  } finally {
    const stopped = await service.stop();
    strictEqual(stopped.code, 0);
  }
});
