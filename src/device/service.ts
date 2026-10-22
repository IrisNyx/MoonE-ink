import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJsonBytes } from '../domain/canonical.js';
import { contentDisplayText, STORED_GENRE_CONTENT_SCHEMA } from '../domain/genre-content.js';
import type { EphemeraConfig } from '../config.js';
import { DeviceRepositoryError } from './repository.js';
import {
  DEVICE_PROTOCOL_VERSION,
  LANDSCAPE_PROFILE,
  PORTRAIT_PROFILE,
  type DeviceBindingRecord,
  type DeviceChannelRepository,
  type DeviceFrameRecord,
  type DeviceHistoryFilter,
  type ProtocolLimits,
} from './types.js';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{32,128}$/;
const ROOT_KEY_FILE = 'device-channel.key';
const HISTORY_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

export class DeviceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DeviceApiError';
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  if (!SHA256.test(a) || !SHA256.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function loadOrCreateRootKey(dataDir: string): Buffer {
  const path = join(dataDir, ROOT_KEY_FILE);
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (!SHA256.test(value)) throw new DeviceApiError(500, 'storage_unavailable', 'device credential root is invalid', true);
    return Buffer.from(value, 'hex');
  }
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('hex')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return key;
}

function stableSecret(rootKey: Buffer, bindingId: string): string {
  return createHmac('sha256', rootKey).update(`ephemera.device.binding.v1\0${bindingId}`, 'utf8').digest('base64url');
}

function jsonDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== 'object') return depth;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.reduce((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new DeviceApiError(400, 'invalid_input', `${name} is invalid`);
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeviceApiError(400, 'invalid_input', `${name} must be an object`);
  }
}

export function deviceFrameActions(frame: DeviceFrameRecord): Array<{ id: 'previous_page' | 'next_page'; x: number; y: number; w: number; h: number }> {
  const actions: Array<{ id: 'previous_page' | 'next_page'; x: number; y: number; w: number; h: number }> = [];
  const edgeWidth = Math.floor(frame.width / 3);
  if (frame.page_index > 0) {
    actions.push({ id: 'previous_page', x: 0, y: 0, w: edgeWidth, h: frame.height });
  }
  if (frame.page_index + 1 < frame.page_count) {
    actions.push({ id: 'next_page', x: frame.width - edgeWidth, y: 0, w: edgeWidth, h: frame.height });
  }
  return actions;
}

