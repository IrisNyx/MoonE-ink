/**
 * Stable business error codes used inside tool failure payloads.
 *
 * Protocol-level failures (malformed JSON-RPC envelope, unknown tool,
 * invalid tool arguments) are produced by the MCP SDK as JSON-RPC errors
 * and never wrapped into tool results.
 */
export type BusinessErrorCode =
  | 'invalid_input'
  | 'unsupported_genre'
  | 'unsupported_content_slot'
  | 'idempotency_conflict'
  | 'instance_changed'
  | 'not_found'
  | 'queue_full'
  | 'render_overflow'
  | 'asset_unavailable'
  | 'author_content_mismatch'
  | 'render_failed'
  | 'storage_unavailable';

export interface BusinessErrorShape {
  ok: false;
  error: { code: BusinessErrorCode; message: string; retryable: boolean };
}

export class BusinessError extends Error {
  readonly code: BusinessErrorCode;
  readonly retryable: boolean;

  constructor(code: BusinessErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.retryable = retryable;
  }

  toShape(): BusinessErrorShape {
    return {
      ok: false,
      error: { code: this.code, message: this.message, retryable: this.retryable },
    };
  }
}

/** Fatal configuration problem; the process must exit without listening. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
