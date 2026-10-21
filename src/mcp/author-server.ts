import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { GENRE_CONTENT_SCHEMA } from '../domain/genre-content.js';
import { BusinessError } from '../errors.js';
import {
  ENABLED_PRODUCTION_GENRE_IDS,
  ENABLED_PRODUCTION_LAYOUT_VARIANT_IDS,
  authorCatalogText,
} from '../production-catalog.js';
import { publish, TOOL_PEEK, TOOL_PUBLISH, type ToolContext } from '../tools.js';
import type { WeatherSnapshot } from '../weather/types.js';
import { LEGACY_PROTOCOL_VERSIONS } from '../version.js';
import type { McpRequestContextInput } from './server.js';

const intentSchema = z.enum(['note', 'letter', 'share', 'reminder', 'question', 'celebration', 'other']);
const deliverySchema = z.strictObject({
  persistence: z.enum(['ephemeral', 'keep', 'archive']),
  presentation: z.enum(['ambient', 'foreground', 'physical-preferred']),
  interruption: z.enum(['never', 'when-idle', 'important']),
  preferredMedium: z.enum(['ephemera', 'print']).optional(),
  deliverAfter: z.string().optional().describe('可选 RFC 3339 最早投递时间。'),
  expiresAt: z.string().optional().describe('可选 RFC 3339 过期时间。'),
});
const titleSlotSchema = z.strictObject({
  action: z.enum(['replace', 'supply']),
  value: z.string().max(512),
});
const titleAdaptationSchema = z.strictObject({
  schema: z.literal('explicit-replacement-v1'),
  title: titleSlotSchema.optional(),
  subtitle: titleSlotSchema.optional(),
});
const bylinesSchema = z.strictObject({
  issuer: z.string().max(512).optional().describe('作者希望刊登的署名人；省略时使用 Owner 为该版式设的默认值。'),
  recipient: z.string().max(512).optional().describe('仅限有“收执人/致”第二落款位的版式；省略时使用 Owner 默认值。'),
});
const commonV3 = {
  schemaVersion: z.literal(3),
  intent: intentSchema,
  title: z.string().max(512).optional().describe('只有便签、欠条、附刊和印记徽有标题位；其他结构稿不要填写。'),
  subtitle: z.string().max(512).optional().describe('只有醒来纸、某夜星空和登机牌有副题位；其他结构稿不要填写。'),
  signature: z.string().max(512).optional().describe('兼容的单落款字段，等同 bylines.issuer；新稿优先使用 bylines。'),
  bylines: bylinesSchema.optional().describe('可选次要栏目。作者写了就原样使用；没写才回落到 Owner 在控制台配置的落款。'),
  protectedText: z.array(z.string()).max(64).optional(),
  tone: z.string().max(128).optional(),
  genrePreferenceMode: z.enum(['strict', 'preferred']).optional(),
  layoutVariant: z.enum(ENABLED_PRODUCTION_LAYOUT_VARIANT_IDS as [string, ...string[]]).optional(),
  delivery: deliverySchema.optional(),
  titleAdaptation: titleAdaptationSchema.optional(),
} as const;

const autoManuscriptSchema = z.strictObject({
  ...commonV3,
  body: z.string().min(1).max(64 * 1024).describe(
    '普通散文正文。没有明确结构体裁时只填这一份正文，服务会自动选版；不要同时填写 content。',
  ),
  genrePreference: z.enum(ENABLED_PRODUCTION_GENRE_IDS).optional().describe(
    '可选体裁偏好。诗、电报、清单等结构稿应改用 content，而不是把结构压进 body。',
  ),
});

const structuredManuscriptSchema = z.strictObject({
  ...commonV3,
  content: GENRE_CONTENT_SCHEMA.describe(
    '结构稿。kind 决定体裁；各分支列出的主内容必须完整，可选次要栏可省略。不要再复制一份 body。',
  ),
});

// The legacy branches stay explicit and strict so existing v1/v2 clients do
// not break, without turning the current author surface back into arbitrary JSON.
const legacyV1Schema = z.strictObject({
  intent: intentSchema,
  body: z.string().min(1).max(64 * 1024),
  title: z.string().max(512).optional(),
  subtitle: z.string().max(512).optional(),
  protectedText: z.array(z.string()).max(64).optional(),
  tone: z.string().max(128).optional(),
  genrePreference: z.literal('postcard').optional(),
  delivery: deliverySchema.optional(),
  titleAdaptation: titleAdaptationSchema.optional(),
});
const legacyV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  intent: intentSchema,
  body: z.string().min(1).max(64 * 1024),
  title: z.string().max(512).optional(),
  subtitle: z.string().max(512).optional(),
  signature: z.string().max(512).optional(),
  protectedText: z.array(z.string()).max(64).optional(),
  tone: z.string().max(128).optional(),
  genrePreference: z.enum(['postcard', 'note']).optional(),
  genrePreferenceMode: z.enum(['strict', 'preferred']).optional(),
  layoutVariant: z.enum(['postcard-portrait', 'note-portrait-v4']).optional(),
  delivery: deliverySchema.optional(),
  titleAdaptation: titleAdaptationSchema.optional(),
});