function frameId(frame: DeviceFrameRecord): string {
  const actions = deviceFrameActions(frame);
  return `frm_${createHash('sha256')
    .update(
      `${frame.publication_id}\0${frame.edition_id}\0${frame.page_id}\0${frame.profile}\0${frame.sha256}\0${JSON.stringify(actions)}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function toFrame(frame: DeviceFrameRecord): Record<string, unknown> {
  const stride = frame.width / 2;
  const actions = deviceFrameActions(frame);
  return {
    frame_id: frameId(frame),
    publication_id: frame.publication_id,
    edition_id: frame.edition_id,
    part_id: frame.part_id,
    page_id: frame.page_id,
    page_index: frame.page_index,
    page_count: frame.page_count,
    profile: frame.profile,
    format: 'gray4',
    width: frame.width,
    height: frame.height,
    stride_bytes: stride,
    byte_length: frame.byte_length,
    sha256: frame.sha256,
    asset: `/device/v1/assets/${frame.sha256}.bin`,
    actions,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function listText(blob: Uint8Array): { title: string | null; label: string; summary: string } {
  const manuscript = JSON.parse(Buffer.from(blob).toString('utf8')) as {
    title?: unknown;
    body?: unknown;
    content?: unknown;
  };
  let text = typeof manuscript.body === 'string' ? manuscript.body : '';
  if (manuscript.content !== undefined) {
    const parsed = STORED_GENRE_CONTENT_SCHEMA.safeParse(manuscript.content);
    if (parsed.success) text = contentDisplayText(parsed.data);
  }
  const title = typeof manuscript.title === 'string' && manuscript.title.trim().length > 0
    ? manuscript.title.trim()
    : null;
  const compact = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  // Device fields are fixed-size UTF-8 byte buffers. JavaScript's slice() is
  // based on UTF-16 code units, which let a Chinese summary grow to roughly
  // three times the device limit and made the whole otherwise valid history
  // response disappear on the reader.
  const label = truncateUtf8(title ?? compact[0] ?? '无标题', 96);
  const summary = truncateUtf8(compact.join('　'), 180);
  return { title, label, summary };
}

export interface DeviceChannelServiceDeps {
  repository: DeviceChannelRepository;
  config: EphemeraConfig['deviceChannel'];
  instanceId: string;
  dataDir: string;
  clock?: () => number;
  random?: (bytes: number) => Buffer;
}

export class DeviceChannelService {
  readonly channelId: string;
  readonly limits: ProtocolLimits;
  private readonly repository: DeviceChannelRepository;
  private readonly config: EphemeraConfig['deviceChannel'];
  private readonly instanceId: string;
  private readonly dataDir: string;
  private readonly rootKey: Buffer;
  private readonly clock: () => number;
  private readonly random: (bytes: number) => Buffer;

  constructor(deps: DeviceChannelServiceDeps) {
    this.repository = deps.repository;
    this.config = deps.config;
    this.instanceId = deps.instanceId;
    this.dataDir = deps.dataDir;
    this.channelId = deps.config.channel_id;
    this.limits = deps.config.limits;
    this.clock = deps.clock ?? (() => Date.now());
    this.random = deps.random ?? randomBytes;
    this.rootKey = loadOrCreateRootKey(deps.dataDir);
    this.repository.configureChannel({
      channelId: this.channelId,
      publisherCallerIds: deps.config.publisher_caller_ids,
      nowIso: this.now(),
      epochSource: () => `epoch_${this.random(16).toString('hex')}`,
    });
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  authenticateOwner(header: string | undefined): boolean {
    const expected = this.config.owner_token_sha256;
    if (expected === undefined || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const raw = header.slice(7);
    return raw.length > 0 && sameHex(sha256(raw), expected);
  }

  authenticateDevice(header: string | undefined): DeviceBindingRecord {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new DeviceApiError(401, 'unauthorized', 'device credential is required');
    }
    const raw = header.slice(7);
    if (raw.length < 32) throw new DeviceApiError(401, 'unauthorized', 'device credential is invalid');
    const binding = this.repository.bindingBySecretDigest(sha256(raw));
    if (binding === null) throw new DeviceApiError(401, 'unauthorized', 'device credential is invalid');
    if (binding.status !== 'active') throw new DeviceApiError(403, 'binding_changed', 'device binding is revoked');
    if (binding.instance_id !== this.instanceId) throw new DeviceApiError(409, 'instance_changed', 'service instance changed');
    return binding;
  }

  createPairing(body: unknown): Record<string, unknown> {
    assertObject(body, 'pairing request');
    const allowed = ['channel_id', 'profiles', 'expires_in_seconds'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new DeviceApiError(400, 'invalid_input', 'unknown pairing field');
    const channelId = body['channel_id'] ?? this.channelId;
    if (channelId !== this.channelId) throw new DeviceApiError(404, 'not_found', 'channel not found');
    const profiles = body['profiles'] ?? this.config.allowed_profiles;
    if (!Array.isArray(profiles) || profiles.length === 0 || profiles.some((item) => typeof item !== 'string')) {
      throw new DeviceApiError(400, 'invalid_input', 'profiles must be a non-empty string array');
    }
    const uniqueProfiles = [...new Set(profiles as string[])];
    if (uniqueProfiles.some((item) => !this.config.allowed_profiles.includes(item as typeof PORTRAIT_PROFILE | typeof LANDSCAPE_PROFILE))) {
      throw new DeviceApiError(400, 'unsupported_profile', 'pairing requested an unavailable profile');
    }
    const ttl = body['expires_in_seconds'] ?? this.config.pairing_ttl_seconds;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > this.config.pairing_ttl_seconds) {
      throw new DeviceApiError(400, 'invalid_input', 'expires_in_seconds is outside the configured bound');
    }
    const code = this.random(24).toString('base64url');
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + ttl * 1000).toISOString();
    const pairingId = `pair_${this.random(16).toString('hex')}`;
    this.repository.createPairing({
      pairingId,
      codeDigest: sha256(code),
      channelId: this.channelId,
      allowedProfiles: uniqueProfiles,
      createdAt,
      expiresAt,
      maxAttempts: this.config.pairing_max_attempts,
    });
    return {
      protocol_version: DEVICE_PROTOCOL_VERSION,
      pairing_id: pairingId,
      channel_id: this.channelId,
      enrollment_code: code,
      profiles: uniqueProfiles,
      limits: this.limits,
      expires_at: expiresAt,
    };
  }

  pair(body: unknown): Record<string, unknown> {
    assertObject(body, 'pair request');
    const keys = ['protocol_version', 'request_id', 'device_id', 'enrollment_code', 'supported_profiles', 'limits'];
    if (!exactKeys(body, keys)) throw new DeviceApiError(400, 'invalid_input', 'pair request fields are incomplete or unknown');
    if (body['protocol_version'] !== DEVICE_PROTOCOL_VERSION) throw new DeviceApiError(400, 'unsupported_protocol', 'protocol_version is unsupported');
    assertId(body['request_id'], 'request_id');
    assertId(body['device_id'], 'device_id');
    if (typeof body['enrollment_code'] !== 'string' || !CURSOR.test(body['enrollment_code'])) {
      throw new DeviceApiError(400, 'invalid_input', 'enrollment_code is invalid');
    }
    const codeDigest = sha256(body['enrollment_code']);
    const pairing = this.repository.pairingByDigest(codeDigest);
    if (pairing === null) throw new DeviceApiError(401, 'pairing_invalid', 'pairing code is invalid or expired');
    const now = this.now();
    if (pairing.expires_at <= now || pairing.failed_attempts >= pairing.max_attempts) {
      throw new DeviceApiError(401, 'pairing_invalid', 'pairing code is invalid or expired');
    }
    const supported = body['supported_profiles'];
    if (!Array.isArray(supported) || supported.length === 0 || supported.some((item) => typeof item !== 'string')) {
      this.repository.notePairingFailure(codeDigest);
      throw new DeviceApiError(400, 'invalid_input', 'supported_profiles is invalid');
    }
    const profiles = pairing.allowed_profiles.filter((item) => supported.includes(item));
    if (profiles.length === 0) {
      this.repository.notePairingFailure(codeDigest);
      throw new DeviceApiError(409, 'unsupported_profile', 'device and channel have no common profile');
    }
    assertObject(body['limits'], 'limits');
    const deviceLimits = body['limits'];
    const expectedLimitKeys = Object.keys(this.limits);
    if (!exactKeys(deviceLimits, expectedLimitKeys)) {
      this.repository.notePairingFailure(codeDigest);
      throw new DeviceApiError(400, 'invalid_input', 'limits fields are incomplete or unknown');
    }
    for (const [key, required] of Object.entries(this.limits)) {
      const offered = deviceLimits[key];
      if (typeof offered !== 'number' || !Number.isInteger(offered) || offered < required) {
        this.repository.notePairingFailure(codeDigest);
        throw new DeviceApiError(409, 'limits_incompatible', `device limit ${key} is below the channel contract`);
      }
    }
    const canonicalInput = {
      protocol_version: 1,
      request_id: body['request_id'],
      device_id: body['device_id'],
      supported_profiles: [...new Set(supported as string[])].sort(),
      limits: deviceLimits,
    };
    const requestDigest = sha256(canonicalJsonBytes(canonicalInput));
    const bindingId = pairing.binding_id ?? `bind_${this.random(16).toString('hex')}`;
    const secret = stableSecret(this.rootKey, bindingId);
    let result;
    try {
      result = this.repository.consumePairing({
        codeDigest,
        requestId: body['request_id'],
        requestDigest,
        bindingId,
        deviceId: body['device_id'],
        secretSha256: sha256(secret),
        profiles,
        limits: this.limits,
        nowIso: now,
      });
    } catch (error) {
      if (error instanceof DeviceRepositoryError) {
        if (error.code === 'idempotency_conflict') throw new DeviceApiError(409, 'idempotency_conflict', 'pair request id was reused with different input');
        if (error.code === 'expired' || error.code === 'not_found') throw new DeviceApiError(401, 'pairing_invalid', 'pairing code is invalid or expired');
      }
      throw error;
    }
    return {
      protocol_version: 1,
      device_id: result.binding.device_id,
      binding_id: result.binding.binding_id,
      instance_id: result.binding.instance_id,
      channel_id: result.binding.channel_id,
      epoch: result.binding.epoch,
      profiles: result.binding.profiles,
      limits: result.binding.limits,
      device_secret: stableSecret(this.rootKey, result.binding.binding_id),
      server_time: now,
      replayed: result.duplicate,
    };
  }

  revokeBinding(bindingId: string): Record<string, unknown> {
    assertId(bindingId, 'binding_id');
    const existed = this.repository.revokeBinding(bindingId, this.now());
    return { protocol_version: 1, binding_id: bindingId, revoked: true, existed };
  }

  /** Owner-only operational view used by the local Console. */
  adminStatus(): Record<string, unknown> {
    return {
      enabled: true,
      channel_id: this.channelId,
      bindings: this.repository.adminBindings(),
      recent_events: this.repository.adminRecentEvents(40),
      server_time: this.now(),
    };
  }

  screen(binding: DeviceBindingRecord, includeLibrary = false, selectedPublicationId: string | null = null): Record<string, unknown> {
    if (selectedPublicationId !== null) assertId(selectedPublicationId, 'read_status_for');
    const now = this.now();
    const state = this.repository.currentScreen(binding, now);
    if (state.epoch !== binding.epoch) throw new DeviceApiError(409, 'epoch_changed', 'channel epoch changed');
    const base = {
      protocol_version: 1,
      instance_id: this.instanceId,
      channel_id: binding.channel_id,
      epoch: binding.epoch,
      revision: state.revision,
      server_time: now,
      ...(includeLibrary ? {
        library: (() => {
          const library = this.repository.libraryState(binding.channel_id, selectedPublicationId);
          return {
            revision: library.revision,
            unread_count: library.unread_count,
            selected_read_status: selectedPublicationId === null ? null : {
              publication_id: selectedPublicationId,
              unread: library.selected_unread,
            },
          };
        })(),
      } : {}),
    };
    if (state.frame === null) return { ...base, availability: { state: 'empty' }, offer: null };
    if (!binding.profiles.includes(state.frame.profile)) {
      return {
        ...base,
        availability: {
          state: 'unsupported_profile',
          publication_id: state.frame.publication_id,
          required_profile: state.frame.profile,
        },
        offer: null,
      };
    }
    this.assertFrameLimits(binding, state.frame);
    return {
      ...base,
      availability: { state: 'ready' },
      offer: {
        delivery_id: state.frame.delivery_id,
        publication_id: state.frame.publication_id,
        presentation: 'ambient',
        interruption: 'when-idle',
        expires_at: state.frame.expires_at,
        frame: toFrame(state.frame),
      },
    };
  }

  history(binding: DeviceBindingRecord, cursor: string | null, limitInput: string | null,
          includeLibrary = false, filterInput: string | null = null): Record<string, unknown> {
    const now = this.now();
    const limit = limitInput === null ? Math.min(20, binding.limits.max_history_items) : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > binding.limits.max_history_items) {
      throw new DeviceApiError(400, 'invalid_input', 'history limit is outside binding limits');
    }
    if (filterInput !== null && !includeLibrary) throw new DeviceApiError(400, 'invalid_input', 'history filter requires include_library=1');
    const filter: DeviceHistoryFilter = filterInput === null ? 'legacy'
      : filterInput === 'recent' || filterInput === 'unread' ? filterInput
      : (() => { throw new DeviceApiError(400, 'invalid_input', 'history filter is invalid'); })();
    const library = includeLibrary ? this.repository.libraryState(binding.channel_id, null) : null;
    let highWater: number;
    let before: number | null;
    let remainingItems: number | null;
    if (cursor === null) {
      highWater = this.repository.historyHighWater(binding.channel_id);
      before = null;
      remainingItems = filter === 'recent' ? 50 : null;
    } else {
      if (!CURSOR.test(cursor)) throw new DeviceApiError(400, 'invalid_cursor', 'history cursor is invalid');
      const stored = this.repository.historyCursor(binding.binding_id, sha256(cursor));
      if (stored === null || stored.expires_at <= now || stored.page_size !== limit || stored.filter !== filter) {
        throw new DeviceApiError(400, 'invalid_cursor', 'history cursor is invalid or expired');
      }
      if (includeLibrary && stored.library_revision !== library!.revision) {
        throw new DeviceApiError(409, 'cursor_stale', 'history changed; refresh the first page');
      }
      highWater = stored.snapshot_high_water;
      before = stored.last_acceptance_seq;
      remainingItems = stored.remaining_items;
    }
    const pageLimit = remainingItems === null ? limit : Math.min(limit, remainingItems);
    const rows = pageLimit === 0 ? [] : this.repository.historyPage(binding.channel_id, highWater, before, pageLimit + 1, filter);
    const page = rows.slice(0, pageLimit);
    const remainingAfter = remainingItems === null ? null : Math.max(0, remainingItems - page.length);
    let nextCursor: string | null = null;
    if (rows.length > pageLimit && remainingAfter !== 0) {
      nextCursor = this.random(32).toString('base64url');
      this.repository.insertHistoryCursor({
        bindingId: binding.binding_id,
        cursorDigest: sha256(nextCursor),
        snapshotHighWater: highWater,
        lastAcceptanceSeq: page[page.length - 1]!.acceptance_seq,
        pageSize: limit,
        filter,
        libraryRevision: library?.revision ?? 0,
        remainingItems: remainingAfter,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + HISTORY_CURSOR_TTL_MS).toISOString(),
      });
    }
    const response = {
      protocol_version: 1,
      instance_id: this.instanceId,
      channel_id: binding.channel_id,
      epoch: binding.epoch,
      ...(includeLibrary ? { library_revision: library!.revision, unread_count: library!.unread_count } : {}),
      items: page.map((item) => ({
        ...listText(item.canonical_blob),
        publication_id: item.publication_id,
        delivery_id: item.delivery_id,
        acceptance_seq: item.acceptance_seq,
        accepted_at: item.accepted_at,
        committed_at: item.committed_at,
        expires_at: item.expires_at,
        withdrawn_at: item.withdrawn_at,
        edition_id: item.edition_id,
        profile: item.profile,
        page_count: item.page_count,
        genre: item.genre,
        display_date: item.committed_at,
        unread: item.unread !== 0,
        presentable: binding.profiles.includes(item.profile),
      })),
      next_cursor: nextCursor,
      server_time: now,
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > binding.limits.max_history_response_bytes) {
      throw new DeviceApiError(413, 'limits_incompatible', 'history response exceeds binding limit');
    }
    return response;
  }

  pages(binding: DeviceBindingRecord, publicationId: string, profile: string | null, editionId: string | null,
        includeLibrary = false): Record<string, unknown> {
    assertId(publicationId, 'publication_id');
    if (profile === null || profile.length === 0) throw new DeviceApiError(400, 'invalid_input', 'profile is required');
    if (!binding.profiles.includes(profile)) throw new DeviceApiError(409, 'unsupported_profile', 'profile is not supported by this binding');
    if (editionId !== null) assertId(editionId, 'edition_id');
    const rows = this.repository.pages(binding, publicationId, profile, editionId);
    if (rows.length === 0) {
      throw new DeviceApiError(editionId === null ? 404 : 409, editionId === null ? 'not_found' : 'edition_profile_mismatch', editionId === null ? 'publication or profile not found' : 'edition does not match publication and profile');
    }
    for (const row of rows) this.assertFrameLimits(binding, row);
    const response = {
      protocol_version: 1,
      instance_id: this.instanceId,
      channel_id: binding.channel_id,
      epoch: binding.epoch,
      publication_id: publicationId,
      edition_id: rows[0]!.edition_id,
      profile,
      page_count: rows.length,
      frames: rows.map(toFrame),
      ...(includeLibrary ? { unread: this.repository.libraryState(binding.channel_id, publicationId).selected_unread } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > binding.limits.max_pages_response_bytes) {
      throw new DeviceApiError(413, 'limits_incompatible', 'pages response exceeds binding limit');
    }
    return response;
  }

  asset(binding: DeviceBindingRecord, digest: string): { path: string; byteLength: number } {
    if (!SHA256.test(digest)) throw new DeviceApiError(400, 'invalid_input', 'asset digest is invalid');
    const record = this.repository.authorizedAsset(binding, digest);
    if (record === null) throw new DeviceApiError(404, 'not_found', 'asset not found for this binding');
    const path = join(this.dataDir, record.relative_path);
    const rel = relative(this.dataDir, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new DeviceApiError(500, 'storage_unavailable', 'asset path is invalid', true);
    }
    return { path, byteLength: record.byte_length };
  }

  event(binding: DeviceBindingRecord, body: unknown): Record<string, unknown> {
    assertObject(body, 'event');
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > binding.limits.max_event_body_bytes || jsonDepth(body) > binding.limits.max_json_depth) {
      throw new DeviceApiError(413, 'invalid_input', 'event exceeds binding limits');
    }
    const allowed = ['protocol_version','instance_id','channel_id','epoch','binding_id','device_id','event_id','seq','kind','observed_at','subject','state','action_id'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new DeviceApiError(400, 'invalid_input', 'unknown event field');
    if (body['protocol_version'] !== 1) throw new DeviceApiError(400, 'unsupported_protocol', 'protocol_version is unsupported');
    if (body['instance_id'] !== binding.instance_id) throw new DeviceApiError(409, 'instance_changed', 'event instance changed');
    if (body['channel_id'] !== binding.channel_id) throw new DeviceApiError(403, 'forbidden', 'event channel is not authorized');
    if (body['epoch'] !== binding.epoch) throw new DeviceApiError(409, 'epoch_changed', 'event epoch changed');
    if (body['binding_id'] !== binding.binding_id || body['device_id'] !== binding.device_id) {
      throw new DeviceApiError(409, 'binding_changed', 'event binding changed');
    }
    assertId(body['event_id'], 'event_id');
    if (typeof body['seq'] !== 'number' || !Number.isSafeInteger(body['seq']) || body['seq'] < 1) throw new DeviceApiError(400, 'invalid_input', 'seq is invalid');
    const kinds = ['cached','presented','acknowledged','status','interaction'];
    if (typeof body['kind'] !== 'string' || !kinds.includes(body['kind'])) throw new DeviceApiError(400, 'invalid_input', 'kind is invalid');
    if (body['observed_at'] !== null && typeof body['observed_at'] !== 'string') throw new DeviceApiError(400, 'invalid_input', 'observed_at is invalid');
    const subjectRequired = ['cached','presented','acknowledged'].includes(body['kind']);
    const subject = body['subject'];
    let publicationId: string | null = null;
    let pageId: string | null = null;
    let subjectFrameId: string | null = null;
    let subjectDeliveryId: string | null = null;
    if (subject !== null && subject !== undefined) {
      assertObject(subject, 'subject');
      if (!exactKeys(subject, ['publication_id','page_id','frame_id','delivery_id'])) throw new DeviceApiError(400, 'invalid_input', 'subject fields are invalid');
      assertId(subject['publication_id'], 'subject.publication_id');
      assertId(subject['page_id'], 'subject.page_id');
      assertId(subject['frame_id'], 'subject.frame_id');
      if (subject['delivery_id'] !== null) assertId(subject['delivery_id'], 'subject.delivery_id');
      const authorized = this.repository.subjectFrame(binding, subject['publication_id'], subject['page_id']);
      if (authorized === null || frameId(authorized) !== subject['frame_id']) throw new DeviceApiError(403, 'forbidden', 'event subject is not authorized');
      if (subject['delivery_id'] !== null && subject['delivery_id'] !== authorized.delivery_id) throw new DeviceApiError(403, 'forbidden', 'event delivery is not authorized');
      publicationId = authorized.publication_id;
      pageId = authorized.page_id;
      subjectFrameId = frameId(authorized);
      subjectDeliveryId = subject['delivery_id'];
    } else if (subjectRequired) {
      throw new DeviceApiError(400, 'invalid_input', 'event kind requires a subject');
    }
    if (body['kind'] === 'interaction') {
      if (typeof body['action_id'] !== 'string' || !['previous_page','next_page','previous_publication','next_publication','acknowledge','return_latest'].includes(body['action_id'])) {
        throw new DeviceApiError(400, 'invalid_input', 'interaction action_id is invalid');
      }
    } else if (body['action_id'] !== undefined) {
      throw new DeviceApiError(400, 'invalid_input', 'action_id is only valid for interaction events');
    }
    assertObject(body['state'], 'state');
    const state = body['state'];
    const requiredStateKeys = ['active_app','mode','pending_count','presented_frame'];
    const allowedStateKeys = new Set([...requiredStateKeys, 'app_view', 'power']);
    if (requiredStateKeys.some((key) => !(key in state)) || Object.keys(state).some((key) => !allowedStateKeys.has(key))) {
      throw new DeviceApiError(400, 'invalid_input', 'state fields are invalid');
    }
    if (typeof state['active_app'] !== 'string' || Buffer.byteLength(state['active_app'], 'utf8') > binding.limits.max_string_bytes) throw new DeviceApiError(400, 'invalid_input', 'active_app is invalid');
    if (state['mode'] !== 'follow_latest' && state['mode'] !== 'history') throw new DeviceApiError(400, 'invalid_input', 'mode is invalid');
    if (state['pending_count'] !== 0 && state['pending_count'] !== 1) throw new DeviceApiError(400, 'invalid_input', 'pending_count is invalid');
    if (state['app_view'] !== undefined && state['app_view'] !== null &&
        !['home','inbox','reading','unknown'].includes(String(state['app_view']))) {
      throw new DeviceApiError(400, 'invalid_input', 'app_view is invalid');
    }
    if (state['power'] !== undefined) {
      assertObject(state['power'], 'power');
      const power = state['power'];
      const requiredPowerKeys = ['source','battery_percent','battery_mv','mode','next_sync_in_seconds','next_sync_at'];
      const optionalPowerKeys = ['current_ma','average_current_ma','remaining_mah','full_mah','light_sleep_seconds','uptime_seconds'];
      if (requiredPowerKeys.some((key) => !(key in power)) ||
          Object.keys(power).some((key) => !requiredPowerKeys.includes(key) && !optionalPowerKeys.includes(key))) {
        throw new DeviceApiError(400, 'invalid_input', 'power fields are invalid');
      }
      if (!['external','battery','unknown'].includes(String(power['source'])) ||
          !['external_online','active','battery_idle','retry_backoff','low_battery'].includes(String(power['mode']))) {
        throw new DeviceApiError(400, 'invalid_input', 'power state is invalid');
      }
      for (const key of ['battery_percent','battery_mv','next_sync_in_seconds']) {
        const value = power[key];
        if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
          throw new DeviceApiError(400, 'invalid_input', `power.${key} is invalid`);
        }
      }
      if (typeof power['battery_percent'] === 'number' && power['battery_percent'] > 100) {
        throw new DeviceApiError(400, 'invalid_input', 'power.battery_percent is invalid');
      }
      if (power['next_sync_at'] !== null && typeof power['next_sync_at'] !== 'string') {
        throw new DeviceApiError(400, 'invalid_input', 'power.next_sync_at is invalid');
      }
      for (const key of optionalPowerKeys) {
        const value = power[key];
        if (value === undefined) continue;
        const signed = key === 'current_ma' || key === 'average_current_ma';
        if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
            (signed ? value < -32768 || value > 32767 : value < 0)) {
          throw new DeviceApiError(400, 'invalid_input', `power.${key} is invalid`);
        }
      }
    }
    if (state['presented_frame'] !== null) {
      assertObject(state['presented_frame'], 'presented_frame');
      const presented = state['presented_frame'];
      if (!exactKeys(presented, ['publication_id','page_id','frame_id'])) throw new DeviceApiError(400, 'invalid_input', 'presented_frame fields are invalid');
      assertId(presented['publication_id'], 'presented_frame.publication_id');
      assertId(presented['page_id'], 'presented_frame.page_id');
      assertId(presented['frame_id'], 'presented_frame.frame_id');
      const authorized = this.repository.subjectFrame(binding, presented['publication_id'], presented['page_id']);
      if (authorized === null || frameId(authorized) !== presented['frame_id']) throw new DeviceApiError(403, 'forbidden', 'presented_frame is not authorized');
    }
    const payloadJson = Buffer.from(canonicalJsonBytes(body)).toString('utf8');
    let outcome;
    try {
      outcome = this.repository.acceptEvent({
        binding,
        eventId: body['event_id'],
        seq: body['seq'],
        kind: body['kind'],
        payloadDigest: sha256(payloadJson),
        payloadJson,
        publicationId,
        pageId,
        frameId: subjectFrameId,
        deliveryId: subjectDeliveryId,
        stateJson: Buffer.from(canonicalJsonBytes(state)).toString('utf8'),
        receivedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof DeviceRepositoryError && error.code === 'idempotency_conflict') {
        throw new DeviceApiError(409, 'idempotency_conflict', 'event id or sequence was reused with different input');
      }
      throw error;
    }
    return { protocol_version: 1, event_id: body['event_id'], status: outcome.status, received_at: outcome.received_at };
  }

  etag(binding: DeviceBindingRecord, response: Record<string, unknown>): string {
    const stable = { ...response };
    delete stable['server_time'];
    const digest = sha256(canonicalJsonBytes({ binding_id: binding.binding_id, profiles: binding.profiles, limits: binding.limits, response: stable }));
    return `"${digest}"`;
  }

  private assertFrameLimits(binding: DeviceBindingRecord, frame: DeviceFrameRecord): void {
    if (frame.page_count < 1 || frame.page_count > binding.limits.max_pages_per_edition) throw new DeviceApiError(409, 'limits_incompatible', 'edition exceeds binding page limit');
    const geometryMatches = (frame.profile === PORTRAIT_PROFILE && frame.width === 540 && frame.height === 960) ||
      (frame.profile === LANDSCAPE_PROFILE && frame.width === 960 && frame.height === 540);
    if (!geometryMatches || frame.byte_length !== 259200) {
      throw new DeviceApiError(409, 'unsupported_profile', 'frame does not match the declared raster profile');
    }
  }
}
