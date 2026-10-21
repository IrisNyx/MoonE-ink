import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const OWNER_STATE_FILE = 'owner-auth.json';
export const OWNER_BOOTSTRAP_FILE = 'owner-bootstrap.txt';
const COOKIE_NAME = 'mooneink_owner';
const CSRF_COOKIE_NAME = 'mooneink_bootstrap_csrf';
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,512}$/;
// The Console is an appliance UI, not a short-lived banking session. A
// successful Owner login should survive ordinary service restarts and browser
// refreshes; credential rotation still invalidates every existing cookie.
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_CSRF_TTL_MS = 10 * 60 * 1000;

interface OwnerState {
  schema_version: 1;
  instance_id: string;
  owner_token_sha256: string | null;
  bootstrap_token_sha256: string | null;
  bootstrap_expires_at: string | null;
  updated_at: string;
}

interface BootstrapCsrf {
  cookie_digest: Buffer;
  header_digest: Buffer;
  expires_at: number;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return sha256(value).toString('hex');
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/.exec(header)?.[1] ?? null;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, value, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function validateState(value: unknown, instanceId: string): OwnerState {
  const state = value as Partial<OwnerState>;
  const digest = (candidate: unknown): candidate is string | null =>
    candidate === null || (typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate));
  if (
    state.schema_version !== 1 ||
    state.instance_id !== instanceId ||
    !digest(state.owner_token_sha256) ||
    !digest(state.bootstrap_token_sha256) ||
    !(state.bootstrap_expires_at === null || typeof state.bootstrap_expires_at === 'string') ||
    typeof state.updated_at !== 'string'
  ) {
    throw new Error('owner identity state is invalid or belongs to another instance');
  }
  return state as OwnerState;
}

export interface SessionIssue {
  cookie: string;
  csrf_token: string;
  expires_at: string;
}

export interface SessionRefresh {
  csrf_token: string;
  expires_at: string;
}

export interface BootstrapStatus {
  initialized: boolean;
  bootstrap_available: boolean;
  csrf_cookie: string;
  csrf_token: string;
}

