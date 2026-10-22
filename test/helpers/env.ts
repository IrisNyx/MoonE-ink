import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * All test scratch state (SQLite databases, lock files, generated configs)
 * lives in the isolated directory supplied by scripts/test.mjs. Tests never
 * use an installed service's configuration, credentials or database.
 */
export function requireTestTmp(): string {
  const root = process.env.EPHEMERA_TEST_TMP;
  if (root === undefined || root.length === 0) {
    throw new Error('EPHEMERA_TEST_TMP is not set; run npm test or set an isolated test directory');
  }
  mkdirSync(root, { recursive: true });
  return root;
}

export function freshDir(prefix: string): string {
  const root = requireTestTmp();
  const dir = join(root, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const SERVICE_ROOT = process.cwd();

export const SERVICE_ENTRY = join(SERVICE_ROOT, 'dist', 'src', 'index.js');
