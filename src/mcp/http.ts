import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CredentialStore } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import { isHostAllowed, isOriginAllowed } from '../netguard.js';
import type { ToolContext } from '../tools.js';
import { buildAuthorMcpServer } from './author-server.js';
import { buildMcpServer } from './server.js';
import { DeviceHttpHandler } from '../device/http.js';
import type { DeviceChannelService } from '../device/service.js';
import { AdminHttpHandler } from '../admin/http.js';
import type { OwnerAuthService } from '../admin/auth.js';
import type { TypesetterSettingsStore } from '../typesetter/settings.js';
import { WeatherSettingsStore } from '../weather/settings.js';

function sendError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

interface HttpServiceDeps {
  config: ResolvedConfig;
  credentials: CredentialStore;
  /** Fully wired tool context (store, acceptance, publication, capability). */
  toolContext: ToolContext;
  deviceChannel?: DeviceChannelService;
  ownerAuth?: OwnerAuthService;
  typesetterSettings: TypesetterSettingsStore;
  weatherSettings?: WeatherSettingsStore;
  log: {
    debug(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  };
}

/**
 * Standalone HTTP front for the MCP service.
 *
 * `/mcp` is served by the official v2 SDK composition: one
 * `createMcpHandler` whose per-request factory builds the tool server for
 * both eras —
 *  - modern (2026-07-28): per-request `_meta` envelope, `server/discover`
 *    negotiation, version selection handled by the SDK's modern leg;
 *  - legacy stateless (2025-11-25 / 2025-03-26): the SDK's built-in
 *    stateless legacy fallback answers each request with a fresh instance
 *    over a session-less streamable HTTP transport (initialize is answered
 *    per request; GET/DELETE — 2025 session operations — are answered 405
 *    because this deployment is session-less).
 *
 * Host validation and bearer authentication run before any protocol handling
 * for every /mcp request. Browser-facing admin/device routes additionally
 * enforce the Origin allowlist. Authenticated MCP machine clients may carry
 * an arbitrary Origin added by their HTTP stack; Host validation and the
 * bearer credential remain authoritative for that route. The validated
 * identity is handed to the SDK as the pass-through `authInfo` (the raw token
 * is never kept).
 */
export class EphemeraHttpService {
  private readonly server: Server;
  private readonly handler: McpHttpHandler;
  private readonly nodeHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  private readonly toolContext: ToolContext;
  private readonly deviceHandler: DeviceHttpHandler | null;
  private readonly adminHandler: AdminHttpHandler | null;
  private closing = false;
  private startedAt = Date.now();

