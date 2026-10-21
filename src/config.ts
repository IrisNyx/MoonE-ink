import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { fsFailureCategory } from './diagnostics.js';
import { ConfigError } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const DEFAULT_DEVICE_LIMITS = {
  max_pages_per_edition: 16,
  max_pages_response_bytes: 262144,
  max_history_response_bytes: 262144,
  max_actions_per_frame: 6,
  max_string_bytes: 4096,
  max_json_depth: 8,
  max_event_body_bytes: 32768,
  max_history_items: 50,
  request_timeout_ms: 15000,
  asset_download_timeout_ms: 30000,
} as const;

const deviceLimitsSchema = z.strictObject({
  max_pages_per_edition: z.number().int().min(1).max(64).default(16),
  max_pages_response_bytes: z.number().int().min(4096).max(4 * 1024 * 1024).default(262144),
  max_history_response_bytes: z.number().int().min(4096).max(4 * 1024 * 1024).default(262144),
  max_actions_per_frame: z.number().int().min(0).max(32).default(6),
  max_string_bytes: z.number().int().min(128).max(65536).default(4096),
  max_json_depth: z.number().int().min(2).max(32).default(8),
  max_event_body_bytes: z.number().int().min(1024).max(262144).default(32768),
  max_history_items: z.number().int().min(1).max(100).default(50),
  request_timeout_ms: z.number().int().min(1000).max(120000).default(15000),
  asset_download_timeout_ms: z.number().int().min(1000).max(300000).default(30000),
});

const credentialSchema = z.strictObject({
  credential_id: z.string().regex(ID_PATTERN),
  caller_id: z.string().regex(ID_PATTERN),
  /** SHA-256 of the raw bearer token, hex-encoded lowercase. */
  token_sha256: z.string().regex(SHA256_HEX),
  revoked: z.boolean().default(false),
  /** Author credentials see only publish+peek; internal preserves the operational compatibility surface. */
  tool_view: z.enum(['author', 'internal']).default('internal'),
});

