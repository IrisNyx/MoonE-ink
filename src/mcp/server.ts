import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BusinessError } from '../errors.js';
import {
  history,
  listGenres,
  peek,
  publish,
  requestStatus,
  serviceInfo,
  withdraw,
  TOOL_HISTORY,
  TOOL_LIST_GENRES,
  TOOL_PEEK,
  TOOL_PUBLISH,
  TOOL_REQUEST_STATUS,
  TOOL_SERVICE_INFO,
  TOOL_WITHDRAW,
  type HistoryWire,
  type ListGenresResult,
  type PeekWire,
  type PublishResultWire,
  type RequestStatusResultWire,
  type ServiceInfoResult,
  type ToolContext,
  type WithdrawWire,
} from '../tools.js';
import { LEGACY_PROTOCOL_VERSIONS } from '../version.js';
import { authorCatalogText } from '../production-catalog.js';

/**
 * Input schemas are strict zod objects passed to the official SDK: unknown
 * top-level fields fail validation and surface as JSON-RPC -32602 errors a
 * standard client can recognize (never as silent success). The manuscript is
 * passed through as an object here — the acceptance domain is the single
 * validation authority for its inner shape (stable invalid_input codes).
 */
const serviceInfoInput = z.strictObject({});

const listGenresInput = z.strictObject({
  only_supported: z.boolean().optional().describe('Return only genres a renderer currently supports (default true)'),
});

const publishInput = z.strictObject({
  expected_instance_id: z.string().min(1).describe('Instance identity this call targets (from ephemera_service_info)'),
  request_id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .describe('Caller-chosen stable request id; retries after a lost response MUST reuse it'),
  manuscript: z.record(z.string(), z.unknown()).describe('ManuscriptV1 postcard, or ManuscriptV2 note/postcard with schemaVersion:2'),
  contract_version: z
    .enum(['accepted-v2', 'terminal-v1'])
    .optional()
    .describe('Omit/accepted-v2 for the legacy immediate receipt; terminal-v1 waits for one final published or rejected result'),
});

const requestStatusInput = z
  .strictObject({
    expected_instance_id: z.string().min(1).describe('Instance identity this call targets'),
    operation_id: z.string().min(1).optional().describe('Operation id from the publish receipt'),
    request_id: z.string().min(1).optional().describe('The original request id (exactly one of operation_id/request_id)'),
  })
  .refine((value) => (value.operation_id !== undefined) !== (value.request_id !== undefined), {
    message: 'exactly one of operation_id or request_id is required',
  });

const historyInput = z.strictObject({
  expected_instance_id: z.string().min(1).describe('Instance identity this call targets (from ephemera_service_info)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Page size (default 20, max 100); must match the cursor page size when continuing'),
  cursor: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Opaque continuation token from a previous ephemera_history response'),
});

const peekInput = z.strictObject({
  expected_instance_id: z.string().min(1).describe('Instance identity this call targets'),
});

const withdrawInput = z.strictObject({
  expected_instance_id: z.string().min(1).describe('Instance identity this call targets'),
  request_id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .describe('Caller-chosen stable request id; retries of the same withdrawal MUST reuse it'),
  publication_id: z.string().min(1).describe('Publication id from history/peek/request_status'),
});

const serviceInfoOutput = z.strictObject({
  ok: z.literal(true),
  api_schema_version: z.number().int(),
  instance_id: z.string(),
  service_version: z.string(),
  capabilities: z.strictObject({
    publish: z.boolean(),
    history: z.boolean(),
    device_channel: z.boolean(),
    renderer: z.boolean(),
  }),
  rendered_profiles: z.array(z.string()),
  protocol: z.strictObject({
    supported_versions: z.array(z.string()),
    latest_version: z.string(),
    sdk: z.strictObject({
      name: z.string(),
      version: z.string(),
      node_adapter: z.strictObject({ name: z.string(), version: z.string() }),
    }),
  }),
});

const listGenresOutput = z.strictObject({
  ok: z.literal(true),
  genres: z.array(
    z.strictObject({
      id: z.string(),
      supported: z.boolean(),
      planned: z.boolean(),
      accepted_fields: z.array(z.string()),
      limits: z.strictObject({
        body_max_bytes: z.number().int(),
        http_body_max_bytes: z.number().int(),
        title_max_chars: z.number().int(),
        subtitle_max_chars: z.number().int(),
        pending_jobs_max: z.number().int(),
        max_pages: z.number().int(),
      }),
    }),
  ),
  pagination: z.strictObject({
    total: z.number().int(),
    returned: z.number().int(),
    kind: z.literal('complete'),
  }),
});

