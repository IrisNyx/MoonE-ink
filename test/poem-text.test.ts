import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  GENRE_CONTENT_SCHEMA,
  STORED_GENRE_CONTENT_SCHEMA,
  contentDisplayText,
  contentPrimaryText,
  contentTextSegments,
  contentToPaperFields,
} from '../src/domain/genre-content.js';
import { validateManuscript } from '../src/domain/manuscript.js';
import { realRenderJob } from '../src/jobs/renderer.js';
import type { WorkerRenderOutcome } from '../src/jobs/worker.js';
import { RenderError } from '../src/render/errors.js';
import { freshDir } from './helpers/env.js';
import { openPublicationFixture } from './helpers/publication.js';

type PoemLayout = 'poem-portrait' | 'poem-landscape';

const textCases: Array<{ name: string; text: string; lines: string[]; layout: PoemLayout }> = [
  { name: 'LF', text: '月光落下\n窗边很静\n等你醒来', lines: ['月光落下', '窗边很静', '等你醒来'], layout: 'poem-portrait' },
  { name: 'blank-line', text: '月光落下\n\n等你醒来', lines: ['月光落下', '', '等你醒来'], layout: 'poem-portrait' },
  { name: 'CRLF', text: '月光落下\r\n窗边很静\r\n等你醒来', lines: ['月光落下', '窗边很静', '等你醒来'], layout: 'poem-landscape' },
];

test('poem author input is one text string; newline spelling is preserved while paper gets separate lines', () => {
  for (const entry of textCases) {
    const content = GENRE_CONTENT_SCHEMA.parse({ kind: 'poem', text: entry.text });
    assert.equal(content.kind, 'poem');
    assert.deepEqual(content, { kind: 'poem', text: entry.text });
    assert.equal(contentPrimaryText(content), entry.text, `${entry.name}: exact body projection`);
    assert.equal(contentDisplayText(content), entry.text, `${entry.name}: exact author readback projection`);
    assert.deepEqual(contentToPaperFields(content).poem, entry.lines, `${entry.name}: authored line boundaries`);
    const manuscript = validateManuscript({ schemaVersion: 3, intent: 'note', content }).manuscript;
    assert.equal(manuscript.body, entry.text);
    assert.equal(manuscript.genrePreference, 'poem');
  }
  const edgeWhitespace = '\n月光落下\r\n\r\n等你醒来\n';
  const edgeContent = GENRE_CONTENT_SCHEMA.parse({ kind: 'poem', text: edgeWhitespace });
  assert.equal(contentPrimaryText(edgeContent), edgeWhitespace, 'leading/trailing and blank lines are not trimmed');
  assert.deepEqual(contentToPaperFields(edgeContent).poem, ['', '月光落下', '', '等你醒来', '']);
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'poem', lines: ['月光落下'] }).success, false,
    'the public author contract no longer asks for an array of lines');
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'poem', text: '月光落下', lines: ['月光落下'] }).success, false,
    'two competing copies of the poem must not be accepted');
});

for (const entry of textCases) {
  test(`poem ${entry.name}: real ${entry.layout} publication and persisted readback preserve the exact author text`,
    { timeout: 180_000 }, async () => {
      const rendered: WorkerRenderOutcome[] = [];
      const fixture = openPublicationFixture({ render: async (job) => {
        const result = await realRenderJob(job);
        rendered.push(result);
        return result;
      } });
      try {
        const receipt = await fixture.service.accept({
          expectedInstanceId: fixture.instanceId,
          callerId: 'poem_text_author',
          requestId: `poem-text-${entry.name}`,
          manuscript: {
            schemaVersion: 3, intent: 'note',
            content: { kind: 'poem', text: entry.text }, layoutVariant: entry.layout,
          },
        });
        assert.equal(await fixture.makeWorker().runOnce(), true);
        const status = fixture.status('poem_text_author', { operationId: receipt.operation_id });
        assert.equal(status?.status, 'published', JSON.stringify(status));
        assert.equal(rendered.length, 1);
        const page = rendered[0]?.pages?.[0];
        const landscape = entry.layout === 'poem-landscape';
        assert.equal(page?.width, landscape ? 960 : 540);
        assert.equal(page?.height, landscape ? 540 : 960);
        assert.equal(page?.gray4.bytes, 259200);
        assert.deepEqual((rendered[0]?.paper as { poem?: unknown }).poem, entry.lines);
        fixture.restart();
        const work = fixture.query.authorPeek('poem_text_author', { scope: 'recent', limit: 1 }).items[0];
        assert.equal(work?.genre, 'poem');
        assert.equal(work?.body, entry.text, 'database restart/readback must not normalize newlines or remove blank lines');
      } finally {
        fixture.close();
      }
    });
}

