import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDir, SERVICE_ENTRY } from './env.js';

export interface CredentialSpec {
  credential_id: string;
  caller_id: string;
  token_sha256: string;
  revoked?: boolean;
  tool_view?: 'author' | 'internal';
}

export interface ServiceOptions {
  dataDir?: string;
  token?: string;
  callerId?: string;
  extraCredentials?: CredentialSpec[];
  configOverride?: (config: Record<string, unknown>) => void;
}

export interface ExitStatus {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ServiceHandle {
  proc: ChildProcess;
  port: number;
  token: string;
  callerId: string;
  dataDir: string;
  configPath: string;
  stdoutText(): string;
  stderrText(): string;
  /** Graceful stop: close stdin pipe (Windows-friendly), escalate to kill. */
  stop(): Promise<ExitStatus>;
  /** Hard termination without cleanup (crash simulation). */
  crash(): void;
  /** Wait for process exit without signalling it. */
  waitExit(timeoutMs?: number): Promise<ExitStatus>;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Replace anything that looks like an operator-machine file path with a
 * stable placeholder. Startup diagnostics must never echo private absolute
 * paths (config locations, data directories, scratch roots): they surface in
 * test failures which end up in evidence files.
 */
export function redactPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'`,;:[\]]*/g, '[path]')
    .replace(/(^|[\s"'`([=,])(?:\/[\w.-]+){2,}/g, '$1[path]')
    .replace(/\\\\[^\s"'`,;[\]]*/g, '[unc-path]');
}

/** Redacted, bounded diagnostic tail for error messages. */
function diagnosticSummary(kind: string, detail: string, out: string, err: string): string {
  const tail = (text: string): string => {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-25).map((line) => redactPaths(line)).join('\n');
  };
  return `${kind}: ${detail}\n--- stdout (redacted tail) ---\n${tail(out)}\n--- stderr (redacted tail) ---\n${tail(err)}`;
}

/** Kill exactly the process tree this test spawned (taskkill on Windows). */
function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGKILL');
  }
}

export function baseConfig(opts: ServiceOptions): { config: Record<string, unknown>; dataDir: string; token: string } {
  const dataDir = opts.dataDir ?? freshDir('data');
  const token = opts.token ?? `test-token-${randomBytes(24).toString('hex')}`;
  const callerId = opts.callerId ?? 'caller_test';

  const credentials: CredentialSpec[] = [
    {
      credential_id: 'cred_primary_test',
      caller_id: callerId,
      token_sha256: sha256Hex(token),
    },
    ...(opts.extraCredentials ?? []),
  ];

  const config: Record<string, unknown> = {
    server: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      timezone: 'Asia/Shanghai',
      maxHttpBodyBytes: 262144,
      sseKeepAliveMs: 200,
    },
    network: {
      allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
      allowedOrigins: [],
    },
    auth: {
      mode: 'static-bearer',
      credentials,
    },
    logging: { level: 'debug' },
  };
  opts.configOverride?.(config);
  return { config, dataDir, token };
}

function spawnService(configPath: string): ChildProcessWithoutNullStreams {
  const proc = spawn(process.execPath, [SERVICE_ENTRY, '--config', configPath, '--stop-on-stdin-eof'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  return proc;
}

interface LineBuffer {
  text(): string;
  lines(): string[];
}

function lineBuffer(stream: NodeJS.ReadableStream): LineBuffer {
  let whole = '';
  const lines: string[] = [];
  stream.on('data', (chunk: string) => {
    whole += chunk;
    let index = whole.indexOf('\n');
    while (index !== -1) {
      lines.push(whole.slice(0, index));
      whole = whole.slice(index + 1);
      index = whole.indexOf('\n');
    }
  });
  return {
    text: () => whole,
    lines: () => lines,
  };
}

/** Start a real service process and wait until it reports a listening port. */
export async function startService(opts: ServiceOptions = {}): Promise<ServiceHandle> {
  const runDir = freshDir('run');
  const { config, dataDir, token } = baseConfig(opts);
  const configPath = join(runDir, 'config.json');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const proc = spawnService(configPath);
  const out = lineBuffer(proc.stdout);
  const err = lineBuffer(proc.stderr);

  const port = await new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      for (const line of out.lines().slice().reverse()) {
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === 'listening' && typeof event.port === 'number') {
            clearInterval(timer);
            resolve(event.port);
            return;
          }
        } catch {
          // non-JSON noise; ignore
        }
      }
      if (Date.now() - started > 25_000) {
        clearInterval(timer);
        // Never leave the timed-out child running: it is ours, kill it now.
        killTree(proc);
        reject(
          new Error(
            diagnosticSummary(
              'service did not report listening in time (spawned process terminated)',
              `exitCode=${proc.exitCode}`,
              out.lines().join('\n'),
              err.lines().join('\n'),
            ),
          ),
        );
        return;
      }
      if (proc.exitCode !== null) {
        clearInterval(timer);
        reject(
          new Error(
            diagnosticSummary(
              'service exited early',
              `code ${proc.exitCode}`,
              out.lines().join('\n'),
              err.lines().join('\n'),
            ),
          ),
        );
      }
    }, 50);
    proc.once('exit', () => {
      /* polled path above resolves or rejects */
    });
  });

  const waitExit = (timeoutMs = 15_000): Promise<ExitStatus> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve({ exited: true, code: proc.exitCode, signal: proc.signalCode });
        return;
      }
      const timer = setTimeout(() => resolve({ exited: false, code: null, signal: null }), timeoutMs);
      proc.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ exited: true, code, signal });
      });
    });

  const stop = async (): Promise<ExitStatus> => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return { exited: true, code: proc.exitCode, signal: proc.signalCode };
    }
    // Graceful path first: supervisor closes the stdin pipe (works on
    // Windows where SIGTERM handlers cannot run).
    await new Promise<void>((resolve) => {
      proc.stdin.end(() => resolve());
      setTimeout(resolve, 200).unref?.();
    });
    let status = await waitExit(10_000);
    if (!status.exited) {
      killTree(proc);
      status = await waitExit(10_000);
      if (!status.exited) {
        throw new Error('service process refused to terminate');
      }
    }
    return status;
  };

  return {
    proc,
    port,
    token,
    callerId: (config.auth as { credentials: CredentialSpec[] }).credentials[0]?.caller_id ?? 'caller_unconfigured',
    dataDir,
    configPath,
    stdoutText: () => out.lines().join('\n'),
    stderrText: () => err.lines().join('\n'),
    stop,
    crash: () => {
      proc.kill();
    },
    waitExit,
  };
}

