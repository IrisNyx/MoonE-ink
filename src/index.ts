import './runtime-security.js';
import { parseArgs } from 'node:util';
import { CredentialStore } from './auth.js';
import { loadConfig } from './config.js';
import { redactDiagnosticText, safeFailureMessage } from './diagnostics.js';
import { ConfigError } from './errors.js';
import { AcceptanceService } from './domain/acceptance.js';
import { QueryService } from './domain/query.js';
import { PublicationWorker, type WorkerLogger } from './jobs/worker.js';
import { AssetStore } from './jobs/assets.js';
import { realRenderJob } from './jobs/renderer.js';
import { browserEnvironmentStatus } from './render/browser.js';
import { EphemeraHttpService } from './mcp/http.js';
import { Logger } from './logger.js';
import { openDataStore } from './storage.js';
import { assertRestoreCredentials } from './restore-policy.js';
import type { ToolContext } from './tools.js';
import { DeviceChannelService } from './device/service.js';
import { OwnerAuthService, OWNER_BOOTSTRAP_FILE } from './admin/auth.js';
import { TypesetterSettingsStore } from './typesetter/settings.js';
import { PersonalizationStore } from './admin/personalization.js';
import { WeatherSettingsStore } from './weather/settings.js';
import { selectedGenre } from './domain/manuscript.js';
import { almanacFactsForDate } from './facts/almanac.js';

/**
 * Process exit codes:
 *   0 clean shutdown (SIGINT/SIGTERM)
 *   1 unexpected runtime failure
 *   2 invalid configuration
 *   3 data directory unavailable (busy lock / schema mismatch / unreadable)
 *   4 cannot listen on the configured address
 */
const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_CONFIG = 2;
const EXIT_DATA_DIR = 3;
const EXIT_LISTEN = 4;

function usage(): string {
  return [
    'ephemera-mcp — standalone Ephemera MCP foundation service',
    '',
    'usage: node dist/src/index.js --config <path-to-config.json> [--stop-on-stdin-eof]',
    '',
    'The configuration file is the private deployment configuration and is',
    'never part of the repository; see config.example.json for the shape.',
    '',
    '--stop-on-stdin-eof: request a graceful shutdown when the piped stdin',
    'reaches EOF (supervisor pattern; Windows-friendly since POSIX signals',
    'cannot reach handlers there). Do not combine with a null stdin device.',
  ].join('\n');
}

