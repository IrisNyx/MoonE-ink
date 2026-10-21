import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceChannelService } from './service.js';
import { DeviceApiError } from './service.js';

const MAX_SCREEN_WAIT_MS = 30_000;

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: DeviceApiError): void {
  sendJson(
    res,
    error.status,
    { error: { code: error.code, message: error.message, retryable: error.retryable } },
    error.status === 401 ? { 'www-authenticate': 'Bearer' } : {},
  );
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) throw new DeviceApiError(413, 'invalid_input', 'request body exceeds the configured limit');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DeviceApiError(400, 'invalid_input', 'request body is not valid JSON');
  }
}

interface AttemptBucket { started: number; count: number }

export class DeviceHttpHandler {
  private readonly pairingAttempts = new Map<string, AttemptBucket>();

  constructor(private readonly service: DeviceChannelService) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      await this.handleInner(req, res, url);
    } catch (error) {
      if (error instanceof DeviceApiError) {
        sendError(res, error);
        return;
      }
      sendError(res, new DeviceApiError(500, 'storage_unavailable', 'device channel is unavailable', true));
    }
  }

  private requireMethod(req: IncomingMessage, expected: string): void {
    if (req.method !== expected) throw new DeviceApiError(405, 'method_not_allowed', `method must be ${expected}`);
  }

  private owner(req: IncomingMessage): void {
    if (!this.service.authenticateOwner(req.headers.authorization)) throw new DeviceApiError(401, 'unauthorized', 'owner credential is required');
  }

  private rateLimitPair(req: IncomingMessage): void {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const existing = this.pairingAttempts.get(key);
    if (existing === undefined || now - existing.started >= 15 * 60 * 1000) {
      this.pairingAttempts.set(key, { started: now, count: 1 });
      return;
    }
    existing.count += 1;
    if (existing.count > 20) throw new DeviceApiError(429, 'rate_limited', 'too many pairing attempts', true);
  }

  private async waitForScreen(req: IncomingMessage, binding: ReturnType<DeviceChannelService['authenticateDevice']>,
                              afterRevision: number, afterLibraryRevision: number, waitMs: number,
                              includeLibrary: boolean, selectedPublicationId: string | null): Promise<Record<string, unknown>> {
    const deadline = Date.now() + waitMs;
    let response = this.service.screen(binding, includeLibrary, selectedPublicationId);
    const unchanged = () => Number(response['revision']) <= afterRevision &&
      (!includeLibrary || Number((response['library'] as Record<string, unknown>)?.['revision']) <= afterLibraryRevision);
    while (!req.destroyed && unchanged() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      response = this.service.screen(binding, includeLibrary, selectedPublicationId);
    }
    return response;
  }

  private async handleInner(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (path === '/admin/v1/pairings') {
      this.requireMethod(req, 'POST');
      this.owner(req);
      sendJson(res, 201, this.service.createPairing(await readJson(req, 32768)));
      return;
    }
    const revoke = /^\/admin\/v1\/device-bindings\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
    if (revoke !== null) {
      this.requireMethod(req, 'DELETE');
      this.owner(req);
      sendJson(res, 200, this.service.revokeBinding(revoke[1]!));
      return;
    }
    if (path === '/device/v1/pair') {
      this.requireMethod(req, 'POST');
      this.rateLimitPair(req);
      sendJson(res, 200, this.service.pair(await readJson(req, 65536)));
      return;
    }
    const binding = this.service.authenticateDevice(req.headers.authorization);
    if (path === '/device/v1/screen') {
      this.requireMethod(req, 'GET');
      const afterRaw = url.searchParams.get('after_revision');
      const waitRaw = url.searchParams.get('wait_ms');
      const includeLibrary = url.searchParams.get('include_library') === '1';
      const afterLibraryRaw = url.searchParams.get('after_library_revision');
      const selectedPublicationId = url.searchParams.get('read_status_for');
      const afterRevision = afterRaw === null ? -1 : Number(afterRaw);
      const afterLibraryRevision = afterLibraryRaw === null ? -1 : Number(afterLibraryRaw);
      const waitMs = waitRaw === null ? 0 : Number(waitRaw);
      if (!Number.isSafeInteger(afterRevision) || afterRevision < -1 ||
          !Number.isSafeInteger(afterLibraryRevision) || afterLibraryRevision < -1 ||
          !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_SCREEN_WAIT_MS) {
        throw new DeviceApiError(400, 'invalid_input', 'screen wait parameters are invalid');
      }
      if (!includeLibrary && (afterLibraryRaw !== null || selectedPublicationId !== null)) {
        throw new DeviceApiError(400, 'invalid_input', 'library parameters require include_library=1');
      }
      const response = waitMs > 0 && afterRevision >= 0
        ? await this.waitForScreen(req, binding, afterRevision, afterLibraryRevision, waitMs, includeLibrary, selectedPublicationId)
        : this.service.screen(binding, includeLibrary, selectedPublicationId);
      if (req.destroyed) return;
      const etag = this.service.etag(binding, response);
      const headers = { etag, date: new Date().toUTCString(), 'cache-control': 'private, no-cache' };
      const offerUnchanged = Number(response['revision']) <= afterRevision;
      const libraryUnchanged = !includeLibrary ||
        Number((response['library'] as Record<string, unknown>)?.['revision']) <= afterLibraryRevision;
      if ((offerUnchanged && libraryUnchanged) || req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
      } else {
        sendJson(res, 200, response, headers);
      }
      return;
    }
    if (path === '/device/v1/history') {
      this.requireMethod(req, 'GET');
      sendJson(res, 200, this.service.history(
        binding,
        url.searchParams.get('cursor'),
        url.searchParams.get('limit'),
        url.searchParams.get('include_library') === '1',
        url.searchParams.get('filter'),
      ));
      return;
    }
    const pages = /^\/device\/v1\/publications\/([A-Za-z0-9._:-]{1,128})\/pages$/.exec(path);
    if (pages !== null) {
      this.requireMethod(req, 'GET');
      sendJson(res, 200, this.service.pages(
        binding,
        pages[1]!,
        url.searchParams.get('profile'),
        url.searchParams.get('edition_id'),
        url.searchParams.get('include_library') === '1',
      ));
      return;
    }
    const asset = /^\/device\/v1\/assets\/([0-9a-f]{64})\.bin$/.exec(path);
    if (asset !== null) {
      this.requireMethod(req, 'GET');
      const record = this.service.asset(binding, asset[1]!);
      let bytes: Buffer;
      try {
        bytes = readFileSync(record.path);
      } catch {
        throw new DeviceApiError(503, 'asset_unavailable', 'asset bytes are unavailable', true);
      }
      if (bytes.length !== record.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset[1]) {
        throw new DeviceApiError(503, 'asset_unavailable', 'asset failed integrity verification', true);
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'cache-control': 'private, immutable, max-age=31536000',
      });
      res.end(bytes);
      return;
    }
    if (path === '/device/v1/event') {
      this.requireMethod(req, 'POST');
      sendJson(res, 200, this.service.event(binding, await readJson(req, binding.limits.max_event_body_bytes)));
      return;
    }
    throw new DeviceApiError(404, 'not_found', 'device route not found');
  }
}