  constructor(private readonly deps: HttpServiceDeps) {
    this.toolContext = deps.toolContext;
    this.deviceHandler = deps.deviceChannel === undefined ? null : new DeviceHttpHandler(deps.deviceChannel);
    const routedCallers = new Set(deps.config.raw.deviceChannel.publisher_caller_ids);
    const consoleCallers = [...new Set(
      deps.config.raw.auth.credentials.filter((entry) => !entry.revoked).map((entry) => entry.caller_id),
    )].map((callerId) => ({ caller_id: callerId, device_routed: routedCallers.has(callerId) }));
    const mcpCredential = (() => {
      const path = deps.config.raw.auth.console_bearer_file;
      if (path === undefined || !existsSync(path)) return null;
      try {
        const bearerToken = readFileSync(path, 'utf8').trim();
        if (bearerToken.length === 0) return null;
        const digest = createHash('sha256').update(bearerToken, 'utf8').digest('hex');
        const entry = deps.config.raw.auth.credentials.find((candidate) =>
          !candidate.revoked && candidate.tool_view === 'author' && candidate.token_sha256 === digest,
        );
        return entry === undefined ? null : { caller_id: entry.caller_id, bearer_token: bearerToken };
      } catch {
        return null;
      }
    })();
    this.adminHandler = deps.ownerAuth === undefined
      ? null
      : new AdminHttpHandler(
          deps.ownerAuth,
          deps.toolContext,
          deps.deviceChannel,
          consoleCallers,
          deps.config.raw.server.maxHttpBodyBytes,
          deps.typesetterSettings,
          deps.weatherSettings ?? new WeatherSettingsStore(deps.toolContext.store.dataDir),
          mcpCredential,
          deps.config.raw.server.port,
          (() => {
            if (deps.deviceChannel === undefined) return null;
            if (deps.config.raw.deviceChannel.public_endpoint !== undefined) {
              return deps.config.raw.deviceChannel.public_endpoint;
            }
            if (deps.config.raw.server.host === '127.0.0.1') return null;
            const lanHost = deps.config.raw.network.allowedHosts.find((host) =>
              /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && host !== '127.0.0.1',
            );
            return lanHost === undefined ? null : `http://${lanHost}:${deps.config.raw.server.port}`;
          })(),
        );
    const { maxHttpBodyBytes, sseKeepAliveMs } = deps.config.raw.server;

    this.handler = createMcpHandler(
      (ctx) => {
        const identity = ctx.authInfo?.extra as { caller_id?: string; credential_id?: string; tool_view?: string } | undefined;
        deps.log.debug('mcp_request', {
          era: ctx.era,
          caller_id: typeof identity?.caller_id === 'string' ? identity.caller_id : 'unknown',
        });
        const factory = identity?.tool_view === 'author' ? buildAuthorMcpServer : buildMcpServer;
        return factory(
          {
            era: ctx.era,
            callerId: typeof identity?.caller_id === 'string' ? identity.caller_id : undefined,
            credentialId: typeof identity?.credential_id === 'string' ? identity.credential_id : undefined,
          },
          this.toolContext,
        );
      },
      {
        legacy: 'stateless',
        onerror: (error) => {
          // Reporting only; the SDK has already answered the client.
          deps.log.warn('mcp_handler_error', { message: error.message });
        },
        keepAliveMs: sseKeepAliveMs,
        maxRequestBodySize: maxHttpBodyBytes,
      },
    );

    this.nodeHandler = toNodeHandler(this.handler, {
      onerror: (error) => {
        deps.log.warn('mcp_node_adapter_error', { message: error.message });
      },
      maxRequestBodySize: maxHttpBodyBytes,
    });

    this.server = createServer((req, res) => {
      this.dispatch(req, res).catch((error) => {
        deps.log.error('http_handler_error', { message: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) {
          sendError(res, 500, -32603, 'Internal error');
        } else {
          res.destroy();
        }
      });
    });
  }

  listen(): Promise<{ host: string; port: number }> {
    const { host, port } = this.deps.config.raw.server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        const actualPort = typeof address === 'object' && address !== null ? address.port : port;
        resolve({ host, port: actualPort });
      });
    });
  }

  /** Stop accepting requests, tear down the SDK handler, release the port. */
  shutdown(): Promise<void> {
    this.closing = true;
    return new Promise((resolve) => {
      void this.handler
        .close()
        .catch(() => undefined)
        .then(() => {
          this.server.close(() => resolve());
          // Node waits for open SSE connections; force-release them.
          this.server.closeAllConnections?.();
        });
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ephemera.invalid');
    const path = url.pathname;

    if (path === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', uptime_sec: Math.floor((Date.now() - this.startedAt) / 1000) }));
      return;
    }

    if (this.closing) {
      sendError(res, 503, -32000, 'Server is shutting down');
      return;
    }

    const network = this.deps.config.raw.network;
    if (!isHostAllowed(req.headers.host, network.allowedHosts)) {
      this.deps.log.warn('request_rejected', { reason: 'host_not_allowed' });
      sendError(res, 403, -32000, 'Forbidden: Host header not allowed');
      return;
    }
    const adminSurface = path === '/console' || path.startsWith('/console/') || path.startsWith('/admin/v1/');
    let sameOriginAdmin = false;
    if (adminSurface && req.headers.origin !== undefined && req.headers.host !== undefined) {
      try {
        const origin = new URL(req.headers.origin);
        sameOriginAdmin = (origin.protocol === 'http:' || origin.protocol === 'https:') && origin.host === req.headers.host;
      } catch {
        sameOriginAdmin = false;
      }
    }
    const originAllowed = isOriginAllowed(req.headers.origin, network.allowedOrigins);
    // Native/mobile MCP clients can attach `Origin: null` or their own app
    // origin even though this is not a browser CORS request. Let /mcp reach
    // bearer authentication; browser-facing routes retain the strict Origin
    // policy, and the server still rejects spoofed Host headers above.
    if (path !== '/mcp' && !originAllowed && !(adminSurface && sameOriginAdmin)) {
      this.deps.log.warn('request_rejected', { reason: 'origin_not_allowed' });
      sendError(res, 403, -32000, 'Forbidden: Origin header not allowed');
      return;
    }

    if (this.adminHandler !== null && adminSurface) {
      await this.adminHandler.handle(req, res, url);
      return;
    }

    if (path !== '/mcp') {
      if (this.deviceHandler !== null &&
          (path.startsWith('/device/v1/') || (this.adminHandler === null && path.startsWith('/admin/v1/')))) {
        await this.deviceHandler.handle(req, res, url);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    // Network users of this AGPL service can retrieve the matching public source.
    res.setHeader('Link', '<https://github.com/IrisNyx/MoonE-ink>; rel="source"');

    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      sendError(res, 405, -32000, 'Method Not Allowed', { allow: 'POST, GET, DELETE' });
      return;
    }

    // Authentication covers every /mcp exchange: discovery, initialize,
    // tool calls, and the (stateless-deployment 405) GET/DELETE probes.
    const auth = this.deps.credentials.authenticate(req.headers.authorization);
    if (!auth.ok) {
      this.deps.log.warn('auth_rejected', { reason: auth.failure.reason, method: req.method ?? '' });
      const headers = auth.failure.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined;
      sendError(res, auth.failure.status, -32000, 'Unauthorized', headers);
      return;
    }
    if (!originAllowed) {
      this.deps.log.debug('mcp_origin_compat', { present: req.headers.origin !== undefined });
    }
    // Official pass-through path: toNodeHandler forwards req.auth as the
    // handler's authInfo, and the factory derives the caller identity from
    // it — the ONLY source of caller_id; tool arguments never carry it. The
    // raw token is intentionally not retained.
    (req as IncomingMessage & { auth?: AuthInfo }).auth = {
      token: '',
      clientId: auth.identity.credentialId,
      scopes: ['mcp:read'],
      extra: { caller_id: auth.identity.callerId, credential_id: auth.identity.credentialId, tool_view: auth.identity.toolView },
    };

    // Streamable HTTP formally asks clients to advertise both response media
    // types. Several otherwise compatible mobile clients send only JSON,
    // `*/*`, or omit Accept. The server can safely normalize that negotiation
    // detail because the SDK still chooses and labels the actual response.
    if (req.method === 'POST') {
      const accept = req.headers.accept?.toLowerCase() ?? '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
        this.deps.log.debug('mcp_accept_compat', { present: accept.length > 0 });
      }
    }

    await this.nodeHandler(req, res);
  }
}
