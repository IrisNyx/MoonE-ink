import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BusinessError } from '../errors.js';
import type { DeviceChannelService } from '../device/service.js';
import { DeviceApiError } from '../device/service.js';
import { AssetStore, relativePathFor } from '../jobs/assets.js';
import {
  history,
  publish,
  requestStatus,
  serviceInfo,
  withdraw,
  type ToolContext,
} from '../tools.js';
import {
  PRODUCTION_CATALOG_REVISION,
  ENABLED_PRODUCTION_LAYOUTS,
  PRODUCTION_LAYOUTS,
  PRODUCTION_RESOURCES_REVISION,
} from '../production-catalog.js';
import {
  CONSOLE_CSS,
  CONSOLE_HTML,
  CONSOLE_JS,
  CONSOLE_VIEWPORT_CSS,
  CONSOLE_VISIBILITY_CSS,
} from './console-assets.js';
import { DeviceInstallerAssets, esptoolBrowserBundle } from './device-installer.js';
import { INSTALLER_JS } from './installer-assets.js';
import type { OwnerAuthService, SessionIssue } from './auth.js';
import { PersonalizationStore } from './personalization.js';
import type { AuthorWorkView, HistoryItemWire } from '../domain/query.js';
import { LayoutPreviewStore } from './layout-previews.js';
import type { TypesetterSettingsStore } from '../typesetter/settings.js';
import type { WeatherSettingsStore } from '../weather/settings.js';
import { WEATHER_ICON_KINDS } from '../weather/types.js';
import { weatherIconDataUrl } from '../weather/icons.js';
import { MASCOT_MOODS, type MascotMood } from '../domain/mascot.js';
import { builtinMascotPngs } from '../render/branding.js';

interface ConsoleCaller {
  caller_id: string;
  device_routed: boolean;
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function bytes(res: ServerResponse, status: number, contentType: string, value: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(value.length),
    'cache-control': 'private, immutable, max-age=31536000',
    'x-content-type-options': 'nosniff',
  });
  res.end(value);
}

function error(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  json(res, status, { error: { code, message, retryable } }, status === 401 ? { 'www-authenticate': 'Bearer' } : {});
}

function businessError(res: ServerResponse, cause: BusinessError): void {
  const status = cause.code === 'not_found' ? 404
    : cause.code === 'instance_changed' || cause.code === 'idempotency_conflict' ? 409
    : cause.code === 'queue_full' ? 429
    : cause.code === 'render_overflow' || cause.code === 'unsupported_content_slot' || cause.code === 'unsupported_genre' || cause.code === 'author_content_mismatch' ? 422
    : cause.code === 'render_failed' || cause.code === 'asset_unavailable' || cause.code === 'storage_unavailable' ? 503
    : 400;
  error(res, status, cause.code, cause.message, cause.retryable);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > maxBytes) throw new Error('request body is too large');
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function sessionBody(issue: SessionIssue): Record<string, unknown> {
  return { ok: true, csrf_token: issue.csrf_token, expires_at: issue.expires_at };
}