test('stored poem lines remain valid and readable after the public contract switches to text',
  { timeout: 180_000 }, async () => {
    const legacy = { kind: 'poem', lines: ['月光落下', '窗边很静', '等你醒来'] };
    const expected = legacy.lines.join('\n');
    const content = STORED_GENRE_CONTENT_SCHEMA.parse(legacy);
    const oldEmbeddedBreak = STORED_GENRE_CONTENT_SCHEMA.parse({ kind: 'poem', lines: ['月\n光', '窗'] });
    assert.deepEqual(contentToPaperFields(oldEmbeddedBreak).poem, ['月\n光', '窗'],
      'legacy array elements retain their existing column grouping');
    assert.deepEqual(contentTextSegments(oldEmbeddedBreak), ['月\n光', '窗']);
    assert.equal(contentPrimaryText(content), expected);
    assert.equal(contentDisplayText(content), expected);
    assert.deepEqual(contentToPaperFields(content).poem, legacy.lines);
    const savedManuscript = {
      schemaVersion: 3, intent: 'note', body: expected,
      content: legacy, layoutVariant: 'poem-portrait',
    };
    assert.equal(validateManuscript(savedManuscript).manuscript.body, expected);
    const fixture = openPublicationFixture({ render: realRenderJob });
    try {
      // The domain fixture bypasses the new author-facing schema, as a stored
      // job does. Its original lines representation must still render/read back.
      const receipt = await fixture.service.accept({
        expectedInstanceId: fixture.instanceId, callerId: 'legacy_poem_author',
        requestId: 'stored-poem-lines', manuscript: savedManuscript,
      });
      assert.equal(await fixture.makeWorker().runOnce(), true);
      assert.equal(fixture.status('legacy_poem_author', { operationId: receipt.operation_id })?.status, 'published');
      fixture.restart();
      const work = fixture.query.authorPeek('legacy_poem_author', { scope: 'recent', limit: 1 }).items[0];
      assert.equal(work?.genre, 'poem');
      assert.equal(work?.body, expected);
    } finally {
      fixture.close();
    }
  });

for (const layout of ['poem-portrait', 'poem-landscape'] as const) {
  test(`${layout}: a long unbroken poem line passes input validation and is rejected by real layout`,
    { timeout: 180_000 }, async () => {
      const text = '月'.repeat(60);
      const content = GENRE_CONTENT_SCHEMA.parse({ kind: 'poem', text });
      const manuscript = validateManuscript({
        schemaVersion: 3, intent: 'note', content, layoutVariant: layout,
      }).manuscript;
      assert.equal(manuscript.body, text);
      assert.deepEqual(contentToPaperFields(content).poem, [text], 'input must not silently reflow a poem line');
      await assert.rejects(realRenderJob({
        manuscript, date: '2026-10-23', tmpDir: join(freshDir('poem-long-line'), layout),
      }), (error: unknown) => {
        assert.ok(error instanceof RenderError);
        assert.equal(error.code, 'render_overflow');
        assert.match(error.message, /第\s*1\s*行/);
        assert.match(error.message, /换行/);
        return true;
      });
      assert.equal(manuscript.body, text, 'rejection must leave the author text unchanged');
    });
}

test('poem landscape accepts an eight-character line but rejects a ten-character line entering the footer',
  { timeout: 180_000 }, async () => {
    const root = freshDir('poem-landscape-column');
    const prepare = (length: number) => validateManuscript({
      schemaVersion: 3, intent: 'note', layoutVariant: 'poem-landscape',
      content: GENRE_CONTENT_SCHEMA.parse({ kind: 'poem', text: '月'.repeat(length) }),
    }).manuscript;
    const short = prepare(8);
    const rendered = await realRenderJob({ manuscript: short, date: '2026-10-23', tmpDir: join(root, 'eight') });
    assert.equal(rendered.pages?.[0]?.width, 960);
    assert.equal(rendered.pages?.[0]?.height, 540);
    assert.deepEqual((rendered.paper as { poem?: unknown }).poem, ['月'.repeat(8)]);
    const overflowing = prepare(10);
    assert.equal(overflowing.body, '月'.repeat(10), 'ten characters are valid input before measured layout');
    await assert.rejects(realRenderJob({
      manuscript: overflowing, date: '2026-10-23', tmpDir: join(root, 'ten'),
    }), (error: unknown) => {
      assert.ok(error instanceof RenderError);
      assert.equal(error.code, 'render_overflow');
      assert.match(error.message, /第\s*1\s*行/);
      assert.match(error.message, /换行/);
      return true;
    });
    assert.equal(overflowing.body, '月'.repeat(10));
  });