const publishOutput = z.strictObject({
  instance_id: z.string(),
  operation_id: z.string(),
  accepted: z.literal(true),
  acceptance_seq: z.number().int(),
  accepted_at: z.string(),
  reserved_publication_id: z.string(),
  status: z.enum(['accepted', 'processing', 'published', 'failed']),
  replayed: z.boolean(),
});

const operationStatusOutput = z.strictObject({
  instance_id: z.string(),
  operation_id: z.string(),
  request_id: z.string(),
  acceptance_seq: z.number().int(),
  accepted_at: z.string(),
  reserved_publication_id: z.string(),
  status: z.enum(['accepted', 'processing', 'published', 'failed']),
  publication: z
    .strictObject({
      publication_id: z.string(),
      commit_seq: z.number().int(),
      edition_id: z.string(),
      profile: z.string(),
      target: z.strictObject({ width: z.number().int(), height: z.number().int() }),
      renderer: z.strictObject({
        build: z.string(),
        version: z.string(),
        chromium: z.string(),
        playwright: z.string(),
        fonts_manifest_version: z.number().int(),
        fonts_file_count: z.number().int(),
      }),
      pages: z.array(
        z.strictObject({
          page_id: z.string(),
          page_index: z.number().int(),
          width: z.number().int(),
          height: z.number().int(),
          assets: z.array(
            z.strictObject({
              role: z.string(),
              kind: z.string(),
              sha256: z.string(),
              bytes: z.number().int(),
            }),
          ),
        }),
      ),
    })
    .optional(),
  failure: z.strictObject({ code: z.string(), retryable: z.literal(false) }).optional(),
});

const preAcceptanceStatusOutput = z.strictObject({
  contract_version: z.literal('terminal-v1'),
  instance_id: z.string(),
  request_id: z.string(),
  accepted: z.literal(false),
  status: z.literal('rejected'),
  phase: z.literal('pre-acceptance'),
  rejected_at: z.string(),
  failure: z.strictObject({
    category: z.literal('manuscript'),
    code: z.enum(['invalid_input', 'unsupported_genre', 'unsupported_content_slot']),
    message: z.string(),
    retryable: z.literal(false),
  }),
});

const requestStatusOutput = z.union([operationStatusOutput, preAcceptanceStatusOutput]);

const terminalPublishOutput = z.strictObject({
  contract_version: z.literal('terminal-v1'),
  instance_id: z.string(),
  operation_id: z.string(),
  request_id: z.string(),
  acceptance_seq: z.number().int(),
  accepted_at: z.string(),
  reserved_publication_id: z.string(),
  outcome: z.enum(['published', 'rejected']),
  replayed: z.boolean(),
  publication: operationStatusOutput.shape.publication,
  failure: z
    .strictObject({
      category: z.enum(['manuscript', 'deadline', 'technical']),
      code: z.string(),
      message: z.string(),
      retryable: z.literal(false),
    })
    .optional(),
});

const terminalPreAcceptanceRejectionOutput = z.strictObject({
  contract_version: z.literal('terminal-v1'),
  instance_id: z.string(),
  request_id: z.string(),
  accepted: z.literal(false),
  outcome: z.literal('rejected'),
  phase: z.literal('pre-acceptance'),
  rejected_at: z.string(),
  replayed: z.boolean(),
  failure: z.strictObject({
    category: z.literal('manuscript'),
    code: z.enum(['invalid_input', 'unsupported_genre', 'unsupported_content_slot']),
    message: z.string(),
    retryable: z.literal(false),
  }),
});

const publishResultOutput = z.union([publishOutput, terminalPublishOutput, terminalPreAcceptanceRejectionOutput]);

