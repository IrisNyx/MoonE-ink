import {
  API_SCHEMA_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  LANDSCAPE_RENDER_PROFILE,
  MODERN_PROTOCOL_VERSION,
  RENDER_PROFILE,
  SDK_NODE_MODULE,
  SDK_NODE_VERSION,
  SDK_SERVER_MODULE,
  SDK_SERVER_VERSION,
  SERVICE_VERSION,
} from './version.js';
import { GENRE_CATALOG, type GenreDescriptor } from './genres.js';
import { BusinessError } from './errors.js';
import type { DataStore } from './storage.js';
import type { AcceptanceService } from './domain/acceptance.js';
import type { PublicationRepository } from './domain/publication.js';
import type { QueryService } from './domain/query.js';
import type { WeatherSnapshot } from './weather/types.js';

/** Names of the seven tools registered as of MCP-04. */
export const TOOL_SERVICE_INFO = 'ephemera_service_info';
export const TOOL_LIST_GENRES = 'ephemera_list_genres';
export const TOOL_PUBLISH = 'ephemera_publish';
export const TOOL_REQUEST_STATUS = 'ephemera_request_status';
export const TOOL_HISTORY = 'ephemera_history';
export const TOOL_PEEK = 'ephemera_peek';
export const TOOL_WITHDRAW = 'ephemera_withdraw';

export interface ProtocolMatrix {
  /** Protocol revisions the linked SDK actually negotiates, newest first. */
  supported_versions: string[];
  latest_version: string;
  sdk: { name: string; version: string; node_adapter: { name: string; version: string } };
}

/**
 * The served matrix: the 2026-07-28 revision via the SDK v2 modern leg
 * (per-request envelope + server/discover), plus the two 2025 revisions via
 * the SDK's legacy initialize negotiation. Each row is proven by an official
 * SDK client pinned to exactly that revision in test/protocols.test.ts.
 */
export function protocolMatrix(): ProtocolMatrix {
  return {
    supported_versions: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
    latest_version: MODERN_PROTOCOL_VERSION,
    sdk: {
      name: SDK_SERVER_MODULE,
      version: SDK_SERVER_VERSION,
      node_adapter: { name: SDK_NODE_MODULE, version: SDK_NODE_VERSION },
    },
  };
}

export interface Capabilities {
  publish: boolean;
  history: boolean;
  device_channel: boolean;
  renderer: boolean;
}

/**
 * MCP-04 capability set: the read-only foundation, the publish/status loop,
 * the accepted postcard/note renderers and the history/peek/withdraw query tools
 * over schema v9. `publish` is true only when the store, the worker and the
 * REAL renderer are actually available — a missing locked browser cache
 * keeps the service honest with publish=false instead of accepting doomed
 * work. `history` is true: the query tools read committed SQLite facts only
 * and never depend on the renderer. Device Channel is independently enabled
 * by deployment configuration; caller-private peek remains device-blind.
 */
export function capabilitiesFor(publishAvailable: boolean, deviceChannelAvailable = false): Capabilities {
  return {
    publish: publishAvailable,
    history: true,
    device_channel: deviceChannelAvailable,
    renderer: true,
  };
}

/** Raster profiles this build can actually render (postcard and note paper). */
export const RENDERED_PROFILES: readonly string[] = [RENDER_PROFILE, LANDSCAPE_RENDER_PROFILE];

export type ServiceInfoResult = {
  ok: true;
  api_schema_version: number;
  instance_id: string;
  service_version: string;
  capabilities: Capabilities;
  /** Rendered profiles shipped by this build; empty until real renderers land. */
  rendered_profiles: string[];
  protocol: ProtocolMatrix;
};

export interface GenreView {
  id: string;
  supported: boolean;
  planned: boolean;
  accepted_fields: string[];
  limits: GenreDescriptor['limits'];
}

export type ListGenresResult = {
  ok: true;
  genres: GenreView[];
  pagination: { total: number; returned: number; kind: 'complete' };
};

export interface ToolContext {
  store: DataStore;
  /** Persistent acceptance domain service (MCP-03a). */
  acceptance: AcceptanceService;
  /** Publication repository backing request_status reads (MCP-03b). */
  publication: PublicationRepository;
  /** Query/withdraw domain service (MCP-04). */
  query: QueryService;
  /** Author-facing real forecast, shared with the weather publication path. */
  authorWeatherForecast?: () => Promise<WeatherSnapshot>;
  /** Whether the real renderer + worker are available on this instance. */
  publishAvailable: boolean;
  deviceChannelAvailable?: boolean;
  /** Optional worker wake-up; terminal calls use it to avoid idle-poll delay. */
  wakePublisher?: () => void;
  /** Test seam for the bounded terminal wait loop. */
  terminalPollMs?: number;
  now?: () => number;
}

