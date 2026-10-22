import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'ephemera-tests-'));
try {
  const result = spawnSync(process.execPath, ['--test', 'dist/test/*.test.js'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, EPHEMERA_TEST_TMP: scratch },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(resolve(scratch)) !== resolve(tmpdir())) throw new Error('Unexpected test scratch directory');
  rmSync(scratch, { recursive: true, force: true });
}
