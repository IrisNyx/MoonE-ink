/**
 * Structured JSON-lines logger.
 *
 * Hard rules enforced by convention and reviewed by tests (F08):
 *  - never log bearer tokens or credential digests
 *  - never log filesystem paths beyond basenames
 *  - never log manuscript text (future batches)
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export class Logger {
  private readonly threshold: number;

  constructor(level: LogLevel) {
    this.threshold = LEVEL_ORDER[level];
  }

  log(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) {
      return;
    }
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          line[key] = value;
        }
      }
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  debug(event: string, fields?: LogFields): void {
    this.log('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }
}
