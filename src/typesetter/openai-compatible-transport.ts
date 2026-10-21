import {
  TYPESETTER_CAPABILITY_SCHEMA,
  TYPESETTER_FILL_SCHEMA,
  TYPESETTER_RETURN_SCHEMA,
  TYPESETTER_REVIEW_SCHEMA,
  TYPESETTER_SELECT_SCHEMA,
  type TypesetterTransport,
} from './reviewer.js';

interface ChatOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

interface ChatResult {
  value: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function parseStructuredContent(value: string): unknown {
  let json = value.trim().replace(/^\uFEFF/, '');
  // Some reasoning models return their chain-of-thought in the content field
  // even when a JSON response format was requested. MiniMax can split it into
  // a separate response field, but stripping a leading tagged block keeps the
  // adapter compatible with older gateways as well.
  json = json.replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/i, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(json);
  if (fenced !== null) json = fenced[1]!.trim();
  return JSON.parse(json) as unknown;
}

const SELECT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['layout_id', 'reason'],
  properties: {
    layout_id: { type: 'string' },
    reason: { type: 'string', maxLength: 300 },
  },
} as const;

const REVIEW_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'reviewed_page_indexes', 'issues'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject'] },
    reviewed_page_indexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['code', 'page_index', 'message'],
        properties: {
          code: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          page_index: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
          message: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
    },
  },
} as const;

const FILL_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['additions'],
  properties: {
    additions: {
      type: 'array', maxItems: 128,
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'value'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 256 },
          value: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
  },
} as const;

const RETURN_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['message'],
  properties: { message: { type: 'string', minLength: 1, maxLength: 512 } },
} as const;

const TEST_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok'],
  properties: { ok: { type: 'boolean' } },
} as const;

// A visible 64 x 64 black-and-white checkerboard. A 1 x 1 transparent/white
// PNG is rejected as an invalid image by otherwise capable multimodal APIs,
// including MiniMax M3.
const VISION_TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFQSURBVHhexdChDQBBEMPA77/p+4CFxral8FG+9crVzcAwa3UzMMxa3QwMs1Y3A8Os1c3AMGt1MzDMWt0MDLNWNwPDrNXNwDBrdTMwzFrdDAyzVjcDw6zVzcAwa3UzMMxa3QwMs1Y3A8Os1c3AMGt1MzDMWt0MDLNWNwPDrNXNwDBrdTMwzFrdDAyzVjcDw6zVzcAwa3UzMMxa3QwMs1Y3A8Os1c3AMGt1MzDMWt0MDLNWlwvoFHXnyEKUuXNkIcrcObIQZe4cWYgyd44sRJk7RxaizJ0jC1HmzpGFKHPnyEKUuXNkIcrcObIQZe4cWYgyd44sRJk7RxaizJ0jC1HmzpGFKHPnyEKUuXNkIcrcObIQZe4cWYgyd44sRJk7RxaizJ0jC1HmzpGFKHPnyEKUuXNkIcrcObIQZe4cWYgyd44sRJk7RxaizJ0jC1HavvcDT6baSuBJbgYAAAAASUVORK5CYII=';

/**
 * Direct adapter for OpenAI Chat Completions compatible APIs. The three
 * editorial stages stay separate even when they use the same model/key.
 */
export class OpenAiCompatibleTypesetterTransport implements TypesetterTransport {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly splitReasoning: boolean;

  constructor(options: ChatOptions) {
    this.endpoint = /\/chat\/completions\/?$/.test(options.endpoint)
      ? options.endpoint.replace(/\/$/, '')
      : `${options.endpoint.replace(/\/+$/, '')}/chat/completions`;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxRequestBytes = options.maxRequestBytes ?? 24 * 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 128 * 1024;
    this.splitReasoning = /^MiniMax-/i.test(options.model);
    if (this.endpoint.length === 0 || this.model.length === 0 || this.apiKey.length === 0) {
      throw new Error('typesetter OpenAI-compatible configuration is incomplete');
    }
  }

  async capabilities(_signal: AbortSignal): Promise<unknown> {
    // Chat Completions has no portable capability discovery endpoint. The
    // explicit Console test makes real text, schema and image requests.
    return { schema: TYPESETTER_CAPABILITY_SCHEMA, vision: true, structured_output: true, max_images: 16 };
  }

  async select(request: {
    schema: typeof TYPESETTER_SELECT_SCHEMA;
    prompt: string;
    manuscript: unknown;
    catalog_revision: string;
    candidates: unknown[];
  }, signal: AbortSignal): Promise<unknown> {
    const result = await this.chat(
      request.prompt,
      [{ type: 'text', text: `以下是只读投稿与候选版式数据。只从 candidates 中选择。\n${JSON.stringify({ manuscript: request.manuscript, catalog_revision: request.catalog_revision, candidates: request.candidates })}` }],
      'ephemera_typesetter_select',
      SELECT_RESULT_SCHEMA,
      signal,
    );
    if (!plain(result.value)) return result.value;
    return { schema: TYPESETTER_SELECT_SCHEMA, layout_id: result.value['layout_id'], reason: result.value['reason'] };
  }