export function serviceInfo(ctx: ToolContext): ServiceInfoResult {
  return {
    ok: true,
    api_schema_version: API_SCHEMA_VERSION,
    instance_id: ctx.store.instanceId,
    service_version: SERVICE_VERSION,
    capabilities: capabilitiesFor(ctx.publishAvailable, ctx.deviceChannelAvailable ?? false),
    rendered_profiles: [...RENDERED_PROFILES],
    protocol: protocolMatrix(),
  };
}

export function listGenres(args: { only_supported?: boolean }): ListGenresResult {
  const onlySupported = args.only_supported ?? true;
  const selected = GENRE_CATALOG.filter((genre) => (onlySupported ? genre.supported : true));
  return {
    ok: true,
    genres: selected.map((genre) => ({
      id: genre.id,
      supported: genre.supported,
      planned: genre.planned,
      accepted_fields: [...genre.accepted_fields],
      limits: { ...genre.limits },
    })),
    pagination: { total: selected.length, returned: selected.length, kind: 'complete' },
  };
}

/** Arguments of `ephemera_publish` (caller identity is NOT an argument). */
export interface PublishArgs {
  expected_instance_id: string;
  request_id: string;
  manuscript: unknown;
  /** Omitted keeps the historical immediate accepted-v2 response. */
  contract_version?: 'accepted-v2' | 'terminal-v1';
}

/** The exact receipt wire shape of a successful `ephemera_publish` call. */
export interface PublishReceiptWire {
  instance_id: string;
  operation_id: string;
  accepted: true;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  status: 'accepted' | 'processing' | 'published' | 'failed' | 'unknown_after_restore';
  replayed: boolean;
}

export interface TerminalPublishWire {
  contract_version: 'terminal-v1';
  instance_id: string;
  operation_id: string;
  request_id: string;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  outcome: 'published' | 'rejected';
  replayed: boolean;
  publication?: PublicationSummaryWire;
  failure?: {
    category: 'manuscript' | 'deadline' | 'technical';
    code: string;
    message: string;
    retryable: false;
  };
}

export interface TerminalPreAcceptanceRejectionWire {
  contract_version: 'terminal-v1';
  instance_id: string;
  request_id: string;
  accepted: false;
  outcome: 'rejected';
  phase: 'pre-acceptance';
  rejected_at: string;
  replayed: boolean;
  failure: {
    category: 'manuscript';
    code: 'invalid_input' | 'unsupported_genre' | 'unsupported_content_slot';
    message: string;
    retryable: false;
  };
}

export type TerminalPublishResultWire = TerminalPublishWire | TerminalPreAcceptanceRejectionWire;
export type PublishResultWire = PublishReceiptWire | TerminalPublishResultWire;

function terminalFailure(code: string, detail?: string): NonNullable<TerminalPublishWire['failure']> {
  if (code === 'deadline_exceeded') {
    return { category: 'deadline', code, message: '出版等待时间已用完，本次没有发布。请稍后重新投稿。', retryable: false };
  }
  if (code === 'invalid_input' || code === 'unsupported_genre' || code === 'unsupported_content_slot' ||
      code === 'unsupported_glyph' || code === 'render_overflow' || code === 'model_rejected') {
    const returned = code === 'model_rejected' && typeof detail === 'string' && detail.length > 0 && detail.length <= 2048
      ? detail
      : 'the manuscript did not pass publication checks';
    return { category: 'manuscript', code, message: returned, retryable: false };
  }
  if (code === 'model_unavailable') {
    const timeout = typeof detail === 'string' && (detail.includes('timeout') || detail.includes('超时'));
    return {
      category: 'technical', code,
      message: timeout
        ? '排版审核等待回复超时，本次没有发布。请稍后重新投稿。'
        : '排版审核服务暂时无法完成，本次没有发布。请稍后重新投稿。',
      retryable: false,
    };
  }
  const technicalMessages: Record<string, string> = {
    render_failed: '页面排版生成失败，本次没有发布。请稍后重新投稿。',
    storage_unavailable: '出版服务暂时无法保存页面，本次没有发布。请稍后重新投稿。',
    asset_unavailable: '出版页面文件暂时不可用，本次没有发布。请稍后重新投稿。',
    unknown_after_restore: '服务恢复后无法确认这次投稿的结果，请联系管理员核对。',
  };
  return {
    category: 'technical', code,
    message: technicalMessages[code] ?? '出版服务暂时无法完成，本次没有发布。请联系管理员查看出版报错。',
    retryable: false,
  };
}

