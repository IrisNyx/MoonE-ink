import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BusinessError } from '../src/errors.js';
import { buildAuthorMcpServer } from '../src/mcp/author-server.js';
import type { ToolContext } from '../src/tools.js';
import { BoundedTypesetterReviewer, TYPESETTER_CAPABILITY_SCHEMA, TYPESETTER_REVIEW_SCHEMA } from '../src/typesetter/reviewer.js';
import { LEGACY_PROTOCOL_VERSIONS } from '../src/version.js';
import { connectLegacyClient, connectModernClient } from './helpers/client.js';
import { openPublicationFixture, syntheticRenderer } from './helpers/publication.js';
import { startService } from './helpers/proc.js';
import { realRenderJob } from '../src/jobs/renderer.js';

interface AuthorIssue {
  field: string;
  message: string;
  suggestion: string;
}

interface AuthorReceipt {
  status: 'published' | 'rejected' | 'unavailable' | 'unconfirmed';
  message?: string;
  issues?: AuthorIssue[];
  work?: { body: string; genre: string };
}

function receipt(result: unknown): AuthorReceipt {
  const wire = result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: AuthorReceipt;
  };
  strictEqual(wire.isError, undefined, 'an author publication outcome is a normal MCP result');
  ok(wire.structuredContent, 'the same author receipt is available as structured content');
  const text = wire.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  deepStrictEqual(JSON.parse(text), wire.structuredContent, 'text and structured author receipts must agree');
  return wire.structuredContent;
}

function rejectedAt(result: unknown, field: string): AuthorReceipt {
  const payload = receipt(result);
  strictEqual(payload.status, 'rejected');
  ok(payload.message?.length, 'the author receives a readable publication outcome');
  const issue = payload.issues?.find((item) => item.field === field);
  ok(issue, `the receipt identifies ${field}: ${JSON.stringify(payload)}`);
  ok(issue.message.length > 0);
  ok(issue.suggestion.length > 0, 'the identified problem has a concrete correction');
  return payload;
}