  async fill(request: {
    schema: typeof TYPESETTER_FILL_SCHEMA;
    prompt: string;
    manuscript: unknown;
    layout_id: string;
    allowed_slots: Array<{ path: string; description_zh: string }>;
    facts?: unknown;
  }, signal: AbortSignal): Promise<unknown> {
    const result = await this.chat(
      request.prompt,
      [{ type: 'text', text: `以下是只读作者原稿、版式、系统事实和本次允许补充的次要栏目。只输出 allowed_slots 中确有必要的 path。\n${JSON.stringify({ manuscript: request.manuscript, layout_id: request.layout_id, allowed_slots: request.allowed_slots, facts: request.facts ?? null })}` }],
      'ephemera_typesetter_fill',
      FILL_RESULT_SCHEMA,
      signal,
    );
    if (!plain(result.value)) return result.value;
    return { schema: TYPESETTER_FILL_SCHEMA, additions: result.value['additions'] };
  }

  async review(request: Parameters<TypesetterTransport['review']>[0], signal: AbortSignal): Promise<unknown> {
    const content: Array<Record<string, unknown>> = [{
      type: 'text',
      text: `以下是只读的原稿、版式和页码信息。后续图片按 index 顺序给出，必须检查全部页面。\n${JSON.stringify({ manuscript: request.manuscript, catalog_revision: request.catalog_revision, layout_id: request.layout_id, pages: request.pages.map((page) => ({ index: page.index, sha256: page.sha256 })) })}`,
    }];
    for (const page of request.pages) {
      content.push({ type: 'text', text: `页面 index=${page.index}` });
      content.push({ type: 'image_url', image_url: { url: `data:${page.media_type};base64,${page.bytes_base64}` } });
    }
    const result = await this.chat(request.prompt, content, 'ephemera_typesetter_review', REVIEW_RESULT_SCHEMA, signal);
    if (!plain(result.value)) return result.value;
    return {
      schema: TYPESETTER_REVIEW_SCHEMA,
      decision: result.value['decision'],
      reviewed_page_indexes: result.value['reviewed_page_indexes'],
      issues: result.value['issues'],
      usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
    };
  }

  async returnFeedback(request: {
    schema: typeof TYPESETTER_RETURN_SCHEMA;
    prompt: string;
    layout_id: string;
    issues: Array<{ code: string; page_index: number | null; message: string }>;
  }, signal: AbortSignal): Promise<unknown> {
    const result = await this.chat(
      request.prompt,
      [{ type: 'text', text: `以下是已确认问题，只能整理这些问题。\n${JSON.stringify({ layout_id: request.layout_id, issues: request.issues })}` }],
      'ephemera_typesetter_return',
      RETURN_RESULT_SCHEMA,
      signal,
    );
    if (!plain(result.value)) return result.value;
    return { schema: TYPESETTER_RETURN_SCHEMA, message: result.value['message'] };
  }

  async testCapabilities(signal: AbortSignal): Promise<{
    text: boolean;
    structured: boolean;
    vision: boolean;
  }> {
    let text = false;
    let structured = false;
    let vision = false;
    try {
      const value = await this.chatPlain('你在进行连接测试。', '只回复 OK。', signal);
      text = value.trim().length > 0;
    } catch { /* reported below */ }
    try {
      const value = await this.chat('你在进行结构化输出测试。', [{ type: 'text', text: '把 ok 设为 true。' }], 'ephemera_structure_test', TEST_RESULT_SCHEMA, signal);
      structured = plain(value.value) && value.value['ok'] === true;
    } catch { /* reported below */ }
    try {
      const value = await this.chatPlainContent(
        '你在进行图片输入能力测试。看到黑白棋盘格后只回复 CHECKER。',
        [{ type: 'text', text: '检查随附的非私人黑白测试图片。' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_TEST_PNG}` } }],
        signal,
      );
      vision = /\bCHECKER\b/i.test(value);
    } catch { /* reported below */ }
    return { text, structured, vision };
  }

  private async chatPlain(system: string, user: string, signal: AbortSignal): Promise<string> {
    return this.chatPlainContent(system, user, signal);
  }

  private async chatPlainContent(
    system: string,
    user: string | Array<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request({
      model: this.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(this.splitReasoning ? { reasoning_split: true } : {}),
    }, signal);
    return this.content(response);
  }

  private async chat(
    system: string,
    content: Array<Record<string, unknown>>,
    schemaName: string,
    schema: unknown,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const structuredSystem = this.splitReasoning
      ? `${system}\n你必须只返回一个符合以下 JSON Schema 的 JSON 对象，不要解释或代码块：\n${JSON.stringify(schema)}`
      : system;
    const response = await this.request({
      model: this.model,
      messages: [{ role: 'system', content: structuredSystem }, { role: 'user', content }],
      response_format: this.splitReasoning
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      ...(this.splitReasoning ? { reasoning_split: true } : {}),
    }, signal);
    const contentText = this.content(response);
    const usage = plain(response['usage']) ? response['usage'] : {};
    return {
      value: parseStructuredContent(contentText),
      inputTokens: integerOrNull(usage['prompt_tokens']),
      outputTokens: integerOrNull(usage['completion_tokens']),
    };
  }

  private content(response: Record<string, unknown>): string {
    const choices = response['choices'];
    if (!Array.isArray(choices) || !plain(choices[0]) || !plain(choices[0]['message'])) {
      throw new Error('model response has no assistant message');
    }
    const content = choices[0]['message']['content'];
    if (typeof content !== 'string' || content.length < 1) throw new Error('model response content is empty');
    return content;
  }

  private async request(value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) throw new Error('typesetter request exceeds the configured bound');
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
      body,
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('typesetter model endpoint returned a non-success status');
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > this.maxResponseBytes) throw new Error('typesetter response exceeds the configured bound');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 2 || bytes.byteLength > this.maxResponseBytes) throw new Error('typesetter response size is invalid');
    const decoded = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    if (!plain(decoded)) throw new Error('typesetter response is not an object');
    return decoded;
  }
}