function staticAsset(res: ServerResponse, contentType: string, bodyText: string): void {
  const body = Buffer.from(bodyText, 'utf8');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export class AdminHttpHandler {
  private readonly assets: AssetStore;
  private readonly personalization: PersonalizationStore;
  private readonly layoutPreviews: LayoutPreviewStore;
  private readonly callerIds: ReadonlySet<string>;
  private readonly installer = new DeviceInstallerAssets();

  constructor(
    private readonly auth: OwnerAuthService,
    private readonly toolContext: ToolContext,
    private readonly device: DeviceChannelService | undefined,
    private readonly callers: readonly ConsoleCaller[],
    private readonly maxBodyBytes: number,
    private readonly typesetterSettings: TypesetterSettingsStore,
    private readonly weatherSettings: WeatherSettingsStore,
    private readonly mcpCredential: { caller_id: string; bearer_token: string } | null,
    private readonly serverPort: number,
    private readonly deviceEndpointHint: string | null = null,
  ) {
    this.assets = new AssetStore(toolContext.store.dataDir);
    this.personalization = new PersonalizationStore(toolContext.store.dataDir);
    this.layoutPreviews = new LayoutPreviewStore(toolContext.store.dataDir, this.personalization);
    this.callerIds = new Set(callers.map((item) => item.caller_id));
    this.backfillPublicationArchives();
  }

  private archiveHistoryItem(item: HistoryItemWire, work: AuthorWorkView): void {
    if (this.assets.publicationArchiveExists(item.publication_id)) return;
    const pngPages = item.pages.flatMap((page) => {
      const png = page.assets.find((asset) => asset.kind === 'png' || asset.role === 'primary');
      return png === undefined ? [] : [{
        index: page.page_index,
        png: {
          sha256: png.sha256,
          kind: 'png' as const,
          mediaType: 'image/png',
          byteLength: png.bytes,
          relativePath: relativePathFor(png.sha256, 'png'),
        },
      }];
    });
    if (pngPages.length !== item.pages.length) return;
    this.assets.archivePublication({
      publicationId: item.publication_id,
      manuscript: work,
      body: work.body,
      pages: pngPages,
    });
  }

  private backfillPublicationArchives(): void {
    for (const caller of this.callers) {
      try {
        const page = history(this.toolContext, caller.caller_id, {
          expected_instance_id: this.toolContext.store.instanceId,
          limit: 100,
        });
        const works = this.toolContext.query.authorPeek(caller.caller_id, { scope: 'recent', limit: 100 }).items;
        const byReference = new Map(works.map((work) => [work.reference, work]));
        for (const item of page.items) {
          const work = byReference.get(item.publication_id);
          if (work !== undefined) this.archiveHistoryItem(item, work);
        }
      } catch {
        // A missing convenience copy must not prevent the canonical service
        // from starting; opening 投稿浏览 retries the same backfill.
      }
    }
  }

  private caller(value: unknown): string {
    if (typeof value !== 'string' || !this.callerIds.has(value)) {
      throw new BusinessError('invalid_input', 'caller_id is not an active Console publishing identity');
    }
    return value;
  }

  private requireRead(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.auth.authenticate(req.headers.cookie)) {
      error(res, 401, 'unauthorized', 'owner session is required');
      return false;
    }
    return true;
  }

  private requireWrite(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.auth.authenticateWrite(
      req.headers.cookie,
      typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
    )) {
      error(res, 403, 'csrf_rejected', 'owner session and CSRF token are required');
      return false;
    }
    return true;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (path === '/console' || path === '/console/') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      const body = Buffer.from(CONSOLE_HTML, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }
    if (path === '/console/app.js') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      staticAsset(res, 'text/javascript; charset=utf-8', CONSOLE_JS);
      return;
    }
    if (path === '/console/styles.css') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      staticAsset(
        res,
        'text/css; charset=utf-8',
        `${CONSOLE_CSS}${CONSOLE_VISIBILITY_CSS}${CONSOLE_VIEWPORT_CSS}`,
      );
      return;
    }
    if (path === '/console/installer.js') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      staticAsset(res, 'text/javascript; charset=utf-8', INSTALLER_JS);
      return;
    }
    if (path === '/console/esptool.js') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      bytes(res, 200, 'text/javascript; charset=utf-8', esptoolBrowserBundle());
      return;
    }
    const weatherIcon = /^\/console\/weather-icons\/([a-z-]+)\.svg$/.exec(path);
    if (weatherIcon !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      const kind = weatherIcon[1]!;
      if (!(WEATHER_ICON_KINDS as readonly string[]).includes(kind)) {
        return error(res, 404, 'not_found', 'weather icon not found');
      }
      const dataUrl = weatherIconDataUrl(kind as (typeof WEATHER_ICON_KINDS)[number]);
      bytes(res, 200, 'image/svg+xml; charset=utf-8', Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      return;
    }

    if (path === '/admin/v1/bootstrap/status') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!isLoopback(req)) return error(res, 403, 'local_only', 'owner initialization is local-only');
      const status = this.auth.bootstrapStatus();
      json(res, 200, {
        initialized: status.initialized,
        bootstrap_available: status.bootstrap_available,
        csrf_token: status.csrf_token,
      }, { 'set-cookie': status.csrf_cookie });
      return;
    }
    if (path === '/admin/v1/bootstrap') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!isLoopback(req)) return error(res, 403, 'local_only', 'owner initialization is local-only');
      try {
        const body = await readJson(req, 32_768);
        if (!exactKeys(body, ['owner_token'])) throw new Error('unknown field');
        const issue = this.auth.bootstrap(
          req.headers.authorization,
          req.headers.cookie,
          typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
          body['owner_token'],
        );
        json(res, 201, sessionBody(issue), { 'set-cookie': this.auth.sessionCookie(issue) });
      } catch {
        error(res, 401, 'bootstrap_rejected', 'owner initialization was rejected');
      }
      return;
    }
    if (path === '/admin/v1/login') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!isLoopback(req)) return error(res, 403, 'local_only', 'owner login is local-only until TLS remote management is enabled');
      try {
        const body = await readJson(req, 32_768);
        if (!exactKeys(body, ['owner_token'])) throw new Error('unknown field');
        const issue = this.auth.login(
          req.headers.cookie,
          typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
          body['owner_token'],
        );
        json(res, 200, sessionBody(issue), { 'set-cookie': this.auth.sessionCookie(issue) });
      } catch {
        error(res, 401, 'login_rejected', 'owner login was rejected');
      }
      return;
    }
    if (path === '/admin/v1/session') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      const session = this.auth.sessionInfo(req.headers.cookie);
      if (session === null) return error(res, 401, 'unauthorized', 'owner session is required');
      json(res, 200, {
        authenticated: true,
        instance_id: this.toolContext.store.instanceId,
        device_channel: this.device !== undefined,
        owner_bearer_managed: this.auth.managedByConfiguration(),
        csrf_token: session.csrf_token,
        expires_at: session.expires_at,
      });
      return;
    }
    if (path === '/admin/v1/logout') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      this.auth.logout(req.headers.cookie);
      json(res, 200, { ok: true }, { 'set-cookie': this.auth.clearSessionCookie() });
      return;
    }
    if (path === '/admin/v1/owner/rotate') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      try {
        const body = await readJson(req, 32_768);
        if (!exactKeys(body, ['current_owner_token', 'new_owner_token'])) throw new Error('unknown field');
        const issue = this.auth.rotate(
          req.headers.cookie,
          typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
          body['current_owner_token'],
          body['new_owner_token'],
        );
        json(res, 200, sessionBody(issue), { 'set-cookie': this.auth.sessionCookie(issue) });
      } catch {
        error(res, 403, 'rotation_rejected', 'owner credential rotation was rejected');
      }
      return;
    }

    if (path === '/admin/v1/console/overview') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      json(res, 200, {
        service: serviceInfo(this.toolContext),
        catalog: {
          revision: PRODUCTION_CATALOG_REVISION,
          resources_revision: PRODUCTION_RESOURCES_REVISION,
          enabled_layouts: ENABLED_PRODUCTION_LAYOUTS,
        },
        callers: this.callers,
        author_views: this.callers.map((caller) => ({
          caller_id: caller.caller_id,
          ...this.toolContext.query.authorPeek(caller.caller_id, { scope: 'overview', limit: 5 }),
        })),
        recent_failures: this.toolContext.publication.adminRecentFailures?.(10) ?? [],
        device: this.device === undefined
          ? { enabled: false, channel_id: null, endpoint_hint: null }
          : { enabled: true, channel_id: this.device.channelId, endpoint_hint: this.deviceEndpointHint },
      });
      return;
    }
    if (path === '/admin/v1/console/layouts') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      json(res, 200, {
        revision: PRODUCTION_CATALOG_REVISION,
        builtin_layouts: PRODUCTION_LAYOUTS.map((layout) => ({
          ...layout,
          preview_url: `/admin/v1/console/layouts/${layout.id}/preview.png`,
        })),
        custom_layouts: [],
        custom_display_interface: {
          schema: 'ephemera-custom-layout-display-v1',
          fields: ['id', 'name_zh', 'purpose_zh', 'usage_recommendation_zh', 'trigger_recommendation_zh', 'preview_url'],
          editor_available: false,
        },
      });
      return;
    }
    const layoutPreview = /^\/admin\/v1\/console\/layouts\/([a-z0-9-]{1,80})\/preview\.png$/.exec(path);
    if (layoutPreview !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      try {
        const content = await this.layoutPreviews.preview(layoutPreview[1]!);
        if (content === null) return error(res, 404, 'not_found', 'layout preview is unavailable');
        bytes(res, 200, 'image/png', content);
      } catch {
        error(res, 503, 'preview_unavailable', '版式预览暂时无法生成，请检查排版运行环境', true);
      }
      return;
    }
    if (path === '/admin/v1/console/typesetter') {
      if (req.method === 'GET') {
        if (!this.requireRead(req, res)) return;
        json(res, 200, this.typesetterSettings.view());
        return;
      }
      if (req.method === 'POST') {
        if (!this.requireWrite(req, res)) return;
        try {
          const body = await readJson(req, 128 * 1024);
          if (!exactKeys(body, [
            'enabled', 'adapter', 'endpoint', 'model', 'api_key', 'timeout_ms', 'commit_reserve_ms',
            'select_prompt', 'fill_prompt', 'review_prompt', 'return_prompt',
          ])) throw new BusinessError('invalid_input', '排版工设置包含未知字段');
          json(res, 200, this.typesetterSettings.save(body));
        } catch (cause) {
          if (cause instanceof BusinessError) return businessError(res, cause);
          error(res, 400, 'invalid_input', '排版工设置保存失败');
        }
        return;
      }
      return error(res, 405, 'method_not_allowed', 'method must be GET or POST');
    }
    if (path === '/admin/v1/console/typesetter/test') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      try {
        json(res, 200, await this.typesetterSettings.testConnection());
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        error(res, 503, 'typesetter_unavailable', '排版工连接测试失败', true);
      }
      return;
    }
    if (path === '/admin/v1/console/weather') {
      if (req.method === 'GET') {
        if (!this.requireRead(req, res)) return;
        json(res, 200, this.weatherSettings.view());
        return;
      }
      if (req.method === 'POST') {
        if (!this.requireWrite(req, res)) return;
        try {
          const body = await readJson(req, 64 * 1024);
          if (!exactKeys(body, ['enabled', 'api_host', 'api_key', 'location'])) {
            throw new BusinessError('invalid_input', '天气设置包含未知字段');
          }
          json(res, 200, this.weatherSettings.save(body));
        } catch (cause) {
          if (cause instanceof BusinessError) return businessError(res, cause);
          error(res, 400, 'invalid_input', '天气设置保存失败');
        }
        return;
      }
      return error(res, 405, 'method_not_allowed', 'method must be GET or POST');
    }
    if (path === '/admin/v1/console/weather/search') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      try {
        const body = await readJson(req, 32 * 1024);
        if (!exactKeys(body, ['query', 'api_host', 'api_key']) || typeof body['query'] !== 'string') {
          throw new BusinessError('invalid_input', '地点搜索参数不正确');
        }
        json(res, 200, {
          locations: await this.weatherSettings.search(body['query'], {
            api_host: body['api_host'],
            api_key: body['api_key'],
          }),
        });
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        error(res, 503, 'asset_unavailable', '地点搜索失败', true);
      }
      return;
    }
    if (path === '/admin/v1/console/weather/refresh') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      try {
        json(res, 200, { snapshot: await this.weatherSettings.refresh(), settings: this.weatherSettings.view() });
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        error(res, 503, 'asset_unavailable', '天气获取失败', true);
      }
      return;
    }
    if (path === '/admin/v1/console/mcp-config') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      const host = typeof req.headers.host === 'string' ? req.headers.host : `127.0.0.1:${this.serverPort}`;
      let port = String(this.serverPort);
      try { port = new URL(`http://${host}`).port || '80'; } catch { /* validated Host normally reaches here */ }
      const endpoints: Array<{ kind: 'local' | 'lan' | 'public'; label: string; url: string; recommendation: string }> = [{
        kind: 'local',
        label: '本机端点',
        url: `http://127.0.0.1:${port}/mcp`,
        recommendation: '作者模型和 MoonE-ink 服务运行在同一台电脑时使用。',
      }];
      try {
        const current = new URL(`http://${host}/mcp`);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(current.hostname)) {
          endpoints.push({ kind: 'lan', label: '局域网端点', url: current.toString(), recommendation: '同一局域网内的另一台设备使用；不能当作公网地址。' });
        }
      } catch { /* the stable local endpoint above remains available */ }
      if (this.deviceEndpointHint !== null) {
        const external = new URL('/mcp', `${this.deviceEndpointHint.replace(/\/+$/, '')}/`).toString();
        if (!endpoints.some((item) => item.url === external)) {
          const parsed = new URL(external);
          const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ||
            /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
          endpoints.push({
            kind: local ? 'lan' : 'public',
            label: local ? '局域网端点' : '公网端点',
            url: external,
            recommendation: local ? '同一局域网内使用。' : '远程作者模型使用；应配置 HTTPS 和反向代理。',
          });
        }
      }
      json(res, 200, {
        transport: 'streamable-http',
        endpoints,
        caller_id: this.mcpCredential?.caller_id ?? this.callers.find((caller) => caller.device_routed)?.caller_id ?? null,
        bearer_token: this.mcpCredential?.bearer_token ?? null,
        bearer_available: this.mcpCredential !== null,
        author_tools: ['ephemera_publish', 'ephemera_peek'],
      });
      return;
    }
    if (path === '/admin/v1/device-installer/manifest') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      json(res, 200, this.installer.publicManifest());
      return;
    }
    const installerFile = /^\/admin\/v1\/device-installer\/files\/(bootloader|partitions|firmware)\.bin$/.exec(path);
    if (installerFile !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      try {
        bytes(res, 200, 'application/octet-stream', this.installer.readVerified(`${installerFile[1]}.bin`));
      } catch {
        error(res, 503, 'installer_unavailable', 'verified device installer is unavailable', true);
      }
      return;
    }
    if (path === '/admin/v1/console/personalization') {
      if (req.method === 'GET') {
        if (!this.requireRead(req, res)) return;
        json(res, 200, this.personalization.view());
        return;
      }
      if (req.method === 'POST') {
        if (!this.requireWrite(req, res)) return;
        try {
          const body = await readJson(req, 16 * 1024 * 1024);
          if (!exactKeys(body, ['signatures', 'signature_slots', 'logo_primary', 'logo_secondary', 'logo_fox', 'mascot_states'])) {
            throw new BusinessError('invalid_input', 'personalization request contains an unknown field');
          }
          json(res, 200, this.personalization.save({
            ...(Object.hasOwn(body, 'signatures') ? { signatures: body['signatures'] } : {}),
            ...(Object.hasOwn(body, 'signature_slots') ? { signature_slots: body['signature_slots'] } : {}),
            ...(Object.hasOwn(body, 'logo_primary') ? { logo_primary: body['logo_primary'] } : {}),
            ...(Object.hasOwn(body, 'logo_secondary') ? { logo_secondary: body['logo_secondary'] } : {}),
            ...(Object.hasOwn(body, 'logo_fox') ? { logo_fox: body['logo_fox'] } : {}),
            ...(Object.hasOwn(body, 'mascot_states') ? { mascot_states: body['mascot_states'] } : {}),
          }));
        } catch (cause) {
          if (cause instanceof BusinessError) return businessError(res, cause);
          return error(res, 400, 'invalid_input', 'personalization request was rejected');
        }
        return;
      }
      return error(res, 405, 'method_not_allowed', 'method must be GET or POST');
    }
    const personalizationLogo = /^\/admin\/v1\/console\/personalization\/(logo-primary|logo-secondary|logo-fox|mascot-(?:normal|happy|sad|thinking|sleepy))\.png$/.exec(path);
    if (personalizationLogo !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      const content = this.personalization.logo(`${personalizationLogo[1]}.png` as Parameters<PersonalizationStore['logo']>[0]);
      if (content === null) return error(res, 404, 'not_found', 'logo is not configured');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(content.length), 'cache-control': 'no-store' });
      res.end(content);
      return;
    }
    const builtinMascot = /^\/admin\/v1\/console\/personalization\/builtin-mascot-(normal|happy|sad|thinking|sleepy)\.png$/.exec(path);
    if (builtinMascot !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      const mood = builtinMascot[1] as MascotMood;
      if (!(MASCOT_MOODS as readonly string[]).includes(mood)) return error(res, 404, 'not_found', 'mascot state is unavailable');
      const content = builtinMascotPngs()[mood];
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(content.length), 'cache-control': 'private, max-age=3600' });
      res.end(content);
      return;
    }
    if (path === '/admin/v1/console/logs') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      json(res, 200, {
        failures: this.toolContext.publication.adminRecentFailures?.(50) ?? [],
        device_events: this.device?.adminStatus().recent_events ?? [],
      });
      return;
    }
    if (path === '/admin/v1/console/history') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      try {
        const callerId = this.caller(url.searchParams.get('caller_id'));
        const limitText = url.searchParams.get('limit');
        const cursor = url.searchParams.get('cursor');
        const page = history(this.toolContext, callerId, {
          expected_instance_id: this.toolContext.store.instanceId,
          ...(limitText === null ? {} : { limit: Number(limitText) }),
          ...(cursor === null ? {} : { cursor }),
        });
        const works = this.toolContext.query.authorPeek(callerId, { scope: 'recent', limit: 100 }).items;
        const byReference = new Map(works.map((work) => [work.reference, work]));
        const items = page.items.map((item) => {
          const work = byReference.get(item.publication_id) ?? null;
          const provenance = this.toolContext.publication.adminPublicationText?.(item.publication_id, callerId) ?? null;
          return {
            ...item,
            work,
            finished: work === null ? null : {
              text: [work.body, ...(provenance?.editor_additions ?? []).map((addition) => addition.value)].join('\n'),
              editor_additions: provenance?.editor_additions ?? [],
            },
          };
        });
        for (const item of items) {
          if (item.work === null || this.assets.publicationArchiveExists(item.publication_id)) continue;
          try {
            this.archiveHistoryItem(item, item.work);
          } catch {
            // The canonical record and browser preview remain available; a
            // later visit retries creation of the human-readable archive.
          }
        }
        json(res, 200, { ...page, items });
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        return error(res, 400, 'invalid_input', 'history request was rejected');
      }
      return;
    }
    if (path === '/admin/v1/console/status') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      try {
        const callerId = this.caller(url.searchParams.get('caller_id'));
        const requestId = url.searchParams.get('request_id');
        if (requestId === null) throw new BusinessError('invalid_input', 'request_id is required');
        json(res, 200, await requestStatus(this.toolContext, callerId, {
          expected_instance_id: this.toolContext.store.instanceId,
          request_id: requestId,
        }));
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        return error(res, 400, 'invalid_input', 'status request was rejected');
      }
      return;
    }
    if (path === '/admin/v1/console/publish') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      try {
        const body = await readJson(req, this.maxBodyBytes);
        if (!exactKeys(body, ['caller_id', 'request_id', 'title', 'body', 'signature', 'layout_variant'])) {
          throw new BusinessError('invalid_input', 'publish request contains an unknown field');
        }
        const callerId = this.caller(body['caller_id']);
        const text = body['body'];
        const title = body['title'];
        const signature = body['signature'];
        const layoutVariant = body['layout_variant'];
        if (typeof text !== 'string' || typeof title !== 'string' || typeof signature !== 'string' ||
            layoutVariant !== 'note-portrait-v4' ||
            typeof body['request_id'] !== 'string') {
          throw new BusinessError('invalid_input', 'publish fields have invalid types');
        }
        const manuscript = {
          schemaVersion: 2,
          intent: 'note',
          body: text,
          ...(title.length === 0 ? {} : { title }),
          ...(signature.length === 0 ? {} : { signature }),
          genrePreference: 'note',
          genrePreferenceMode: 'strict',
          layoutVariant,
          delivery: {
            persistence: 'keep',
            presentation: 'ambient',
            interruption: 'when-idle',
            preferredMedium: 'ephemera',
          },
        };
        json(res, 200, await publish(this.toolContext, callerId, {
          expected_instance_id: this.toolContext.store.instanceId,
          request_id: body['request_id'],
          manuscript,
          contract_version: 'terminal-v1',
        }));
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        return error(res, 400, 'invalid_input', 'publish request was rejected');
      }
      return;
    }
    if (path === '/admin/v1/console/withdraw') {
      if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
      if (!this.requireWrite(req, res)) return;
      try {
        const body = await readJson(req, 32_768);
        if (!exactKeys(body, ['caller_id', 'request_id', 'publication_id']) ||
            typeof body['request_id'] !== 'string' || typeof body['publication_id'] !== 'string') {
          throw new BusinessError('invalid_input', 'withdraw request is invalid');
        }
        json(res, 200, withdraw(this.toolContext, this.caller(body['caller_id']), {
          expected_instance_id: this.toolContext.store.instanceId,
          request_id: body['request_id'],
          publication_id: body['publication_id'],
        }));
      } catch (cause) {
        if (cause instanceof BusinessError) return businessError(res, cause);
        return error(res, 400, 'invalid_input', 'withdraw request was rejected');
      }
      return;
    }
    const preview = /^\/admin\/v1\/console\/assets\/([0-9a-f]{64})\.png$/.exec(path);
    if (preview !== null) {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      try {
        const digest = preview[1]!;
        const content = this.assets.readFinal(relativePathFor(digest, 'png'));
        if (createHash('sha256').update(content).digest('hex') !== digest) {
          return error(res, 503, 'asset_unavailable', 'preview asset failed integrity verification', true);
        }
        bytes(res, 200, 'image/png', content);
      } catch {
        return error(res, 404, 'not_found', 'preview asset is unavailable');
      }
      return;
    }
    if (path === '/admin/v1/device-status') {
      if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'method must be GET');
      if (!this.requireRead(req, res)) return;
      if (this.device === undefined) return error(res, 409, 'device_channel_disabled', 'device channel is not enabled');
      try {
        json(res, 200, this.device.adminStatus());
      } catch {
        error(res, 503, 'storage_unavailable', 'device status is unavailable', true);
      }
      return;
    }

    const legacyOwner = this.device?.authenticateOwner(req.headers.authorization) === true;
    const sessionOwner = this.auth.authenticateWrite(
      req.headers.cookie,
      typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
    );
    if (!legacyOwner && !sessionOwner) return error(res, 401, 'unauthorized', 'owner authorization is required');
    if (this.device === undefined) return error(res, 409, 'device_channel_disabled', 'device channel is not enabled');

    try {
      if (path === '/admin/v1/pairings') {
        if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'method must be POST');
        json(res, 201, this.device.createPairing(await readJson(req, 32_768)));
        return;
      }
      const revoke = /^\/admin\/v1\/device-bindings\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
      if (revoke !== null) {
        if (req.method !== 'DELETE') return error(res, 405, 'method_not_allowed', 'method must be DELETE');
        json(res, 200, this.device.revokeBinding(revoke[1]!));
        return;
      }
    } catch (cause) {
      if (cause instanceof DeviceApiError) return error(res, cause.status, cause.code, cause.message, cause.retryable);
      return error(res, 400, 'invalid_input', 'request was rejected');
    }
    error(res, 404, 'not_found', 'admin route not found');
  }
}