const readOnlyAnnotations = {
  title: 'Ephemera (read-only)',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Shared item shape of history entries and peek offers. */
const historyItemOutput = z.strictObject({
  publication_id: z.string(),
  operation_id: z.string(),
  acceptance_seq: z.number().int(),
  accepted_at: z.string(),
  committed_at: z.string(),
  deliver_after: z.string().nullable(),
  eligible_at: z.string(),
  expires_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  edition: z.strictObject({
    edition_id: z.string(),
    profile: z.string(),
    renderer: z.strictObject({
      build: z.string(),
      version: z.string(),
      chromium: z.string(),
      playwright: z.string(),
      fonts_manifest_version: z.number().int(),
      fonts_file_count: z.number().int(),
    }),
  }),
  pages: z.array(
    z.strictObject({
      page_id: z.string(),
      page_index: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
      assets: z.array(
        z.strictObject({
          role: z.string(),
          kind: z.string(),
          sha256: z.string(),
          bytes: z.number().int(),
        }),
      ),
    }),
  ),
});

const historyOutput = z.strictObject({
  instance_id: z.string(),
  items: z.array(historyItemOutput),
  next_cursor: z.string().nullable(),
});

const peekOutput = z.strictObject({
  instance_id: z.string(),
  offer: historyItemOutput.nullable(),
  device_channel_enabled: z.literal(false),
  device_status: z.strictObject({
    state: z.literal('unknown'),
    offered_at: z.null(),
    cached_at: z.null(),
    presented_at: z.null(),
    acknowledged_at: z.null(),
    last_reported_at: z.null(),
  }),
});

const withdrawOutput = z.strictObject({
  instance_id: z.string(),
  request_id: z.string(),
  publication_id: z.string(),
  withdrawn_at: z.string(),
  already_withdrawn: z.boolean(),
  replayed: z.boolean(),
});

function success(payload: ServiceInfoResult | ListGenresResult | PublishResultWire | RequestStatusResultWire | HistoryWire | PeekWire | WithdrawWire) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(error: BusinessError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(error.toShape()) }],
    isError: true as const,
  };
}

/** The per-request construction context the official v2 serving entry provides. */
export interface McpRequestContextInput {
  era: 'legacy' | 'modern';
  callerId: string | undefined;
  credentialId: string | undefined;
}

/**
 * Build a fresh MCP server instance with exactly the seven registered tools:
 * the two read-only foundation tools (MCP-01), the publish/status loop
 * (MCP-03b) and the history/peek/withdraw query tools (MCP-04). The official
 * v2 serving entry (createMcpHandler) calls this factory once per HTTP
 * request for both eras, so the modern (2026-07-28 envelope) and legacy
 * (2025 initialize) legs can never drift.
 *
 * The caller identity arrives from the request context (authenticated
 * credential), never from tool arguments; it is handed to the domain layer
 * per request.
 */