/**
 * `ephemera_publish`: persistently accept the manuscript for the CURRENT
 * authenticated caller. The default accepted-v2 contract returns the stored
 * receipt immediately; `accepted:true` then means durable and queryable, not
 * rendered. The explicit terminal-v1 contract wakes the worker and waits only
 * until its transaction-fixed deadline for one durable published/rejected
 * outcome. Replays of the same key/input and contract return the same operation;
 * a changed manuscript or contract is `idempotency_conflict`.
 */
export function publish(
  ctx: ToolContext,
  callerId: string | undefined,
  args: PublishArgs & { contract_version: 'terminal-v1' },
): Promise<TerminalPublishResultWire>;
export function publish(
  ctx: ToolContext,
  callerId: string | undefined,
  args: PublishArgs & { contract_version?: 'accepted-v2' },
): Promise<PublishReceiptWire>;
export function publish(ctx: ToolContext, callerId: string | undefined, args: PublishArgs): Promise<PublishResultWire>;
export async function publish(ctx: ToolContext, callerId: string | undefined, args: PublishArgs): Promise<PublishResultWire> {
  if (callerId === undefined || callerId.length === 0) {
    // The HTTP layer derives the caller from the authenticated credential;
    // reaching here without one is a wiring defect, never trusted input.
    throw new BusinessError('invalid_input', 'caller identity is missing');
  }
  if (!ctx.publishAvailable) {
    throw new BusinessError('render_failed', 'publishing is unavailable: the locked renderer is not configured on this service');
  }
  const receipt = await ctx.acceptance.submit({
    expectedInstanceId: args.expected_instance_id,
    callerId,
    requestId: args.request_id,
    manuscript: args.manuscript,
    businessContract: args.contract_version ?? 'accepted-v2',
  });
  if (!receipt.accepted) {
    return {
      contract_version: 'terminal-v1',
      instance_id: receipt.instance_id,
      request_id: receipt.request_id,
      accepted: false,
      outcome: 'rejected',
      phase: 'pre-acceptance',
      rejected_at: receipt.rejected_at,
      replayed: receipt.replayed,
      failure: { ...receipt.failure },
    };
  }
  if (receipt.business_contract === 'terminal-v1') {
    if (receipt.deadline_at === null) {
      throw new BusinessError('storage_unavailable', 'terminal publication has no deadline', true);
    }
    ctx.wakePublisher?.();
    const deadlineMs = Date.parse(receipt.deadline_at);
    const pollMs = Math.max(1, Math.min(ctx.terminalPollMs ?? 25, 250));
    for (;;) {
      const status = await requestStatus(ctx, callerId, {
        expected_instance_id: args.expected_instance_id,
        operation_id: receipt.operation_id,
      });
      if (status.status === 'published' && status.publication !== undefined) {
        return {
          contract_version: 'terminal-v1',
          instance_id: receipt.instance_id,
          operation_id: receipt.operation_id,
          request_id: args.request_id,
          acceptance_seq: receipt.acceptance_seq,
          accepted_at: receipt.accepted_at,
          reserved_publication_id: receipt.reserved_publication_id,
          outcome: 'published',
          replayed: receipt.replayed,
          publication: status.publication,
        };
      }
      if ((status.status === 'failed' || status.status === 'unknown_after_restore') && status.failure !== undefined) {
        return {
          contract_version: 'terminal-v1',
          instance_id: receipt.instance_id,
          operation_id: receipt.operation_id,
          request_id: args.request_id,
          acceptance_seq: receipt.acceptance_seq,
          accepted_at: receipt.accepted_at,
          reserved_publication_id: receipt.reserved_publication_id,
          outcome: 'rejected',
          replayed: receipt.replayed,
          failure: terminalFailure(status.failure.code, status.failure.message),
        };
      }
      const nowMs = (ctx.now ?? Date.now)();
      if (nowMs >= deadlineMs) {
        ctx.publication.expireOperation(receipt.operation_id, new Date(nowMs).toISOString());
        continue;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollMs, Math.max(1, deadlineMs - nowMs)));
      });
    }
  }
  return {
    instance_id: receipt.instance_id,
    operation_id: receipt.operation_id,
    accepted: true,
    acceptance_seq: receipt.acceptance_seq,
    accepted_at: receipt.accepted_at,
    reserved_publication_id: receipt.reserved_publication_id,
    status: receipt.status,
    replayed: receipt.replayed,
  };
}

