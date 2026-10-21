/**
 * Stable renderer error codes.
 *
 * These are the offline-CLI twins of the service's business error codes: the
 * CLI reports them as `{ok:false,error:{code,message}}` on stderr with a
 * non-zero exit. Messages must stay bounded and must never embed manuscript
 * content, absolute paths or stack traces.
 */
export type RenderErrorCode =
  | 'invalid_input'
  | 'unsupported_genre'
  | 'unsupported_content_slot'
  | 'unsupported_glyph'
  | 'render_overflow'
  | 'author_content_mismatch'
  | 'asset_unavailable'
  | 'render_failed'
  | 'output_unavailable'
  | 'internal_error';

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly exitCode: number;

  constructor(code: RenderErrorCode, message: string, exitCode = 1) {
    // Defensive: whatever the constructor site passed, keep the message short
    // and free of line breaks so a single-line JSON error stays parseable.
    super(message.split(/\r?\n/)[0]!.slice(0, 300));
    this.name = 'RenderError';
    this.code = code;
    this.exitCode = exitCode;
  }

  toShape(): { ok: false; error: { code: RenderErrorCode; message: string } } {
    return { ok: false, error: { code: this.code, message: this.message } };
  }
}

/** Wrap unknown failures as internal_error without leaking their text. */
export function internalRenderError(): RenderError {
  return new RenderError('internal_error', 'renderer failed (internal error)');
}
