import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';
import { HttpTypesetterTransport } from './http-transport.js';
import { OpenAiCompatibleTypesetterTransport } from './openai-compatible-transport.js';
import {
  BoundedTypesetterReviewer,
  DEFAULT_TYPESETTER_FILL_PROMPT,
  DEFAULT_TYPESETTER_RETURN_PROMPT,
  DEFAULT_TYPESETTER_REVIEW_PROMPT,
  DEFAULT_TYPESETTER_SELECT_PROMPT,
  TYPESETTER_CAPABILITY_SCHEMA,
  TYPESETTER_FILL_SCHEMA,
  TYPESETTER_RETURN_SCHEMA,
  TYPESETTER_SELECT_SCHEMA,
  type TypesetterReviewInput,
  type TypesetterReviewOutcome,
} from './reviewer.js';
import type { ProductionLayout } from '../production-catalog.js';
import type { EditorAddition, EditorSlot } from '../domain/genre-content.js';

interface StoredTypesetterSettings {
  schema_version: 2;
  adapter: TypesetterAdapter;
  enabled: boolean;
  endpoint: string;
  model: string;
  timeout_ms: number;
  commit_reserve_ms: number;
  select_prompt: string;
  fill_prompt: string;
  review_prompt: string;
  return_prompt: string;
}

export type TypesetterAdapter = 'openai-chat-completions' | 'ephemera-bridge';

export interface TypesetterSettingsSeed {
  enabled: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs: number;
  commitReserveMs: number;
}

export interface TypesetterSettingsView {
  enabled: boolean;
  adapter: TypesetterAdapter;
  endpoint: string;
  model: string;
  api_key_set: boolean;
  timeout_ms: number;
  commit_reserve_ms: number;
  select_prompt: string;
  fill_prompt: string;
  review_prompt: string;
  return_prompt: string;
  prompt_defaults: {
    select: string;
    fill: string;
    review: string;
    returned: string;
  };
}

export interface TypesetterConnectionTest {
  ok: boolean;
  vision: boolean;
  structured_output: boolean;
  max_images: number | null;
  message: string;
  tests: { text: boolean; structured: boolean; vision: boolean };
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BusinessError('invalid_input', '排版工 API 地址不是有效网址');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new BusinessError('invalid_input', '排版工 API 必须使用 HTTPS；本机地址可以使用 HTTP');
  }
}

/**
 * Owner-managed settings used by both the Console and the publication worker.
 * The API key is kept in a separate service-owned file and is never returned
 * from a read endpoint or copied into a publication snapshot.
 */
export class TypesetterSettingsStore {
  private readonly root: string;
  private readonly settingsPath: string;
  private readonly apiKeyPath: string;

  constructor(dataDir: string, private readonly seed: TypesetterSettingsSeed) {
    this.root = join(dataDir, 'settings', 'typesetter');
    this.settingsPath = join(this.root, 'settings.json');
    this.apiKeyPath = join(this.root, 'api-key.txt');
  }

  view(): TypesetterSettingsView {
    const current = this.read();
    return {
      enabled: current.enabled,
      adapter: current.adapter,
      endpoint: current.endpoint,
      model: current.model,
      api_key_set: this.readApiKey() !== null,
      timeout_ms: current.timeout_ms,
      commit_reserve_ms: current.commit_reserve_ms,
      select_prompt: current.select_prompt,
      fill_prompt: current.fill_prompt,
      review_prompt: current.review_prompt,
      return_prompt: current.return_prompt,
      prompt_defaults: {
        select: DEFAULT_TYPESETTER_SELECT_PROMPT,
        fill: DEFAULT_TYPESETTER_FILL_PROMPT,
        review: DEFAULT_TYPESETTER_REVIEW_PROMPT,
        returned: DEFAULT_TYPESETTER_RETURN_PROMPT,
      },
    };
  }

  isEnabled(): boolean {
    return this.read().enabled;
  }

