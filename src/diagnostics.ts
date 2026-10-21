/**
 * Startup diagnostic safety.
 *
 * Logs must not record private file paths. Raw OS exception messages embed
 * absolute paths (config location, data directory), so startup failures never
 * copy them into stdout/stderr/log records: each failing step reports a
 * stable category derived from the errno code, and `redactDiagnosticText`
 * acts as a final guard that strips path-shaped text and bounds the length
 * of anything unexpected that still reaches an emit boundary.
 */

/** Hard cap so a pathological message can never flood diagnostics either. */
const MAX_MESSAGE_LENGTH = 500;

const DRIVE_PATH = /[A-Za-z]:[\\/][^\s"'`,;:[\]]*/g;
const POSIX_PATH = /(^|[\s"'`([=,])(?:\/[\w.-]+){2,}/g;
const UNC_PATH = /\\\\[^\s"'`,;[\]]*/g;

/** Strip path-shaped substrings and bound a diagnostic message to one line. */
export function redactDiagnosticText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const redacted = firstLine
    .replace(DRIVE_PATH, '[path]')
    .replace(POSIX_PATH, '$1[path]')
    .replace(UNC_PATH, '[path]');
  return redacted.length <= MAX_MESSAGE_LENGTH ? redacted : `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`;
}

export type FsFailureCategory =
  | 'not_found'
  | 'not_a_directory'
  | 'is_a_directory'
  | 'permission_denied'
  | 'already_exists'
  | 'busy'
  | 'io_error';

/** Stable category for a filesystem failure; never includes the OS message. */
export function fsFailureCategory(error: unknown): FsFailureCategory {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return 'not_found';
    case 'ENOTDIR':
      return 'not_a_directory';
    case 'EISDIR':
      return 'is_a_directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'EEXIST':
      return 'already_exists';
    case 'EBUSY':
      return 'busy';
    default:
      return 'io_error';
  }
}

/**
 * Safe message for an unexpected (non-categorized) failure: keep enough shape
 * to debug, never trust the payload. Values without an Error message get the
 * fallback summary; Error text goes through the redaction guard.
 */
export function safeFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message.length > 0 ? error.message : fallback;
  return redactDiagnosticText(message);
}
