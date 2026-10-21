import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isSecureNodeVersion, SECURE_NODE_RANGE } from '../src/runtime-security.js';

test('accepts patched versions and rejects affected branches and prereleases', () => {
  for (const version of ['24.22.1', 'v24.22.2', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) {
    assert.equal(isSecureNodeVersion(version), true, version);
  }
  for (const version of ['22.23.4', '24.16.0', '24.22.0', '25.9.0', '26.0.0', '26.12.0', '24.22.1-rc.1', 'invalid']) {
    assert.equal(isSecureNodeVersion(version), false, version);
  }
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, SECURE_NODE_RANGE);
});

test('direct service and command entry points reject an affected runtime before reading configuration', () => {
  const paths = ['../src/index.js', '../../scripts/data-admin.mjs', '../../scripts/device-simulator.mjs'];
  for (const path of paths) {
    const url = new URL(path, import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process, 'version', { value: 'v24.16.0' }); await import(${JSON.stringify(url)});`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 1, path);
    assert.match(child.stderr, /certificate security fixes/);
    assert.doesNotMatch(child.stderr, /config_error|SQLITE_ERROR/);
  }
});