  save(input: {
    enabled?: unknown;
    adapter?: unknown;
    endpoint?: unknown;
    model?: unknown;
    api_key?: unknown;
    timeout_ms?: unknown;
    commit_reserve_ms?: unknown;
    select_prompt?: unknown;
    fill_prompt?: unknown;
    review_prompt?: unknown;
    return_prompt?: unknown;
  }): TypesetterSettingsView {
    const previous = this.read();
    const enabled = input.enabled === undefined ? previous.enabled : input.enabled;
    const adapter = input.adapter === undefined ? previous.adapter : input.adapter;
    const endpoint = input.endpoint === undefined ? previous.endpoint : input.endpoint;
    const model = input.model === undefined ? previous.model : input.model;
    const timeoutMs = input.timeout_ms === undefined ? previous.timeout_ms : input.timeout_ms;
    const commitReserveMs = input.commit_reserve_ms === undefined ? previous.commit_reserve_ms : input.commit_reserve_ms;
    const selectPrompt = input.select_prompt === undefined ? previous.select_prompt : input.select_prompt;
    const fillPrompt = input.fill_prompt === undefined ? previous.fill_prompt : input.fill_prompt;
    const reviewPrompt = input.review_prompt === undefined ? previous.review_prompt : input.review_prompt;
    const returnPrompt = input.return_prompt === undefined ? previous.return_prompt : input.return_prompt;
    if (typeof enabled !== 'boolean' || (adapter !== 'openai-chat-completions' && adapter !== 'ephemera-bridge') ||
        typeof endpoint !== 'string' || endpoint.length > 2048 ||
        typeof model !== 'string' || Array.from(model).length > 256 ||
        !Number.isInteger(timeoutMs) || (timeoutMs as number) < 250 || (timeoutMs as number) > 60_000 ||
        !Number.isInteger(commitReserveMs) || (commitReserveMs as number) < 0 || (commitReserveMs as number) > 30_000 ||
        (commitReserveMs as number) >= (timeoutMs as number) ||
        !this.validPrompt(selectPrompt) || !this.validPrompt(fillPrompt) || !this.validPrompt(reviewPrompt) || !this.validPrompt(returnPrompt)) {
      throw new BusinessError('invalid_input', '排版工设置不完整或超出允许范围');
    }
    if (endpoint.length > 0) validateEndpoint(endpoint);

    let apiKey = this.readApiKey();
    if (input.api_key !== undefined) {
      if (input.api_key === null || input.api_key === '') {
        apiKey = null;
      } else if (typeof input.api_key === 'string' && input.api_key.length <= 8192) {
        apiKey = input.api_key;
      } else {
        throw new BusinessError('invalid_input', '排版工 API Key 无效');
      }
    }
    if (enabled && (endpoint.length === 0 || model.length === 0 || apiKey === null)) {
      throw new BusinessError('invalid_input', '启用逐稿审核前，需要填写 API 地址、模型和 API Key');
    }

    mkdirSync(this.root, { recursive: true });
    const stored: StoredTypesetterSettings = {
      schema_version: 2,
      adapter,
      enabled,
      endpoint,
      model,
      timeout_ms: timeoutMs as number,
      commit_reserve_ms: commitReserveMs as number,
      select_prompt: selectPrompt,
      fill_prompt: fillPrompt,
      review_prompt: reviewPrompt,
      return_prompt: returnPrompt,
    };
    const temporary = `${this.settingsPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(stored), { encoding: 'utf8', flag: 'w', mode: 0o600 });
    renameSync(temporary, this.settingsPath);
    this.writeApiKey(apiKey);
    return this.view();
  }

  async testConnection(): Promise<TypesetterConnectionTest> {
    const current = this.read();
    const apiKey = this.readApiKey();
    if (current.endpoint.length === 0 || current.model.length === 0 || apiKey === null) {
      throw new BusinessError('invalid_input', '请先保存 API 地址、模型和 API Key');
    }
    const transport = this.transport(current, apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), current.adapter === 'openai-chat-completions' ? current.timeout_ms * 3 : current.timeout_ms);
    try {
      if (transport instanceof OpenAiCompatibleTypesetterTransport) {
        const tests = await transport.testCapabilities(controller.signal);
        const ok = tests.text && tests.structured && tests.vision;
        const failed = [
          ...(tests.text ? [] : ['文字连接']),
          ...(tests.structured ? [] : ['结构化返回']),
          ...(tests.vision ? [] : ['图片输入']),
        ];
        return {
          ok,
          vision: tests.vision,
          structured_output: tests.structured,
          max_images: tests.vision ? 16 : null,
          tests,
          message: ok
            ? '三项测试都通过：可以读文字、按结构返回结果，并查看最终页图。'
            : `以下接口测试未通过：${failed.join('、')}。这可能是请求格式或测试图片不兼容，不等于模型本身没有这些能力。`,
        };
      }
      const capabilities = await transport.capabilities(controller.signal);
      const vision = plain(capabilities) && capabilities['vision'] === true;
      const structured = plain(capabilities) && capabilities['structured_output'] === true;
      const maxImages = plain(capabilities) && Number.isInteger(capabilities['max_images'])
        ? capabilities['max_images'] as number
        : null;
      const ok = plain(capabilities) && capabilities['schema'] === TYPESETTER_CAPABILITY_SCHEMA &&
        vision && structured && maxImages !== null && maxImages >= 1;
      return {
        ok,
        vision,
        structured_output: structured,
        max_images: maxImages,
        tests: { text: ok, structured, vision },
        message: ok ? '连接成功，可以接收页图并返回结构化审核结果。' : '服务已响应，但缺少页图或结构化审核能力。',
      };
    } catch {
      return {
        ok: false,
        vision: false,
        structured_output: false,
        max_images: null,
        tests: { text: false, structured: false, vision: false },
        message: '无法连接排版工服务，请检查地址、模型、密钥和网络。',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async review(input: TypesetterReviewInput): Promise<TypesetterReviewOutcome> {
    const current = this.read();
    const apiKey = this.readApiKey();
    if (!current.enabled || current.endpoint.length === 0 || current.model.length === 0 || apiKey === null) {
      throw new Error('typesetter review is not enabled');
    }
    const reviewer = new BoundedTypesetterReviewer(
      this.transport(current, apiKey),
      { maxDurationMs: current.timeout_ms, commitReserveMs: current.commit_reserve_ms },
    );
    return reviewer.review({ ...input, prompt: current.review_prompt });
  }

  async select(input: {
    manuscript: unknown;
    catalogRevision: string;
    candidates: ProductionLayout[];
    deadlineAt: string;
  }): Promise<{ kind: 'selected'; layoutId: string; reason: string } | { kind: 'technical_failure' }> {
    const current = this.read();
    const apiKey = this.readApiKey();
    if (!current.enabled || apiKey === null || current.endpoint.length === 0 || current.model.length === 0) {
      throw new Error('typesetter selection is not enabled');
    }
    const remaining = Date.parse(input.deadlineAt) - Date.now() - current.commit_reserve_ms;
    if (!Number.isFinite(remaining) || remaining <= 0) return { kind: 'technical_failure' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(current.timeout_ms, remaining));
    try {
      const transport = this.transport(current, apiKey);
      const response = await transport.select({
        schema: TYPESETTER_SELECT_SCHEMA,
        prompt: current.select_prompt,
        manuscript: input.manuscript,
        catalog_revision: input.catalogRevision,
        candidates: input.candidates.map((layout) => ({
          id: layout.id,
          genre: layout.genre,
          name_zh: layout.name_zh,
          purpose_zh: layout.purpose_zh,
          usage_recommendation_zh: layout.usage_recommendation_zh,
          trigger_recommendation_zh: layout.trigger_recommendation_zh,
          pagination: layout.pagination,
          trigger: layout.trigger,
          required_fact_fields: [...layout.required_fact_fields],
        })),
      }, controller.signal);
      if (!plain(response) || Object.keys(response).sort().join(',') !== 'layout_id,reason,schema' ||
          response['schema'] !== TYPESETTER_SELECT_SCHEMA || typeof response['layout_id'] !== 'string' ||
          typeof response['reason'] !== 'string' || Array.from(response['reason']).length > 300 ||
          !input.candidates.some((layout) => layout.id === response['layout_id'])) {
        return { kind: 'technical_failure' };
      }
      return { kind: 'selected', layoutId: response['layout_id'], reason: response['reason'] };
    } catch {
      return { kind: 'technical_failure' };
    } finally {
      clearTimeout(timer);
    }
  }

  async fill(input: {
    manuscript: unknown;
    layoutId: string;
    allowedSlots: readonly EditorSlot[];
    facts?: unknown;
    deadlineAt: string;
  }): Promise<{ kind: 'filled'; additions: EditorAddition[] } | { kind: 'technical_failure' }> {
    if (input.allowedSlots.length === 0) return { kind: 'filled', additions: [] };
    const current = this.read();
    const apiKey = this.readApiKey();
    if (!current.enabled || apiKey === null || current.endpoint.length === 0 || current.model.length === 0) {
      throw new Error('typesetter fill is not enabled');
    }
    const remaining = Date.parse(input.deadlineAt) - Date.now() - current.commit_reserve_ms;
    if (!Number.isFinite(remaining) || remaining <= 0) return { kind: 'technical_failure' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(current.timeout_ms, remaining));
    try {
      const transport = this.transport(current, apiKey);
      const response = await transport.fill({
        schema: TYPESETTER_FILL_SCHEMA,
        prompt: current.fill_prompt,
        manuscript: input.manuscript,
        layout_id: input.layoutId,
        allowed_slots: input.allowedSlots.map((slot) => ({ ...slot })),
        ...(input.facts === undefined ? {} : { facts: input.facts }),
      }, controller.signal);
      if (!plain(response) || Object.keys(response).sort().join(',') !== 'additions,schema' ||
          response['schema'] !== TYPESETTER_FILL_SCHEMA || !Array.isArray(response['additions'])) {
        return { kind: 'technical_failure' };
      }
      const allowed = new Set(input.allowedSlots.map((slot) => slot.path));
      const seen = new Set<string>();
      const additions: EditorAddition[] = [];
      for (const addition of response['additions']) {
        if (!plain(addition) || Object.keys(addition).sort().join(',') !== 'path,value' ||
            typeof addition['path'] !== 'string' || !allowed.has(addition['path']) || seen.has(addition['path']) ||
            typeof addition['value'] !== 'string' || addition['value'].length < 1 ||
            Array.from(addition['value']).length > 4_096) {
          return { kind: 'technical_failure' };
        }
        seen.add(addition['path']);
        additions.push({ path: addition['path'], value: addition['value'] });
      }
      return { kind: 'filled', additions };
    } catch {
      return { kind: 'technical_failure' };
    } finally {
      clearTimeout(timer);
    }
  }

  async returnFeedback(input: {
    layoutId: string;
    issues: Array<{ code: string; page_index: number | null; message: string }>;
    deadlineAt: string;
  }): Promise<string> {
    const fallback = input.issues.map((issue) =>
      `${issue.page_index === null ? '' : `第 ${issue.page_index + 1} 页：`}${issue.message}`,
    ).join('；').slice(0, 512) || '排版审核未通过，请调整内容后重新投稿。';
    const current = this.read();
    const apiKey = this.readApiKey();
    const remaining = Date.parse(input.deadlineAt) - Date.now() - current.commit_reserve_ms;
    if (!current.enabled || apiKey === null || !Number.isFinite(remaining) || remaining <= 0) return fallback;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(current.timeout_ms, remaining));
    try {
      const transport = this.transport(current, apiKey);
      const response = await transport.returnFeedback({
        schema: TYPESETTER_RETURN_SCHEMA,
        prompt: current.return_prompt,
        layout_id: input.layoutId,
        issues: input.issues,
      }, controller.signal);
      if (!plain(response) || Object.keys(response).sort().join(',') !== 'message,schema' ||
          response['schema'] !== TYPESETTER_RETURN_SCHEMA || typeof response['message'] !== 'string' ||
          response['message'].length < 1 || Array.from(response['message']).length > 512) return fallback;
      return response['message'];
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  private read(): StoredTypesetterSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        schema_version: 2,
        adapter: this.seed.enabled ? 'ephemera-bridge' : 'openai-chat-completions',
        enabled: this.seed.enabled,
        endpoint: this.seed.endpoint ?? '',
        model: this.seed.model ?? '',
        timeout_ms: this.seed.timeoutMs,
        commit_reserve_ms: this.seed.commitReserveMs,
        select_prompt: DEFAULT_TYPESETTER_SELECT_PROMPT,
        fill_prompt: DEFAULT_TYPESETTER_FILL_PROMPT,
        review_prompt: DEFAULT_TYPESETTER_REVIEW_PROMPT,
        return_prompt: DEFAULT_TYPESETTER_RETURN_PROMPT,
      };
    }
    try {
      const value = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as unknown;
      if (!plain(value) || (value['schema_version'] !== 1 && value['schema_version'] !== 2) || typeof value['enabled'] !== 'boolean' ||
          typeof value['endpoint'] !== 'string' || typeof value['model'] !== 'string' ||
          !Number.isInteger(value['timeout_ms']) || !Number.isInteger(value['commit_reserve_ms']) ||
          !this.validPrompt(value['select_prompt']) ||
          (value['fill_prompt'] !== undefined && !this.validPrompt(value['fill_prompt'])) || !this.validPrompt(value['review_prompt']) ||
          !this.validPrompt(value['return_prompt'])) {
        throw new Error('invalid settings');
      }
      const adapter = value['adapter'] === undefined ? 'ephemera-bridge' : value['adapter'];
      if (adapter !== 'openai-chat-completions' && adapter !== 'ephemera-bridge') throw new Error('invalid adapter');
      return {
        ...(value as unknown as Omit<StoredTypesetterSettings, 'schema_version' | 'fill_prompt'>),
        schema_version: 2,
        adapter,
        fill_prompt: typeof value['fill_prompt'] === 'string' ? value['fill_prompt'] : DEFAULT_TYPESETTER_FILL_PROMPT,
      };
    } catch {
      throw new BusinessError('storage_unavailable', '排版工设置无法读取', true);
    }
  }

  private validPrompt(value: unknown): value is string {
    return typeof value === 'string' && Array.from(value).length >= 20 && Array.from(value).length <= 12_000;
  }

  private transport(current: StoredTypesetterSettings, apiKey: string): HttpTypesetterTransport | OpenAiCompatibleTypesetterTransport {
    const options = { endpoint: current.endpoint, model: current.model, apiKey };
    return current.adapter === 'openai-chat-completions'
      ? new OpenAiCompatibleTypesetterTransport(options)
      : new HttpTypesetterTransport(options);
  }

  private readApiKey(): string | null {
    try {
      if (existsSync(this.apiKeyPath)) {
        const value = readFileSync(this.apiKeyPath, 'utf8').trim();
        return value.length === 0 ? null : value;
      }
      return this.seed.apiKey === undefined || this.seed.apiKey.length === 0 ? null : this.seed.apiKey;
    } catch {
      throw new BusinessError('storage_unavailable', '排版工密钥无法读取', true);
    }
  }

  private writeApiKey(value: string | null): void {
    if (value === null) {
      if (existsSync(this.apiKeyPath)) unlinkSync(this.apiKeyPath);
      return;
    }
    const temporary = `${this.apiKeyPath}.tmp`;
    writeFileSync(temporary, `${value}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    renameSync(temporary, this.apiKeyPath);
  }
}