export function buildMcpServer(ctx: McpRequestContextInput, toolContext: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'ephemera', title: 'Ephemera MCP Foundation Service', version: serviceInfo(toolContext).service_version },
    {
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS],
    },
  );

  server.registerTool(
    TOOL_SERVICE_INFO,
    {
      description:
        'Return this service instance identity, service and API schema versions, the actually ' +
        'supported MCP protocol version matrix, and current capability status.',
      inputSchema: serviceInfoInput,
      outputSchema: serviceInfoOutput,
      annotations: { ...readOnlyAnnotations, title: 'Ephemera service info' },
    },
    async () => success(serviceInfo(toolContext)),
  );

  server.registerTool(
    TOOL_LIST_GENRES,
    {
      description:
        'List ephemera genres. By default renderer-supported postcard and note are returned; pass ' +
        'only_supported=false to inspect the complete planning catalog. Postcard is one 540x960 body-only ' +
        'page. Note accepts ManuscriptV2 title/body/signature and paginates to at most 16 pages without ' +
        'rewriting author text.',
      inputSchema: listGenresInput,
      outputSchema: listGenresOutput,
      annotations: { ...readOnlyAnnotations, title: 'Ephemera genre list' },
    },
    async (args) => {
      // Defense in depth: re-validate strictly at the domain boundary even
      // though the SDK already enforced the declared schema.
      const parsed = listGenresInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_list_genres'));
      }
      return success(listGenres(parsed.data));
    },
  );

  server.registerTool(
    TOOL_PUBLISH,
    {
      description:
        'Submit a manuscript under an explicit business contract. Omit contract_version (accepted-v2) ' +
        'for the historical durable acceptance receipt and status polling. Set terminal-v1 for one bounded ' +
        'call that returns only published or rejected; the overall deadline includes queue, render, review ' +
        'and commit, and a rejected request can never publish later. Manuscript/schema rejection before ' +
        'acceptance is also persisted without consuming an operation id or publication number. Retries MUST reuse request_id and the ' +
        'same contract/input; changed input or contract is idempotency_conflict.' +
        '\n\n' + authorCatalogText(),
      inputSchema: publishInput,
      outputSchema: publishResultOutput,
      annotations: {
        title: 'Ephemera publish',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const parsed = publishInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_publish'));
      }
      try {
        return success(await publish(toolContext, ctx.callerId, parsed.data));
      } catch (error) {
        if (error instanceof BusinessError) {
          return failure(error);
        }
        return failure(new BusinessError('storage_unavailable', 'publish is temporarily unavailable', true));
      }
    },
  );

  server.registerTool(
    TOOL_REQUEST_STATUS,
    {
      description:
        'Query one operation of the calling credential by operation_id or request_id (exactly one). ' +
        'Returns the acceptance receipt facts and the current status; published carries a read-only ' +
        'publication summary (commit sequence, edition, page and asset digests — server-side commit ' +
        'facts only, never device display state); failed carries a stable failure code with ' +
        'retryable=false. A request_id may also retrieve a durable terminal-v1 rejection that happened ' +
        'before acceptance and therefore has no operation_id. Unknown and foreign results are indistinguishable not_found.',
      inputSchema: requestStatusInput,
      outputSchema: requestStatusOutput,
      annotations: { ...readOnlyAnnotations, title: 'Ephemera request status' },
    },
    async (args) => {
      const parsed = requestStatusInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_request_status'));
      }
      try {
        return success(await requestStatus(toolContext, ctx.callerId, parsed.data));
      } catch (error) {
        if (error instanceof BusinessError) {
          return failure(error);
        }
        return failure(new BusinessError('storage_unavailable', 'status is temporarily unavailable', true));
      }
    },
  );

  server.registerTool(
    TOOL_HISTORY,
    {
      description:
        'List the calling credential\'s successfully published records, newest acceptance first, as a ' +
        'stable snapshot page. The first call fixes the committed-publication high water; later completions ' +
        'and new submissions never insert into that snapshot (refresh to see them). next_cursor continues the ' +
        'same snapshot; unknown, expired, tampered, foreign or page-size-mismatched cursors are one uniform ' +
        'invalid_input. Withdrawn and expired records stay listed with their facts — history never deletes.',
      inputSchema: historyInput,
      outputSchema: historyOutput,
      annotations: { ...readOnlyAnnotations, title: 'Ephemera history' },
    },
    async (args) => {
      const parsed = historyInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_history'));
      }
      try {
        return success(history(toolContext, ctx.callerId, parsed.data));
      } catch (error) {
        if (error instanceof BusinessError) {
          return failure(error);
        }
        return failure(new BusinessError('storage_unavailable', 'history is temporarily unavailable', true));
      }
    },
  );

  server.registerTool(
    TOOL_PEEK,
    {
      description:
        'Return the calling credential\'s current latest eligible offer: among published, unwithdrawn, ' +
        'unexpired publications with eligible_at <= now, the maximum by (eligible_at, acceptance_seq) — ' +
        'acceptance order and the author delivery reservation decide, never worker completion time. ' +
        'This caller-private MCP query has no Device Channel state permission: device_channel_enabled is false ' +
        'and every device fact is explicitly unknown. Use the separately authenticated Device API for device state.',
      inputSchema: peekInput,
      outputSchema: peekOutput,
      annotations: { ...readOnlyAnnotations, title: 'Ephemera peek' },
    },
    async (args) => {
      const parsed = peekInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_peek'));
      }
      try {
        return success(peek(toolContext, ctx.callerId, parsed.data));
      } catch (error) {
        if (error instanceof BusinessError) {
          return failure(error);
        }
        return failure(new BusinessError('storage_unavailable', 'peek is temporarily unavailable', true));
      }
    },
  );

  server.registerTool(
    TOOL_WITHDRAW,
    {
      description:
        'Idempotently cancel the future automatic delivery eligibility of one of the calling credential\'s ' +
        'publications. The (instance, caller, request_id) key replays the stored outcome; the same key against ' +
        'a different publication is idempotency_conflict; unknown or foreign publications are a uniform ' +
        'not_found. Withdrawal deletes nothing — manuscript, publication, pages, assets and history all stay — ' +
        'and never claims any device screen was erased.',
      inputSchema: withdrawInput,
      outputSchema: withdrawOutput,
      annotations: {
        title: 'Ephemera withdraw',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const parsed = withdrawInput.safeParse(args ?? {});
      if (!parsed.success) {
        return failure(new BusinessError('invalid_input', 'invalid arguments for ephemera_withdraw'));
      }
      try {
        return success(withdraw(toolContext, ctx.callerId, parsed.data));
      } catch (error) {
        if (error instanceof BusinessError) {
          return failure(error);
        }
        return failure(new BusinessError('storage_unavailable', 'withdraw is temporarily unavailable', true));
      }
    },
  );

  return server;
}
