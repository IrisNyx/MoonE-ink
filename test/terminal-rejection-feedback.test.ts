import { match, ok, strictEqual } from 'node:assert';
import { test } from 'node:test';
import { RenderError, type RenderErrorCode } from '../src/render/errors.js';
import { publish, requestStatus, type ToolContext } from '../src/tools.js';
import { BoundedTypesetterReviewer, TYPESETTER_CAPABILITY_SCHEMA, TYPESETTER_REVIEW_SCHEMA } from '../src/typesetter/reviewer.js';
import { openPublicationFixture } from './helpers/publication.js';

function context(fixture: ReturnType<typeof openPublicationFixture>): ToolContext {
  return {
    store: fixture.storeView(), acceptance: fixture.service,
    publication: fixture.publication, query: fixture.query,
    publishAvailable: true, terminalPollMs: 2,
  };
}

const contentCases: Array<{ code: RenderErrorCode; detail: string; expected: string }> = [
  { code: 'invalid_input', detail: 'title must be a string when present', expected: 'title must be a string' },
  { code: 'unsupported_genre', detail: 'genre is not supported by this renderer', expected: '所选体裁暂不支持' },
  { code: 'unsupported_content_slot', detail: 'postcard paper has no subtitle slot', expected: 'subtitle' },
  { code: 'unsupported_glyph', detail: 'note body contains a Unicode scalar with no glyph in the bound fonts (first at 8)', expected: 'first at 8' },
  { code: 'render_overflow', detail: 'body does not fit the postcard paper (body_no_vertical_overflow, body_lines)', expected: '正文超出所选版式' },
];

for (const entry of contentCases) {
  test(`terminal feedback retains actionable ${entry.code} after restart and replay`, async () => {
    const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
    const args = {
      expected_instance_id: fixture.instanceId, request_id: `feedback-${entry.code}`,
      contract_version: 'terminal-v1' as const,
      manuscript: { intent: 'note', body: '保留原文，反馈应指出需要修正的位置。' },
    };
    try {
      const receipt = await fixture.service.accept({
        expectedInstanceId: fixture.instanceId, callerId: 'feedback', requestId: args.request_id,
        manuscript: args.manuscript, businessContract: args.contract_version,
      });
      const worker = fixture.makeWorker({ render: async () => { throw new RenderError(entry.code, entry.detail); } });
      strictEqual(await worker.runOnce(), true);
      strictEqual(await worker.runOnce(), false, 'content rejection must not retry rendering');
      strictEqual(fixture.status('feedback', { operationId: receipt.operation_id })?.terminal_detail, entry.detail);
      fixture.restart();
      const ctx = context(fixture);
      const result = await publish(ctx, 'feedback', args);
      strictEqual(result.outcome, 'rejected');
      strictEqual(result.replayed, true);
      strictEqual(result.failure?.category, 'manuscript');
      strictEqual(result.failure?.code, entry.code);
      ok(result.failure?.message.includes(entry.expected), result.failure?.message);
      ok(!result.failure?.message.includes('body_no_vertical_overflow'));
      ok(!result.failure?.message.includes('the manuscript did not pass publication checks'));
      const status = await requestStatus(ctx, 'feedback', {
        expected_instance_id: fixture.instanceId, operation_id: receipt.operation_id,
      });
      strictEqual(status.failure?.message, result.failure?.message, 'feedback must not be wrapped or duplicated on replay');
      strictEqual(fixture.publicationCounts().publication, 0);
    } finally {
      fixture.close();
    }
  });
}

test('technical rendering and template font failures never ask the author to rewrite', async () => {
  for (const code of ['render_failed', 'unsupported_glyph'] as const) {
    const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
    try {
      const args = {
        expected_instance_id: fixture.instanceId, request_id: `technical-${code}`,
        contract_version: 'terminal-v1' as const, manuscript: { intent: 'note', body: '原文无需为技术故障修改。' },
      };
      await fixture.service.accept({
        expectedInstanceId: fixture.instanceId, callerId: 'feedback', requestId: args.request_id,
        manuscript: args.manuscript, businessContract: args.contract_version,
      });
      const worker = fixture.makeWorker({ render: async () => {
        throw new RenderError(code, code === 'unsupported_glyph'
          ? 'note template text contains a Unicode scalar with no glyph in the bound fonts (first at 0)'
          : 'browser failed at C:\\private\\browser.js');
      } });
      for (let i = 0; i < 3; i += 1) await worker.runOnce();
      const result = await publish(context(fixture), 'feedback', args);
      strictEqual(result.outcome, 'rejected');
      strictEqual(result.failure?.category, 'technical');
      strictEqual(result.failure?.code, 'render_failed');
      ok(!/删|修改|字符|C:|browser\.js/.test(result.failure?.message ?? ''));
      strictEqual(fixture.publicationCounts().publication, 0);
    } finally {
      fixture.close();
    }
  }
});

test('model rejection keeps its existing returnFeedback verbatim', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const feedback = '标题与落款发生重叠，请选择能同时容纳这两个栏目的版式。';
  const reviewer = Object.assign(new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review() {
      return {
        schema: TYPESETTER_REVIEW_SCHEMA, decision: 'reject', reviewed_page_indexes: [0],
        issues: [{ code: 'collision', page_index: 0, message: '标题与落款重叠。' }], usage: null,
      };
    },
  }), { async returnFeedback() { return feedback; } });
  try {
    const args = {
      expected_instance_id: fixture.instanceId, request_id: 'model-feedback',
      contract_version: 'terminal-v1' as const, manuscript: { intent: 'note', body: '保留原有审核意见。' },
    };
    await fixture.service.accept({
      expectedInstanceId: fixture.instanceId, callerId: 'feedback', requestId: args.request_id,
      manuscript: args.manuscript, businessContract: args.contract_version,
    });
    await fixture.makeWorker({ reviewer }).runOnce();
    const result = await publish(context(fixture), 'feedback', args);
    strictEqual(result.failure?.code, 'model_rejected');
    strictEqual(result.failure?.message, feedback);
    match(result.failure?.message ?? '', /标题与落款/);
    strictEqual(fixture.publicationCounts().publication, 0);
  } finally {
    fixture.close();
  }
});
