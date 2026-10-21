import {
  TYPESETTER_FILL_SCHEMA,
  TYPESETTER_RETURN_SCHEMA,
  TYPESETTER_SELECT_SCHEMA,
  type TypesetterTransport,
} from './reviewer.js';

export interface HttpTypesetterTransportOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

/**
 * Small provider-neutral HTTP boundary for an Ephemera review bridge. It
 * never logs URLs, credentials, manuscripts, images or response bodies.
 * Saving configuration constructs nothing and performs no request; callers
 * explicitly invoke capabilities/review (or a future admin connection test).
 */
export class HttpTypesetterTransport implements TypesetterTransport {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpTypesetterTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxRequestBytes = options.maxRequestBytes ?? 24 * 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    if (this.endpoint.length === 0 || this.model.length === 0 || this.apiKey.length === 0) {
      throw new Error('typesetter HTTP transport configuration is incomplete');
    }
  }

  async capabilities(signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/capabilities?model=${encodeURIComponent(this.model)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    return this.readJson(response);
  }

  async review(request: Parameters<TypesetterTransport['review']>[0], signal: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({ ...request, model: this.model });
    if (Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) {
      throw new Error('typesetter request exceeds the configured bound');
    }
    const response = await fetch(`${this.endpoint}/review`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body,
      signal,
      redirect: 'error',
    });
    return this.readJson(response);
  }

  async select(request: {
    schema: typeof TYPESETTER_SELECT_SCHEMA;
    prompt: string;
    manuscript: unknown;
    catalog_revision: string;
    candidates: unknown[];
  }, signal: AbortSignal): Promise<unknown> {
    return this.postJson('/select', { ...request, model: this.model }, signal);
  }

  async fill(request: {
    schema: typeof TYPESETTER_FILL_SCHEMA;
    prompt: string;
    manuscript: unknown;
    layout_id: string;
    allowed_slots: Array<{ path: string; description_zh: string }>;
    facts?: unknown;
  }, signal: AbortSignal): Promise<unknown> {
    return this.postJson('/fill', { ...request, model: this.model }, signal);
  }

  async returnFeedback(request: {
    schema: typeof TYPESETTER_RETURN_SCHEMA;
    prompt: string;
    layout_id: string;
    issues: Array<{ code: string; page_index: number | null; message: string }>;
  }, signal: AbortSignal): Promise<unknown> {
    return this.postJson('/return', { ...request, model: this.model }, signal);
  }

  private async postJson(path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) {
      throw new Error('typesetter request exceeds the configured bound');
    }
    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body,
      signal,
      redirect: 'error',
    });
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw new Error('typesetter endpoint returned a non-success status');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > this.maxResponseBytes) {
      throw new Error('typesetter response exceeds the configured bound');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 2 || bytes.byteLength > this.maxResponseBytes) {
      throw new Error('typesetter response size is invalid');
    }
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new Error('typesetter response is not valid JSON');
    }
  }
}