/** Arguments of `ephemera_request_status` (exactly one lookup key). */
export interface RequestStatusArgs {
  expected_instance_id: string;
  operation_id?: string;
  request_id?: string;
}

/** Read-only publication summary returned when status is published. */
export interface PublicationSummaryWire {
  publication_id: string;
  commit_seq: number;
  edition_id: string;
  profile: string;
  target: { width: number; height: number };
  renderer: {
    build: string;
    version: string;
    chromium: string;
    playwright: string;
    fonts_manifest_version: number;
    fonts_file_count: number;
  };
  pages: {
    page_id: string;
    page_index: number;
    width: number;
    height: number;
    assets: { role: string; kind: string; sha256: string; bytes: number }[];
  }[];
}

export interface RequestStatusWire {
  instance_id: string;
  operation_id: string;
  request_id: string;
  acceptance_seq: number;
  accepted_at: string;
  reserved_publication_id: string;
  status: 'accepted' | 'processing' | 'published' | 'failed' | 'unknown_after_restore';
  /** Present exactly when status is published — server-side commit only;
   * publishing says nothing about any device (offered/cached/presented/
   * acknowledged remain unknown and are never implied). */
  publication?: PublicationSummaryWire;
  /** Present exactly when status is failed: a stable queryable code. */
  failure?: { code: string; retryable: false; message?: string };
}

export interface PreAcceptanceRequestStatusWire {
  contract_version: 'terminal-v1';
  instance_id: string;
  request_id: string;
  accepted: false;
  status: 'rejected';
  phase: 'pre-acceptance';
  rejected_at: string;
  failure: TerminalPreAcceptanceRejectionWire['failure'];
}

export type RequestStatusResultWire = RequestStatusWire | PreAcceptanceRequestStatusWire;

/**
 * `ephemera_request_status`: caller-scoped lookup of one operation by
 * operation id or request id. Another caller's operation and an unknown id
 * are indistinguishable (`not_found` with the same fixed payload).
 */
export async function requestStatus(
  ctx: ToolContext,
  callerId: string | undefined,
  args: RequestStatusArgs,
): Promise<RequestStatusResultWire> {
  if (callerId === undefined || callerId.length === 0) {
    throw new BusinessError('invalid_input', 'caller identity is missing');
  }
  if (typeof args.expected_instance_id !== 'string' || args.expected_instance_id.length === 0) {
    throw new BusinessError('invalid_input', 'expected_instance_id must be a non-empty string');
  }
  if (args.expected_instance_id !== ctx.store.instanceId) {
    throw new BusinessError('instance_changed', 'expected instance does not match this service instance');
  }
  const hasOperation = args.operation_id !== undefined;
  const hasRequest = args.request_id !== undefined;
  if (hasOperation === hasRequest) {
    throw new BusinessError('invalid_input', 'exactly one of operation_id or request_id is required');
  }
  const view = ctx.publication.statusForCaller(callerId, {
    operationId: args.operation_id,
    requestId: args.request_id,
  });
  if (view === null) {
    if (args.request_id !== undefined) {
      const rejection = await ctx.acceptance.lookupPreAcceptance({
        expectedInstanceId: args.expected_instance_id,
        callerId,
        requestId: args.request_id,
      });
      if (rejection !== null) {
        return {
          contract_version: 'terminal-v1',
          instance_id: rejection.instance_id,
          request_id: rejection.request_id,
          accepted: false,
          status: 'rejected',
          phase: 'pre-acceptance',
          rejected_at: rejection.rejected_at,
          failure: { ...rejection.failure },
        };
      }
    }
    throw new BusinessError('not_found', 'operation not found for this caller');
  }
  const result: RequestStatusWire = {
    instance_id: view.instance_id,
    operation_id: view.operation_id,
    request_id: view.request_id,
    acceptance_seq: view.acceptance_seq,
    accepted_at: view.accepted_at,
    reserved_publication_id: view.reserved_publication_id,
    status: view.status,
  };
  if (view.status === 'published' && view.publication !== null) {
    const summary = view.publication;
    result.publication = {
      publication_id: summary.publication_id,
      commit_seq: summary.commit_seq,
      edition_id: summary.edition_id,
      profile: summary.profile,
      target: { width: summary.target.width, height: summary.target.height },
      renderer: { ...summary.renderer },
      pages: summary.pages.map((page) => ({
        page_id: page.page_id,
        page_index: page.page_index,
        width: page.width,
        height: page.height,
        assets: page.assets.map((asset) => ({ role: asset.role, kind: asset.kind, sha256: asset.sha256, bytes: asset.bytes })),
      })),
    };
  }
  if ((view.status === 'failed' || view.status === 'unknown_after_restore') && view.failure_code !== null) {
    result.failure = {
      code: view.failure_code,
      retryable: false,
      ...(view.failure_code === 'model_rejected' && view.terminal_detail !== null
        ? { message: view.terminal_detail }
        : view.failure_code === 'model_unavailable' || view.failure_code === 'render_failed' ||
          view.failure_code === 'storage_unavailable'
          ? { message: terminalFailure(view.failure_code, view.terminal_detail ?? undefined).message }
        : {}),
    };
  }
  return result;
}