export interface RawServiceRun {
  code: number | null;
  /** Combined stdout+stderr exactly as captured — deliberately NOT redacted. */
  raw: string;
  /** Bounded, path-redacted tail that is safe to put into evidence. */
  redactedTail: string;
}

/**
 * Run the real service process with explicit argv and capture its combined
 * output with no post-processing. Unlike `expectFailedStart`, `raw` is what
 * the production process actually emitted: tests assert on it to prove the
 * service itself redacts, not a helper. Only `redactedTail` may reach test
 * failure messages / evidence files.
 */
export async function runServiceRaw(argv: string[]): Promise<RawServiceRun> {
  const proc = spawn(process.execPath, [SERVICE_ENTRY, ...argv], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  proc.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      killTree(proc);
      resolve(null);
    }, 20_000);
    proc.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const raw = `${out}\n${err}`;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return { code, raw, redactedTail: lines.slice(-25).map((line) => redactPaths(line)).join('\n') };
}

/**
 * Run a service whose startup is expected to fail. Enforces the expected
 * non-zero exit code: a process that exits with any other code (or does not
 * exit at all before the timeout) fails the test right here. The returned
 * output is path-redacted so evidence never echoes operator-private paths.
 */
export async function expectFailedStart(
  config: Record<string, unknown>,
  expectedCode: number,
): Promise<{ code: number | null; output: string }> {
  if (!Number.isInteger(expectedCode) || expectedCode === 0) {
    throw new Error(`expectFailedStart requires a non-zero expected exit code, got ${expectedCode}`);
  }
  const runDir = freshDir('fail');
  const configPath = join(runDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const proc = spawnService(configPath);
  const out = lineBuffer(proc.stdout);
  const err = lineBuffer(proc.stderr);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      killTree(proc);
      resolve(null);
    }, 20_000);
    proc.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const output = redactPaths(`${out.lines().join('\n')}\n${err.lines().join('\n')}`);
  if (code === null) {
    throw new Error(
      `expected failed start with exit code ${expectedCode}, but the process was still running after 20s (killed)\n${output}`,
    );
  }
  if (code !== expectedCode) {
    throw new Error(`expected failed start with exit code ${expectedCode}, got ${code}\n${output}`);
  }
  return { code, output };
}