export const configSchema = z.strictObject({
  server: z.strictObject({
    /** Bind address. Defaults to loopback; remote exposure is a deliberate act. */
    host: z.string().min(1).default('127.0.0.1'),
    /** 0 picks an ephemeral port (printed in the listening log line). */
    port: z.number().int().min(0).max(65535).default(8765),
    /** Directory holding the SQLite database and lock file (service-owned). */
    dataDir: z.string().min(1),
    /** IANA timezone used for publication numbering; validated now. */
    timezone: z.string().min(1).default('UTC'),
    /**
     * Server-wide cap on operations in `accepted|processing` state; new
     * acceptances above it fail with queue_full (replays still succeed).
     */
    maxPendingOperations: z.number().int().min(1).max(1000).default(100),
    /** Queue→selection→render→review→commit budget for terminal-v1. */
    terminalPublishBudgetMs: z.number().int().min(1_000).max(120_000).default(20_000),
    /** Hard cap on HTTP request bodies (spec default 256 KiB). */
    maxHttpBodyBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(256 * 1024),
    /** Interval between SSE keep-alive comment frames. */
    sseKeepAliveMs: z.number().int().min(0).max(60_000).default(15_000),
    /**
     * Publication worker tuning (operational timing, not fault injection):
     * how long one attempt's lease guards a claimed operation and how often
     * an idle worker looks for eligible work. Defaults keep a crashed
     * attempt recoverable within two minutes without busy polling.
     */
    worker: z.strictObject({
      leaseDurationMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
      pollIntervalMs: z.number().int().min(50).max(60_000).default(2_000),
    }),
  }),
  network: z.strictObject({
    /** Allowed Host header hostnames (port-insensitive, lowercase). */
    allowedHosts: z.array(z.string().min(1)).default(['localhost', '127.0.0.1', '[::1]']),
    /** Allowed browser Origins; empty list rejects every Origin header. */
    allowedOrigins: z.array(z.string().min(1)).default([]),
  }),
  auth: z.strictObject({
    mode: z.literal('static-bearer'),
    // A clean C1 install starts with the management plane only. MCP remains
    // closed until the owner explicitly creates at least one active caller.
    credentials: z.array(credentialSchema).default([]),
    /** Optional service-private raw author token file shown only to an authenticated Owner Console. */
    console_bearer_file: z.string().min(1).optional(),
  }).default({ mode: 'static-bearer', credentials: [] }),
  deviceChannel: z.strictObject({
    enabled: z.boolean().default(false),
    /** Separate owner credential; ordinary MCP and device credentials never authorize admin routes. */
    owner_token_sha256: z.string().regex(SHA256_HEX).optional(),
    /** Address written into devices. VPS deployments use their public HTTPS origin. */
    public_endpoint: z.string().url().optional(),
    channel_id: z.string().regex(ID_PATTERN).default('channel_default'),
    /** Trusted publisher-to-channel mapping frozen onto each operation at acceptance. */
    publisher_caller_ids: z.array(z.string().regex(ID_PATTERN)).default([]),
    allowed_profiles: z.array(z.enum(['epaper-540x960-gray4-v1', 'epaper-960x540-gray4-v1'])).min(1)
      .default(['epaper-540x960-gray4-v1', 'epaper-960x540-gray4-v1']),
    pairing_ttl_seconds: z.number().int().min(60).max(86400).default(900),
    pairing_max_attempts: z.number().int().min(1).max(20).default(5),
    limits: deviceLimitsSchema.default(DEFAULT_DEVICE_LIMITS),
  }).default({
    enabled: false,
    channel_id: 'channel_default',
    publisher_caller_ids: [],
    allowed_profiles: ['epaper-540x960-gray4-v1', 'epaper-960x540-gray4-v1'],
    pairing_ttl_seconds: 900,
    pairing_max_attempts: 5,
    limits: DEFAULT_DEVICE_LIMITS,
  }),
  typesetter: z.strictObject({
    enabled: z.boolean().default(false),
    /** Base URL of an Ephemera review bridge; secrets stay in the named env var. */
    endpoint: z.string().url().optional(),
    model: z.string().min(1).max(256).optional(),
    apiKeyEnv: z.string().regex(ENV_NAME).optional(),
    timeoutMs: z.number().int().min(250).max(60_000).default(8_000),
    commitReserveMs: z.number().int().min(0).max(30_000).default(1_000),
  }).default({ enabled: false, timeoutMs: 8_000, commitReserveMs: 1_000 }),
  logging: z.strictObject({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
});

export type EphemeraConfig = z.infer<typeof configSchema>;

export interface ResolvedConfig {
  readonly raw: EphemeraConfig;
  /** Absolute data directory. */
  readonly dataDir: string;
}

/**
 * Coarse JSON syntax category. The parser message can quote file content, so
 * only the category — never the message — reaches the diagnostic.
 */
function jsonFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('Unexpected end of JSON input') ? 'unexpected end of input' : 'syntax error';
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new ConfigError('server.timezone: unknown IANA timezone');
  }
}

function validateOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError('network.allowedOrigins: entries must be absolute http or https URLs');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError('network.allowedOrigins: entries must use http or https');
    }
  }
}

function validateCredentialTable(config: EphemeraConfig): void {
  const credentialIds = new Set<string>();
  for (const credential of config.auth.credentials) {
    if (credentialIds.has(credential.credential_id)) {
      throw new ConfigError('auth.credentials: duplicate credential_id');
    }
    credentialIds.add(credential.credential_id);
  }
}

function validateTypesetter(config: EphemeraConfig): void {
  if (!config.typesetter.enabled) {
    return;
  }
  if (config.typesetter.endpoint === undefined || config.typesetter.model === undefined || config.typesetter.apiKeyEnv === undefined) {
    throw new ConfigError('typesetter: endpoint, model and apiKeyEnv are required when enabled');
  }
  const url = new URL(config.typesetter.endpoint);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('typesetter.endpoint: HTTPS is required except for loopback development bridges');
  }
  if (config.typesetter.commitReserveMs >= config.server.terminalPublishBudgetMs) {
    throw new ConfigError('typesetter.commitReserveMs: must be smaller than server.terminalPublishBudgetMs');
  }
}

function privateHttpHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254);
}

function validateDeviceEndpoint(config: EphemeraConfig): void {
  const endpoint = config.deviceChannel.public_endpoint;
  if (endpoint === undefined) return;
  const parsed = new URL(endpoint);
  const rootOnly = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' &&
    parsed.username === '' && parsed.password === '';
  if (!rootOnly || (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && privateHttpHost(parsed.hostname)))) {
    throw new ConfigError('deviceChannel.public_endpoint: use an HTTPS origin, or private/local HTTP origin, without a path');
  }
  (config.deviceChannel as { public_endpoint?: string }).public_endpoint = endpoint.replace(/\/$/, '');
}

/**
 * Load and validate a configuration file. All rejections throw ConfigError
 * with a field-level message; the caller must exit without listening.
 * Messages are safe to print: they carry stable failure categories, never
 * raw OS exception text (which embeds the absolute config path), file
 * content, or rejected configuration values.
 */
export function loadConfig(path: string): ResolvedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`configuration file could not be read (${fsFailureCategory(error)})`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`configuration file is not valid JSON (${jsonFailureCategory(error)})`);
  }

  // Optional sections with fully-defaulted fields; merging keeps unknown
  // top-level fields intact so the strict schema still rejects them.
  let input: unknown = parsedJson;
  if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
    const record = parsedJson as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...record,
      ...(record.server === undefined ? { server: {} } : {}),
      ...(record.network === undefined ? { network: {} } : {}),
      ...(record.logging === undefined ? { logging: {} } : {}),
      ...(record.deviceChannel === undefined ? { deviceChannel: {} } : {}),
      ...(record.typesetter === undefined ? { typesetter: {} } : {}),
    };
    if (typeof record.server === 'object' && record.server !== null && !Array.isArray(record.server)) {
      const server = record.server as Record<string, unknown>;
      merged.server = { ...server, ...(server.worker === undefined ? { worker: {} } : {}) };
    }
    input = merged;
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'root';
    throw new ConfigError(`${where}: ${issue?.message ?? 'invalid configuration'}`);
  }

  const config = result.data;
  validateTimezone(config.server.timezone);
  validateOrigins(config.network.allowedOrigins);
  validateCredentialTable(config);
  validateTypesetter(config);
  validateDeviceEndpoint(config);
  if (config.deviceChannel.enabled) {
    if (config.deviceChannel.owner_token_sha256 === undefined) {
      throw new ConfigError('deviceChannel.owner_token_sha256: required when deviceChannel.enabled is true');
    }
    if (config.deviceChannel.publisher_caller_ids.length === 0) {
      throw new ConfigError('deviceChannel.publisher_caller_ids: at least one caller is required when enabled');
    }
    const activeCallers = new Set(config.auth.credentials.filter((item) => !item.revoked).map((item) => item.caller_id));
    for (const caller of config.deviceChannel.publisher_caller_ids) {
      if (!activeCallers.has(caller)) {
        throw new ConfigError('deviceChannel.publisher_caller_ids: every caller must have an active MCP credential');
      }
    }
  }

  const dataDir = isAbsolute(config.server.dataDir)
    ? config.server.dataDir
    : resolve(process.cwd(), config.server.dataDir);

  if (config.auth.console_bearer_file !== undefined && !isAbsolute(config.auth.console_bearer_file)) {
    (config.auth as { console_bearer_file?: string }).console_bearer_file = resolve(
      dirname(isAbsolute(path) ? path : resolve(process.cwd(), path)),
      config.auth.console_bearer_file,
    );
  }

  const normalizedHosts = config.network.allowedHosts.map((host) => host.toLowerCase());
  (config.network as { allowedHosts: string[] }).allowedHosts = normalizedHosts;

  return { raw: config, dataDir };
}