function emitError(log: Logger, event: string, message: string): void {
  // Startup failures go to stderr as structured lines; stdout stays for logs.
  // Guard the boundary: whatever a caller passed, only bounded, path-free
  // text may reach stderr or the log record.
  const safe = redactDiagnosticText(message);
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, message: safe })}\n`);
  log.error(event, { message: safe });
}

async function main(): Promise<number> {
  let values: { config?: string; help?: boolean; 'stop-on-stdin-eof'?: boolean };
  try {
    values = parseArgs({
      options: {
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
        'stop-on-stdin-eof': { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    const message = safeFailureMessage(error, 'invalid command line arguments');
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'config_error', message })}\n`);
    return EXIT_CONFIG;
  }
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }
  if (typeof values.config !== 'string' || values.config.length === 0) {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'config_error', message: '--config <path> is required' })}\n`);
    return EXIT_CONFIG;
  }

  let config;
  try {
    config = loadConfig(values.config);
  } catch (error) {
    // ConfigError messages are safe by construction (stable categories, no
    // raw OS text, no rejected values); anything else is summarized.
    const message =
      error instanceof ConfigError ? redactDiagnosticText(error.message) : 'configuration failed (internal error)';
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'config_error', message })}\n`);
    return EXIT_CONFIG;
  }

  const log = new Logger(config.raw.logging.level);

  let configuredTypesetterApiKey: string | undefined;
  if (config.raw.typesetter.enabled) {
    const apiKeyEnv = config.raw.typesetter.apiKeyEnv!;
    const apiKey = process.env[apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      emitError(log, 'config_error', 'configured typesetter credential environment variable is missing');
      return EXIT_CONFIG;
    }
    configuredTypesetterApiKey = apiKey;
  }
  const typesetterSettings = new TypesetterSettingsStore(config.dataDir, {
    enabled: config.raw.typesetter.enabled,
    ...(config.raw.typesetter.endpoint === undefined ? {} : { endpoint: config.raw.typesetter.endpoint }),
    ...(config.raw.typesetter.model === undefined ? {} : { model: config.raw.typesetter.model }),
    ...(configuredTypesetterApiKey === undefined ? {} : { apiKey: configuredTypesetterApiKey }),
    timeoutMs: config.raw.typesetter.timeoutMs,
    commitReserveMs: config.raw.typesetter.commitReserveMs,
  });
  const weatherSettings = new WeatherSettingsStore(config.dataDir);

  let store;
  let ownerAuth: OwnerAuthService;
  try {
    store = openDataStore(config.dataDir);
    assertRestoreCredentials(store.restorePolicy, config.raw);
    ownerAuth = new OwnerAuthService(
      store.dataDir,
      store.instanceId,
      Date.now,
      config.raw.deviceChannel.enabled ? config.raw.deviceChannel.owner_token_sha256 : undefined,
    );
  } catch (error) {
    store?.close();
    emitError(log, 'data_dir_error', safeFailureMessage(error, 'data directory unavailable'));
    return EXIT_DATA_DIR;
  }

  // The publish capability is honest about the real renderer: schema v9 and
  // the worker always run, but without the locked browser cache the service
  // reports publish=false and the publish tool refuses work instead of
  // accepting manuscripts that could only fail.
  const browserStatus = browserEnvironmentStatus();
  if (!browserStatus.ok) {
    log.warn('renderer_unavailable', { reason: browserStatus.reason });
  }

  const acceptanceRepository = store.createAcceptanceRepository();
  const publicationRepository = store.createPublicationRepository();
  const queryRepository = store.createQueryRepository();
  const acceptance = new AcceptanceService({
    repository: acceptanceRepository,
    instanceId: store.instanceId,
    timezone: config.raw.server.timezone,
    maxPendingOperations: config.raw.server.maxPendingOperations,
    terminalPublishBudgetMs: config.raw.server.terminalPublishBudgetMs,
    channelForCaller: (callerId) =>
      config.raw.deviceChannel.enabled && config.raw.deviceChannel.publisher_caller_ids.includes(callerId)
        ? config.raw.deviceChannel.channel_id
        : null,
  });
  const query = new QueryService({ repository: queryRepository, instanceId: store.instanceId });
  const assets = new AssetStore(config.dataDir);
  const personalization = new PersonalizationStore(config.dataDir);
  // Startup recovery: scratch directories of leases this process does not
  // hold are leftovers of a dead attempt (single owner per data directory).
  assets.cleanupStaleTmp(new Set());
  const worker = new PublicationWorker({
    repository: publicationRepository,
    assets,
    render: (job) => realRenderJob({
      ...job,
      timezone: config.raw.server.timezone,
      branding: personalization.renderBranding(),
    }),
    resolvePublicationFacts: async ({ genre, publicationDate }) => {
      if (genre === 'almanac') return { almanac: almanacFactsForDate(publicationDate) };
      if (genre === 'weather') return { weather: await weatherSettings.snapshotForPublication() };
      if (genre === 'starmap') {
        try {
          return { weather: await weatherSettings.snapshotForPublication() };
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    leaseDurationMs: config.raw.server.worker.leaseDurationMs,
    pollIntervalMs: config.raw.server.worker.pollIntervalMs,
    reviewer: typesetterSettings,
    log: log as WorkerLogger,
  });
  worker.start();

  const toolContext: ToolContext = {
    store,
    acceptance,
    publication: publicationRepository,
    query,
    authorWeatherForecast: () => weatherSettings.snapshotForPublication(),
    publishAvailable: browserStatus.ok,
    deviceChannelAvailable: config.raw.deviceChannel.enabled,
    wakePublisher: () => worker.notify(),
  };

  const deviceChannel = config.raw.deviceChannel.enabled
    ? new DeviceChannelService({
        repository: store.createDeviceChannelRepository(),
        config: config.raw.deviceChannel,
        instanceId: store.instanceId,
        dataDir: store.dataDir,
      })
    : undefined;

  const service = new EphemeraHttpService({
    config,
    credentials: new CredentialStore(config.raw.auth.credentials),
    toolContext,
    ...(deviceChannel === undefined ? {} : { deviceChannel }),
    ownerAuth,
    typesetterSettings,
    weatherSettings,
    log,
  });

  let address: { host: string; port: number };
  try {
    address = await service.listen();
  } catch (error) {
    emitError(log, 'listen_error', safeFailureMessage(error, 'cannot listen on the configured address'));
    await worker.stop();
    store.close();
    return EXIT_LISTEN;
  }

  log.info('listening', { host: address.host, port: address.port });
  log.info('instance_ready', {
    instance_id: store.instanceId,
    schema_version: store.schemaVersion,
    created_at: store.instanceCreatedAt,
  });
  log.info('owner_management_ready', {
    initialized: ownerAuth.initialized(),
    bootstrap_file: ownerAuth.initialized() ? null : OWNER_BOOTSTRAP_FILE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('shutdown_begin', { signal });
    try {
      // Stop accepting requests first, then let the worker finish its
      // current attempt (bounded), then release the data directory.
      await service.shutdown();
      await worker.stop();
    } finally {
      store.close();
      log.info('shutdown_complete', {});
    }
    process.exit(EXIT_OK);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Optional supervisor stop path: Windows cannot deliver POSIX signals to
  // handlers, so a supervisor may instead close the piped stdin to request
  // a graceful shutdown. Opt-in flag; never combined with a null stdin.
  if (values['stop-on-stdin-eof'] === true && !process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on('error', () => undefined);
    process.stdin.on('end', () => void shutdown('stdin_end'));
  }

  const fatal = (origin: string, error: unknown): void => {
    emitError(log, 'fatal', safeFailureMessage(error, `unexpected runtime failure (${origin})`));
    void (async () => {
      try {
        await service.shutdown();
        await worker.stop();
      } finally {
        store.close();
        process.exit(EXIT_RUNTIME);
      }
    })();
  };
  process.on('uncaughtException', (error) => fatal('uncaughtException', error));
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

  return new Promise<number>(() => {
    // Long-running service; exit happens via signals or fatal errors.
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'fatal', message: safeFailureMessage(error, 'unexpected runtime failure') })}\n`,
    );
    process.exit(EXIT_RUNTIME);
  },
);