for (const protocol of ['modern', ...LEGACY_PROTOCOL_VERSIONS]) {
  test(`author receipt over ${protocol}: malformed manuscripts and repeated layout conflicts can be corrected`, { timeout: 120_000 }, async () => {
    const service = await startService({
      configOverride(config) {
        const auth = config['auth'] as { credentials: Array<Record<string, unknown>> };
        auth.credentials[0]!['tool_view'] = 'author';
      },
    });
    try {
      const connection = protocol === 'modern'
        ? await connectModernClient({ port: service.port, token: service.token })
        : await connectLegacyClient({ port: service.port, token: service.token, version: protocol });
      try {
        const listed = await connection.client.listTools();
        const publishTool = listed.tools.find((tool) => tool.name === 'ephemera_publish')!;
        const input = publishTool.inputSchema as { required?: string[]; properties?: { manuscript?: unknown }; additionalProperties?: boolean };
        ok(input.required?.includes('manuscript'), 'advertisement still requires a manuscript');
        ok(input.properties?.manuscript, 'advertisement retains the complete manuscript schema');
        strictEqual(input.additionalProperties, false, 'advertisement retains strict object fields');
        ok(JSON.stringify(publishTool.outputSchema).includes('rejected'), 'rejected is an advertised business outcome');
        const poemSchemas: Array<Record<string, any>> = [];
        const findPoem = (node: unknown): void => {
          if (node === null || typeof node !== 'object') return;
          const object = node as Record<string, any>;
          if (object.properties?.kind?.enum?.includes('poem')) poemSchemas.push(object);
          Object.values(object).forEach(findPoem);
        };
        findPoem(publishTool.inputSchema);
        ok(poemSchemas.length > 0, 'the public contract includes poem');
        for (const schema of poemSchemas) {
          strictEqual(schema.properties.text.type, 'string');
          strictEqual(schema.properties.lines, undefined);
          ok(schema.required.includes('text'));
        }

        const lines = ['月亮落在窗边，', '我把这一刻留给你。'];
        const wrongLayout = {
          schemaVersion: 3, intent: 'share',
          content: { kind: 'note', text: lines.join('\n') },
          layoutVariant: 'poem-portrait',
        };
        const original = JSON.stringify(wrongLayout);
        const asString = await connection.client.callTool({
          name: 'ephemera_publish', arguments: { manuscript: JSON.stringify(wrongLayout) },
        });
        const stringReceipt = rejectedAt(asString, 'manuscript');
        ok(stringReceipt.issues?.some((issue) => /对象|object|字符串|string/.test(issue.suggestion)),
          'a string manuscript gets an object-versus-string correction');

        rejectedAt(await connection.client.callTool({ name: 'ephemera_publish', arguments: {} }), 'manuscript');
        rejectedAt(await connection.client.callTool({
          name: 'ephemera_publish', arguments: { manuscript: { schemaVersion: 3, intent: 'share', content: { kind: 'note' } } },
        }), 'manuscript.content.text');

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const mismatch = rejectedAt(await connection.client.callTool({
            name: 'ephemera_publish', arguments: { manuscript: wrongLayout },
          }), 'manuscript.layoutVariant');
          const advice = mismatch.issues?.map((issue) => `${issue.message} ${issue.suggestion}`).join(' ') ?? '';
          ok(advice.includes('note') && advice.includes('poem-portrait'), 'the conflicting genre and layout are explained');
          ok(/note-portrait-v4|省略|删除|移除|不填/.test(advice), 'the receipt offers a usable layout correction');
          strictEqual(JSON.stringify(wrongLayout), original, 'the original manuscript is not rewritten');
        }

        const before = await connection.client.callTool({ name: 'ephemera_peek', arguments: {} }) as unknown as {
          structuredContent: { items: unknown[]; unread_count: number };
        };
        strictEqual(before.structuredContent.items.length, 0, 'rejected calls publish no work');
        strictEqual(before.structuredContent.unread_count, 0);

        const corrected = { schemaVersion: 3, intent: 'share', content: { kind: 'poem', text: lines.join('\n') }, layoutVariant: 'poem-portrait' };
        const published = receipt(await connection.client.callTool({ name: 'ephemera_publish', arguments: { manuscript: corrected } }));
        strictEqual(published.status, 'published');
        strictEqual(published.work?.genre, 'poem');
        strictEqual(published.work?.body, lines.join('\n'), 'a corrected poem preserves every original line');
        const after = await connection.client.callTool({ name: 'ephemera_peek', arguments: {} }) as unknown as {
          structuredContent: { items: Array<{ body: string }>; unread_count: number };
        };
        strictEqual(after.structuredContent.items.length, 1, 'only the corrected manuscript was published');
        strictEqual(after.structuredContent.items[0]?.body, lines.join('\n'));
      } finally {
        await connection.close();
      }
    } finally {
      await service.stop();
    }
  });
}

function fixtureContext(fixture: ReturnType<typeof openPublicationFixture>, wakePublisher: () => void): ToolContext {
  return {
    store: fixture.storeView(), acceptance: fixture.service, publication: fixture.publication,
    query: fixture.query, publishAvailable: true, wakePublisher, terminalPollMs: 2, now: Date.now,
  };
}

async function connectAuthor(context: ToolContext) {
  const server = buildAuthorMcpServer({ era: 'legacy', callerId: 'caller_author_receipt', credentialId: 'credential_test' }, context);
  const client = new Client({ name: 'author-receipt-in-memory', version: '1' }, { supportedProtocolVersions: ['2025-11-25'] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('a poem line entering the footer returns actual layout advice as a normal MCP receipt', { timeout: 120_000 }, async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 90_000 });
  const worker = fixture.makeWorker({ render: realRenderJob });
  let work: Promise<boolean> | undefined;
  const connection = await connectAuthor(fixtureContext(fixture, () => { work ??= worker.runOnce(); }));
  const manuscript = {
    schemaVersion: 3, intent: 'share',
    content: { kind: 'poem', text: '月'.repeat(10) }, layoutVariant: 'poem-landscape',
  };
  const original = JSON.stringify(manuscript);
  try {
    const payload = receipt(await connection.client.callTool({ name: 'ephemera_publish', arguments: { manuscript } }));
    await work;
    strictEqual(payload.status, 'rejected');
    ok(/第\s*1\s*行/.test(payload.message ?? ''), payload.message);
    ok(payload.message?.includes('换行'), payload.message);
    strictEqual(JSON.stringify(manuscript), original);
    strictEqual(fixture.publicationCounts().publication, 0);
  } finally {
    await work;
    await connection.close();
    fixture.close();
  }
});