const publishInput = z.strictObject({
  manuscript: z.union([
    structuredManuscriptSchema,
    autoManuscriptSchema,
    legacyV2Schema,
    legacyV1Schema,
  ]).describe('一次提交完整作者稿件；结构稿使用 content，普通散文使用 body。'),
});

/**
 * Some mobile MCP hosts still consume the advertised schemas through an
 * OpenAPI-style converter which does not understand JSON Schema `const` or
 * `oneOf`.  Keep Zod as the source of truth for validation, but advertise the
 * equivalent, more widely supported spellings on the wire.
 */
function normalizeAdvertisedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAdvertisedSchema);
  if (value === null || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'const') {
      normalized['enum'] = [normalizeAdvertisedSchema(child)];
    } else if (key === 'oneOf') {
      normalized['anyOf'] = normalizeAdvertisedSchema(child);
    } else {
      normalized[key] = normalizeAdvertisedSchema(child);
    }
  }
  return normalized;
}

function broadlyCompatibleAdvertisement<Schema extends { readonly '~standard': {
  readonly jsonSchema: {
    readonly input: (options: never) => Record<string, unknown>;
    readonly output: (options: never) => Record<string, unknown>;
  };
} }>(schema: Schema): Schema {
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: (options: never) => normalizeAdvertisedSchema(standard.jsonSchema.input(options)) as Record<string, unknown>,
        output: (options: never) => normalizeAdvertisedSchema(standard.jsonSchema.output(options)) as Record<string, unknown>,
      },
    },
  } as Schema;
}

const advertisedPublishInput = broadlyCompatibleAdvertisement(publishInput);

const workOutput = z.strictObject({
  reference: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  signature: z.string().nullable(),
  genre: z.string(),
  page_count: z.number().int(),
  part_count: z.number().int(),
  unread: z.boolean(),
});

const publishOutput = z.strictObject({
  status: z.literal('published'),
  work: workOutput,
  has_supplement: z.boolean(),
});
const advertisedPublishOutput = broadlyCompatibleAdvertisement(publishOutput);

const peekInput = z.strictObject({
  scope: z.enum(['overview', 'unread', 'recent', 'work', 'weather']).optional().describe(
    'overview 默认同时回答当前显示与未读；unread 只列未读；recent 浏览已有投稿；work 查一篇；weather 读取真实的今天、明天、后天预报，写气象简报前先调用。',
  ),
  work: z.string().min(1).optional().describe('作品编号、完整标题或正文中的一段；scope=work 时使用。'),
  limit: z.number().int().min(1).max(100).optional(),
});

const peekOutput = z.strictObject({
  current_state: z.enum(['known', 'unknown']),
  current: workOutput.nullable(),
  unread_count: z.number().int(),
  items: z.array(workOutput),
  weather: z.strictObject({
    location: z.string(),
    source: z.string(),
    current: z.strictObject({ description: z.string(), temperature_c: z.number() }),
    forecast: z.array(z.strictObject({
      label: z.string(), date: z.string(), description: z.string(),
      temperature_min_c: z.number(), temperature_max_c: z.number(),
    })),
  }).optional(),
});

const failure = (error: BusinessError) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ code: error.code, message: error.message }) }],
  isError: true as const,
});

// A preview is an author workflow prerequisite, not an authentication token.
// Restarting the service deliberately asks the author to read the forecast again.
const viewedWeatherByCaller = new Map<string, { locationId: string; date: string }>();

function weatherPreviewIdentity(snapshot: WeatherSnapshot): { locationId: string; date: string } {
  return { locationId: snapshot.location.id, date: snapshot.days[0].date };
}