/** Arguments of `ephemera_history` (caller identity is NOT an argument). */
export interface HistoryArgs {
  expected_instance_id: string;
  limit?: number;
  cursor?: string;
}

/** The exact wire shape of a successful `ephemera_history` page. */
export type HistoryWire = import('./domain/query.js').HistoryPageWire;

/**
 * `ephemera_history`: one stable snapshot page of the CURRENT caller's
 * successfully published records, ordered by acceptance sequence (newest
 * first). The first call fixes the committed-publication high water; the
 * opaque cursor continues that exact snapshot. Expired and withdrawn records
 * are listed (with their facts) — withdrawal never removes history.
 */
export function history(ctx: ToolContext, callerId: string | undefined, args: HistoryArgs): HistoryWire {
  if (callerId === undefined || callerId.length === 0) {
    throw new BusinessError('invalid_input', 'caller identity is missing');
  }
  return ctx.query.history(callerId, {
    expected_instance_id: args.expected_instance_id,
    limit: args.limit,
    cursor: args.cursor,
  });
}

/** Arguments of `ephemera_peek` (exactly one field). */
export interface PeekArgs {
  expected_instance_id: string;
}

/** The exact wire shape of a successful `ephemera_peek` call. */
export type PeekWire = import('./domain/query.js').PeekResultWire;

/**
 * `ephemera_peek`: the caller's latest eligible offer — max by
 * (eligible_at, acceptance_seq) over published, unwithdrawn, unexpired,
 * due publications — with the device channel explicitly disabled and every
 * device fact explicitly unknown. `published` never implies offered,
 * cached, presented or acknowledged.
 */
export function peek(ctx: ToolContext, callerId: string | undefined, args: PeekArgs): PeekWire {
  if (callerId === undefined || callerId.length === 0) {
    throw new BusinessError('invalid_input', 'caller identity is missing');
  }
  return ctx.query.peek(callerId, { expected_instance_id: args.expected_instance_id });
}

/** Arguments of `ephemera_withdraw` (idempotency key + target publication). */
export interface WithdrawArgs {
  expected_instance_id: string;
  request_id: string;
  publication_id: string;
}

/** The exact wire shape of a successful `ephemera_withdraw` call. */
export type WithdrawWire = import('./domain/query.js').WithdrawResultWire;

/**
 * `ephemera_withdraw`: idempotently cancel the future automatic delivery
 * eligibility of one of the caller's publications. The same
 * (instance, caller, request) key replays the stored outcome; the same key
 * against a different publication is `idempotency_conflict`; unknown or
 * foreign publications are one uniform `not_found`. Withdrawal deletes
 * nothing (manuscript, publication, edition, pages and assets all stay) and
 * never claims anything about any device screen.
 */
export function withdraw(ctx: ToolContext, callerId: string | undefined, args: WithdrawArgs): WithdrawWire {
  if (callerId === undefined || callerId.length === 0) {
    throw new BusinessError('invalid_input', 'caller identity is missing');
  }
  return ctx.query.withdraw(callerId, {
    expected_instance_id: args.expected_instance_id,
    request_id: args.request_id,
    publication_id: args.publication_id,
  });
}