test('author receipt preserves the existing typesetter returnFeedback through the real MCP handler', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const feedback = '第 1 页：末行与落款重叠，最后三个字无法辨认；原文无需修改，请由管理员检查该版式。';
  let feedbackCalls = 0;
  const reviewer = Object.assign(new BoundedTypesetterReviewer({
    async capabilities() {
      return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
    },
    async review() {
      return {
        schema: TYPESETTER_REVIEW_SCHEMA, decision: 'reject', reviewed_page_indexes: [0],
        issues: [{ code: 'collision', page_index: 0, message: '末行与落款重叠，最后三个字无法辨认。' }], usage: null,
      };
    },
  }), {
    async returnFeedback(input: { issues: Array<{ page_index: number | null; message: string }> }) {
      feedbackCalls += 1;
      strictEqual(input.issues[0]?.page_index, 0);
      ok(input.issues[0]?.message.includes('最后三个字'));
      return feedback;
    },
  });
  const worker = fixture.makeWorker({ reviewer });
  let work: Promise<boolean> | undefined;
  const context = fixtureContext(fixture, () => { work ??= worker.runOnce(); });
  const connection = await connectAuthor(context);
  try {
    const payload = receipt(await connection.client.callTool({
      name: 'ephemera_publish', arguments: { manuscript: { schemaVersion: 3, intent: 'note', content: { kind: 'note', text: '原稿保持不变。' } } },
    }));
    await work;
    strictEqual(payload.status, 'rejected');
    strictEqual(payload.message, feedback, 'the author receives the actual existing returnFeedback, not a generic replacement');
    strictEqual(feedbackCalls, 1);
    strictEqual(fixture.publicationCounts().publication, 0);
    const row = fixture.raw().one<{ terminal_detail: string }>('SELECT terminal_detail FROM operation');
    strictEqual(row?.terminal_detail, feedback, 'the author receipt agrees with durable rejection feedback');
  } finally {
    await work;
    await connection.close();
    fixture.close();
  }
});

test('author receipt reports a service failure without asking the author to revise the manuscript', async () => {
  const fixture = openPublicationFixture();
  const context = fixtureContext(fixture, () => { throw new Error('unavailable renderer must not be scheduled'); });
  context.publishAvailable = false;
  const connection = await connectAuthor(context);
  try {
    const payload = receipt(await connection.client.callTool({
      name: 'ephemera_publish', arguments: { manuscript: { schemaVersion: 3, intent: 'note', content: { kind: 'note', text: '这是内容完整的便签。' } } },
    }));
    strictEqual(payload.status, 'unavailable');
    deepStrictEqual(Object.keys(payload).sort(), ['message', 'status']);
    ok(payload.message?.length);
    strictEqual(fixture.publicationCounts().publication, 0);
    strictEqual(fixture.counts().operation, 0, 'an unavailable service does not accept a doomed publication');
  } finally {
    await connection.close();
    fixture.close();
  }
});