/** Normal author surface: exactly write and peek. Operational tools stay in the admin/internal surface. */
export function buildAuthorMcpServer(ctx: McpRequestContextInput, toolContext: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'ephemera', title: 'Ephemera 作者工具', version: '1' },
    {
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS],
      instructions: '写气象简报时先调用 ephemera_peek(scope=weather) 读取真实的今天、明天、后天预报，再使用 ephemera_publish 提交 content.kind=weather。未看预报的天气稿不会出版；其他体裁按作者意图投稿。',
    },
  );

  server.registerTool(
    TOOL_PUBLISH,
    {
      description: '写下并正式出版一篇纸。重要：写气象简报前，必须先调用 ephemera_peek(scope=weather) 看真实预报，再用 content.kind=weather 投稿；未经预览的天气稿不会出版。当前 21 种体裁可新投；普通散文可自动选版，结构稿由 content.kind 明确选择。' +
        '长醒来纸会自动生成同一作品内的附刊。成功只返回作者作品内容与结果，不返回内部任务或渲染诊断。\n\n' + authorCatalogText(),
      inputSchema: advertisedPublishInput,
      outputSchema: advertisedPublishOutput,
      annotations: { title: '写一篇纸', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const parsed = publishInput.safeParse(args ?? {});
      if (!parsed.success) return failure(new BusinessError('invalid_input', '稿件格式不正确'));
      try {
        if ('content' in parsed.data.manuscript && parsed.data.manuscript.content.kind === 'weather') {
          if (ctx.callerId === undefined || toolContext.authorWeatherForecast === undefined ||
              viewedWeatherByCaller.get(ctx.callerId) === undefined) {
            return failure(new BusinessError('invalid_input',
              '气象简报尚未读取预报。先调用 ephemera_peek，参数 scope=weather；看过今天、明天、后天的真实天气后，按预报写 commentary，再以 content.kind=weather 投稿。'));
          }
          const currentForecast = await toolContext.authorWeatherForecast();
          const viewed = viewedWeatherByCaller.get(ctx.callerId);
          const current = weatherPreviewIdentity(currentForecast);
          if (viewed?.locationId !== current.locationId || viewed.date !== current.date) {
            return failure(new BusinessError('invalid_input',
              '天气地点或日期已变化。请重新调用 ephemera_peek(scope=weather)，依据新预报修改天气稿后再投稿。'));
          }
        }
        const result = await publish(toolContext, ctx.callerId, {
          expected_instance_id: toolContext.store.instanceId,
          request_id: `author:${randomUUID()}`,
          manuscript: parsed.data.manuscript,
          contract_version: 'terminal-v1',
        });
        if (!('outcome' in result) || result.outcome !== 'published' || result.publication === undefined) {
          const message = 'failure' in result && result.failure?.code === 'model_rejected'
            ? '页面显示有文字缺失或不可读，本次没有发布；请联系管理员检查版式，不需要修改原文。'
            : 'failure' in result && result.failure !== undefined ? result.failure.message : '这篇稿件没有出版成功';
          const code = 'failure' in result && result.failure?.category === 'technical' ? 'render_failed' : 'invalid_input';
          return failure(new BusinessError(code, message));
        }
        const view = toolContext.query.authorPeek(ctx.callerId, {
          scope: 'work', work: result.publication.publication_id, limit: 1,
        });
        const work = view.items[0];
        if (work === undefined) throw new BusinessError('storage_unavailable', '作品已经出版，但暂时无法读取', true);
        const payload = { status: 'published' as const, work, has_supplement: work.part_count > 1 };
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (error) {
        if (error instanceof BusinessError) return failure(error);
        return failure(new BusinessError('storage_unavailable', '暂时无法出版，请稍后再试', true));
      }
    },
  );

  server.registerTool(
    TOOL_PEEK,
    {
      description: '回看自己写过的内容、当前显示及未读；写气象简报前调用 scope=weather，读取已配置地点的真实今天、明天、后天预报。默认 overview；不暴露密钥或调试信息。',
      inputSchema: peekInput,
      outputSchema: peekOutput,
      annotations: { title: '看看现在和未读', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = peekInput.safeParse(args ?? {});
      if (!parsed.success) return failure(new BusinessError('invalid_input', '回看条件格式不正确'));
      try {
        const { scope, work, limit } = parsed.data;
        const view = toolContext.query.authorPeek(ctx.callerId,
          scope === 'weather' ? { scope: 'overview', limit: 1 } : { scope, work, limit });
        let payload: z.infer<typeof peekOutput> = view;
        if (scope === 'weather') {
          if (toolContext.authorWeatherForecast === undefined) {
            throw new BusinessError('asset_unavailable', '天气预报尚未接入；请暂时不要写具体天气。');
          }
          const forecast = await toolContext.authorWeatherForecast();
          if (ctx.callerId !== undefined) viewedWeatherByCaller.set(ctx.callerId, weatherPreviewIdentity(forecast));
          payload = {
            ...view,
            weather: {
              location: forecast.location.full_name,
              source: forecast.provider_name,
              current: {
                description: forecast.current.description,
                temperature_c: forecast.current.temperature_c,
              },
              forecast: forecast.days.map((day, index) => ({
                label: ['今天', '明天', '后天'][index]!,
                date: day.date,
                description: day.description,
                temperature_min_c: day.temperature_min_c,
                temperature_max_c: day.temperature_max_c,
              })),
            },
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (error) {
        if (error instanceof BusinessError) return failure(error);
        return failure(new BusinessError('storage_unavailable', '暂时无法读取作品', true));
      }
    },
  );
  return server;
}