export class OwnerAuthService {
  private state: OwnerState;
  private readonly bootstrapCsrf = new Map<string, BootstrapCsrf>();
  private readonly statePath: string;
  private readonly bootstrapPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly instanceId: string,
    private readonly now: () => number = Date.now,
    private readonly configuredOwnerTokenSha256?: string,
  ) {
    this.statePath = join(dataDir, OWNER_STATE_FILE);
    this.bootstrapPath = join(dataDir, OWNER_BOOTSTRAP_FILE);
    this.state = this.loadOrCreate();
    this.adoptConfiguredOwner();
    this.ensureBootstrapReadable();
  }

  initialized(): boolean {
    return this.state.owner_token_sha256 !== null;
  }

  managedByConfiguration(): boolean {
    return this.configuredOwnerTokenSha256 !== undefined;
  }

  bootstrapStatus(): BootstrapStatus {
    this.expire();
    const cookie = randomBytes(24).toString('base64url');
    const header = randomBytes(24).toString('base64url');
    const key = sha256Hex(cookie);
    this.bootstrapCsrf.set(key, {
      cookie_digest: sha256(cookie),
      header_digest: sha256(header),
      expires_at: this.now() + BOOTSTRAP_CSRF_TTL_MS,
    });
    return {
      initialized: this.initialized(),
      bootstrap_available: this.bootstrapAvailable(),
      csrf_cookie: `${CSRF_COOKIE_NAME}=${cookie}; Path=/admin/v1/; HttpOnly; SameSite=Strict; Max-Age=600`,
      csrf_token: header,
    };
  }

  bootstrap(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
    ownerToken: unknown,
  ): SessionIssue {
    this.assertBootstrapCsrf(cookie, csrfHeader);
    if (this.initialized()) throw new Error('owner identity is already initialized');
    if (!this.bootstrapAvailable()) throw new Error('bootstrap credential is unavailable or expired');
    const rawBootstrap = bearer(authorization);
    if (
      rawBootstrap === null ||
      this.state.bootstrap_token_sha256 === null ||
      !safeEqual(sha256(rawBootstrap), Buffer.from(this.state.bootstrap_token_sha256, 'hex'))
    ) {
      throw new Error('bootstrap credential is invalid');
    }
    if (typeof ownerToken !== 'string' || !TOKEN_PATTERN.test(ownerToken)) {
      throw new Error('owner credential must be 32-512 safe characters');
    }
    this.state = {
      ...this.state,
      owner_token_sha256: sha256Hex(ownerToken),
      bootstrap_token_sha256: null,
      bootstrap_expires_at: null,
      updated_at: new Date(this.now()).toISOString(),
    };
    this.persist();
    if (existsSync(this.bootstrapPath)) unlinkSync(this.bootstrapPath);
    this.bootstrapCsrf.clear();
    return this.issueSession();
  }

  login(
    cookie: string | undefined,
    csrfHeader: string | undefined,
    ownerToken: unknown,
  ): SessionIssue {
    this.assertBootstrapCsrf(cookie, csrfHeader);
    if (!this.initialized()) throw new Error('owner identity is not initialized');
    if (
      typeof ownerToken !== 'string' ||
      !TOKEN_PATTERN.test(ownerToken) ||
      this.state.owner_token_sha256 === null ||
      !safeEqual(sha256(ownerToken), Buffer.from(this.state.owner_token_sha256, 'hex'))
    ) {
      throw new Error('owner credential is invalid');
    }
    return this.issueSession();
  }

  rotate(
    cookie: string | undefined,
    csrfHeader: string | undefined,
    currentOwnerToken: unknown,
    newOwnerToken: unknown,
  ): SessionIssue {
    if (this.managedByConfiguration()) {
      throw new Error('owner Bearer is managed by the deployment configuration');
    }
    if (!this.authenticateWrite(cookie, csrfHeader)) {
      throw new Error('owner session and CSRF token are required');
    }
    if (
      typeof currentOwnerToken !== 'string' ||
      !TOKEN_PATTERN.test(currentOwnerToken) ||
      this.state.owner_token_sha256 === null ||
      !safeEqual(sha256(currentOwnerToken), Buffer.from(this.state.owner_token_sha256, 'hex'))
    ) {
      throw new Error('current owner credential is invalid');
    }
    if (typeof newOwnerToken !== 'string' || !TOKEN_PATTERN.test(newOwnerToken)) {
      throw new Error('new owner credential must be 32-512 safe characters');
    }
    const next: OwnerState = {
      ...this.state,
      owner_token_sha256: sha256Hex(newOwnerToken),
      updated_at: new Date(this.now()).toISOString(),
    };
    this.persist(next);
    this.state = next;
    return this.issueSession();
  }

  authenticate(cookie: string | undefined): boolean {
    const raw = cookieValue(cookie, COOKIE_NAME);
    return raw !== null && this.readSession(raw) !== null;
  }

  /** Recover the deterministic per-session CSRF token after a Console reload. */
  sessionInfo(cookie: string | undefined): SessionRefresh | null {
    const raw = cookieValue(cookie, COOKIE_NAME);
    if (raw === null) return null;
    const expires = this.readSession(raw);
    return expires === null
      ? null
      : { csrf_token: this.csrfFor(raw), expires_at: new Date(expires).toISOString() };
  }

  authenticateWrite(cookie: string | undefined, csrfHeader: string | undefined): boolean {
    const raw = cookieValue(cookie, COOKIE_NAME);
    if (raw === null || typeof csrfHeader !== 'string') return false;
    return this.readSession(raw) !== null && safeEqual(sha256(this.csrfFor(raw)), sha256(csrfHeader));
  }

  logout(_cookie: string | undefined): void {
    // Sessions are signed, long-lived cookies. Clearing the browser cookie is
    // sufficient for logout; rotating the Owner Bearer revokes every copy.
  }

  sessionCookie(issue: SessionIssue): string {
    return issue.cookie;
  }

  clearSessionCookie(): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  private loadOrCreate(): OwnerState {
    if (existsSync(this.statePath)) {
      const value = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
      const observedInstance = (value as { instance_id?: unknown }).instance_id;
      if (typeof observedInstance === 'string' && observedInstance !== this.instanceId) {
        // A disaster restore or cloned directory has a new instance identity.
        // Validate the old record before retiring it; corruption still fails
        // closed instead of silently manufacturing a new owner.
        validateState(value, observedInstance);
        renameSync(this.statePath, `${this.statePath}.retired.${this.now()}`);
        if (existsSync(this.bootstrapPath)) {
          renameSync(this.bootstrapPath, `${this.bootstrapPath}.retired.${this.now()}`);
        }
      } else {
        return validateState(value, this.instanceId);
      }
    }
    const state: OwnerState = {
      schema_version: 1,
      instance_id: this.instanceId,
      owner_token_sha256: null,
      bootstrap_token_sha256: null,
      bootstrap_expires_at: null,
      updated_at: new Date(this.now()).toISOString(),
    };
    this.state = state;
    this.persist();
    return state;
  }

  private adoptConfiguredOwner(): void {
    if (this.configuredOwnerTokenSha256 === undefined) return;
    if (!/^[0-9a-f]{64}$/.test(this.configuredOwnerTokenSha256)) {
      throw new Error('configured owner credential digest is invalid');
    }
    if (
      this.state.owner_token_sha256 !== this.configuredOwnerTokenSha256 ||
      this.state.bootstrap_token_sha256 !== null ||
      this.state.bootstrap_expires_at !== null
    ) {
      this.state = {
        ...this.state,
        owner_token_sha256: this.configuredOwnerTokenSha256,
        bootstrap_token_sha256: null,
        bootstrap_expires_at: null,
        updated_at: new Date(this.now()).toISOString(),
      };
      this.persist();
    }
    if (existsSync(this.bootstrapPath)) unlinkSync(this.bootstrapPath);
  }

  private ensureBootstrapReadable(): void {
    if (this.initialized()) {
      if (existsSync(this.bootstrapPath)) unlinkSync(this.bootstrapPath);
      return;
    }
    if (this.bootstrapAvailable() && existsSync(this.bootstrapPath)) return;
    const raw = randomBytes(32).toString('base64url');
    this.state = {
      ...this.state,
      bootstrap_token_sha256: sha256Hex(raw),
      bootstrap_expires_at: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    };
    this.persist();
    if (existsSync(this.bootstrapPath)) unlinkSync(this.bootstrapPath);
    writeFileSync(this.bootstrapPath, `${raw}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }

  private bootstrapAvailable(): boolean {
    return this.state.bootstrap_token_sha256 !== null &&
      this.state.bootstrap_expires_at !== null &&
      Date.parse(this.state.bootstrap_expires_at) > this.now();
  }

  private persist(state: OwnerState = this.state): void {
    atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private issueSession(): SessionIssue {
    const expires = this.now() + SESSION_TTL_MS;
    const payload = `v1.${expires}.${randomBytes(24).toString('base64url')}`;
    const raw = `${payload}.${this.sessionSignature(payload)}`;
    const csrf = this.csrfFor(raw);
    return {
      cookie: `${COOKIE_NAME}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      csrf_token: csrf,
      expires_at: new Date(expires).toISOString(),
    };
  }

  private csrfFor(rawSession: string): string {
    return createHmac('sha256', this.sessionKey())
      .update(`mooneink.owner.csrf.v1\0${rawSession}`, 'utf8')
      .digest('base64url');
  }

  private sessionKey(): Buffer {
    if (this.state.owner_token_sha256 === null) throw new Error('owner identity is not initialized');
    return Buffer.from(this.state.owner_token_sha256, 'hex');
  }

  private sessionSignature(payload: string): string {
    return createHmac('sha256', this.sessionKey())
      .update(`mooneink.owner.session.v1\0${this.instanceId}\0${payload}`, 'utf8')
      .digest('base64url');
  }

  private readSession(raw: string): number | null {
    if (!this.initialized()) return null;
    const parts = raw.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d{10,16}$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{24,64}$/.test(parts[2] ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? '')) {
      return null;
    }
    const expires = Number(parts[1]);
    if (!Number.isSafeInteger(expires) || expires <= this.now()) return null;
    const payload = parts.slice(0, 3).join('.');
    const expected = this.sessionSignature(payload);
    return safeEqual(sha256(expected), sha256(parts[3]!)) ? expires : null;
  }

  private assertBootstrapCsrf(cookie: string | undefined, csrfHeader: string | undefined): void {
    this.expire();
    const rawCookie = cookieValue(cookie, CSRF_COOKIE_NAME);
    if (rawCookie === null || typeof csrfHeader !== 'string') throw new Error('CSRF validation failed');
    const key = sha256Hex(rawCookie);
    const record = this.bootstrapCsrf.get(key);
    this.bootstrapCsrf.delete(key);
    if (
      record === undefined ||
      record.expires_at <= this.now() ||
      !safeEqual(record.cookie_digest, sha256(rawCookie)) ||
      !safeEqual(record.header_digest, sha256(csrfHeader))
    ) {
      throw new Error('CSRF validation failed');
    }
  }

  private expire(): void {
    const now = this.now();
    for (const [key, value] of this.bootstrapCsrf) if (value.expires_at <= now) this.bootstrapCsrf.delete(key);
  }
}