test('author receipt never labels an already committed work as a manuscript rejection when readback fails', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  const worker = fixture.makeWorker();
  let work: Promise<boolean> | undefined;
  let readbackCalls = 0;
  const context = fixtureContext(fixture, () => { work ??= worker.runOnce(); });
  context.query = Object.assign(Object.create(fixture.query) as typeof fixture.query, {
    authorPeek() {
      readbackCalls += 1;
      strictEqual(fixture.publicationCounts().publication, 1, 'the readback fault is injected only after a real commit');
      throw new BusinessError('storage_unavailable', 'private diagnostic must not reach the author', true);
    },
  });
  const connection = await connectAuthor(context);
  try {
    const payload = receipt(await connection.client.callTool({
      // The fixture renderer implements the legacy postcard contract.
      name: 'ephemera_publish', arguments: { manuscript: { intent: 'note', body: '已完成的出版不能假称被拒稿。' } },
    }));
    await work;
    strictEqual(readbackCalls, 1, 'the test reaches the intended post-commit readback failure');
    strictEqual(payload.status, 'unconfirmed');
    deepStrictEqual(Object.keys(payload).sort(), ['message', 'status']);
    ok(payload.message?.length);
    strictEqual(payload.message?.includes('private diagnostic'), false);
    strictEqual(fixture.publicationCounts().publication, 1, 'failure happens after commit, so the response must not claim no publication');
  } finally {
    await work;
    await connection.close();
    fixture.close();
  }
});

test('author receipt keeps a pending terminal status failure unconfirmed while the accepted worker can still commit', async () => {
  const fixture = openPublicationFixture({ terminalPublishBudgetMs: 5_000 });
  let allowRender!: () => void;
  const renderGate = new Promise<void>((resolve) => { allowRender = resolve; });
  const render = syntheticRenderer();
  const worker = fixture.makeWorker({
    async render(job) { await renderGate; return render(job); },
  });
  let work: Promise<boolean> | undefined;
  let statusCalls = 0;
  const context = fixtureContext(fixture, () => { work ??= worker.runOnce(); });
  context.publication = Object.assign(Object.create(fixture.publication) as typeof fixture.publication, {
    statusForCaller() {
      statusCalls += 1;
      strictEqual(fixture.counts().operation, 1, 'the request was durably accepted before status lookup failed');
      strictEqual(fixture.publicationCounts().publication, 0, 'the render gate keeps the accepted work unfinished');
      throw new BusinessError('storage_unavailable', 'private status lookup diagnostic', true);
    },
  });
  const connection = await connectAuthor(context);
  try {
    const payload = receipt(await connection.client.callTool({
      name: 'ephemera_publish', arguments: { manuscript: { intent: 'note', body: '查询失败不代表这份稿件没有出版。' } },
    }));
    strictEqual(statusCalls, 1, 'the test reaches the terminal status query after acceptance');
    strictEqual(payload.status, 'unconfirmed');
    deepStrictEqual(Object.keys(payload).sort(), ['message', 'status']);
    strictEqual(payload.message?.includes('private status lookup'), false);
    strictEqual(fixture.publicationCounts().publication, 0);
    allowRender();
    await work;
    strictEqual(fixture.publicationCounts().publication, 1, 'the accepted worker can commit after the uncertain author receipt');
  } finally {
    allowRender();
    await work;
    await connection.close();
    fixture.close();
  }
});

test('author receipt reports missing weather service as unavailable without manuscript advice or acceptance', async () => {
  const fixture = openPublicationFixture();
  const context = fixtureContext(fixture, () => { throw new Error('missing weather service must not schedule publication'); });
  strictEqual(context.authorWeatherForecast, undefined);
  const connection = await connectAuthor(context);
  try {
    const payload = receipt(await connection.client.callTool({
      name: 'ephemera_publish', arguments: {
        manuscript: { schemaVersion: 3, intent: 'share', content: { kind: 'weather', commentary: '天气服务接入后再投递这份简报。' } },
      },
    }));
    strictEqual(payload.status, 'unavailable');
    deepStrictEqual(Object.keys(payload).sort(), ['message', 'status']);
    ok(payload.message?.length);
    strictEqual(payload.message?.includes('scope=weather'), false, 'a missing service is not disguised as a forgotten preview');
    strictEqual(fixture.counts().operation, 0);
    strictEqual(fixture.publicationCounts().publication, 0);
  } finally {
    await connection.close();
    fixture.close();
  }
});
